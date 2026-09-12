import {
  deriveMigrationDecision,
  renderMigrationDecisionReport,
  type MigrationDecisionReport,
} from "./migration-decision.js";
import {
  displayDiagnosticPreview,
  displayIdentifier,
  displayQualifiedIdentity,
} from "./report-safe-display.js";
import { REASON_MESSAGES, type ReasonId } from "./public-profile.js";
import { reasonOutcome, type MigrationTargetEvaluation } from "./migration-evaluator.js";

export function migrationTechnicalSections(
  evaluation: MigrationTargetEvaluation,
  decision: MigrationDecisionReport = deriveMigrationDecision(evaluation),
): readonly { readonly heading: string; readonly body: string }[] {
  const section = (
    heading: string,
    append: (lines: string[], e: MigrationTargetEvaluation) => void,
  ) => {
    const lines: string[] = [];
    append(lines, evaluation);
    return { heading, body: lines.join("\n") };
  };
  return [
    {
      heading: "TARGET",
      body: `${displayQualifiedIdentity(evaluation.target.identity)}\nsource: line ${evaluation.target.firstSeenSpan.start.line}, column ${evaluation.target.firstSeenSpan.start.column}`,
    },
    { heading: "RESULT", body: evaluation.result },
    section("OBSERVED", appendObserved),
    section("FILE-MAPPABLE / FILE AUTHORITY", appendFileAuthority),
    section("DATABASE / SYSTEM CONTROLLED", appendDatabaseControlled),
    section("STRUCTURAL CONFLICTS", (lines, e) =>
      appendReasons(lines, e, "outside_envelope_observed"),
    ),
    section("NOT EVALUATED", appendNotEvaluated),
    section("REQUIRES IMPORTFLOW REVIEW", (lines, e) => {
      appendReasons(lines, e, "more_evidence_required");
      appendExternalReview(lines);
    }),
    {
      heading: "STRUCTURAL DETAILS",
      body:
        deriveMigrationDecision(evaluation)
          .databaseBehavior.map((f) => `- ${f.basis}: ${f.text}`)
          .join("\n") || "- none established",
    },
    {
      heading: "COLUMN EVIDENCE",
      body:
        (evaluation.structure?.columns ?? [])
          .map((c) => {
            const contract = evaluation.contract?.columns.find(
              (entry) => entry.name.identity === c.name.identity,
            );
            return `- ${displayIdentifier(c.name)}: ${displayDiagnosticPreview(c.type)}; ${contract?.state}; authority ${contract?.authority}; nullable ${contract?.nullable}; identity mode ${contract?.identityMode ?? "not established"}; rules ${contract?.reasonIds.join(", ") || "none"}; line ${c.span.start.line}`;
          })
          .join("\n") || "- none established",
    },
    {
      heading: "STATEMENT ACCOUNTING",
      body: (evaluation.coverage?.statements ?? [])
        .map((s) => `- #${s.ordinal + 1} ${s.label}: ${s.state}; line ${s.span.start.line}`)
        .join("\n"),
    },
    { heading: "BOTTOM LINE", body: decision.bottomLine.join(" ") },
  ];
}

export function renderMigrationTargetReport(
  evaluation: MigrationTargetEvaluation,
  decision: MigrationDecisionReport = deriveMigrationDecision(evaluation),
  technical = migrationTechnicalSections(evaluation, decision),
): string {
  return `PG IMPORT CHECK — MIGRATION v0.3\nprofile: importflow-envelope-v4 | supplied DDL only | local deterministic analysis\n\nDECISION REPORT\n${renderMigrationDecisionReport(decision)}\nTECHNICAL EVIDENCE\n${technical.map((s) => `${s.heading}\n${s.body}`).join("\n\n")}\n\n`;
}

function appendObserved(lines: string[], evaluation: MigrationTargetEvaluation): void {
  const observed = evaluation.observed;
  if (evaluation.result === "more_evidence_required")
    lines.push(
      "- No evaluated conflict takes precedence; unresolved supplied evidence requires review.",
    );
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
    evaluation.contract?.columns.filter(
      (c) =>
        c.authority === "file_supplied" ||
        c.authority === "database_default_available" ||
        c.authority === "database_sequence_default",
    ) ?? [];
  if (evaluation.contract?.status === "provisional")
    lines.push(
      "- provisional from evaluated declarations; NOT EVALUATED statements may change final file authority",
    );
  if (evaluation.contract?.profileConflict)
    lines.push(
      "- target is outside the current profile; all proposed mapping requires conflict review",
    );
  for (const column of columns)
    lines.push(
      `- ${displayIdentifier(column.name)} — ${column.state}${column.authority === "database_default_available" ? "; explicit source value permitted by ordinary DEFAULT semantics" : ""}`,
    );
  if (columns.length === 0) lines.push("- none established from the evaluated DDL");
}

function appendDatabaseControlled(lines: string[], evaluation: MigrationTargetEvaluation): void {
  const columns =
    evaluation.contract?.columns.filter(
      (c) => c.authority === "database_identity" || c.authority === "database_generated_expression",
    ) ?? [];
  for (const column of columns)
    lines.push(`- ${displayIdentifier(column.name)} — ${column.authority}; ${column.state}`);
  if (columns.length === 0) lines.push("- none established from the evaluated DDL");
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
  const ledger =
    evaluation.coverage?.statements.filter(
      (s) =>
        s.state === "UNSUPPORTED_DOCUMENT_STATEMENT" ||
        s.state === "RELEVANT_NOT_EVALUATED" ||
        s.state === "UNRESOLVED_TARGET_ASSOCIATION",
    ) ?? [];
  for (const statement of ledger)
    lines.push(
      `- ${statement.label} — ${statement.state === "UNSUPPORTED_DOCUMENT_STATEMENT" ? "unsupported document statement; not evaluated" : statement.state === "UNRESOLVED_TARGET_ASSOCIATION" ? "target association unresolved; relevance and effects not established" : "relevant statement not evaluated"} (line ${statement.span.start.line})`,
    );
  if (evaluation.notEvaluated.length === 0 && evaluation.refusal === null && ledger.length === 0) {
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

export function isConflictReason(reasonId: ReasonId): boolean {
  return reasonOutcome(reasonId) === "outside_envelope_observed";
}
