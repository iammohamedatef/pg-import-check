import {
  type ColumnAmbiguityCandidate,
  type ColumnDeclarationCandidate,
  type ConflictSelectableColumn,
  createColumnConflictCandidate,
  selectEarlierDeclarationCandidate,
} from "./create-table-column-conflicts.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { ExplicitConstraintWrapper } from "./create-table-constraint-names.js";
import {
  NO_TARGET_COLUMN_ORDINAL,
  type TargetColumnAssociations,
  uniquelyAssociatedOrdinal,
} from "./create-table-target-column-association.js";

export type TableKeyConstraintKind = "primary_key" | "unique";

export type TableKeyColumnReference = {
  readonly identity: string;
  readonly quoted: boolean;
  readonly span: SourceSpan;
};

export type ParsedTableKeyConstraint = {
  readonly kind: TableKeyConstraintKind;
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly columnReferences: readonly TableKeyColumnReference[];
  readonly explicitConstraintName: ExplicitConstraintWrapper | null;
};

type KeyDeclaration = {
  readonly kind: TableKeyConstraintKind;
  readonly keywordSpan: SourceSpan;
  readonly establishmentSpan: SourceSpan;
  readonly underlyingClauseSpan: SourceSpan;
  readonly clauseSpan: SourceSpan;
  readonly source: "inline" | "table";
  readonly inlineColumnOrdinal: number | null;
  readonly columnReferences: readonly TableKeyColumnReference[];
};

type ValidatedKeyDeclaration = {
  readonly declaration: KeyDeclaration;
  readonly memberOrdinals: readonly number[];
};

const MULTIPLE_TARGET_PRIMARY_KEY_RULE_ORDER = 1;
const INVALID_TARGET_KEY_MEMBER_RULE_ORDER = 6;
const DUPLICATE_MODELED_UNIQUE_RULE_ORDER = 8;

export function selectModeledKeyDeclarationCandidate(
  columns: readonly ConflictSelectableColumn[],
  tableKeyConstraints: readonly ParsedTableKeyConstraint[],
  targetColumnsByIdentity: TargetColumnAssociations,
): ColumnDeclarationCandidate | null {
  const declarations = mergeKeyDeclarations(columns, tableKeyConstraints);
  const validatedDeclarations: ValidatedKeyDeclaration[] = [];
  let selected: ColumnDeclarationCandidate | null = null;

  for (const declaration of declarations) {
    if (declaration.source === "inline") {
      const inlineColumnOrdinal = declaration.inlineColumnOrdinal;
      if (inlineColumnOrdinal === null) {
        throw new Error("Inline modeled-key declaration has no target column.");
      }
      validatedDeclarations.push({
        declaration,
        memberOrdinals: [inlineColumnOrdinal],
      });
      continue;
    }

    const seenMembers = new Map<string, TableKeyColumnReference>();
    const associatedOrdinals: number[] = [];
    let declarationIsValid = true;

    for (const reference of declaration.columnReferences) {
      const earlierReference = seenMembers.get(reference.identity);
      if (earlierReference !== undefined) {
        declarationIsValid = false;
        selected = selectEarlierDeclarationCandidate(
          selected,
          keyAmbiguityCandidate(
            declaration,
            earlierReference.span.start.rawByteOffset,
            uniquelyAssociatedOrdinal(targetColumnsByIdentity.get(reference.identity)),
            reference.identity,
            INVALID_TARGET_KEY_MEMBER_RULE_ORDER,
            declaration.keywordSpan,
          ),
        );
        continue;
      }
      seenMembers.set(reference.identity, reference);

      const association = targetColumnsByIdentity.get(reference.identity);
      if (association === undefined) {
        declarationIsValid = false;
        selected = selectEarlierDeclarationCandidate(
          selected,
          keyAmbiguityCandidate(
            declaration,
            reference.span.start.rawByteOffset,
            NO_TARGET_COLUMN_ORDINAL,
            reference.identity,
            INVALID_TARGET_KEY_MEMBER_RULE_ORDER,
            declaration.keywordSpan,
          ),
        );
        continue;
      }

      if (association.kind !== "unique") {
        declarationIsValid = false;
        continue;
      }
      associatedOrdinals.push(association.ordinal);
    }

    if (declarationIsValid) {
      validatedDeclarations.push({ declaration, memberOrdinals: associatedOrdinals });
    }
  }

  return selectValidatedKeyCandidates(columns, validatedDeclarations, selected);
}

function mergeKeyDeclarations(
  columns: readonly ConflictSelectableColumn[],
  tableKeyConstraints: readonly ParsedTableKeyConstraint[],
): readonly KeyDeclaration[] {
  const inlineDeclarations: KeyDeclaration[] = [];
  for (const [columnOrdinal, column] of columns.entries()) {
    const eligibleInlineKinds = new Set<TableKeyConstraintKind>();
    for (const occurrence of column.clauseOccurrences) {
      if (occurrence.kind !== "primary_key" && occurrence.kind !== "unique") {
        continue;
      }
      if (eligibleInlineKinds.has(occurrence.kind)) {
        continue;
      }
      eligibleInlineKinds.add(occurrence.kind);
      inlineDeclarations.push({
        kind: occurrence.kind,
        keywordSpan: occurrence.keywordSpan,
        establishmentSpan: occurrence.establishmentSpan,
        underlyingClauseSpan: occurrence.underlyingClauseSpan,
        clauseSpan: occurrence.clauseSpan,
        source: "inline",
        inlineColumnOrdinal: columnOrdinal,
        columnReferences: [column.name],
      });
    }
  }

  const declarations: KeyDeclaration[] = [];
  let inlineOrdinal = 0;
  let tableOrdinal = 0;
  while (inlineOrdinal < inlineDeclarations.length || tableOrdinal < tableKeyConstraints.length) {
    const inline = inlineDeclarations[inlineOrdinal];
    const table = tableKeyConstraints[tableOrdinal];
    if (
      table === undefined ||
      (inline !== undefined &&
        inline.establishmentSpan.start.rawByteOffset < table.establishmentSpan.start.rawByteOffset)
    ) {
      declarations.push(inline ?? invariantFailure());
      inlineOrdinal += 1;
      continue;
    }

    declarations.push({
      ...table,
      source: "table",
      inlineColumnOrdinal: null,
    });
    tableOrdinal += 1;
  }
  return declarations;
}

function selectValidatedKeyCandidates(
  columns: readonly ConflictSelectableColumn[],
  validatedDeclarations: readonly ValidatedKeyDeclaration[],
  initialSelection: ColumnDeclarationCandidate | null,
): ColumnDeclarationCandidate | null {
  const declarationsByColumn: number[][] = Array.from({ length: columns.length }, () => []);
  for (const [validatedOrdinal, validated] of validatedDeclarations.entries()) {
    for (const memberOrdinal of validated.memberOrdinals) {
      declarationsByColumn[memberOrdinal]?.push(validatedOrdinal);
    }
  }

  const modeledMembers: number[][] = Array.from({ length: validatedDeclarations.length }, () => []);
  for (const [columnOrdinal, declarationOrdinals] of declarationsByColumn.entries()) {
    for (const declarationOrdinal of declarationOrdinals) {
      modeledMembers[declarationOrdinal]?.push(columnOrdinal);
    }
  }

  const firstExplicitNullByColumn = columns.map(
    (column) => column.clauseOccurrences.find((occurrence) => occurrence.kind === "null") ?? null,
  );

  const firstUniqueByIdentity = new Map<
    string,
    { readonly validated: ValidatedKeyDeclaration; readonly targetColumnOrdinal: number }
  >();
  let firstPrimaryKey: ValidatedKeyDeclaration | null = null;
  let firstPrimaryKeyTargetColumnOrdinal = NO_TARGET_COLUMN_ORDINAL;
  let selected = initialSelection;

  for (const [validatedOrdinal, validated] of validatedDeclarations.entries()) {
    const declaration = validated.declaration;
    const members = modeledMembers[validatedOrdinal] ?? invariantFailure();
    const modeledIdentity = encodeModeledKeyIdentity(columns, members);
    const targetColumnOrdinal = members[0] ?? NO_TARGET_COLUMN_ORDINAL;

    if (declaration.kind === "primary_key") {
      if (firstPrimaryKey === null) {
        firstPrimaryKey = validated;
        firstPrimaryKeyTargetColumnOrdinal = targetColumnOrdinal;
      } else {
        selected = selectEarlierDeclarationCandidate(
          selected,
          keyAmbiguityCandidate(
            declaration,
            firstPrimaryKey.declaration.establishmentSpan.start.rawByteOffset,
            Math.min(firstPrimaryKeyTargetColumnOrdinal, targetColumnOrdinal),
            modeledIdentity,
            MULTIPLE_TARGET_PRIMARY_KEY_RULE_ORDER,
          ),
        );
      }

      if (declaration.source === "table") {
        for (const memberOrdinal of members) {
          const column = columns[memberOrdinal] ?? invariantFailure();
          const explicitNull = firstExplicitNullByColumn[memberOrdinal];
          if (explicitNull === undefined || explicitNull === null) {
            continue;
          }
          const primaryBeforeNull =
            declaration.establishmentSpan.start.rawByteOffset <
            explicitNull.establishmentSpan.start.rawByteOffset;
          selected = selectEarlierDeclarationCandidate(
            selected,
            createColumnConflictCandidate(
              memberOrdinal,
              column.name,
              primaryBeforeNull ? ["PRIMARY KEY", "NULL"] : ["NULL", "PRIMARY KEY"],
              primaryBeforeNull ? explicitNull.establishmentSpan : declaration.establishmentSpan,
            ),
          );
        }
      }
      continue;
    }

    const earlierUnique = firstUniqueByIdentity.get(modeledIdentity);
    if (earlierUnique === undefined) {
      firstUniqueByIdentity.set(modeledIdentity, { validated, targetColumnOrdinal });
      continue;
    }
    selected = selectEarlierDeclarationCandidate(
      selected,
      keyAmbiguityCandidate(
        declaration,
        earlierUnique.validated.declaration.establishmentSpan.start.rawByteOffset,
        Math.min(earlierUnique.targetColumnOrdinal, targetColumnOrdinal),
        modeledIdentity,
        DUPLICATE_MODELED_UNIQUE_RULE_ORDER,
      ),
    );
  }

  return selected;
}

function encodeModeledKeyIdentity(
  columns: readonly ConflictSelectableColumn[],
  memberOrdinals: readonly number[],
): string {
  const parts: string[] = [];
  for (const memberOrdinal of memberOrdinals) {
    const identity = columns[memberOrdinal]?.name.identity ?? invariantFailure();
    parts.push(`${identity.length}:${identity}`);
  }
  return parts.join("|");
}

function keyAmbiguityCandidate(
  declaration: KeyDeclaration,
  earlierDeclarationOffset: number,
  targetColumnOrdinal: number,
  normalizedIdentity: string,
  ambiguityRuleOrder: number,
  establishmentSpan: SourceSpan = declaration.establishmentSpan,
): ColumnAmbiguityCandidate {
  return {
    kind: "ambiguous_declaration",
    establishmentOffset: establishmentSpan.start.rawByteOffset,
    earlierDeclarationOffset,
    targetColumnOrdinal,
    normalizedIdentity,
    ambiguityRuleOrder,
    refusal: {
      refusalId: "ambiguous_declaration",
      span: establishmentSpan,
    },
  };
}

function invariantFailure(): never {
  throw new Error("CREATE TABLE modeled-key invariant violated.");
}
