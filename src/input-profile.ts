import { utf8ByteWidth } from "./utf8.js";

export const MAX_RAW_INPUT_BYTES = 262_144;

const UTF8_BOM_LENGTH = 3;

type NulLocation = {
  rawByteOffset: number;
  rawByteLength: 1;
  line: number;
  column: number;
};

export type RawInputRefusalId = "input_too_large" | "invalid_utf8" | "nul_byte_not_in_profile";

export type AcceptedRawInput = {
  kind: "accepted";
  rawBytes: Uint8Array;
  sourceText: string;
};

export type RawInputResult =
  | AcceptedRawInput
  | {
      kind: "refused";
      refusalId: "input_too_large" | "invalid_utf8";
    }
  | {
      kind: "refused";
      refusalId: "nul_byte_not_in_profile";
      location: NulLocation;
    };

export function applyRawInputProfile(input: Uint8Array): RawInputResult {
  if (input.byteLength > MAX_RAW_INPUT_BYTES) {
    return { kind: "refused", refusalId: "input_too_large" };
  }

  const rawBytes = new Uint8Array(input);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  let decodedText: string;
  try {
    decodedText = decoder.decode(rawBytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return { kind: "refused", refusalId: "invalid_utf8" };
    }

    throw error;
  }

  const hasLeadingBom = startsWithUtf8Bom(rawBytes);
  const sourceText = hasLeadingBom ? decodedText.slice(1) : decodedText;
  const nulLocation = findNulLocation(sourceText, hasLeadingBom ? UTF8_BOM_LENGTH : 0);

  if (nulLocation !== undefined) {
    return {
      kind: "refused",
      refusalId: "nul_byte_not_in_profile",
      location: nulLocation,
    };
  }

  return { kind: "accepted", rawBytes, sourceText };
}

function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function findNulLocation(sourceText: string, sourceRawByteOffset: number): NulLocation | undefined {
  let rawByteOffset = sourceRawByteOffset;
  let line = 1;
  let column = 1;
  let previousWasCarriageReturn = false;

  for (const scalar of sourceText) {
    if (scalar === "\0") {
      return { rawByteOffset, rawByteLength: 1, line, column };
    }

    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("Decoded scalar unexpectedly had no code point.");
    }

    rawByteOffset += utf8ByteWidth(codePoint);

    if (scalar === "\r") {
      line += 1;
      column = 1;
      previousWasCarriageReturn = true;
    } else if (scalar === "\n") {
      if (!previousWasCarriageReturn) {
        line += 1;
      }
      column = 1;
      previousWasCarriageReturn = false;
    } else {
      column += 1;
      previousWasCarriageReturn = false;
    }
  }

  return undefined;
}
