import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRawInputProfile,
  MAX_RAW_INPUT_BYTES,
  type AcceptedRawInput,
  type RawInputResult,
} from "../src/input-profile.js";
import {
  createSourceCursor,
  type SourceCursor,
  type SourceLocation,
} from "../src/source-cursor.js";

const encoder = new TextEncoder();
const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

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

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function assertPosition(cursor: SourceCursor, expected: SourceLocation): void {
  assert.deepEqual(cursor.position(), expected);
}

function traverse(cursor: SourceCursor): Array<{ scalar: string; position: SourceLocation }> {
  const observations: Array<{ scalar: string; position: SourceLocation }> = [];
  for (;;) {
    const scalar = cursor.advance();
    if (scalar === null) {
      return observations;
    }
    observations.push({ scalar, position: cursor.position() });
  }
}

describe("createSourceCursor", () => {
  describe("EOF", () => {
    it("is stable for empty and BOM-only input", () => {
      const emptyCursor = cursorFor("");
      assert.equal(emptyCursor.atEnd(), true);
      assert.equal(emptyCursor.peek(), null);
      assert.equal(emptyCursor.peekNext(), null);
      assert.equal(emptyCursor.peekSecondNext(), null);
      assert.equal(emptyCursor.advance(), null);
      assertPosition(emptyCursor, { rawByteOffset: 0, line: 1, column: 1 });
      assert.equal(emptyCursor.advance(), null);
      assertPosition(emptyCursor, { rawByteOffset: 0, line: 1, column: 1 });

      const bomOnlyCursor = createSourceCursor(expectAccepted(applyRawInputProfile(UTF8_BOM)));
      assert.equal(bomOnlyCursor.atEnd(), true);
      assert.equal(bomOnlyCursor.peek(), null);
      assert.equal(bomOnlyCursor.peekNext(), null);
      assert.equal(bomOnlyCursor.peekSecondNext(), null);
      assert.equal(bomOnlyCursor.advance(), null);
      assertPosition(bomOnlyCursor, { rawByteOffset: 3, line: 1, column: 1 });
    });
  });

  describe("scalar traversal", () => {
    it("peek does not advance", () => {
      const cursor = cursorFor("ABC");

      assert.equal(cursor.peek(), "A");
      assert.equal(cursor.peek(), "A");
      assertPosition(cursor, { rawByteOffset: 0, line: 1, column: 1 });
    });

    it("peeks up to two complete scalars ahead without advancing", () => {
      const cursor = cursorFor("A😀B");

      assert.equal(cursor.peek(), "A");
      assert.equal(cursor.peekNext(), "😀");
      assert.equal(cursor.peekSecondNext(), "B");
      assert.equal(cursor.peekSecondNext(), "B");
      assert.equal(cursor.peekNext(), "😀");
      assertPosition(cursor, { rawByteOffset: 0, line: 1, column: 1 });

      assert.equal(cursor.advance(), "A");
      assert.equal(cursor.peek(), "😀");
      assert.equal(cursor.peekNext(), "B");
      assert.equal(cursor.peekSecondNext(), null);
      assertPosition(cursor, { rawByteOffset: 1, line: 1, column: 2 });

      assert.equal(cursor.advance(), "😀");
      assert.equal(cursor.peek(), "B");
      assert.equal(cursor.peekNext(), null);
      assert.equal(cursor.peekSecondNext(), null);
      assertPosition(cursor, { rawByteOffset: 5, line: 1, column: 3 });

      assert.equal(cursor.advance(), "B");
      assert.equal(cursor.peekNext(), null);
      assertPosition(cursor, { rawByteOffset: 6, line: 1, column: 4 });
    });

    it("position returns snapshots", () => {
      const cursor = cursorFor("ABC");
      const initialPosition = cursor.position();

      assert.equal(cursor.advance(), "A");
      assert.deepEqual(initialPosition, { rawByteOffset: 0, line: 1, column: 1 });
      assertPosition(cursor, { rawByteOffset: 1, line: 1, column: 2 });
      assert.deepEqual(traverse(cursor), [
        { scalar: "B", position: { rawByteOffset: 2, line: 1, column: 3 } },
        { scalar: "C", position: { rawByteOffset: 3, line: 1, column: 4 } },
      ]);
      assert.equal(cursor.atEnd(), true);
    });

    it("peeks and advances complete Unicode scalars", () => {
      const cursor = cursorFor("A¢€😀e\u0301");
      const expected = [
        { scalar: "A", position: { rawByteOffset: 1, line: 1, column: 2 } },
        { scalar: "¢", position: { rawByteOffset: 3, line: 1, column: 3 } },
        { scalar: "€", position: { rawByteOffset: 6, line: 1, column: 4 } },
        { scalar: "😀", position: { rawByteOffset: 10, line: 1, column: 5 } },
        { scalar: "e", position: { rawByteOffset: 11, line: 1, column: 6 } },
        { scalar: "\u0301", position: { rawByteOffset: 13, line: 1, column: 7 } },
      ];

      for (const observation of expected) {
        assert.equal(cursor.peek(), observation.scalar);
        assert.equal(cursor.advance(), observation.scalar);
        assertPosition(cursor, observation.position);
      }

      assert.equal(cursor.atEnd(), true);
      assert.equal(cursor.peek(), null);
    });

    it("cursors traverse independently", () => {
      const accepted = acceptText("A¢€😀\r\nB\ne\u0301");
      const firstCursor = createSourceCursor(accepted);
      const secondCursor = createSourceCursor(accepted);

      const first = traverse(firstCursor);
      const second = traverse(secondCursor);

      assert.deepEqual(first, second);
      assert.equal(first.length, 10);
      assert.equal(firstCursor.atEnd(), true);
      assert.equal(secondCursor.atEnd(), true);
    });
  });

  describe("line endings", () => {
    it("counts CRLF as one line break across two scalar advances", () => {
      const cursor = cursorFor("A\r\nB");

      assert.equal(cursor.advance(), "A");
      assert.equal(cursor.advance(), "\r");
      const afterCarriageReturn = cursor.position();
      assert.deepEqual(afterCarriageReturn, { rawByteOffset: 2, line: 2, column: 1 });
      assert.equal(cursor.peek(), "\n");

      assert.equal(cursor.advance(), "\n");
      const afterLineFeed = cursor.position();
      assert.equal(afterLineFeed.rawByteOffset > afterCarriageReturn.rawByteOffset, true);
      assert.equal(afterLineFeed.line, afterCarriageReturn.line);
      assert.equal(afterLineFeed.column, afterCarriageReturn.column);
      assert.equal(cursor.peek(), "B");

      assert.equal(cursor.advance(), "B");
      assertPosition(cursor, { rawByteOffset: 4, line: 2, column: 2 });
    });

    it("tracks lone and consecutive CR and LF scalars", () => {
      const cases = [
        {
          sourceText: "A\rB",
          positions: [
            { rawByteOffset: 1, line: 1, column: 2 },
            { rawByteOffset: 2, line: 2, column: 1 },
            { rawByteOffset: 3, line: 2, column: 2 },
          ],
        },
        {
          sourceText: "A\nB",
          positions: [
            { rawByteOffset: 1, line: 1, column: 2 },
            { rawByteOffset: 2, line: 2, column: 1 },
            { rawByteOffset: 3, line: 2, column: 2 },
          ],
        },
        {
          sourceText: "\r\r\n",
          positions: [
            { rawByteOffset: 1, line: 2, column: 1 },
            { rawByteOffset: 2, line: 3, column: 1 },
            { rawByteOffset: 3, line: 3, column: 1 },
          ],
        },
        {
          sourceText: "\n\r",
          positions: [
            { rawByteOffset: 1, line: 2, column: 1 },
            { rawByteOffset: 2, line: 3, column: 1 },
          ],
        },
        {
          sourceText: "A\r\n\nB",
          positions: [
            { rawByteOffset: 1, line: 1, column: 2 },
            { rawByteOffset: 2, line: 2, column: 1 },
            { rawByteOffset: 3, line: 2, column: 1 },
            { rawByteOffset: 4, line: 3, column: 1 },
            { rawByteOffset: 5, line: 3, column: 2 },
          ],
        },
      ];

      for (const testCase of cases) {
        const accepted = acceptText(testCase.sourceText);
        const cursor = createSourceCursor(accepted);
        assert.deepEqual(
          traverse(cursor).map((observation) => observation.position),
          testCase.positions,
          JSON.stringify(testCase.sourceText),
        );
        assert.equal(accepted.sourceText, testCase.sourceText);
      }
    });
  });

  describe("raw offsets", () => {
    it("starts after the stripped BOM", () => {
      const leading = expectAccepted(
        applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode("A"))),
      );
      const leadingBefore = new Uint8Array(leading.rawBytes);
      const leadingCursor = createSourceCursor(leading);

      assertPosition(leadingCursor, { rawByteOffset: 3, line: 1, column: 1 });
      assert.equal(leadingCursor.advance(), "A");
      assertPosition(leadingCursor, { rawByteOffset: 4, line: 1, column: 2 });
      assert.deepEqual(leading.rawBytes, leadingBefore);

      const doubleLeading = expectAccepted(
        applyRawInputProfile(concatenate(UTF8_BOM, UTF8_BOM, encoder.encode("A"))),
      );
      const doubleLeadingCursor = createSourceCursor(doubleLeading);
      assertPosition(doubleLeadingCursor, { rawByteOffset: 3, line: 1, column: 1 });
      assert.equal(doubleLeadingCursor.advance(), "\uFEFF");
      assertPosition(doubleLeadingCursor, { rawByteOffset: 6, line: 1, column: 2 });
      assert.equal(doubleLeadingCursor.advance(), "A");
      assertPosition(doubleLeadingCursor, { rawByteOffset: 7, line: 1, column: 3 });
    });

    it("does not depend on later accepted-byte mutation", () => {
      const accepted = expectAccepted(
        applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode("A"))),
      );
      const cursor = createSourceCursor(accepted);

      accepted.rawBytes.fill(0x00);

      assertPosition(cursor, { rawByteOffset: 3, line: 1, column: 1 });
      assert.equal(cursor.peek(), "A");
      assert.equal(cursor.advance(), "A");
      assertPosition(cursor, { rawByteOffset: 4, line: 1, column: 2 });
    });

    it("combines BOM, multibyte scalars, and newlines", () => {
      const accepted = expectAccepted(
        applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode("😀\nA"))),
      );

      assert.deepEqual(traverse(createSourceCursor(accepted)), [
        { scalar: "😀", position: { rawByteOffset: 7, line: 1, column: 2 } },
        { scalar: "\n", position: { rawByteOffset: 8, line: 2, column: 1 } },
        { scalar: "A", position: { rawByteOffset: 9, line: 2, column: 2 } },
      ]);
    });

    it("increases on every scalar", () => {
      const observations = traverse(cursorFor("A¢€😀\r\nB\ne\u0301"));
      let previousRawByteOffset = 0;

      for (const observation of observations) {
        assert.equal(observation.position.rawByteOffset > previousRawByteOffset, true);
        previousRawByteOffset = observation.position.rawByteOffset;
      }
    });

    it("traverses the maximum accepted input", () => {
      const input = new Uint8Array(MAX_RAW_INPUT_BYTES);
      input.fill(0x41);
      const cursor = createSourceCursor(expectAccepted(applyRawInputProfile(input)));

      let advances = 0;
      while (cursor.advance() !== null) {
        advances += 1;
      }

      assert.equal(advances, MAX_RAW_INPUT_BYTES);
      assert.equal(cursor.atEnd(), true);
      assertPosition(cursor, {
        rawByteOffset: MAX_RAW_INPUT_BYTES,
        line: 1,
        column: MAX_RAW_INPUT_BYTES + 1,
      });
    });
  });

  it("NUL location matches cursor position", () => {
    const prefixes = ["", "é\r\nx", "😀", "A\rB", "A\nB"];

    for (const prefix of prefixes) {
      const prefixBytes = encoder.encode(prefix);
      const cursor = createSourceCursor(expectAccepted(applyRawInputProfile(prefixBytes)));
      traverse(cursor);

      const refusal = applyRawInputProfile(concatenate(prefixBytes, Uint8Array.of(0x00)));
      assert.equal(refusal.kind, "refused");
      if (refusal.kind !== "refused" || refusal.refusalId !== "nul_byte_not_in_profile") {
        assert.fail("Expected NUL refusal");
      }

      assert.deepEqual(refusal.location, {
        ...cursor.position(),
        rawByteLength: 1,
      });
    }

    const bomPrefix = concatenate(UTF8_BOM, encoder.encode("é\r\nx"));
    const bomCursor = createSourceCursor(expectAccepted(applyRawInputProfile(bomPrefix)));
    traverse(bomCursor);
    const bomRefusal = applyRawInputProfile(concatenate(bomPrefix, Uint8Array.of(0x00)));
    assert.equal(bomRefusal.kind, "refused");
    if (bomRefusal.kind !== "refused" || bomRefusal.refusalId !== "nul_byte_not_in_profile") {
      assert.fail("Expected NUL refusal after BOM-prefixed source");
    }
    assert.deepEqual(bomRefusal.location, {
      ...bomCursor.position(),
      rawByteLength: 1,
    });
  });
});
