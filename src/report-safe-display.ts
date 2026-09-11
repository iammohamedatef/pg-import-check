import type { IdentifierIdentity, QualifiedIdentity } from "./create-table-parser-primitives.js";

const MAX_PREVIEW_SCALARS = 64;
const MAX_PREVIEW_RENDERED_BYTES = 256;
const TRUNCATION_MARKER = "...";

const UNSAFE_IDENTIFIER_RANGES = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
  [0xfdd0, 0xfdef],
] as const;

const NON_ASCII_WHITESPACE_RANGES = [
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
] as const;

const TRUSTED_STRUCTURAL_GLYPHS = new Set(["→", "⚠", "—", "✕", "·"]);

export function displayIdentifier(identifier: IdentifierIdentity): string {
  const identity = identifier.quoted
    ? identifier.identity
    : foldAsciiUppercase(identifier.identity);
  const displayed = renderScalars(identity, identifier.quoted ? "identifier" : "fragment");
  return identifier.quoted ? `"${displayed}"` : displayed;
}

export function displayQualifiedIdentity(identity: QualifiedIdentity): string {
  const local = displayIdentifier(identity.local);
  if (identity.qualifier === null) {
    return `${local} (schema not declared)`;
  }
  return `${displayIdentifier(identity.qualifier)}.${local}`;
}

/** sourceRemains marks a scalar-aligned bounded prefix of a longer accepted fragment. */
export function displayDiagnosticPreview(fragment: string, sourceRemains = false): string {
  const rendered: { readonly value: string; readonly byteLength: number }[] = [];
  let renderedBytes = 0;
  let scalarCount = 0;
  let codeUnitIndex = 0;

  while (codeUnitIndex < fragment.length && scalarCount < MAX_PREVIEW_SCALARS) {
    const codePoint = fragment.codePointAt(codeUnitIndex);
    if (codePoint === undefined) {
      throw new Error("Report preview unexpectedly had no code point.");
    }
    const scalar = String.fromCodePoint(codePoint);
    const value = renderScalar(scalar, "diagnostic");
    const byteLength = utf8Length(value);
    if (renderedBytes + byteLength > MAX_PREVIEW_RENDERED_BYTES) {
      break;
    }
    rendered.push({ value, byteLength });
    renderedBytes += byteLength;
    scalarCount += 1;
    codeUnitIndex += codePoint > 0xffff ? 2 : 1;
  }

  const truncated = sourceRemains || codeUnitIndex < fragment.length;
  if (!truncated) {
    return rendered.map(({ value }) => value).join("");
  }

  const contentByteLimit = MAX_PREVIEW_RENDERED_BYTES - utf8Length(TRUNCATION_MARKER);
  while (renderedBytes > contentByteLimit) {
    const removed = rendered.pop();
    if (removed === undefined) {
      throw new Error("Report preview truncation invariant violated.");
    }
    renderedBytes -= removed.byteLength;
  }
  return `${rendered.map(({ value }) => value).join("")}${TRUNCATION_MARKER}`;
}

export function isReportUnsafeIdentifierCodePoint(codePoint: number): boolean {
  return isInRanges(codePoint, UNSAFE_IDENTIFIER_RANGES) || (codePoint & 0xffff) >= 0xfffe;
}

function renderScalars(value: string, context: "identifier" | "fragment"): string {
  return [...value].map((scalar) => renderScalar(scalar, context)).join("");
}

function renderScalar(scalar: string, context: "identifier" | "fragment" | "diagnostic"): string {
  if (scalar === "\\") {
    return "\\\\";
  }
  if (scalar === '"' && context === "diagnostic") {
    return '\\"';
  }
  if (scalar === '"' && context === "identifier") {
    return '""';
  }
  if (scalar === "\n") {
    return "\\n";
  }
  if (scalar === "\r") {
    return "\\r";
  }
  if (scalar === "\t") {
    return "\\t";
  }

  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined) {
    throw new Error("Report scalar unexpectedly had no code point.");
  }
  if (
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    isReportUnsafeIdentifierCodePoint(codePoint) ||
    isInRanges(codePoint, NON_ASCII_WHITESPACE_RANGES) ||
    TRUSTED_STRUCTURAL_GLYPHS.has(scalar)
  ) {
    return `\\u{${codePoint.toString(16).toUpperCase()}}`;
  }
  return scalar;
}

function foldAsciiUppercase(value: string): string {
  let folded = "";
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("Report scalar unexpectedly had no code point.");
    }
    folded +=
      codePoint >= 0x41 && codePoint <= 0x5a ? String.fromCodePoint(codePoint + 0x20) : scalar;
  }
  return folded;
}

function isInRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function utf8Length(value: string): number {
  let length = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("Report scalar unexpectedly had no code point.");
    }
    if (codePoint <= 0x7f) {
      length += 1;
    } else if (codePoint <= 0x7ff) {
      length += 2;
    } else if (codePoint <= 0xffff) {
      length += 3;
    } else {
      length += 4;
    }
  }
  return length;
}
