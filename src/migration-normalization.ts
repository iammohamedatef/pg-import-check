import type { AcceptedRawInput } from "./input-profile.js";
import type { CreateTableToken, SourceSpan } from "./create-table-token-source.js";
import type { MigrationStatement } from "./migration-document.js";

export type V02RecognitionObservation =
  | {
      readonly kind: "type_spelling";
      readonly original:
        | "timestamp with time zone"
        | "timestamp without time zone"
        | "character varying"
        | "double precision";
      readonly projectedAs: "timestamptz" | "timestamp" | "varchar" | "float8";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "foreign_key_action";
      readonly action:
        | "on delete cascade"
        | "on delete set null"
        | "on delete restrict"
        | "on update cascade";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "relation_storage";
      readonly storage: "with_parameters" | "tablespace";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "trigger_syntax";
      readonly form: "or_replace" | "update_of_columns";
      readonly span: SourceSpan;
    };

type Replacement = {
  readonly start: number;
  readonly end: number;
  readonly replacement: Uint8Array;
};

const encoder = new TextEncoder();

/**
 * Versioned v0.2 projection only. The frozen v0.1 grammar is not widened.
 * Rewrites are semantic aliases or audited FK action clauses whose presence is
 * separately retained as evidence.
 */
export function normalizeStatementForV02(
  input: AcceptedRawInput,
  statement: MigrationStatement,
): { readonly bytes: Uint8Array; readonly observations: readonly V02RecognitionObservation[] } {
  const replacements: Replacement[] = [];
  const observations: V02RecognitionObservation[] = [];
  if (statement.kind === "create_table") {
    collectCreateTableTypeReplacements(statement.tokens, replacements, observations);
    collectCastTypeReplacements(statement.tokens, replacements, observations);
    collectRelationStorageReplacements(statement.tokens, replacements, observations);
  }
  if (statement.kind === "create_table" || statement.kind === "alter_table") {
    collectForeignKeyActionReplacements(statement.tokens, replacements, observations);
  }
  if (statement.kind === "create_trigger") {
    collectTriggerReplacements(statement.tokens, replacements, observations);
  }
  return {
    bytes: applyReplacements(input.rawBytes, statement.span, replacements),
    observations,
  };
}

function collectTriggerReplacements(
  tokens: readonly CreateTableToken[],
  replacements: Replacement[],
  observations: V02RecognitionObservation[],
): void {
  if (
    word(tokens[0]) === "create" &&
    word(tokens[1]) === "or" &&
    word(tokens[2]) === "replace" &&
    (word(tokens[3]) === "trigger" ||
      (word(tokens[3]) === "constraint" && word(tokens[4]) === "trigger"))
  ) {
    const start = tokens[1];
    const end = tokens[2];
    if (start !== undefined && end !== undefined) {
      replacements.push({
        start: start.span.start.rawByteOffset,
        end: end.span.end.rawByteOffset,
        replacement: new Uint8Array(),
      });
      observations.push({
        kind: "trigger_syntax",
        form: "or_replace",
        span: span(start.span, end.span),
      });
    }
  }

  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (word(tokens[index]) !== "update" || word(tokens[index + 1]) !== "of") continue;
    let endIndex = index + 1;
    let cursor = index + 2;
    let sawColumn = false;
    let expectColumn = true;
    for (; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      const nextWord = word(token);
      if (nextWord === "on" || nextWord === "or") break;
      if (expectColumn) {
        if (!isIdentifier(token)) {
          sawColumn = false;
          break;
        }
        sawColumn = true;
        expectColumn = false;
      } else {
        if (!isPunctuation(token, ",")) {
          sawColumn = false;
          break;
        }
        expectColumn = true;
      }
      endIndex = cursor;
    }
    if (
      !sawColumn ||
      expectColumn ||
      endIndex < index + 2 ||
      (word(tokens[cursor]) !== "on" && word(tokens[cursor]) !== "or")
    )
      continue;
    const start = tokens[index + 1];
    const end = tokens[endIndex];
    if (start === undefined || end === undefined) continue;
    replacements.push({
      start: start.span.start.rawByteOffset,
      end: end.span.end.rawByteOffset,
      replacement: new Uint8Array(),
    });
    observations.push({
      kind: "trigger_syntax",
      form: "update_of_columns",
      span: span(start.span, end.span),
    });
  }
}

function collectCastTypeReplacements(
  tokens: readonly CreateTableToken[],
  replacements: Replacement[],
  observations: V02RecognitionObservation[],
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "operator" || token.value !== "::") continue;
    collectTypeAt(tokens, index + 1, replacements, observations);
  }
}

function collectRelationStorageReplacements(
  tokens: readonly CreateTableToken[],
  replacements: Replacement[],
  observations: V02RecognitionObservation[],
): void {
  const opening = tokens.findIndex((token) => isPunctuation(token, "("));
  if (opening < 0) return;
  let depth = 0;
  let closing = -1;
  for (let index = opening; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isPunctuation(token, "(")) depth += 1;
    else if (isPunctuation(token, ")")) {
      depth -= 1;
      if (depth === 0) {
        closing = index;
        break;
      }
    }
  }
  if (closing < 0) return;

  let at = closing + 1;
  while (at < tokens.length && !isPunctuation(tokens[at], ";")) {
    const start = tokens[at];
    if (word(start) === "with" && isPunctuation(tokens[at + 1], "(")) {
      let localDepth = 0;
      let endIndex = -1;
      for (let index = at + 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (isPunctuation(token, "(")) localDepth += 1;
        else if (isPunctuation(token, ")")) {
          localDepth -= 1;
          if (localDepth === 0) {
            endIndex = index;
            break;
          }
        }
      }
      const end = endIndex >= 0 ? tokens[endIndex] : undefined;
      if (start === undefined || end === undefined) return;
      replacements.push({
        start: start.span.start.rawByteOffset,
        end: end.span.end.rawByteOffset,
        replacement: new Uint8Array(),
      });
      observations.push({
        kind: "relation_storage",
        storage: "with_parameters",
        span: span(start.span, end.span),
      });
      at = endIndex + 1;
      continue;
    }
    if (word(start) === "tablespace" && isIdentifier(tokens[at + 1])) {
      const end = tokens[at + 1];
      if (start === undefined || end === undefined) return;
      replacements.push({
        start: start.span.start.rawByteOffset,
        end: end.span.end.rawByteOffset,
        replacement: new Uint8Array(),
      });
      observations.push({
        kind: "relation_storage",
        storage: "tablespace",
        span: span(start.span, end.span),
      });
      at += 2;
      continue;
    }
    // Any other target suffix remains for the closed recognizer to reject.
    break;
  }
}

function collectCreateTableTypeReplacements(
  tokens: readonly CreateTableToken[],
  replacements: Replacement[],
  observations: V02RecognitionObservation[],
): void {
  const openingIndex = tokens.findIndex((token) => isPunctuation(token, "("));
  if (openingIndex < 0) return;

  let depth = 0;
  let expectElementStart = false;
  for (let index = openingIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isPunctuation(token, "(")) {
      depth += 1;
      if (index === openingIndex) expectElementStart = true;
      continue;
    }
    if (isPunctuation(token, ")")) {
      depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (isPunctuation(token, ",")) {
      expectElementStart = true;
      continue;
    }
    if (!expectElementStart) continue;
    expectElementStart = false;

    const firstWord = word(token);
    if (
      firstWord !== null &&
      ["constraint", "primary", "unique", "foreign", "check", "like", "exclude"].includes(firstWord)
    ) {
      continue;
    }
    if (!isIdentifier(token)) continue;
    collectTypeAt(tokens, index + 1, replacements, observations);
  }
}

function collectTypeAt(
  tokens: readonly CreateTableToken[],
  typeIndex: number,
  replacements: Replacement[],
  observations: V02RecognitionObservation[],
): void {
  const typeToken = tokens[typeIndex];
  const typeWord = word(typeToken);
  if (typeToken === undefined || typeWord === null) return;

  if (typeWord === "character" && word(tokens[typeIndex + 1]) === "varying") {
    const varying = tokens[typeIndex + 1];
    if (varying === undefined) return;
    replaceRange(typeToken.span, varying.span, "varchar", replacements);
    observations.push({
      kind: "type_spelling",
      original: "character varying",
      projectedAs: "varchar",
      span: span(typeToken.span, varying.span),
    });
    return;
  }

  if (typeWord === "double" && word(tokens[typeIndex + 1]) === "precision") {
    const precision = tokens[typeIndex + 1];
    if (precision === undefined) return;
    replaceRange(typeToken.span, precision.span, "float8", replacements);
    observations.push({
      kind: "type_spelling",
      original: "double precision",
      projectedAs: "float8",
      span: span(typeToken.span, precision.span),
    });
    return;
  }

  if (typeWord !== "timestamp") return;
  let suffixIndex = typeIndex + 1;
  if (isPunctuation(tokens[suffixIndex], "(")) {
    let modifierDepth = 0;
    for (; suffixIndex < tokens.length; suffixIndex += 1) {
      const token = tokens[suffixIndex];
      if (token === undefined) return;
      if (isPunctuation(token, "(")) modifierDepth += 1;
      else if (isPunctuation(token, ")")) {
        modifierDepth -= 1;
        if (modifierDepth === 0) {
          suffixIndex += 1;
          break;
        }
      }
    }
  }

  const direction = word(tokens[suffixIndex]);
  if (
    (direction !== "with" && direction !== "without") ||
    word(tokens[suffixIndex + 1]) !== "time" ||
    word(tokens[suffixIndex + 2]) !== "zone"
  ) {
    return;
  }
  const suffixStart = tokens[suffixIndex];
  const suffixEnd = tokens[suffixIndex + 2];
  if (suffixStart === undefined || suffixEnd === undefined) return;
  const projectedAs = direction === "with" ? "timestamptz" : "timestamp";
  replaceRange(typeToken.span, typeToken.span, projectedAs, replacements);
  replacements.push({
    start: suffixStart.span.start.rawByteOffset,
    end: suffixEnd.span.end.rawByteOffset,
    replacement: new Uint8Array(),
  });
  observations.push({
    kind: "type_spelling",
    original: direction === "with" ? "timestamp with time zone" : "timestamp without time zone",
    projectedAs,
    span: span(typeToken.span, suffixEnd.span),
  });
}

function collectForeignKeyActionReplacements(
  tokens: readonly CreateTableToken[],
  replacements: Replacement[],
  observations: V02RecognitionObservation[],
): void {
  const depths: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    depths.push(depth);
    if (isPunctuation(token, "(")) depth += 1;
    else if (isPunctuation(token, ")")) depth = Math.max(0, depth - 1);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (word(tokens[index]) !== "on") continue;
    const currentDepth = depths[index] ?? 0;
    if (!hasReferencesInCurrentClause(tokens, depths, index, currentDepth)) continue;

    const axis = word(tokens[index + 1]);
    const firstAction = word(tokens[index + 2]);
    let action:
      | "on delete cascade"
      | "on delete set null"
      | "on delete restrict"
      | "on update cascade"
      | null = null;
    let endIndex = index + 2;
    if ((axis === "delete" || axis === "update") && firstAction === "cascade") {
      action = axis === "delete" ? "on delete cascade" : "on update cascade";
    } else if (axis === "delete" && firstAction === "restrict") {
      action = "on delete restrict";
    } else if (axis === "delete" && firstAction === "set" && word(tokens[index + 3]) === "null") {
      action = "on delete set null";
      endIndex = index + 3;
    }
    if (action === null) continue;
    const start = tokens[index];
    const end = tokens[endIndex];
    if (start === undefined || end === undefined) continue;
    replacements.push({
      start: start.span.start.rawByteOffset,
      end: end.span.end.rawByteOffset,
      replacement: new Uint8Array(),
    });
    observations.push({
      kind: "foreign_key_action",
      action,
      span: span(start.span, end.span),
    });
  }
}

function hasReferencesInCurrentClause(
  tokens: readonly CreateTableToken[],
  depths: readonly number[],
  before: number,
  currentDepth: number,
): boolean {
  for (let index = before - 1; index >= 0; index -= 1) {
    const depth = depths[index] ?? 0;
    const token = tokens[index];
    if (depth < currentDepth) return false;
    if (depth === currentDepth && isPunctuation(token, ",")) return false;
    if (depth === currentDepth && word(token) === "references") return true;
  }
  return false;
}

function applyReplacements(
  source: Uint8Array,
  statementSpan: SourceSpan,
  replacements: readonly Replacement[],
): Uint8Array {
  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let cursor = statementSpan.start.rawByteOffset;
  const end = statementSpan.end.rawByteOffset;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const replacement of ordered) {
    if (
      replacement.start < cursor ||
      replacement.end < replacement.start ||
      replacement.end > end
    ) {
      throw new Error("v0.2 projection replacement overlap invariant");
    }
    const prefix = source.subarray(cursor, replacement.start);
    parts.push(prefix, replacement.replacement);
    total += prefix.byteLength + replacement.replacement.byteLength;
    cursor = replacement.end;
  }
  const suffix = source.subarray(cursor, end);
  parts.push(suffix);
  total += suffix.byteLength;

  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function replaceRange(
  first: SourceSpan,
  last: SourceSpan,
  replacement: string,
  replacements: Replacement[],
): void {
  replacements.push({
    start: first.start.rawByteOffset,
    end: last.end.rawByteOffset,
    replacement: encoder.encode(replacement),
  });
}

function span(first: SourceSpan, last: SourceSpan): SourceSpan {
  return { start: first.start, end: last.end };
}

function word(token: CreateTableToken | undefined): string | null {
  return token?.kind === "word" ? token.folded : null;
}

function isIdentifier(token: CreateTableToken | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted_identifier";
}

function isPunctuation(token: CreateTableToken | undefined, value: string): boolean {
  return token?.kind === "punctuation" && token.value === value;
}
