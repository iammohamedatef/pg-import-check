import type { AcceptedRawInput } from "./input-profile.js";
import { utf8ByteWidth } from "./utf8.js";

/**
 * v0.2 document admission is intentionally separate from the frozen v0.1
 * 262,144-byte per-target limit. This value is benchmark-gated before release.
 */
export const MAX_MIGRATION_DOCUMENT_BYTES = 2_097_152;

const UTF8_BOM_LENGTH = 3;

type NulLocation = {
  rawByteOffset: number;
  rawByteLength: 1;
  line: number;
  column: number;
};

export type MigrationInputRefusal =
  | { readonly refusalId: "document_input_too_large" }
  | { readonly refusalId: "invalid_utf8" }
  | { readonly refusalId: "nul_byte_not_in_profile"; readonly location: NulLocation };

export type MigrationInputResult =
  | { readonly kind: "accepted"; readonly input: AcceptedRawInput }
  | { readonly kind: "refused"; readonly refusal: MigrationInputRefusal };

export function applyMigrationInputProfile(input: Uint8Array): MigrationInputResult {
  if (input.byteLength > MAX_MIGRATION_DOCUMENT_BYTES) {
    return { kind: "refused", refusal: { refusalId: "document_input_too_large" } };
  }

  const rawBytes = new Uint8Array(input);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let decodedText: string;
  try {
    decodedText = decoder.decode(rawBytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return { kind: "refused", refusal: { refusalId: "invalid_utf8" } };
    }
    throw error;
  }

  const hasLeadingBom = startsWithUtf8Bom(rawBytes);
  const sourceText = hasLeadingBom ? decodedText.slice(1) : decodedText;
  const nulLocation = findNulLocation(sourceText, hasLeadingBom ? UTF8_BOM_LENGTH : 0);
  if (nulLocation !== undefined) {
    return {
      kind: "refused",
      refusal: { refusalId: "nul_byte_not_in_profile", location: nulLocation },
    };
  }

  return { kind: "accepted", input: { kind: "accepted", rawBytes, sourceText } };
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
    if (codePoint === undefined) throw new Error("Decoded scalar unexpectedly had no code point.");
    rawByteOffset += utf8ByteWidth(codePoint);

    if (scalar === "\r") {
      line += 1;
      column = 1;
      previousWasCarriageReturn = true;
    } else if (scalar === "\n") {
      if (!previousWasCarriageReturn) line += 1;
      column = 1;
      previousWasCarriageReturn = false;
    } else {
      column += 1;
      previousWasCarriageReturn = false;
    }
  }

  return undefined;
}
