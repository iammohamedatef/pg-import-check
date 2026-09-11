import type { SourceSpan } from "./create-table-token-source.js";
import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import type { ParsedColumnReferencesClauseOccurrence } from "./create-table-foreign-key-constraints.js";

type ParsedExpressionColumnClauseOccurrence = {
  readonly kind: "check" | "default";
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly expressionSpan: SourceSpan;
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

type ParsedGeneratedStoredColumnClauseOccurrence = {
  readonly kind: "generated_stored";
  readonly keywordSpan: SourceSpan;
  readonly generatedKeywordSpan: SourceSpan;
  readonly alwaysKeywordSpan: SourceSpan;
  readonly asKeywordSpan: SourceSpan;
  readonly expressionSpan: SourceSpan;
  readonly storedKeywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly explicitConstraintName: null;
};

type ParsedIdentityMode =
  | {
      readonly kind: "always";
      readonly alwaysKeywordSpan: SourceSpan;
    }
  | {
      readonly kind: "by_default";
      readonly byKeywordSpan: SourceSpan;
      readonly defaultKeywordSpan: SourceSpan;
    };

type ParsedIdentityColumnClauseOccurrence = {
  readonly kind: "identity";
  readonly keywordSpan: SourceSpan;
  readonly generatedKeywordSpan: SourceSpan;
  readonly mode: ParsedIdentityMode;
  readonly asKeywordSpan: SourceSpan;
  readonly identityKeywordSpan: SourceSpan;
  readonly optionsSpan: SourceSpan | null;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly explicitConstraintName: null;
};

type ParsedNullabilityColumnClauseOccurrence = {
  readonly kind: "null" | "not_null";
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

type ParsedKeyColumnClauseOccurrence = {
  readonly kind: "primary_key" | "unique";
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

export type ParsedColumnClauseOccurrence =
  | ParsedExpressionColumnClauseOccurrence
  | ParsedGeneratedStoredColumnClauseOccurrence
  | ParsedIdentityColumnClauseOccurrence
  | ParsedNullabilityColumnClauseOccurrence
  | ParsedKeyColumnClauseOccurrence
  | ParsedColumnReferencesClauseOccurrence;

export type ParsedColumnClauseKind = ParsedColumnClauseOccurrence["kind"];

export type ColumnIdentityEvidence = {
  readonly identity: string;
  readonly quoted: boolean;
  readonly span: SourceSpan;
};

type ColumnTypeEvidence = {
  readonly name: {
    readonly qualifier: ColumnIdentityEvidence | null;
    readonly local: ColumnIdentityEvidence;
  };
  readonly modifierDigitSpans: readonly SourceSpan[];
  readonly arrayDimensions: number;
};

export type ConflictSelectableColumn = {
  readonly name: ColumnIdentityEvidence;
  readonly type: ColumnTypeEvidence;
  readonly clauseOccurrences: readonly ParsedColumnClauseOccurrence[];
};

export type ColumnConflictLabel =
  | "NULL"
  | "NOT NULL"
  | "PRIMARY KEY"
  | "UNIQUE"
  | "CHECK"
  | "REFERENCES"
  | "DEFAULT"
  | "GENERATED STORED"
  | "IDENTITY"
  | "SERIAL";

export type ConflictingColumnDeclarationRefusal = {
  readonly refusalId: "conflicting_column_declaration";
  readonly column: ColumnIdentityEvidence;
  readonly clauseLabels: readonly [ColumnConflictLabel, ColumnConflictLabel];
  readonly span: SourceSpan;
};

export type AmbiguousDeclarationRefusal = {
  readonly refusalId: "ambiguous_declaration";
  readonly span: SourceSpan;
};

export type ColumnDeclarationRefusal =
  | AmbiguousDeclarationRefusal
  | ConflictingColumnDeclarationRefusal;

export type ColumnConflictCandidate = {
  readonly kind: "conflicting_column_declaration";
  readonly establishmentOffset: number;
  readonly targetColumnOrdinal: number;
  readonly categoryRanks: readonly [number, number];
  readonly refusal: ConflictingColumnDeclarationRefusal;
};

export type ColumnAmbiguityCandidate = {
  readonly kind: "ambiguous_declaration";
  readonly establishmentOffset: number;
  readonly earlierDeclarationOffset: number;
  readonly targetColumnOrdinal: number;
  readonly normalizedIdentity: string;
  readonly ambiguityRuleOrder: number;
  readonly refusal: AmbiguousDeclarationRefusal;
};

export type ColumnDeclarationCandidate = ColumnAmbiguityCandidate | ColumnConflictCandidate;

type FirstColumnOccurrence = {
  readonly ordinal: number;
  readonly column: ConflictSelectableColumn;
};

const SERIAL_TYPE_IDENTITIES: ReadonlySet<string> = new Set(["smallserial", "serial", "bigserial"]);

const CLAUSE_LABELS: Readonly<Record<ParsedColumnClauseKind, ColumnConflictLabel>> = {
  check: "CHECK",
  default: "DEFAULT",
  generated_stored: "GENERATED STORED",
  identity: "IDENTITY",
  null: "NULL",
  not_null: "NOT NULL",
  primary_key: "PRIMARY KEY",
  references: "REFERENCES",
  unique: "UNIQUE",
};

type ColumnClauseCardinalitySlot =
  | "check"
  | "default"
  | "explicit_nullability"
  | "generated_stored"
  | "identity"
  | "primary_key"
  | "references"
  | "unique";

const CARDINALITY_SLOT_BY_KIND: Readonly<
  Record<ParsedColumnClauseKind, ColumnClauseCardinalitySlot>
> = {
  check: "check",
  default: "default",
  generated_stored: "generated_stored",
  identity: "identity",
  null: "explicit_nullability",
  not_null: "explicit_nullability",
  primary_key: "primary_key",
  references: "references",
  unique: "unique",
};

type ColumnConflictParticipantKind = ParsedColumnClauseKind | "serial_shorthand";

type ColumnConflictPair = readonly [ColumnConflictParticipantKind, ColumnConflictParticipantKind];

const COLUMN_CONFLICT_PAIRS: readonly ColumnConflictPair[] = [
  ["null", "primary_key"],
  ["null", "identity"],
  ["default", "generated_stored"],
  ["default", "identity"],
  ["generated_stored", "identity"],
  ["serial_shorthand", "null"],
  ["serial_shorthand", "default"],
  ["serial_shorthand", "generated_stored"],
  ["serial_shorthand", "identity"],
];

// Zero-based positions in the fixed §7.3 clause-category tie-break order.
const CLAUSE_CATEGORY_RANKS: Readonly<Record<ColumnConflictLabel, number>> = {
  NULL: 0,
  "NOT NULL": 1,
  "PRIMARY KEY": 2,
  UNIQUE: 3,
  CHECK: 4,
  REFERENCES: 5,
  DEFAULT: 6,
  "GENERATED STORED": 7,
  IDENTITY: 8,
  SERIAL: 9,
};

const DUPLICATE_TARGET_COLUMN_RULE_ORDER = 0;

export function selectColumnDeclarationCandidate(
  columns: readonly ConflictSelectableColumn[],
): ColumnDeclarationCandidate | null {
  const firstColumnsByIdentity = new Map<string, FirstColumnOccurrence>();
  let selected: ColumnDeclarationCandidate | null = null;

  for (const [ordinal, column] of columns.entries()) {
    const earlierColumn = firstColumnsByIdentity.get(column.name.identity);
    if (earlierColumn === undefined) {
      firstColumnsByIdentity.set(column.name.identity, { ordinal, column });
    } else {
      selected = selectEarlierDeclarationCandidate(selected, {
        kind: "ambiguous_declaration",
        establishmentOffset: column.name.span.start.rawByteOffset,
        earlierDeclarationOffset: earlierColumn.column.name.span.start.rawByteOffset,
        targetColumnOrdinal: earlierColumn.ordinal,
        normalizedIdentity: column.name.identity,
        ambiguityRuleOrder: DUPLICATE_TARGET_COLUMN_RULE_ORDER,
        refusal: {
          refusalId: "ambiguous_declaration",
          span: column.name.span,
        },
      });
    }

    const firstOccurrences: Partial<
      Record<ColumnClauseCardinalitySlot, ParsedColumnClauseOccurrence>
    > = {};
    const firstOccurrencesByKind: Partial<
      Record<ParsedColumnClauseKind, ParsedColumnClauseOccurrence>
    > = {};
    const serialShorthand = isSerialShorthand(column.type);

    for (const occurrence of column.clauseOccurrences) {
      const slot = CARDINALITY_SLOT_BY_KIND[occurrence.kind];
      const firstOccurrence = firstOccurrences[slot];
      if (firstOccurrence === undefined) {
        firstOccurrences[slot] = occurrence;
      } else {
        selected = selectEarlierDeclarationCandidate(
          selected,
          createColumnConflictCandidate(
            ordinal,
            column.name,
            [CLAUSE_LABELS[firstOccurrence.kind], CLAUSE_LABELS[occurrence.kind]],
            occurrence.establishmentSpan,
          ),
        );
      }

      for (const [firstKind, secondKind] of COLUMN_CONFLICT_PAIRS) {
        if (firstKind === "serial_shorthand" || secondKind === "serial_shorthand") {
          continue;
        }

        const partnerKind =
          firstKind === occurrence.kind
            ? secondKind
            : secondKind === occurrence.kind
              ? firstKind
              : null;
        if (partnerKind !== null) {
          const earlierOccurrence = firstOccurrencesByKind[partnerKind];
          if (earlierOccurrence === undefined) {
            continue;
          }
          selected = selectEarlierDeclarationCandidate(
            selected,
            createColumnConflictCandidate(
              ordinal,
              column.name,
              [CLAUSE_LABELS[earlierOccurrence.kind], CLAUSE_LABELS[occurrence.kind]],
              occurrence.establishmentSpan,
            ),
          );
        }
      }

      if (serialShorthand && isColumnConflictPair("serial_shorthand", occurrence.kind)) {
        selected = selectEarlierDeclarationCandidate(
          selected,
          createColumnConflictCandidate(
            ordinal,
            column.name,
            ["SERIAL", CLAUSE_LABELS[occurrence.kind]],
            occurrence.establishmentSpan,
          ),
        );
      }

      firstOccurrencesByKind[occurrence.kind] ??= occurrence;
    }
  }

  return selected;
}

function isColumnConflictPair(
  left: ColumnConflictParticipantKind,
  right: ColumnConflictParticipantKind,
): boolean {
  return COLUMN_CONFLICT_PAIRS.some(
    ([first, second]) =>
      (first === left && second === right) || (first === right && second === left),
  );
}

export function createColumnConflictCandidate(
  columnOrdinal: number,
  column: ColumnIdentityEvidence,
  clauseLabels: readonly [ColumnConflictLabel, ColumnConflictLabel],
  span: SourceSpan,
): ColumnConflictCandidate {
  const firstRank = CLAUSE_CATEGORY_RANKS[clauseLabels[0]];
  const secondRank = CLAUSE_CATEGORY_RANKS[clauseLabels[1]];
  const categoryRanks: readonly [number, number] =
    firstRank <= secondRank ? [firstRank, secondRank] : [secondRank, firstRank];

  return {
    kind: "conflicting_column_declaration",
    establishmentOffset: span.start.rawByteOffset,
    targetColumnOrdinal: columnOrdinal,
    categoryRanks,
    refusal: {
      refusalId: "conflicting_column_declaration",
      column,
      clauseLabels,
      span,
    },
  };
}

function isSerialShorthand(type: ColumnTypeEvidence): boolean {
  return (
    type.name.qualifier === null &&
    !type.name.local.quoted &&
    SERIAL_TYPE_IDENTITIES.has(type.name.local.identity) &&
    type.modifierDigitSpans.length === 0 &&
    type.arrayDimensions === 0
  );
}

export function compareColumnDeclarationCandidates(
  left: ColumnDeclarationCandidate,
  right: ColumnDeclarationCandidate,
): number {
  const establishment = left.establishmentOffset - right.establishmentOffset;
  if (establishment !== 0) {
    return establishment;
  }

  if (left.kind === "ambiguous_declaration") {
    return right.kind === "ambiguous_declaration" ? compareAmbiguities(left, right) : -1;
  }
  return right.kind === "ambiguous_declaration" ? 1 : compareConflicts(left, right);
}

function compareConflicts(left: ColumnConflictCandidate, right: ColumnConflictCandidate): number {
  const column = left.targetColumnOrdinal - right.targetColumnOrdinal;
  if (column !== 0) {
    return column;
  }

  const firstCategory = left.categoryRanks[0] - right.categoryRanks[0];
  return firstCategory !== 0 ? firstCategory : left.categoryRanks[1] - right.categoryRanks[1];
}

function compareAmbiguities(
  left: ColumnAmbiguityCandidate,
  right: ColumnAmbiguityCandidate,
): number {
  const earlierDeclaration = left.earlierDeclarationOffset - right.earlierDeclarationOffset;
  if (earlierDeclaration !== 0) {
    return earlierDeclaration;
  }

  const column = left.targetColumnOrdinal - right.targetColumnOrdinal;
  if (column !== 0) {
    return column;
  }

  const identity = compareUnicodeScalars(left.normalizedIdentity, right.normalizedIdentity);
  if (identity !== 0) {
    return identity;
  }

  return left.ambiguityRuleOrder - right.ambiguityRuleOrder;
}

export function selectEarlierDeclarationCandidate(
  selected: ColumnDeclarationCandidate | null,
  candidate: ColumnDeclarationCandidate,
): ColumnDeclarationCandidate {
  return selected === null || compareColumnDeclarationCandidates(candidate, selected) < 0
    ? candidate
    : selected;
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = left[Symbol.iterator]();
  const rightScalars = right[Symbol.iterator]();

  for (;;) {
    const leftStep = leftScalars.next();
    const rightStep = rightScalars.next();
    if (leftStep.done || rightStep.done) {
      if (leftStep.done === rightStep.done) {
        return 0;
      }
      return leftStep.done ? -1 : 1;
    }

    const difference = (leftStep.value.codePointAt(0) ?? 0) - (rightStep.value.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
}
