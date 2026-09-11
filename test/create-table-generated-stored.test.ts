import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  recognizeCreateTableCoreShape,
  type CreateTableCoreShapeResult,
} from "../src/create-table-core-shape.js";
import type { SourceSpan } from "../src/create-table-token-source.js";
import {
  applyRawInputProfile,
  MAX_RAW_INPUT_BYTES,
  type AcceptedRawInput,
} from "../src/input-profile.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

type RecognizedResult = Extract<CreateTableCoreShapeResult, { kind: "recognized_core_shape" }>;
type RefusedResult = Extract<CreateTableCoreShapeResult, { kind: "refused" }>;

function acceptText(sourceText: string, withBom = false): AcceptedRawInput {
  const source = encoder.encode(sourceText);
  const bytes = withBom ? Uint8Array.from([...UTF8_BOM, ...source]) : source;
  const result = applyRawInputProfile(bytes);
  if (result.kind !== "accepted") {
    assert.fail(`Expected accepted input, received ${result.refusalId}`);
  }
  return result;
}

function recognizeText(sourceText: string): CreateTableCoreShapeResult {
  return recognizeCreateTableCoreShape(acceptText(sourceText));
}

function expectRecognized(result: CreateTableCoreShapeResult): RecognizedResult {
  if (result.kind !== "recognized_core_shape") {
    assert.fail(`Expected recognized core shape, received ${result.kind}`);
  }
  return result;
}

function expectRefused(result: CreateTableCoreShapeResult): RefusedResult {
  if (result.kind !== "refused") {
    assert.fail(`Expected refusal, received ${result.kind}`);
  }
  return result;
}

function spanText(input: AcceptedRawInput, span: SourceSpan): string {
  return decoder.decode(input.rawBytes.subarray(span.start.rawByteOffset, span.end.rawByteOffset));
}

function expectBoundary(sourceText: string, expected: string): void {
  const input = acceptText(sourceText);
  const result = recognizeCreateTableCoreShape(input);
  if (result.kind !== "not_recognized_by_create_table_grammar") {
    assert.fail(`Expected CREATE TABLE grammar miss for ${sourceText}, received ${result.kind}`);
  }
  if (result.boundary.kind !== "unexpected_token") {
    assert.fail(`Expected token boundary for ${sourceText}, received EOF`);
  }
  assert.equal(spanText(input, result.boundary.span), expected, sourceText);
}

function generatedOccurrence(sourceText: string) {
  const input = acceptText(sourceText);
  const column = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape.derived
    .columns[0];
  const occurrence = column?.clauseOccurrences.find(
    (candidate) => candidate.kind === "generated_stored",
  );
  if (occurrence?.kind !== "generated_stored") {
    assert.fail("Expected a stored-generated occurrence");
  }
  return { input, column, occurrence };
}

describe("CREATE TABLE stored-generated column recognition", () => {
  it("retains the canonical occurrence and every exact span across BOM, CRLF, and Unicode", () => {
    const sourceText = [
      'CrEaTe TABLE "表" (',
      '  "é" int GeNeRaTeD/*g*/AlWaYs\tAS ("😀" || lower("é")) StOrEd',
      ")",
    ].join("\r\n");
    const input = acceptText(sourceText, true);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    const occurrence = shape.derived.columns[0]?.clauseOccurrences[0];
    if (occurrence?.kind !== "generated_stored") {
      assert.fail("Expected stored-generated evidence");
    }

    assert.deepEqual(
      shape.derived.columns[0]?.clauseOccurrences.map(({ kind }) => kind),
      ["generated_stored"],
    );
    assert.equal(spanText(input, occurrence.keywordSpan), "GeNeRaTeD");
    assert.equal(spanText(input, occurrence.generatedKeywordSpan), "GeNeRaTeD");
    assert.equal(spanText(input, occurrence.alwaysKeywordSpan), "AlWaYs");
    assert.equal(spanText(input, occurrence.asKeywordSpan), "AS");
    assert.equal(spanText(input, occurrence.expressionSpan), '("😀" || lower("é"))');
    assert.equal(spanText(input, occurrence.storedKeywordSpan), "StOrEd");
    assert.equal(
      spanText(input, occurrence.clauseSpan),
      'GeNeRaTeD/*g*/AlWaYs\tAS ("😀" || lower("é")) StOrEd',
    );
    assert.deepEqual(occurrence.underlyingClauseSpan, occurrence.clauseSpan);
    assert.deepEqual(occurrence.establishmentSpan, occurrence.generatedKeywordSpan);
    assert.equal(occurrence.explicitConstraintName, null);
    assert.equal(occurrence.generatedKeywordSpan.start.line, 2);
    assert.equal(occurrence.generatedKeywordSpan.start.column, 11);
    assert.equal(occurrence.generatedKeywordSpan.start.rawByteOffset, 36);
    assert.equal(
      shape.derived.columns[0]?.span.end.rawByteOffset,
      occurrence.storedKeywordSpan.end.rawByteOffset,
    );
  });

  it("keeps protected content and typed nesting opaque and leaves following clauses caller-owned", () => {
    const expression = `([lower(')] GENERATED STORED'), E'\\')', $tag$)] ; GENERATED STORED$tag$, $12])`;
    const sourceText = `create table t (c int GENERATED ALWAYS AS (${expression}) STORED NOT NULL UNIQUE)`;
    const { input, column, occurrence } = generatedOccurrence(sourceText);

    assert.equal(spanText(input, occurrence.expressionSpan), `(${expression})`);
    assert.deepEqual(
      column?.clauseOccurrences.map(({ kind }) => kind),
      ["generated_stored", "not_null", "unique"],
    );
  });

  it("recognizes generated clauses independently across multiple columns", () => {
    const shape = expectRecognized(
      recognizeText(
        "create table t (a int GENERATED ALWAYS AS (1) STORED, b text, c int GENERATED ALWAYS AS (a + 1) STORED)",
      ),
    ).coreShape;

    assert.deepEqual(
      shape.derived.columns.map((column) => [
        column.name.identity,
        column.clauseOccurrences.map(({ kind }) => kind),
      ]),
      [
        ["a", ["generated_stored"]],
        ["b", []],
        ["c", ["generated_stored"]],
      ],
    );
  });

  it("requires the complete selected prefix and a nonempty parenthesized expression", () => {
    for (const [clause, boundary] of [
      ["GENERATED)", ")"],
      ["GENERATED WRONG E'open", "WRONG"],
      ["GENERATED ALWAYS)", ")"],
      ["GENERATED ALWAYS WRONG E'open", "WRONG"],
      ["GENERATED ALWAYS AS)", ")"],
      ["GENERATED ALWAYS AS WRONG E'open", "WRONG"],
      ["GENERATED ALWAYS AS () STORED)", ")"],
      ["GENERATED ALWAYS AS (1))", ")"],
      ["GENERATED ALWAYS AS (1) VIRTUAL E'open", "VIRTUAL"],
    ] as const) {
      expectBoundary(`create table t (c int ${clause}`, boundary);
    }
  });

  it("stays committed to stored generation after ALWAYS AS selects a parenthesized expression", () => {
    for (const [clause, boundary] of [
      ["GENERATED ALWAYS AS (1) IDENTITY E'open", "IDENTITY"],
      ["GENERATED ALWAYS AS (1) DEFAULT E'open", "DEFAULT"],
      ["GENERATED ALWAYS AS (1) VIRTUAL E'open", "VIRTUAL"],
    ] as const) {
      expectBoundary(`create table t (c int ${clause}`, boundary);
    }
  });

  it("preserves structural and protected-token refusals inside the committed expression", () => {
    const mismatch = acceptText("create table t (c int GENERATED ALWAYS AS ([)] STORED)");
    const mismatchRefusal = expectRefused(recognizeCreateTableCoreShape(mismatch)).refusal;
    assert.equal(mismatchRefusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(mismatch, mismatchRefusal.span), ")");

    const eof = acceptText("create table t (c int GENERATED ALWAYS AS ([x]");
    const eofRefusal = expectRefused(recognizeCreateTableCoreShape(eof)).refusal;
    assert.equal(eofRefusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(eof, eofRefusal.span), "(");
    assert.equal(eofRefusal.span.start.rawByteOffset, eof.rawBytes.lastIndexOf("(".charCodeAt(0)));

    for (const [tail, refusalId] of [
      ["'open", "unterminated_string"],
      ["E'open", "unterminated_string"],
      ["$tag$open", "unterminated_dollar_quote"],
      ['"open', "unterminated_quoted_identifier"],
      ["/* open", "unterminated_block_comment"],
    ] as const) {
      const result = expectRefused(
        recognizeText(`create table t (c int GENERATED ALWAYS AS (${tail}`),
      );
      assert.equal(result.refusal.refusalId, refusalId, tail);
    }
  });

  it("applies repetition and DEFAULT conflicts in source order at the later keyword", () => {
    for (const testCase of [
      {
        clauses: "GENERATED ALWAYS AS (1) STORED GENERATED ALWAYS AS (2) STORED",
        labels: ["GENERATED STORED", "GENERATED STORED"],
        anchor: "GENERATED",
      },
      {
        clauses: "DEFAULT 1 GENERATED ALWAYS AS (2) STORED",
        labels: ["DEFAULT", "GENERATED STORED"],
        anchor: "GENERATED",
      },
      {
        clauses: "GENERATED ALWAYS AS (1) STORED DEFAULT 2",
        labels: ["GENERATED STORED", "DEFAULT"],
        anchor: "DEFAULT",
      },
    ]) {
      const sourceText = `create table t (c int ${testCase.clauses})`;
      const input = acceptText(sourceText);
      const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
      assert.equal(refusal.refusalId, "conflicting_column_declaration");
      if (refusal.refusalId !== "conflicting_column_declaration") {
        assert.fail("Expected column conflict");
      }
      assert.deepEqual(refusal.clauseLabels, testCase.labels, testCase.clauses);
      assert.equal(spanText(input, refusal.span), testCase.anchor, testCase.clauses);
      assert.equal(refusal.span.start.rawByteOffset, sourceText.lastIndexOf(testCase.anchor));
    }
  });

  it("conflicts with exact serial shorthand while preserving every structural lookalike", () => {
    for (const type of ["smallserial", "SeRiAl", "bigserial"]) {
      const sourceText = `create table t (c ${type} GENERATED ALWAYS AS (1) STORED)`;
      const input = acceptText(sourceText);
      const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
      assert.equal(refusal.refusalId, "conflicting_column_declaration", type);
      if (refusal.refusalId !== "conflicting_column_declaration") {
        assert.fail("Expected serial conflict");
      }
      assert.deepEqual(refusal.clauseLabels, ["SERIAL", "GENERATED STORED"], type);
      assert.equal(spanText(input, refusal.span), "GENERATED", type);
    }

    for (const type of ['"serial"', "pg.serial", "serial(1)", "serial(1,2)", "serial[]"]) {
      expectRecognized(recognizeText(`create table t (c ${type} GENERATED ALWAYS AS (1) STORED)`));
    }
  });

  it("accepts every currently recognized non-conflicting column clause", () => {
    for (const clause of [
      "NULL",
      "NOT NULL",
      "PRIMARY KEY",
      "UNIQUE",
      "CHECK (c > 0)",
      "REFERENCES parent(id)",
    ]) {
      for (const clauses of [
        `${clause} GENERATED ALWAYS AS (1) STORED`,
        `GENERATED ALWAYS AS (1) STORED ${clause}`,
      ]) {
        expectRecognized(recognizeText(`create table t (c int ${clauses})`));
      }
    }

    expectRecognized(
      recognizeText(
        "create table t (c int NOT NULL PRIMARY KEY UNIQUE CHECK (c > 0) REFERENCES parent(id) GENERATED ALWAYS AS (1) STORED)",
      ),
    );
  });

  it("keeps generated contextual and outside the explicit-name wrapper grammar", () => {
    const control = expectRecognized(
      recognizeText(
        'create table generated (generated int, c generated.int GENERATED ALWAYS AS (1) STORED, "GENERATED" int)',
      ),
    ).coreShape;
    assert.deepEqual(
      control.derived.columns.map((column) => column.name.identity),
      ["generated", "c", "GENERATED"],
    );
    assert.equal(control.derived.columns[1]?.type.name.qualifier?.identity, "generated");

    expectBoundary("create table t (c int CONSTRAINT n GENERATED E'open", "GENERATED");
    expectBoundary('create table t (c int "GENERATED")', '"GENERATED"');
  });

  it("defers semantic candidates until complete grammar and lexical consumption", () => {
    const lexical = expectRefused(
      recognizeText(
        "create table t (c int GENERATED ALWAYS AS (1) STORED GENERATED ALWAYS AS (2) STORED E'open",
      ),
    );
    assert.equal(lexical.refusal.refusalId, "unterminated_string");

    expectBoundary(
      "create table t (c int GENERATED ALWAYS AS (1) STORED DEFAULT 2 VIRTUAL E'open",
      "VIRTUAL",
    );

    const input = acceptText(
      "create table t (c int GENERATED ALWAYS AS (1) STORED DEFAULT 2 CHECK ([)])",
    );
    const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
    assert.equal(refusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(input, refusal.span), ")");
  });

  it("traverses deep and near-cap stored expressions iteratively and deterministically", () => {
    const depth = 10_000;
    const deepExpression = `${"([".repeat(depth)}x${"])".repeat(depth)}`;
    const deepText = `create table t (c int GENERATED ALWAYS AS (${deepExpression}) STORED)`;
    const deepFirst = recognizeText(deepText);
    assert.deepEqual(recognizeText(deepText), deepFirst);
    expectRecognized(deepFirst);

    const prefix = "create table t (c int GENERATED ALWAYS AS (";
    const suffix = ") STORED)";
    const repeats = Math.floor((MAX_RAW_INPUT_BYTES - prefix.length - suffix.length) / 2);
    const nearCapText = `${prefix}${"x ".repeat(repeats)}${suffix}`;
    const nearCapInput = acceptText(nearCapText);
    assert.equal(MAX_RAW_INPUT_BYTES - nearCapInput.rawBytes.byteLength < 2, true);

    const first = recognizeCreateTableCoreShape(nearCapInput);
    assert.deepEqual(recognizeCreateTableCoreShape(nearCapInput), first);
    const occurrence = expectRecognized(first).coreShape.derived.columns[0]?.clauseOccurrences[0];
    assert.equal(occurrence?.kind, "generated_stored");
    if (occurrence?.kind === "generated_stored") {
      assert.equal(spanText(nearCapInput, occurrence.expressionSpan).startsWith("(x x "), true);
      assert.equal(spanText(nearCapInput, occurrence.expressionSpan).endsWith("x )"), true);
    }
  });
});
