import type { SourceSpan } from "./create-table-token-source.js";
import type { MigrationDocumentIndex, MigrationStatement } from "./migration-document.js";
import { normalizeStatementForV02 } from "./migration-normalization.js";

/** Map normalized evidence back to original document token boundaries, without rescanning SQL. */
export function createMigrationSource(
  index: MigrationDocumentIndex,
  included: readonly MigrationStatement[],
) {
  let offset = 0;
  const chunks = included.map((statement) => {
    const normalized = normalizeStatementForV02(index.input, statement);
    const start = offset;
    offset += normalized.bytes.length + 1;
    return { statement, normalized, start, end: offset - 1 };
  });
  function originalOffset(projected: number, end: boolean): number {
    const chunk = chunks.find((c) => projected >= c.start && projected <= c.end);
    if (chunk === undefined) throw new Error("Projected evidence source invariant");
    let local = projected - chunk.start + chunk.statement.span.start.rawByteOffset;
    let delta = 0;
    for (const replacement of chunk.normalized.replacements) {
      const at = replacement.start + delta;
      if (local < at || (!end && local === at && replacement.byteLength > 0)) break;
      if (local < at + replacement.byteLength || (end && local === at + replacement.byteLength)) {
        return end ? replacement.end : replacement.start;
      }
      delta += replacement.byteLength - (replacement.end - replacement.start);
    }
    local -= delta;
    return local;
  }
  function location(rawByteOffset: number, end: boolean) {
    const chunk = chunks.find(
      (c) =>
        rawByteOffset >= c.statement.span.start.rawByteOffset &&
        rawByteOffset <= c.statement.span.end.rawByteOffset,
    );
    if (chunk === undefined) throw new Error("Original evidence source invariant");
    const tokens = chunk.statement.tokens;
    let low = 0;
    let high = tokens.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((tokens[mid]?.span.start.rawByteOffset ?? Infinity) <= rawByteOffset) low = mid;
      else high = mid - 1;
    }
    const token = tokens[low];
    if (token === undefined) throw new Error("Original source token invariant");
    if (token.span.start.rawByteOffset === rawByteOffset) return token.span.start;
    if (token.span.end.rawByteOffset === rawByteOffset) return token.span.end;
    // Spans are token aligned; only a normalized replacement can cover an interior boundary.
    return end ? token.span.end : token.span.start;
  }
  function span(projected: SourceSpan): SourceSpan {
    return {
      start: location(originalOffset(projected.start.rawByteOffset, false), false),
      end: location(originalOffset(projected.end.rawByteOffset, true), true),
    };
  }
  return {
    span,
    text(projected: SourceSpan): string {
      const source = span(projected);
      return new TextDecoder().decode(
        index.input.rawBytes.subarray(source.start.rawByteOffset, source.end.rawByteOffset),
      );
    },
  };
}
