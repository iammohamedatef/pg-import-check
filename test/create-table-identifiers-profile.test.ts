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
  expectMiss,
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
  it("applies contextual identifier refusals across the complete implemented identifier-demand class", () => {
    const atLimit = "a".repeat(63);
    const overLimit = "a".repeat(64);
    const roles = [
      { role: "target relation", build: (id: string) => `create table ${id} (c int)` },
      { role: "target qualifier", build: (id: string) => `create table ${id} . t (c int)` },
      { role: "target local", build: (id: string) => `create table q . ${id} (c int)` },
      { role: "column", build: (id: string) => `create table t (${id} int)` },
      { role: "type", build: (id: string) => `create table t (c ${id} )` },
      { role: "type qualifier", build: (id: string) => `create table t (c ${id} . int)` },
      { role: "qualified type local", build: (id: string) => `create table t (c q . ${id} )` },
      {
        role: "column constraint name",
        build: (id: string) => `create table t (c int constraint ${id} unique)`,
      },
      {
        role: "table constraint name",
        build: (id: string) => `create table t (c int, constraint ${id} unique (c))`,
      },
      {
        role: "PRIMARY KEY member",
        build: (id: string) => `create table t (c int, primary key (${id} ))`,
      },
      {
        role: "UNIQUE member",
        build: (id: string) => `create table t (c int, unique (${id} ))`,
      },
      {
        role: "FK local member",
        build: (id: string) => `create table t (c int, foreign key (${id} ) references p)`,
      },
      {
        role: "referenced relation qualifier",
        build: (id: string) => `create table t (c int references ${id} . p)`,
      },
      {
        role: "referenced relation local",
        build: (id: string) => `create table t (c int references q . ${id} )`,
      },
      {
        role: "FK remote member",
        build: (id: string) => `create table t (c int references p (${id} ))`,
      },
      {
        role: "DEFAULT call",
        build: (id: string) => `create table t (c int default ${id} ())`,
      },
      {
        role: "DEFAULT call qualifier",
        build: (id: string) => `create table t (c int default ${id} . fn())`,
      },
      {
        role: "DEFAULT qualified call local",
        build: (id: string) => `create table t (c int default fn . ${id} ())`,
      },
      {
        role: "cast type",
        build: (id: string) => `create table t (c int default 1::${id} )`,
      },
      {
        role: "cast type qualifier",
        build: (id: string) => `create table t (c int default 1::${id} . int)`,
      },
      {
        role: "cast qualified type local",
        build: (id: string) => `create table t (c int default 1::q . ${id} )`,
      },
    ];

    for (const { role, build } of roles) {
      const atLimitResult = recognizeText(build(atLimit));
      if (atLimitResult.kind === "refused") {
        assert.notEqual(atLimitResult.refusal.refusalId, "identifier_outside_profile", role);
        assert.notEqual(atLimitResult.refusal.refusalId, "unquoted_non_ascii_identifier", role);
      }

      const overLimitText = build(overLimit);
      const overLimitInput = acceptText(overLimitText);
      const overLimitRefusal = expectRefused(recognizeCreateTableCoreShape(overLimitInput)).refusal;
      assert.equal(overLimitRefusal.refusalId, "identifier_outside_profile", role);
      if (overLimitRefusal.refusalId === "identifier_outside_profile") {
        assert.equal(overLimitRefusal.actualUtf8ByteLength, 64, role);
        assert.equal(spanText(overLimitInput, overLimitRefusal.span), overLimit, role);
      }

      for (const identity of ["é", "asciié"]) {
        const sourceText = build(identity);
        const input = acceptText(sourceText);
        const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
        assert.equal(refusal.refusalId, "unquoted_non_ascii_identifier", `${role}: ${identity}`);
        assert.equal(spanText(input, refusal.span), "é", `${role}: ${identity}`);
      }

      const quotedUnicodeResult = recognizeText(build('"é"'));
      if (quotedUnicodeResult.kind === "refused") {
        assert.notEqual(quotedUnicodeResult.refusal.refusalId, "identifier_outside_profile", role);
        assert.notEqual(
          quotedUnicodeResult.refusal.refusalId,
          "unquoted_non_ascii_identifier",
          role,
        );
      }
    }

    const quotedAtLimit = `${"é".repeat(31)}a`;
    const atLimitShape = expectRecognized(
      recognizeText(`create table "${quotedAtLimit}" ("${quotedAtLimit}" "${quotedAtLimit}")`),
    ).coreShape;
    assert.equal(atLimitShape.table.local.identity, quotedAtLimit);
    assert.equal(atLimitShape.derived.columns[0]?.name.identity, quotedAtLimit);
    assert.equal(atLimitShape.derived.columns[0]?.type.name.local.identity, quotedAtLimit);

    const quotedOverLimit = `"${"é".repeat(32)}"`;
    const overLimitResult = expectRefused(recognizeText(`create table ${quotedOverLimit} (c int)`));
    assert.equal(overLimitResult.refusal.refusalId, "identifier_outside_profile");
  });
  it("preserves exact contextual identifier coordinates across CRLF and multibyte input", () => {
    const sourceText = "CREATE\r\nTABLE t (\r\n  é int\r\n)";
    const input = acceptText(sourceText);
    const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
    assert.equal(refusal.refusalId, "unquoted_non_ascii_identifier");
    assert.equal(spanText(input, refusal.span), "é");
    assert.deepEqual(refusal.span, {
      start: { rawByteOffset: 21, line: 3, column: 3 },
      end: { rawByteOffset: 23, line: 3, column: 4 },
    });
  });
  it("keeps non-ASCII inside opaque traversal out of identifier-demand semantics", () => {
    for (const sourceText of [
      "create table t (c int check (é ))",
      "create table t (c int default (é ))",
      "create table t (c int) partition by é ",
    ]) {
      const input = acceptText(sourceText);
      const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
      assert.equal(refusal.refusalId, "syntax_not_in_profile", sourceText);
      assert.equal(spanText(input, refusal.span), "é", sourceText);
    }

    expectRecognized(recognizeText('create table t (c int check ("é"))'));
    expectRecognized(recognizeText("create table t (c int check ('é'))"));
  });
  it("passes through only lexical refusals already selected by the token source", () => {
    const cases: Array<{ sourceText: string; refusalId: LexicalRefusal["refusalId"] }> = [
      { sourceText: "create /* open", refusalId: "unterminated_block_comment" },
      { sourceText: 'create table "open', refusalId: "unterminated_quoted_identifier" },
      { sourceText: "create table t (c 'open", refusalId: "unterminated_string" },
      { sourceText: "create table t (c $tag$open", refusalId: "unterminated_dollar_quote" },
      { sourceText: "create table t (c int)\uFEFF", refusalId: "unexpected_bom" },
      { sourceText: "create table nameé (c int)", refusalId: "unquoted_non_ascii_identifier" },
      {
        sourceText: 'create table "\u200B" (c int)',
        refusalId: "identifier_contains_unsafe_character",
      },
      {
        sourceText: `create table "${"a".repeat(64)}" (c int)`,
        refusalId: "identifier_outside_profile",
      },
      {
        sourceText: 'create table U&"name" (c int)',
        refusalId: "unicode_escape_syntax_not_in_profile",
      },
      { sourceText: 'create table "" (c int)', refusalId: "syntax_not_in_profile" },
    ];

    for (const testCase of cases) {
      const input = acceptText(testCase.sourceText);
      const expectedRefusal = firstLexicalRefusal(input);
      const actual = expectRefused(recognizeCreateTableCoreShape(input));

      assert.equal(expectedRefusal.refusalId, testCase.refusalId, testCase.sourceText);
      assert.deepEqual(actual.refusal, expectedRefusal, testCase.sourceText);
    }

    const bareDollarBomInput = acceptText("create table t (c int);\r\n$\uFEFF");
    const bareDollarBomRefusal = firstLexicalRefusal(bareDollarBomInput);
    assert.deepEqual(bareDollarBomRefusal, {
      refusalId: "unexpected_bom",
      span: {
        start: { rawByteOffset: 26, line: 2, column: 2 },
        end: { rawByteOffset: 29, line: 2, column: 3 },
      },
    });
    assert.deepEqual(
      expectRefused(recognizeCreateTableCoreShape(bareDollarBomInput)).refusal,
      bareDollarBomRefusal,
    );

    const wellFormedMisses = [
      "create table t (c 'closed')",
      "create table t (c E'closed')",
      "create table t (c $$closed$$)",
      "create table t (c 42)",
    ];
    for (const sourceText of wellFormedMisses) {
      expectMiss(recognizeText(sourceText));
    }
  });
  it("preserves BOM, CRLF, multibyte scalar coordinates, and full miss spans", () => {
    const sourceText = 'CREATE\r\nTABLE "é" (\r\n  "😀" q.numeric(0001, 02)[][]\r\n)';
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));

    assert.deepEqual(coreShape.span, {
      start: { rawByteOffset: 3, line: 1, column: 1 },
      end: { rawByteOffset: 60, line: 4, column: 2 },
    });
    assert.deepEqual(coreShape.table.local.span, {
      start: { rawByteOffset: 17, line: 2, column: 7 },
      end: { rawByteOffset: 21, line: 2, column: 10 },
    });

    const column = coreShape.derived.columns[0] ?? assert.fail("missing column");
    assert.deepEqual(column.name.span, {
      start: { rawByteOffset: 27, line: 3, column: 3 },
      end: { rawByteOffset: 33, line: 3, column: 6 },
    });
    assert.deepEqual(column.type.span, {
      start: { rawByteOffset: 34, line: 3, column: 7 },
      end: { rawByteOffset: 57, line: 3, column: 30 },
    });
    assert.deepEqual(column.type.modifierDigitSpans, [
      {
        start: { rawByteOffset: 44, line: 3, column: 17 },
        end: { rawByteOffset: 48, line: 3, column: 21 },
      },
      {
        start: { rawByteOffset: 50, line: 3, column: 23 },
        end: { rawByteOffset: 52, line: 3, column: 25 },
      },
    ]);

    const extendedInput = expectAccepted(
      applyRawInputProfile(
        concatenate(UTF8_BOM, encoder.encode(`${sourceText}\r\nINHERITS (parent) USING`)),
      ),
    );
    const boundary = expectUnexpectedToken(
      extendedInput,
      recognizeCreateTableCoreShape(extendedInput),
    );
    assert.deepEqual(boundary, {
      start: { rawByteOffset: 80, line: 5, column: 19 },
      end: { rawByteOffset: 85, line: 5, column: 24 },
    });
    assert.equal(spanText(extendedInput, boundary), "USING");

    const opaqueText = 'CREATE TABLE t (\r\n  "é" int CHECK ("😀" = 1)\r\n) PARTITION BY ("é"; 2)';
    const opaqueInput = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(opaqueText))),
    );
    const opaqueShape = expectRecognized(recognizeCreateTableCoreShape(opaqueInput)).coreShape;
    assert.deepEqual(columnExpressionSpan(opaqueShape.derived.columns[0], "check"), {
      start: { rawByteOffset: 38, line: 2, column: 17 },
      end: { rawByteOffset: 50, line: 2, column: 26 },
    });
    assert.deepEqual(opaqueShape.partitionByClause?.expressionSpan, {
      start: { rawByteOffset: 67, line: 3, column: 16 },
      end: { rawByteOffset: 76, line: 3, column: 24 },
    });
    assert.deepEqual(opaqueShape.span, {
      start: { rawByteOffset: 3, line: 1, column: 1 },
      end: { rawByteOffset: 76, line: 3, column: 24 },
    });

    const mismatchedText = 'CREATE TABLE t (\r\n c int CHECK ("😀"\r\n ]';
    const mismatchedInput = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(mismatchedText))),
    );
    assert.deepEqual(expectUnbalanced(recognizeCreateTableCoreShape(mismatchedInput)), {
      start: { rawByteOffset: 44, line: 3, column: 2 },
      end: { rawByteOffset: 45, line: 3, column: 3 },
    });
  });
});
