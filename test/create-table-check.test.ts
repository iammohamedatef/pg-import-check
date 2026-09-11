import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recognizeCreateTableCoreShape } from "../src/create-table-core-shape.js";
import type { LexicalRefusal } from "../src/create-table-token-source.js";
import { applyRawInputProfile } from "../src/input-profile.js";
import {
  UTF8_BOM,
  acceptText,
  columnExpressionSpan,
  concatenate,
  expectAccepted,
  expectRecognized,
  expectRefused,
  expectUnbalanced,
  expectUnexpectedToken,
  firstLexicalRefusal,
  recognizeText,
  spanText,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();
describe("recognizeCreateTableCoreShape", () => {
  it("retains one inline CHECK span while treating protected tokens atomically", () => {
    const expression = [
      "(",
      "')](' E'\\\\)]' \"quoted;)]\" ",
      '$tag$); U&"name"; USING WITH ON TABLESPACE [$tag$ ',
      "/* ([;)] */ -- ([;)]\r\n",
      "$1 ([value; other])",
      ")",
    ].join("");
    const sourceText = `create table t (c int CHECK ${expression}, d text)`;
    const input = acceptText(sourceText);
    const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));
    const checkedColumn = coreShape.derived.columns[0] ?? assert.fail("missing checked column");

    assert.equal(
      spanText(input, columnExpressionSpan(checkedColumn, "check") ?? assert.fail()),
      expression,
    );
    assert.equal(spanText(input, checkedColumn.span), `c int CHECK ${expression}`);
    assert.equal(columnExpressionSpan(coreShape.derived.columns[1], "check"), null);
    assert.equal(coreShape.partitionByClause, null);
  });
  it("keeps CHECK nonempty, bounded, and lazy after its matching parenthesis", () => {
    for (const sourceText of [
      "create table t (c int CHECK ())",
      "create table t (c int CHECK ( /* only */ -- trivia\r\n ))",
    ]) {
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        ")",
        sourceText,
      );
    }

    const demandedDefault = expectRefused(
      recognizeText("create table t (c int CHECK (true) DEFAULT 'unterminated)"),
    );
    assert.equal(demandedDefault.refusal.refusalId, "unterminated_string");

    const repeatedCheck = expectRefused(
      recognizeText("create table t (c int CHECK (true) CHECK ('unterminated)"),
    );
    assert.equal(repeatedCheck.refusal.refusalId, "unterminated_string");

    const twoColumns = expectRecognized(
      recognizeText("create table t (c int CHECK ((left; right)[1]), d text)"),
    ).coreShape;
    assert.deepEqual(
      twoColumns.derived.columns.map((column) => column.name.identity),
      ["c", "d"],
    );
  });
  it("passes demanded protected-token refusals through an outstanding CHECK stack", () => {
    const cases: Array<{
      sourceText: string;
      refusalId: LexicalRefusal["refusalId"];
      opening: string;
    }> = [
      {
        sourceText: "create table t (c int CHECK ([ 'open",
        refusalId: "unterminated_string",
        opening: "'",
      },
      {
        sourceText: "create table t (c int CHECK ([ E'open",
        refusalId: "unterminated_string",
        opening: "E'",
      },
      {
        sourceText: "create table t (c int CHECK ([ $tag$open",
        refusalId: "unterminated_dollar_quote",
        opening: "$tag$",
      },
      {
        sourceText: 'create table t (c int CHECK ([ "open',
        refusalId: "unterminated_quoted_identifier",
        opening: '"',
      },
      {
        sourceText: "create table t (c int CHECK ([ /* open",
        refusalId: "unterminated_block_comment",
        opening: "/*",
      },
      {
        sourceText: 'create table t (c int CHECK (U&"name"))',
        refusalId: "unicode_escape_syntax_not_in_profile",
        opening: "U",
      },
    ];

    for (const testCase of cases) {
      const input = acceptText(testCase.sourceText);
      const { refusal } = expectRefused(recognizeCreateTableCoreShape(input));
      assert.equal(refusal.refusalId, testCase.refusalId, testCase.sourceText);
      assert.equal(
        refusal.span.start.rawByteOffset,
        testCase.sourceText.lastIndexOf(testCase.opening),
      );
    }

    const mismatchFirst = acceptText("create table t (c int CHECK ([) 'unterminated");
    assert.equal(
      spanText(mismatchFirst, expectUnbalanced(recognizeCreateTableCoreShape(mismatchFirst))),
      ")",
    );
  });
  it("retains every bare and named table CHECK around columns and keys without comparison", () => {
    const sourceText = [
      "create table t (",
      "  CHECK (true),",
      "  a int CHECK (a > 0) PRIMARY KEY,",
      "  CHECK (true),",
      "  UNIQUE (b),",
      "  b text,",
      "  CONSTRAINT guard CHECK (a > 0),",
      "  CHECK (false)",
      ")",
    ].join("\r\n");
    const input = acceptText(sourceText);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;

    assert.deepEqual(
      shape.derived.columns.map((column) => column.name.identity),
      ["a", "b"],
    );
    assert.deepEqual(
      shape.derived.tableKeyConstraints.map((constraint) => constraint.kind),
      ["unique"],
    );
    assert.deepEqual(
      shape.derived.columns[0]?.clauseOccurrences.map((occurrence) => occurrence.kind),
      ["check", "primary_key"],
    );
    assert.equal(
      spanText(input, columnExpressionSpan(shape.derived.columns[0], "check") ?? assert.fail()),
      "(a > 0)",
    );

    assert.deepEqual(
      shape.derived.tableCheckConstraints.map((constraint) => ({
        kind: constraint.kind,
        expression: spanText(input, constraint.expressionSpan),
        clause: spanText(input, constraint.clauseSpan),
        named: constraint.explicitConstraintName?.name.identity ?? null,
      })),
      [
        { kind: "check", expression: "(true)", clause: "CHECK (true)", named: null },
        { kind: "check", expression: "(true)", clause: "CHECK (true)", named: null },
        {
          kind: "check",
          expression: "(a > 0)",
          clause: "CONSTRAINT guard CHECK (a > 0)",
          named: "guard",
        },
        { kind: "check", expression: "(false)", clause: "CHECK (false)", named: null },
      ],
    );
    assert.equal(
      (shape.derived.tableCheckConstraints[0]?.keywordSpan.start.rawByteOffset ?? assert.fail()) <
        (shape.derived.columns[0]?.span.start.rawByteOffset ?? assert.fail()),
      true,
    );
    assert.equal(
      (shape.derived.tableCheckConstraints[1]?.keywordSpan.start.rawByteOffset ?? assert.fail()) <
        (shape.derived.columns[1]?.span.start.rawByteOffset ?? assert.fail()),
      true,
    );
    assert.deepEqual(
      shape.derived.explicitConstraintNames.map((occurrence) => ({
        scope: occurrence.scope,
        kind: occurrence.kind,
        name: occurrence.name.identity,
        targetColumnOrdinal: occurrence.targetColumnOrdinal,
      })),
      [{ scope: "table", kind: "check", name: "guard", targetColumnOrdinal: null }],
    );
  });
  it("retains exact table CHECK spans across a BOM, CRLF, and multibyte scalars", () => {
    const sourceText = [
      'CREATE TABLE "表" (',
      '  "é" int CHECK ("é" <> 0),',
      '  CONSTRAINT "名" CHECK (("😀", "é"))',
      ")",
    ].join("\r\n");
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    const tableCheck = shape.derived.tableCheckConstraints[0] ?? assert.fail("missing table CHECK");

    const constraintKeywordSpan = {
      start: { rawByteOffset: 58, line: 3, column: 3 },
      end: { rawByteOffset: 68, line: 3, column: 13 },
    };
    const nameSpan = {
      start: { rawByteOffset: 69, line: 3, column: 14 },
      end: { rawByteOffset: 74, line: 3, column: 17 },
    };
    const wrapperSpan = {
      start: constraintKeywordSpan.start,
      end: nameSpan.end,
    };
    const keywordSpan = {
      start: { rawByteOffset: 75, line: 3, column: 18 },
      end: { rawByteOffset: 80, line: 3, column: 23 },
    };
    const expressionSpan = {
      start: { rawByteOffset: 81, line: 3, column: 24 },
      end: { rawByteOffset: 97, line: 3, column: 36 },
    };
    const underlyingClauseSpan = {
      start: keywordSpan.start,
      end: expressionSpan.end,
    };
    const clauseSpan = {
      start: constraintKeywordSpan.start,
      end: expressionSpan.end,
    };

    assert.deepEqual(tableCheck, {
      kind: "check",
      keywordSpan,
      establishmentSpan: constraintKeywordSpan,
      expressionSpan,
      underlyingClauseSpan,
      clauseSpan,
      explicitConstraintName: {
        constraintKeywordSpan,
        name: { identity: "名", quoted: true, span: nameSpan },
        wrapperSpan,
      },
    });
    assert.equal(spanText(input, tableCheck.keywordSpan), "CHECK");
    assert.equal(spanText(input, tableCheck.expressionSpan), '(("😀", "é"))');
    assert.equal(spanText(input, tableCheck.underlyingClauseSpan), 'CHECK (("😀", "é"))');
    assert.equal(spanText(input, tableCheck.clauseSpan), 'CONSTRAINT "名" CHECK (("😀", "é"))');
    assert.equal(spanText(input, tableCheck.explicitConstraintName.name.span), '"名"');

    assert.deepEqual(shape.derived.explicitConstraintNames[0], {
      constraintKeywordSpan,
      name: { identity: "名", quoted: true, span: nameSpan },
      wrapperSpan,
      scope: "table",
      kind: "check",
      underlyingKeywordSpan: keywordSpan,
      underlyingClauseSpan,
      clauseSpan,
      sourceOrder: 0,
      targetColumnOrdinal: null,
    });

    const columnCheck = shape.derived.columns[0]?.clauseOccurrences[0] ?? assert.fail();
    assert.equal(columnCheck.kind, "check");
    if (columnCheck.kind !== "check") {
      assert.fail("expected column CHECK");
    }
    assert.deepEqual(columnCheck.expressionSpan, {
      start: { rawByteOffset: 42, line: 2, column: 17 },
      end: { rawByteOffset: 53, line: 2, column: 27 },
    });
    assert.deepEqual(
      columnExpressionSpan(shape.derived.columns[0], "check"),
      columnCheck.expressionSpan,
    );
  });
  it("keeps protected and nested table CHECK content opaque and the next delimiter caller-owned", () => {
    const expression = [
      "(",
      "(left, [right; value]), ",
      "')](' E'\\\\)]' \"CHECK;)]\" ",
      "$tag$),]; CONSTRAINT CHECK FOREIGN LIKE EXCLUDE$tag$ ",
      "/* ([;)] */ -- ([;)]\r\n",
      "$1, CHECK, CONSTRAINT",
      ")",
    ].join("");
    const sourceText = `create table t (CONSTRAINT guard CHECK ${expression}, c int, CONSTRAINT key_name UNIQUE (c))`;
    const input = acceptText(sourceText);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;

    assert.equal(shape.derived.tableCheckConstraints.length, 1);
    assert.equal(
      spanText(input, shape.derived.tableCheckConstraints[0]?.expressionSpan ?? assert.fail()),
      expression,
    );
    assert.deepEqual(
      shape.derived.columns.map((column) => column.name.identity),
      ["c"],
    );
    assert.deepEqual(
      shape.derived.tableKeyConstraints.map((constraint) => constraint.kind),
      ["unique"],
    );
    assert.deepEqual(
      shape.derived.explicitConstraintNames.map((occurrence) => [
        occurrence.name.identity,
        occurrence.kind,
      ]),
      [
        ["guard", "check"],
        ["key_name", "unique"],
      ],
    );
  });
  it("keeps selected table CHECK grammar nonempty and structurally owned", () => {
    for (const testCase of [
      { clause: "CHECK true)", boundary: "true" },
      { clause: "CONSTRAINT named CHECK true)", boundary: "true" },
      { clause: "CHECK ())", boundary: ")" },
      { clause: "CHECK ( /* only */ -- trivia\r\n ))", boundary: ")" },
      { clause: "CONSTRAINT named CHECK ))", boundary: ")" },
    ]) {
      const input = acceptText(`create table t (${testCase.clause}`);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.clause,
      );
    }

    for (const sourceText of ["create table t (CHECK ([)])", "create table t (CHECK (]))"]) {
      const input = acceptText(sourceText);
      const refusalSpan = expectUnbalanced(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, refusalSpan), sourceText.includes("([)") ? ")" : "]");
    }

    const outstandingInput = acceptText("create table t (CHECK (([");
    assert.equal(
      spanText(outstandingInput, expectUnbalanced(recognizeCreateTableCoreShape(outstandingInput))),
      "[",
    );

    const unexpectedCloseInput = acceptText("create table t (CHECK (true))]");
    assert.equal(
      spanText(
        unexpectedCloseInput,
        expectUnbalanced(recognizeCreateTableCoreShape(unexpectedCloseInput)),
      ),
      "]",
    );
  });
  it("passes every demanded protected-token refusal through table CHECK", () => {
    const sourceTexts = [
      "create table t (CHECK ('open",
      "create table t (CHECK (E'open",
      "create table t (CHECK ($tag$open",
      'create table t (CHECK ("open',
      "create table t (CHECK (/* open",
      "create table t (CHECK (\uFEFF))",
      "create table t (CONSTRAINT named CHECK E'open",
    ];

    for (const sourceText of sourceTexts) {
      const input = acceptText(sourceText);
      assert.deepEqual(
        expectRefused(recognizeCreateTableCoreShape(input)).refusal,
        firstLexicalRefusal(input),
        sourceText,
      );
    }
  });
  it("stops lazily at unsupported table CHECK forms, options, and tails", () => {
    const cases = [
      { clause: "CHECK (true) NO INHERIT E'open", boundary: "NO" },
      {
        clause: "CONSTRAINT named CHECK (true) DEFERRABLE E'open",
        boundary: "DEFERRABLE",
      },
      { clause: "CONSTRAINT named CHECK ) E'open", boundary: ")" },
      { clause: "CONSTRAINT named REFERENCES E'open", boundary: "REFERENCES" },
      {
        clause: "CONSTRAINT dup CHECK (true), CONSTRAINT DUP REFERENCES E'open",
        boundary: "REFERENCES",
      },
    ];

    for (const testCase of cases) {
      const input = acceptText(`create table t (${testCase.clause}`);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.clause,
      );
    }
  });
});
