import type {
  CreateTableToken,
  CreateTableTokenSource,
  LexicalRefusal,
  SourceSpan,
  TokenSourceStep,
} from "./create-table-token-source.js";
import { contextualRefusalForDemand } from "./create-table-token-source.js";

type OpeningDelimiter = "(" | "[";
type ClosingDelimiter = ")" | "]";
type DelimiterToken = Extract<CreateTableToken, { kind: "punctuation" }>;

export type StructuralRefusal = {
  readonly refusalId: "unbalanced_delimiter";
  readonly span: SourceSpan;
};

export type CreateTableParseRefusal = LexicalRefusal | StructuralRefusal;

export type StructuralTokenStep =
  | Exclude<TokenSourceStep, { kind: "refused" }>
  | {
      readonly kind: "refused";
      readonly refusal: CreateTableParseRefusal;
    };

export type OpaqueTraversalResult =
  | {
      readonly kind: "traversed";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "empty";
      readonly boundary: Exclude<StructuralTokenStep, { kind: "refused" }>;
    }
  | {
      readonly kind: "not_admitted";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "refused";
      readonly refusal: CreateTableParseRefusal;
    };

type OutstandingDelimiter = {
  readonly value: OpeningDelimiter;
  readonly span: SourceSpan;
};

type OpaqueTraversal =
  | {
      readonly kind: "parenthesized";
      readonly openingSpan: SourceSpan;
      readonly contentRequirement: "required" | "optional";
    }
  | {
      readonly kind: "expression";
      readonly depthZeroBoundary: ";";
    };

export class CreateTableStructuralReader {
  readonly #source: CreateTableTokenSource;
  readonly #outstanding: OutstandingDelimiter[] = [];
  #current: StructuralTokenStep | null = null;

  constructor(source: CreateTableTokenSource) {
    this.#source = source;
  }

  peek(): StructuralTokenStep {
    if (this.#current === null) {
      this.#current = this.classify(this.#source.next());
    }
    return this.#current;
  }

  consumeCurrent(): void {
    const step = this.peek();
    if (step.kind !== "token" || isDelimiter(step.token)) {
      throwInvariantError();
    }
    this.#current = null;
  }

  commitOpening(value: OpeningDelimiter): DelimiterToken {
    const step = this.peek();
    if (step.kind !== "token" || step.token.kind !== "punctuation" || step.token.value !== value) {
      throwInvariantError();
    }

    this.#outstanding.push({ value, span: step.token.span });
    this.#current = null;
    return step.token;
  }

  consumeClosing(value: ClosingDelimiter): DelimiterToken {
    const step = this.peek();
    const outstanding = this.#outstanding.at(-1);
    if (
      step.kind !== "token" ||
      step.token.kind !== "punctuation" ||
      step.token.value !== value ||
      outstanding === undefined ||
      closingFor(outstanding.value) !== value
    ) {
      throwInvariantError();
    }

    this.#outstanding.pop();
    this.#current = null;
    return step.token;
  }

  traverseOpaqueParenthesized(
    contentRequirement: "required" | "optional" = "required",
  ): OpaqueTraversalResult {
    const outstanding = this.#outstanding.at(-1);
    if (outstanding?.value !== "(") {
      throwInvariantError();
    }
    return this.traverseOpaque({
      kind: "parenthesized",
      openingSpan: outstanding.span,
      contentRequirement,
    });
  }

  traverseOpaqueExpression(depthZeroBoundary: ";"): OpaqueTraversalResult {
    return this.traverseOpaque({ kind: "expression", depthZeroBoundary });
  }

  private traverseOpaque(traversal: OpaqueTraversal): OpaqueTraversalResult {
    const baseDepth =
      traversal.kind === "parenthesized" ? this.#outstanding.length - 1 : this.#outstanding.length;
    let firstSpan: SourceSpan | null = null;
    let lastSpan: SourceSpan | null = null;

    for (;;) {
      const step = this.peek();
      if (step.kind === "refused") {
        return step;
      }
      if (step.kind === "eof") {
        if (traversal.kind === "parenthesized") {
          throwInvariantError();
        }
        if (firstSpan === null || lastSpan === null) {
          return { kind: "empty", boundary: step };
        }
        return { kind: "traversed", span: spanning(firstSpan, lastSpan) };
      }
      const contextualRefusal = contextualRefusalForDemand(step.token, "opaque");
      if (contextualRefusal !== null) {
        return { kind: "refused", refusal: contextualRefusal };
      }
      if (this.#outstanding.length === baseDepth) {
        if (traversal.kind === "parenthesized") {
          throwInvariantError();
        }
        if (step.token.kind === "punctuation" && step.token.value === traversal.depthZeroBoundary) {
          if (firstSpan === null || lastSpan === null) {
            return { kind: "empty", boundary: step };
          }
          return { kind: "traversed", span: spanning(firstSpan, lastSpan) };
        }
      } else if (
        traversal.kind === "parenthesized" &&
        this.#outstanding.length === baseDepth + 1 &&
        step.token.kind === "punctuation" &&
        step.token.value === ")"
      ) {
        if (firstSpan === null) {
          if (traversal.contentRequirement === "required") {
            return { kind: "empty", boundary: step };
          }
          const closing = this.consumeClosing(")");
          return { kind: "traversed", span: spanning(traversal.openingSpan, closing.span) };
        }
        const closing = this.consumeClosing(")");
        return { kind: "traversed", span: spanning(traversal.openingSpan, closing.span) };
      }

      firstSpan ??= step.token.span;
      lastSpan = step.token.span;

      if (step.token.kind === "punctuation") {
        if (step.token.value === "(" || step.token.value === "[") {
          this.commitOpening(step.token.value);
          continue;
        }
        if (step.token.value === ")" || step.token.value === "]") {
          this.consumeClosing(step.token.value);
          continue;
        }
      }

      this.consumeCurrent();
    }
  }

  private classify(step: TokenSourceStep): StructuralTokenStep {
    if (step.kind === "refused") {
      return step;
    }

    if (step.kind === "eof") {
      const outstanding = this.#outstanding.at(-1);
      return outstanding === undefined
        ? step
        : {
            kind: "refused",
            refusal: { refusalId: "unbalanced_delimiter", span: outstanding.span },
          };
    }

    if (
      step.token.kind === "punctuation" &&
      (step.token.value === ")" || step.token.value === "]")
    ) {
      const outstanding = this.#outstanding.at(-1);
      if (outstanding === undefined || closingFor(outstanding.value) !== step.token.value) {
        return {
          kind: "refused",
          refusal: { refusalId: "unbalanced_delimiter", span: step.token.span },
        };
      }
    }

    return step;
  }
}

function closingFor(opening: OpeningDelimiter): ClosingDelimiter {
  return opening === "(" ? ")" : "]";
}

function isDelimiter(token: CreateTableToken): boolean {
  return (
    token.kind === "punctuation" &&
    (token.value === "(" || token.value === ")" || token.value === "[" || token.value === "]")
  );
}

function spanning(first: SourceSpan, last: SourceSpan): SourceSpan {
  return { start: first.start, end: last.end };
}

function throwInvariantError(): never {
  throw new Error("CREATE TABLE structural reader invariant violated.");
}
