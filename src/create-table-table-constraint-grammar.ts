import {
  parseCheckProduction,
  type ParsedTableCheckConstraint,
} from "./create-table-check-grammar.js";
import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import type { ParsedTableForeignKeyConstraint } from "./create-table-foreign-key-constraints.js";
import type { ParsedTableKeyConstraint } from "./create-table-key-constraints.js";
import {
  expectWord,
  failureFromStep,
  isFailure,
  isWord,
  notRecognizedAt,
  parseOptionalReferencedColumnList,
  parseQualifiedIdentity,
  parseSimpleColumnList,
  parsed,
  spanning,
  type ParseResult,
} from "./create-table-parser-primitives.js";
import type { CreateTableStructuralReader } from "./create-table-structural-reader.js";

export type ParsedTableConstraintElement =
  | {
      readonly kind: "table_key";
      readonly constraint: ParsedTableKeyConstraint;
    }
  | {
      readonly kind: "table_check";
      readonly constraint: ParsedTableCheckConstraint;
    }
  | {
      readonly kind: "table_foreign_key";
      readonly constraint: ParsedTableForeignKeyConstraint;
    };

export function parseTableKeyConstraint(
  tokens: CreateTableStructuralReader,
  kind: ParsedTableKeyConstraint["kind"],
  explicitConstraintName: ExplicitConstraintWrapper | null = null,
): ParseResult<ParsedTableConstraintElement> {
  const keyword = tokens.peek();
  if (keyword.kind !== "token" || keyword.token.kind !== "word") {
    throw new Error("CREATE TABLE table-key dispatch invariant violated.");
  }
  tokens.consumeCurrent();

  if (kind === "primary_key") {
    const key = expectWord(tokens, "key");
    if (isFailure(key)) {
      return key;
    }
  }

  const columnList = parseSimpleColumnList(tokens);
  if (isFailure(columnList)) {
    return columnList;
  }

  const underlyingClauseSpan = spanning(keyword.token.span, columnList.value.span);
  return parsed({
    kind: "table_key",
    constraint: {
      kind,
      keywordSpan: keyword.token.span,
      establishmentSpan: explicitConstraintName?.constraintKeywordSpan ?? keyword.token.span,
      underlyingClauseSpan,
      clauseSpan:
        explicitConstraintName === null
          ? underlyingClauseSpan
          : spanning(explicitConstraintName.constraintKeywordSpan, columnList.value.span),
      columnReferences: columnList.value.columnReferences,
      explicitConstraintName,
    },
  });
}

export function parseNamedTableConstraint(
  tokens: CreateTableStructuralReader,
  explicitConstraintName: ExplicitConstraintWrapper,
): ParseResult<ParsedTableConstraintElement> {
  const underlying = tokens.peek();
  if (underlying.kind !== "token") {
    return failureFromStep(underlying);
  }
  if (isWord(underlying.token, "primary")) {
    return parseTableKeyConstraint(tokens, "primary_key", explicitConstraintName);
  }
  if (isWord(underlying.token, "unique")) {
    return parseTableKeyConstraint(tokens, "unique", explicitConstraintName);
  }
  if (isWord(underlying.token, "check")) {
    return parseTableCheckConstraint(tokens, explicitConstraintName);
  }
  if (isWord(underlying.token, "foreign")) {
    return parseTableForeignKeyConstraint(tokens, explicitConstraintName);
  }
  return notRecognizedAt(underlying.token.span);
}

export function parseTableForeignKeyConstraint(
  tokens: CreateTableStructuralReader,
  explicitConstraintName: ExplicitConstraintWrapper | null,
): ParseResult<ParsedTableConstraintElement> {
  const foreign = expectWord(tokens, "foreign");
  if (isFailure(foreign)) {
    return foreign;
  }
  const key = expectWord(tokens, "key");
  if (isFailure(key)) {
    return key;
  }
  const localColumns = parseSimpleColumnList(tokens);
  if (isFailure(localColumns)) {
    return localColumns;
  }
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
  const underlyingClauseSpan = spanning(foreign.value.span, underlyingEnd);
  return parsed({
    kind: "table_foreign_key",
    constraint: {
      kind: "foreign_key",
      foreignKeywordSpan: foreign.value.span,
      keyKeywordSpan: key.value.span,
      referencesKeywordSpan: references.value.span,
      establishmentSpan: explicitConstraintName?.constraintKeywordSpan ?? foreign.value.span,
      underlyingClauseSpan,
      clauseSpan:
        explicitConstraintName === null
          ? underlyingClauseSpan
          : spanning(explicitConstraintName.constraintKeywordSpan, underlyingEnd),
      localColumns: localColumns.value,
      referencedRelation: referencedRelation.value,
      referencedColumns: referencedColumns.value,
      explicitConstraintName,
    },
  });
}

export function parseTableCheckConstraint(
  tokens: CreateTableStructuralReader,
  explicitConstraintName: ExplicitConstraintWrapper | null,
): ParseResult<ParsedTableConstraintElement> {
  const constraint = parseCheckProduction(tokens, explicitConstraintName);
  return isFailure(constraint)
    ? constraint
    : parsed({ kind: "table_check", constraint: constraint.value });
}
