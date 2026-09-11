import {
  selectColumnDeclarationCandidate,
  selectEarlierDeclarationCandidate,
  type ColumnDeclarationCandidate,
  type ColumnAmbiguityCandidate,
} from "./create-table-column-conflicts.js";
import { selectDuplicateExplicitConstraintNameCandidate } from "./create-table-constraint-names.js";
import { selectModeledKeyDeclarationCandidate } from "./create-table-key-constraints.js";
import { selectModeledForeignKeyDeclarationCandidate } from "./create-table-foreign-key-constraints.js";
import {
  buildTargetColumnAssociations,
  NO_TARGET_COLUMN_ORDINAL,
  uniquelyAssociatedOrdinal,
} from "./create-table-target-column-association.js";
import type { CreateTableElement } from "./create-table-core-shape.js";
import type { SourceSpan } from "./create-table-token-source.js";
import {
  ddlQualifiedIdentityKey,
  type DdlEvidence,
  type DdlRecognitionResult,
} from "./ddl-evidence.js";
import type { DdlStatement } from "./ddl-statements.js";
import { deriveDdlViews } from "./ddl-table.js";

export function associateDdl(statements: readonly DdlStatement[]): DdlRecognitionResult {
  const tables = statements.filter((s) => s.kind === "table");
  const targetStatement = tables[0];
  if (targetStatement === undefined)
    return { kind: "refused", refusal: { refusalId: "no_target_table" } };
  const second = tables[1];
  if (second !== undefined)
    return {
      kind: "refused",
      refusal: {
        refusalId: "multiple_target_tables",
        actualTargetCount: tables.length,
        span: second.start,
      },
    };
  const target = targetStatement.value;
  const targetKey = ddlQualifiedIdentityKey(target.table);
  for (const statement of statements) {
    if (statement.kind === "table" || statement.kind === "enum" || statement.kind === "function")
      continue;
    if (ddlQualifiedIdentityKey(statement.value.table) !== targetKey) {
      return {
        kind: "refused",
        refusal: {
          refusalId: "statement_targets_other_relation",
          span: statement.value.table.span,
        },
      };
    }
  }

  // Statement order gives a linear merge of table elements and ALTER additions.
  const elements: CreateTableElement[] = [];
  for (const statement of statements) {
    if (statement.kind === "table") elements.push(...statement.value.body.elements);
    else if (statement.kind === "addition") elements.push(statement.value.element);
  }
  const associated = deriveDdlViews(elements);
  const columns = associated.columns;
  const targetColumns = buildTargetColumnAssociations(columns);
  let selected = selectColumnDeclarationCandidate(columns);
  function select(candidate: ColumnDeclarationCandidate | null): void {
    if (candidate !== null) selected = selectEarlierDeclarationCandidate(selected, candidate);
  }
  select(
    selectModeledKeyDeclarationCandidate(columns, associated.tableKeyConstraints, targetColumns),
  );
  select(
    selectModeledForeignKeyDeclarationCandidate(
      columns,
      associated.tableForeignKeyConstraints,
      targetColumns,
    ),
  );
  select(selectDuplicateExplicitConstraintNameCandidate(associated.explicitConstraintNames));

  const firstObjects = new Map<string, Map<string, SourceSpan>>();
  function duplicate(
    namespace: string,
    key: string,
    span: SourceSpan,
    rule = 2,
    ordinal = NO_TARGET_COLUMN_ORDINAL,
  ): void {
    let namespaceMap = firstObjects.get(namespace);
    if (namespaceMap === undefined) {
      namespaceMap = new Map();
      firstObjects.set(namespace, namespaceMap);
    }
    const earlier = namespaceMap.get(key);
    if (earlier === undefined) namespaceMap.set(key, span);
    else select(ambiguity(span, earlier, key, rule, ordinal));
  }
  const enums = new Map<
    string,
    DdlEvidence["enums"] extends ReadonlyMap<string, infer T> ? T : never
  >();
  const functions = new Map<
    string,
    DdlEvidence["functions"] extends ReadonlyMap<string, infer T> ? T : never
  >();
  const indexes: DdlEvidence["indexes"][number][] = [];
  const triggers: DdlEvidence["triggers"][number][] = [];
  const policies: DdlEvidence["policies"][number][] = [];
  const rls: DdlEvidence["rls"][number][] = [];
  const additions: DdlEvidence["additions"][number][] = [];
  const usedEnums = new Set(columns.map((c) => ddlQualifiedIdentityKey(c.type.name)));
  const usedFunctions = new Set<string>();
  for (const statement of statements) {
    const { start } = statement;
    switch (statement.kind) {
      case "table":
        break;
      case "addition":
        additions.push(statement.value);
        break;
      case "enum": {
        const value = statement.value;
        const key = ddlQualifiedIdentityKey(value.name);
        duplicate("enum", key, start);
        enums.set(key, value);
        const labels = new Map<string, SourceSpan>();
        for (const [i, label] of value.labels.entries()) {
          const span = value.labelSpans[i];
          if (span === undefined) throw new Error("Enum label evidence invariant");
          const earlier = labels.get(label);
          if (earlier === undefined) labels.set(label, span);
          else select(ambiguity(start, earlier, label, 5));
        }
        break;
      }
      case "function": {
        const key = ddlQualifiedIdentityKey(statement.value.name);
        duplicate("function", key, start);
        functions.set(key, statement.value);
        break;
      }
      case "rls":
        duplicate("rls", statement.value.axis, start, 3);
        rls.push(statement.value);
        break;
      case "policy":
        duplicate("policy", statement.value.name.identity, start);
        policies.push(statement.value);
        break;
      case "trigger":
        duplicate("trigger", statement.value.name.identity, start);
        usedFunctions.add(ddlQualifiedIdentityKey(statement.value.function));
        triggers.push(statement.value);
        break;
      case "index": {
        const value = statement.value;
        duplicate("index", value.name.identity, start);
        indexes.push(value);
        const seen = new Map<string, SourceSpan>();
        let valid = true;
        let ordinal = NO_TARGET_COLUMN_ORDINAL;
        for (const member of value.columns.columnReferences) {
          const association = targetColumns.get(member.identity);
          const memberOrdinal = uniquelyAssociatedOrdinal(association);
          ordinal = Math.min(ordinal, memberOrdinal);
          const earlier = seen.get(member.identity);
          if (earlier !== undefined || association === undefined) {
            valid = false;
            select(ambiguity(start, earlier ?? member.span, member.identity, 6, memberOrdinal));
          }
          if (association?.kind !== "unique") valid = false;
          if (earlier === undefined) seen.set(member.identity, member.span);
        }
        if (valid)
          duplicate(
            "modeled_index",
            JSON.stringify([value.unique, value.columns.columnReferences.map((c) => c.identity)]),
            start,
            10,
            ordinal,
          );
        break;
      }
    }
  }
  if (selected !== null) return { kind: "refused", refusal: selected.refusal };
  for (const statement of statements) {
    if (
      (statement.kind === "enum" &&
        !usedEnums.has(ddlQualifiedIdentityKey(statement.value.name))) ||
      (statement.kind === "function" &&
        !usedFunctions.has(ddlQualifiedIdentityKey(statement.value.name)))
    ) {
      return {
        kind: "refused",
        refusal: { refusalId: "unassociated_auxiliary_declaration", span: statement.start },
      };
    }
  }
  return {
    kind: "recognized",
    evidence: {
      target,
      columns,
      associated,
      additions,
      enums,
      functions,
      indexes,
      triggers,
      policies,
      rls,
    },
  };
}

function ambiguity(
  span: SourceSpan,
  earlier: SourceSpan,
  identity: string,
  rule: number,
  ordinal = NO_TARGET_COLUMN_ORDINAL,
): ColumnAmbiguityCandidate {
  return {
    kind: "ambiguous_declaration",
    establishmentOffset: span.start.rawByteOffset,
    earlierDeclarationOffset: earlier.start.rawByteOffset,
    targetColumnOrdinal: ordinal,
    normalizedIdentity: identity,
    ambiguityRuleOrder: rule,
    refusal: { refusalId: "ambiguous_declaration", span },
  };
}
