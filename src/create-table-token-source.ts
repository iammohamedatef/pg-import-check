import type { AcceptedRawInput } from "./input-profile.js";
import { consumeLexicalTrivia } from "./lexical-trivia.js";
import { createSourceCursor, type SourceCursor, type SourceLocation } from "./source-cursor.js";
import { utf8ByteWidth } from "./utf8.js";

export const MAX_IDENTIFIER_BYTES = 63;
const ASCII_OPERATOR_CHARACTERS = "+-*/<>=~!@#%^&|`?:";
const ASCII_PUNCTUATION = "()[],.;";
const ACCEPTED_WHITESPACE = "\t\f\n\r ";

type Punctuation = "(" | ")" | "[" | "]" | "," | "." | ";";

export type SourceSpan = {
  readonly start: SourceLocation;
  readonly end: SourceLocation;
};

export type CreateTableToken =
  | {
      readonly kind: "word";
      readonly folded: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "quoted_identifier";
      readonly identity: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "standard_string";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "escape_string";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "dollar_quoted";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "numeric";
      readonly isUnsignedInteger: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "punctuation";
      readonly value: Punctuation;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "operator";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "dollar_position";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "contextual_issue";
      readonly issue: "non_ascii_at_token_start";
      readonly span: SourceSpan;
    };

type SimpleLexicalRefusalId =
  | "unterminated_block_comment"
  | "unterminated_string"
  | "unterminated_quoted_identifier"
  | "unterminated_dollar_quote"
  | "unexpected_bom"
  | "unquoted_non_ascii_identifier"
  | "identifier_contains_unsafe_character"
  | "unicode_escape_syntax_not_in_profile"
  | "syntax_not_in_profile";

export type LexicalRefusal =
  | {
      readonly refusalId: SimpleLexicalRefusalId;
      readonly span: SourceSpan;
    }
  | {
      readonly refusalId: "identifier_outside_profile";
      readonly actualUtf8ByteLength: number;
      readonly span: SourceSpan;
    };

export type TokenSourceStep =
  | {
      readonly kind: "token";
      readonly token: CreateTableToken;
    }
  | {
      readonly kind: "eof";
      readonly location: SourceLocation;
    }
  | {
      readonly kind: "refused";
      readonly refusal: LexicalRefusal;
    };

export interface CreateTableTokenSource {
  next(): TokenSourceStep;
}

export function contextualRefusalForDemand(
  tokenValue: CreateTableToken,
  demand: "identifier" | "opaque",
): LexicalRefusal | null {
  if (tokenValue.kind === "contextual_issue") {
    return {
      refusalId:
        demand === "identifier" ? "unquoted_non_ascii_identifier" : "syntax_not_in_profile",
      span: tokenValue.span,
    };
  }

  if (
    demand === "identifier" &&
    tokenValue.kind === "word" &&
    tokenValue.folded.length > MAX_IDENTIFIER_BYTES
  ) {
    return {
      refusalId: "identifier_outside_profile",
      actualUtf8ByteLength: tokenValue.folded.length,
      span: tokenValue.span,
    };
  }

  return null;
}

export function createTableTokenSource(input: AcceptedRawInput): CreateTableTokenSource {
  return new TokenSource(createSourceCursor(input));
}

class TokenSource implements CreateTableTokenSource {
  readonly #cursor: SourceCursor;
  #terminal: TokenSourceStep | null = null;

  constructor(cursor: SourceCursor) {
    this.#cursor = cursor;
  }

  next(): TokenSourceStep {
    if (this.#terminal !== null) {
      return this.#terminal;
    }

    const trivia = consumeLexicalTrivia(this.#cursor);
    if (trivia.kind === "refused") {
      return this.finish({
        kind: "refused",
        refusal: {
          refusalId: trivia.refusalId,
          span: span(trivia.location, this.#cursor.position()),
        },
      });
    }

    const scalar = this.#cursor.peek();
    if (scalar === null) {
      return this.finish({ kind: "eof", location: this.#cursor.position() });
    }

    const step = scanToken(this.#cursor, scalar);
    if (step.kind === "refused") {
      return this.finish(step);
    }
    return step;
  }

  private finish(step: TokenSourceStep): TokenSourceStep {
    this.#terminal = step;
    return step;
  }
}

function scanToken(cursor: SourceCursor, scalar: string): TokenSourceStep {
  if (scalar === "\uFEFF") {
    return refuseSingleScalar(cursor, "unexpected_bom");
  }

  if ((scalar === "E" || scalar === "e") && cursor.peekNext() === "'") {
    return scanEscapeString(cursor);
  }

  if (isAsciiWordStart(scalar)) {
    return scanWord(cursor);
  }

  if (scalar === '"') {
    return scanQuotedIdentifier(cursor);
  }

  if (scalar === "'") {
    return scanStandardString(cursor);
  }

  if (scalar === "$") {
    return scanDollarStart(cursor);
  }

  if (isAsciiDigit(scalar) || (scalar === "." && isAsciiDigit(cursor.peekNext()))) {
    return scanNumeric(cursor);
  }

  if (isPunctuation(scalar)) {
    const start = cursor.position();
    cursor.advance();
    return token({ kind: "punctuation", value: scalar, span: spanToCursor(start, cursor) });
  }

  if (isOperatorCharacter(scalar)) {
    return scanOperator(cursor);
  }

  if (isNonAscii(scalar)) {
    const start = cursor.position();
    consumeUnsupportedFragment(cursor);
    return token({
      kind: "contextual_issue",
      issue: "non_ascii_at_token_start",
      span: spanToCursor(start, cursor),
    });
  }

  return refuseUnsupportedFragment(cursor);
}

function scanWord(cursor: SourceCursor): TokenSourceStep {
  const start = cursor.position();
  const foldedParts: string[] = [];

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null || !isAsciiWordContinuation(scalar)) {
      break;
    }

    cursor.advance();
    foldedParts.push(foldAsciiLetter(scalar));
  }

  const next = cursor.peek();
  if (next === "\uFEFF") {
    return refuseSingleScalar(cursor, "unexpected_bom");
  }
  if (next !== null && isNonAscii(next)) {
    const nonAsciiStart = cursor.position();
    consumeUnsupportedFragment(cursor);
    return refused({
      refusalId: "unquoted_non_ascii_identifier",
      span: spanToCursor(nonAsciiStart, cursor),
    });
  }

  const folded = foldedParts.join("");
  if (
    folded === "u" &&
    cursor.peek() === "&" &&
    (cursor.peekNext() === '"' || cursor.peekNext() === "'")
  ) {
    cursor.advance();
    return refused({
      refusalId: "unicode_escape_syntax_not_in_profile",
      span: spanToCursor(start, cursor),
    });
  }

  return token({ kind: "word", folded, span: spanToCursor(start, cursor) });
}

function scanQuotedIdentifier(cursor: SourceCursor): TokenSourceStep {
  const opening = cursor.position();
  const identityParts: string[] = [];
  let identityByteLength = 0;

  cursor.advance();

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null) {
      return refused({
        refusalId: "unterminated_quoted_identifier",
        span: spanToCursor(opening, cursor),
      });
    }

    if (scalar === '"') {
      if (cursor.peekNext() === '"') {
        cursor.advance();
        cursor.advance();
        identityByteLength += 1;
        if (identityByteLength <= MAX_IDENTIFIER_BYTES) {
          identityParts.push('"');
        }
        continue;
      }

      cursor.advance();
      if (identityByteLength === 0) {
        return refused({
          refusalId: "syntax_not_in_profile",
          span: spanToCursor(opening, cursor),
        });
      }
      if (identityByteLength > MAX_IDENTIFIER_BYTES) {
        return refused({
          refusalId: "identifier_outside_profile",
          actualUtf8ByteLength: identityByteLength,
          span: spanToCursor(opening, cursor),
        });
      }
      return token({
        kind: "quoted_identifier",
        identity: identityParts.join(""),
        span: spanToCursor(opening, cursor),
      });
    }

    const scalarLocation = cursor.position();
    cursor.advance();
    const codePoint = codePointOf(scalar);
    if (isUnsafeIdentifierCodePoint(codePoint)) {
      return refused({
        refusalId: "identifier_contains_unsafe_character",
        span: span(scalarLocation, cursor.position()),
      });
    }

    identityByteLength += utf8ByteWidth(codePoint);
    if (identityByteLength <= MAX_IDENTIFIER_BYTES) {
      identityParts.push(scalar);
    }
  }
}

function scanStandardString(cursor: SourceCursor): TokenSourceStep {
  const opening = cursor.position();
  cursor.advance();

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null) {
      return refused({
        refusalId: "unterminated_string",
        span: spanToCursor(opening, cursor),
      });
    }

    if (scalar === "'") {
      cursor.advance();
      if (cursor.peek() === "'") {
        cursor.advance();
        continue;
      }
      return token({ kind: "standard_string", span: spanToCursor(opening, cursor) });
    }

    cursor.advance();
  }
}

function scanEscapeString(cursor: SourceCursor): TokenSourceStep {
  const opening = cursor.position();
  cursor.advance();
  cursor.advance();

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null) {
      return refused({
        refusalId: "unterminated_string",
        span: spanToCursor(opening, cursor),
      });
    }

    if (scalar === "\\") {
      cursor.advance();
      if (!cursor.atEnd()) {
        cursor.advance();
      }
      continue;
    }

    if (scalar === "'") {
      cursor.advance();
      if (cursor.peek() === "'") {
        cursor.advance();
        continue;
      }
      return token({ kind: "escape_string", span: spanToCursor(opening, cursor) });
    }

    cursor.advance();
  }
}

function scanDollarStart(cursor: SourceCursor): TokenSourceStep {
  const opening = cursor.position();
  const delimiter: string[] = ["$"];

  cursor.advance();
  const next = cursor.peek();

  if (next === "\uFEFF") {
    return refuseSingleScalar(cursor, "unexpected_bom");
  }

  if (next === "$") {
    delimiter.push("$");
    cursor.advance();
    return scanDollarBody(cursor, opening, delimiter);
  }

  if (next !== null && isAsciiTagStart(next)) {
    for (;;) {
      const scalar = cursor.peek();
      if (scalar === null || !isAsciiTagContinuation(scalar)) {
        break;
      }
      delimiter.push(scalar);
      cursor.advance();
    }

    if (cursor.peek() === "$") {
      delimiter.push("$");
      cursor.advance();
      return scanDollarBody(cursor, opening, delimiter);
    }

    if (cursor.peek() === "\uFEFF") {
      return refuseSingleScalar(cursor, "unexpected_bom");
    }
    consumeUnsupportedFragment(cursor);
    return refused({
      refusalId: "syntax_not_in_profile",
      span: spanToCursor(opening, cursor),
    });
  }

  if (isAsciiDigit(next)) {
    consumeAsciiDigits(cursor);
    return token({ kind: "dollar_position", span: spanToCursor(opening, cursor) });
  }

  consumeUnsupportedFragment(cursor);
  return refused({
    refusalId: "syntax_not_in_profile",
    span: spanToCursor(opening, cursor),
  });
}

function scanDollarBody(
  cursor: SourceCursor,
  opening: SourceLocation,
  delimiter: readonly string[],
): TokenSourceStep {
  const prefixLengths = buildPrefixLengths(delimiter);
  let matchedLength = 0;

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null) {
      return refused({
        refusalId: "unterminated_dollar_quote",
        span: spanToCursor(opening, cursor),
      });
    }

    while (matchedLength > 0 && scalar !== delimiter[matchedLength]) {
      matchedLength = prefixLengthAt(prefixLengths, matchedLength - 1);
    }
    if (scalar === delimiter[matchedLength]) {
      matchedLength += 1;
    }

    cursor.advance();
    if (matchedLength === delimiter.length) {
      return token({ kind: "dollar_quoted", span: spanToCursor(opening, cursor) });
    }
  }
}

function buildPrefixLengths(pattern: readonly string[]): Uint32Array {
  const prefixLengths = new Uint32Array(pattern.length);
  let matchedLength = 0;

  for (let index = 1; index < pattern.length; index += 1) {
    const scalar = pattern[index];
    if (scalar === undefined) {
      throwInvariantError();
    }

    while (matchedLength > 0 && scalar !== pattern[matchedLength]) {
      matchedLength = prefixLengthAt(prefixLengths, matchedLength - 1);
    }
    if (scalar === pattern[matchedLength]) {
      matchedLength += 1;
    }
    prefixLengths[index] = matchedLength;
  }

  return prefixLengths;
}

function prefixLengthAt(prefixLengths: Uint32Array, index: number): number {
  const length = prefixLengths[index];
  if (length === undefined) {
    throwInvariantError();
  }
  return length;
}

function scanNumeric(cursor: SourceCursor): TokenSourceStep {
  const start = cursor.position();
  const startedWithDigit = isAsciiDigit(cursor.peek());
  let hasDecimalPoint = false;
  let hasExponent = false;

  if (startedWithDigit) {
    consumeAsciiDigits(cursor);
    if (cursor.peek() === ".") {
      hasDecimalPoint = true;
      cursor.advance();
      consumeAsciiDigits(cursor);
    }
  } else {
    hasDecimalPoint = true;
    cursor.advance();
    consumeAsciiDigits(cursor);
  }

  if (hasValidExponent(cursor)) {
    hasExponent = true;
    cursor.advance();
    if (cursor.peek() === "+" || cursor.peek() === "-") {
      cursor.advance();
    }
    consumeAsciiDigits(cursor);
  }

  return token({
    kind: "numeric",
    isUnsignedInteger: startedWithDigit && !hasDecimalPoint && !hasExponent,
    span: spanToCursor(start, cursor),
  });
}

function hasValidExponent(cursor: SourceCursor): boolean {
  const scalar = cursor.peek();
  if (scalar !== "e" && scalar !== "E") {
    return false;
  }

  const next = cursor.peekNext();
  if (isAsciiDigit(next)) {
    return true;
  }
  return (next === "+" || next === "-") && isAsciiDigit(cursor.peekSecondNext());
}

function scanOperator(cursor: SourceCursor): TokenSourceStep {
  const start = cursor.position();
  const parts: string[] = [];

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null || !isOperatorCharacter(scalar) || beginsComment(cursor, scalar)) {
      break;
    }
    parts.push(scalar);
    cursor.advance();
  }

  if (parts.length === 0) {
    throwInvariantError();
  }
  return token({ kind: "operator", value: parts.join(""), span: spanToCursor(start, cursor) });
}

function beginsComment(cursor: SourceCursor, scalar: string): boolean {
  return (
    (scalar === "-" && cursor.peekNext() === "-") || (scalar === "/" && cursor.peekNext() === "*")
  );
}

function consumeAsciiDigits(cursor: SourceCursor): void {
  while (isAsciiDigit(cursor.peek())) {
    cursor.advance();
  }
}

function consumeUnsupportedFragment(cursor: SourceCursor): void {
  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null || scalar === ";" || isAcceptedWhitespace(scalar)) {
      return;
    }
    cursor.advance();
  }
}

function refuseSingleScalar(
  cursor: SourceCursor,
  refusalId: SimpleLexicalRefusalId,
): TokenSourceStep {
  const start = cursor.position();
  cursor.advance();
  return refused({ refusalId, span: spanToCursor(start, cursor) });
}

function refuseUnsupportedFragment(cursor: SourceCursor): TokenSourceStep {
  const start = cursor.position();
  consumeUnsupportedFragment(cursor);
  if (cursor.position().rawByteOffset === start.rawByteOffset) {
    throwInvariantError();
  }
  return refused({
    refusalId: "syntax_not_in_profile",
    span: spanToCursor(start, cursor),
  });
}

function refused(refusal: LexicalRefusal): TokenSourceStep {
  return { kind: "refused", refusal };
}

function token(tokenValue: CreateTableToken): TokenSourceStep {
  return { kind: "token", token: tokenValue };
}

function spanToCursor(start: SourceLocation, cursor: SourceCursor): SourceSpan {
  return span(start, cursor.position());
}

function span(start: SourceLocation, end: SourceLocation): SourceSpan {
  return { start, end };
}

function isAsciiWordStart(scalar: string | null): scalar is string {
  return scalar === "_" || isAsciiLetter(scalar);
}

function isAsciiWordContinuation(scalar: string): boolean {
  return scalar === "$" || scalar === "_" || isAsciiLetter(scalar) || isAsciiDigit(scalar);
}

function isAsciiTagStart(scalar: string): boolean {
  return scalar === "_" || isAsciiLetter(scalar);
}

function isAsciiTagContinuation(scalar: string): boolean {
  return scalar === "_" || isAsciiLetter(scalar) || isAsciiDigit(scalar);
}

function isAsciiLetter(scalar: string | null): boolean {
  if (scalar === null || scalar.length !== 1) {
    return false;
  }
  const code = scalar.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(scalar: string | null): boolean {
  if (scalar === null || scalar.length !== 1) {
    return false;
  }
  const code = scalar.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

function foldAsciiLetter(scalar: string): string {
  const code = scalar.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCharCode(code + 0x20);
  }
  return scalar;
}

function isPunctuation(scalar: string): scalar is Punctuation {
  return ASCII_PUNCTUATION.includes(scalar);
}

function isOperatorCharacter(scalar: string): boolean {
  return ASCII_OPERATOR_CHARACTERS.includes(scalar);
}

function isAcceptedWhitespace(scalar: string): boolean {
  return ACCEPTED_WHITESPACE.includes(scalar);
}

function isNonAscii(scalar: string): boolean {
  return codePointOf(scalar) > 0x7f;
}

function codePointOf(scalar: string): number {
  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined) {
    throwInvariantError();
  }
  return codePoint;
}

function isUnsafeIdentifierCodePoint(codePoint: number): boolean {
  return (
    inRange(codePoint, 0x0000, 0x001f) ||
    inRange(codePoint, 0x007f, 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    inRange(codePoint, 0x0600, 0x0605) ||
    codePoint === 0x061c ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    inRange(codePoint, 0x0890, 0x0891) ||
    codePoint === 0x08e2 ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    inRange(codePoint, 0x180b, 0x180f) ||
    inRange(codePoint, 0x200b, 0x200f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    inRange(codePoint, 0x202a, 0x202e) ||
    inRange(codePoint, 0x2060, 0x206f) ||
    codePoint === 0x3164 ||
    inRange(codePoint, 0xfe00, 0xfe0f) ||
    codePoint === 0xfeff ||
    codePoint === 0xffa0 ||
    inRange(codePoint, 0xfff0, 0xfffb) ||
    codePoint === 0x110bd ||
    codePoint === 0x110cd ||
    inRange(codePoint, 0x13430, 0x1343f) ||
    inRange(codePoint, 0x1bca0, 0x1bca3) ||
    inRange(codePoint, 0x1d173, 0x1d17a) ||
    inRange(codePoint, 0xe0000, 0xe0fff) ||
    inRange(codePoint, 0xe000, 0xf8ff) ||
    inRange(codePoint, 0xf0000, 0xffffd) ||
    inRange(codePoint, 0x100000, 0x10fffd) ||
    inRange(codePoint, 0xfdd0, 0xfdef) ||
    (codePoint & 0xffff) >= 0xfffe
  );
}

function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function throwInvariantError(): never {
  throw new Error("CREATE TABLE token source invariant violated.");
}
