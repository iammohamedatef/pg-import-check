import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recognizeCreateTableCoreShape } from "../src/create-table-core-shape.js";
import { applyRawInputProfile } from "../src/input-profile.js";
import {
  UTF8_BOM,
  acceptText,
  concatenate,
  expectAccepted,
  expectAmbiguous,
  expectConflict,
  expectRecognized,
  expectRefused,
  expectUnbalanced,
  expectUnexpectedToken,
  recognizeText,
  spanText,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();
describe("recognizeCreateTableCoreShape", () => {
  it("retains source-ordered bare key occurrences with exact BOM, CRLF, and scalar spans", () => {
    const sourceText = ['CREATE TABLE "表" (', '  "é" int UnIqUe PRIMARY/* key */KEY', ")"].join(
      "\r\n",
    );
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const column = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape.derived
      .columns[0];
    const occurrences = column?.clauseOccurrences ?? assert.fail("missing key occurrences");

    assert.deepEqual(
      occurrences.map((occurrence) => ({
        kind: occurrence.kind,
        keyword: spanText(input, occurrence.keywordSpan),
        clause: spanText(input, occurrence.clauseSpan),
      })),
      [
        { kind: "unique", keyword: "UnIqUe", clause: "UnIqUe" },
        {
          kind: "primary_key",
          keyword: "PRIMARY",
          clause: "PRIMARY/* key */KEY",
        },
      ],
    );

    const primaryKey = occurrences[1] ?? assert.fail("missing PRIMARY KEY");
    const primaryOffset = sourceText.indexOf("PRIMARY");
    assert.deepEqual(primaryKey.keywordSpan, {
      start: {
        rawByteOffset:
          UTF8_BOM.byteLength + encoder.encode(sourceText.slice(0, primaryOffset)).byteLength,
        line: 2,
        column: 18,
      },
      end: {
        rawByteOffset:
          UTF8_BOM.byteLength +
          encoder.encode(sourceText.slice(0, primaryOffset + "PRIMARY".length)).byteLength,
        line: 2,
        column: 25,
      },
    });
    assert.equal(
      spanText(input, column?.span ?? assert.fail()),
      '"é" int UnIqUe PRIMARY/* key */KEY',
    );

    const reverse = expectRecognized(recognizeText("create table t (c int PRIMARY KEY UNIQUE)"))
      .coreShape.derived.columns[0];
    assert.deepEqual(
      reverse?.clauseOccurrences.map(({ kind }) => kind),
      ["primary_key", "unique"],
    );
  });
  it("retains ordered table-key evidence and resolves forward references after parsing", () => {
    const sourceText = [
      'CREATE TABLE "表" (',
      '  PRIMARY/* key */KEY ("é", A),',
      "  a int,",
      '  "é" text,',
      '  UnIqUe (A, "é")',
      ")",
    ].join("\r\n");
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));

    assert.deepEqual(
      coreShape.derived.tableKeyConstraints.map((constraint) => ({
        kind: constraint.kind,
        keyword: spanText(input, constraint.keywordSpan),
        clause: spanText(input, constraint.clauseSpan),
        references: constraint.columnReferences.map((reference) => ({
          identity: reference.identity,
          quoted: reference.quoted,
          source: spanText(input, reference.span),
        })),
      })),
      [
        {
          kind: "primary_key",
          keyword: "PRIMARY",
          clause: 'PRIMARY/* key */KEY ("é", A)',
          references: [
            { identity: "é", quoted: true, source: '"é"' },
            { identity: "a", quoted: false, source: "A" },
          ],
        },
        {
          kind: "unique",
          keyword: "UnIqUe",
          clause: 'UnIqUe (A, "é")',
          references: [
            { identity: "a", quoted: false, source: "A" },
            { identity: "é", quoted: true, source: '"é"' },
          ],
        },
      ],
    );
    assert.deepEqual(
      coreShape.derived.columns.map((column) => column.name.identity),
      ["a", "é"],
    );
    assert.equal(coreShape.derived.tableKeyConstraints[0]?.keywordSpan.start.line, 2);
    assert.equal(coreShape.derived.tableKeyConstraints[0]?.keywordSpan.start.column, 3);
  });
  it("keeps malformed table-key lists under lexical, structural, and grammar ownership", () => {
    const grammarCases = [
      { sourceText: "create table t (a int, primary key ())", boundary: ")" },
      { sourceText: "create table t (a int, unique (,a))", boundary: "," },
      { sourceText: "create table t (a int, unique (a,))", boundary: ")" },
      { sourceText: "create table t (a int, primary wrong E'open", boundary: "wrong" },
      { sourceText: "create table t (a int, unique (a) with (x=1))", boundary: "with" },
      { sourceText: "create table t (a int, unique (a) nulls distinct)", boundary: "nulls" },
    ];
    for (const testCase of grammarCases) {
      const input = acceptText(testCase.sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.sourceText,
      );
    }

    for (const sourceText of [
      "create table t (a int, primary 'unterminated",
      'create table t (a int, unique ("unterminated',
    ]) {
      const refusal = expectRefused(recognizeText(sourceText)).refusal;
      assert.equal(
        refusal.refusalId,
        sourceText.includes('"') ? "unterminated_quoted_identifier" : "unterminated_string",
      );
    }

    const mismatch = acceptText("create table t (a int, unique (a])");
    assert.equal(
      spanText(mismatch, expectUnbalanced(recognizeCreateTableCoreShape(mismatch))),
      "]",
    );
    const outstanding = acceptText("create table t (a int, primary key (a");
    assert.equal(
      spanText(outstanding, expectUnbalanced(recognizeCreateTableCoreShape(outstanding))),
      "(",
    );
  });
  it("refuses repeated and absent table-key members at the exact declaration keyword", () => {
    for (const testCase of [
      { sourceText: "create table t (a int, unique (a, A))", keyword: "unique" },
      { sourceText: 'create table t (a int, primary key (a, "a"))', keyword: "primary" },
      {
        sourceText: "create table t (primary key (later, missing), later int)",
        keyword: "primary",
      },
    ]) {
      const input = acceptText(testCase.sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span).toLowerCase(), testCase.keyword);
      assert.equal(refusal.span.start.rawByteOffset, testCase.sourceText.indexOf(testCase.keyword));
    }

    expectRecognized(recognizeText("create table t (unique (later), later int)"));
  });
  it("does not associate table-key members arbitrarily across duplicate target identities", () => {
    for (const sourceText of [
      "create table t (primary key (a), a int null, a text)",
      "create table t (a int null, a text, primary key (a))",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span), "a", sourceText);
      assert.equal(refusal.span.start.rawByteOffset, sourceText.indexOf("a text"), sourceText);
    }
  });
  it("unifies inline and table UNIQUE declarations by unordered normalized member set", () => {
    for (const sourceText of [
      "create table t (a int unique, unique (a))",
      "create table t (unique (a), a int unique)",
      "create table t (a int, b int, unique (a,b), unique (b,a))",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      const firstUnique = sourceText.toLowerCase().indexOf("unique");
      const secondUnique = sourceText.toLowerCase().indexOf("unique", firstUnique + 1);
      assert.equal(refusal.span.start.rawByteOffset, secondUnique, sourceText);
      assert.equal(spanText(input, refusal.span).toLowerCase(), "unique", sourceText);
    }

    expectRecognized(recognizeText("create table t (a int, b int, unique (a,b), unique (a))"));
    expectRecognized(recognizeText('create table t (a int, "A" int, unique (a), unique ("A"))'));
    expectRecognized(
      recognizeText('create table t ("é" int, "é" int, unique ("é"), unique ("é"))'),
    );
  });
  it("keeps the multiple-primary-key rule independent of modeled member-set equality", () => {
    for (const sourceText of [
      "create table t (a int primary key, primary key (a))",
      "create table t (primary key (a), a int primary key)",
      "create table t (a int, b int, primary key (a), primary key (b))",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      const firstPrimary = sourceText.toLowerCase().indexOf("primary");
      const secondPrimary = sourceText.toLowerCase().indexOf("primary", firstPrimary + 1);
      assert.equal(refusal.span.start.rawByteOffset, secondPrimary, sourceText);
      assert.equal(spanText(input, refusal.span).toLowerCase(), "primary", sourceText);
    }
  });
  it("keeps explicit names independent from key identity and unresolved association", () => {
    for (const sourceText of [
      "create table t (a int constraint first unique, constraint second unique (a))",
      "create table t (a int constraint first primary key, constraint second primary key (a))",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span).toLowerCase(), "constraint");
      assert.equal(
        refusal.span.start.rawByteOffset,
        sourceText.toLowerCase().lastIndexOf("constraint"),
      );
    }

    for (const sourceText of [
      "create table t (a int constraint dup null, constraint DUP unique (missing))",
      "create table t (a int constraint dup check (true), constraint DUP unique (a,a))",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span).toLowerCase(), "constraint", sourceText);
      assert.equal(
        refusal.span.start.rawByteOffset,
        sourceText.toLowerCase().lastIndexOf("constraint"),
        sourceText,
      );
    }

    const duplicateTargetText =
      "create table t (a int, a text constraint dup unique, constraint DUP unique (a))";
    const duplicateTargetInput = acceptText(duplicateTargetText);
    const duplicateTarget = expectAmbiguous(recognizeCreateTableCoreShape(duplicateTargetInput));
    assert.equal(spanText(duplicateTargetInput, duplicateTarget.span), "a");
    assert.equal(duplicateTarget.span.start.rawByteOffset, duplicateTargetText.indexOf("a text"));

    for (const sourceText of [
      "create table t (a int constraint nullable null, constraint pk primary key (a))",
      "create table t (constraint pk primary key (a), a int constraint nullable null)",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectConflict(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span).toLowerCase(), "constraint", sourceText);
    }

    for (const sourceText of [
      "create table t (a int constraint first check (true) constraint second check (false))",
      "create table t (a int constraint first null constraint second not null)",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectConflict(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span).toLowerCase(), "constraint", sourceText);
      assert.equal(
        refusal.span.start.rawByteOffset,
        sourceText.toLowerCase().lastIndexOf("constraint"),
        sourceText,
      );
    }

    for (const sourceText of [
      "create table t (a int, constraint one unique (missing))",
      "create table t (a int, constraint one unique (a,a))",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectAmbiguous(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusal.span).toLowerCase(), "unique", sourceText);
    }
  });
  it("keeps quoted contexts, wrappers, key options, and inexact PRIMARY forms outside dispatch", () => {
    const quoted = expectRecognized(
      recognizeText(
        'create table t ("PRIMARY" primary.int UNIQUE, "UNIQUE" unique.int PRIMARY KEY)',
      ),
    ).coreShape;
    assert.deepEqual(
      quoted.derived.columns.map((column) => [
        column.name.identity,
        column.type.name.qualifier?.identity,
      ]),
      [
        ["PRIMARY", "primary"],
        ["UNIQUE", "unique"],
      ],
    );

    const missCases = [
      { clause: "PRIMARY)", boundary: ")" },
      { clause: "PRIMARY NULL)", boundary: "NULL" },
      { clause: "PRIMARY KEYS)", boundary: "KEYS" },
      { clause: 'PRIMARY "KEY")', boundary: '"KEY"' },
      { clause: '"PRIMARY")', boundary: '"PRIMARY"' },
      { clause: '"UNIQUE")', boundary: '"UNIQUE"' },
      { clause: "PRIMARY KEY (c))", boundary: "(" },
      { clause: "PRIMARY KEY WITH (fillfactor = 70))", boundary: "WITH" },
      { clause: "UNIQUE (c))", boundary: "(" },
      { clause: "UNIQUE NULLS NOT DISTINCT)", boundary: "NULLS" },
    ];

    for (const testCase of missCases) {
      const input = acceptText(`create table t (c int ${testCase.clause}`);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.clause,
      );
    }

    const columns = expectRecognized(
      recognizeText("create table t (a int UNIQUE, b int PRIMARY KEY, c int UNIQUE)"),
    ).coreShape.derived.columns;
    assert.deepEqual(
      columns.map((column) => column.clauseOccurrences.map(({ kind }) => kind)),
      [["unique"], ["primary_key"], ["unique"]],
    );
  });
});
