import type { CreateTableCoreShape } from "./create-table-core-shape.js";
import type {
  DdlAlterConstraint,
  DdlEnum,
  DdlFunction,
  DdlIndex,
  DdlPolicy,
  DdlRls,
  DdlTrigger,
} from "./ddl-evidence.js";
import type { SourceSpan } from "./create-table-token-source.js";

export type DdlStatement = (
  | { readonly kind: "table"; readonly value: CreateTableCoreShape }
  | { readonly kind: "enum"; readonly value: DdlEnum }
  | { readonly kind: "function"; readonly value: DdlFunction }
  | { readonly kind: "index"; readonly value: DdlIndex }
  | { readonly kind: "policy"; readonly value: DdlPolicy }
  | { readonly kind: "trigger"; readonly value: DdlTrigger }
  | { readonly kind: "rls"; readonly value: DdlRls }
  | { readonly kind: "addition"; readonly value: DdlAlterConstraint }
) & { readonly start: SourceSpan };
