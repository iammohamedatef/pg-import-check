import type { IdentifierIdentity } from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { MigrationTargetEvidence } from "./migration-evaluator.js";
import { reasonOutcome } from "./migration-evaluator.js";
import { serialFamily } from "./policy-types.js";
import type { ReasonId } from "./public-profile.js";

export type ValueAuthority =
  | "file_supplied"
  | "database_default_available"
  | "database_identity"
  | "database_generated_expression"
  | "database_sequence_default"
  | "unknown_or_review";
export type ImportColumnState =
  | "required_source_value"
  | "optional_source_value"
  | "database_default_available"
  | "database_identity"
  | "database_generated"
  | "blocked_by_profile"
  | "unresolved"
  | "provisional";
export type ImportContractColumn = {
  readonly name: IdentifierIdentity;
  readonly authority: ValueAuthority;
  readonly identityMode: "always" | "by_default" | null;
  readonly state: ImportColumnState;
  readonly nullable: boolean;
  readonly foreignKeySource: boolean;
  readonly reasonIds: readonly ReasonId[];
  readonly span: SourceSpan;
};
export type ImportContract = {
  readonly status: "established_static_shape" | "provisional" | "unresolved";
  readonly profileConflict: boolean;
  readonly columns: readonly ImportContractColumn[];
};

/** Derive omission and authority independently of the frozen v0.1 profile disposition. */
export function deriveImportContract(evaluation: MigrationTargetEvidence): ImportContract {
  const evidence = evaluation.evidence;
  const profileConflict = evaluation.result === "outside_envelope_observed";
  if (evidence === null) return { status: "unresolved", profileConflict, columns: [] };
  // Unevaluated target statements may affect nullability, existence, constraints or generation.
  const provisional =
    evaluation.notEvaluated.length > 0 ||
    (evaluation.coverage?.counts.RELEVANT_NOT_EVALUATED ?? 0) > 0 ||
    (evaluation.coverage?.counts.UNRESOLVED_TARGET_ASSOCIATION ?? 0) > 0;
  const pk = new Set(evaluation.observed?.primaryKeyColumns.map((c) => c.identity));
  const fk = new Set(
    evidence.associated.tableForeignKeyConstraints.flatMap((f) =>
      f.localColumns.columnReferences.map((c) => c.identity),
    ),
  );
  const policies = new Map(evaluation.policy?.columns.map((c) => [c.name.identity, c]));
  const generationByColumn = new Map<string, (typeof evaluation.generatedColumns)[number][]>();
  for (const generation of evaluation.generatedColumns) {
    const entries = generationByColumn.get(generation.column.identity) ?? [];
    entries.push(generation);
    generationByColumn.set(generation.column.identity, entries);
  }
  const columns = evidence.columns.map((column): ImportContractColumn => {
    const clauses = column.clauseOccurrences;
    const identity = clauses.find((c) => c.kind === "identity");
    const later = generationByColumn.get(column.name.identity) ?? [];
    let authority: ValueAuthority = clauses.some((c) => c.kind === "generated_stored")
      ? "database_generated_expression"
      : identity !== undefined
        ? "database_identity"
        : serialFamily(column.type) !== null
          ? "database_sequence_default"
          : clauses.some((c) => c.kind === "default")
            ? "database_default_available"
            : "file_supplied";
    if (later.length === 1) {
      const source = later[0]?.source;
      // Multiple or competing generation declarations are evidence, not ordered projection.
      authority =
        authority !== "file_supplied"
          ? "unknown_or_review"
          : source === "identity"
            ? "database_identity"
            : "database_default_available";
    } else if (later.length > 1) authority = "unknown_or_review";
    const nullable =
      !pk.has(column.name.identity) &&
      !clauses.some((c) => c.kind === "not_null") &&
      identity === undefined &&
      serialFamily(column.type) === null &&
      authority !== "database_identity";
    const reasons = policies.get(column.name.identity)?.reasonIds ?? [];
    const blocked = reasons.some((r) => reasonOutcome(r) === "outside_envelope_observed");
    const unresolved =
      authority === "unknown_or_review" ||
      policies.get(column.name.identity)?.disposition === "type requires ImportFlow review" ||
      policies.get(column.name.identity)?.disposition === "unresolved" ||
      reasons.includes("identifier_review_required");
    const state: ImportColumnState = blocked
      ? "blocked_by_profile"
      : provisional
        ? "provisional"
        : unresolved
          ? "unresolved"
          : authority === "database_identity"
            ? "database_identity"
            : authority === "database_generated_expression"
              ? "database_generated"
              : authority === "database_default_available" ||
                  authority === "database_sequence_default"
                ? "database_default_available"
                : nullable
                  ? "optional_source_value"
                  : "required_source_value";
    return {
      name: column.name,
      authority,
      state,
      nullable,
      identityMode:
        identity?.kind === "identity" ? identity.mode.kind : (later[0]?.identityMode ?? null),
      foreignKeySource:
        fk.has(column.name.identity) || clauses.some((c) => c.kind === "references"),
      reasonIds: reasons,
      span: column.span,
    };
  });
  return {
    status: provisional ? "provisional" : "established_static_shape",
    profileConflict,
    columns,
  };
}
