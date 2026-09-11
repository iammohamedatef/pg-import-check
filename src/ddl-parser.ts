import type { AcceptedRawInput } from "./input-profile.js";
import type { DdlRefusal } from "./ddl-evidence.js";
import {
  expectPunctuation,
  expectWord,
  failureFromOpaqueTraversal,
  failureFromStep,
  parseIdentifier,
  parseSimpleColumnList,
  spanning,
  type ParseResult,
  type QualifiedIdentity,
} from "./create-table-parser-primitives.js";
import { CreateTableStructuralReader } from "./create-table-structural-reader.js";
import {
  contextualRefusalForDemand,
  createTableTokenSource,
  type CreateTableToken,
  type SourceSpan,
} from "./create-table-token-source.js";

/** Only handled recognizer failures cross this boundary; programming defects propagate. */
export class DdlParseFailure extends Error {
  constructor(readonly refusal: DdlRefusal) {
    super("DDL recognition refused");
  }
}

export function take<T>(result: ParseResult<T>): T {
  if (result.kind === "parsed") return result.value;
  if (result.kind === "refused") throw new DdlParseFailure(result.refusal);
  const boundary = result.boundary;
  throw new DdlParseFailure(
    boundary.kind === "unexpected_token"
      ? { refusalId: "syntax_not_in_profile", span: boundary.span }
      : { refusalId: "syntax_not_in_profile", location: boundary.location, atEndOfInput: true },
  );
}

export class DdlParser {
  readonly reader: CreateTableStructuralReader;
  lastSpan: SourceSpan | null = null;
  constructor(readonly input: AcceptedRawInput) {
    this.reader = new CreateTableStructuralReader(createTableTokenSource(input));
  }
  peek(): CreateTableToken | null {
    const step = this.reader.peek();
    if (step.kind === "refused") throw new DdlParseFailure(step.refusal);
    return step.kind === "eof" ? null : step.token;
  }
  fail(token = this.peek()): never {
    if (token !== null)
      throw new DdlParseFailure({ refusalId: "syntax_not_in_profile", span: token.span });
    take(failureFromStep(this.reader.peek()));
    throw new Error("DDL failure invariant");
  }
  consume(): CreateTableToken {
    const token = this.peek();
    if (token === null) this.fail(token);
    this.reader.consumeCurrent();
    this.lastSpan = token.span;
    return token;
  }
  word(value: string): SourceSpan {
    const token = take(expectWord(this.reader, value));
    this.lastSpan = token.span;
    return token.span;
  }
  isWord(value: string): boolean {
    const token = this.peek();
    return token?.kind === "word" && token.folded === value;
  }
  optionalWord(value: string): boolean {
    if (!this.isWord(value)) return false;
    this.consume();
    return true;
  }
  choice<const T extends string>(values: readonly T[]): T {
    const token = this.peek();
    if (token?.kind !== "word" || !values.includes(token.folded as T)) this.fail(token);
    this.consume();
    return token.folded as T;
  }
  isPunctuation(value: string): boolean {
    const token = this.peek();
    return token?.kind === "punctuation" && token.value === value;
  }
  punctuation(value: Extract<CreateTableToken, { kind: "punctuation" }>["value"]): SourceSpan {
    const token = take(expectPunctuation(this.reader, value));
    this.lastSpan = token.span;
    return token.span;
  }
  optionalPunctuation(value: "," | "." | ";"): boolean {
    if (!this.isPunctuation(value)) return false;
    this.punctuation(value);
    return true;
  }
  semanticPosition(): void {
    const token = this.peek();
    if (token?.kind === "escape_string") {
      throw new DdlParseFailure({
        refusalId: "escape_string_semantics_not_in_profile",
        span: token.span,
      });
    }
  }
  identifier() {
    this.semanticPosition();
    const name = take(parseIdentifier(this.reader));
    this.lastSpan = name.span;
    return name;
  }
  qualified(): QualifiedIdentity {
    const first = this.identifier();
    if (!this.optionalPunctuation(".")) return { qualifier: null, local: first, span: first.span };
    const local = this.identifier();
    return { qualifier: first, local, span: spanning(first.span, local.span) };
  }
  columnList() {
    const result = take(parseSimpleColumnList(this.reader));
    this.lastSpan = result.span;
    return result;
  }
  opaque(): SourceSpan {
    this.punctuation("(");
    const result = this.reader.traverseOpaqueParenthesized();
    if (result.kind !== "traversed") return take(failureFromOpaqueTraversal(result));
    this.lastSpan = result.span;
    return result.span;
  }
  /** Decode only required standard-string semantic values, never protected bodies. */
  string(): { value: string; span: SourceSpan } {
    this.semanticPosition();
    const token = this.peek();
    if (token?.kind !== "standard_string") this.fail(token);
    this.consume();
    const bytes = this.input.rawBytes.subarray(
      token.span.start.rawByteOffset + 1,
      token.span.end.rawByteOffset - 1,
    );
    return {
      value: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replaceAll("''", "'"),
      span: token.span,
    };
  }
  opaqueToken(token: CreateTableToken): void {
    const refusal = contextualRefusalForDemand(token, "opaque");
    if (refusal !== null) throw new DdlParseFailure(refusal);
  }
  spanFrom(start: SourceSpan): SourceSpan {
    if (this.lastSpan === null) throw new Error("DDL span invariant");
    return spanning(start, this.lastSpan);
  }
  end(): void {
    if (this.peek() !== null && !this.isPunctuation(";")) this.fail();
  }
}
