import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRawInputProfile,
  MAX_RAW_INPUT_BYTES,
  type AcceptedRawInput,
  type RawInputResult,
} from "../src/input-profile.js";
import { consumeLexicalTrivia, type LexicalTriviaResult } from "../src/lexical-trivia.js";
import {
  createSourceCursor,
  type SourceCursor,
  type SourceLocation,
} from "../src/source-cursor.js";

const encoder = new TextEncoder();

function expectAccepted(result: RawInputResult): AcceptedRawInput {
  if (result.kind !== "accepted") {
    assert.fail(`Expected accepted input, received ${result.refusalId}`);
  }
  return result;
}

function acceptText(sourceText: string): AcceptedRawInput {
  return expectAccepted(applyRawInputProfile(encoder.encode(sourceText)));
}

function cursorFor(sourceText: string): SourceCursor {
  return createSourceCursor(acceptText(sourceText));
}

function assertOk(result: LexicalTriviaResult): void {
  assert.deepEqual(result, { kind: "ok" });
}

function assertPosition(cursor: SourceCursor, expected: SourceLocation): void {
  assert.deepEqual(cursor.position(), expected);
}

describe("consumeLexicalTrivia", () => {
  describe("whitespace and boundaries", () => {
    it("accepts empty input and stops before non-trivia", () => {
      const empty = cursorFor("");
      assertOk(consumeLexicalTrivia(empty));
      assert.equal(empty.atEnd(), true);
      assertPosition(empty, { rawByteOffset: 0, line: 1, column: 1 });

      for (const sourceText of ["A", "-A", "/A", "*A", "*/A", "/-A", "\vA", "\u00A0A"]) {
        const cursor = cursorFor(sourceText);
        const before = cursor.position();

        assertOk(consumeLexicalTrivia(cursor));
        assert.equal(cursor.peek(), [...sourceText][0]);
        assert.deepEqual(cursor.position(), before, JSON.stringify(sourceText));
      }
    });

    it("consumes exactly the five whitespace scalars", () => {
      const cases = [
        { scalar: "\t", position: { rawByteOffset: 1, line: 1, column: 2 } },
        { scalar: "\f", position: { rawByteOffset: 1, line: 1, column: 2 } },
        { scalar: " ", position: { rawByteOffset: 1, line: 1, column: 2 } },
        { scalar: "\r", position: { rawByteOffset: 1, line: 2, column: 1 } },
        { scalar: "\n", position: { rawByteOffset: 1, line: 2, column: 1 } },
      ];

      for (const testCase of cases) {
        const cursor = cursorFor(`${testCase.scalar}A`);
        assertOk(consumeLexicalTrivia(cursor));
        assert.equal(cursor.peek(), "A");
        assertPosition(cursor, testCase.position);
      }

      const mixed = cursorFor("\t\f \r\nA");
      assertOk(consumeLexicalTrivia(mixed));
      assert.equal(mixed.peek(), "A");
      assertPosition(mixed, { rawByteOffset: 5, line: 2, column: 1 });
    });
  });

  describe("line comments", () => {
    it("consumes comments and their following line-ending trivia", () => {
      const cases = [
        { sourceText: "--x\nA", position: { rawByteOffset: 4, line: 2, column: 1 } },
        { sourceText: "--x\rA", position: { rawByteOffset: 4, line: 2, column: 1 } },
        { sourceText: "--x\r\nA", position: { rawByteOffset: 5, line: 2, column: 1 } },
      ];

      for (const testCase of cases) {
        const cursor = cursorFor(testCase.sourceText);
        assertOk(consumeLexicalTrivia(cursor));
        assert.equal(cursor.peek(), "A");
        assertPosition(cursor, testCase.position);
      }
    });

    it("accepts a line comment through EOF", () => {
      const sourceText = "-- /* not a block */\t😀";
      const cursor = cursorFor(sourceText);

      assertOk(consumeLexicalTrivia(cursor));
      assert.equal(cursor.atEnd(), true);
      assertPosition(cursor, {
        rawByteOffset: encoder.encode(sourceText).byteLength,
        line: 1,
        column: [...sourceText].length + 1,
      });
    });
  });

  describe("block comments", () => {
    it("consumes simple, multiline, and nested comments", () => {
      const cases = [
        { sourceText: "/*x*/A", position: { rawByteOffset: 5, line: 1, column: 6 } },
        { sourceText: "/*😀\r\né*/A", position: { rawByteOffset: 12, line: 2, column: 4 } },
        { sourceText: "/* --\n still */A", position: { rawByteOffset: 15, line: 2, column: 10 } },
        {
          sourceText: "/* outer /* inner */ outer */A",
          position: { rawByteOffset: 29, line: 1, column: 30 },
        },
      ];

      for (const testCase of cases) {
        const cursor = cursorFor(testCase.sourceText);
        assertOk(consumeLexicalTrivia(cursor));
        assert.equal(cursor.peek(), "A");
        assertPosition(cursor, testCase.position);
      }
    });

    it("consumes adjacent mixed trivia", () => {
      const cursor = cursorFor(" \t/*a*/--b\r\n/*c*/A");

      assertOk(consumeLexicalTrivia(cursor));
      assert.equal(cursor.peek(), "A");
      assertPosition(cursor, { rawByteOffset: 17, line: 2, column: 6 });
    });

    it("reports a simple unterminated comment at its outer opener", () => {
      for (const sourceText of ["/*", "/*/"]) {
        const cursor = cursorFor(sourceText);

        assert.deepEqual(consumeLexicalTrivia(cursor), {
          kind: "refused",
          refusalId: "unterminated_block_comment",
          location: { rawByteOffset: 0, line: 1, column: 1 },
        });
        assert.equal(cursor.atEnd(), true);
      }
    });

    it("retains only the outer opener location for unterminated nesting", () => {
      const prefix = "é\r\n  ";
      const cursor = cursorFor(`${prefix}/* outer /* inner`);

      for (const scalar of prefix) {
        assert.equal(cursor.advance(), scalar);
      }
      const outerLocation = cursor.position();

      assert.deepEqual(consumeLexicalTrivia(cursor), {
        kind: "refused",
        refusalId: "unterminated_block_comment",
        location: outerLocation,
      });
      assert.deepEqual(outerLocation, { rawByteOffset: 6, line: 2, column: 3 });
      assert.equal(cursor.atEnd(), true);
    });

    it("handles maximum-size iterative nesting", () => {
      const depth = MAX_RAW_INPUT_BYTES / 4;
      const sourceText = "/*".repeat(depth) + "*/".repeat(depth);
      const cursor = cursorFor(sourceText);

      assert.equal(encoder.encode(sourceText).byteLength, MAX_RAW_INPUT_BYTES);
      assertOk(consumeLexicalTrivia(cursor));
      assert.equal(cursor.atEnd(), true);
      assertPosition(cursor, {
        rawByteOffset: MAX_RAW_INPUT_BYTES,
        line: 1,
        column: MAX_RAW_INPUT_BYTES + 1,
      });
    });
  });
});
