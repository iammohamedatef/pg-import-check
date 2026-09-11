import {
  type ColumnAmbiguityCandidate,
  type ColumnDeclarationCandidate,
  selectEarlierDeclarationCandidate,
} from "./create-table-column-conflicts.js";
import type { SourceSpan } from "./create-table-token-source.js";

export type ExplicitConstraintNameIdentity = {
  readonly identity: string;
  readonly quoted: boolean;
  readonly span: SourceSpan;
};

export type ExplicitConstraintWrapper = {
  readonly constraintKeywordSpan: SourceSpan;
  readonly name: ExplicitConstraintNameIdentity;
  readonly wrapperSpan: SourceSpan;
};

export type ExplicitConstraintNameOccurrence = ExplicitConstraintWrapper & {
  readonly scope: "column" | "table";
  readonly kind:
    | "null"
    | "not_null"
    | "primary_key"
    | "unique"
    | "check"
    | "references"
    | "foreign_key";
  readonly underlyingKeywordSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly sourceOrder: number;
  readonly targetColumnOrdinal: number | null;
};

const NO_TARGET_COLUMN_ORDINAL = Number.MAX_SAFE_INTEGER;
const DUPLICATE_EXPLICIT_CONSTRAINT_NAME_RULE_ORDER = 2;

export function selectDuplicateExplicitConstraintNameCandidate(
  occurrences: readonly ExplicitConstraintNameOccurrence[],
): ColumnDeclarationCandidate | null {
  const firstByIdentity = new Map<string, ExplicitConstraintNameOccurrence>();
  let selected: ColumnDeclarationCandidate | null = null;

  for (const occurrence of occurrences) {
    const earlier = firstByIdentity.get(occurrence.name.identity);
    if (earlier === undefined) {
      firstByIdentity.set(occurrence.name.identity, occurrence);
      continue;
    }

    selected = selectEarlierDeclarationCandidate(
      selected,
      duplicateNameCandidate(earlier, occurrence),
    );
  }

  return selected;
}

function duplicateNameCandidate(
  earlier: ExplicitConstraintNameOccurrence,
  later: ExplicitConstraintNameOccurrence,
): ColumnAmbiguityCandidate {
  return {
    kind: "ambiguous_declaration",
    establishmentOffset: later.constraintKeywordSpan.start.rawByteOffset,
    earlierDeclarationOffset: earlier.constraintKeywordSpan.start.rawByteOffset,
    targetColumnOrdinal: Math.min(
      earlier.targetColumnOrdinal ?? NO_TARGET_COLUMN_ORDINAL,
      later.targetColumnOrdinal ?? NO_TARGET_COLUMN_ORDINAL,
    ),
    normalizedIdentity: later.name.identity,
    ambiguityRuleOrder: DUPLICATE_EXPLICIT_CONSTRAINT_NAME_RULE_ORDER,
    refusal: {
      refusalId: "ambiguous_declaration",
      span: later.constraintKeywordSpan,
    },
  };
}
