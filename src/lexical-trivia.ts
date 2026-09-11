import type { SourceCursor, SourceLocation } from "./source-cursor.js";

export type LexicalTriviaResult =
  | { kind: "ok" }
  | {
      kind: "refused";
      refusalId: "unterminated_block_comment";
      location: SourceLocation;
    };

export function consumeLexicalTrivia(cursor: SourceCursor): LexicalTriviaResult {
  for (;;) {
    const scalar = cursor.peek();

    if (scalar === null) {
      return { kind: "ok" };
    }

    if (isWhitespace(scalar)) {
      cursor.advance();
      continue;
    }

    if (scalar === "-" && cursor.peekNext() === "-") {
      consumeLineComment(cursor);
      continue;
    }

    if (scalar === "/" && cursor.peekNext() === "*") {
      const refusal = consumeBlockComment(cursor);
      if (refusal !== null) {
        return refusal;
      }
      continue;
    }

    return { kind: "ok" };
  }
}

function consumeLineComment(cursor: SourceCursor): void {
  cursor.advance();
  cursor.advance();

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null || scalar === "\r" || scalar === "\n") {
      return;
    }
    cursor.advance();
  }
}

function consumeBlockComment(cursor: SourceCursor): LexicalTriviaResult | null {
  const location = cursor.position();
  let depth = 1;

  cursor.advance();
  cursor.advance();

  for (;;) {
    const scalar = cursor.peek();
    if (scalar === null) {
      return {
        kind: "refused",
        refusalId: "unterminated_block_comment",
        location,
      };
    }

    if (scalar === "/" && cursor.peekNext() === "*") {
      cursor.advance();
      cursor.advance();
      depth += 1;
      continue;
    }

    if (scalar === "*" && cursor.peekNext() === "/") {
      cursor.advance();
      cursor.advance();
      depth -= 1;

      if (depth === 0) {
        return null;
      }
      continue;
    }

    cursor.advance();
  }
}

function isWhitespace(scalar: string): boolean {
  return scalar === "\t" || scalar === "\f" || scalar === "\n" || scalar === "\r" || scalar === " ";
}
