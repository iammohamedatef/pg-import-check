import type {
  CreateTableCoreShape,
  CreateTableDerivedViews,
  CreateTableElement,
  ParsedPartitionByClause,
} from "./create-table-core-shape.js";
import { parseCoreColumn } from "./create-table-column-grammar.js";
import { parseInheritsClause } from "./create-table-inherits-grammar.js";
import {
  parseNamedTableConstraint,
  parseTableCheckConstraint,
  parseTableForeignKeyConstraint,
  parseTableKeyConstraint,
  type ParsedTableConstraintElement,
} from "./create-table-table-constraint-grammar.js";
import {
  failureFromOpaqueTraversal,
  parseExplicitConstraintWrapper,
  parseQualifiedIdentity,
  spanning,
} from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import { type DdlParser, take } from "./ddl-parser.js";

export function parseDdlConstraint(p: DdlParser): ParsedTableConstraintElement {
  const token = p.peek();
  if (token?.kind !== "word") p.fail(token);
  switch (token.folded) {
    case "constraint":
      return take(
        parseNamedTableConstraint(p.reader, take(parseExplicitConstraintWrapper(p.reader))),
      );
    case "primary":
      return take(parseTableKeyConstraint(p.reader, "primary_key"));
    case "unique":
      return take(parseTableKeyConstraint(p.reader, "unique"));
    case "foreign":
      return take(parseTableForeignKeyConstraint(p.reader, null));
    case "check":
      return take(parseTableCheckConstraint(p.reader, null));
    default:
      return p.fail(token);
  }
}

function element(p: DdlParser): CreateTableElement {
  const token = p.peek();
  if (token?.kind === "word") {
    if (["constraint", "primary", "unique", "foreign", "check"].includes(token.folded))
      return parseDdlConstraint(p);
    if (token.folded === "like" || token.folded === "exclude") p.fail(token);
  }
  return { kind: "column", column: take(parseCoreColumn(p.reader)) };
}

export function parseDdlTable(
  p: DdlParser,
  start: SourceSpan,
  temporary: boolean,
): CreateTableCoreShape {
  if (p.optionalWord("if")) {
    p.word("not");
    p.word("exists");
  }
  // Preserve the frozen table grammar's identifier-position miss behavior.
  const table = take(parseQualifiedIdentity(p.reader));
  const openingParenthesisSpan = p.punctuation("(");
  const elements: CreateTableElement[] = [element(p)];
  while (p.optionalPunctuation(",")) elements.push(element(p));
  const closingParenthesisSpan = p.punctuation(")");
  const body = {
    openingParenthesisSpan,
    closingParenthesisSpan,
    elements,
    span: spanning(openingParenthesisSpan, closingParenthesisSpan),
  };
  const inheritsClause = p.isWord("inherits") ? take(parseInheritsClause(p.reader)) : null;
  let partitionByClause: ParsedPartitionByClause | null = null;
  if (p.isWord("partition")) {
    const partitionKeywordSpan = p.word("partition");
    const byKeywordSpan = p.word("by");
    const result = p.reader.traverseOpaqueExpression(";");
    if (result.kind !== "traversed") take(failureFromOpaqueTraversal(result));
    else
      partitionByClause = {
        partitionKeywordSpan,
        byKeywordSpan,
        expressionSpan: result.span,
        span: spanning(partitionKeywordSpan, result.span),
      };
  }
  const span = spanning(start, partitionByClause?.span ?? inheritsClause?.span ?? body.span);
  p.lastSpan = span;
  return {
    temporary,
    table,
    body,
    inheritsClause,
    partitionByClause,
    derived: deriveDdlViews(elements),
    span,
  };
}

/** Physical columns stay in table order; auxiliary elements may precede the table. */
export function deriveDdlViews(elements: readonly CreateTableElement[]): CreateTableDerivedViews {
  const columns: CreateTableDerivedViews["columns"][number][] = [];
  const tableKeyConstraints: CreateTableDerivedViews["tableKeyConstraints"][number][] = [];
  const tableCheckConstraints: CreateTableDerivedViews["tableCheckConstraints"][number][] = [];
  const tableForeignKeyConstraints: CreateTableDerivedViews["tableForeignKeyConstraints"][number][] =
    [];
  const explicitConstraintNames: CreateTableDerivedViews["explicitConstraintNames"][number][] = [];
  for (const item of elements) {
    if (item.kind === "column") {
      const targetColumnOrdinal = columns.length;
      columns.push(item.column);
      for (const occurrence of item.column.clauseOccurrences) {
        const wrapper = occurrence.explicitConstraintName;
        if (wrapper === null) continue;
        if (occurrence.kind === "default") throw new Error("Named DEFAULT invariant");
        explicitConstraintNames.push({
          ...wrapper,
          scope: "column",
          kind: occurrence.kind,
          underlyingKeywordSpan: occurrence.keywordSpan,
          underlyingClauseSpan: occurrence.underlyingClauseSpan,
          clauseSpan: occurrence.clauseSpan,
          sourceOrder: explicitConstraintNames.length,
          targetColumnOrdinal,
        });
      }
    } else {
      const c = item.constraint;
      if (item.kind === "table_key") tableKeyConstraints.push(item.constraint);
      else if (item.kind === "table_check") tableCheckConstraints.push(item.constraint);
      else tableForeignKeyConstraints.push(item.constraint);
      if (c.explicitConstraintName !== null)
        explicitConstraintNames.push({
          ...c.explicitConstraintName,
          scope: "table",
          kind: c.kind,
          underlyingKeywordSpan: c.kind === "foreign_key" ? c.foreignKeywordSpan : c.keywordSpan,
          underlyingClauseSpan: c.underlyingClauseSpan,
          clauseSpan: c.clauseSpan,
          sourceOrder: explicitConstraintNames.length,
          targetColumnOrdinal: null,
        });
    }
  }
  return {
    columns,
    tableKeyConstraints,
    tableCheckConstraints,
    tableForeignKeyConstraints,
    explicitConstraintNames,
  };
}
