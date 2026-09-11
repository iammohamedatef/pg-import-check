import assert from "node:assert/strict";

import {
  recognizeCreateTableCoreShape,
  type CoreColumnShape,
  type CreateTableCoreShapeResult,
} from "../src/create-table-core-shape.js";
import {
  createTableTokenSource,
  type LexicalRefusal,
  type SourceSpan,
} from "../src/create-table-token-source.js";
import {
  applyRawInputProfile,
  type AcceptedRawInput,
  type RawInputResult,
} from "../src/input-profile.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

type RecognizedResult = Extract<CreateTableCoreShapeResult, { kind: "recognized_core_shape" }>;
type GrammarMiss = Extract<
  CreateTableCoreShapeResult,
  { kind: "not_recognized_by_create_table_grammar" }
>;
type RefusedResult = Extract<CreateTableCoreShapeResult, { kind: "refused" }>;
type ConflictRefusal = Extract<
  RefusedResult["refusal"],
  { refusalId: "conflicting_column_declaration" }
>;
type AmbiguousRefusal = Extract<RefusedResult["refusal"], { refusalId: "ambiguous_declaration" }>;

export function expectAccepted(result: RawInputResult): AcceptedRawInput {
  if (result.kind !== "accepted") {
    assert.fail(`Expected accepted input, received ${result.refusalId}`);
  }
  return result;
}

export function acceptText(sourceText: string): AcceptedRawInput {
  return expectAccepted(applyRawInputProfile(encoder.encode(sourceText)));
}

export function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function recognizeText(sourceText: string): CreateTableCoreShapeResult {
  return recognizeCreateTableCoreShape(acceptText(sourceText));
}

export function expectRecognized(result: CreateTableCoreShapeResult): RecognizedResult {
  if (result.kind !== "recognized_core_shape") {
    assert.fail(`Expected recognized core shape, received ${result.kind}`);
  }
  return result;
}

export function expectMiss(result: CreateTableCoreShapeResult): GrammarMiss {
  if (result.kind !== "not_recognized_by_create_table_grammar") {
    assert.fail(`Expected CREATE TABLE grammar miss, received ${result.kind}`);
  }
  return result;
}

export function expectRefused(result: CreateTableCoreShapeResult): RefusedResult {
  if (result.kind !== "refused") {
    assert.fail(`Expected refusal, received ${result.kind}`);
  }
  return result;
}

export function expectConflict(result: CreateTableCoreShapeResult): ConflictRefusal {
  const { refusal } = expectRefused(result);
  if (refusal.refusalId !== "conflicting_column_declaration") {
    assert.fail(`Expected column conflict, received ${refusal.refusalId}`);
  }
  return refusal;
}

export function expectAmbiguous(result: CreateTableCoreShapeResult): AmbiguousRefusal {
  const { refusal } = expectRefused(result);
  if (refusal.refusalId !== "ambiguous_declaration") {
    assert.fail(`Expected declaration ambiguity, received ${refusal.refusalId}`);
  }
  return refusal;
}

export function expectUnbalanced(result: CreateTableCoreShapeResult): SourceSpan {
  const { refusal } = expectRefused(result);
  assert.equal(refusal.refusalId, "unbalanced_delimiter");
  return refusal.span;
}

export function expectUnexpectedToken(
  input: AcceptedRawInput,
  result: CreateTableCoreShapeResult,
): SourceSpan {
  const miss = expectMiss(result);
  if (miss.boundary.kind !== "unexpected_token") {
    assert.fail("Expected an unexpected-token boundary, received end of input");
  }
  assert.equal(miss.boundary.span.end.rawByteOffset > miss.boundary.span.start.rawByteOffset, true);
  assert.equal(miss.boundary.span.end.rawByteOffset <= input.rawBytes.byteLength, true);
  return miss.boundary.span;
}

export function expectEndOfInput(
  input: AcceptedRawInput,
  result: CreateTableCoreShapeResult,
): void {
  const miss = expectMiss(result);
  if (miss.boundary.kind !== "end_of_input") {
    assert.fail(`Expected end of input, received ${spanText(input, miss.boundary.span)}`);
  }
  assert.equal(miss.boundary.location.rawByteOffset, input.rawBytes.byteLength);
}

export function spanText(input: AcceptedRawInput, span: SourceSpan): string {
  return decoder.decode(input.rawBytes.subarray(span.start.rawByteOffset, span.end.rawByteOffset));
}

export function columnExpressionSpan(
  column: CoreColumnShape | undefined,
  kind: "check" | "default",
): SourceSpan | null {
  if (column === undefined) {
    return null;
  }
  for (const occurrence of column.clauseOccurrences) {
    if (
      (occurrence.kind === "check" || occurrence.kind === "default") &&
      occurrence.kind === kind
    ) {
      return occurrence.expressionSpan;
    }
  }
  return null;
}

export function firstLexicalRefusal(input: AcceptedRawInput): LexicalRefusal {
  const source = createTableTokenSource(input);
  for (;;) {
    const step = source.next();
    if (step.kind === "refused") {
      return step.refusal;
    }
    if (step.kind === "eof") {
      assert.fail("Expected token source to refuse");
    }
  }
}
