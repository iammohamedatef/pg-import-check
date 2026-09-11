import type {
  AmbiguousDeclarationRefusal,
  ConflictingColumnDeclarationRefusal,
} from "./create-table-column-conflicts.js";
import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import type { ForeignKeyReferencedColumns } from "./create-table-foreign-key-constraints.js";
import {
  contextualRefusalForDemand,
  type CreateTableToken,
  type SourceSpan,
} from "./create-table-token-source.js";
import type {
  CreateTableParseRefusal,
  CreateTableStructuralReader,
  OpaqueTraversalResult,
  StructuralTokenStep,
} from "./create-table-structural-reader.js";
import type { SourceLocation } from "./source-cursor.js";

const EXCLUDED_LOCAL_TYPE_WORDS: ReadonlySet<string> = new Set([
  "constraint",
  "not",
  "null",
  "primary",
  "unique",
  "check",
  "references",
  "default",
  "generated",
]);

export type IdentifierIdentity = {
  readonly identity: string;
  readonly quoted: boolean;
  readonly span: SourceSpan;
};

export type QualifiedIdentity = {
  readonly qualifier: IdentifierIdentity | null;
  readonly local: IdentifierIdentity;
  readonly span: SourceSpan;
};

export type TypeModifierDigitSpans =
  | readonly []
  | readonly [SourceSpan]
  | readonly [SourceSpan, SourceSpan];

export type TypeShape = {
  readonly name: QualifiedIdentity;
  readonly modifierDigitSpans: TypeModifierDigitSpans;
  readonly arrayDimensions: number;
  readonly span: SourceSpan;
};

export type CreateTableCoreShapeRefusal =
  | CreateTableParseRefusal
  | AmbiguousDeclarationRefusal
  | ConflictingColumnDeclarationRefusal;

export type CreateTableGrammarBoundary =
  | {
      readonly kind: "unexpected_token";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "end_of_input";
      readonly location: SourceLocation;
    };

export type RecognitionFailure =
  | {
      readonly kind: "not_recognized_by_create_table_grammar";
      readonly boundary: CreateTableGrammarBoundary;
    }
  | {
      readonly kind: "refused";
      readonly refusal: CreateTableCoreShapeRefusal;
    };

export type Parsed<T> = {
  readonly kind: "parsed";
  readonly value: T;
};

export type ParseResult<T> = Parsed<T> | RecognitionFailure;

export type ParsedSimpleColumnList = {
  readonly span: SourceSpan;
  readonly columnReferences: readonly IdentifierIdentity[];
};

export function parseTypeShape(tokens: CreateTableStructuralReader): ParseResult<TypeShape> {
  const first = parseIdentifier(tokens);
  if (isFailure(first)) {
    return first;
  }

  let name: QualifiedIdentity;
  const stepAfterFirst = tokens.peek();
  if (stepAfterFirst.kind === "refused") {
    return failureFromStep(stepAfterFirst);
  }

  if (
    stepAfterFirst.kind === "token" &&
    stepAfterFirst.token.kind === "punctuation" &&
    stepAfterFirst.token.value === "."
  ) {
    tokens.consumeCurrent();
    const localName = parseLocalTypeWord(tokens);
    if (isFailure(localName)) {
      return localName;
    }
    name = {
      qualifier: first.value,
      local: localName.value,
      span: spanning(first.value.span, localName.value.span),
    };
  } else {
    if (isExcludedLocalTypeWord(first.value)) {
      return notRecognizedAt(first.value.span);
    }
    name = {
      qualifier: null,
      local: first.value,
      span: first.value.span,
    };
  }

  let modifierDigitSpans: TypeModifierDigitSpans = [];
  let typeEnd = name.span;
  const possibleModifier = tokens.peek();
  if (possibleModifier.kind === "refused") {
    return failureFromStep(possibleModifier);
  }
  if (
    possibleModifier.kind === "token" &&
    possibleModifier.token.kind === "punctuation" &&
    possibleModifier.token.value === "("
  ) {
    tokens.commitOpening("(");
    const firstModifier = parseUnsignedIntegerSpan(tokens);
    if (isFailure(firstModifier)) {
      return firstModifier;
    }
    modifierDigitSpans = [firstModifier.value];

    const afterFirstModifier = tokens.peek();
    if (afterFirstModifier.kind === "refused") {
      return failureFromStep(afterFirstModifier);
    }
    if (
      afterFirstModifier.kind === "token" &&
      afterFirstModifier.token.kind === "punctuation" &&
      afterFirstModifier.token.value === ","
    ) {
      tokens.consumeCurrent();
      const secondModifier = parseUnsignedIntegerSpan(tokens);
      if (isFailure(secondModifier)) {
        return secondModifier;
      }
      modifierDigitSpans = [firstModifier.value, secondModifier.value];
    }

    const closeModifier = expectPunctuation(tokens, ")");
    if (isFailure(closeModifier)) {
      return closeModifier;
    }
    typeEnd = closeModifier.value.span;
  }

  let arrayDimensions = 0;
  for (;;) {
    const possibleArray = tokens.peek();
    if (possibleArray.kind === "refused") {
      return failureFromStep(possibleArray);
    }
    if (
      possibleArray.kind !== "token" ||
      possibleArray.token.kind !== "punctuation" ||
      possibleArray.token.value !== "["
    ) {
      break;
    }

    tokens.commitOpening("[");
    const closeArray = expectPunctuation(tokens, "]");
    if (isFailure(closeArray)) {
      return closeArray;
    }
    arrayDimensions += 1;
    typeEnd = closeArray.value.span;
  }

  return parsed({
    name,
    modifierDigitSpans,
    arrayDimensions,
    span: spanning(name.span, typeEnd),
  });
}

export function parseQualifiedIdentity(
  tokens: CreateTableStructuralReader,
): ParseResult<QualifiedIdentity> {
  const first = parseIdentifier(tokens);
  if (isFailure(first)) {
    return first;
  }

  const step = tokens.peek();
  if (step.kind === "refused") {
    return failureFromStep(step);
  }
  if (step.kind !== "token" || step.token.kind !== "punctuation" || step.token.value !== ".") {
    return parsed({ qualifier: null, local: first.value, span: first.value.span });
  }

  tokens.consumeCurrent();
  const second = parseIdentifier(tokens);
  if (isFailure(second)) {
    return second;
  }
  return parsed({
    qualifier: first.value,
    local: second.value,
    span: spanning(first.value.span, second.value.span),
  });
}

export function parseOptionalReferencedColumnList(
  tokens: CreateTableStructuralReader,
): ParseResult<ForeignKeyReferencedColumns> {
  const step = tokens.peek();
  if (step.kind === "refused") {
    return failureFromStep(step);
  }
  if (step.kind !== "token" || step.token.kind !== "punctuation" || step.token.value !== "(") {
    return parsed({ kind: "referenced_columns_omitted" });
  }

  const list = parseSimpleColumnList(tokens);
  return isFailure(list) ? list : parsed({ kind: "explicit_referenced_columns", list: list.value });
}

export function parseSimpleColumnList(
  tokens: CreateTableStructuralReader,
): ParseResult<ParsedSimpleColumnList> {
  const opening = expectPunctuation(tokens, "(");
  if (isFailure(opening)) {
    return opening;
  }
  const columnReferences: IdentifierIdentity[] = [];
  const firstReference = parseIdentifier(tokens);
  if (isFailure(firstReference)) {
    return firstReference;
  }
  columnReferences.push(firstReference.value);

  let closing: Extract<CreateTableToken, { kind: "punctuation" }>;
  for (;;) {
    const step = tokens.peek();
    if (step.kind !== "token") {
      return failureFromStep(step);
    }
    if (step.token.kind === "punctuation" && step.token.value === ")") {
      closing = tokens.consumeClosing(")");
      break;
    }
    if (step.token.kind !== "punctuation" || step.token.value !== ",") {
      return notRecognizedAt(step.token.span);
    }
    tokens.consumeCurrent();
    const reference = parseIdentifier(tokens);
    if (isFailure(reference)) {
      return reference;
    }
    columnReferences.push(reference.value);
  }

  return parsed({
    span: spanning(opening.value.span, closing.span),
    columnReferences,
  });
}

function parseLocalTypeWord(tokens: CreateTableStructuralReader): ParseResult<IdentifierIdentity> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }
  if (step.token.kind === "word" && EXCLUDED_LOCAL_TYPE_WORDS.has(step.token.folded)) {
    return notRecognizedAt(step.token.span);
  }
  return parseIdentifier(tokens);
}

export function parseExplicitConstraintWrapper(
  tokens: CreateTableStructuralReader,
): ParseResult<ExplicitConstraintWrapper> {
  const constraint = expectWord(tokens, "constraint");
  if (isFailure(constraint)) {
    return constraint;
  }
  const name = parseIdentifier(tokens);
  if (isFailure(name)) {
    return name;
  }
  return parsed({
    constraintKeywordSpan: constraint.value.span,
    name: name.value,
    wrapperSpan: spanning(constraint.value.span, name.value.span),
  });
}

export function parseIdentifier(
  tokens: CreateTableStructuralReader,
): ParseResult<IdentifierIdentity> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }

  const contextualRefusal = contextualRefusalForDemand(step.token, "identifier");
  if (contextualRefusal !== null) {
    return { kind: "refused", refusal: contextualRefusal };
  }

  if (step.token.kind === "quoted_identifier") {
    tokens.consumeCurrent();
    return parsed({
      identity: step.token.identity,
      quoted: true,
      span: step.token.span,
    });
  }

  if (step.token.kind !== "word") {
    return notRecognizedAt(step.token.span);
  }

  tokens.consumeCurrent();
  return parsed({ identity: step.token.folded, quoted: false, span: step.token.span });
}

function parseUnsignedIntegerSpan(tokens: CreateTableStructuralReader): ParseResult<SourceSpan> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }
  if (step.token.kind !== "numeric" || !step.token.isUnsignedInteger) {
    return notRecognizedAt(step.token.span);
  }
  tokens.consumeCurrent();
  return parsed(step.token.span);
}

export function expectWord(
  tokens: CreateTableStructuralReader,
  folded: string,
): ParseResult<Extract<CreateTableToken, { kind: "word" }>> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }
  if (!isWord(step.token, folded)) {
    return notRecognizedAt(step.token.span);
  }
  tokens.consumeCurrent();
  return parsed(step.token);
}

export function expectPunctuation(
  tokens: CreateTableStructuralReader,
  value: Extract<CreateTableToken, { kind: "punctuation" }>["value"],
): ParseResult<Extract<CreateTableToken, { kind: "punctuation" }>> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }
  if (step.token.kind !== "punctuation" || step.token.value !== value) {
    return notRecognizedAt(step.token.span);
  }
  if (value === "(" || value === "[") {
    return parsed(tokens.commitOpening(value));
  }
  if (value === ")" || value === "]") {
    return parsed(tokens.consumeClosing(value));
  }
  tokens.consumeCurrent();
  return parsed(step.token);
}

export function isWord(
  token: CreateTableToken,
  folded: string,
): token is Extract<CreateTableToken, { kind: "word" }> {
  return token.kind === "word" && token.folded === folded;
}

function isExcludedLocalTypeWord(identifier: IdentifierIdentity): boolean {
  return !identifier.quoted && EXCLUDED_LOCAL_TYPE_WORDS.has(identifier.identity);
}

export function parsed<T>(value: T): Parsed<T> {
  return { kind: "parsed", value };
}

export function isFailure<T>(result: ParseResult<T>): result is RecognitionFailure {
  return result.kind !== "parsed";
}

export function failureFromStep(
  step: Exclude<StructuralTokenStep, { kind: "token" }>,
): RecognitionFailure;
export function failureFromStep(step: StructuralTokenStep): RecognitionFailure;
export function failureFromStep(step: StructuralTokenStep): RecognitionFailure {
  if (step.kind === "refused") {
    return { kind: "refused", refusal: step.refusal };
  }
  if (step.kind === "eof") {
    return {
      kind: "not_recognized_by_create_table_grammar",
      boundary: { kind: "end_of_input", location: step.location },
    };
  }
  return notRecognizedAt(step.token.span);
}

export function failureFromOpaqueTraversal(
  result: Exclude<OpaqueTraversalResult, { kind: "traversed" }>,
): RecognitionFailure {
  if (result.kind === "refused") {
    return { kind: "refused", refusal: result.refusal };
  }
  if (result.kind === "not_admitted") {
    return notRecognizedAt(result.span);
  }
  return failureFromStep(result.boundary);
}

export function notRecognizedAt(span: SourceSpan): RecognitionFailure {
  return {
    kind: "not_recognized_by_create_table_grammar",
    boundary: { kind: "unexpected_token", span },
  };
}

export function spanning(first: SourceSpan, last: SourceSpan): SourceSpan {
  return { start: first.start, end: last.end };
}
