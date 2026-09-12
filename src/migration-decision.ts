import { ddlQualifiedIdentityKey } from "./ddl-evidence.js";
import type { MigrationTargetEvaluation } from "./migration-evaluator.js";
import { reasonOutcome } from "./migration-evaluator.js";
import {
  displayDiagnosticPreview,
  displayIdentifier as id,
  displayQualifiedIdentity as qualified,
} from "./report-safe-display.js";
import { REASON_MESSAGES } from "./public-profile.js";

export type DecisionFact = {
  readonly basis: "Observed" | "Derived" | "Not evaluated" | "Recommendation";
  readonly text: string;
};
export type DecisionSection = { readonly heading: string; readonly facts: readonly DecisionFact[] };
export type MigrationDecisionReport = {
  readonly decision:
    | "REVIEW REQUIRED"
    | "OUTSIDE CURRENT PROFILE"
    | "STATIC ANALYSIS INCOMPLETE"
    | "READY FOR FURTHER MAPPING REVIEW";
  readonly target: string;
  readonly coverage: string;
  readonly sections: readonly DecisionSection[];
  readonly bottomLine: readonly string[];
  readonly databaseBehavior: readonly DecisionFact[];
};

const stateLabels = {
  required_source_value: "Required from source",
  optional_source_value: "Optional source values",
  database_default_available: "Database default available",
  database_identity: "Database identity",
  database_generated: "Database computed",
  blocked_by_profile: "Blocked by profile",
  unresolved: "Unresolved",
  provisional: "Provisional",
} as const;

const MAX_DECISION_FACT_SCALARS = 384;

function compactFact(fact: DecisionFact): DecisionFact {
  const scalars = Array.from(fact.text);
  return scalars.length <= MAX_DECISION_FACT_SCALARS
    ? fact
    : {
        ...fact,
        text: `${scalars.slice(0, MAX_DECISION_FACT_SCALARS).join("")}… (continued in Technical Evidence)`,
      };
}

function summarizeNames(names: readonly string[]): string {
  return `${names.slice(0, 8).join(", ")}${names.length > 8 ? `; ${names.length - 8} more in Technical Evidence` : ""}`;
}

export function deriveMigrationDecision(
  evaluation: MigrationTargetEvaluation,
): MigrationDecisionReport {
  const { contract, structure, coverage } = evaluation;
  if (contract === undefined || structure === undefined || coverage === undefined)
    throw new Error("Decision evidence invariant");
  const facts: DecisionFact[] = [];
  const next: DecisionFact[] = [];
  const add = (basis: DecisionFact["basis"], text: string) => facts.push({ basis, text });
  const recommend = (text: string) => next.push({ basis: "Recommendation", text });
  const blocked = contract.columns.filter((c) => c.state === "blocked_by_profile");
  if (blocked.length > 0) {
    add(
      "Observed",
      `Current ImportFlow Alpha profile conflicts: ${blocked
        .map((c) => {
          const type =
            structure.columns.find((s) => s.name.identity === c.name.identity)?.type ??
            "type unavailable";
          return `${id(c.name)} (${displayDiagnosticPreview(type)})`;
        })
        .join(
          ", ",
        )}. Recognized PostgreSQL declarations can fall outside this profile; this is not a syntax-invalidity finding.`,
    );
    recommend(
      "Review blocked fields against the current profile. Excluding a field from a proposed mapping may be possible only where omission is acceptable; future profile support may be needed.",
    );
  }
  const conflicts =
    evaluation.policy?.reasonIds.filter((r) => reasonOutcome(r) === "outside_envelope_observed") ??
    [];
  for (const r of conflicts) {
    if (r === "column_type_outside_profile" && blocked.length > 0) continue;
    add("Observed", REASON_MESSAGES[r]);
  }
  if (contract.status === "provisional") {
    add(
      "Derived",
      coverage.counts.UNRESOLVED_TARGET_ASSOCIATION > 0
        ? "Final mapping is provisional because some supplied statements may affect this target but could not be safely associated."
        : "Final mapping is provisional because target statements remain NOT_EVALUATED.",
    );
    recommend(
      "Resolve the reported statement uncertainty and establish the final target shape before mapping.",
    );
  } else if (contract.status === "unresolved") {
    add("Not evaluated", "A complete target shape could not be established.");
    recommend(
      "Provide one supported, exact target declaration and resolve the reported recognition or association issue.",
    );
  }
  if (coverage.state !== "COMPLETE STATIC COVERAGE") {
    add(
      "Not evaluated",
      `${coverage.counts.UNSUPPORTED_DOCUMENT_STATEMENT} unsupported document statement(s); ${coverage.counts.RELEVANT_NOT_EVALUATED} target-relevant statement(s) not evaluated.${coverage.counts.UNRESOLVED_TARGET_ASSOCIATION > 0 ? ` ${coverage.counts.UNRESOLVED_TARGET_ASSOCIATION} supplied statement(s) could not be safely associated with a target.` : ""} Complete static conclusions are unavailable.`,
    );
    recommend(
      "Review coverage entries against the supplied migration; unsupported statement contents and effects were not evaluated.",
    );
  }
  const insertTriggers = structure.triggers.filter((t) => t.events.includes("insert"));
  if (insertTriggers.length > 0) {
    add(
      "Observed",
      `INSERT triggers require behavior review: ${insertTriggers.map((t) => id(t.name)).join(", ")}. Function bodies and effects were not evaluated.`,
    );
    recommend(
      "Review the declared INSERT trigger functions and their effects before defining the import mapping.",
    );
  }
  const resolution = structure.foreignKeys.filter((f) => f.identityResolutionMayBeRequired);
  for (const f of resolution) {
    add(
      "Derived",
      `${f.columns.map(id).join(", ")} → ${qualified(f.referencedTable)} (${f.referencedColumns?.map(id).join(", ")}): identity resolution may be required; the visible referenced key is database-generated.`,
    );
  }
  if (resolution.length > 0)
    recommend(
      "A source-file identifier may need to be resolved to the referenced database identifier before this foreign key can be populated. No source identifier or lookup key was selected.",
    );
  if (structure.foreignKeys.length > 0 && resolution.length === 0) {
    add(
      "Observed",
      `Relationship fields require mapping review: ${structure.foreignKeys.map((f) => f.columns.map(id).join(", ")).join("; ")}.`,
    );
    recommend(
      "Review foreign-key source values against the named referenced keys; existing rows and lookup behavior were not checked.",
    );
  }
  if (structure.policies.length > 0 || structure.rls.length > 0) {
    add(
      "Observed",
      "RLS/policy declarations are present; effective INSERT authorization is not established.",
    );
    recommend(
      "Review effective role permissions and RLS authorization for the intended import context.",
    );
  }
  if (structure.checks.length > 0) {
    add(
      "Observed",
      `CHECK evidence: ${structure.checks.map((c) => (c.name === null ? `unnamed at line ${c.span.start.line}` : id(c.name))).join(", ")}. Expression semantics not evaluated.`,
    );
    recommend(
      "Review the displayed CHECK expressions against intended source values; expressions were not executed.",
    );
  }
  if (evaluation.policy?.reasonIds.includes("primary_key_missing_from_input")) {
    add("Observed", "No primary key is declared in the evaluated evidence.");
    recommend("Establish the target key evidence required by the current ImportFlow profile.");
  }
  if (structure.unique.length > 0)
    recommend(
      "Review the named UNIQUE participants; existing-row duplicates and source-file duplicates were not checked.",
    );
  const unresolved = contract.columns.filter((c) => c.state === "unresolved");
  if (unresolved.length > 0) {
    add(
      "Derived",
      `Column classification remains unresolved: ${unresolved
        .map((c) => {
          const type =
            structure.columns.find((s) => s.name.identity === c.name.identity)?.type ??
            "type unavailable";
          return `${id(c.name)} (${displayDiagnosticPreview(type)})`;
        })
        .join(", ")}. Type definitions or identifier/profile review may be needed.`,
    );
    recommend(
      "Review the named unresolved column types and identifiers; unavailable type definitions and enum labels were not inferred.",
    );
  }
  const generated = contract.columns.filter(
    (c) => c.authority === "database_identity" || c.authority === "database_generated_expression",
  );
  if (generated.length > 0) {
    add(
      "Derived",
      `Database generation requires value-authority review: ${generated.map((c) => `${id(c.name)} (${c.authority === "database_identity" ? `identity ${c.identityMode ?? "mode not established"}` : "computed expression"})`).join(", ")}. These are not ordinary required source inputs.`,
    );
    recommend(
      "Review identity mode and database-computed fields when defining source authority; expression effects were not evaluated.",
    );
  }
  const defaults = contract.columns.filter(
    (c) =>
      c.authority === "database_default_available" || c.authority === "database_sequence_default",
  );
  if (defaults.length > 0)
    add(
      "Derived",
      `Database defaults are available for ${defaults.map((c) => id(c.name)).join(", ")}; explicit source values are not prohibited by ordinary DEFAULT semantics. Default expression behavior remains unevaluated.`,
    );
  if (structure.unique.length > 0)
    add(
      "Observed",
      `Declared uniqueness participants: ${structure.unique.map((u) => `(${u.columns.map(id).join(", ")})`).join("; ")}. Existing-row and source-file duplicates were not checked.`,
    );
  if (facts.length === 0)
    add(
      "Derived",
      "The supplied static shape supports further mapping review; live state and source data remain unverified.",
    );
  if (next.length === 0)
    recommend(
      "Review final mapping, live permissions, runtime behavior and source data with ImportFlow before importing.",
    );
  const decision =
    coverage.state !== "COMPLETE STATIC COVERAGE"
      ? "STATIC ANALYSIS INCOMPLETE"
      : evaluation.result === "outside_envelope_observed"
        ? "OUTSIDE CURRENT PROFILE"
        : evaluation.result === "more_evidence_required"
          ? "REVIEW REQUIRED"
          : "READY FOR FURTHER MAPPING REVIEW";
  const groups: DecisionFact[] = Object.entries(stateLabels).flatMap(([state, label]) => {
    const names = contract.columns.filter((c) => c.state === state).map((c) => id(c.name));
    return names.length === 0
      ? []
      : [{ basis: "Derived" as const, text: `${label}: ${summarizeNames(names)}` }];
  });
  const relationships = contract.columns.filter((c) => c.foreignKeySource).map((c) => id(c.name));
  if (relationships.length > 0)
    groups.push({
      basis: "Observed",
      text: `Relationship fields: ${summarizeNames(relationships)}`,
    });
  if (contract.profileConflict)
    groups.push({
      basis: "Derived",
      text: "Target profile conflicts qualify all proposed mapping; these groups describe supplied structural evidence only.",
    });
  if (contract.columns.some((c) => c.authority === "database_default_available"))
    groups.push({
      basis: "Derived",
      text: "Ordinary DEFAULT can supply a value when omitted; explicit source values are not prohibited merely by a DEFAULT. Default expressions were not evaluated.",
    });
  const counts = coverage.counts;
  const behavior: DecisionFact[] = [];
  const observed = (text: string) => behavior.push({ basis: "Observed", text });
  for (const u of structure.unique)
    observed(
      `UNIQUE ${u.name === null ? "(unnamed)" : id(u.name)}: (${u.columns.map(id).join(", ")})${u.composite ? " composite" : ""}; ${u.source}, line ${u.span.start.line}.`,
    );
  for (const f of structure.foreignKeys)
    observed(
      `FK ${f.name === null ? "(unnamed)" : id(f.name)}: (${f.columns.map(id).join(", ")}) → ${qualified(f.referencedTable)} (${f.referencedColumns?.map(id).join(", ") ?? "referenced columns omitted"}); local nullable: ${f.nullable.join(", ")}${f.actions.length > 0 ? `; ${f.actions.join(", ")}` : ""}; line ${f.span.start.line}.`,
    );
  for (const c of structure.checks)
    observed(
      `CHECK ${c.name === null ? "(unnamed)" : id(c.name)}: ${displayDiagnosticPreview(c.expression)}; line ${c.span.start.line}. Expression semantics not evaluated.`,
    );
  // Shared enum labels are rendered once per type, avoiding columns × labels amplification.
  const enumGroups = new Map<
    string,
    { declaration: (typeof structure.enums)[number]; columns: string[] }
  >();
  for (const declaration of structure.enums) {
    const key = ddlQualifiedIdentityKey(declaration.type);
    const group = enumGroups.get(key);
    if (group === undefined)
      enumGroups.set(key, { declaration, columns: [id(declaration.column)] });
    else group.columns.push(id(declaration.column));
  }
  for (const { declaration: e, columns } of enumGroups.values())
    observed(
      `ENUM ${columns.join(", ")} → ${qualified(e.type)}: ${e.labels?.map((l) => JSON.stringify(displayDiagnosticPreview(l))).join(", ") ?? "labels unavailable"}; line ${e.span.start.line}.`,
    );
  for (const t of structure.triggers)
    observed(
      `TRIGGER ${id(t.name)}: ${t.timing.toUpperCase()} ${t.events.join(" OR ").toUpperCase()}${t.updateOf.length ? ` OF ${t.updateOf.map(id).join(", ")}` : ""}; ${t.level}; WHEN ${t.whenPresent ? "present" : "absent"}; function ${qualified(t.function)}; line ${t.span.start.line}. Function body/effects not evaluated.`,
    );
  for (const r of structure.rls)
    observed(
      `RLS ${r.axis}: ${r.value}; line ${r.span.start.line}. Declaration evidence, not effective authorization.`,
    );
  for (const p of structure.policies)
    observed(
      `POLICY ${id(p.name)}: ${p.command.toUpperCase()}, ${p.mode}; roles ${p.roles?.map(id).join(", ") ?? "PUBLIC (default)"}; USING ${p.usingPresent ? "present" : "absent"}; WITH CHECK ${p.withCheckPresent ? "present" : "absent"}; line ${p.span.start.line}. Effective authorization not evaluated.`,
    );
  const bottomLine = facts.slice(0, 3).map((f) => compactFact(f).text);
  return {
    decision,
    target: qualified(evaluation.target.identity),
    coverage: coverage.state,
    bottomLine,
    databaseBehavior: behavior,
    sections: (
      [
        {
          heading: "DECISION",
          facts: [
            { basis: "Derived", text: decision },
            {
              basis: "Not evaluated",
              text: "Supplied DDL only. Not production approval or a migration guarantee.",
            },
          ],
        },
        {
          heading: "TARGET",
          facts: [{ basis: "Observed", text: qualified(evaluation.target.identity) }],
        },
        {
          heading: "COVERAGE",
          facts: [
            { basis: "Derived", text: coverage.state },
            {
              basis: "Observed",
              text: `${coverage.discovered} statements discovered; ${coverage.relevant} relevant; ${counts.EVALUATED_FOR_TARGET} evaluated; ${counts.RELEVANT_NOT_EVALUATED} relevant not evaluated; ${counts.IRRELEVANT_TO_TARGET} unrelated; ${counts.UNRESOLVED_TARGET_ASSOCIATION} could not be safely associated with a target; ${counts.UNSUPPORTED_DOCUMENT_STATEMENT} unsupported document statements; ${counts.PARSE_REFUSED} parse refused.`,
            },
            {
              basis: "Not evaluated",
              text: "Coverage describes bounded static declarations; expression semantics, runtime effects, source data and live state are not evaluated.",
            },
          ],
        },
        {
          heading: "IMPORT CONTRACT",
          facts: groups.length
            ? groups
            : [{ basis: "Not evaluated", text: "No column contract established." }],
        },
        { heading: "PRIMARY FINDINGS", facts: facts.slice(0, 6) },
        {
          heading: "DATABASE BEHAVIOR",
          facts: behavior.slice(0, 6).concat(
            behavior.length > 6
              ? [
                  {
                    basis: "Observed",
                    text: `${behavior.length - 6} further structural details in Technical Evidence.`,
                  },
                ]
              : [],
          ),
        },
        { heading: "NEXT REVIEW", facts: next.slice(0, 6) },
        { heading: "BOTTOM LINE", facts: bottomLine.map((text) => ({ basis: "Derived", text })) },
      ] satisfies readonly DecisionSection[]
    ).map((section) => ({ ...section, facts: section.facts.map(compactFact) })),
  };
}

export function renderMigrationDecisionReport(decision: MigrationDecisionReport): string {
  return `${decision.sections.map((s) => `${s.heading}\n${s.facts.map((f) => `- ${f.basis}: ${f.text}`).join("\n")}`).join("\n\n")}\n`;
}
