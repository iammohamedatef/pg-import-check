import type { AcceptedRawInput } from "./input-profile.js";
import type { DdlRecognitionResult } from "./ddl-evidence.js";
import type { DdlStatement } from "./ddl-statements.js";
import { DdlParser, DdlParseFailure } from "./ddl-parser.js";
import { parseDdlTable } from "./ddl-table.js";
import { parseDdlComment, parseDdlEnum, parseDdlFunction, parseDdlIndex } from "./ddl-auxiliary.js";
import { parseDdlAlter, parseDdlPolicy } from "./ddl-policy.js";
import { parseDdlTrigger } from "./ddl-trigger.js";
import { associateDdl } from "./ddl-association.js";
import { spanning } from "./create-table-parser-primitives.js";

export type { DdlEvidence, DdlRefusal, DdlRecognitionResult } from "./ddl-evidence.js";

const PREFIXES = [
  ["create", "table"],
  ["create", "temp", "table"],
  ["create", "temporary", "table"],
  ["create", "type"],
  ["alter", "table"],
  ["create", "policy"],
  ["create", "function"],
  ["create", "or", "replace", "function"],
  ["create", "trigger"],
  ["create", "constraint", "trigger"],
  ["create", "index"],
  ["create", "unique", "index"],
  ["comment", "on"],
] as const;

/** One shared, demand-driven token stream. Semantic stages run only after EOF. */
export function recognizeDdl(input: AcceptedRawInput): DdlRecognitionResult {
  try {
    const p = new DdlParser(input);
    if (p.peek() === null) return { kind: "refused", refusal: { refusalId: "input_empty" } };
    const statements: DdlStatement[] = [];
    while (p.peek() !== null) {
      if (p.isPunctuation(";"))
        throw new DdlParseFailure({
          refusalId: "empty_statement_not_in_profile",
          span: p.consume().span,
        });
      const statement = parseStatement(p);
      p.end();
      if (statement !== null) statements.push(statement);
      p.optionalPunctuation(";");
    }
    return associateDdl(statements);
  } catch (error) {
    if (error instanceof DdlParseFailure) return { kind: "refused", refusal: error.refusal };
    throw error;
  }
}

function parseStatement(p: DdlParser): DdlStatement | null {
  const first = p.peek();
  if (first === null) p.fail(first);
  let possible: readonly (readonly string[])[] = PREFIXES;
  let position = 0;
  const words: string[] = [];
  for (;;) {
    const token = p.peek();
    if (token === null) p.fail(token);
    // A contextual non-ASCII source issue remains a demanded lexical/profile refusal.
    p.opaqueToken(token);
    possible = possible.filter(
      (prefix) => token.kind === "word" && prefix[position] === token.folded,
    );
    if (possible.length === 0)
      throw new DdlParseFailure({
        refusalId: "unsupported_statement",
        span: spanning(first.span, token.span),
      });
    if (token.kind !== "word") throw new Error("DDL dispatch invariant");
    words.push(token.folded);
    p.consume();
    position++;
    if (possible.some((prefix) => prefix.length === position)) break;
  }
  const start = first.span;
  const family = words.at(-1);
  switch (family) {
    case "table":
      return words[0] === "alter"
        ? { ...parseDdlAlter(p, start), start }
        : { kind: "table", value: parseDdlTable(p, start, words.length === 3), start };
    case "type":
      return { kind: "enum", value: parseDdlEnum(p, start), start };
    case "policy":
      return { kind: "policy", value: parseDdlPolicy(p, start), start };
    case "function":
      return { kind: "function", value: parseDdlFunction(p, start, words.length === 4), start };
    case "trigger":
      return { kind: "trigger", value: parseDdlTrigger(p, start, words.length === 3), start };
    case "index":
      return { kind: "index", value: parseDdlIndex(p, start, words.length === 3), start };
    case "on":
      parseDdlComment(p);
      return null;
    default:
      throw new Error("DDL family invariant");
  }
}
