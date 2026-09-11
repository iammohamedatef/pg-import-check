import type { IdentifierIdentity, QualifiedIdentity } from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { DdlRefusal } from "./ddl-evidence.js";
import type { RawInputResult } from "./input-profile.js";
import { type AnalyzedResult, PROFILE, REASON_MESSAGES, type ReasonId } from "./public-profile.js";
import {
  displayDiagnosticPreview,
  displayIdentifier,
  displayQualifiedIdentity,
} from "./report-safe-display.js";

export const COLUMN_DISPOSITIONS = [
  "outside public type profile",
  "type requires ImportFlow review",
  "excluded from file mapping by the ordinary generation/default rule",
  "file mapping candidate; final classification requires ImportFlow review",
] as const;

export type ColumnDisposition = (typeof COLUMN_DISPOSITIONS)[number];

export type AnalyzedReport = {
  readonly target: QualifiedIdentity;
  readonly columns: readonly {
    readonly name: IdentifierIdentity;
    readonly disposition: ColumnDisposition;
    readonly reasonIds: readonly ReasonId[];
  }[];
  readonly result: AnalyzedResult;
  readonly reasonIds: readonly ReasonId[];
};

export type ReportRefusalId =
  | "input_empty"
  | "input_too_large"
  | "invalid_utf8"
  | "nul_byte_not_in_profile"
  | "unexpected_bom"
  | "browser_lone_surrogate"
  | "unquoted_non_ascii_identifier"
  | "identifier_outside_profile"
  | "identifier_contains_unsafe_character"
  | "unterminated_string"
  | "unterminated_quoted_identifier"
  | "unterminated_dollar_quote"
  | "unterminated_block_comment"
  | "unbalanced_delimiter"
  | "unicode_escape_syntax_not_in_profile"
  | "escape_string_semantics_not_in_profile"
  | "no_target_table"
  | "multiple_target_tables"
  | "empty_statement_not_in_profile"
  | "unsupported_statement"
  | "syntax_not_in_profile"
  | "statement_targets_other_relation"
  | "unassociated_auxiliary_declaration"
  | "conflicting_column_declaration"
  | "ambiguous_declaration";

type RawProfileRefusal = Extract<RawInputResult, { readonly kind: "refused" }>;

/** Refusals accepted directly from recognition and the whole-input profile. */
export type ReportRefusal =
  | DdlRefusal
  | RawProfileRefusal
  | { readonly refusalId: "browser_lone_surrogate" };

const RESULT_NOTES: Readonly<Record<AnalyzedResult, string>> = {
  outside_envelope_observed:
    "Explicit declarations conflict with the dated public target-schema profile.",
  more_evidence_required: "A declared feature or missing declaration requires ImportFlow review.",
  no_structural_conflict_observed:
    "No structural conflict was observed among the declarations evaluated.",
};

const REFUSAL_TEXT: Readonly<
  Record<
    Exclude<
      ReportRefusalId,
      "identifier_outside_profile" | "multiple_target_tables" | "conflicting_column_declaration"
    >,
    readonly [explanation: string, remediation: string]
  >
> = {
  input_empty: [
    "Nothing remained after whitespace and comments.",
    "Supply one accepted CREATE TABLE declaration.",
  ],
  input_too_large: [
    "The input exceeds the 262,144 raw-byte limit for check-behavior-v1.",
    "Reduce the supplied DDL to 262,144 UTF-8 bytes or fewer.",
  ],
  invalid_utf8: ["The input is not strict scalar-valid UTF-8.", "Supply the DDL as UTF-8 text."],
  nul_byte_not_in_profile: [
    "The input contains a NUL byte, which is outside check-behavior-v1.",
    "Remove the NUL byte and supply text input.",
  ],
  unexpected_bom: [
    "A byte-order mark is present somewhere other than the start of the input.",
    "Keep at most one leading UTF-8 BOM and remove the unexpected mark.",
  ],
  browser_lone_surrogate: [
    "The browser input contains an unpaired UTF-16 surrogate.",
    "Replace the invalid string value and try again.",
  ],
  unquoted_non_ascii_identifier: [
    "An unquoted identifier contains non-ASCII text, whose PostgreSQL identity this profile does not reproduce.",
    "check-behavior-v1 accepts non-ASCII identifiers only when they are double-quoted. Supply the exact double-quoted identifier or an equivalent declaration in the accepted profile.",
  ],
  identifier_contains_unsafe_character: [
    "An identifier contains a control, format, private-use, or noncharacter code point prohibited by this profile.",
    "Rename the identifier or supply an accepted identifier without the prohibited character.",
  ],
  unterminated_string: [
    "A string literal has no closing quote.",
    "Supply a complete string literal.",
  ],
  unterminated_quoted_identifier: [
    "A double-quoted identifier has no closing quote.",
    "Supply a complete double-quoted identifier.",
  ],
  unterminated_dollar_quote: [
    "A dollar-quoted body has no exact matching closing delimiter.",
    "Supply the matching case-sensitive dollar delimiter.",
  ],
  unterminated_block_comment: [
    "A block comment has no matching close.",
    "Close every nested block comment.",
  ],
  unbalanced_delimiter: [
    "A delimited construct is unbalanced.",
    "Balance the parentheses or brackets in the supplied statement.",
  ],
  unicode_escape_syntax_not_in_profile: [
    "PostgreSQL Unicode-escape syntax is outside check-behavior-v1.",
    "Supply an equivalent directly encoded accepted form without changing identifier identity.",
  ],
  escape_string_semantics_not_in_profile: [
    "Escape-string semantics are not accepted in this position.",
    "Use the standard-string or dollar-quoted form accepted for this position.",
  ],
  no_target_table: [
    "No accepted CREATE TABLE target was supplied.",
    "Supply the one table intended for import analysis.",
  ],
  empty_statement_not_in_profile: [
    "An empty SQL statement is outside check-behavior-v1.",
    "Remove the extra semicolon.",
  ],
  unsupported_statement: [
    "The top-level statement is outside check-behavior-v1.",
    "Remove it or supply the relevant declaration in an accepted statement form.",
  ],
  syntax_not_in_profile: [
    "The statement does not match the closed check-behavior-v1 grammar.",
    "Supply the equivalent accepted form or remove the statement.",
  ],
  statement_targets_other_relation: [
    "A target-associated statement names a different relation.",
    "Supply only statements associated with the one target table.",
  ],
  unassociated_auxiliary_declaration: [
    "An auxiliary declaration is not associated with the target table or its supplied trigger.",
    "Remove it or supply the target declaration that references it.",
  ],
  ambiguous_declaration: [
    "The supplied declarations conflict or identify the same modeled object more than once.",
    "Supply one unambiguous declarative definition for each modeled object.",
  ],
};

export function renderAnalyzedReport(report: AnalyzedReport): string {
  const findingLines = orderedDistinctReasonIds(report.reasonIds).map(
    (reasonId) => `  ${reasonId} — ${REASON_MESSAGES[reasonId]}`,
  );
  if (findingLines.length === 0) {
    findingLines.push(
      "  No profile conflicts or unresolved predicates were found in the evaluated declarations.",
    );
  }

  const columnLines = report.columns.map((column) => {
    const reasonIds = orderedDistinctReasonIds(column.reasonIds);
    const reasons = reasonIds.length === 0 ? "" : ` | ${reasonIds.join(",")}`;
    return `  ${displayIdentifier(column.name)} — ${column.disposition}${reasons}`;
  });

  return finish([
    "PG IMPORT CHECK",
    `profile: ${PROFILE.envelope_version} | ${PROFILE.display_name}`,
    `as of: ${PROFILE.applicability.as_of} | offline snapshot; current availability not verified`,
    `target: ${displayQualifiedIdentity(report.target)}`,
    `TEXT-ONLY VERDICT: ${report.result}`,
    RESULT_NOTES[report.result],
    "",
    "FINDINGS",
    ...findingLines,
    "",
    "COLUMNS",
    ...columnLines,
    "",
    "IMPORTFLOW REVIEW REQUIRED",
    "Only supplied DDL was analyzed. No live database was queried.",
    "This is not production approval or a migration guarantee.",
    "Review live schema and omitted objects, effective authorization and tenant isolation,",
    "trusted system values and final mapping, trigger/function/rewrite effects,",
    "installation, workload, and production approval with ImportFlow.",
    "Profile restrictions describe the dated Alpha scope, not permanent product limits.",
    "",
    `${PROFILE.behavior_version} | ${PROFILE.envelope_version} | ${PROFILE.applicability.as_of}`,
  ]);
}

export function renderRefusalReport(refusal: ReportRefusal, rawAcceptedBytes?: Uint8Array): string {
  const [explanation, remediation] = refusalText(refusal);
  const location = refusalLocation(refusal, rawAcceptedBytes);
  return finish([
    "PG IMPORT CHECK",
    `profile: ${PROFILE.envelope_version} | ${PROFILE.applicability.as_of}`,
    `REFUSED: ${refusal.refusalId}`,
    `  ${explanation}`,
    ...(location === null ? [] : [location]),
    `  ${remediation}`,
    "Analysis unavailable; this is not a finding of ImportFlow incompatibility.",
    "No live database was queried. No production approval or migration guarantee is given.",
    `${PROFILE.behavior_version} | ${PROFILE.envelope_version} | ${PROFILE.applicability.as_of}`,
  ]);
}

function refusalText(refusal: ReportRefusal): readonly [string, string] {
  if (refusal.refusalId === "identifier_outside_profile") {
    return [
      `An identifier is ${refusal.actualUtf8ByteLength} UTF-8 bytes; this profile accepts at most 63.`,
      "Supply a declaration whose identifier identity is unambiguous under the 63-byte profile.",
    ];
  }
  if (refusal.refusalId === "multiple_target_tables") {
    return [
      `${refusal.actualTargetCount} CREATE TABLE targets were supplied; this check analyzes one.`,
      "Supply only the target table and its accepted auxiliary declarations.",
    ];
  }
  if (refusal.refusalId === "conflicting_column_declaration") {
    const column = displayIdentifier(refusal.column);
    return [
      `${column} combines conflicting or repeated column clauses: ${refusal.clauseLabels.join(" + ")}.`,
      `Supply one accepted, unambiguous declaration for ${column}.`,
    ];
  }
  return REFUSAL_TEXT[refusal.refusalId];
}

function refusalLocation(refusal: ReportRefusal, rawAcceptedBytes?: Uint8Array): string | null {
  if ("atEndOfInput" in refusal) {
    return "  at end of input";
  }
  if ("span" in refusal) {
    return locationForSpan(refusal.span, rawAcceptedBytes);
  }
  if (refusal.refusalId === "nul_byte_not_in_profile") {
    const { location } = refusal;
    return `  at line ${location.line}, column ${location.column}; 1 bytes; "\\u{0}"`;
  }
  return null;
}

function locationForSpan(span: SourceSpan, rawAcceptedBytes?: Uint8Array): string {
  if (rawAcceptedBytes === undefined) {
    throw new Error("A refusal source span requires rawAcceptedBytes.");
  }
  const { start, end } = span;
  const byteLength = end.rawByteOffset - start.rawByteOffset;
  if (
    start.rawByteOffset < 0 ||
    end.rawByteOffset < start.rawByteOffset ||
    end.rawByteOffset > rawAcceptedBytes.byteLength
  ) {
    throw new Error("Refusal source span is outside rawAcceptedBytes.");
  }
  // 64 scalars occupy at most 256 UTF-8 bytes. Never decode a whole long token.
  let previewEnd = Math.min(start.rawByteOffset + 256, end.rawByteOffset);
  while (
    previewEnd < end.rawByteOffset &&
    previewEnd > start.rawByteOffset &&
    ((rawAcceptedBytes[previewEnd] ?? 0) & 0xc0) === 0x80
  ) {
    previewEnd -= 1;
  }
  const bytes = rawAcceptedBytes.subarray(start.rawByteOffset, previewEnd);
  let fragment: string;
  try {
    fragment = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Refusal source span is not scalar-valid UTF-8.");
    }
    throw error;
  }
  const preview = displayDiagnosticPreview(fragment, previewEnd < end.rawByteOffset);
  return `  at line ${start.line}, column ${start.column}; ${byteLength} bytes; "${preview}"`;
}

function orderedDistinctReasonIds(reasonIds: readonly ReasonId[]): ReasonId[] {
  const present = new Set(reasonIds);
  return PROFILE.rules.flatMap((rule) => (present.has(rule.id) ? [rule.id] : []));
}

function finish(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}
