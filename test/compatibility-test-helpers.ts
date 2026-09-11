import assert from "node:assert/strict";
import { checkCompatibility } from "../src/index.js";
import { PROFILE } from "../src/public-profile.js";

export const check = (ddl: string): string => checkCompatibility(new TextEncoder().encode(ddl));
export const target = (columns = "id integer PRIMARY KEY, value text"): string =>
  `CREATE TABLE public.t (${columns});`;

export const REVIEW_BLOCK = [
  "IMPORTFLOW REVIEW REQUIRED",
  "Only supplied DDL was analyzed. No live database was queried.",
  "This is not production approval or a migration guarantee.",
  "Review live schema and omitted objects, effective authorization and tenant isolation,",
  "trusted system values and final mapping, trigger/function/rewrite effects,",
  "installation, workload, and production approval with ImportFlow.",
  "Profile restrictions describe the dated Alpha scope, not permanent product limits.",
].join("\n");

export function assertReport(report: string, result: string, reasons: readonly string[]): void {
  assert.ok(report.endsWith("\n") && !report.endsWith("\n\n"));
  for (const scalar of report) {
    const code = scalar.charCodeAt(0);
    assert.ok(code === 10 || (code >= 32 && !(code >= 127 && code <= 159) && code !== 0xfeff));
  }
  assert.doesNotMatch(report, / +$/m);
  assert.ok(report.endsWith("check-behavior-v2 | importflow-envelope-v4 | 2026-09-09\n"));
  assert.doesNotMatch(report, /no_envelope_conflict_observed/);
  if (result === "refused") {
    assert.deepEqual(
      [...report.matchAll(/^REFUSED: (\w+)$/gm)].map((m) => m[1]),
      reasons,
    );
    assert.ok(
      report.includes("Analysis unavailable; this is not a finding of ImportFlow incompatibility."),
    );
    assert.ok(
      report.includes(
        "No live database was queried. No production approval or migration guarantee is given.",
      ),
    );
    assert.doesNotMatch(report, /TEXT-ONLY VERDICT:|FINDINGS|COLUMNS|IMPORTFLOW REVIEW REQUIRED/);
    return;
  }
  assert.ok(report.includes(`TEXT-ONLY VERDICT: ${result}\n`));
  const findings = report.split("\nFINDINGS\n")[1]?.split("\n\nCOLUMNS\n")[0];
  assert.ok(findings !== undefined);
  assert.deepEqual(
    [...findings.matchAll(/^ {2}(\w+) — /gm)].map((m) => m[1]),
    reasons,
  );
  assert.equal(report.split(REVIEW_BLOCK).length - 1, 1);
  for (const category of PROFILE.external_review_always_required)
    assert.ok(!report.includes(category));
  assert.ok(!report.includes("report_notice_authority"));
}

export function expectCheck(ddl: string, result: string, reasons: readonly string[]): string {
  const report = check(ddl);
  assertReport(report, result, reasons);
  return report;
}
