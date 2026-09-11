import type { AcceptedRawInput } from "./input-profile.js";
import { utf8ByteWidth } from "./utf8.js";

const UTF8_BOM_LENGTH = 3;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

export type SourceLocation = {
  readonly rawByteOffset: number;
  readonly line: number;
  readonly column: number;
};

export interface SourceCursor {
  atEnd(): boolean;
  peek(): string | null;
  peekNext(): string | null;
  peekSecondNext(): string | null;
  advance(): string | null;
  position(): SourceLocation;
}

export function createSourceCursor(input: AcceptedRawInput): SourceCursor {
  const rawByteLength = input.rawBytes.byteLength;
  const initialRawByteOffset = startsWithUtf8Bom(input.rawBytes) ? UTF8_BOM_LENGTH : 0;

  return new Cursor(input.sourceText, rawByteLength, initialRawByteOffset);
}

class Cursor implements SourceCursor {
  readonly #sourceText: string;
  readonly #rawByteLength: number;
  #codeUnitIndex = 0;
  #rawByteOffset: number;
  #line = 1;
  #column = 1;

  constructor(sourceText: string, rawByteLength: number, initialRawByteOffset: number) {
    this.#sourceText = sourceText;
    this.#rawByteLength = rawByteLength;
    this.#rawByteOffset = initialRawByteOffset;

    if (
      initialRawByteOffset > rawByteLength ||
      (sourceText.length === 0 && initialRawByteOffset !== rawByteLength)
    ) {
      throwInvariantError();
    }
  }

  atEnd(): boolean {
    return this.#codeUnitIndex === this.#sourceText.length;
  }

  peek(): string | null {
    if (this.atEnd()) {
      return null;
    }

    return String.fromCodePoint(this.currentCodePoint());
  }

  peekNext(): string | null {
    if (this.atEnd()) {
      return null;
    }

    const currentCodePoint = this.currentCodePoint();
    const nextCodeUnitIndex = this.#codeUnitIndex + (currentCodePoint > 0xffff ? 2 : 1);
    const nextCodePoint = this.#sourceText.codePointAt(nextCodeUnitIndex);

    return nextCodePoint === undefined ? null : String.fromCodePoint(nextCodePoint);
  }

  peekSecondNext(): string | null {
    if (this.atEnd()) {
      return null;
    }

    const currentCodePoint = this.currentCodePoint();
    const nextCodeUnitIndex = this.#codeUnitIndex + (currentCodePoint > 0xffff ? 2 : 1);
    const nextCodePoint = this.#sourceText.codePointAt(nextCodeUnitIndex);
    if (nextCodePoint === undefined) {
      return null;
    }

    const secondNextCodeUnitIndex = nextCodeUnitIndex + (nextCodePoint > 0xffff ? 2 : 1);
    const secondNextCodePoint = this.#sourceText.codePointAt(secondNextCodeUnitIndex);

    return secondNextCodePoint === undefined ? null : String.fromCodePoint(secondNextCodePoint);
  }

  advance(): string | null {
    if (this.atEnd()) {
      return null;
    }

    const codePoint = this.currentCodePoint();
    const scalar = String.fromCodePoint(codePoint);
    const nextCodeUnitIndex = this.#codeUnitIndex + (codePoint > 0xffff ? 2 : 1);
    const nextRawByteOffset = this.#rawByteOffset + utf8ByteWidth(codePoint);

    if (
      nextCodeUnitIndex > this.#sourceText.length ||
      nextRawByteOffset > this.#rawByteLength ||
      (nextCodeUnitIndex === this.#sourceText.length && nextRawByteOffset !== this.#rawByteLength)
    ) {
      throwInvariantError();
    }

    if (codePoint === CARRIAGE_RETURN) {
      this.#line += 1;
      this.#column = 1;
    } else if (codePoint === LINE_FEED) {
      const followsCarriageReturn =
        this.#codeUnitIndex > 0 &&
        this.#sourceText.charCodeAt(this.#codeUnitIndex - 1) === CARRIAGE_RETURN;
      if (!followsCarriageReturn) {
        this.#line += 1;
      }
      this.#column = 1;
    } else {
      this.#column += 1;
    }

    this.#codeUnitIndex = nextCodeUnitIndex;
    this.#rawByteOffset = nextRawByteOffset;

    return scalar;
  }

  position(): SourceLocation {
    return {
      rawByteOffset: this.#rawByteOffset,
      line: this.#line,
      column: this.#column,
    };
  }

  private currentCodePoint(): number {
    const codePoint = this.#sourceText.codePointAt(this.#codeUnitIndex);
    if (codePoint === undefined) {
      throwInvariantError();
    }
    return codePoint;
  }
}

function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function throwInvariantError(): never {
  throw new Error("Source cursor invariant violated.");
}
