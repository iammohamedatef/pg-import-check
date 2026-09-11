import {
  expectPunctuation,
  expectWord,
  failureFromStep,
  isFailure,
  notRecognizedAt,
  parseQualifiedIdentity,
  parsed,
  spanning,
  type ParseResult,
  type QualifiedIdentity,
} from "./create-table-parser-primitives.js";
import type { CreateTableStructuralReader } from "./create-table-structural-reader.js";
import type { CreateTableToken, SourceSpan } from "./create-table-token-source.js";

export type ParsedInheritsClause = {
  readonly keywordSpan: SourceSpan;
  readonly relations: readonly QualifiedIdentity[];
  readonly span: SourceSpan;
};

export function parseInheritsClause(
  tokens: CreateTableStructuralReader,
): ParseResult<ParsedInheritsClause> {
  const keyword = expectWord(tokens, "inherits");
  if (isFailure(keyword)) {
    return keyword;
  }
  const opening = expectPunctuation(tokens, "(");
  if (isFailure(opening)) {
    return opening;
  }

  const relations: QualifiedIdentity[] = [];
  const firstRelation = parseQualifiedIdentity(tokens);
  if (isFailure(firstRelation)) {
    return firstRelation;
  }
  relations.push(firstRelation.value);

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
    const relation = parseQualifiedIdentity(tokens);
    if (isFailure(relation)) {
      return relation;
    }
    relations.push(relation.value);
  }

  return parsed({
    keywordSpan: keyword.value.span,
    relations,
    span: spanning(keyword.value.span, closing.span),
  });
}
