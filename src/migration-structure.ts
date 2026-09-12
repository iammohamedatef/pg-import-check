import type { IdentifierIdentity, QualifiedIdentity } from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import { ddlQualifiedIdentityKey } from "./ddl-evidence.js";
import type { ForeignKeyReferencedColumns } from "./create-table-foreign-key-constraints.js";
import type { MigrationDocumentIndex } from "./migration-document.js";
import type { MigrationTargetEvidence } from "./migration-evaluator.js";
import { createMigrationSource } from "./migration-source.js";
import { deriveImportContract } from "./migration-contract.js";

export type UniqueEvidence = {
  readonly name: IdentifierIdentity | null;
  readonly columns: readonly IdentifierIdentity[];
  readonly composite: boolean;
  readonly source: "constraint" | "index";
  readonly span: SourceSpan;
};
export type ForeignKeyEvidence = {
  readonly name: IdentifierIdentity | null;
  readonly columns: readonly IdentifierIdentity[];
  readonly referencedTable: QualifiedIdentity;
  readonly referencedColumns: readonly IdentifierIdentity[] | null;
  readonly nullable: readonly boolean[];
  readonly actions: readonly string[];
  readonly identityResolutionMayBeRequired: boolean;
  readonly referencedKeyEvidence: "database_generated" | "not_established";
  readonly supportingStatementOrdinals: readonly number[];
  readonly span: SourceSpan;
};
export type CheckEvidence = {
  readonly name: IdentifierIdentity | null;
  readonly expression: string;
  readonly expressionSemantics: "not_evaluated";
  readonly span: SourceSpan;
};
export type MigrationStructure = {
  readonly columns: readonly {
    readonly name: IdentifierIdentity;
    readonly type: string;
    readonly span: SourceSpan;
  }[];
  readonly unique: readonly UniqueEvidence[];
  readonly foreignKeys: readonly ForeignKeyEvidence[];
  readonly checks: readonly CheckEvidence[];
  readonly enums: readonly {
    readonly column: IdentifierIdentity;
    readonly type: QualifiedIdentity;
    readonly labels: readonly string[] | null;
    readonly span: SourceSpan;
  }[];
  readonly triggers: readonly {
    readonly name: IdentifierIdentity;
    readonly timing: string;
    readonly events: readonly string[];
    readonly updateOf: readonly IdentifierIdentity[];
    readonly level: string;
    readonly whenPresent: boolean;
    readonly function: QualifiedIdentity;
    readonly effects: "not_evaluated";
    readonly span: SourceSpan;
  }[];
  readonly policies: readonly {
    readonly name: IdentifierIdentity;
    readonly command: string;
    readonly mode: string;
    readonly roles: readonly IdentifierIdentity[] | null;
    readonly usingPresent: boolean;
    readonly withCheckPresent: boolean;
    readonly span: SourceSpan;
  }[];
  readonly rls: readonly {
    readonly axis: "enabled" | "forced";
    readonly value: boolean;
    readonly span: SourceSpan;
  }[];
};

export function deriveMigrationStructure(
  index: MigrationDocumentIndex,
  evaluation: MigrationTargetEvidence,
  referenceEvaluation: (key: string) => MigrationTargetEvidence | null,
): MigrationStructure {
  const evidence = evaluation.evidence;
  if (evidence === null)
    return {
      columns: [],
      unique: [],
      foreignKeys: [],
      checks: [],
      enums: [],
      triggers: [],
      policies: [],
      rls: [],
    };
  const source = createMigrationSource(index, evaluation.includedStatements);
  const originalIdentifier = (name: IdentifierIdentity): IdentifierIdentity => ({
    ...name,
    span: source.span(name.span),
  });
  const originalQualified = (name: QualifiedIdentity): QualifiedIdentity => ({
    local: originalIdentifier(name.local),
    qualifier: name.qualifier === null ? null : originalIdentifier(name.qualifier),
    span: source.span(name.span),
  });
  const contract = deriveImportContract(evaluation);
  const columns = new Map(contract.columns.map((c) => [c.name.identity, c]));
  const unique: UniqueEvidence[] = [];
  const foreignKeys: ForeignKeyEvidence[] = [];
  const checks: CheckEvidence[] = [];
  const referenceCache = new Map<string, MigrationTargetEvidence | null>();
  function generatedReference(
    table: QualifiedIdentity,
    referenced: readonly IdentifierIdentity[] | null,
  ): readonly number[] {
    if (table.qualifier === null || referenced === null) return [];
    const key = ddlQualifiedIdentityKey(table);
    let other = referenceCache.get(key);
    if (other === undefined) {
      if (referenceCache.size >= 32) return [];
      other = key === evaluation.target.key ? evaluation : referenceEvaluation(key);
      referenceCache.set(key, other);
    }
    if (other === null || other.evidence === null || other.notEvaluated.length > 0) return [];
    const otherContract = deriveImportContract(other);
    if (otherContract.status !== "established_static_shape") return [];
    const matches = (list: readonly IdentifierIdentity[]) =>
      list.length === referenced.length &&
      list.every((c, i) => c.identity === referenced[i]?.identity);
    const keyVisible =
      matches(other.observed?.primaryKeyColumns ?? []) ||
      other.evidence.associated.tableKeyConstraints.some(
        (c) => c.kind === "unique" && matches(c.columnReferences),
      ) ||
      other.evidence.columns.some(
        (c) => matches([c.name]) && c.clauseOccurrences.some((k) => k.kind === "unique"),
      ) ||
      other.evidence.indexes.some((i) => i.unique && matches(i.columns.columnReferences));
    const generated =
      keyVisible &&
      referenced.some((r) => {
        const c = otherContract.columns.find((c) => c.name.identity === r.identity);
        return (
          c !== undefined &&
          (c.authority === "database_identity" ||
            c.authority === "database_generated_expression" ||
            c.authority === "database_sequence_default")
        );
      });
    return generated
      ? [
          ...other.includedStatements.map((s) => s.ordinal),
          ...other.generatedColumns.flatMap((g) => {
            const statement = index.statements.find(
              (s) => s.span.start.rawByteOffset === g.span.start.rawByteOffset,
            );
            return statement === undefined ? [] : [statement.ordinal];
          }),
        ]
      : [];
  }
  function addForeignKey(
    local: readonly IdentifierIdentity[],
    relation: QualifiedIdentity,
    refs: ForeignKeyReferencedColumns,
    name: IdentifierIdentity | null,
    projected: SourceSpan,
  ) {
    const span = source.span(projected);
    const referenced =
      refs.kind === "explicit_referenced_columns" ? refs.list.columnReferences : null;
    const supportingStatementOrdinals = generatedReference(relation, referenced);
    const generated = supportingStatementOrdinals.length > 0;
    // Removed action clauses belong to this REFERENCES clause until its next same-depth delimiter.
    const actions = evaluation.recognitionObservations
      .filter(
        (o) =>
          o.kind === "foreign_key_action" &&
          o.referencesSpan.start.rawByteOffset >= span.start.rawByteOffset &&
          o.referencesSpan.start.rawByteOffset <= span.end.rawByteOffset,
      )
      .map((o) => (o.kind === "foreign_key_action" ? o.action : ""));
    foreignKeys.push({
      name: name === null ? null : originalIdentifier(name),
      columns: local.map(originalIdentifier),
      referencedTable: originalQualified(relation),
      referencedColumns: referenced?.map(originalIdentifier) ?? null,
      nullable: local.map((c) => columns.get(c.identity)?.nullable ?? true),
      actions,
      identityResolutionMayBeRequired: generated,
      referencedKeyEvidence: generated ? "database_generated" : "not_established",
      supportingStatementOrdinals,
      span,
    });
  }
  for (const column of evidence.columns) {
    for (const clause of column.clauseOccurrences) {
      const name = clause.explicitConstraintName?.name ?? null;
      if (clause.kind === "unique")
        unique.push({
          name: name === null ? null : originalIdentifier(name),
          columns: [originalIdentifier(column.name)],
          composite: false,
          source: "constraint",
          span: source.span(clause.clauseSpan),
        });
      if (clause.kind === "references")
        addForeignKey(
          [column.name],
          clause.referencedRelation,
          clause.referencedColumns,
          name,
          clause.clauseSpan,
        );
      if (clause.kind === "check")
        checks.push({
          name: name === null ? null : originalIdentifier(name),
          expression: source.text(clause.expressionSpan),
          expressionSemantics: "not_evaluated",
          span: source.span(clause.clauseSpan),
        });
    }
  }
  for (const constraint of evidence.associated.tableKeyConstraints) {
    if (constraint.kind === "unique")
      unique.push({
        name:
          constraint.explicitConstraintName === null
            ? null
            : originalIdentifier(constraint.explicitConstraintName.name),
        columns: constraint.columnReferences.map(originalIdentifier),
        composite: constraint.columnReferences.length > 1,
        source: "constraint",
        span: source.span(constraint.clauseSpan),
      });
  }
  for (const i of evidence.indexes) {
    if (i.unique)
      unique.push({
        name: originalIdentifier(i.name),
        columns: i.columns.columnReferences.map(originalIdentifier),
        composite: i.columns.columnReferences.length > 1,
        source: "index",
        span: source.span(i.span),
      });
  }
  for (const c of evidence.associated.tableForeignKeyConstraints)
    addForeignKey(
      c.localColumns.columnReferences,
      c.referencedRelation,
      c.referencedColumns,
      c.explicitConstraintName?.name ?? null,
      c.clauseSpan,
    );
  for (const c of evidence.associated.tableCheckConstraints)
    checks.push({
      name:
        c.explicitConstraintName === null
          ? null
          : originalIdentifier(c.explicitConstraintName.name),
      expression: source.text(c.expressionSpan),
      expressionSemantics: "not_evaluated",
      span: source.span(c.clauseSpan),
    });
  return {
    columns: evidence.columns.map((c) => {
      const original = source.span(c.type.span);
      const spelling = evaluation.recognitionObservations.find(
        (o) =>
          o.kind === "type_spelling" && o.span.start.rawByteOffset === original.start.rawByteOffset,
      );
      const end = Math.max(original.end.rawByteOffset, spelling?.span.end.rawByteOffset ?? 0);
      return {
        name: originalIdentifier(c.name),
        type: new TextDecoder().decode(
          index.input.rawBytes.subarray(original.start.rawByteOffset, end),
        ),
        span: source.span(c.span),
      };
    }),
    unique,
    foreignKeys,
    checks,
    enums: evidence.columns.flatMap((c) => {
      const declaration = evidence.enums.get(ddlQualifiedIdentityKey(c.type.name));
      return declaration === undefined
        ? []
        : [
            {
              column: originalIdentifier(c.name),
              type: originalQualified(declaration.name),
              labels: declaration.labels,
              span: source.span(declaration.span),
            },
          ];
    }),
    triggers: evidence.triggers.map((t) => {
      const span = source.span(t.span);
      const statement = evaluation.includedStatements.find(
        (s) =>
          s.kind === "create_trigger" && s.span.start.rawByteOffset === span.start.rawByteOffset,
      );
      const updateOf: IdentifierIdentity[] = [];
      if (statement !== undefined) {
        const observation = evaluation.recognitionObservations.find(
          (o) =>
            o.kind === "trigger_syntax" &&
            o.form === "update_of_columns" &&
            o.span.start.rawByteOffset >= span.start.rawByteOffset &&
            o.span.end.rawByteOffset <= span.end.rawByteOffset,
        );
        if (observation !== undefined) {
          for (const token of statement.tokens) {
            if (
              token.span.start.rawByteOffset <= observation.span.start.rawByteOffset ||
              token.span.end.rawByteOffset > observation.span.end.rawByteOffset
            )
              continue;
            if (token.kind === "word")
              updateOf.push({ identity: token.folded, quoted: false, span: token.span });
            else if (token.kind === "quoted_identifier")
              updateOf.push({ identity: token.identity, quoted: true, span: token.span });
          }
        }
      }
      return {
        name: originalIdentifier(t.name),
        timing: t.timing,
        events: t.events,
        updateOf,
        level: t.forEach,
        whenPresent: t.whenSpan !== null,
        function: originalQualified(t.function),
        effects: "not_evaluated",
        span,
      };
    }),
    policies: evidence.policies.map((p) => ({
      name: originalIdentifier(p.name),
      command: p.command,
      mode: p.mode,
      roles: p.roles?.map(originalIdentifier) ?? null,
      usingPresent: p.usingSpan !== null,
      withCheckPresent: p.withCheckSpan !== null,
      span: source.span(p.span),
    })),
    rls: evidence.rls.map((r) => ({ axis: r.axis, value: r.value, span: source.span(r.span) })),
  };
}
