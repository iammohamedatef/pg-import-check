import type { DdlEvidence } from "./ddl-evidence.js";
import { recognizeDdl } from "./ddl-recognizer.js";
import { applyRawInputProfile } from "./input-profile.js";
import type { GeneratedColumnEvidence, MigrationNotEvaluated } from "./migration-association.js";
import type { MigrationDocumentIndex } from "./migration-document.js";
import { serialFamily } from "./policy-types.js";

/** Reuse the closed column grammar for a generation suffix; do not project ordered ALTER state. */
export function validateMigrationGeneration(
  index: MigrationDocumentIndex,
  evidence: DdlEvidence,
  projectedBytes: Uint8Array,
  generated: readonly GeneratedColumnEvidence[],
): {
  readonly accepted: readonly GeneratedColumnEvidence[];
  readonly notEvaluated: readonly MigrationNotEvaluated[];
} {
  const accepted: GeneratedColumnEvidence[] = [];
  const notEvaluated: MigrationNotEvaluated[] = [];
  const counts = new Map<string, number>();
  for (const item of generated)
    counts.set(item.column.identity, (counts.get(item.column.identity) ?? 0) + 1);
  const decoder = new TextDecoder();
  let remainingBytes = 262_144;
  for (const item of generated) {
    const column = evidence.columns.find((c) => c.name.identity === item.column.identity);
    const statement = index.statements.find(
      (s) => s.span.start.rawByteOffset === item.span.start.rawByteOffset,
    );
    const tokens = statement?.tokens ?? [];
    const columnAt = tokens.findIndex(
      (t) => t.span.start.rawByteOffset === item.column.span.start.rawByteOffset,
    );
    const suffix = tokens[columnAt + 2];
    const last = tokens.at(-1);
    const end =
      last?.kind === "punctuation" && last.value === ";"
        ? last.span.start.rawByteOffset
        : item.span.end.rawByteOffset;
    let detail: string | null = null;
    let identityMode: "always" | "by_default" | null = null;
    if (column === undefined || statement === undefined || suffix === undefined || columnAt < 0) {
      detail = "Generation evidence has no single recognized base column or bounded suffix.";
    } else if (
      (counts.get(item.column.identity) ?? 0) > 1 ||
      serialFamily(column.type) !== null ||
      column.clauseOccurrences.some(
        (c) => c.kind === "identity" || c.kind === "default" || c.kind === "generated_stored",
      )
    ) {
      detail =
        "Competing generation declarations require ordered state review; final value authority was not established.";
    } else {
      const type = decoder.decode(
        projectedBytes.subarray(
          column.type.span.start.rawByteOffset,
          column.type.span.end.rawByteOffset,
        ),
      );
      const declaration = decoder.decode(
        index.input.rawBytes.subarray(suffix.span.start.rawByteOffset, end),
      );
      const bytes = new TextEncoder().encode(
        `CREATE TABLE public.generation_evidence ("${column.name.identity.replaceAll('"', '""')}" ${type} ${declaration});`,
      );
      remainingBytes -= bytes.length;
      const admitted = remainingBytes < 0 ? null : applyRawInputProfile(bytes);
      const recognized = admitted?.kind === "accepted" ? recognizeDdl(admitted) : null;
      if (recognized?.kind !== "recognized")
        detail =
          "The generation suffix is outside the bounded column recognition grammar; value authority was not established.";
      else if (
        recognized.evidence.columns.length !== 1 ||
        recognized.evidence.columns[0]?.clauseOccurrences.length !== 1 ||
        recognized.evidence.columns[0]?.clauseOccurrences[0]?.kind !==
          (item.source === "identity" ? "identity" : "default")
      ) {
        detail =
          "The generation suffix contains additional clauses outside the bounded ALTER form.";
      } else if (
        item.source === "identity" &&
        (column.type.name.qualifier !== null ||
          column.type.arrayDimensions !== 0 ||
          !["smallint", "int2", "integer", "int", "int4", "bigint", "int8"].includes(
            column.type.name.local.identity,
          ))
      ) {
        detail =
          "Identity evidence could not be established on a recognized PostgreSQL integer column.";
      } else if (
        item.source === "identity" &&
        !column.clauseOccurrences.some((c) => c.kind === "not_null" || c.kind === "primary_key") &&
        !evidence.associated.tableKeyConstraints.some(
          (k) =>
            k.kind === "primary_key" &&
            k.columnReferences.some((c) => c.identity === column.name.identity),
        )
      ) {
        detail =
          "Adding identity requires existing NOT NULL evidence; nullable base-column authority remains unresolved.";
      }
    }
    if (detail === null && item.source === "identity" && statement !== undefined) {
      const mode = tokens[columnAt + 3];
      identityMode = mode?.kind === "word" && mode.folded === "always" ? "always" : "by_default";
    }
    if (detail === null) accepted.push({ ...item, identityMode });
    else
      notEvaluated.push({
        kind: "relevant_statement_not_recognized",
        statementKind: "ALTER TABLE",
        span: item.span,
        detail,
      });
  }
  return { accepted, notEvaluated };
}
