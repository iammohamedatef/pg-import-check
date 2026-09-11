import type { AcceptedRawInput } from "./input-profile.js";
import {
  type ExplicitConstraintNameOccurrence,
  selectDuplicateExplicitConstraintNameCandidate,
} from "./create-table-constraint-names.js";
export type {
  ExplicitConstraintNameIdentity,
  ExplicitConstraintNameOccurrence,
  ExplicitConstraintWrapper,
} from "./create-table-constraint-names.js";
import {
  selectColumnDeclarationCandidate,
  selectEarlierDeclarationCandidate,
} from "./create-table-column-conflicts.js";
export type {
  AmbiguousDeclarationRefusal,
  ConflictingColumnDeclarationRefusal,
  ParsedColumnClauseOccurrence,
} from "./create-table-column-conflicts.js";
import { parseCoreColumn, type CoreColumnShape } from "./create-table-column-grammar.js";
export type { CoreColumnShape } from "./create-table-column-grammar.js";
import type { ParsedTableCheckConstraint } from "./create-table-check-grammar.js";
export type { ParsedTableCheckConstraint } from "./create-table-check-grammar.js";
import { parseInheritsClause, type ParsedInheritsClause } from "./create-table-inherits-grammar.js";
export type { ParsedInheritsClause } from "./create-table-inherits-grammar.js";
import {
  createTableTokenSource,
  type CreateTableToken,
  type SourceSpan,
} from "./create-table-token-source.js";
import { CreateTableStructuralReader } from "./create-table-structural-reader.js";
import {
  expectPunctuation,
  expectWord,
  failureFromOpaqueTraversal,
  failureFromStep,
  isFailure,
  isWord,
  notRecognizedAt,
  parseExplicitConstraintWrapper,
  parseQualifiedIdentity,
  parsed,
  spanning,
  type ParseResult,
  type QualifiedIdentity,
  type RecognitionFailure,
} from "./create-table-parser-primitives.js";
export type {
  CreateTableCoreShapeRefusal,
  CreateTableGrammarBoundary,
  IdentifierIdentity,
  QualifiedIdentity,
  TypeModifierDigitSpans,
  TypeShape,
} from "./create-table-parser-primitives.js";
import {
  type ParsedTableKeyConstraint,
  selectModeledKeyDeclarationCandidate,
} from "./create-table-key-constraints.js";
import { buildTargetColumnAssociations } from "./create-table-target-column-association.js";
export type {
  ParsedTableKeyConstraint,
  TableKeyColumnReference,
  TableKeyConstraintKind,
} from "./create-table-key-constraints.js";
import {
  type ParsedTableForeignKeyConstraint,
  selectModeledForeignKeyDeclarationCandidate,
} from "./create-table-foreign-key-constraints.js";
export type {
  ForeignKeyColumnList,
  ForeignKeyReferencedColumns,
  ParsedColumnReferencesClauseOccurrence,
  ParsedTableForeignKeyConstraint,
} from "./create-table-foreign-key-constraints.js";
import {
  parseNamedTableConstraint,
  parseTableCheckConstraint,
  parseTableForeignKeyConstraint,
  parseTableKeyConstraint,
  type ParsedTableConstraintElement,
} from "./create-table-table-constraint-grammar.js";

export type CreateTableElement =
  | {
      readonly kind: "column";
      readonly column: CoreColumnShape;
    }
  | ParsedTableConstraintElement;

export type CreateTableBody = {
  readonly openingParenthesisSpan: SourceSpan;
  readonly elements: readonly CreateTableElement[];
  readonly closingParenthesisSpan: SourceSpan;
  readonly span: SourceSpan;
};

export type ParsedPartitionByClause = {
  readonly partitionKeywordSpan: SourceSpan;
  readonly byKeywordSpan: SourceSpan;
  readonly expressionSpan: SourceSpan;
  readonly span: SourceSpan;
};

export type CreateTableDerivedViews = {
  readonly columns: readonly CoreColumnShape[];
  readonly tableKeyConstraints: readonly ParsedTableKeyConstraint[];
  readonly tableCheckConstraints: readonly ParsedTableCheckConstraint[];
  readonly tableForeignKeyConstraints: readonly ParsedTableForeignKeyConstraint[];
  readonly explicitConstraintNames: readonly ExplicitConstraintNameOccurrence[];
};

export type CreateTableCoreShape = {
  readonly temporary: boolean;
  readonly table: QualifiedIdentity;
  readonly body: CreateTableBody;
  readonly inheritsClause: ParsedInheritsClause | null;
  readonly partitionByClause: ParsedPartitionByClause | null;
  readonly derived: CreateTableDerivedViews;
  readonly span: SourceSpan;
};

/**
 * `not_recognized_by_create_table_grammar` is the permanent private family-level grammar miss.
 * It makes no claim about PostgreSQL validity, compatibility, or a final public refusal.
 */
export type CreateTableCoreShapeResult =
  | {
      readonly kind: "recognized_core_shape";
      readonly coreShape: CreateTableCoreShape;
    }
  | RecognitionFailure;

export function recognizeCreateTableCoreShape(input: AcceptedRawInput): CreateTableCoreShapeResult {
  const tokens = new CreateTableStructuralReader(createTableTokenSource(input));
  const create = expectWord(tokens, "create");
  if (isFailure(create)) {
    return create;
  }

  const tablePrefix = parseTablePrefix(tokens);
  if (isFailure(tablePrefix)) {
    return tablePrefix;
  }

  const optionalExistenceClause = parseOptionalExistenceClause(tokens);
  if (optionalExistenceClause !== null) {
    return optionalExistenceClause;
  }

  const table = parseQualifiedIdentity(tokens);
  if (isFailure(table)) {
    return table;
  }

  const body = parseCreateTableBody(tokens);
  if (isFailure(body)) {
    return body;
  }

  let inheritsClause: ParsedInheritsClause | null = null;
  const possibleInherits = tokens.peek();
  if (possibleInherits.kind === "refused") {
    return failureFromStep(possibleInherits);
  }
  if (possibleInherits.kind === "token" && isWord(possibleInherits.token, "inherits")) {
    const inherits = parseInheritsClause(tokens);
    if (isFailure(inherits)) {
      return inherits;
    }
    inheritsClause = inherits.value;
  }

  const partitionByClause = parseOptionalPartitionByClause(tokens);
  if (isFailure(partitionByClause)) {
    return partitionByClause;
  }

  const stepAfterShape = tokens.peek();
  if (
    stepAfterShape.kind === "token" &&
    stepAfterShape.token.kind === "punctuation" &&
    stepAfterShape.token.value === ";"
  ) {
    tokens.consumeCurrent();
  }

  const terminal = tokens.peek();
  if (terminal.kind !== "eof") {
    return failureFromStep(terminal);
  }

  const derived = deriveCreateTableViews(body.value.elements);
  const shapeEnd = partitionByClause.value?.span ?? inheritsClause?.span ?? body.value.span;
  const coreShape: CreateTableCoreShape = {
    temporary: tablePrefix.value.temporary,
    table: table.value,
    body: body.value,
    inheritsClause,
    partitionByClause: partitionByClause.value,
    derived,
    span: spanning(create.value.span, shapeEnd),
  };

  let declarationCandidate = selectColumnDeclarationCandidate(derived.columns);
  const targetColumnsByIdentity = buildTargetColumnAssociations(derived.columns);
  const modeledKeyCandidate = selectModeledKeyDeclarationCandidate(
    derived.columns,
    derived.tableKeyConstraints,
    targetColumnsByIdentity,
  );
  if (modeledKeyCandidate !== null) {
    declarationCandidate = selectEarlierDeclarationCandidate(
      declarationCandidate,
      modeledKeyCandidate,
    );
  }
  const modeledForeignKeyCandidate = selectModeledForeignKeyDeclarationCandidate(
    derived.columns,
    derived.tableForeignKeyConstraints,
    targetColumnsByIdentity,
  );
  if (modeledForeignKeyCandidate !== null) {
    declarationCandidate = selectEarlierDeclarationCandidate(
      declarationCandidate,
      modeledForeignKeyCandidate,
    );
  }
  const duplicateNameCandidate = selectDuplicateExplicitConstraintNameCandidate(
    derived.explicitConstraintNames,
  );
  if (duplicateNameCandidate !== null) {
    declarationCandidate = selectEarlierDeclarationCandidate(
      declarationCandidate,
      duplicateNameCandidate,
    );
  }
  if (declarationCandidate !== null) {
    return { kind: "refused", refusal: declarationCandidate.refusal };
  }

  return { kind: "recognized_core_shape", coreShape };
}

function parseTablePrefix(
  tokens: CreateTableStructuralReader,
): ParseResult<{ readonly temporary: boolean }> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }

  if (isWord(step.token, "table")) {
    tokens.consumeCurrent();
    return parsed({ temporary: false });
  }

  if (!isWord(step.token, "temp") && !isWord(step.token, "temporary")) {
    return notRecognizedAt(step.token.span);
  }

  tokens.consumeCurrent();
  const table = expectWord(tokens, "table");
  if (isFailure(table)) {
    return table;
  }
  return parsed({ temporary: true });
}

function parseOptionalExistenceClause(
  tokens: CreateTableStructuralReader,
): RecognitionFailure | null {
  const step = tokens.peek();
  if (step.kind === "refused") {
    return failureFromStep(step);
  }
  if (step.kind === "eof" || !isWord(step.token, "if")) {
    return null;
  }

  tokens.consumeCurrent();
  const not = expectWord(tokens, "not");
  if (isFailure(not)) {
    return not;
  }
  const exists = expectWord(tokens, "exists");
  return isFailure(exists) ? exists : null;
}

function parseCreateTableBody(tokens: CreateTableStructuralReader): ParseResult<CreateTableBody> {
  const opening = expectPunctuation(tokens, "(");
  if (isFailure(opening)) {
    return opening;
  }

  const elements: CreateTableElement[] = [];
  const firstElement = parseCoreTableElement(tokens);
  if (isFailure(firstElement)) {
    return firstElement;
  }
  elements.push(firstElement.value);

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

    const element = parseCoreTableElement(tokens);
    if (isFailure(element)) {
      return element;
    }
    elements.push(element.value);
  }

  return parsed({
    openingParenthesisSpan: opening.value.span,
    elements,
    closingParenthesisSpan: closing.span,
    span: spanning(opening.value.span, closing.span),
  });
}

function parseOptionalPartitionByClause(
  tokens: CreateTableStructuralReader,
): ParseResult<ParsedPartitionByClause | null> {
  const possiblePartition = tokens.peek();
  if (possiblePartition.kind === "refused") {
    return failureFromStep(possiblePartition);
  }
  if (possiblePartition.kind !== "token" || !isWord(possiblePartition.token, "partition")) {
    return parsed(null);
  }

  const partition = expectWord(tokens, "partition");
  if (isFailure(partition)) {
    return partition;
  }
  const by = expectWord(tokens, "by");
  if (isFailure(by)) {
    return by;
  }

  const expression = tokens.traverseOpaqueExpression(";");
  if (expression.kind !== "traversed") {
    return failureFromOpaqueTraversal(expression);
  }

  return parsed({
    partitionKeywordSpan: partition.value.span,
    byKeywordSpan: by.value.span,
    expressionSpan: expression.span,
    span: spanning(partition.value.span, expression.span),
  });
}

function parseCoreTableElement(
  tokens: CreateTableStructuralReader,
): ParseResult<CreateTableElement> {
  const step = tokens.peek();
  if (step.kind !== "token") {
    return failureFromStep(step);
  }

  if (step.token.kind === "word") {
    switch (step.token.folded) {
      case "constraint": {
        const wrapper = parseExplicitConstraintWrapper(tokens);
        return isFailure(wrapper) ? wrapper : parseNamedTableConstraint(tokens, wrapper.value);
      }

      case "check":
        return parseTableCheckConstraint(tokens, null);

      case "foreign":
        return parseTableForeignKeyConstraint(tokens, null);

      case "primary":
        return parseTableKeyConstraint(tokens, "primary_key");

      case "unique":
        return parseTableKeyConstraint(tokens, "unique");

      case "like":
      case "exclude":
        return notRecognizedAt(step.token.span);
    }
  }

  const column = parseCoreColumn(tokens);
  return isFailure(column) ? column : parsed({ kind: "column", column: column.value });
}

function deriveCreateTableViews(elements: readonly CreateTableElement[]): CreateTableDerivedViews {
  const columns: CoreColumnShape[] = [];
  const tableKeyConstraints: ParsedTableKeyConstraint[] = [];
  const tableCheckConstraints: ParsedTableCheckConstraint[] = [];
  const tableForeignKeyConstraints: ParsedTableForeignKeyConstraint[] = [];
  const explicitConstraintNames: ExplicitConstraintNameOccurrence[] = [];

  for (const element of elements) {
    if (element.kind === "column") {
      const targetColumnOrdinal = columns.length;
      columns.push(element.column);
      for (const occurrence of element.column.clauseOccurrences) {
        const wrapper = occurrence.explicitConstraintName;
        if (wrapper === null) {
          continue;
        }
        if (occurrence.kind === "default") {
          throw new Error("CREATE TABLE named DEFAULT invariant violated.");
        }
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
      continue;
    }

    if (element.kind === "table_key") {
      tableKeyConstraints.push(element.constraint);
    } else if (element.kind === "table_check") {
      tableCheckConstraints.push(element.constraint);
    } else {
      tableForeignKeyConstraints.push(element.constraint);
    }

    const wrapper = element.constraint.explicitConstraintName;
    if (wrapper === null) {
      continue;
    }
    const underlyingKeywordSpan =
      element.constraint.kind === "foreign_key"
        ? element.constraint.foreignKeywordSpan
        : element.constraint.keywordSpan;
    explicitConstraintNames.push({
      ...wrapper,
      scope: "table",
      kind: element.constraint.kind,
      underlyingKeywordSpan,
      underlyingClauseSpan: element.constraint.underlyingClauseSpan,
      clauseSpan: element.constraint.clauseSpan,
      sourceOrder: explicitConstraintNames.length,
      targetColumnOrdinal: null,
    });
  }

  return {
    columns,
    tableKeyConstraints,
    tableCheckConstraints,
    tableForeignKeyConstraints,
    explicitConstraintNames,
  };
}
