import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  recognizeCreateTableCoreShape,
  type CreateTableCoreShapeResult,
} from "../src/create-table-core-shape.js";
import type { ColumnConflictLabel } from "../src/create-table-column-conflicts.js";
import { applyRawInputProfile, MAX_RAW_INPUT_BYTES } from "../src/input-profile.js";
import {
  acceptText,
  concatenate,
  expectAccepted,
  expectConflict,
  expectRecognized,
  expectRefused,
  expectUnexpectedToken,
  recognizeText,
  spanText,
  UTF8_BOM,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();

function acceptTextWithBom(sourceText: string) {
  return expectAccepted(applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))));
}

function utf8OffsetOf(sourceText: string, needle: string, fromEnd = false): number {
  const codeUnitOffset = fromEnd ? sourceText.lastIndexOf(needle) : sourceText.indexOf(needle);
  assert.notEqual(codeUnitOffset, -1, `Missing ${needle}`);
  return encoder.encode(sourceText.slice(0, codeUnitOffset)).byteLength;
}

function expectBoundary(sourceText: string, expected: string): void {
  const input = acceptText(sourceText);
  assert.equal(
    spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
    expected,
    sourceText,
  );
}

function identityOccurrence(sourceText: string, withBom = false) {
  const input = withBom ? acceptTextWithBom(sourceText) : acceptText(sourceText);
  const column = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape.derived
    .columns[0];
  const occurrence = column?.clauseOccurrences.find((candidate) => candidate.kind === "identity");
  if (occurrence?.kind !== "identity") {
    assert.fail("Expected an identity occurrence");
  }
  return { input, column, occurrence };
}

function expectIdentityConflict(
  sourceText: string,
  labels: readonly [ColumnConflictLabel, ColumnConflictLabel],
  anchor: string,
): void {
  const input = acceptText(sourceText);
  const refusal = expectConflict(recognizeCreateTableCoreShape(input));
  assert.deepEqual(refusal.clauseLabels, labels, sourceText);
  assert.equal(spanText(input, refusal.span), anchor, sourceText);
  assert.equal(
    refusal.span.start.rawByteOffset,
    utf8OffsetOf(sourceText, anchor, true),
    sourceText,
  );
}

function expectIdentityOccurrence(
  result: CreateTableCoreShapeResult,
): Extract<
  NonNullable<
    Extract<
      CreateTableCoreShapeResult,
      { kind: "recognized_core_shape" }
    >["coreShape"]["derived"]["columns"][number]
  >["clauseOccurrences"][number],
  { kind: "identity" }
> {
  const occurrence = expectRecognized(result).coreShape.derived.columns[0]?.clauseOccurrences[0];
  if (occurrence?.kind !== "identity") {
    assert.fail("Expected identity occurrence");
  }
  return occurrence;
}

describe("CREATE TABLE identity column recognition", () => {
  it("retains ALWAYS evidence and exact spans across BOM, CRLF, and Unicode", () => {
    const sourceText = [
      'CrEaTe TABLE "表" (',
      '  "é" int GeNeRaTeD/*g*/AlWaYs\tAS IdEnTiTy (start 7, note "😀")',
      ")",
    ].join("\r\n");
    const { input, column, occurrence } = identityOccurrence(sourceText, true);

    assert.deepEqual(
      column?.clauseOccurrences.map(({ kind }) => kind),
      ["identity"],
    );
    assert.equal(spanText(input, occurrence.keywordSpan), "GeNeRaTeD");
    assert.equal(spanText(input, occurrence.generatedKeywordSpan), "GeNeRaTeD");
    assert.equal(occurrence.mode.kind, "always");
    if (occurrence.mode.kind === "always") {
      assert.equal(spanText(input, occurrence.mode.alwaysKeywordSpan), "AlWaYs");
    }
    assert.equal(spanText(input, occurrence.asKeywordSpan), "AS");
    assert.equal(spanText(input, occurrence.identityKeywordSpan), "IdEnTiTy");
    assert.equal(
      spanText(input, occurrence.optionsSpan ?? assert.fail("missing options")),
      '(start 7, note "😀")',
    );
    assert.equal(
      spanText(input, occurrence.clauseSpan),
      'GeNeRaTeD/*g*/AlWaYs\tAS IdEnTiTy (start 7, note "😀")',
    );
    assert.deepEqual(occurrence.underlyingClauseSpan, occurrence.clauseSpan);
    assert.deepEqual(occurrence.establishmentSpan, occurrence.generatedKeywordSpan);
    assert.equal(occurrence.explicitConstraintName, null);
    assert.equal(occurrence.generatedKeywordSpan.start.line, 2);
    assert.equal(occurrence.generatedKeywordSpan.start.column, 11);
    assert.equal(
      occurrence.generatedKeywordSpan.start.rawByteOffset,
      UTF8_BOM.byteLength + utf8OffsetOf(sourceText, "GeNeRaTeD"),
    );
    assert.equal(column?.span.end.rawByteOffset, occurrence.clauseSpan.end.rawByteOffset);
  });

  it("measures raw offsets in UTF-8 bytes after a non-ASCII prefix", () => {
    const sourceText = 'create table "表" ("😀" int GENERATED ALWAYS AS IDENTITY)';
    const occurrence = identityOccurrence(sourceText).occurrence;
    const rawByteOffset = utf8OffsetOf(sourceText, "GENERATED");

    assert.notEqual(rawByteOffset, sourceText.indexOf("GENERATED"));
    assert.equal(occurrence.generatedKeywordSpan.start.rawByteOffset, rawByteOffset);
  });

  it("retains the discriminated BY DEFAULT mode without inventing absent options", () => {
    const sourceText = "create table t (c int GENERATED/*1*/BY/*2*/DEFAULT/*3*/AS/*4*/IDENTITY)";
    const { input, occurrence } = identityOccurrence(sourceText);

    assert.equal(occurrence.mode.kind, "by_default");
    if (occurrence.mode.kind === "by_default") {
      assert.equal(spanText(input, occurrence.mode.byKeywordSpan), "BY");
      assert.equal(spanText(input, occurrence.mode.defaultKeywordSpan), "DEFAULT");
    }
    assert.equal(occurrence.optionsSpan, null);
    assert.equal(
      spanText(input, occurrence.clauseSpan),
      "GENERATED/*1*/BY/*2*/DEFAULT/*3*/AS/*4*/IDENTITY",
    );
  });

  it("keeps non-empty nested and protected identity options opaque and caller-bounded", () => {
    const options = `([start 2, note ')] ; IDENTITY', escaped E'\\')', body $tag$)] ; GENERATED$tag$, position $12]; cache 3)`;
    const sourceText = `create table t (c int GENERATED ALWAYS AS IDENTITY (${options}) NOT NULL UNIQUE)`;
    const { input, column, occurrence } = identityOccurrence(sourceText);

    assert.equal(
      spanText(input, occurrence.optionsSpan ?? assert.fail("missing options")),
      `(${options})`,
    );
    assert.deepEqual(
      column?.clauseOccurrences.map(({ kind }) => kind),
      ["identity", "not_null", "unique"],
    );
  });

  it("recognizes both modes and option choices independently across columns", () => {
    const shape = expectRecognized(
      recognizeText(
        "create table t (a int GENERATED ALWAYS AS IDENTITY, b int GENERATED BY DEFAULT AS IDENTITY (start 2), c text)",
      ),
    ).coreShape;

    assert.deepEqual(
      shape.derived.columns.map((column) => [
        column.name.identity,
        column.clauseOccurrences.map(({ kind }) => kind),
      ]),
      [
        ["a", ["identity"]],
        ["b", ["identity"]],
        ["c", []],
      ],
    );
  });

  it("commits each GENERATED branch and stops at the first wrong demanded token", () => {
    for (const [clause, boundary] of [
      ["GENERATED WRONG E'open", "WRONG"],
      ["GENERATED BY WRONG E'open", "WRONG"],
      ["GENERATED BY DEFAULT WRONG E'open", "WRONG"],
      ["GENERATED BY DEFAULT AS WRONG E'open", "WRONG"],
      ["GENERATED ALWAYS WRONG E'open", "WRONG"],
      ["GENERATED ALWAYS AS WRONG E'open", "WRONG"],
      ["GENERATED ALWAYS AS (1) IDENTITY E'open", "IDENTITY"],
      ["GENERATED ALWAYS AS IDENTITY (start 1) STORED E'open", "STORED"],
    ] as const) {
      expectBoundary(`create table t (c int ${clause}`, boundary);
    }
  });

  it("preserves demanded lexical refusals at every committed identity prefix", () => {
    for (const clause of [
      "GENERATED E'open",
      "GENERATED BY E'open",
      "GENERATED BY DEFAULT E'open",
      "GENERATED BY DEFAULT AS E'open",
      "GENERATED ALWAYS E'open",
      "GENERATED ALWAYS AS E'open",
      "GENERATED ALWAYS AS IDENTITY E'open",
    ]) {
      const refusal = expectRefused(recognizeText(`create table t (c int ${clause}`)).refusal;
      assert.equal(refusal.refusalId, "unterminated_string", clause);
    }
  });

  it("rejects empty or comment-only options and preserves typed delimiter ownership", () => {
    for (const sourceText of [
      "create table t (c int GENERATED ALWAYS AS IDENTITY ())",
      "create table t (c int GENERATED BY DEFAULT AS IDENTITY (/* only */))",
    ]) {
      expectBoundary(sourceText, ")");
    }

    const mismatch = acceptText("create table t (c int GENERATED ALWAYS AS IDENTITY ([)]))");
    const mismatchRefusal = expectRefused(recognizeCreateTableCoreShape(mismatch)).refusal;
    assert.equal(mismatchRefusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(mismatch, mismatchRefusal.span), ")");

    const eof = acceptText("create table t (c int GENERATED BY DEFAULT AS IDENTITY ([x]");
    const eofRefusal = expectRefused(recognizeCreateTableCoreShape(eof)).refusal;
    assert.equal(eofRefusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(eof, eofRefusal.span), "(");
  });

  it("passes protected-token refusals through opaque identity options", () => {
    for (const [tail, refusalId] of [
      ["'open", "unterminated_string"],
      ["E'open", "unterminated_string"],
      ["$tag$open", "unterminated_dollar_quote"],
      ['"open', "unterminated_quoted_identifier"],
      ["/* open", "unterminated_block_comment"],
      ['U&"open"', "unicode_escape_syntax_not_in_profile"],
    ] as const) {
      const refusal = expectRefused(
        recognizeText(`create table t (c int GENERATED ALWAYS AS IDENTITY (${tail}`),
      ).refusal;
      assert.equal(refusal.refusalId, refusalId, tail);
    }
  });

  it("conflicts on every repeated mode/options combination at the second GENERATED", () => {
    for (const clauses of [
      "GENERATED ALWAYS AS IDENTITY GENERATED ALWAYS AS IDENTITY",
      "GENERATED ALWAYS AS IDENTITY (start 1) GENERATED BY DEFAULT AS IDENTITY",
      "GENERATED BY DEFAULT AS IDENTITY GENERATED ALWAYS AS IDENTITY (start 2)",
      "GENERATED BY DEFAULT AS IDENTITY (start 1) GENERATED BY DEFAULT AS IDENTITY (start 2)",
    ]) {
      expectIdentityConflict(
        `create table t (c int ${clauses})`,
        ["IDENTITY", "IDENTITY"],
        "GENERATED",
      );
    }
  });

  it("applies NULL, DEFAULT, stored-generation, and serial conflicts", () => {
    for (const testCase of [
      {
        clauses: "NULL GENERATED ALWAYS AS IDENTITY",
        labels: ["NULL", "IDENTITY"],
        anchor: "GENERATED",
      },
      {
        clauses: "GENERATED ALWAYS AS IDENTITY NULL",
        labels: ["IDENTITY", "NULL"],
        anchor: "NULL",
      },
      {
        clauses: "DEFAULT 1 GENERATED ALWAYS AS IDENTITY",
        labels: ["DEFAULT", "IDENTITY"],
        anchor: "GENERATED",
      },
      {
        clauses: "GENERATED ALWAYS AS IDENTITY DEFAULT 1",
        labels: ["IDENTITY", "DEFAULT"],
        anchor: "DEFAULT",
      },
      {
        clauses: "GENERATED ALWAYS AS (1) STORED GENERATED BY DEFAULT AS IDENTITY",
        labels: ["GENERATED STORED", "IDENTITY"],
        anchor: "GENERATED",
      },
      {
        clauses: "GENERATED ALWAYS AS IDENTITY GENERATED ALWAYS AS (1) STORED",
        labels: ["IDENTITY", "GENERATED STORED"],
        anchor: "GENERATED",
      },
    ] as const) {
      expectIdentityConflict(
        `create table t (c int ${testCase.clauses})`,
        testCase.labels,
        testCase.anchor,
      );
    }

    for (const type of ["smallserial", "SeRiAl", "bigserial"]) {
      expectIdentityConflict(
        `create table t (c ${type} GENERATED ALWAYS AS IDENTITY)`,
        ["SERIAL", "IDENTITY"],
        "GENERATED",
      );
    }
  });

  it("preserves structural serial lookalikes", () => {
    for (const type of ['"serial"', "pg.serial", "serial(1)", "serial(1,2)", "serial[]"]) {
      expectRecognized(recognizeText(`create table t (c ${type} GENERATED ALWAYS AS IDENTITY)`));
    }
  });

  it("accepts NOT NULL, PRIMARY KEY, UNIQUE, CHECK, and REFERENCES in both orders", () => {
    for (const clause of [
      "NOT NULL",
      "PRIMARY KEY",
      "UNIQUE",
      "CHECK (c > 0)",
      "REFERENCES parent(id)",
    ]) {
      for (const clauses of [
        `${clause} GENERATED ALWAYS AS IDENTITY`,
        `GENERATED BY DEFAULT AS IDENTITY ${clause}`,
      ]) {
        expectRecognized(recognizeText(`create table t (c int ${clauses})`));
      }
    }

    expectRecognized(
      recognizeText(
        "create table t (c int NOT NULL PRIMARY KEY UNIQUE CHECK (c > 0) REFERENCES parent(id) GENERATED ALWAYS AS IDENTITY)",
      ),
    );
  });

  it("keeps GENERATED and IDENTITY contextual, unquoted, and outside named wrappers", () => {
    const control = expectRecognized(
      recognizeText(
        'create table identity (generated identity, identity generated.int, c identity GENERATED ALWAYS AS IDENTITY, "IDENTITY" int)',
      ),
    ).coreShape;
    assert.deepEqual(
      control.derived.columns.map((column) => column.name.identity),
      ["generated", "identity", "c", "IDENTITY"],
    );

    expectBoundary("create table t (c int CONSTRAINT n GENERATED ALWAYS AS IDENTITY)", "GENERATED");
    expectBoundary('create table t (c int GENERATED ALWAYS AS "IDENTITY")', '"IDENTITY"');
  });

  it("defers identity conflicts until later grammar, lexical, and structural defects are consumed", () => {
    const lexical = expectRefused(
      recognizeText(
        "create table t (c int GENERATED ALWAYS AS IDENTITY GENERATED BY DEFAULT AS IDENTITY E'open",
      ),
    ).refusal;
    assert.equal(lexical.refusalId, "unterminated_string");

    expectBoundary(
      "create table t (c int GENERATED ALWAYS AS IDENTITY DEFAULT 1 VIRTUAL E'open",
      "VIRTUAL",
    );

    const structural = acceptText(
      "create table t (c int GENERATED ALWAYS AS IDENTITY DEFAULT 1 CHECK ([)]))",
    );
    const refusal = expectRefused(recognizeCreateTableCoreShape(structural)).refusal;
    assert.equal(refusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(structural, refusal.span), ")");
  });

  it("uses category rank 8 when same-location identity conflicts compete", () => {
    expectIdentityConflict(
      "create table t (c int NULL DEFAULT 1 GENERATED ALWAYS AS IDENTITY)",
      ["NULL", "IDENTITY"],
      "GENERATED",
    );

    expectIdentityConflict(
      "create table t (c int DEFAULT 1 GENERATED ALWAYS AS IDENTITY NULL)",
      ["DEFAULT", "IDENTITY"],
      "GENERATED",
    );
  });

  it("traverses deep and near-cap identity options iteratively and deterministically", () => {
    const depth = 10_000;
    const deepOptions = `${"([".repeat(depth)}x${"])".repeat(depth)}`;
    const deepText = `create table t (c int GENERATED ALWAYS AS IDENTITY (${deepOptions}))`;
    const deepFirst = recognizeText(deepText);
    assert.deepEqual(recognizeText(deepText), deepFirst);
    expectRecognized(deepFirst);

    const prefix = "create table t (c int GENERATED BY DEFAULT AS IDENTITY (";
    const suffix = "))";
    const repeats = Math.floor((MAX_RAW_INPUT_BYTES - prefix.length - suffix.length) / 2);
    const nearCapText = `${prefix}${"x ".repeat(repeats)}${suffix}`;
    const nearCapInput = acceptText(nearCapText);
    assert.equal(MAX_RAW_INPUT_BYTES - nearCapInput.rawBytes.byteLength < 2, true);

    const first = recognizeCreateTableCoreShape(nearCapInput);
    assert.deepEqual(recognizeCreateTableCoreShape(nearCapInput), first);
    const occurrence = expectIdentityOccurrence(first);
    assert.equal(
      spanText(nearCapInput, occurrence.optionsSpan ?? assert.fail("missing options")).startsWith(
        "(x x ",
      ),
      true,
    );
  });

  it("keeps many independent identity columns linear through the shared selector", () => {
    const columns = Array.from(
      { length: 3_500 },
      (_, ordinal) => `c${ordinal.toString().padStart(4, "0")} int GENERATED ALWAYS AS IDENTITY`,
    );
    const sourceText = `create table t (${columns.join(",")})`;
    assert.equal(encoder.encode(sourceText).byteLength < MAX_RAW_INPUT_BYTES, true);

    const first = recognizeText(sourceText);
    assert.deepEqual(recognizeText(sourceText), first);
    const shape = expectRecognized(first).coreShape;
    assert.equal(shape.derived.columns.length, columns.length);
    assert.equal(shape.derived.columns.at(-1)?.clauseOccurrences[0]?.kind, "identity");
  });
});
