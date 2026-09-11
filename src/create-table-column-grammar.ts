import { parseCheckProduction } from "./create-table-check-grammar.js";
import type { ParsedColumnClauseOccurrence } from "./create-table-column-conflicts.js";
import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import type { ParsedColumnReferencesClauseOccurrence } from "./create-table-foreign-key-constraints.js";
import {
  expectPunctuation,
  expectWord,
  failureFromOpaqueTraversal,
  failureFromStep,
  isFailure,
  isWord,
  notRecognizedAt,
  parseExplicitConstraintWrapper,
  parseIdentifier,
  parseOptionalReferencedColumnList,
  parseQualifiedIdentity,
  parseTypeShape,
  parsed,
  spanning,
  type IdentifierIdentity,
  type ParseResult,
  type TypeShape,
} from "./create-table-parser-primitives.js";
import type { CreateTableStructuralReader } from "./create-table-structural-reader.js";
import type { SourceSpan } from "./create-table-token-source.js";

const DEFAULT_KEYWORD_ATOMS: ReadonlySet<string> = new Set([
  "null",
  "true",
  "false",
  "current_date",
  "current_timestamp",
]);

type BareColumnClauseKind =
  | "check"
  | "default"
  | "generated"
  | "not"
  | "null"
  | "primary"
  | "references"
  | "unique";

export type CoreColumnShape = {
  readonly name: IdentifierIdentity;
  readonly type: TypeShape;
  readonly clauseOccurrences: readonly ParsedColumnClauseOccurrence[];
  readonly span: SourceSpan;
};

export function parseCoreColumn(tokens: CreateTableStructuralReader): ParseResult<CoreColumnShape> {
  const name = parseIdentifier(tokens);
  if (isFailure(name)) {
    return name;
  }
  const type = parseTypeShape(tokens);
  if (isFailure(type)) {
    return type;
  }

  const clauseOccurrences: ParsedColumnClauseOccurrence[] = [];
  let columnEnd = type.value.span;
  for (;;) {
    const possibleClause = tokens.peek();
    if (possibleClause.kind === "refused") {
      return failureFromStep(possibleClause);
    }
    if (possibleClause.kind !== "token" || possibleClause.token.kind !== "word") {
      break;
    }

    let explicitConstraintName: ExplicitConstraintWrapper | null = null;
    let underlyingKind = possibleClause.token.folded;
    if (underlyingKind === "constraint") {
      const wrapper = parseExplicitConstraintWrapper(tokens);
      if (isFailure(wrapper)) {
        return wrapper;
      }
      explicitConstraintName = wrapper.value;
      const underlying = tokens.peek();
      if (underlying.kind !== "token") {
        return failureFromStep(underlying);
      }
      if (underlying.token.kind !== "word") {
        return notRecognizedAt(underlying.token.span);
      }
      underlyingKind = underlying.token.folded;
      if (!isNameableColumnClauseKind(underlyingKind)) {
        return notRecognizedAt(underlying.token.span);
      }
    } else if (!isBareColumnClauseKind(underlyingKind)) {
      break;
    }

    const occurrence = parseColumnClause(tokens, underlyingKind, explicitConstraintName);
    if (isFailure(occurrence)) {
      return occurrence;
    }
    clauseOccurrences.push(occurrence.value);
    columnEnd = occurrence.value.clauseSpan;
  }

  return parsed({
    name: name.value,
    type: type.value,
    clauseOccurrences,
    span: spanning(name.value.span, columnEnd),
  });
}

function parseColumnClause(
  tokens: CreateTableStructuralReader,
  kind: BareColumnClauseKind,
  explicitConstraintName: ExplicitConstraintWrapper | null,
): ParseResult<ParsedColumnClauseOccurrence> {
  if (kind === "generated") {
    if (explicitConstraintName !== null) {
      throw new Error("CREATE TABLE named GENERATED invariant violated.");
    }
    return parseGeneratedClause(tokens);
  }
  if (kind === "check") {
    return parseCheckProduction(tokens, explicitConstraintName);
  }
  if (kind === "references") {
    return parseColumnReferencesClause(tokens, explicitConstraintName);
  }

  const keyword = tokens.peek();
  if (keyword.kind !== "token" || keyword.token.kind !== "word") {
    throw new Error("CREATE TABLE column-clause dispatch invariant violated.");
  }
  tokens.consumeCurrent();

  let underlyingEnd = keyword.token.span;
  let expressionSpan: SourceSpan | null = null;
  if (kind === "not") {
    const nullKeyword = expectWord(tokens, "null");
    if (isFailure(nullKeyword)) {
      return nullKeyword;
    }
    underlyingEnd = nullKeyword.value.span;
  } else if (kind === "primary") {
    const keyKeyword = expectWord(tokens, "key");
    if (isFailure(keyKeyword)) {
      return keyKeyword;
    }
    underlyingEnd = keyKeyword.value.span;
  } else if (kind === "default") {
    const expression = parseDefaultExpression(tokens);
    if (isFailure(expression)) {
      return expression;
    }
    expressionSpan = expression.value;
    underlyingEnd = expression.value;
  }

  const underlyingClauseSpan = spanning(keyword.token.span, underlyingEnd);
  const clauseSpan =
    explicitConstraintName === null
      ? underlyingClauseSpan
      : spanning(explicitConstraintName.constraintKeywordSpan, underlyingEnd);
  const shared = {
    keywordSpan: keyword.token.span,
    establishmentSpan: explicitConstraintName?.constraintKeywordSpan ?? keyword.token.span,
    underlyingClauseSpan,
    clauseSpan,
    explicitConstraintName,
  };

  if (kind === "default") {
    if (expressionSpan === null) {
      throw new Error("CREATE TABLE expression-clause invariant violated.");
    }
    return parsed({ kind, ...shared, expressionSpan });
  }
  return parsed({ kind: parsedColumnClauseKind(kind), ...shared });
}

function parseGeneratedClause(
  tokens: CreateTableStructuralReader,
): ParseResult<ParsedColumnClauseOccurrence> {
  const generated = expectWord(tokens, "generated");
  if (isFailure(generated)) {
    return generated;
  }

  const mode = tokens.peek();
  if (mode.kind !== "token") {
    return failureFromStep(mode);
  }
  const modeSpan = mode.token.span;
  if (isWord(mode.token, "by")) {
    tokens.consumeCurrent();
    return parseGeneratedByDefaultIdentityClause(tokens, generated.value.span, modeSpan);
  }
  if (!isWord(mode.token, "always")) {
    return notRecognizedAt(modeSpan);
  }

  tokens.consumeCurrent();
  return parseGeneratedAlwaysClause(tokens, generated.value.span, modeSpan);
}

function parseGeneratedAlwaysClause(
  tokens: CreateTableStructuralReader,
  generatedKeywordSpan: SourceSpan,
  alwaysKeywordSpan: SourceSpan,
): ParseResult<ParsedColumnClauseOccurrence> {
  const as = expectWord(tokens, "as");
  if (isFailure(as)) {
    return as;
  }

  const alternative = tokens.peek();
  if (alternative.kind !== "token") {
    return failureFromStep(alternative);
  }
  if (isWord(alternative.token, "identity")) {
    tokens.consumeCurrent();
    return finishIdentityClause(
      tokens,
      generatedKeywordSpan,
      { kind: "always", alwaysKeywordSpan },
      as.value.span,
      alternative.token.span,
    );
  }
  if (alternative.token.kind !== "punctuation" || alternative.token.value !== "(") {
    return notRecognizedAt(alternative.token.span);
  }

  tokens.commitOpening("(");
  const expression = tokens.traverseOpaqueParenthesized();
  if (expression.kind !== "traversed") {
    return failureFromOpaqueTraversal(expression);
  }
  const stored = expectWord(tokens, "stored");
  if (isFailure(stored)) {
    return stored;
  }

  const clauseSpan = spanning(generatedKeywordSpan, stored.value.span);
  return parsed({
    kind: "generated_stored",
    keywordSpan: generatedKeywordSpan,
    generatedKeywordSpan,
    alwaysKeywordSpan,
    asKeywordSpan: as.value.span,
    expressionSpan: expression.span,
    storedKeywordSpan: stored.value.span,
    establishmentSpan: generatedKeywordSpan,
    underlyingClauseSpan: clauseSpan,
    clauseSpan,
    explicitConstraintName: null,
  });
}

function parseGeneratedByDefaultIdentityClause(
  tokens: CreateTableStructuralReader,
  generatedKeywordSpan: SourceSpan,
  byKeywordSpan: SourceSpan,
): ParseResult<ParsedColumnClauseOccurrence> {
  const defaultKeyword = expectWord(tokens, "default");
  if (isFailure(defaultKeyword)) {
    return defaultKeyword;
  }
  const as = expectWord(tokens, "as");
  if (isFailure(as)) {
    return as;
  }
  const identity = expectWord(tokens, "identity");
  if (isFailure(identity)) {
    return identity;
  }

  return finishIdentityClause(
    tokens,
    generatedKeywordSpan,
    {
      kind: "by_default",
      byKeywordSpan,
      defaultKeywordSpan: defaultKeyword.value.span,
    },
    as.value.span,
    identity.value.span,
  );
}

function finishIdentityClause(
  tokens: CreateTableStructuralReader,
  generatedKeywordSpan: SourceSpan,
  mode:
    | { readonly kind: "always"; readonly alwaysKeywordSpan: SourceSpan }
    | {
        readonly kind: "by_default";
        readonly byKeywordSpan: SourceSpan;
        readonly defaultKeywordSpan: SourceSpan;
      },
  asKeywordSpan: SourceSpan,
  identityKeywordSpan: SourceSpan,
): ParseResult<ParsedColumnClauseOccurrence> {
  let optionsSpan: SourceSpan | null = null;
  const possibleOptions = tokens.peek();
  if (possibleOptions.kind === "refused") {
    return failureFromStep(possibleOptions);
  }
  if (
    possibleOptions.kind === "token" &&
    possibleOptions.token.kind === "punctuation" &&
    possibleOptions.token.value === "("
  ) {
    tokens.commitOpening("(");
    const options = tokens.traverseOpaqueParenthesized();
    if (options.kind !== "traversed") {
      return failureFromOpaqueTraversal(options);
    }
    optionsSpan = options.span;
  }

  const clauseSpan = spanning(generatedKeywordSpan, optionsSpan ?? identityKeywordSpan);
  return parsed({
    kind: "identity",
    keywordSpan: generatedKeywordSpan,
    generatedKeywordSpan,
    mode,
    asKeywordSpan,
    identityKeywordSpan,
    optionsSpan,
    establishmentSpan: generatedKeywordSpan,
    underlyingClauseSpan: clauseSpan,
    clauseSpan,
    explicitConstraintName: null,
  });
}

function parseColumnReferencesClause(
  tokens: CreateTableStructuralReader,
  explicitConstraintName: ExplicitConstraintWrapper | null,
): ParseResult<ParsedColumnReferencesClauseOccurrence> {
  const references = expectWord(tokens, "references");
  if (isFailure(references)) {
    return references;
  }
  const referencedRelation = parseQualifiedIdentity(tokens);
  if (isFailure(referencedRelation)) {
    return referencedRelation;
  }
  const referencedColumns = parseOptionalReferencedColumnList(tokens);
  if (isFailure(referencedColumns)) {
    return referencedColumns;
  }

  const underlyingEnd =
    referencedColumns.value.kind === "explicit_referenced_columns"
      ? referencedColumns.value.list.span
      : referencedRelation.value.span;
  const underlyingClauseSpan = spanning(references.value.span, underlyingEnd);
  return parsed({
    kind: "references",
    keywordSpan: references.value.span,
    establishmentSpan: explicitConstraintName?.constraintKeywordSpan ?? references.value.span,
    underlyingClauseSpan,
    clauseSpan:
      explicitConstraintName === null
        ? underlyingClauseSpan
        : spanning(explicitConstraintName.constraintKeywordSpan, underlyingEnd),
    referencedRelation: referencedRelation.value,
    referencedColumns: referencedColumns.value,
    explicitConstraintName,
  });
}

function parseDefaultExpression(tokens: CreateTableStructuralReader): ParseResult<SourceSpan> {
  const atom = parseDefaultAtom(tokens);
  if (isFailure(atom)) {
    return atom;
  }

  let expressionEnd = atom.value;
  for (;;) {
    const possibleCast = tokens.peek();
    if (possibleCast.kind === "refused") {
      return failureFromStep(possibleCast);
    }
    if (
      possibleCast.kind !== "token" ||
      possibleCast.token.kind !== "operator" ||
      possibleCast.token.value !== "::"
    ) {
      break;
    }

    tokens.consumeCurrent();
    const type = parseTypeShape(tokens);
    if (isFailure(type)) {
      return type;
    }
    expressionEnd = type.value.span;
  }

  return parsed(spanning(atom.value, expressionEnd));
}

function parseDefaultAtom(tokens: CreateTableStructuralReader): ParseResult<SourceSpan> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }

  if (step.token.kind === "numeric") {
    tokens.consumeCurrent();
    return parsed(step.token.span);
  }

  if (step.token.kind === "operator" && (step.token.value === "+" || step.token.value === "-")) {
    tokens.consumeCurrent();
    const numeric = tokens.peek();
    if (numeric.kind !== "token") {
      return failureFromStep(numeric);
    }
    if (numeric.token.kind !== "numeric") {
      return notRecognizedAt(numeric.token.span);
    }
    tokens.consumeCurrent();
    return parsed(spanning(step.token.span, numeric.token.span));
  }

  if (step.token.kind === "standard_string" || step.token.kind === "escape_string") {
    tokens.consumeCurrent();
    return parsed(step.token.span);
  }

  if (step.token.kind === "word" && DEFAULT_KEYWORD_ATOMS.has(step.token.folded)) {
    tokens.consumeCurrent();
    return parsed(step.token.span);
  }

  if (step.token.kind === "punctuation" && step.token.value === "(") {
    tokens.commitOpening("(");
    const expression = tokens.traverseOpaqueParenthesized();
    return expression.kind === "traversed"
      ? parsed(expression.span)
      : failureFromOpaqueTraversal(expression);
  }

  const functionName = parseQualifiedIdentity(tokens);
  if (isFailure(functionName)) {
    return functionName;
  }
  const opening = expectPunctuation(tokens, "(");
  if (isFailure(opening)) {
    return opening;
  }
  const argumentsSpan = tokens.traverseOpaqueParenthesized("optional");
  if (argumentsSpan.kind !== "traversed") {
    return failureFromOpaqueTraversal(argumentsSpan);
  }
  return parsed(spanning(functionName.value.span, argumentsSpan.span));
}

function isBareColumnClauseKind(folded: string): folded is BareColumnClauseKind {
  return (
    folded === "check" ||
    folded === "default" ||
    folded === "generated" ||
    folded === "not" ||
    folded === "null" ||
    folded === "primary" ||
    folded === "references" ||
    folded === "unique"
  );
}

function isNameableColumnClauseKind(
  folded: string,
): folded is Exclude<BareColumnClauseKind, "default" | "generated"> {
  return folded !== "default" && folded !== "generated" && isBareColumnClauseKind(folded);
}

function parsedColumnClauseKind(
  kind: Exclude<BareColumnClauseKind, "check" | "default" | "generated" | "references">,
): "not_null" | "null" | "primary_key" | "unique" {
  if (kind === "not") {
    return "not_null";
  }
  if (kind === "primary") {
    return "primary_key";
  }
  return kind;
}
