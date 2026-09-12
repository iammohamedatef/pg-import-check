import { ddlQualifiedIdentityKey } from "./ddl-evidence.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { MigrationDocumentIndex } from "./migration-document.js";
import type { MigrationTargetEvidence } from "./migration-evaluator.js";

export type StatementAccountingState =
  | "EVALUATED_FOR_TARGET"
  | "RELEVANT_NOT_EVALUATED"
  | "IRRELEVANT_TO_TARGET"
  | "UNRESOLVED_TARGET_ASSOCIATION"
  | "UNSUPPORTED_DOCUMENT_STATEMENT"
  | "PARSE_REFUSED";

export type StatementAccounting = {
  readonly ordinal: number;
  readonly label: string;
  readonly state: StatementAccountingState;
  readonly span: SourceSpan;
};

export type MigrationCoverage = {
  readonly state: "COMPLETE STATIC COVERAGE" | "PARTIAL STATIC COVERAGE" | "REFUSED";
  readonly discovered: number;
  readonly relevant: number;
  readonly counts: Readonly<Record<StatementAccountingState, number>>;
  readonly statements: readonly StatementAccounting[];
};

/** One exhaustive classification per indexed statement; DML contents are never interpreted. */
export function deriveMigrationCoverage(
  index: MigrationDocumentIndex,
  evaluation: MigrationTargetEvidence,
  supportingStatementOrdinals: readonly number[] = [],
): MigrationCoverage {
  const included = new Set([
    ...evaluation.includedStatements.map((s) => s.ordinal),
    ...supportingStatementOrdinals,
  ]);
  const generated = new Set(evaluation.generatedColumns.map((g) => g.span.start.rawByteOffset));
  const failed = new Set(evaluation.notEvaluated.map((n) => n.span.start.rawByteOffset));
  const referencedTypes = new Set(
    evaluation.evidence?.columns.map((c) => ddlQualifiedIdentityKey(c.type.name)) ?? [],
  );
  const referencedTypeNames = new Set(
    evaluation.evidence?.columns.map((c) => c.type.name.local.identity) ?? [],
  );
  const unqualifiedTypeNames = new Set(
    evaluation.evidence?.columns
      .filter((c) => c.type.name.qualifier === null)
      .map((c) => c.type.name.local.identity) ?? [],
  );
  const counts: Record<StatementAccountingState, number> = {
    EVALUATED_FOR_TARGET: 0,
    RELEVANT_NOT_EVALUATED: 0,
    IRRELEVANT_TO_TARGET: 0,
    UNRESOLVED_TARGET_ASSOCIATION: 0,
    UNSUPPORTED_DOCUMENT_STATEMENT: 0,
    PARSE_REFUSED: 0,
  };
  const statements = index.statements.map((statement): StatementAccounting => {
    const exactTarget =
      statement.target !== null &&
      ddlQualifiedIdentityKey(statement.target) === evaluation.target.key;
    const referencedType =
      statement.kind === "create_type" &&
      statement.objectIdentity !== null &&
      referencedTypes.has(ddlQualifiedIdentityKey(statement.objectIdentity));
    // A missing schema does not establish that same-named objects differ.
    // Missing targets on recognized target-bearing statements prove neither
    // relevance nor irrelevance. Keep that uncertainty separate from both.
    const unresolvedAssociation =
      statement.target !== null
        ? statement.target.local.identity === evaluation.target.identity.local.identity &&
          (statement.target.qualifier === null || evaluation.target.identity.qualifier === null)
        : statement.kind === "create_type"
          ? statement.objectIdentity !== null &&
            (statement.objectIdentity.qualifier === null
              ? referencedTypeNames.has(statement.objectIdentity.local.identity)
              : unqualifiedTypeNames.has(statement.objectIdentity.local.identity))
          : statement.kind !== "other" && statement.kind !== "empty";
    let state: StatementAccountingState;
    if (included.has(statement.ordinal)) {
      state = evaluation.refusal === null ? "EVALUATED_FOR_TARGET" : "PARSE_REFUSED";
    } else if (
      generated.has(statement.span.start.rawByteOffset) &&
      !failed.has(statement.span.start.rawByteOffset)
    ) {
      state = evaluation.evidence === null ? "RELEVANT_NOT_EVALUATED" : "EVALUATED_FOR_TARGET";
    } else if (exactTarget || referencedType || failed.has(statement.span.start.rawByteOffset)) {
      state = "RELEVANT_NOT_EVALUATED";
    } else if (statement.kind === "other") {
      state = "UNSUPPORTED_DOCUMENT_STATEMENT";
    } else if (unresolvedAssociation) {
      state = "UNRESOLVED_TARGET_ASSOCIATION";
    } else {
      state = "IRRELEVANT_TO_TARGET";
    }
    counts[state] += 1;
    const first = statement.tokens[0];
    const label =
      statement.kind === "other"
        ? first?.kind === "word"
          ? first.folded.toUpperCase()
          : "SQL statement"
        : statement.kind.replaceAll("_", " ").toUpperCase();
    return { ordinal: statement.ordinal, label, state, span: statement.span };
  });
  if (Object.values(counts).reduce((a, b) => a + b, 0) !== index.statements.length) {
    throw new Error("Document statement accounting invariant");
  }
  return {
    state:
      evaluation.refusal !== null
        ? "REFUSED"
        : evaluation.evidence === null ||
            evaluation.notEvaluated.length > 0 ||
            counts.RELEVANT_NOT_EVALUATED > 0 ||
            counts.UNRESOLVED_TARGET_ASSOCIATION > 0 ||
            counts.UNSUPPORTED_DOCUMENT_STATEMENT > 0
          ? "PARTIAL STATIC COVERAGE"
          : "COMPLETE STATIC COVERAGE",
    discovered: statements.length,
    relevant: counts.EVALUATED_FOR_TARGET + counts.RELEVANT_NOT_EVALUATED + counts.PARSE_REFUSED,
    counts,
    statements,
  };
}
