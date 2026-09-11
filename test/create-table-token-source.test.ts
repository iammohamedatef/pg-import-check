import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTableTokenSource,
  type CreateTableToken,
  type CreateTableTokenSource,
  type LexicalRefusal,
  type TokenSourceStep,
} from "../src/create-table-token-source.js";
import {
  applyRawInputProfile,
  MAX_RAW_INPUT_BYTES,
  type AcceptedRawInput,
  type RawInputResult,
} from "../src/input-profile.js";

const encoder = new TextEncoder();
const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

function expectAccepted(result: RawInputResult): AcceptedRawInput {
  if (result.kind !== "accepted") {
    assert.fail(`Expected accepted input, received ${result.refusalId}`);
  }
  return result;
}

function acceptText(sourceText: string): AcceptedRawInput {
  return expectAccepted(applyRawInputProfile(encoder.encode(sourceText)));
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function sourceFor(sourceText: string): CreateTableTokenSource {
  return createTableTokenSource(acceptText(sourceText));
}

function expectToken(step: TokenSourceStep): CreateTableToken {
  if (step.kind !== "token") {
    assert.fail(
      step.kind === "refused"
        ? `Expected token, received ${step.refusal.refusalId}`
        : "Expected token, received EOF",
    );
  }
  return step.token;
}

function expectRefusal(
  step: TokenSourceStep,
  refusalId: LexicalRefusal["refusalId"],
): LexicalRefusal {
  if (step.kind !== "refused") {
    assert.fail(`Expected ${refusalId}, received ${step.kind}`);
  }
  assert.equal(step.refusal.refusalId, refusalId);
  return step.refusal;
}

function tokensFor(sourceText: string): CreateTableToken[] {
  const source = sourceFor(sourceText);
  const tokens: CreateTableToken[] = [];

  for (;;) {
    const step = source.next();
    if (step.kind === "eof") {
      return tokens;
    }
    if (step.kind === "refused") {
      assert.fail(`Unexpected refusal: ${step.refusal.refusalId}`);
    }
    tokens.push(step.token);
  }
}

function describeToken(token: CreateTableToken): string {
  switch (token.kind) {
    case "word":
      return `word:${token.folded}`;
    case "quoted_identifier":
      return `identifier:${token.identity}`;
    case "standard_string":
      return "standard_string";
    case "escape_string":
      return "escape_string";
    case "dollar_quoted":
      return "dollar_quoted";
    case "numeric":
      return token.isUnsignedInteger ? "numeric:unsigned" : "numeric:general";
    case "punctuation":
      return `punctuation:${token.value}`;
    case "operator":
      return `operator:${token.value}`;
    case "dollar_position":
      return "dollar_position";
    case "contextual_issue":
      return `issue:${token.issue}`;
  }
}

function descriptionsFor(sourceText: string): string[] {
  return tokensFor(sourceText).map(describeToken);
}

function collectSteps(sourceText: string): TokenSourceStep[] {
  const source = sourceFor(sourceText);
  const steps: TokenSourceStep[] = [];

  for (;;) {
    const step = source.next();
    steps.push(step);
    if (step.kind !== "token") {
      return steps;
    }
  }
}

describe("createTableTokenSource", () => {
  it("recognizes the boundaries earned by CREATE TABLE grammar", () => {
    const cases = [
      {
        sourceText: "CREATE/* gap */TABLE UESCAPE",
        expected: ["word:create", "word:table", "word:uescape"],
      },
      {
        sourceText: 'public."Order" numeric(10,2)[]',
        expected: [
          "word:public",
          "punctuation:.",
          "identifier:Order",
          "word:numeric",
          "punctuation:(",
          "numeric:unsigned",
          "punctuation:,",
          "numeric:unsigned",
          "punctuation:)",
          "punctuation:[",
          "punctuation:]",
        ],
      },
      {
        sourceText: "DEFAULT -1.5e+2::numeric",
        expected: ["word:default", "operator:-", "numeric:general", "operator:::", "word:numeric"],
      },
      {
        sourceText: "CHECK (value <> $12)",
        expected: [
          "word:check",
          "punctuation:(",
          "word:value",
          "operator:<>",
          "dollar_position",
          "punctuation:)",
        ],
      },
      {
        sourceText: "CONSTRAINT fk FOREIGN KEY (ref_id) REFERENCES public.parent(id)",
        expected: [
          "word:constraint",
          "word:fk",
          "word:foreign",
          "word:key",
          "punctuation:(",
          "word:ref_id",
          "punctuation:)",
          "word:references",
          "word:public",
          "punctuation:.",
          "word:parent",
          "punctuation:(",
          "word:id",
          "punctuation:)",
        ],
      },
      {
        sourceText: "GENERATED ALWAYS AS (lower(note || '/* text */')) STORED;",
        expected: [
          "word:generated",
          "word:always",
          "word:as",
          "punctuation:(",
          "word:lower",
          "punctuation:(",
          "word:note",
          "operator:||",
          "standard_string",
          "punctuation:)",
          "punctuation:)",
          "word:stored",
          "punctuation:;",
        ],
      },
    ];

    for (const testCase of cases) {
      assert.deepEqual(
        descriptionsFor(testCase.sourceText),
        testCase.expected,
        testCase.sourceText,
      );
    }
  });

  it("folds only ASCII words and leaves keyword meaning contextual", () => {
    assert.deepEqual(descriptionsFor("CrEaTe create CONSTRAINT UESCAPE _A$1"), [
      "word:create",
      "word:create",
      "word:constraint",
      "word:uescape",
      "word:_a$1",
    ]);
  });

  it("preserves exclusive raw-byte and scalar-coordinate spans after a BOM", () => {
    const accepted = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode("\"é😀\"\r\n E'😀'"))),
    );
    const source = createTableTokenSource(accepted);

    const identifier = expectToken(source.next());
    assert.deepEqual(identifier, {
      kind: "quoted_identifier",
      identity: "é😀",
      span: {
        start: { rawByteOffset: 3, line: 1, column: 1 },
        end: { rawByteOffset: 11, line: 1, column: 5 },
      },
    });

    const escapeString = expectToken(source.next());
    assert.deepEqual(escapeString, {
      kind: "escape_string",
      span: {
        start: { rawByteOffset: 14, line: 2, column: 2 },
        end: { rawByteOffset: 21, line: 2, column: 6 },
      },
    });
    assert.deepEqual(source.next(), {
      kind: "eof",
      location: { rawByteOffset: 21, line: 2, column: 6 },
    });
  });

  describe("quoted identifiers", () => {
    it("decodes doubled quotes and preserves normalization forms", () => {
      const tokens = tokensFor('"a""b" "é" "é" "😀" """"');
      assert.deepEqual(tokens.map(describeToken), [
        'identifier:a"b',
        "identifier:é",
        "identifier:é",
        "identifier:😀",
        'identifier:"',
      ]);

      const composed = tokens[1];
      const decomposed = tokens[2];
      assert.equal(composed?.kind, "quoted_identifier");
      assert.equal(decomposed?.kind, "quoted_identifier");
      if (composed?.kind === "quoted_identifier" && decomposed?.kind === "quoted_identifier") {
        assert.notEqual(composed.identity, decomposed.identity);
      }
    });

    it("enforces empty and quoted 63-byte boundaries while leaving words contextual", () => {
      const empty = expectRefusal(sourceFor('""').next(), "syntax_not_in_profile");
      assert.deepEqual(empty.span, {
        start: { rawByteOffset: 0, line: 1, column: 1 },
        end: { rawByteOffset: 2, line: 1, column: 3 },
      });

      const atLimit = expectToken(sourceFor(`"${"é".repeat(31)}a"`).next());
      assert.equal(atLimit.kind, "quoted_identifier");

      const longWordText = "A".repeat(64);
      const longWord = expectToken(sourceFor(longWordText).next());
      assert.deepEqual(longWord, {
        kind: "word",
        folded: "a".repeat(64),
        span: {
          start: { rawByteOffset: 0, line: 1, column: 1 },
          end: { rawByteOffset: 64, line: 1, column: 65 },
        },
      });
    });

    it("applies unsafe, EOF, and safely closed length precedence", () => {
      const overlengthUnterminated = expectRefusal(
        sourceFor(`"${"a".repeat(64)}`).next(),
        "unterminated_quoted_identifier",
      );
      assert.equal("actualUtf8ByteLength" in overlengthUnterminated, false);
      assert.deepEqual(overlengthUnterminated.span, {
        start: { rawByteOffset: 0, line: 1, column: 1 },
        end: { rawByteOffset: 65, line: 1, column: 66 },
      });

      const overlengthUnsafe = expectRefusal(
        sourceFor(`"${"a".repeat(64)}\u200B`).next(),
        "identifier_contains_unsafe_character",
      );
      assert.deepEqual(overlengthUnsafe.span, {
        start: { rawByteOffset: 65, line: 1, column: 66 },
        end: { rawByteOffset: 68, line: 1, column: 67 },
      });

      const crossingUnsafe = expectRefusal(
        sourceFor(`"${"a".repeat(62)}\u200B"`).next(),
        "identifier_contains_unsafe_character",
      );
      assert.deepEqual(crossingUnsafe.span, {
        start: { rawByteOffset: 63, line: 1, column: 64 },
        end: { rawByteOffset: 66, line: 1, column: 65 },
      });

      const safelyClosedOverlength = expectRefusal(
        sourceFor(`"${"é".repeat(32)}"`).next(),
        "identifier_outside_profile",
      );
      assert.equal(
        safelyClosedOverlength.refusalId === "identifier_outside_profile"
          ? safelyClosedOverlength.actualUtf8ByteLength
          : undefined,
        64,
      );
      assert.deepEqual(safelyClosedOverlength.span, {
        start: { rawByteOffset: 0, line: 1, column: 1 },
        end: { rawByteOffset: 66, line: 1, column: 35 },
      });
    });

    it("uses the fixed unsafe-code-point table", () => {
      const unsafeCodePoints = [
        0x000a, 0x007f, 0x00ad, 0x034f, 0x0600, 0x061c, 0x115f, 0x180b, 0x200b, 0x2028, 0x3164,
        0xfe00, 0xfeff, 0xfff0, 0x110bd, 0x13430, 0x1bca0, 0x1d173, 0xe0000, 0xe000, 0xf0000,
        0x100000, 0xfdd0, 0xffff, 0x10ffff,
      ];

      for (const codePoint of unsafeCodePoints) {
        const scalar = String.fromCodePoint(codePoint);
        const refusal = expectRefusal(
          sourceFor(`"${scalar}"`).next(),
          "identifier_contains_unsafe_character",
        );
        assert.equal(refusal.span.start.rawByteOffset, 1, `U+${codePoint.toString(16)}`);
        assert.equal(
          refusal.span.end.rawByteOffset,
          1 + encoder.encode(scalar).byteLength,
          `U+${codePoint.toString(16)}`,
        );
      }
    });
  });

  describe("protected string and dollar forms", () => {
    it("keeps standard and E-prefixed string rules distinct", () => {
      const escapedQuote = "E'a" + "\\" + "'b'";
      const cases = [
        { sourceText: "'a''b\\c'", expected: "standard_string" },
        { sourceText: "'-- /* $tag$ */'", expected: "standard_string" },
        { sourceText: escapedQuote, expected: "escape_string" },
        { sourceText: "e'a''b'", expected: "escape_string" },
      ];

      for (const testCase of cases) {
        assert.equal(
          describeToken(expectToken(sourceFor(testCase.sourceText).next())),
          testCase.expected,
        );
      }

      for (const sourceText of ["'open", "E'open", "E'open" + "\\"]) {
        expectRefusal(sourceFor(sourceText).next(), "unterminated_string");
      }
    });

    it("preserves CR, LF, and CRLF source coordinates inside strings", () => {
      for (const lineEnding of ["\r", "\n", "\r\n"]) {
        const sourceText = `'a${lineEnding}b'X`;
        const source = sourceFor(sourceText);
        const stringToken = expectToken(source.next());
        const expectedRawEnd = encoder.encode(sourceText.slice(0, -1)).byteLength;

        assert.deepEqual(stringToken.span.end, {
          rawByteOffset: expectedRawEnd,
          line: 2,
          column: 3,
        });
        assert.deepEqual(expectToken(source.next()).span.start, stringToken.span.end);
      }
    });

    it("matches exact tagged and untagged dollar delimiters", () => {
      const cases = [
        "$$$$",
        "$tag$body $TAG$ -- /* ' $tag$",
        "$_9$x$other$y$_9$",
        "$tag$x$TAG$$tag$",
      ];

      for (const sourceText of cases) {
        const tokenValue = expectToken(sourceFor(sourceText).next());
        assert.equal(tokenValue.kind, "dollar_quoted", sourceText);
        assert.equal(tokenValue.span.end.rawByteOffset, encoder.encode(sourceText).byteLength);
      }

      expectRefusal(sourceFor("$tag$body$TAG$").next(), "unterminated_dollar_quote");
      expectRefusal(sourceFor("$tag").next(), "syntax_not_in_profile");
    });

    it("handles adversarial repeated delimiter prefixes in linear traversal", () => {
      const delimiter = `$${"a".repeat(63)}$`;
      const nearMatch = `${delimiter.slice(0, -1)}X`;
      const sourceText = `${delimiter}${nearMatch.repeat(1_000)}${delimiter}`;
      const tokenValue = expectToken(sourceFor(sourceText).next());

      assert.equal(tokenValue.kind, "dollar_quoted");
      assert.equal(tokenValue.span.end.rawByteOffset, encoder.encode(sourceText).byteLength);
    });

    it("traverses one maximum-size dollar token", () => {
      const sourceText = `$$${"a".repeat(MAX_RAW_INPUT_BYTES - 4)}$$`;
      const source = sourceFor(sourceText);
      const tokenValue = expectToken(source.next());

      assert.equal(tokenValue.kind, "dollar_quoted");
      assert.equal(tokenValue.span.end.rawByteOffset, MAX_RAW_INPUT_BYTES);
      assert.deepEqual(source.next(), {
        kind: "eof",
        location: {
          rawByteOffset: MAX_RAW_INPUT_BYTES,
          line: 1,
          column: MAX_RAW_INPUT_BYTES + 1,
        },
      });
    });
  });

  it("uses the longest valid numeric token without consuming incomplete exponents", () => {
    const cases = [
      { sourceText: "0", expected: ["numeric:unsigned"], ends: [1] },
      { sourceText: "12.", expected: ["numeric:general"], ends: [3] },
      { sourceText: ".5", expected: ["numeric:general"], ends: [2] },
      { sourceText: "1.e2", expected: ["numeric:general"], ends: [4] },
      { sourceText: "1E-9", expected: ["numeric:general"], ends: [4] },
      {
        sourceText: "1e+",
        expected: ["numeric:unsigned", "word:e", "operator:+"],
        ends: [1, 2, 3],
      },
      {
        sourceText: ".5e-",
        expected: ["numeric:general", "word:e", "operator:-"],
        ends: [2, 3, 4],
      },
      {
        sourceText: "1..2",
        expected: ["numeric:general", "numeric:general"],
        ends: [2, 4],
      },
    ];

    for (const testCase of cases) {
      const tokens = tokensFor(testCase.sourceText);
      assert.deepEqual(tokens.map(describeToken), testCase.expected, testCase.sourceText);
      assert.deepEqual(
        tokens.map((tokenValue) => tokenValue.span.end.rawByteOffset),
        testCase.ends,
        testCase.sourceText,
      );
    }
  });

  it("recognizes punctuation, maximal operators, comments, and dollar positions", () => {
    const allOperators = "+-*/<>=~!@#%^&|`?:";
    assert.deepEqual(descriptionsFor(`${allOperators} ()[],.; $123`), [
      `operator:${allOperators}`,
      "punctuation:(",
      "punctuation:)",
      "punctuation:[",
      "punctuation:]",
      "punctuation:,",
      "punctuation:.",
      "punctuation:;",
      "dollar_position",
    ]);

    assert.deepEqual(descriptionsFor("+/* block */- -- line\r\n::"), [
      "operator:+",
      "operator:-",
      "operator:::",
    ]);
  });

  describe("lexical and contextual issues", () => {
    it("preserves the full contextual fragment for non-ASCII at token start", () => {
      const source = sourceFor("éx);word");
      assert.deepEqual(expectToken(source.next()), {
        kind: "contextual_issue",
        issue: "non_ascii_at_token_start",
        span: {
          start: { rawByteOffset: 0, line: 1, column: 1 },
          end: { rawByteOffset: 4, line: 1, column: 4 },
        },
      });
      assert.equal(describeToken(expectToken(source.next())), "punctuation:;");
      assert.equal(describeToken(expectToken(source.next())), "word:word");
    });

    it("refuses an ASCII-word non-ASCII suffix from the first non-ASCII scalar", () => {
      const refusal = expectRefusal(
        sourceFor("nameéquipe;").next(),
        "unquoted_non_ascii_identifier",
      );
      assert.deepEqual(refusal.span, {
        start: { rawByteOffset: 4, line: 1, column: 5 },
        end: { rawByteOffset: 11, line: 1, column: 11 },
      });
    });

    it("detects unexpected BOM and immediate Unicode-escape prefixes", () => {
      const secondBom = expectRefusal(sourceFor("\uFEFF\uFEFFx").next(), "unexpected_bom");
      assert.equal(secondBom.span.start.rawByteOffset, 3);

      const embeddedBom = expectRefusal(sourceFor("word\uFEFFx").next(), "unexpected_bom");
      assert.equal(embeddedBom.span.start.rawByteOffset, 4);

      for (const sourceText of ['U&"name"', "u&'value'"]) {
        const refusal = expectRefusal(
          sourceFor(sourceText).next(),
          "unicode_escape_syntax_not_in_profile",
        );
        assert.equal(refusal.span.start.rawByteOffset, 0);
        assert.equal(refusal.span.end.rawByteOffset, 2);
      }

      assert.deepEqual(descriptionsFor('U &"name" UESCAPE'), [
        "word:u",
        "operator:&",
        "identifier:name",
        "word:uescape",
      ]);
    });

    it("keeps BOM ownership distinct across neighboring dollar paths", () => {
      const bareDollarBom = expectRefusal(sourceFor("$\uFEFF").next(), "unexpected_bom");
      assert.deepEqual(bareDollarBom.span, {
        start: { rawByteOffset: 1, line: 1, column: 2 },
        end: { rawByteOffset: 4, line: 1, column: 3 },
      });

      expectRefusal(sourceFor("$").next(), "syntax_not_in_profile");
      expectRefusal(sourceFor("$tag\uFEFF").next(), "unexpected_bom");

      const dollarPositionSource = sourceFor("$1\uFEFF");
      const dollarPosition = expectToken(dollarPositionSource.next());
      assert.equal(dollarPosition.kind, "dollar_position");
      expectRefusal(dollarPositionSource.next(), "unexpected_bom");

      const protectedBom = expectToken(sourceFor("$$\uFEFF$$").next());
      assert.equal(protectedBom.kind, "dollar_quoted");
    });

    it("returns deterministic refusals for malformed or unterminated forms", () => {
      const cases: Array<{
        sourceText: string;
        refusalId: LexicalRefusal["refusalId"];
        start: number;
      }> = [
        { sourceText: "\vbad;", refusalId: "syntax_not_in_profile", start: 0 },
        { sourceText: "/* open", refusalId: "unterminated_block_comment", start: 0 },
        { sourceText: "'open", refusalId: "unterminated_string", start: 0 },
        {
          sourceText: '"open',
          refusalId: "unterminated_quoted_identifier",
          start: 0,
        },
        { sourceText: "$tag$open", refusalId: "unterminated_dollar_quote", start: 0 },
      ];

      for (const testCase of cases) {
        const source = sourceFor(testCase.sourceText);
        const first = expectRefusal(source.next(), testCase.refusalId);
        assert.equal(first.span.start.rawByteOffset, testCase.start, testCase.sourceText);
        if (testCase.sourceText === "\vbad;") {
          assert.equal(first.span.end.rawByteOffset, 4);
        }
        assert.deepEqual(source.next(), { kind: "refused", refusal: first });
      }
    });
  });

  it("is deterministic, monotonic, and stable at EOF", () => {
    const sourceText = 'word /* gap */ "é"\r\n-1.0 $1';
    const first = collectSteps(sourceText);
    const second = collectSteps(sourceText);
    assert.deepEqual(first, second);

    let previousEnd = 0;
    for (const step of first) {
      if (step.kind !== "token") {
        continue;
      }
      assert.equal(step.token.span.start.rawByteOffset >= previousEnd, true);
      assert.equal(step.token.span.end.rawByteOffset > step.token.span.start.rawByteOffset, true);
      previousEnd = step.token.span.end.rawByteOffset;
    }

    const eofSource = sourceFor("word");
    expectToken(eofSource.next());
    const eof = eofSource.next();
    assert.equal(eof.kind, "eof");
    assert.deepEqual(eofSource.next(), eof);
  });

  it("retains BOM inside protected non-identifier regions", () => {
    assert.deepEqual(descriptionsFor("'\uFEFF' $$\uFEFF$$ -- \uFEFF\nword"), [
      "standard_string",
      "dollar_quoted",
      "word:word",
    ]);
    expectRefusal(sourceFor('"\uFEFF"').next(), "identifier_contains_unsafe_character");
  });
});
