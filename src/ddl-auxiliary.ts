import type { DdlEnum, DdlFunction, DdlIndex } from "./ddl-evidence.js";
import type { CreateTableToken, SourceSpan } from "./create-table-token-source.js";
import { DdlParseFailure, type DdlParser } from "./ddl-parser.js";

export function parseDdlEnum(p: DdlParser, start: SourceSpan): DdlEnum {
  const name = p.qualified();
  p.word("as");
  p.word("enum");
  p.punctuation("(");
  const labels: string[] = [];
  const labelSpans: SourceSpan[] = [];
  do {
    const label = p.string();
    labels.push(label.value);
    labelSpans.push(label.span);
  } while (p.optionalPunctuation(","));
  p.punctuation(")");
  return { name, labels, labelSpans, span: p.spanFrom(start) };
}

export function parseDdlFunction(p: DdlParser, start: SourceSpan, orReplace: boolean): DdlFunction {
  const name = p.qualified();
  p.punctuation("(");
  p.punctuation(")");
  p.word("returns");
  p.word("trigger");
  let language = false;
  let bodySpan: SourceSpan | null = null;
  let security: DdlFunction["security"] = null;
  for (;;) {
    const token = p.peek();
    if (token === null || p.isPunctuation(";")) {
      if (!language || bodySpan === null) p.fail(token);
      return { name, orReplace, security, bodySpan, span: p.spanFrom(start) };
    }
    if (p.isWord("language")) {
      if (language) p.fail(token);
      p.consume();
      p.word("plpgsql");
      language = true;
    } else if (p.isWord("as")) {
      if (bodySpan !== null) p.fail(token);
      p.consume();
      p.semanticPosition();
      const body = p.peek();
      if (body?.kind !== "dollar_quoted") p.fail(body);
      bodySpan = p.consume().span;
    } else if (p.isWord("security")) {
      if (security !== null) p.fail(token);
      p.consume();
      security = p.choice(["definer", "invoker"]);
    } else p.fail(token);
  }
}

export function parseDdlIndex(p: DdlParser, start: SourceSpan, unique: boolean): DdlIndex {
  if (p.optionalWord("if")) {
    p.word("not");
    p.word("exists");
  }
  const name = p.identifier();
  p.word("on");
  p.optionalWord("only");
  const table = p.qualified();
  if (p.optionalWord("using")) p.word("btree");
  const columns = p.columnList();
  return { name, table, unique, columns, span: p.spanFrom(start) };
}

/** Rightmost depth-zero IS is selected in one forward traversal. No body is opened. */
export function parseDdlComment(p: DdlParser): void {
  let depth = 0;
  let tokenCount = 0;
  let separator: CreateTableToken | null = null;
  let designatorCount = 0;
  let value: CreateTableToken | null = null;
  let extra: CreateTableToken | null = null;
  for (;;) {
    const token = p.peek();
    if (token === null || (depth === 0 && p.isPunctuation(";"))) break;
    p.opaqueToken(token);
    if (depth === 0 && token.kind === "word" && token.folded === "is") {
      separator = token;
      designatorCount = tokenCount;
      value = null;
      extra = null;
    } else if (separator !== null) {
      if (value === null) value = token;
      else extra ??= token;
    }
    tokenCount++;
    if (token.kind === "punctuation" && (token.value === "(" || token.value === "[")) {
      p.punctuation(token.value);
      depth++;
    } else if (token.kind === "punctuation" && (token.value === ")" || token.value === "]")) {
      p.punctuation(token.value);
      depth--;
    } else p.consume();
  }
  if (separator === null) p.fail();
  if (designatorCount === 0) p.fail(separator);
  if (value === null) p.fail();
  if (value.kind === "escape_string")
    throw new DdlParseFailure({
      refusalId: "escape_string_semantics_not_in_profile",
      span: value.span,
    });
  if (value.kind !== "standard_string" && !(value.kind === "word" && value.folded === "null"))
    p.fail(value);
  if (extra !== null) p.fail(extra);
}
