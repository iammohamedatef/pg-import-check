import { displayIdentifier, displayQualifiedIdentity } from "./report-safe-display.js";
import { REASON_MESSAGES, type ReasonId } from "./public-profile.js";
import { reasonOutcome, type MigrationTargetEvaluation } from "./migration-evaluator.js";

export function renderMigrationTargetReport(evaluation: MigrationTargetEvaluation): string {
  const lines: string[] = [
    "PG IMPORT CHECK — MIGRATION v0.2",
    "profile: importflow-envelope-v4 | supplied DDL only | local deterministic analysis",
    "",
    "TARGET",
    displayQualifiedIdentity(evaluation.target.identity),
    `source: line ${evaluation.target.firstSeenSpan.start.line}, column ${evaluation.target.firstSeenSpan.start.column}`,
    "",
    "RESULT",
    evaluation.result,
    "",
    "OBSERVED",
  ];

  appendObserved(lines, evaluation);
  lines.push("", "FILE-MAPPABLE / FILE AUTHORITY");
  appendFileAuthority(lines, evaluation);
  lines.push("", "DATABASE / SYSTEM CONTROLLED");
  appendDatabaseControlled(lines, evaluation);
  lines.push("", "STRUCTURAL CONFLICTS");
  appendReasons(lines, evaluation, "outside_envelope_observed");
  lines.push("", "NOT EVALUATED");
  appendNotEvaluated(lines, evaluation);
  lines.push("", "REQUIRES IMPORTFLOW REVIEW");
  appendReasons(lines, evaluation, "more_evidence_required");
  appendExternalReview(lines);
  lines.push("", "BOTTOM LINE", bottomLine(evaluation), "");
  return `${lines.join("\n")}\n`;
}

function appendObserved(lines: string[], evaluation: MigrationTargetEvaluation): void {
  const observed = evaluation.observed;
  if (observed === null) {
    lines.push(
      "- A target identity was discovered, but a complete evaluated table shape is unavailable.",
    );
  } else {
    if (evaluation.notEvaluated.length > 0) {
      lines.push(
        "- partial evaluated evidence: NOT EVALUATED statements may change the final target shape or state",
      );
    }
    lines.push(`- columns in evaluated base declaration: ${observed.columnCount}`);
    lines.push(
      observed.primaryKeyColumns.length === 0
        ? "- primary key: not declared in evaluated evidence"
        : `- primary key: (${observed.primaryKeyColumns.map(displayIdentifier).join(", ")})`,
    );
    lines.push(`- unique constraints: ${observed.uniqueConstraintCount}`);
    lines.push(`- foreign keys: ${observed.foreignKeyCount}`);
    if (observed.enumBackedColumnCount > 0)
      lines.push(`- enum-backed columns: ${observed.enumBackedColumnCount}`);
    if (observed.generatedColumnCount > 0)
      lines.push(`- generated/default-controlled columns: ${observed.generatedColumnCount}`);
    if (observed.associatedAlterConstraintCount > 0)
      lines.push(`- associated ALTER constraints: ${observed.associatedAlterConstraintCount}`);
    if (observed.uniqueIndexCount > 0)
      lines.push(`- associated unique indexes: ${observed.uniqueIndexCount}`);
    if (observed.triggerCount > 0)
      lines.push(`- trigger declarations in evaluated evidence: ${observed.triggerCount}`);
    if (observed.policyCount > 0)
      lines.push(`- policy declarations in evaluated evidence: ${observed.policyCount}`);
    if (observed.rlsStatementCount > 0)
      lines.push(`- associated RLS state statements: ${observed.rlsStatementCount}`);
  }

  const seenRecognition = new Set<string>();
  for (const observation of evaluation.recognitionObservations) {
    const key = `${observation.kind}:${observation.span.start.rawByteOffset}`;
    if (seenRecognition.has(key)) continue;
    seenRecognition.add(key);
    if (observation.kind === "type_spelling") {
      lines.push(
        `- type spelling recognized: ${observation.original} → ${observation.projectedAs} (line ${observation.span.start.line})`,
      );
    } else if (observation.kind === "foreign_key_action") {
      lines.push(
        `- foreign-key action recognized: ${observation.action} (line ${observation.span.start.line})`,
      );
    } else if (observation.kind === "relation_storage") {
      lines.push(
        `- relation storage clause observed and excluded from structural policy: ${observation.storage} (line ${observation.span.start.line})`,
      );
    } else {
      lines.push(
        `- trigger syntax recognized for bounded structural analysis: ${observation.form} (line ${observation.span.start.line})`,
      );
    }
  }
}

function appendFileAuthority(lines: string[], evaluation: MigrationTargetEvaluation): void {
  const columns =
    evaluation.policy?.columns.filter(
      (column) =>
        column.disposition ===
        "file mapping candidate; final classification requires ImportFlow review",
    ) ?? [];
  if (columns.length === 0) {
    lines.push("- none established from the evaluated DDL");
    return;
  }
  if (evaluation.notEvaluated.length > 0) {
    lines.push(
      "- provisional from evaluated declarations; NOT EVALUATED statements may change final file authority",
    );
  }
  for (const column of columns)
    lines.push(`- ${displayIdentifier(column.name)} — file mapping candidate`);
}

function appendDatabaseControlled(lines: string[], evaluation: MigrationTargetEvaluation): void {
  const columns =
    evaluation.policy?.columns.filter(
      (column) =>
        column.disposition === "excluded from file mapping by the ordinary generation/default rule",
    ) ?? [];
  if (columns.length === 0) {
    lines.push("- none established from the evaluated DDL");
    return;
  }
  if (evaluation.notEvaluated.length > 0) {
    lines.push(
      "- provisional from evaluated declarations; NOT EVALUATED statements may change final database control",
    );
  }
  for (const column of columns) {
    lines.push(
      `- ${displayIdentifier(column.name)} — generation/default evidence excludes ordinary file authority`,
    );
  }
}

function appendReasons(
  lines: string[],
  evaluation: MigrationTargetEvaluation,
  outcome: "outside_envelope_observed" | "more_evidence_required",
): void {
  const reasons =
    evaluation.policy?.reasonIds.filter((reason) => reasonOutcome(reason) === outcome) ?? [];
  if (reasons.length === 0) {
    lines.push(
      outcome === "outside_envelope_observed"
        ? "- none established"
        : "- no additional profile predicate",
    );
    return;
  }
  for (const reason of reasons) {
    lines.push(`- ${reason} — ${REASON_MESSAGES[reason]}`);
    appendConflictProvenance(lines, evaluation, reason);
  }
}

function appendConflictProvenance(
  lines: string[],
  evaluation: MigrationTargetEvaluation,
  reason: ReasonId,
): void {
  if (reason !== "composite_primary_key") return;
  for (const source of evaluation.alterConstraintSources) {
    if (source.constraintKind !== "primary_key" || (source.columnCount ?? 0) <= 1) continue;
    lines.push(
      `- source: ALTER TABLE ${source.constraintName === null ? "unnamed primary-key constraint" : `constraint ${displayIdentifier(source.constraintName)}`} at line ${source.span.start.line}, column ${source.span.start.column}`,
    );
  }
}

function appendNotEvaluated(lines: string[], evaluation: MigrationTargetEvaluation): void {
  if (evaluation.refusal !== null) {
    lines.push(`- selected target recognition refused: ${evaluation.refusal.refusalId}`);
  }
  if (evaluation.notEvaluated.length === 0 && evaluation.refusal === null) {
    lines.push("- none");
    return;
  }
  for (const item of evaluation.notEvaluated) {
    const constraint =
      item.constraintName === undefined
        ? ""
        : `, constraint ${displayIdentifier(item.constraintName)}`;
    lines.push(
      `- ${item.detail} [${item.kind}] (${item.statementKind}${constraint}, line ${item.span.start.line}, column ${item.span.start.column})`,
    );
  }
}

function appendExternalReview(lines: string[]): void {
  lines.push(
    "- effective permissions and RLS authorization are not established from supplied DDL alone",
    "- live target state and omitted database objects were not queried",
    "- runtime trigger/function/rewrite effects are not executed or inferred",
    "- final mapping, trusted system values, workload, and data validation require review",
    "- this report is not production approval or a migration guarantee",
  );
}

function bottomLine(evaluation: MigrationTargetEvaluation): string {
  switch (evaluation.result) {
    case "outside_envelope_observed":
      return "Supplied deterministic evidence establishes a conflict with the current ImportFlow Alpha target-schema profile; unresolved items may still require review.";
    case "more_evidence_required":
      return "No evaluated conflict takes precedence, but supplied DDL leaves profile or NOT_EVALUATED facts that require ImportFlow review.";
    case "no_structural_conflict_observed":
      return "No structural conflict was observed in the evaluated target evidence; live/runtime review is still required.";
    case "refused":
      return "The selected target could not be safely evaluated from this document; this is not a finding of ImportFlow incompatibility.";
  }
}

export function isConflictReason(reasonId: ReasonId): boolean {
  return reasonOutcome(reasonId) === "outside_envelope_observed";
}
