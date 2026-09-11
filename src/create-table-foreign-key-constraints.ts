import {
  type ColumnAmbiguityCandidate,
  type ColumnDeclarationCandidate,
  type ConflictSelectableColumn,
  selectEarlierDeclarationCandidate,
} from "./create-table-column-conflicts.js";
import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import {
  NO_TARGET_COLUMN_ORDINAL,
  type TargetColumnAssociations,
} from "./create-table-target-column-association.js";
import type { SourceSpan } from "./create-table-token-source.js";

export type ForeignKeyIdentifierEvidence = {
  readonly identity: string;
  readonly quoted: boolean;
  readonly span: SourceSpan;
};

export type ForeignKeyQualifiedIdentity = {
  readonly qualifier: ForeignKeyIdentifierEvidence | null;
  readonly local: ForeignKeyIdentifierEvidence;
  readonly span: SourceSpan;
};

export type ForeignKeyColumnList = {
  readonly span: SourceSpan;
  readonly columnReferences: readonly ForeignKeyIdentifierEvidence[];
};

export type ForeignKeyReferencedColumns =
  | {
      readonly kind: "referenced_columns_omitted";
    }
  | {
      readonly kind: "explicit_referenced_columns";
      readonly list: ForeignKeyColumnList;
    };

export type ParsedColumnReferencesClauseOccurrence = {
  readonly kind: "references";
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly referencedRelation: ForeignKeyQualifiedIdentity;
  readonly referencedColumns: ForeignKeyReferencedColumns;
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

export type ParsedTableForeignKeyConstraint = {
  readonly kind: "foreign_key";
  readonly foreignKeywordSpan: SourceSpan;
  readonly keyKeywordSpan: SourceSpan;
  readonly referencesKeywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly localColumns: ForeignKeyColumnList;
  readonly referencedRelation: ForeignKeyQualifiedIdentity;
  readonly referencedColumns: ForeignKeyReferencedColumns;
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

type ForeignKeyDeclaration = {
  readonly source: "column" | "table";
  readonly anchorSpan: SourceSpan;
  readonly inlineColumnOrdinal: number | null;
  readonly localReferences: readonly ForeignKeyIdentifierEvidence[];
  readonly referencedRelation: ForeignKeyQualifiedIdentity;
  readonly referencedColumns: ForeignKeyReferencedColumns;
};

type AssociatedForeignKeyDeclaration = {
  readonly declaration: ForeignKeyDeclaration;
  readonly localOrdinals: readonly number[];
};

type ModeledForeignKey = {
  readonly declaration: ForeignKeyDeclaration;
  readonly identity: string;
  readonly targetColumnOrdinal: number;
};

const INVALID_TARGET_FK_MEMBER_RULE_ORDER = 6;
const INVALID_FK_CARDINALITY_RULE_ORDER = 7;
const DUPLICATE_MODELED_FK_RULE_ORDER = 9;
const IDENTITY_SEPARATOR = "\0";
const UTF8_RADIX_SIZE = 257;
const utf8Encoder = new TextEncoder();

export function selectModeledForeignKeyDeclarationCandidate(
  columns: readonly ConflictSelectableColumn[],
  tableForeignKeys: readonly ParsedTableForeignKeyConstraint[],
  targetColumnsByIdentity: TargetColumnAssociations,
): ColumnDeclarationCandidate | null {
  const declarations = mergeForeignKeyDeclarations(columns, tableForeignKeys);
  const associated: AssociatedForeignKeyDeclaration[] = [];
  let selected: ColumnDeclarationCandidate | null = null;

  for (const declaration of declarations) {
    if (declaration.source === "column") {
      const columnOrdinal = declaration.inlineColumnOrdinal;
      if (columnOrdinal === null) {
        throw new Error("Column REFERENCES declaration has no containing target column.");
      }

      if (
        declaration.referencedColumns.kind === "explicit_referenced_columns" &&
        declaration.referencedColumns.list.columnReferences.length !== 1
      ) {
        selected = selectEarlierDeclarationCandidate(
          selected,
          foreignKeyAmbiguityCandidate(
            declaration,
            declaration.referencedColumns.list.span.start.rawByteOffset,
            columnOrdinal,
            encodeQualifiedIdentity(declaration.referencedRelation),
            INVALID_FK_CARDINALITY_RULE_ORDER,
          ),
        );
        continue;
      }

      associated.push({ declaration, localOrdinals: [columnOrdinal] });
      continue;
    }

    const seenLocalMembers = new Map<string, ForeignKeyIdentifierEvidence>();
    const localOrdinals: number[] = [];
    const ambiguities: {
      readonly earlierDeclarationOffset: number;
      readonly normalizedIdentity: string;
      readonly ruleOrder: number;
    }[] = [];
    let declarationIsValid = true;

    for (const reference of declaration.localReferences) {
      const earlierReference = seenLocalMembers.get(reference.identity);
      if (earlierReference !== undefined) {
        declarationIsValid = false;
        ambiguities.push({
          earlierDeclarationOffset: earlierReference.span.start.rawByteOffset,
          normalizedIdentity: reference.identity,
          ruleOrder: INVALID_TARGET_FK_MEMBER_RULE_ORDER,
        });
        continue;
      }
      seenLocalMembers.set(reference.identity, reference);

      const association = targetColumnsByIdentity.get(reference.identity);
      if (association === undefined) {
        declarationIsValid = false;
        ambiguities.push({
          earlierDeclarationOffset: reference.span.start.rawByteOffset,
          normalizedIdentity: reference.identity,
          ruleOrder: INVALID_TARGET_FK_MEMBER_RULE_ORDER,
        });
        continue;
      }
      if (association.kind !== "unique") {
        declarationIsValid = false;
        continue;
      }

      localOrdinals.push(association.ordinal);
    }

    if (
      declaration.referencedColumns.kind === "explicit_referenced_columns" &&
      declaration.referencedColumns.list.columnReferences.length !==
        declaration.localReferences.length
    ) {
      declarationIsValid = false;
      ambiguities.push({
        earlierDeclarationOffset: declaration.referencedColumns.list.span.start.rawByteOffset,
        normalizedIdentity: encodeQualifiedIdentity(declaration.referencedRelation),
        ruleOrder: INVALID_FK_CARDINALITY_RULE_ORDER,
      });
    }

    const targetColumnOrdinal = lowestTargetColumnOrdinal(localOrdinals);
    for (const ambiguity of ambiguities) {
      selected = selectEarlierDeclarationCandidate(
        selected,
        foreignKeyAmbiguityCandidate(
          declaration,
          ambiguity.earlierDeclarationOffset,
          targetColumnOrdinal,
          ambiguity.normalizedIdentity,
          ambiguity.ruleOrder,
        ),
      );
    }

    if (declarationIsValid) {
      associated.push({ declaration, localOrdinals });
    }
  }

  return selectDuplicateModeledForeignKeyCandidate(columns, associated, selected);
}

function mergeForeignKeyDeclarations(
  columns: readonly ConflictSelectableColumn[],
  tableForeignKeys: readonly ParsedTableForeignKeyConstraint[],
): readonly ForeignKeyDeclaration[] {
  const columnDeclarations: ForeignKeyDeclaration[] = [];
  for (const [columnOrdinal, column] of columns.entries()) {
    for (const occurrence of column.clauseOccurrences) {
      if (occurrence.kind !== "references") {
        continue;
      }
      columnDeclarations.push({
        source: "column",
        anchorSpan: occurrence.keywordSpan,
        inlineColumnOrdinal: columnOrdinal,
        localReferences: [column.name],
        referencedRelation: occurrence.referencedRelation,
        referencedColumns: occurrence.referencedColumns,
      });
    }
  }

  const declarations: ForeignKeyDeclaration[] = [];
  let columnOrdinal = 0;
  let tableOrdinal = 0;
  while (columnOrdinal < columnDeclarations.length || tableOrdinal < tableForeignKeys.length) {
    const column = columnDeclarations[columnOrdinal];
    const table = tableForeignKeys[tableOrdinal];
    if (
      table === undefined ||
      (column !== undefined &&
        column.anchorSpan.start.rawByteOffset < table.foreignKeywordSpan.start.rawByteOffset)
    ) {
      declarations.push(column ?? invariantFailure());
      columnOrdinal += 1;
      continue;
    }

    declarations.push({
      source: "table",
      anchorSpan: table.foreignKeywordSpan,
      inlineColumnOrdinal: null,
      localReferences: table.localColumns.columnReferences,
      referencedRelation: table.referencedRelation,
      referencedColumns: table.referencedColumns,
    });
    tableOrdinal += 1;
  }
  return declarations;
}

function selectDuplicateModeledForeignKeyCandidate(
  columns: readonly ConflictSelectableColumn[],
  associated: readonly AssociatedForeignKeyDeclaration[],
  initialSelection: ColumnDeclarationCandidate | null,
): ColumnDeclarationCandidate | null {
  const explicitPairParts = encodeCanonicalExplicitPairs(columns, associated);
  const firstByIdentity = new Map<string, ModeledForeignKey>();
  let selected = initialSelection;

  for (const [ordinal, item] of associated.entries()) {
    const targetColumnOrdinal = lowestTargetColumnOrdinal(item.localOrdinals);
    const identity = encodeModeledForeignKeyIdentity(
      columns,
      item,
      explicitPairParts[ordinal] ?? invariantFailure(),
    );
    const modeled: ModeledForeignKey = {
      declaration: item.declaration,
      identity,
      targetColumnOrdinal,
    };
    const earlier = firstByIdentity.get(identity);
    if (earlier === undefined) {
      firstByIdentity.set(identity, modeled);
      continue;
    }

    selected = selectEarlierDeclarationCandidate(
      selected,
      foreignKeyAmbiguityCandidate(
        item.declaration,
        earlier.declaration.anchorSpan.start.rawByteOffset,
        Math.min(earlier.targetColumnOrdinal, targetColumnOrdinal),
        identity,
        DUPLICATE_MODELED_FK_RULE_ORDER,
      ),
    );
  }

  return selected;
}

function encodeCanonicalExplicitPairs(
  columns: readonly ConflictSelectableColumn[],
  declarations: readonly AssociatedForeignKeyDeclaration[],
): readonly (readonly string[])[] {
  return declarations.map((item) => {
    if (item.declaration.referencedColumns.kind !== "explicit_referenced_columns") {
      return [];
    }
    const referenced = item.declaration.referencedColumns.list.columnReferences;
    const pairs = item.localOrdinals.map((localOrdinal, pairOrdinal) => {
      const localIdentity = columns[localOrdinal]?.name.identity ?? invariantFailure();
      const referencedIdentity = referenced[pairOrdinal]?.identity ?? invariantFailure();
      return `${encodeIdentity(localIdentity)}${encodeIdentity(referencedIdentity)}`;
    });
    return orderByUnicodeScalars(pairs);
  });
}

function encodeModeledForeignKeyIdentity(
  columns: readonly ConflictSelectableColumn[],
  item: AssociatedForeignKeyDeclaration,
  explicitPairParts: readonly string[],
): string {
  const relation = encodeQualifiedIdentity(item.declaration.referencedRelation);
  if (item.declaration.referencedColumns.kind === "explicit_referenced_columns") {
    return `e${encodeIdentity(relation)}${encodeParts(explicitPairParts)}`;
  }

  const localIdentities = item.localOrdinals.map(
    (ordinal) => columns[ordinal]?.name.identity ?? invariantFailure(),
  );
  return `o${encodeIdentity(relation)}${encodeParts(localIdentities.map(encodeIdentity))}`;
}

function encodeQualifiedIdentity(identity: ForeignKeyQualifiedIdentity): string {
  return identity.qualifier === null
    ? `u${encodeIdentity(identity.local.identity)}`
    : `q${encodeIdentity(identity.qualifier.identity)}${encodeIdentity(identity.local.identity)}`;
}

function encodeIdentity(identity: string): string {
  return `${identity}${IDENTITY_SEPARATOR}`;
}

function encodeParts(parts: readonly string[]): string {
  return parts.join("");
}

function orderByUnicodeScalars(parts: readonly string[]): readonly string[] {
  if (parts.length < 2) {
    return parts;
  }

  type Entry = { readonly part: string; readonly bytes: Uint8Array };
  type Segment = { readonly start: number; readonly end: number; readonly depth: number };

  const entries: Entry[] = parts.map((part) => ({ part, bytes: utf8Encoder.encode(part) }));
  const scratch: Entry[] = new Array<Entry>(entries.length);
  const stack: Segment[] = [{ start: 0, end: entries.length, depth: 0 }];
  const counts = new Uint32Array(UTF8_RADIX_SIZE);
  const starts = new Uint32Array(UTF8_RADIX_SIZE);
  const next = new Uint32Array(UTF8_RADIX_SIZE);

  while (stack.length > 0) {
    const segment = stack.pop() ?? invariantFailure();
    counts.fill(0);
    for (let index = segment.start; index < segment.end; index += 1) {
      const entry = entries[index] ?? invariantFailure();
      const category = radixCategory(entry.bytes, segment.depth);
      counts[category] = (counts[category] ?? invariantFailure()) + 1;
    }

    let offset = segment.start;
    for (let category = 0; category < UTF8_RADIX_SIZE; category += 1) {
      starts[category] = offset;
      offset += counts[category] ?? invariantFailure();
    }
    next.set(starts);

    for (let index = segment.start; index < segment.end; index += 1) {
      const entry = entries[index] ?? invariantFailure();
      const category = radixCategory(entry.bytes, segment.depth);
      const destination = next[category] ?? invariantFailure();
      scratch[destination] = entry;
      next[category] = destination + 1;
    }
    for (let index = segment.start; index < segment.end; index += 1) {
      entries[index] = scratch[index] ?? invariantFailure();
    }

    let groupStart = segment.start + (counts[0] ?? invariantFailure());
    for (let category = 1; category < UTF8_RADIX_SIZE; category += 1) {
      const groupEnd = groupStart + (counts[category] ?? invariantFailure());
      if (groupEnd - groupStart > 1) {
        stack.push({ start: groupStart, end: groupEnd, depth: segment.depth + 1 });
      }
      groupStart = groupEnd;
    }
  }

  return entries.map((entry) => entry.part);
}

function radixCategory(bytes: Uint8Array, depth: number): number {
  // Valid UTF-8 preserves Unicode-scalar order bytewise; zero is the end-of-part sentinel.
  return depth === bytes.length ? 0 : (bytes[depth] ?? invariantFailure()) + 1;
}

function lowestTargetColumnOrdinal(ordinals: readonly number[]): number {
  let lowest = NO_TARGET_COLUMN_ORDINAL;
  for (const ordinal of ordinals) {
    lowest = Math.min(lowest, ordinal);
  }
  return lowest;
}

function foreignKeyAmbiguityCandidate(
  declaration: ForeignKeyDeclaration,
  earlierDeclarationOffset: number,
  targetColumnOrdinal: number,
  normalizedIdentity: string,
  ambiguityRuleOrder: number,
): ColumnAmbiguityCandidate {
  return {
    kind: "ambiguous_declaration",
    establishmentOffset: declaration.anchorSpan.start.rawByteOffset,
    earlierDeclarationOffset,
    targetColumnOrdinal,
    normalizedIdentity,
    ambiguityRuleOrder,
    refusal: {
      refusalId: "ambiguous_declaration",
      span: declaration.anchorSpan,
    },
  };
}

function invariantFailure(): never {
  throw new Error("CREATE TABLE foreign-key invariant violated.");
}
