export type TargetColumnIdentity = {
  readonly name: {
    readonly identity: string;
  };
};

export type TargetColumnAssociation =
  | {
      readonly kind: "unique";
      readonly ordinal: number;
    }
  | {
      readonly kind: "ambiguous";
    };

export type TargetColumnAssociations = ReadonlyMap<string, TargetColumnAssociation>;

export const NO_TARGET_COLUMN_ORDINAL = Number.MAX_SAFE_INTEGER;

export function buildTargetColumnAssociations(
  columns: readonly TargetColumnIdentity[],
): TargetColumnAssociations {
  const associations = new Map<string, TargetColumnAssociation>();
  for (const [ordinal, column] of columns.entries()) {
    const existing = associations.get(column.name.identity);
    associations.set(
      column.name.identity,
      existing === undefined ? { kind: "unique", ordinal } : { kind: "ambiguous" },
    );
  }
  return associations;
}

export function uniquelyAssociatedOrdinal(
  association: TargetColumnAssociation | undefined,
): number {
  return association?.kind === "unique" ? association.ordinal : NO_TARGET_COLUMN_ORDINAL;
}
