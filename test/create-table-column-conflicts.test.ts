import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareColumnDeclarationCandidates,
  createColumnConflictCandidate,
  type ColumnAmbiguityCandidate,
  type ColumnConflictCandidate,
  type ColumnDeclarationCandidate,
} from "../src/create-table-column-conflicts.js";
import type { SourceSpan } from "../src/create-table-token-source.js";

function span(offset: number): SourceSpan {
  return {
    start: { rawByteOffset: offset, line: 1, column: offset + 1 },
    end: { rawByteOffset: offset + 1, line: 1, column: offset + 2 },
  };
}

function conflict(
  overrides: Partial<
    Pick<ColumnConflictCandidate, "establishmentOffset" | "targetColumnOrdinal" | "categoryRanks">
  > = {},
): ColumnConflictCandidate {
  const establishmentOffset = overrides.establishmentOffset ?? 100;
  return {
    kind: "conflicting_column_declaration",
    establishmentOffset,
    targetColumnOrdinal: overrides.targetColumnOrdinal ?? 0,
    categoryRanks: overrides.categoryRanks ?? [4, 4],
    refusal: {
      refusalId: "conflicting_column_declaration",
      column: { identity: "c", quoted: false, span: span(1) },
      clauseLabels: ["CHECK", "CHECK"],
      span: span(establishmentOffset),
    },
  };
}

function ambiguity(
  overrides: Partial<
    Pick<
      ColumnAmbiguityCandidate,
      | "establishmentOffset"
      | "earlierDeclarationOffset"
      | "targetColumnOrdinal"
      | "normalizedIdentity"
      | "ambiguityRuleOrder"
    >
  > = {},
): ColumnAmbiguityCandidate {
  const establishmentOffset = overrides.establishmentOffset ?? 100;
  return {
    kind: "ambiguous_declaration",
    establishmentOffset,
    earlierDeclarationOffset: overrides.earlierDeclarationOffset ?? 1,
    targetColumnOrdinal: overrides.targetColumnOrdinal ?? 0,
    normalizedIdentity: overrides.normalizedIdentity ?? "c",
    ambiguityRuleOrder: overrides.ambiguityRuleOrder ?? 0,
    refusal: { refusalId: "ambiguous_declaration", span: span(establishmentOffset) },
  };
}

function assertPreferredRegardlessOfVisitOrder(
  preferred: ColumnDeclarationCandidate,
  other: ColumnDeclarationCandidate,
): void {
  assert.equal(compareColumnDeclarationCandidates(preferred, other) < 0, true);
  assert.equal(compareColumnDeclarationCandidates(other, preferred) > 0, true);
}

describe("compareColumnDeclarationCandidates", () => {
  it("uses the authority-defined GENERATED STORED and IDENTITY category ranks", () => {
    const column = { identity: "c", quoted: false, span: span(1) };
    assert.deepEqual(
      createColumnConflictCandidate(0, column, ["DEFAULT", "GENERATED STORED"], span(100))
        .categoryRanks,
      [6, 7],
    );
    assert.deepEqual(
      createColumnConflictCandidate(0, column, ["GENERATED STORED", "SERIAL"], span(100))
        .categoryRanks,
      [7, 9],
    );
    assert.deepEqual(
      createColumnConflictCandidate(0, column, ["GENERATED STORED", "GENERATED STORED"], span(100))
        .categoryRanks,
      [7, 7],
    );
    assert.deepEqual(
      createColumnConflictCandidate(0, column, ["DEFAULT", "IDENTITY"], span(100)).categoryRanks,
      [6, 8],
    );
    assert.deepEqual(
      createColumnConflictCandidate(0, column, ["GENERATED STORED", "IDENTITY"], span(100))
        .categoryRanks,
      [7, 8],
    );
    assert.deepEqual(
      createColumnConflictCandidate(0, column, ["IDENTITY", "SERIAL"], span(100)).categoryRanks,
      [8, 9],
    );
  });

  it("prefers ambiguity when establishment locations are equal", () => {
    assertPreferredRegardlessOfVisitOrder(ambiguity(), conflict());
  });

  it("orders equal-location conflicts by column and the complete category-rank key", () => {
    assertPreferredRegardlessOfVisitOrder(
      conflict({ targetColumnOrdinal: 0, categoryRanks: [9, 9] }),
      conflict({ targetColumnOrdinal: 1, categoryRanks: [4, 4] }),
    );
    assertPreferredRegardlessOfVisitOrder(
      conflict({ categoryRanks: [4, 9] }),
      conflict({ categoryRanks: [6, 6] }),
    );
    assertPreferredRegardlessOfVisitOrder(
      conflict({ categoryRanks: [4, 6] }),
      conflict({ categoryRanks: [4, 9] }),
    );
    assertPreferredRegardlessOfVisitOrder(
      conflict({ categoryRanks: [0, 9] }),
      conflict({ categoryRanks: [1, 1] }),
    );
    assertPreferredRegardlessOfVisitOrder(
      conflict({ categoryRanks: [0, 2] }),
      conflict({ categoryRanks: [0, 9] }),
    );
  });

  it("orders equal-location ambiguities by every authority-defined tie key", () => {
    assertPreferredRegardlessOfVisitOrder(
      ambiguity({ earlierDeclarationOffset: 1, targetColumnOrdinal: 9 }),
      ambiguity({ earlierDeclarationOffset: 2, targetColumnOrdinal: 0 }),
    );
    assertPreferredRegardlessOfVisitOrder(
      ambiguity({ targetColumnOrdinal: 1 }),
      ambiguity({ targetColumnOrdinal: 2 }),
    );
    assertPreferredRegardlessOfVisitOrder(
      ambiguity({ normalizedIdentity: "�" }),
      ambiguity({ normalizedIdentity: "𐀀" }),
    );
    assertPreferredRegardlessOfVisitOrder(
      ambiguity({ ambiguityRuleOrder: 0 }),
      ambiguity({ ambiguityRuleOrder: 1 }),
    );
    assertPreferredRegardlessOfVisitOrder(
      ambiguity({ ambiguityRuleOrder: 1 }),
      ambiguity({ ambiguityRuleOrder: 8 }),
    );
  });
});
