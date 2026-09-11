import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "./compatibility-test-helpers.js";

const analyzedPrefix = `PG IMPORT CHECK
profile: importflow-envelope-v4 | ImportFlow Founder-Assisted Alpha — target-schema check profile
as of: 2026-09-09 | offline snapshot; current availability not verified
`;
const analyzedSuffix = `

IMPORTFLOW REVIEW REQUIRED
Only supplied DDL was analyzed. No live database was queried.
This is not production approval or a migration guarantee.
Review live schema and omitted objects, effective authorization and tenant isolation,
trusted system values and final mapping, trigger/function/rewrite effects,
installation, workload, and production approval with ImportFlow.
Profile restrictions describe the dated Alpha scope, not permanent product limits.

check-behavior-v2 | importflow-envelope-v4 | 2026-09-09
`;

const goldens = [
  {
    name: "structural success",
    ddl: "CREATE TABLE public.t(id integer PRIMARY KEY);",
    middle: `target: public.t
TEXT-ONLY VERDICT: no_structural_conflict_observed
No structural conflict was observed among the declarations evaluated.

FINDINGS
  No profile conflicts or unresolved predicates were found in the evaluated declarations.

COLUMNS
  id — file mapping candidate; final classification requires ImportFlow review`,
  },
  {
    name: "unresolved Unicode column and ordinary default",
    ddl: "CREATE TABLE public.t(id integer PRIMARY KEY, \"é\" text DEFAULT 'secret');",
    middle: `target: public.t
TEXT-ONLY VERDICT: more_evidence_required
A declared feature or missing declaration requires ImportFlow review.

FINDINGS
  identifier_review_required — A target-profile identifier requires Unicode compatibility review.
  value_generation_review_required — Declared generation/default behavior requires ImportFlow review.

COLUMNS
  id — file mapping candidate; final classification requires ImportFlow review
  "é" — excluded from file mapping by the ordinary generation/default rule | identifier_review_required,value_generation_review_required`,
  },
  {
    name: "hard conflict plus unresolved findings",
    ddl: "CREATE TABLE t(id integer PRIMARY KEY, value jsonb DEFAULT NULL);",
    middle: `target: t (schema not declared)
TEXT-ONLY VERDICT: outside_envelope_observed
Explicit declarations conflict with the dated public target-schema profile.

FINDINGS
  target_schema_unresolved — The supplied target does not name its schema.
  column_type_outside_profile — A supplied column declares a type shape outside this public profile.
  value_generation_review_required — Declared generation/default behavior requires ImportFlow review.

COLUMNS
  id — file mapping candidate; final classification requires ImportFlow review
  value — outside public type profile | column_type_outside_profile,value_generation_review_required`,
  },
];
for (const golden of goldens) {
  test(`public API exact golden: ${golden.name}`, () => {
    assert.equal(check(golden.ddl), analyzedPrefix + golden.middle + analyzedSuffix);
  });
}

test("public API exact golden: refusal before malformed tail", () => {
  assert.equal(
    check("SELECT 'unterminated"),
    `PG IMPORT CHECK
profile: importflow-envelope-v4 | 2026-09-09
REFUSED: unsupported_statement
  The top-level statement is outside check-behavior-v1.
  at line 1, column 1; 6 bytes; "SELECT"
  Remove it or supply the relevant declaration in an accepted statement form.
Analysis unavailable; this is not a finding of ImportFlow incompatibility.
No live database was queried. No production approval or migration guarantee is given.
check-behavior-v2 | importflow-envelope-v4 | 2026-09-09
`,
  );
});
