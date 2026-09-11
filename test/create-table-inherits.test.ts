import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recognizeCreateTableCoreShape } from "../src/create-table-core-shape.js";
import { applyRawInputProfile, MAX_RAW_INPUT_BYTES } from "../src/input-profile.js";
import {
  UTF8_BOM,
  acceptText,
  concatenate,
  expectAccepted,
  expectRecognized,
  expectRefused,
  expectUnbalanced,
  expectUnexpectedToken,
  firstLexicalRefusal,
  spanText,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();

describe("CREATE TABLE INHERITS recognition", () => {
  it("retains one-part, two-part, quoted, ordered, and duplicate relation evidence", () => {
    const sourceText = 'create table t (c int) INHERITS (parent, app.base, "Case"."父", parent)';
    const input = acceptText(sourceText);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    const clause = shape.inheritsClause ?? assert.fail("missing INHERITS clause");

    assert.equal(spanText(input, clause.keywordSpan), "INHERITS");
    assert.equal(spanText(input, clause.span), 'INHERITS (parent, app.base, "Case"."父", parent)');
    assert.deepEqual(
      clause.relations.map((relation) => [
        relation.qualifier?.identity ?? null,
        relation.qualifier?.quoted ?? null,
        relation.local.identity,
        relation.local.quoted,
      ]),
      [
        [null, null, "parent", false],
        ["app", false, "base", false],
        ["Case", true, "父", true],
        [null, null, "parent", false],
      ],
    );
    assert.deepEqual(
      clause.relations.map((relation) => spanText(input, relation.span)),
      ["parent", "app.base", '"Case"."父"', "parent"],
    );
    assert.equal(spanText(input, clause.relations[2]?.qualifier?.span ?? assert.fail()), '"Case"');
    assert.equal(spanText(input, clause.relations[2]?.local.span ?? assert.fail()), '"父"');
  });

  it("preserves exact BOM, CRLF, byte, line, and scalar coordinates for Unicode names", () => {
    const sourceText = 'CREATE TABLE "表" (\r\n  "é" int\r\n)\r\nINHERITS ("父"."子", "父")';
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    const clause = shape.inheritsClause ?? assert.fail("missing INHERITS clause");
    const first = clause.relations[0] ?? assert.fail("missing inherited relation");

    assert.deepEqual(clause.keywordSpan.start, { rawByteOffset: 40, line: 4, column: 1 });
    assert.deepEqual(first.qualifier?.span.start, { rawByteOffset: 50, line: 4, column: 11 });
    assert.deepEqual(first.local.span.start, { rawByteOffset: 56, line: 4, column: 15 });
    assert.equal(spanText(input, first.span), '"父"."子"');
    assert.equal(shape.span.end.rawByteOffset, input.rawBytes.byteLength);
  });

  it("rejects malformed relation lists at the first selected grammar boundary", () => {
    const cases = [
      { sourceText: "create table t (c int) INHERITS ()", boundary: ")" },
      { sourceText: "create table t (c int) INHERITS parent)", boundary: "parent" },
      { sourceText: "create table t (c int) INHERITS (,parent)", boundary: "," },
      { sourceText: "create table t (c int) INHERITS (parent,)", boundary: ")" },
      { sourceText: "create table t (c int) INHERITS (parent,,other)", boundary: "," },
      { sourceText: "create table t (c int) INHERITS (a.b.c)", boundary: "." },
    ];

    for (const testCase of cases) {
      const input = acceptText(testCase.sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.sourceText,
      );
    }
  });

  it("keeps committed INHERITS delimiters under structural ownership", () => {
    const missingClose = acceptText("create table t (c int) INHERITS (parent");
    assert.equal(
      spanText(missingClose, expectUnbalanced(recognizeCreateTableCoreShape(missingClose))),
      "(",
    );

    const missingRelation = acceptText("create table t (c int) INHERITS (");
    assert.equal(
      spanText(missingRelation, expectUnbalanced(recognizeCreateTableCoreShape(missingRelation))),
      "(",
    );

    const mismatch = acceptText("create table t (c int) INHERITS (parent]");
    assert.equal(
      spanText(mismatch, expectUnbalanced(recognizeCreateTableCoreShape(mismatch))),
      "]",
    );
  });

  it("preserves demanded lexical refusal precedence inside inherited qualified names", () => {
    for (const sourceText of [
      'create table t (c int) INHERITS (U&"name")',
      "create table t (c int) INHERITS (nameé)",
      'create table t (c int) INHERITS ("\u200B")',
    ]) {
      const input = acceptText(sourceText);
      const expected = firstLexicalRefusal(input);
      const result = expectRefused(recognizeCreateTableCoreShape(input));
      assert.deepEqual(result.refusal, expected, sourceText);
    }
  });

  it("allows INHERITS before terminal PARTITION BY and preserves semicolon/EOF behavior", () => {
    const sourceText = "create table t (c int) INHERITS (parent, app.base) PARTITION BY hash(c);";
    const input = acceptText(sourceText);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;

    assert.equal(
      spanText(input, shape.inheritsClause?.span ?? assert.fail()),
      "INHERITS (parent, app.base)",
    );
    assert.equal(
      spanText(input, shape.partitionByClause?.partitionKeywordSpan ?? assert.fail()),
      "PARTITION",
    );
    assert.equal(spanText(input, shape.partitionByClause?.byKeywordSpan ?? assert.fail()), "BY");
    assert.equal(
      spanText(input, shape.partitionByClause?.expressionSpan ?? assert.fail()),
      "hash(c)",
    );
    assert.equal(
      spanText(input, shape.partitionByClause?.span ?? assert.fail()),
      "PARTITION BY hash(c)",
    );
    assert.equal(spanText(input, shape.span), sourceText.slice(0, -1));

    expectRecognized(
      recognizeCreateTableCoreShape(acceptText("create table t (c int) INHERITS (p)")),
    );
    expectRecognized(
      recognizeCreateTableCoreShape(acceptText("create table t (c int) INHERITS (p);")),
    );

    const doubleTerminator = acceptText("create table t (c int) INHERITS (p);;");
    assert.equal(
      spanText(
        doubleTerminator,
        expectUnexpectedToken(doubleTerminator, recognizeCreateTableCoreShape(doubleTerminator)),
      ),
      ";",
    );

    const laterStatement = acceptText(
      "create table t (c int) INHERITS (p); CREATE TABLE other (c int)",
    );
    assert.equal(
      spanText(
        laterStatement,
        expectUnexpectedToken(laterStatement, recognizeCreateTableCoreShape(laterStatement)),
      ),
      "CREATE",
    );

    const terminalOpaque = acceptText(
      "create table t (c int) INHERITS (p) PARTITION BY hash(c) INHERITS (q)",
    );
    const terminalShape = expectRecognized(recognizeCreateTableCoreShape(terminalOpaque)).coreShape;
    assert.equal(
      spanText(terminalOpaque, terminalShape.partitionByClause?.expressionSpan ?? assert.fail()),
      "hash(c) INHERITS (q)",
    );
  });

  it("processes a near-cap many-relation INHERITS list deterministically", () => {
    const prefix = "create table t (c int) INHERITS (";
    const suffix = ")";
    const relations: string[] = [];
    let rawByteLength = prefix.length + suffix.length;

    for (let ordinal = 0; ; ordinal += 1) {
      const relation = `p${ordinal.toString().padStart(5, "0")}`;
      const addition = (relations.length === 0 ? "" : ",") + relation;
      if (rawByteLength + addition.length > MAX_RAW_INPUT_BYTES) {
        break;
      }
      relations.push(relation);
      rawByteLength += addition.length;
    }

    const sourceText = `${prefix}${relations.join(",")}${suffix}`;
    const input = acceptText(sourceText);
    assert.equal(MAX_RAW_INPUT_BYTES - input.rawBytes.byteLength < 8, true);

    const first = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    const second = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    assert.equal(first.inheritsClause?.relations.length, relations.length);
    assert.equal(second.inheritsClause?.relations.length, relations.length);
    assert.equal(first.inheritsClause?.relations[0]?.local.identity, "p00000");
    assert.equal(first.inheritsClause?.relations.at(-1)?.local.identity, relations.at(-1));
    assert.deepEqual(first.inheritsClause, second.inheritsClause);
  });
});
