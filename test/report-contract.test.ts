import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { IdentifierIdentity } from "../src/create-table-parser-primitives.js";
import type { SourceSpan } from "../src/create-table-token-source.js";
import { checkCompatibility } from "../src/index.js";
import { PROFILE, type ReasonId } from "../src/public-profile.js";
import {
  type AnalyzedReport,
  type ReportRefusal,
  type ReportRefusalId,
  renderAnalyzedReport,
  renderRefusalReport,
} from "../src/report-renderer.js";
import {
  displayDiagnosticPreview,
  displayIdentifier,
  isReportUnsafeIdentifierCodePoint,
} from "../src/report-safe-display.js";

const span: SourceSpan = {
  start: { rawByteOffset: 0, line: 3, column: 4 },
  end: { rawByteOffset: 1, line: 3, column: 5 },
};
const column: IdentifierIdentity = { identity: 'a"—', quoted: true, span };
const encoder = new TextEncoder();
const footer = "check-behavior-v2 | importflow-envelope-v4 | 2026-09-09\n";
const notice = `IMPORTFLOW REVIEW REQUIRED
Only supplied DDL was analyzed. No live database was queried.
This is not production approval or a migration guarantee.
Review live schema and omitted objects, effective authorization and tenant isolation,
trusted system values and final mapping, trigger/function/rewrite effects,
installation, workload, and production approval with ImportFlow.
Profile restrictions describe the dated Alpha scope, not permanent product limits.`;

describe("exact public report contract", () => {
  it("renders exact unresolved and success reports, with only the authorized notices", () => {
    const variants = [
      {
        result: "more_evidence_required",
        note: "A declared feature or missing declaration requires ImportFlow review.",
        reasonIds: ["target_schema_unresolved"],
        findings: "  target_schema_unresolved — The supplied target does not name its schema.",
      },
      {
        result: "no_structural_conflict_observed",
        note: "No structural conflict was observed among the declarations evaluated.",
        reasonIds: [],
        findings:
          "  No profile conflicts or unresolved predicates were found in the evaluated declarations.",
      },
    ] as const;
    for (const variant of variants) {
      const report: AnalyzedReport = {
        target: { qualifier: null, local: { identity: "Items", quoted: true, span }, span },
        result: variant.result,
        reasonIds: variant.reasonIds,
        columns: [
          {
            name: { identity: "ID", quoted: false, span },
            disposition: "file mapping candidate; final classification requires ImportFlow review",
            reasonIds: [],
          },
        ],
      };
      const output = renderAnalyzedReport(report);
      assert.equal(
        output,
        `PG IMPORT CHECK
profile: importflow-envelope-v4 | ImportFlow Founder-Assisted Alpha — target-schema check profile
as of: 2026-09-09 | offline snapshot; current availability not verified
target: "Items" (schema not declared)
TEXT-ONLY VERDICT: ${variant.result}
${variant.note}

FINDINGS
${variant.findings}

COLUMNS
  id — file mapping candidate; final classification requires ImportFlow review

${notice}

${footer}`,
      );
      for (const category of PROFILE.external_review_always_required) {
        assert.ok(!output.includes(category));
      }
      assert.doesNotMatch(output, /report_notice_authority/);
    }
  });

  it("renders every JSON reason exactly once in public rule order without suppressing findings", () => {
    const messages = JSON.parse(readFileSync("spec/reason-templates.v4.json", "utf8")) as {
      messages: Record<ReasonId, string>;
    };
    const reasons = PROFILE.rules.map(({ id }) => id);
    const report = renderAnalyzedReport({
      target: { qualifier: null, local: column, span },
      result: "outside_envelope_observed",
      reasonIds: [...reasons].reverse().concat(reasons),
      columns: [
        {
          name: column,
          disposition: "outside public type profile",
          reasonIds: [...reasons].reverse().concat(reasons),
        },
      ],
    });
    assert.equal(
      report.split("\nFINDINGS\n")[1]?.split("\n\nCOLUMNS\n")[0],
      reasons.map((id) => `  ${id} — ${messages.messages[id]}`).join("\n"),
    );
    assert.equal(
      report.split("\nCOLUMNS\n")[1]?.split("\n\n")[0],
      `  "a""\\u{2014}" — outside public type profile | ${reasons.join(",")}`,
    );
  });

  it("matches all 25 recognition explanation/remediation templates byte for byte", () => {
    const document = readFileSync("docs/DDL_RECOGNITION_V1.md", "utf8");
    const section = document.split("### 12.3 Refusal reasons")[1]?.split("A refusal contains")[0];
    assert.ok(section);
    const rows = section.split("\n").filter((line) => line.startsWith("| `"));
    assert.equal(rows.length, 25);
    for (const row of rows) {
      const fields = row.split(" | ");
      const id = fields[0]?.match(/`([^`]+)`/)?.[1] as ReportRefusalId;
      const explanation = fields[2]?.match(/^`(.*)`$/)?.[1];
      const remediation = fields[3]?.match(/^`(.*)` \|$/)?.[1];
      assert.ok(explanation);
      assert.ok(remediation);
      const refusal = refusalFor(id);
      const noLocation = [
        "input_empty",
        "input_too_large",
        "invalid_utf8",
        "browser_lone_surrogate",
        "no_target_table",
      ].includes(id);
      const location = noLocation
        ? ""
        : `  at line 3, column 4; 1 bytes; "${id === "nul_byte_not_in_profile" ? "\\u{0}" : "x"}"\n`;
      const interpolate = (value: string): string =>
        value
          .replace("<actual>", id === "identifier_outside_profile" ? "72" : "3")
          .replace("<column>", '"a""\\u{2014}"')
          .replace("<trusted-clause-list>", "NULL + PRIMARY KEY");
      assert.equal(
        renderRefusalReport(refusal, encoder.encode("x")),
        `PG IMPORT CHECK
profile: importflow-envelope-v4 | 2026-09-09
REFUSED: ${id}
  ${interpolate(explanation)}
${location}  ${interpolate(remediation)}
Analysis unavailable; this is not a finding of ImportFlow incompatibility.
No live database was queried. No production approval or migration guarantee is given.
${footer}`,
        id,
      );
    }
  });

  it("renders an API NUL refusal from raw-profile location without a retained snapshot", () => {
    assert.equal(
      checkCompatibility(encoder.encode("\uFEFF--é\r\n\0")),
      `PG IMPORT CHECK
profile: importflow-envelope-v4 | 2026-09-09
REFUSED: nul_byte_not_in_profile
  The input contains a NUL byte, which is outside check-behavior-v1.
  at line 2, column 1; 1 bytes; "\\u{0}"
  Remove the NUL byte and supply text input.
Analysis unavailable; this is not a finding of ImportFlow incompatibility.
No live database was queried. No production approval or migration guarantee is given.
${footer}`,
    );
  });
});

describe("frozen display safety and bounded work", () => {
  it("mechanically matches the private lexer predicate across every Unicode scalar", () => {
    // Parse only its closed literal union, without eval or exporting/changing the lexer.
    const source = readFileSync("src/create-table-token-source.ts", "utf8");
    const body = source.match(
      /function isUnsafeIdentifierCodePoint\(codePoint: number\): boolean \{([\s\S]*?)\n\}/,
    )?.[1];
    assert.ok(body);
    const acceptedTerms =
      /inRange\(codePoint, (0x[0-9a-f]+), (0x[0-9a-f]+)\)|codePoint === (0x[0-9a-f]+)|\(codePoint & 0xffff\) >= 0xfffe/g;
    const table = new Uint8Array(0x110000);
    for (const term of body.matchAll(acceptedTerms)) {
      if (term[1] !== undefined && term[2] !== undefined) {
        table.fill(1, Number(term[1]), Number(term[2]) + 1);
      } else if (term[3] !== undefined) {
        table[Number(term[3])] = 1;
      } else {
        for (let plane = 0; plane <= 0x10; plane += 1) {
          table.fill(1, plane * 0x10000 + 0xfffe, (plane + 1) * 0x10000);
        }
      }
    }
    assert.equal(body.replace(acceptedTerms, "").replace(/\s|\||\(|\)|;/g, ""), "return");
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      assert.equal(
        isReportUnsafeIdentifierCodePoint(point),
        table[point] === 1,
        `U+${point.toString(16)}`,
      );
    }
  });

  it("escapes the complete whitespace/structural-glyph sets and preserves normalization distinctions", () => {
    const points = [
      0x85,
      0xa0,
      0x1680,
      ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
      0x2192,
      0x26a0,
      0x2014,
      0x2715,
      0xb7,
    ];
    for (const point of points) {
      assert.equal(
        displayDiagnosticPreview(String.fromCodePoint(point)),
        `\\u{${point.toString(16).toUpperCase()}}`,
      );
    }
    for (const value of ["é", "e\u0301", "עברית", "عربي", "https://example.test/a", "😀"]) {
      assert.equal(displayIdentifier({ identity: value, quoted: true, span }), `"${value}"`);
    }
    assert.equal(
      displayDiagnosticPreview("\x1b]8;;https://evil.test\x07x\x1b]8;;\x07"),
      "\\u{1B}]8;;https://evil.test\\u{7}x\\u{1B}]8;;\\u{7}",
    );
  });

  it("retains complete scalars and escape sequences around both limits", () => {
    for (const value of ["a", "é", "漢", "😀", "\u{E0001}", "\\", '"', "\n"]) {
      for (const count of [0, 1, 31, 32, 42, 43, 63, 64, 65, 262_144]) {
        const preview = displayDiagnosticPreview(value.repeat(count));
        assert.ok(encoder.encode(preview).byteLength <= 256);
        for (const unsafe of ["\r", "\n", "\x1b"]) assert.ok(!preview.includes(unsafe));
        if (count > 64) assert.ok(preview.endsWith("..."));
      }
    }
    assert.equal(displayDiagnosticPreview(`${"😀".repeat(63)}a`), `${"😀".repeat(63)}a`);
    assert.equal(displayDiagnosticPreview(`${"😀".repeat(63)}aa`), `${"😀".repeat(63)}a...`);
  });

  it("decodes at most 256 source bytes and aligns the cutoff before a partial scalar", (t) => {
    const decode = TextDecoder.prototype.decode;
    const lengths: number[] = [];
    t.mock.method(
      TextDecoder.prototype,
      "decode",
      function (this: InstanceType<typeof TextDecoder>, input: Uint8Array) {
        lengths.push(input.byteLength);
        return decode.call(this, input);
      },
    );
    for (const fragment of ["x".repeat(262_144), "😀".repeat(65), `a${"😀".repeat(65)}`]) {
      const raw = encoder.encode(fragment);
      const result = renderRefusalReport(
        {
          refusalId: "unsupported_statement",
          span: { start: span.start, end: { ...span.end, rawByteOffset: raw.byteLength } },
        },
        raw,
      );
      assert.ok(
        result.includes(`; ${raw.byteLength} bytes; "${displayDiagnosticPreview(fragment)}"`),
      );
    }
    assert.deepEqual(lengths, [256, 256, 253]);
  });
});

function refusalFor(refusalId: ReportRefusalId): ReportRefusal {
  switch (refusalId) {
    case "input_too_large":
    case "invalid_utf8":
      return { kind: "refused", refusalId };
    case "input_empty":
    case "no_target_table":
    case "browser_lone_surrogate":
      return { refusalId };
    case "nul_byte_not_in_profile":
      return { kind: "refused", refusalId, location: { ...span.start, rawByteLength: 1 } };
    case "identifier_outside_profile":
      return { refusalId, actualUtf8ByteLength: 72, span };
    case "multiple_target_tables":
      return { refusalId, actualTargetCount: 3, span };
    case "conflicting_column_declaration":
      return { refusalId, column, clauseLabels: ["NULL", "PRIMARY KEY"], span };
    case "ambiguous_declaration":
      return { refusalId, span };
    case "unbalanced_delimiter":
      return { refusalId, span };
    case "empty_statement_not_in_profile":
    case "unsupported_statement":
    case "statement_targets_other_relation":
    case "unassociated_auxiliary_declaration":
    case "escape_string_semantics_not_in_profile":
      return { refusalId, span };
    default:
      return { refusalId, span };
  }
}
