import type { IdentifierIdentity, QualifiedIdentity } from "./create-table-parser-primitives.js";
import type { DdlEvidence } from "./ddl-evidence.js";
import { PolicyFindings, orderedReasons, selectResult } from "./policy-findings.js";
import { evaluateEnum, evaluateType, identityConflicts, serialFamily } from "./policy-types.js";
import { PROFILE, type AnalyzedResult, type ReasonId } from "./public-profile.js";

export type ColumnDisposition =
  | "outside public type profile"
  | "type requires ImportFlow review"
  | "excluded from file mapping by the ordinary generation/default rule"
  | "file mapping candidate; final classification requires ImportFlow review";
export type EvaluatedColumn = {
  readonly name: IdentifierIdentity;
  readonly disposition: ColumnDisposition;
  readonly reasonIds: readonly ReasonId[];
};
export type PolicyEvaluation = {
  readonly target: QualifiedIdentity;
  readonly result: AnalyzedResult;
  readonly reasonIds: readonly ReasonId[];
  readonly columns: readonly EvaluatedColumn[];
};

/** Public P01–P13 operate only after full recognition and association succeed. */
export function evaluatePublicProfile(
  evidence: DdlEvidence,
  rawBytes: Uint8Array,
): PolicyEvaluation {
  const findings = new PolicyFindings(evidence.columns.length);
  evaluateTarget(evidence, findings);
  const enumReasons = new Map<string, readonly ReasonId[]>();
  for (const [key, declaration] of evidence.enums) {
    inspectQualifiedName(declaration.name, findings);
    enumReasons.set(key, evaluateEnum(declaration));
  }
  const columnOrdinals = new Map<string, number>();
  const columns: EvaluatedColumn[] = [];
  for (const [ordinal, column] of evidence.columns.entries()) {
    columnOrdinals.set(column.name.identity, ordinal);
    inspectIdentifier(column.name, findings, ordinal);
    const type = evaluateType(column.type, rawBytes, evidence.enums, enumReasons);
    for (const reason of type.reasons) findings.add(reason, ordinal);
    const serial = serialFamily(column.type) !== null;
    let generated = serial;
    for (const clause of column.clauseOccurrences) {
      if (clause.kind === "identity") {
        if (identityConflicts(type)) findings.add("identity_type_outside_profile", ordinal);
        generated = true;
      } else if (clause.kind === "generated_stored" || clause.kind === "default") {
        generated = true;
      } else if (clause.kind === "references") {
        findings.add("foreign_key_mapping_review_required", ordinal);
      } else if (clause.kind === "check") {
        findings.add("check_review_required");
      }
    }
    if (generated) findings.add("value_generation_review_required", ordinal);
    columns.push({
      name: column.name,
      disposition: columnDisposition(findings.forColumn(ordinal), generated),
      reasonIds: [],
    });
  }
  evaluateAssociatedDeclarations(evidence, columnOrdinals, findings);
  return {
    target: evidence.target.table,
    result: selectResult(findings.reasons),
    reasonIds: orderedReasons(findings.reasons),
    columns: columns.map((column, ordinal) => ({
      ...column,
      reasonIds: orderedReasons(findings.forColumn(ordinal)),
    })),
  };
}

/** P01/P02/P03/P04/P13: target declarations and the fully associated constraint set. */
function evaluateTarget(evidence: DdlEvidence, findings: PolicyFindings): void {
  const { target, associated } = evidence;
  if (target.table.qualifier === null) findings.add("target_schema_unresolved");
  else if (target.table.qualifier.identity !== "public")
    findings.add("target_schema_outside_profile");
  if (target.partitionByClause !== null) findings.add("partitioned_target");
  if (target.temporary || target.inheritsClause !== null) findings.add("relation_review_required");
  inspectQualifiedName(target.table, findings);
  for (const wrapper of associated.explicitConstraintNames)
    inspectIdentifier(wrapper.name, findings);
  let keyColumns = 0;
  let constraintCount =
    associated.tableKeyConstraints.length +
    associated.tableCheckConstraints.length +
    associated.tableForeignKeyConstraints.length;
  for (const key of associated.tableKeyConstraints) {
    if (key.kind === "primary_key") keyColumns = key.columnReferences.length;
  }
  for (const column of evidence.columns) {
    for (const clause of column.clauseOccurrences) {
      if (clause.kind === "primary_key") keyColumns = 1;
      if (
        clause.kind === "primary_key" ||
        clause.kind === "unique" ||
        clause.kind === "references" ||
        clause.kind === "check"
      )
        constraintCount += 1;
    }
  }
  if (keyColumns === 0) findings.add("primary_key_missing_from_input");
  else if (keyColumns > 1) findings.add("composite_primary_key");
  if (
    evidence.columns.length > PROFILE.limits.columns ||
    constraintCount > PROFILE.limits.target_constraints
  )
    findings.add("schema_size_outside_profile");
}

/** P08–P12: explicit associated declarations, without expression or live-state inference. */
function evaluateAssociatedDeclarations(
  evidence: DdlEvidence,
  ordinals: ReadonlyMap<string, number>,
  findings: PolicyFindings,
): void {
  for (const fk of evidence.associated.tableForeignKeyConstraints) {
    for (const reference of fk.localColumns.columnReferences) {
      const ordinal = ordinals.get(reference.identity);
      if (ordinal === undefined) throw new Error("Recognized FK association invariant violated.");
      findings.add("foreign_key_mapping_review_required", ordinal);
    }
  }
  if (evidence.associated.tableCheckConstraints.length > 0) findings.add("check_review_required");
  if (evidence.indexes.some((index) => index.unique)) findings.add("index_review_required");
  for (const trigger of evidence.triggers) {
    if (!trigger.events.includes("insert")) continue;
    findings.add(
      trigger.constraint || trigger.whenSpan !== null
        ? "insert_trigger_shape_outside_profile"
        : "insert_trigger_review_required",
    );
  }
  if (evidence.policies.length > 0 || evidence.rls.length > 0)
    findings.add("policy_review_required");
}

/** P04 has a per-component space-before-Unicode decision, not a whole-name shortcut. */
function inspectIdentifier(
  name: IdentifierIdentity,
  findings: PolicyFindings,
  ordinal?: number,
): void {
  if (name.identity.includes(" ")) findings.add("identifier_contains_space", ordinal);
  else if (/[^\x20-\x7e]/u.test(name.identity)) findings.add("identifier_review_required", ordinal);
}
function inspectQualifiedName(name: QualifiedIdentity, findings: PolicyFindings): void {
  if (name.qualifier !== null) inspectIdentifier(name.qualifier, findings);
  inspectIdentifier(name.local, findings);
}

function columnDisposition(reasons: ReadonlySet<ReasonId>, generated: boolean): ColumnDisposition {
  if (
    reasons.has("column_type_outside_profile") ||
    reasons.has("identity_type_outside_profile") ||
    reasons.has("enum_definition_outside_profile")
  )
    return "outside public type profile";
  if (reasons.has("type_review_required") || reasons.has("enum_review_required"))
    return "type requires ImportFlow review";
  if (generated) return "excluded from file mapping by the ordinary generation/default rule";
  return "file mapping candidate; final classification requires ImportFlow review";
}
