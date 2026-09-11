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
  recognizeText,
  spanText,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();
describe("recognizeCreateTableCoreShape", () => {
  it("recognizes only the closed direct DEFAULT atom set and retains exact expression spans", () => {
    const expressions = [
      "0",
      "+ 1.5e-2",
      "-.5",
      "'a''b'",
      "E'backslash\\\\text'",
      "NULL",
      "TRUE",
      "false",
      "CURRENT_DATE",
      "current_timestamp",
      "now()",
      "gen_random_uuid( /* ),]; DEFAULT CHECK USING */ )",
      "public.nextval('sequence_name')",
      '"app"."Fn"()',
      "fn($tag$),]; DEFAULT CHECK USING$tag$, '),]; DEFAULT CHECK USING', E'\\\\),]; DEFAULT CHECK USING', \"quoted),];DEFAULT\", [left; right])",
      "($body$),]; DEFAULT CHECK USING$body$ E'\\\\)]' \"quoted\" [left; right])",
      '-1.25e+2::numeric(10,2)[]::pg."Domain"[][]',
    ];

    for (const expression of expressions) {
      const sourceText = `create table t (c int DEFAULT ${expression})`;
      const input = acceptText(sourceText);
      const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));
      const column = coreShape.derived.columns[0] ?? assert.fail("missing defaulted column");

      assert.equal(
        spanText(
          input,
          columnExpressionSpan(column, "default") ?? assert.fail("missing DEFAULT span"),
        ),
        expression,
        expression,
      );
      assert.equal(columnExpressionSpan(column, "check"), null, expression);
      assert.equal(spanText(input, column.span), `c int DEFAULT ${expression}`, expression);
    }
  });
  it("refuses expression-looking forms outside the closed DEFAULT grammar", () => {
    const cases = [
      { expression: "", boundary: ")" },
      { expression: "/* trivia only */", boundary: ")" },
      { expression: '"literal"', boundary: ")" },
      { expression: "tomorrow", boundary: ")" },
      { expression: "$$body$$", boundary: "$$body$$" },
      { expression: "+ TRUE", boundary: "TRUE" },
      { expression: "1 + 2", boundary: "+" },
      { expression: "1 AND TRUE", boundary: "AND" },
      { expression: "ARRAY[1]", boundary: "[" },
      { expression: "NULL()", boundary: "(" },
      { expression: "1::", boundary: ")" },
      { expression: "1::::int", boundary: "::::" },
    ];

    for (const testCase of cases) {
      const sourceText = `create table t (c int DEFAULT ${testCase.expression})`;
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.expression,
      );
    }

    const quotedKeywordCall = expectRecognized(
      recognizeText('create table t (c int DEFAULT "NULL"())'),
    ).coreShape.derived.columns[0];
    assert.equal(columnExpressionSpan(quotedKeywordCall, "default") === null, false);
  });
  it("stops at the first unsupported tail after a complete DEFAULT", () => {
    const cases = [
      { sourceText: "create table t (c int DEFAULT 1 COLLATE 'unterminated", boundary: "COLLATE" },
      { sourceText: "create table t (c int DEFAULT 1 + 'unterminated", boundary: "+" },
      { sourceText: "create table t (c int DEFAULT now() WITH 'unterminated", boundary: "WITH" },
    ];

    for (const testCase of cases) {
      const input = acceptText(testCase.sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
      );
    }
  });
  it("preserves lexical and typed-delimiter ownership inside DEFAULT", () => {
    const lexicalCases: Array<{
      sourceText: string;
      refusalId: LexicalRefusal["refusalId"];
      opening: string;
    }> = [
      {
        sourceText: "create table t (c int DEFAULT 'open",
        refusalId: "unterminated_string",
        opening: "'",
      },
      {
        sourceText: "create table t (c int DEFAULT E'open",
        refusalId: "unterminated_string",
        opening: "E'",
      },
      {
        sourceText: "create table t (c int DEFAULT fn([ $body$open",
        refusalId: "unterminated_dollar_quote",
        opening: "$body$",
      },
      {
        sourceText: "create table t (c int DEFAULT ([ /* open",
        refusalId: "unterminated_block_comment",
        opening: "/*",
      },
    ];

    for (const testCase of lexicalCases) {
      const { refusal } = expectRefused(recognizeText(testCase.sourceText));
      assert.equal(refusal.refusalId, testCase.refusalId, testCase.sourceText);
      assert.equal(
        refusal.span.start.rawByteOffset,
        testCase.sourceText.lastIndexOf(testCase.opening),
      );
    }

    for (const testCase of [
      { sourceText: "create table t (c int DEFAULT (]", delimiter: "]" },
      { sourceText: "create table t (c int DEFAULT fn([)]", delimiter: ")" },
      { sourceText: "create table t (c int DEFAULT ]", delimiter: "]" },
      { sourceText: "create table t (c int DEFAULT fn([", delimiter: "[" },
    ]) {
      const input = acceptText(testCase.sourceText);
      assert.equal(
        spanText(input, expectUnbalanced(recognizeCreateTableCoreShape(input))),
        testCase.delimiter,
        testCase.sourceText,
      );
    }
  });
  it("retains exact DEFAULT coordinates across a BOM, CRLF, and multibyte scalars", () => {
    const sourceText = 'CREATE TABLE "表" (\r\n  "é" text DEFAULT E\'😀\\\\n\'::"型"\r\n)';
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const column = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape.derived
      .columns[0];
    const expressionSpan =
      columnExpressionSpan(column, "default") ?? assert.fail("missing DEFAULT span");

    assert.equal(spanText(input, expressionSpan), "E'😀\\\\n'::\"型\"");
    assert.equal(expressionSpan.start.line, 2);
    assert.equal(expressionSpan.start.column, 20);
    assert.equal(expressionSpan.end.line, 2);
    assert.equal(expressionSpan.end.column, 32);
    assert.equal(
      expressionSpan.start.rawByteOffset,
      UTF8_BOM.byteLength +
        encoder.encode(sourceText.slice(0, sourceText.indexOf("E'"))).byteLength,
    );
  });
});
