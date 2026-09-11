import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  applyRawInputProfile,
  MAX_RAW_INPUT_BYTES,
  type AcceptedRawInput,
  type RawInputRefusalId,
  type RawInputResult,
} from "../src/input-profile.js";

const encoder = new TextEncoder();
const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

function expectAccepted(result: RawInputResult): AcceptedRawInput {
  if (result.kind !== "accepted") {
    assert.fail(`Expected accepted input, received ${result.refusalId}`);
  }
  return result;
}

function assertRefusal(result: RawInputResult, refusalId: RawInputRefusalId): void {
  if (result.kind !== "refused") {
    assert.fail(`Expected ${refusalId}, received accepted input`);
  }
  assert.equal(result.refusalId, refusalId);
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

test("accepts empty, ASCII, and scalar-valid multibyte UTF-8", () => {
  assert.equal(MAX_RAW_INPUT_BYTES, 262_144);

  const empty = expectAccepted(applyRawInputProfile(new Uint8Array()));
  assert.deepEqual(empty.rawBytes, new Uint8Array());
  assert.equal(empty.sourceText, "");

  const ascii = expectAccepted(applyRawInputProfile(Uint8Array.of(0x41, 0x42)));
  assert.deepEqual(ascii.rawBytes, Uint8Array.of(0x41, 0x42));
  assert.equal(ascii.sourceText, "AB");

  const multibyte = expectAccepted(
    applyRawInputProfile(Uint8Array.of(0xc2, 0xa2, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80)),
  );
  assert.equal(multibyte.sourceText, "¢€😀");
});

test("enforces the inclusive raw-byte limit before later input checks", () => {
  const atLimit = new Uint8Array(MAX_RAW_INPUT_BYTES);
  atLimit.fill(0x61);
  const accepted = expectAccepted(applyRawInputProfile(atLimit));
  assert.equal(accepted.rawBytes.byteLength, MAX_RAW_INPUT_BYTES);
  assert.equal(accepted.sourceText.length, MAX_RAW_INPUT_BYTES);

  const overLimit = new Uint8Array(MAX_RAW_INPUT_BYTES + 1);
  overLimit.fill(0x61);
  assertRefusal(applyRawInputProfile(overLimit), "input_too_large");

  const malformedAtLimit = new Uint8Array(MAX_RAW_INPUT_BYTES);
  malformedAtLimit.fill(0x61);
  malformedAtLimit[MAX_RAW_INPUT_BYTES - 1] = 0xc2;
  assertRefusal(applyRawInputProfile(malformedAtLimit), "invalid_utf8");

  const oversizedMalformedNul = new Uint8Array(MAX_RAW_INPUT_BYTES + 1);
  oversizedMalformedNul.fill(0x61);
  oversizedMalformedNul[0] = 0x80;
  oversizedMalformedNul[1] = 0x00;
  assertRefusal(applyRawInputProfile(oversizedMalformedNul), "input_too_large");
});

test("counts a leading BOM toward the raw-byte limit", () => {
  const atLimit = new Uint8Array(MAX_RAW_INPUT_BYTES);
  atLimit.set(UTF8_BOM);
  atLimit.fill(0x61, UTF8_BOM.byteLength);
  const accepted = expectAccepted(applyRawInputProfile(atLimit));
  assert.equal(accepted.rawBytes.byteLength, MAX_RAW_INPUT_BYTES);
  assert.equal(accepted.sourceText.length, MAX_RAW_INPUT_BYTES - UTF8_BOM.byteLength);

  const overLimit = new Uint8Array(MAX_RAW_INPUT_BYTES + 1);
  overLimit.set(UTF8_BOM);
  overLimit.fill(0x61, UTF8_BOM.byteLength);
  assertRefusal(applyRawInputProfile(overLimit), "input_too_large");
});

test("removes exactly one leading BOM and preserves every other U+FEFF", () => {
  const bomOnly = expectAccepted(applyRawInputProfile(UTF8_BOM));
  assert.deepEqual(bomOnly.rawBytes, UTF8_BOM);
  assert.equal(bomOnly.sourceText, "");

  const leading = expectAccepted(applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode("A"))));
  assert.equal(leading.sourceText, "A");

  const doubleLeading = expectAccepted(
    applyRawInputProfile(concatenate(UTF8_BOM, UTF8_BOM, encoder.encode("A"))),
  );
  assert.equal(doubleLeading.sourceText, "\uFEFFA");

  const embedded = expectAccepted(
    applyRawInputProfile(concatenate(encoder.encode("A"), UTF8_BOM, encoder.encode("B"))),
  );
  assert.equal(embedded.sourceText, "A\uFEFFB");
});

test("refuses each authority-defined malformed UTF-8 class", () => {
  const invalidInputs = [
    { name: "lone continuation", bytes: [0x80] },
    { name: "truncated two-byte sequence", bytes: [0xc2] },
    { name: "truncated three-byte sequence", bytes: [0xe2, 0x82] },
    { name: "truncated four-byte sequence", bytes: [0xf0, 0x9f, 0x98] },
    { name: "overlong two-byte sequence", bytes: [0xc0, 0x80] },
    { name: "overlong three-byte sequence", bytes: [0xe0, 0x80, 0x80] },
    { name: "encoded surrogate", bytes: [0xed, 0xa0, 0x80] },
    { name: "above Unicode maximum", bytes: [0xf4, 0x90, 0x80, 0x80] },
    { name: "malformed continuation", bytes: [0xe2, 0x28, 0xa1] },
    { name: "replacement-decoding trap", bytes: [0xc3, 0x28] },
  ];

  for (const invalidInput of invalidInputs) {
    assert.deepEqual(
      applyRawInputProfile(Uint8Array.from(invalidInput.bytes)),
      { kind: "refused", refusalId: "invalid_utf8" },
      invalidInput.name,
    );
  }

  const literalReplacementCharacter = expectAccepted(
    applyRawInputProfile(Uint8Array.of(0xef, 0xbf, 0xbd)),
  );
  assert.equal(literalReplacementCharacter.sourceText, "\uFFFD");
});

test("applies NUL policy only after strict decode and leading-BOM handling", () => {
  assert.deepEqual(applyRawInputProfile(Uint8Array.of(0x00)), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 0, rawByteLength: 1, line: 1, column: 1 },
  });

  assert.deepEqual(applyRawInputProfile(concatenate(UTF8_BOM, Uint8Array.of(0x00))), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 3, rawByteLength: 1, line: 1, column: 1 },
  });

  assert.deepEqual(applyRawInputProfile(concatenate(Uint8Array.of(0x00), UTF8_BOM)), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 0, rawByteLength: 1, line: 1, column: 1 },
  });

  assert.deepEqual(applyRawInputProfile(concatenate(UTF8_BOM, UTF8_BOM, Uint8Array.of(0x00))), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 6, rawByteLength: 1, line: 1, column: 2 },
  });

  assertRefusal(applyRawInputProfile(Uint8Array.of(0x80, 0x00)), "invalid_utf8");
});

test("retains the first NUL location in raw bytes and Unicode scalar columns", () => {
  assert.deepEqual(applyRawInputProfile(encoder.encode("é\r\nx\0")), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 5, rawByteLength: 1, line: 2, column: 2 },
  });

  assert.deepEqual(applyRawInputProfile(encoder.encode("😀\0")), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 4, rawByteLength: 1, line: 1, column: 2 },
  });

  assert.deepEqual(applyRawInputProfile(encoder.encode("A\rB\0")), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 3, rawByteLength: 1, line: 2, column: 2 },
  });

  assert.deepEqual(applyRawInputProfile(encoder.encode("A\nB\0")), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 3, rawByteLength: 1, line: 2, column: 2 },
  });

  assert.deepEqual(applyRawInputProfile(encoder.encode("A\0B\0")), {
    kind: "refused",
    refusalId: "nul_byte_not_in_profile",
    location: { rawByteOffset: 1, rawByteLength: 1, line: 1, column: 2 },
  });
});

test("preserves normalization forms, whitespace, and line endings", () => {
  const composed = expectAccepted(applyRawInputProfile(encoder.encode("é")));
  const decomposed = expectAccepted(applyRawInputProfile(encoder.encode("e\u0301")));
  assert.equal(composed.sourceText, "é");
  assert.equal(decomposed.sourceText, "e\u0301");
  assert.notEqual(composed.sourceText, decomposed.sourceText);
  assert.notDeepEqual(composed.rawBytes, decomposed.rawBytes);

  const preserved = " \tA\rB\nC\r\nD \n";
  const accepted = expectAccepted(applyRawInputProfile(encoder.encode(preserved)));
  assert.equal(accepted.sourceText, preserved);
});

test("snapshots exact Uint8Array views without mutating or retaining caller storage", () => {
  const input = Uint8Array.of(0x41, 0x42, 0x43);
  const before = new Uint8Array(input);
  const accepted = expectAccepted(applyRawInputProfile(input));
  assert.deepEqual(input, before);
  assert.notStrictEqual(accepted.rawBytes, input);

  input[0] = 0x58;
  assert.deepEqual(accepted.rawBytes, Uint8Array.of(0x41, 0x42, 0x43));

  const backing = Uint8Array.of(0x80, 0x44, 0x45, 0x80);
  const view = backing.subarray(1, 3);
  const acceptedView = expectAccepted(applyRawInputProfile(view));
  assert.deepEqual(acceptedView.rawBytes, Uint8Array.of(0x44, 0x45));
  assert.equal(acceptedView.sourceText, "DE");
  backing[1] = 0x59;
  assert.deepEqual(acceptedView.rawBytes, Uint8Array.of(0x44, 0x45));

  const bufferBacking = Buffer.from([0x80, 0x46, 0x47, 0x80]);
  const bufferView = bufferBacking.subarray(1, 3);
  const acceptedBuffer = expectAccepted(applyRawInputProfile(bufferView));
  assert.equal(Buffer.isBuffer(acceptedBuffer.rawBytes), false);
  assert.deepEqual(acceptedBuffer.rawBytes, Uint8Array.of(0x46, 0x47));
  bufferBacking[1] = 0x5a;
  assert.deepEqual(acceptedBuffer.rawBytes, Uint8Array.of(0x46, 0x47));
});

test("does not mutate refused input and returns deterministic repeated results", () => {
  const invalid = Uint8Array.of(0xe2, 0x28, 0xa1);
  const invalidBefore = new Uint8Array(invalid);
  const firstInvalid = applyRawInputProfile(invalid);
  const secondInvalid = applyRawInputProfile(invalid);
  assert.deepEqual(invalid, invalidBefore);
  assert.deepEqual(firstInvalid, secondInvalid);

  const input = encoder.encode("stable\r\ntext");
  const first = expectAccepted(applyRawInputProfile(input));
  const second = expectAccepted(applyRawInputProfile(input));
  assert.deepEqual(first, second);
  assert.notStrictEqual(first.rawBytes, second.rawBytes);
});
