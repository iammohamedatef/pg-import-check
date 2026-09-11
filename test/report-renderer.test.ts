import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  IdentifierIdentity,
  QualifiedIdentity,
} from "../src/create-table-parser-primitives.js";
import type { SourceSpan } from "../src/create-table-token-source.js";
import type { DdlRefusal } from "../src/ddl-evidence.js";
import {
  type AnalyzedReport,
  renderAnalyzedReport,
  renderRefusalReport,
} from "../src/report-renderer.js";
import {
  displayDiagnosticPreview,
  displayIdentifier,
  displayQualifiedIdentity,
  isReportUnsafeIdentifierCodePoint,
} from "../src/report-safe-display.js";

const encoder = new TextEncoder();
const PROFILE_LINE =
  "profile: importflow-envelope-v4 | ImportFlow Founder-Assisted Alpha — target-schema check profile";
const REVIEW = `IMPORTFLOW REVIEW REQUIRED
Only supplied DDL was analyzed. No live database was queried.
This is not production approval or a migration guarantee.
Review live schema and omitted objects, effective authorization and tenant isolation,
trusted system values and final mapping, trigger/function/rewrite effects,
installation, workload, and production approval with ImportFlow.
Profile restrictions describe the dated Alpha scope, not permanent product limits.`;
const FOOTER = "check-behavior-v2 | importflow-envelope-v4 | 2026-09-09\n";

describe("analyzed report rendering", () => {
  it("renders an exact conflict report with ordered distinct findings and columns", () => {
    const report: AnalyzedReport = {
      target: qualified(identifier("Public", true), identifier('Odd"Table', true)),
      result: "outside_envelope_observed",
      reasonIds: [
        "column_type_outside_profile",
        "target_schema_outside_profile",
        "column_type_outside_profile",
      ],
      columns: [
        {
          name: identifier("ID", false),
          disposition: "file mapping candidate; final classification requires ImportFlow review",
          reasonIds: [],
        },
        {
          name: identifier("payload", false),
          disposition: "outside public type profile",
          reasonIds: ["column_type_outside_profile"],
        },
      ],
    };

    assert.equal(
      renderAnalyzedReport(report),
      `PG IMPORT CHECK
${PROFILE_LINE}
as of: 2026-09-09 | offline snapshot; current availability not verified
target: "Public"."Odd""Table"
TEXT-ONLY VERDICT: outside_envelope_observed
Explicit declarations conflict with the dated public target-schema profile.

FINDINGS
  target_schema_outside_profile — The explicitly named target schema is outside this public profile.
  column_type_outside_profile — A supplied column declares a type shape outside this public profile.

COLUMNS
  id — file mapping candidate; final classification requires ImportFlow review
  payload — outside public type profile | column_type_outside_profile

${REVIEW}

${FOOTER}`,
    );
  });

  it("renders exact unresolved and successful variants", () => {
    const base = {
      target: qualified(null, identifier("items", false)),
      columns: [
        {
          name: identifier("generated_id", false),
          disposition:
            "excluded from file mapping by the ordinary generation/default rule" as const,
          reasonIds: ["value_generation_review_required"] as const,
        },
      ],
    };
    const unresolved = renderAnalyzedReport({
      ...base,
      result: "more_evidence_required",
      reasonIds: ["target_schema_unresolved", "value_generation_review_required"],
    });
    assert.match(
      unresolved,
      /target: items \(schema not declared\)\nTEXT-ONLY VERDICT: more_evidence_required\nA declared feature or missing declaration requires ImportFlow review\./,
    );
    assert.match(
      unresolved,
      / {2}generated_id — excluded from file mapping by the ordinary generation\/default rule \| value_generation_review_required/,
    );

    const success = renderAnalyzedReport({
      target: qualified(identifier("public", false), identifier("items", false)),
      columns: [
        {
          name: identifier("value", false),
          disposition: "file mapping candidate; final classification requires ImportFlow review",
          reasonIds: [],
        },
      ],
      result: "no_structural_conflict_observed",
      reasonIds: [],
    });
    assert.match(
      success,
      /TEXT-ONLY VERDICT: no_structural_conflict_observed\nNo structural conflict was observed among the declarations evaluated\./,
    );
    assert.match(
      success,
      /FINDINGS\n {2}No profile conflicts or unresolved predicates were found in the evaluated declarations\./,
    );
    assertReportFraming(unresolved);
    assertReportFraming(success);
  });
});

describe("safe display", () => {
  it("quotes identities and escapes controls, separators, backslashes, and injection text", () => {
    assert.equal(displayIdentifier(identifier("UPPER", false)), "upper");
    assert.equal(
      displayIdentifier(identifier('A"\\\n\u202e—\u00a0$(touch /tmp/no)', true)),
      '"A""\\\\\\n\\u{202E}\\u{2014}\\u{A0}$(touch /tmp/no)"',
    );
    assert.equal(
      displayQualifiedIdentity(qualified(identifier("مدخل", true), identifier("таблица", true))),
      '"مدخل"."таблица"',
    );
  });

  it("enforces both preview limits and reserves the truncation marker", () => {
    assert.equal(displayDiagnosticPreview("a".repeat(64)), "a".repeat(64));
    assert.equal(displayDiagnosticPreview("a".repeat(65)), `${"a".repeat(64)}...`);
    assert.equal(displayDiagnosticPreview("😀".repeat(64)), "😀".repeat(64));
    assert.equal(displayDiagnosticPreview("😀".repeat(65)), `${"😀".repeat(63)}...`);
    assert.equal(displayDiagnosticPreview("\u001b".repeat(43)), `${"\\u{1B}".repeat(42)}...`);
    assert.equal(encoder.encode(displayDiagnosticPreview("\u001b".repeat(43))).byteLength, 255);
    assert.equal(displayDiagnosticPreview('"\\\r\n\t—'), '\\"\\\\\\r\\n\\t\\u{2014}');
  });

  it("keeps the copied unsafe table mechanically equal to the contract table", () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        continue;
      }
      assert.equal(
        isReportUnsafeIdentifierCodePoint(codePoint),
        contractUnsafeCodePoint(codePoint),
        `unsafe-table mismatch at U+${codePoint.toString(16).toUpperCase()}`,
      );
    }
  });
});

describe("refusal rendering", () => {
  it("renders raw size and invalid UTF-8 refusals without decoding or echoing bytes", () => {
    const invalidBytes = Uint8Array.of(0xff, 0x1b, 0x00);
    const invalid = renderRefusalReport(
      { kind: "refused", refusalId: "invalid_utf8" },
      invalidBytes,
    );
    assert.equal(
      invalid,
      refusalGolden(
        "invalid_utf8",
        "The input is not strict scalar-valid UTF-8.",
        null,
        "Supply the DDL as UTF-8 text.",
      ),
    );
    assert.doesNotMatch(invalid, /FFFD|\\u\{FF\}|at line/);

    const tooLarge = renderRefusalReport({ kind: "refused", refusalId: "input_too_large" });
    assert.equal(
      tooLarge,
      refusalGolden(
        "input_too_large",
        "The input exceeds the 262,144 raw-byte limit for check-behavior-v1.",
        null,
        "Reduce the supplied DDL to 262,144 UTF-8 bytes or fewer.",
      ),
    );
  });

  it("renders a bounded source location and an EOF location", () => {
    const source = `SELECT "${"😀".repeat(65)}"`;
    const raw = encoder.encode(source);
    const refusal: DdlRefusal = {
      refusalId: "unsupported_statement",
      span: sourceSpan(7, raw.byteLength, 1, 8),
    };
    const rendered = renderRefusalReport(refusal, raw);
    assert.equal(
      rendered,
      refusalGolden(
        "unsupported_statement",
        "The top-level statement is outside check-behavior-v1.",
        `  at line 1, column 8; 262 bytes; "\\"${"😀".repeat(62)}..."`,
        "Remove it or supply the relevant declaration in an accepted statement form.",
      ),
    );
    assert.match(
      rendered,
      new RegExp(
        `  at line 1, column 8; ${raw.byteLength - 7} bytes; "\\\\"${"😀".repeat(62)}\\.\\.\\."`,
      ),
    );
    assertReportFraming(rendered);

    const eof: DdlRefusal = {
      refusalId: "syntax_not_in_profile",
      location: { rawByteOffset: 12, line: 2, column: 4 },
      atEndOfInput: true,
    };
    assert.match(
      renderRefusalReport(eof),
      / {2}at end of input\n {2}Supply the equivalent accepted form/,
    );
  });

  it("bounds a near-cap diagnostic without amplifying its preview", () => {
    const source = "x".repeat(262_144);
    const raw = encoder.encode(source);
    const refusal: DdlRefusal = {
      refusalId: "unsupported_statement",
      span: sourceSpan(0, raw.byteLength, 1, 1),
    };
    const rendered = renderRefusalReport(refusal, raw);
    assert.match(
      rendered,
      / {2}at line 1, column 1; 262144 bytes; "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\.\.\."/,
    );
    assert.ok(rendered.length < 1_000);
  });

  it("interpolates identifier length, target count, and safe conflict details", () => {
    const identifierBytes = encoder.encode('"long"');
    const identifierRefusal: DdlRefusal = {
      refusalId: "identifier_outside_profile",
      actualUtf8ByteLength: 64,
      span: sourceSpan(0, identifierBytes.byteLength, 1, 1),
    };
    assert.match(
      renderRefusalReport(identifierRefusal, identifierBytes),
      /An identifier is 64 UTF-8 bytes; this profile accepts at most 63\./,
    );

    const countBytes = encoder.encode("CREATE TABLE a(); CREATE TABLE b();");
    const countRefusal: DdlRefusal = {
      refusalId: "multiple_target_tables",
      actualTargetCount: 2,
      span: sourceSpan(18, countBytes.byteLength, 1, 19),
    };
    assert.match(
      renderRefusalReport(countRefusal, countBytes),
      /2 CREATE TABLE targets were supplied; this check analyzes one\./,
    );

    const conflictBytes = encoder.encode("DEFAULT");
    const conflict: DdlRefusal = {
      refusalId: "conflicting_column_declaration",
      column: identifier("x\n—", true),
      clauseLabels: ["DEFAULT", "DEFAULT"],
      span: sourceSpan(0, conflictBytes.byteLength, 3, 7),
    };
    const rendered = renderRefusalReport(conflict, conflictBytes);
    assert.match(
      rendered,
      /"x\\n\\u\{2014\}" combines conflicting or repeated column clauses: DEFAULT \+ DEFAULT\./,
    );
    assert.match(rendered, /Supply one accepted, unambiguous declaration for "x\\n\\u\{2014\}"\./);
    assertReportFraming(rendered);
  });

  it("renders the raw NUL profile location safely without retained input bytes", () => {
    const rendered = renderRefusalReport({
      kind: "refused",
      refusalId: "nul_byte_not_in_profile",
      location: { rawByteOffset: 1, rawByteLength: 1, line: 1, column: 2 },
    });
    assert.match(rendered, / {2}at line 1, column 2; 1 bytes; "\\u\{0\}"/);
    assert.ok(!rendered.includes("\0"));
  });
});

function identifier(identity: string, quoted: boolean): IdentifierIdentity {
  return { identity, quoted, span: sourceSpan(0, 0, 1, 1) };
}

function qualified(
  qualifier: IdentifierIdentity | null,
  local: IdentifierIdentity,
): QualifiedIdentity {
  return { qualifier, local, span: sourceSpan(0, 0, 1, 1) };
}

function sourceSpan(
  startOffset: number,
  endOffset: number,
  line: number,
  column: number,
): SourceSpan {
  return {
    start: { rawByteOffset: startOffset, line, column },
    end: { rawByteOffset: endOffset, line, column: column + 1 },
  };
}

function refusalGolden(
  refusalId: string,
  explanation: string,
  location: string | null,
  remediation: string,
): string {
  return `PG IMPORT CHECK
profile: importflow-envelope-v4 | 2026-09-09
REFUSED: ${refusalId}
  ${explanation}
${location === null ? "" : `${location}\n`}  ${remediation}
Analysis unavailable; this is not a finding of ImportFlow incompatibility.
No live database was queried. No production approval or migration guarantee is given.
${FOOTER}`;
}

function assertReportFraming(report: string): void {
  assert.ok(report.endsWith("\n"));
  assert.ok(!report.endsWith("\n\n"));
  assert.doesNotMatch(report, /\r/);
  assert.doesNotMatch(report, / +$/m);
  assert.ok(report.endsWith(FOOTER));
}

function contractUnsafeCodePoint(codePoint: number): boolean {
  return (
    inRange(codePoint, 0x0000, 0x001f) ||
    inRange(codePoint, 0x007f, 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    inRange(codePoint, 0x0600, 0x0605) ||
    codePoint === 0x061c ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    inRange(codePoint, 0x0890, 0x0891) ||
    codePoint === 0x08e2 ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    inRange(codePoint, 0x180b, 0x180f) ||
    inRange(codePoint, 0x200b, 0x200f) ||
    inRange(codePoint, 0x202a, 0x202e) ||
    inRange(codePoint, 0x2060, 0x206f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x3164 ||
    inRange(codePoint, 0xfe00, 0xfe0f) ||
    codePoint === 0xfeff ||
    codePoint === 0xffa0 ||
    inRange(codePoint, 0xfff0, 0xfffb) ||
    codePoint === 0x110bd ||
    codePoint === 0x110cd ||
    inRange(codePoint, 0x13430, 0x1343f) ||
    inRange(codePoint, 0x1bca0, 0x1bca3) ||
    inRange(codePoint, 0x1d173, 0x1d17a) ||
    inRange(codePoint, 0xe0000, 0xe0fff) ||
    inRange(codePoint, 0xe000, 0xf8ff) ||
    inRange(codePoint, 0xf0000, 0xffffd) ||
    inRange(codePoint, 0x100000, 0x10fffd) ||
    inRange(codePoint, 0xfdd0, 0xfdef) ||
    (codePoint & 0xffff) >= 0xfffe
  );
}

function inRange(codePoint: number, start: number, end: number): boolean {
  return codePoint >= start && codePoint <= end;
}
