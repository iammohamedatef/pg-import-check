import type { TypeShape } from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import { ddlQualifiedIdentityKey, type DdlEnum } from "./ddl-evidence.js";
import { PROFILE, type ReasonId, type TypeFamily } from "./public-profile.js";
import { utf8ByteWidth } from "./utf8.js";

const BUILTINS = new Map<string, TypeFamily>();
for (const family of Object.keys(PROFILE.builtin_type_spellings) as TypeFamily[]) {
  for (const spelling of PROFILE.builtin_type_spellings[family]) BUILTINS.set(spelling, family);
}
const REJECTED: ReadonlySet<string> = new Set(PROFILE.known_rejected_type_spellings);
const INTEGER_FAMILIES: ReadonlySet<string> = new Set(["smallint", "integer", "bigint"]);

export type TypeEvaluation = {
  readonly family: TypeFamily | "enum" | null;
  readonly reasons: readonly ReasonId[];
};

/** Recognition §5.0, applied only to the frozen accepted type evidence. */
export function serialFamily(type: TypeShape): TypeFamily | null {
  if (
    type.name.qualifier !== null ||
    type.name.local.quoted ||
    type.modifierDigitSpans.length !== 0 ||
    type.arrayDimensions !== 0
  )
    return null;
  switch (type.name.local.identity) {
    case "smallserial":
      return "smallint";
    case "serial":
      return "integer";
    case "bigserial":
      return "bigint";
    default:
      return null;
  }
}

/** P05: classify the accepted span; never resolve search_path or inspect expressions. */
export function evaluateType(
  type: TypeShape,
  rawBytes: Uint8Array,
  enums: ReadonlyMap<string, DdlEnum>,
  enumReasons: ReadonlyMap<string, readonly ReasonId[]>,
): TypeEvaluation {
  if (type.arrayDimensions > 0) return { family: null, reasons: ["column_type_outside_profile"] };
  const key = ddlQualifiedIdentityKey(type.name);
  if (type.name.qualifier !== null && enums.has(key)) {
    return type.modifierDigitSpans.length > 0
      ? { family: null, reasons: ["type_review_required"] }
      : { family: "enum", reasons: enumReasons.get(key) ?? [] };
  }
  if (type.name.qualifier !== null || type.name.local.quoted) return unresolvedType();
  const serial = serialFamily(type);
  if (serial !== null) return { family: serial, reasons: [] };
  const family = BUILTINS.get(type.name.local.identity);
  if (family === undefined)
    return REJECTED.has(type.name.local.identity)
      ? { family: null, reasons: ["column_type_outside_profile"] }
      : unresolvedType();
  if (type.modifierDigitSpans.length === 0) return { family, reasons: [] };
  if (family === "numeric" && type.modifierDigitSpans.length === 2) {
    const precision = boundedModifier(rawBytes, type.modifierDigitSpans[0]);
    const scale = boundedModifier(rawBytes, type.modifierDigitSpans[1]);
    return {
      family,
      reasons:
        precision < 1 || precision > 1000 || scale > 1000 ? ["column_type_outside_profile"] : [],
    };
  }
  return { family, reasons: ["type_review_required"] };
}

function unresolvedType(): TypeEvaluation {
  return { family: null, reasons: ["type_review_required"] };
}

// Saturation avoids giant numeric conversions; even very long zero prefixes are linear.
function boundedModifier(bytes: Uint8Array, span: SourceSpan): number {
  let value = 0;
  for (let offset = span.start.rawByteOffset; offset < span.end.rawByteOffset; offset += 1) {
    const digit = bytes[offset];
    if (digit === undefined || digit < 48 || digit > 57)
      throw new Error("Type modifier evidence invariant violated.");
    value = Math.min(1001, value * 10 + digit - 48);
  }
  return value;
}

/** P06: scan each supplied enum once, regardless of how many columns use it. */
export function evaluateEnum(declaration: DdlEnum): ReasonId[] {
  let conflict = declaration.labels.length > PROFILE.limits.enum_labels_per_type;
  let review = false;
  for (const label of declaration.labels) {
    let bytes = 0;
    for (const scalar of label) {
      const code = scalar.codePointAt(0);
      if (code === undefined) throw new Error("Enum scalar evidence invariant violated.");
      bytes += utf8ByteWidth(code);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) conflict = true;
      else if (code > 0x7e) review = true;
    }
    if (bytes > PROFILE.limits.enum_label_utf8_bytes) conflict = true;
  }
  const reasons: ReasonId[] = [];
  if (conflict) reasons.push("enum_definition_outside_profile");
  if (review) reasons.push("enum_review_required");
  return reasons;
}

export function identityConflicts(type: TypeEvaluation): boolean {
  return type.family !== null && !INTEGER_FAMILIES.has(type.family);
}
