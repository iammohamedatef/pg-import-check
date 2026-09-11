import type {
  CoreColumnShape,
  CreateTableCoreShape,
  CreateTableCoreShapeRefusal,
  CreateTableDerivedViews,
  IdentifierIdentity,
  QualifiedIdentity,
} from "./create-table-core-shape.js";
import type { ParsedSimpleColumnList } from "./create-table-parser-primitives.js";
import type { ParsedTableConstraintElement } from "./create-table-table-constraint-grammar.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { SourceLocation } from "./source-cursor.js";

/** Collision-free exact identity; qualification is never inferred. */
export function ddlQualifiedIdentityKey(name: QualifiedIdentity): string {
  return JSON.stringify([name.qualifier?.identity ?? null, name.local.identity]);
}

export type DdlEnum = {
  readonly name: QualifiedIdentity;
  readonly labels: readonly string[];
  readonly labelSpans: readonly SourceSpan[];
  readonly span: SourceSpan;
};

export type DdlFunction = {
  readonly name: QualifiedIdentity;
  readonly orReplace: boolean;
  readonly security: "definer" | "invoker" | null;
  /** Protected body, never decoded or rescanned. */
  readonly bodySpan: SourceSpan;
  readonly span: SourceSpan;
};

export type DdlTrigger = {
  readonly name: IdentifierIdentity;
  readonly table: QualifiedIdentity;
  readonly constraint: boolean;
  readonly timing: "before" | "after";
  readonly events: readonly ("insert" | "update" | "delete" | "truncate")[];
  readonly from: QualifiedIdentity | null;
  readonly deferrable: boolean | null;
  readonly initially: "immediate" | "deferred" | null;
  readonly forEach: "row" | "statement";
  readonly whenSpan: SourceSpan | null;
  readonly function: QualifiedIdentity;
  readonly arguments: readonly string[];
  readonly span: SourceSpan;
};

export type DdlIndex = {
  readonly name: IdentifierIdentity;
  readonly table: QualifiedIdentity;
  readonly unique: boolean;
  readonly columns: ParsedSimpleColumnList;
  readonly span: SourceSpan;
};

export type DdlPolicy = {
  readonly name: IdentifierIdentity;
  readonly table: QualifiedIdentity;
  readonly mode: "permissive" | "restrictive";
  readonly command: "all" | "select" | "insert" | "update" | "delete";
  /** Null means the omitted TO clause's default PUBLIC role. */
  readonly roles: readonly IdentifierIdentity[] | null;
  readonly usingSpan: SourceSpan | null;
  readonly withCheckSpan: SourceSpan | null;
  readonly span: SourceSpan;
};

export type DdlRls = {
  readonly table: QualifiedIdentity;
  readonly axis: "enabled" | "forced";
  readonly value: boolean;
  readonly span: SourceSpan;
};

export type DdlAlterConstraint = {
  readonly table: QualifiedIdentity;
  readonly element: ParsedTableConstraintElement;
  readonly span: SourceSpan;
};

/** All arrays retain source order. Every span uses absolute raw byte offsets. */
export type DdlEvidence = {
  /** Original CREATE TABLE shape; its derived views exclude ALTER additions. */
  readonly target: CreateTableCoreShape;
  readonly columns: readonly CoreColumnShape[];
  /** Combined target views INCLUDING associated ALTER additions. */
  readonly associated: CreateTableDerivedViews;
  readonly additions: readonly DdlAlterConstraint[];
  /** Keys are ddlQualifiedIdentityKey(typeName); values have decoded labels. */
  readonly enums: ReadonlyMap<string, DdlEnum>;
  readonly functions: ReadonlyMap<string, DdlFunction>;
  readonly indexes: readonly DdlIndex[];
  readonly triggers: readonly DdlTrigger[];
  readonly policies: readonly DdlPolicy[];
  readonly rls: readonly DdlRls[];
};

export type DdlRefusal =
  | CreateTableCoreShapeRefusal
  | { readonly refusalId: "input_empty" | "no_target_table" }
  | {
      readonly refusalId: "multiple_target_tables";
      readonly actualTargetCount: number;
      readonly span: SourceSpan;
    }
  | {
      readonly refusalId:
        | "empty_statement_not_in_profile"
        | "unsupported_statement"
        | "statement_targets_other_relation"
        | "unassociated_auxiliary_declaration"
        | "escape_string_semantics_not_in_profile";
      readonly span: SourceSpan;
    }
  | {
      readonly refusalId: "syntax_not_in_profile";
      readonly location: SourceLocation;
      readonly atEndOfInput: true;
    };

export type DdlRecognitionResult =
  | { readonly kind: "recognized"; readonly evidence: DdlEvidence }
  | { readonly kind: "refused"; readonly refusal: DdlRefusal };
