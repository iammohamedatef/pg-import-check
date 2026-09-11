import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import type { CreateTableStructuralReader } from "./create-table-structural-reader.js";
import type { SourceSpan } from "./create-table-token-source.js";
import {
  expectPunctuation,
  expectWord,
  failureFromOpaqueTraversal,
  isFailure,
  parsed,
  spanning,
  type ParseResult,
} from "./create-table-parser-primitives.js";

export type ParsedTableCheckConstraint = {
  readonly kind: "check";
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly expressionSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

export function parseCheckProduction(
  tokens: CreateTableStructuralReader,
  explicitConstraintName: ExplicitConstraintWrapper | null,
): ParseResult<ParsedTableCheckConstraint> {
  const keyword = expectWord(tokens, "check");
  if (isFailure(keyword)) {
    return keyword;
  }
  const opening = expectPunctuation(tokens, "(");
  if (isFailure(opening)) {
    return opening;
  }
  const expression = tokens.traverseOpaqueParenthesized();
  if (expression.kind !== "traversed") {
    return failureFromOpaqueTraversal(expression);
  }

  const underlyingClauseSpan = spanning(keyword.value.span, expression.span);
  return parsed({
    kind: "check",
    keywordSpan: keyword.value.span,
    establishmentSpan: explicitConstraintName?.constraintKeywordSpan ?? keyword.value.span,
    expressionSpan: expression.span,
    underlyingClauseSpan,
    clauseSpan:
      explicitConstraintName === null
        ? underlyingClauseSpan
        : spanning(explicitConstraintName.constraintKeywordSpan, expression.span),
    explicitConstraintName,
  });
}
