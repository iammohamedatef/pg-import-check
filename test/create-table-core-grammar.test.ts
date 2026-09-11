import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recognizeCreateTableCoreShape } from "../src/create-table-core-shape.js";
import { applyRawInputProfile } from "../src/input-profile.js";
import {
  UTF8_BOM,
  acceptText,
  columnExpressionSpan,
  concatenate,
  expectAccepted,
  expectEndOfInput,
  expectRecognized,
  expectRefused,
  expectUnbalanced,
  expectUnexpectedToken,
  firstLexicalRefusal,
  recognizeText,
  spanText,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();
describe("recognizeCreateTableCoreShape", () => {
  it("returns a cohesive ordered shape with exact identity and type spans", () => {
    const sourceText = [
      "/* leading */\r\n",
      'CrEaTe TeMpOrArY TABLE IF NOT EXISTS "App"."Ledger" (\r\n',
      '  "Entry" constraint.int(00010, 002) [ ] [ ],\r\n',
      '  note "NOT"\r\n',
      ") ; -- trailing",
    ].join("");
    const input = acceptText(sourceText);
    const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));

    assert.equal(coreShape.temporary, true);
    assert.equal(
      spanText(input, coreShape.span),
      sourceText.slice(sourceText.indexOf("CrEaTe"), sourceText.lastIndexOf(")") + 1),
    );
    assert.equal(sourceText[coreShape.span.end.rawByteOffset], " ");

    assert.equal(coreShape.table.qualifier?.identity, "App");
    assert.equal(coreShape.table.qualifier?.quoted, true);
    assert.equal(coreShape.table.local.identity, "Ledger");
    assert.equal(coreShape.table.local.quoted, true);
    assert.equal(spanText(input, coreShape.table.span), '"App"."Ledger"');

    assert.deepEqual(
      coreShape.derived.columns.map((column) => [column.name.identity, column.name.quoted]),
      [
        ["Entry", true],
        ["note", false],
      ],
    );
    assert.equal(
      spanText(input, coreShape.derived.columns[0]?.span ?? assert.fail("missing first column")),
      '"Entry" constraint.int(00010, 002) [ ] [ ]',
    );

    const firstType = coreShape.derived.columns[0]?.type ?? assert.fail("missing first type");
    assert.equal(firstType.name.qualifier?.identity, "constraint");
    assert.equal(firstType.name.local.identity, "int");
    assert.equal(firstType.arrayDimensions, 2);
    assert.equal(spanText(input, firstType.span), "constraint.int(00010, 002) [ ] [ ]");
    assert.deepEqual(
      firstType.modifierDigitSpans.map((modifier) => spanText(input, modifier)),
      ["00010", "002"],
    );

    const secondType = coreShape.derived.columns[1]?.type ?? assert.fail("missing second type");
    assert.equal(secondType.name.qualifier, null);
    assert.equal(secondType.name.local.identity, "NOT");
    assert.equal(secondType.name.local.quoted, true);
    assert.deepEqual(secondType.modifierDigitSpans, []);
    assert.equal(secondType.arrayDimensions, 0);

    const identityShape = expectRecognized(
      recognizeText('create table MiXeD ("é" int, "é" int)'),
    ).coreShape;
    assert.equal(identityShape.table.local.identity, "mixed");
    assert.deepEqual(
      identityShape.derived.columns.map((column) => column.name.identity),
      ["é", "é"],
    );
    assert.notEqual(
      identityShape.derived.columns[0]?.name.identity,
      identityShape.derived.columns[1]?.name.identity,
    );
  });
  it("recognizes each optional prefix and only one optional terminator", () => {
    const cases = [
      { sourceText: "create table t (c int)", temporary: false },
      { sourceText: "CREATE TEMP TABLE t (c int);", temporary: true },
      { sourceText: "create temporary table t(c int) -- trailing", temporary: true },
      { sourceText: "create table if not exists t (c int) /* trailing */", temporary: false },
      {
        sourceText:
          "CREATE/*1*/TEMP/*2*/TABLE/*3*/IF/*4*/NOT/*5*/EXISTS/*6*/q/*7*/./*8*/t/*9*/(/*10*/c/*11*/int/*12*/)/*13*/;/*14*/",
        temporary: true,
        qualifier: "q",
      },
    ];

    for (const testCase of cases) {
      const { coreShape } = expectRecognized(recognizeText(testCase.sourceText));
      assert.equal(coreShape.temporary, testCase.temporary, testCase.sourceText);
      assert.equal(coreShape.table.local.identity, "t", testCase.sourceText);
      assert.equal(
        coreShape.table.qualifier?.identity ?? null,
        testCase.qualifier ?? null,
        testCase.sourceText,
      );
      assert.equal(coreShape.derived.columns.length, 1, testCase.sourceText);
    }

    for (const sourceText of ["create table t (c int);;", "create table t (c int); ;"]) {
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        ";",
      );
    }
  });
  it("retains every supported type component, modifier, and array shape", () => {
    const cases = [
      {
        typeText: "integer",
        qualifier: null,
        local: "integer",
        localQuoted: false,
        modifiers: [],
        arrays: 0,
      },
      {
        typeText: "catalog.numeric ( 0001 )",
        qualifier: "catalog",
        local: "numeric",
        localQuoted: false,
        modifiers: ["0001"],
        arrays: 0,
      },
      {
        typeText: '"Catalog"."Type"(01, 002) [ ] []',
        qualifier: "Catalog",
        local: "Type",
        localQuoted: true,
        modifiers: ["01", "002"],
        arrays: 2,
      },
      {
        typeText: '"NULL"[][][]',
        qualifier: null,
        local: "NULL",
        localQuoted: true,
        modifiers: [],
        arrays: 3,
      },
    ];

    for (const testCase of cases) {
      const sourceText = `create table t (c ${testCase.typeText})`;
      const input = acceptText(sourceText);
      const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));
      const type = coreShape.derived.columns[0]?.type ?? assert.fail("missing type");

      assert.equal(spanText(input, type.span), testCase.typeText, testCase.typeText);
      assert.equal(type.name.qualifier?.identity ?? null, testCase.qualifier, testCase.typeText);
      assert.equal(type.name.local.identity, testCase.local, testCase.typeText);
      assert.equal(type.name.local.quoted, testCase.localQuoted, testCase.typeText);
      assert.deepEqual(
        type.modifierDigitSpans.map((span) => spanText(input, span)),
        testCase.modifiers,
        testCase.typeText,
      );
      assert.equal(type.arrayDimensions, testCase.arrays, testCase.typeText);
    }
  });
  it("dispatches the closed table-element keyword alternatives before core columns", () => {
    const unsupportedStarters = ["LIKE", "EXCLUDE"];

    for (const starter of unsupportedStarters) {
      const unquoted = `create table t (${starter} int)`;
      const unquotedInput = acceptText(unquoted);
      assert.equal(
        spanText(
          unquotedInput,
          expectUnexpectedToken(unquotedInput, recognizeCreateTableCoreShape(unquotedInput)),
        ),
        starter,
      );

      const quoted = expectRecognized(recognizeText(`create table t ("${starter}" USING)`));
      assert.equal(quoted.coreShape.derived.columns[0]?.name.identity, starter);
      assert.equal(quoted.coreShape.derived.columns[0]?.name.quoted, true);
      assert.equal(quoted.coreShape.derived.columns[0]?.type.name.local.identity, "using");
    }

    const committedForeign = acceptText("create table t (FOREIGN int)");
    assert.equal(
      spanText(
        committedForeign,
        expectUnexpectedToken(committedForeign, recognizeCreateTableCoreShape(committedForeign)),
      ),
      "int",
    );

    const tableCheck = expectRecognized(recognizeText("create table t (CHECK (true))"));
    assert.equal(tableCheck.coreShape.derived.columns.length, 0);
    assert.equal(tableCheck.coreShape.derived.tableCheckConstraints.length, 1);

    const quotedCheck = expectRecognized(recognizeText('create table t ("CHECK" USING)'));
    assert.equal(quotedCheck.coreShape.derived.columns[0]?.name.identity, "CHECK");
    assert.equal(quotedCheck.coreShape.derived.columns[0]?.name.quoted, true);
    assert.equal(quotedCheck.coreShape.derived.columns[0]?.type.name.local.identity, "using");

    const committedWrapper = acceptText("create table t (CONSTRAINT int)");
    assert.equal(
      spanText(
        committedWrapper,
        expectUnexpectedToken(committedWrapper, recognizeCreateTableCoreShape(committedWrapper)),
      ),
      ")",
    );
  });
  it("stops at EXCLUDE without scanning the committed table-element alternative", () => {
    const cases = [
      "create table t (EXCLUDE USING)",
      "create table t (id int, EXCLUDE USING)",
      "create table booking (room text, during tstzrange, EXCLUDE USING gist (room WITH =, during WITH &&) WHERE (NOT isempty(during)))",
    ];
    for (const sourceText of cases) {
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        "EXCLUDE",
        sourceText,
      );
    }

    const malformedTailInput = acceptText("create table t (id int, EXCLUDE USING 'unterminated");
    const malformedTailResult = recognizeCreateTableCoreShape(malformedTailInput);
    const boundary = expectUnexpectedToken(malformedTailInput, malformedTailResult);
    assert.deepEqual(boundary, {
      start: { rawByteOffset: 24, line: 1, column: 25 },
      end: { rawByteOffset: 31, line: 1, column: 32 },
    });
    assert.equal(spanText(malformedTailInput, boundary), "EXCLUDE");
    assert.deepEqual(recognizeCreateTableCoreShape(malformedTailInput), malformedTailResult);
  });
  it("retains the LIKE dispatch regression without scanning later syntax", () => {
    const likeCases = [
      "create table t (LIKE parent)",
      "create table t (LIKE public.parent)",
      "create table t (LIKE parent 'unterminated)",
    ];
    for (const sourceText of likeCases) {
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        "LIKE",
        sourceText,
      );
    }
  });
  it("keeps dispatched words in table-name and type roles and ordinary columns on fallback", () => {
    for (const word of ["EXCLUDE", "LIKE", "FOREIGN"]) {
      const { coreShape } = expectRecognized(recognizeText(`create table ${word} (value ${word})`));
      assert.equal(coreShape.table.local.identity, word.toLowerCase(), word);
      assert.equal(
        coreShape.derived.columns[0]?.type.name.local.identity,
        word.toLowerCase(),
        word,
      );
    }

    const representative = expectRecognized(
      recognizeText("create table t (id bigint, amount numeric(10,2), labels app.label[][])"),
    ).coreShape;
    assert.deepEqual(
      representative.derived.columns.map((column) => column.name.identity),
      ["id", "amount", "labels"],
    );
    assert.deepEqual(
      representative.derived.columns.map((column) => column.type.name.local.identity),
      ["bigint", "numeric", "label"],
    );
    assert.equal(representative.derived.columns[2]?.type.arrayDimensions, 2);
  });
  it("commits IF before a table identifier while leaving unrelated words available", () => {
    const allowedKeywordNames = expectRecognized(
      recognizeText(
        "create table table (not int, null int, references int, default int, generated int, create int)",
      ),
    );
    assert.deepEqual(
      allowedKeywordNames.coreShape.derived.columns.map((column) => column.name.identity),
      ["not", "null", "references", "default", "generated", "create"],
    );

    const committedIfInput = acceptText("create table if (c int)");
    assert.equal(
      spanText(
        committedIfInput,
        expectUnexpectedToken(committedIfInput, recognizeCreateTableCoreShape(committedIfInput)),
      ),
      "(",
    );
    assert.equal(
      expectRecognized(recognizeText('create table "if" (c int)')).coreShape.table.local.identity,
      "if",
    );

    const bareUescape = expectRecognized(
      recognizeText("create table UESCAPE (UESCAPE UESCAPE)"),
    ).coreShape;
    assert.equal(bareUescape.table.local.identity, "uescape");
    assert.equal(bareUescape.derived.columns[0]?.name.identity, "uescape");
    assert.equal(bareUescape.derived.columns[0]?.type.name.local.identity, "uescape");

    const apparentUescapeInput = acceptText("create table t (c int UESCAPE '!')");
    assert.equal(
      spanText(
        apparentUescapeInput,
        expectUnexpectedToken(
          apparentUescapeInput,
          recognizeCreateTableCoreShape(apparentUescapeInput),
        ),
      ),
      "UESCAPE",
    );
  });
  it("forbids the nine local type words but permits identifier qualifiers and quoted locals", () => {
    const excludedWords = [
      "constraint",
      "not",
      "null",
      "primary",
      "unique",
      "check",
      "references",
      "default",
      "generated",
    ];

    for (const word of excludedWords) {
      for (const typeText of [word, `q.${word}`]) {
        const input = acceptText(`create table t (c ${typeText})`);
        assert.equal(
          spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
          word,
          typeText,
        );
      }

      const qualified = expectRecognized(recognizeText(`create table t (c ${word}.int)`));
      assert.equal(qualified.coreShape.derived.columns[0]?.type.name.qualifier?.identity, word);
      assert.equal(qualified.coreShape.derived.columns[0]?.type.name.local.identity, "int");

      const quoted = expectRecognized(recognizeText(`create table t (c "${word.toUpperCase()}")`));
      assert.equal(
        quoted.coreShape.derived.columns[0]?.type.name.local.identity,
        word.toUpperCase(),
      );
      assert.equal(quoted.coreShape.derived.columns[0]?.type.name.local.quoted, true);
    }

    const foreignType = expectRecognized(recognizeText("create table t (c foreign)"));
    assert.equal(foreignType.coreShape.derived.columns[0]?.type.name.local.identity, "foreign");
  });
  it("stops dispatch as soon as another family or prefix is established", () => {
    const cases = [
      { sourceText: "SELECT 'unterminated", boundary: "SELECT" },
      { sourceText: "ALTER TABLE 'unterminated", boundary: "ALTER" },
      { sourceText: "COMMENT ON 'unterminated", boundary: "COMMENT" },
      { sourceText: "CREATE VIEW 'unterminated", boundary: "VIEW" },
      { sourceText: "CREATE TYPE 'unterminated", boundary: "TYPE" },
      { sourceText: "CREATE POLICY 'unterminated", boundary: "POLICY" },
      { sourceText: "CREATE FUNCTION 'unterminated", boundary: "FUNCTION" },
      { sourceText: "CREATE TRIGGER 'unterminated", boundary: "TRIGGER" },
      { sourceText: "CREATE CONSTRAINT TRIGGER 'unterminated", boundary: "CONSTRAINT" },
      { sourceText: "CREATE INDEX 'unterminated", boundary: "INDEX" },
      { sourceText: "CREATE UNIQUE INDEX 'unterminated", boundary: "UNIQUE" },
      { sourceText: "CREATE UNLOGGED TABLE 'unterminated", boundary: "UNLOGGED" },
      { sourceText: "CREATE OR REPLACE FUNCTION 'unterminated", boundary: "OR" },
      { sourceText: "CREATE TEMP VIEW 'unterminated", boundary: "VIEW" },
    ];

    for (const testCase of cases) {
      const input = acceptText(testCase.sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.sourceText,
      );
    }

    const constraintResult = expectRefused(recognizeText("create table t (primary 'unterminated"));
    assert.equal(constraintResult.refusal.refusalId, "unterminated_string");
  });
  it("distinguishes incomplete grammar from EOF with a committed delimiter", () => {
    const cases = [
      "",
      " -- only trivia",
      "CREATE",
      "CREATE TEMP",
      "CREATE TEMP TABLE",
      "CREATE TABLE",
      "CREATE TABLE IF",
      "CREATE TABLE IF NOT",
      "CREATE TABLE t",
    ];

    for (const sourceText of cases) {
      const input = acceptText(sourceText);
      expectEndOfInput(input, recognizeCreateTableCoreShape(input));
    }

    for (const sourceText of [
      "CREATE TABLE t (",
      "CREATE TABLE t (c",
      "CREATE TABLE t (c int",
      "CREATE TABLE t (c int,",
    ]) {
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnbalanced(recognizeCreateTableCoreShape(input))),
        "(",
        sourceText,
      );
    }
  });
  it("keeps malformed type and list forms as CREATE TABLE grammar misses", () => {
    const cases = [
      { sourceText: "create table t ()", boundary: ")" },
      { sourceText: "create table t (, c int)", boundary: "," },
      { sourceText: "create table t (c)", boundary: ")" },
      { sourceText: "create table t (c int,)", boundary: ")" },
      { sourceText: "create table t (c int,, d int)", boundary: "," },
      { sourceText: "create table a.b.c (c int)", boundary: "." },
      { sourceText: "create table t (c a.b.c)", boundary: "." },
      { sourceText: "create table t (c double precision)", boundary: "precision" },
      { sourceText: "create table t (c numeric())", boundary: ")" },
      { sourceText: "create table t (c numeric(,2))", boundary: "," },
      { sourceText: "create table t (c numeric(1,))", boundary: ")" },
      { sourceText: "create table t (c numeric(1,2,3))", boundary: "," },
      { sourceText: "create table t (c numeric(-1))", boundary: "-" },
      { sourceText: "create table t (c numeric(1.0))", boundary: "1.0" },
      { sourceText: "create table t (c int[1])", boundary: "1" },
    ];

    for (const testCase of cases) {
      const input = acceptText(testCase.sourceText);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.sourceText,
      );
    }

    const extraCloseInput = acceptText("create table t (c int[]])");
    assert.equal(
      spanText(extraCloseInput, expectUnbalanced(recognizeCreateTableCoreShape(extraCloseInput))),
      "]",
    );
  });
  it("owns typed delimiter mismatches and anchors outstanding EOF at the stack top", () => {
    const closeCases = [
      { sourceText: "create table t ]", offset: 15 },
      { sourceText: "create table t )", offset: 15 },
      { sourceText: "create table t (c int]", offset: 21 },
      { sourceText: "create table t (c int CHECK ((])", offset: 30 },
      { sourceText: "create table t (c int CHECK (([)]))", offset: 31 },
      { sourceText: "create table t (c numeric(1]", offset: 27 },
      { sourceText: "create table t (c int[)", offset: 22 },
    ];

    for (const testCase of closeCases) {
      const input = acceptText(testCase.sourceText);
      const span = expectUnbalanced(recognizeCreateTableCoreShape(input));
      assert.equal(span.start.rawByteOffset, testCase.offset, testCase.sourceText);
      assert.equal(span.end.rawByteOffset, testCase.offset + 1, testCase.sourceText);
    }

    const outstandingCases = [
      { sourceText: "create table t (c numeric(", opener: "(", offset: 25 },
      { sourceText: "create table t (c int[", opener: "[", offset: 21 },
      { sourceText: "create table t (c int CHECK ([value", opener: "[", offset: 29 },
    ];

    for (const testCase of outstandingCases) {
      const input = acceptText(testCase.sourceText);
      const span = expectUnbalanced(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, span), testCase.opener, testCase.sourceText);
      assert.equal(span.start.rawByteOffset, testCase.offset, testCase.sourceText);
    }
  });
  it("dispatches DEFAULT and the current CHECK clause in either order without stealing columns", () => {
    const sourceText = [
      "create table t (",
      "a int DEFAULT 1 CHECK (a > 0),",
      "b text CHECK (length(b) > 0) DEFAULT E'raw\\\\n',",
      '"DEFAULT" text DEFAULT public.value()',
      ")",
    ].join("\r\n");
    const input = acceptText(sourceText);
    const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));

    assert.deepEqual(
      coreShape.derived.columns.map((column) => column.name.identity),
      ["a", "b", "DEFAULT"],
    );
    assert.deepEqual(
      coreShape.derived.columns.map((column) =>
        spanText(
          input,
          columnExpressionSpan(column, "default") ?? assert.fail("missing DEFAULT span"),
        ),
      ),
      ["1", "E'raw\\\\n'", "public.value()"],
    );
    assert.deepEqual(
      coreShape.derived.columns.map((column) =>
        columnExpressionSpan(column, "check") === null
          ? null
          : spanText(input, columnExpressionSpan(column, "check") ?? assert.fail()),
      ),
      ["(a > 0)", "(length(b) > 0)", null],
    );
    assert.deepEqual(
      coreShape.derived.columns.map((column) =>
        column.clauseOccurrences.map((occurrence) => ({
          kind: occurrence.kind,
          clause: spanText(input, occurrence.clauseSpan),
          ...("expressionSpan" in occurrence
            ? { expression: spanText(input, occurrence.expressionSpan) }
            : {}),
        })),
      ),
      [
        [
          { kind: "default", clause: "DEFAULT 1", expression: "1" },
          { kind: "check", clause: "CHECK (a > 0)", expression: "(a > 0)" },
        ],
        [
          {
            kind: "check",
            clause: "CHECK (length(b) > 0)",
            expression: "(length(b) > 0)",
          },
          { kind: "default", clause: "DEFAULT E'raw\\\\n'", expression: "E'raw\\\\n'" },
        ],
        [{ kind: "default", clause: "DEFAULT public.value()", expression: "public.value()" }],
      ],
    );
  });
  it("retains bare nullability occurrences in source order across current clause orders", () => {
    const sourceText = [
      'CREATE TABLE "表" (',
      '  "é" int NULL DEFAULT 1 CHECK (true),',
      "  b text CHECK (b <> '') NOT /* required */ NULL DEFAULT E'raw\\\\n',",
      '  "NULL" "NOT" DEFAULT NULL NOT NULL,',
      '  "NOT" "NULL" NULL',
      ")",
    ].join("\r\n");
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const { columns } = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape.derived;

    assert.deepEqual(
      columns.map((column) => column.name.identity),
      ["é", "b", "NULL", "NOT"],
    );
    assert.deepEqual(
      columns.map((column) =>
        column.clauseOccurrences.map((occurrence) => ({
          kind: occurrence.kind,
          keyword: spanText(input, occurrence.keywordSpan),
          clause: spanText(input, occurrence.clauseSpan),
        })),
      ),
      [
        [
          { kind: "null", keyword: "NULL", clause: "NULL" },
          { kind: "default", keyword: "DEFAULT", clause: "DEFAULT 1" },
          { kind: "check", keyword: "CHECK", clause: "CHECK (true)" },
        ],
        [
          { kind: "check", keyword: "CHECK", clause: "CHECK (b <> '')" },
          { kind: "not_null", keyword: "NOT", clause: "NOT /* required */ NULL" },
          { kind: "default", keyword: "DEFAULT", clause: "DEFAULT E'raw\\\\n'" },
        ],
        [
          { kind: "default", keyword: "DEFAULT", clause: "DEFAULT NULL" },
          { kind: "not_null", keyword: "NOT", clause: "NOT NULL" },
        ],
        [{ kind: "null", keyword: "NULL", clause: "NULL" }],
      ],
    );

    const defaultNull = columns[2] ?? assert.fail("missing DEFAULT NULL control");
    assert.equal(
      spanText(
        input,
        columnExpressionSpan(defaultNull, "default") ?? assert.fail("missing DEFAULT span"),
      ),
      "NULL",
    );

    const notNull = defaultNull.clauseOccurrences[1] ?? assert.fail("missing NOT NULL");
    const notOffset = sourceText.indexOf("NOT NULL", sourceText.indexOf('"NULL"'));
    const lineStart = sourceText.lastIndexOf("\n", notOffset) + 1;
    assert.equal(spanText(input, notNull.keywordSpan), "NOT");
    assert.equal(spanText(input, notNull.clauseSpan), "NOT NULL");
    assert.equal(
      notNull.keywordSpan.start.rawByteOffset,
      UTF8_BOM.byteLength + encoder.encode(sourceText.slice(0, notOffset)).byteLength,
    );
    assert.equal(notNull.keywordSpan.start.line, 4);
    assert.equal(
      notNull.keywordSpan.start.column,
      Array.from(sourceText.slice(lineStart, notOffset)).length + 1,
    );
    assert.equal(spanText(input, defaultNull.span), '"NULL" "NOT" DEFAULT NULL NOT NULL');
  });
  it("recognizes every Issue #43 wrapper without making DEFAULT nameable", () => {
    const columnCases = [
      { clause: "NULL", kind: "null", underlying: "NULL" },
      { clause: "NOT NULL", kind: "not_null", underlying: "NOT NULL" },
      { clause: "PRIMARY KEY", kind: "primary_key", underlying: "PRIMARY KEY" },
      { clause: "UNIQUE", kind: "unique", underlying: "UNIQUE" },
      { clause: "CHECK (c > 0)", kind: "check", underlying: "CHECK (c > 0)" },
    ] as const;

    for (const testCase of columnCases) {
      const sourceText = `create table t (c int CONSTRAINT named ${testCase.clause})`;
      const input = acceptText(sourceText);
      const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
      const occurrence =
        shape.derived.columns[0]?.clauseOccurrences[0] ?? assert.fail("missing clause");
      const name = shape.derived.explicitConstraintNames[0] ?? assert.fail("missing explicit name");
      assert.equal(occurrence.kind, testCase.kind, testCase.clause);
      assert.equal(spanText(input, occurrence.keywordSpan), testCase.underlying.split(" ")[0]);
      assert.equal(spanText(input, occurrence.underlyingClauseSpan), testCase.underlying);
      assert.equal(spanText(input, occurrence.establishmentSpan), "CONSTRAINT");
      assert.equal(spanText(input, occurrence.clauseSpan), `CONSTRAINT named ${testCase.clause}`);
      assert.equal(occurrence.explicitConstraintName?.name.identity, "named");
      assert.deepEqual(
        {
          scope: name.scope,
          kind: name.kind,
          sourceOrder: name.sourceOrder,
          wrapper: spanText(input, name.wrapperSpan),
          underlying: spanText(input, name.underlyingClauseSpan),
          clause: spanText(input, name.clauseSpan),
        },
        {
          scope: "column",
          kind: testCase.kind,
          sourceOrder: 0,
          wrapper: "CONSTRAINT named",
          underlying: testCase.underlying,
          clause: `CONSTRAINT named ${testCase.clause}`,
        },
      );
    }

    for (const testCase of [
      { clause: "PRIMARY KEY (c)", kind: "primary_key" },
      { clause: "UNIQUE (c)", kind: "unique" },
    ] as const) {
      const sourceText = `create table t (c int, CONSTRAINT named ${testCase.clause})`;
      const input = acceptText(sourceText);
      const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
      const constraint = shape.derived.tableKeyConstraints[0] ?? assert.fail("missing table key");
      assert.equal(constraint.kind, testCase.kind);
      assert.equal(spanText(input, constraint.establishmentSpan), "CONSTRAINT");
      assert.equal(spanText(input, constraint.underlyingClauseSpan), testCase.clause);
      assert.equal(spanText(input, constraint.clauseSpan), `CONSTRAINT named ${testCase.clause}`);
      assert.equal(shape.derived.explicitConstraintNames[0]?.scope, "table");
    }

    const namedDefault = acceptText("create table t (c int CONSTRAINT named DEFAULT E'open");
    assert.equal(
      spanText(
        namedDefault,
        expectUnexpectedToken(namedDefault, recognizeCreateTableCoreShape(namedDefault)),
      ),
      "DEFAULT",
    );
  });
  it("retains one relation-wide named-constraint stream with exact Unicode coordinates", () => {
    const sourceText = [
      'CREATE TABLE "表" (',
      '  "é" int CONSTRAINT "名" CHECK ("😀"),',
      "  a int CONSTRAINT required NOT NULL,",
      '  CONSTRAINT pair UNIQUE (a, "é")',
      ")",
    ].join("\r\n");
    const input = expectAccepted(
      applyRawInputProfile(concatenate(UTF8_BOM, encoder.encode(sourceText))),
    );
    const names = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape.derived
      .explicitConstraintNames;

    assert.deepEqual(
      names.map((name) => ({
        scope: name.scope,
        kind: name.kind,
        identity: name.name.identity,
        quoted: name.name.quoted,
        sourceOrder: name.sourceOrder,
        keyword: spanText(input, name.constraintKeywordSpan),
        sourceName: spanText(input, name.name.span),
        wrapper: spanText(input, name.wrapperSpan),
        underlyingKeyword: spanText(input, name.underlyingKeywordSpan),
        underlying: spanText(input, name.underlyingClauseSpan),
        clause: spanText(input, name.clauseSpan),
      })),
      [
        {
          scope: "column",
          kind: "check",
          identity: "名",
          quoted: true,
          sourceOrder: 0,
          keyword: "CONSTRAINT",
          sourceName: '"名"',
          wrapper: 'CONSTRAINT "名"',
          underlyingKeyword: "CHECK",
          underlying: 'CHECK ("😀")',
          clause: 'CONSTRAINT "名" CHECK ("😀")',
        },
        {
          scope: "column",
          kind: "not_null",
          identity: "required",
          quoted: false,
          sourceOrder: 1,
          keyword: "CONSTRAINT",
          sourceName: "required",
          wrapper: "CONSTRAINT required",
          underlyingKeyword: "NOT",
          underlying: "NOT NULL",
          clause: "CONSTRAINT required NOT NULL",
        },
        {
          scope: "table",
          kind: "unique",
          identity: "pair",
          quoted: false,
          sourceOrder: 2,
          keyword: "CONSTRAINT",
          sourceName: "pair",
          wrapper: "CONSTRAINT pair",
          underlyingKeyword: "UNIQUE",
          underlying: 'UNIQUE (a, "é")',
          clause: 'CONSTRAINT pair UNIQUE (a, "é")',
        },
      ],
    );
    assert.deepEqual(names[0]?.constraintKeywordSpan, {
      start: { rawByteOffset: 36, line: 2, column: 11 },
      end: { rawByteOffset: 46, line: 2, column: 21 },
    });
    assert.deepEqual(names[0]?.name.span, {
      start: { rawByteOffset: 47, line: 2, column: 22 },
      end: { rawByteOffset: 52, line: 2, column: 25 },
    });
  });
  it("commits wrappers contextually and preserves malformed/unsupported ownership", () => {
    const keywordName = expectRecognized(
      recognizeText(
        "create table t (a int constraint NULL check ('CONSTRAINT ),];'), b int constraint PRIMARY unique, c int constraint DEFAULT null)",
      ),
    ).coreShape;
    assert.deepEqual(
      keywordName.derived.explicitConstraintNames.map((occurrence) => [
        occurrence.name.identity,
        occurrence.kind,
      ]),
      [
        ["null", "check"],
        ["primary", "unique"],
        ["default", "null"],
      ],
    );

    for (const testCase of [
      { clause: "CONSTRAINT )", boundary: ")" },
      { clause: "CONSTRAINT 1 NULL)", boundary: "1" },
      { clause: "CONSTRAINT 'name' NULL)", boundary: "'name'" },
      { clause: "CONSTRAINT named CONSTRAINT E'open", boundary: "CONSTRAINT" },
      { clause: "CONSTRAINT named DEFAULT E'open", boundary: "DEFAULT" },
      { clause: "CONSTRAINT named GENERATED E'open", boundary: "GENERATED" },
      { clause: "CONSTRAINT named PRIMARY wrong E'open", boundary: "wrong" },
      { clause: "CONSTRAINT named UNIQUE NULLS E'open", boundary: "NULLS" },
    ]) {
      const input = acceptText(`create table t (c int ${testCase.clause}`);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.clause,
      );
    }

    for (const testCase of [
      { constraint: "CONSTRAINT named CHECK true", boundary: "true" },
      { constraint: "CONSTRAINT named REFERENCES E'open", boundary: "REFERENCES" },
      { constraint: "CONSTRAINT named DEFAULT E'open", boundary: "DEFAULT" },
      { constraint: "CONSTRAINT named CONSTRAINT E'open", boundary: "CONSTRAINT" },
      { constraint: "CONSTRAINT named PRIMARY wrong E'open", boundary: "wrong" },
      { constraint: "CONSTRAINT named UNIQUE (c) WITH E'open", boundary: "WITH" },
    ]) {
      const input = acceptText(`create table t (c int, ${testCase.constraint}`);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        testCase.constraint,
      );
    }

    for (const sourceText of [
      'create table t (c int constraint "open',
      "create table t (c int constraint named check ([ E'open",
      'create table t (c int, constraint "open',
      "create table t (c int, constraint named check ([ E'open",
      'create table t (c int, constraint named unique ("open',
    ]) {
      const refusal = expectRefused(recognizeText(sourceText)).refusal;
      assert.equal(
        refusal.refusalId,
        sourceText.includes("E'open") ? "unterminated_string" : "unterminated_quoted_identifier",
        sourceText,
      );
    }

    for (const sourceText of [
      "create table t (c int constraint nameé null)",
      `create table t (c int constraint "${"a".repeat(64)}" null)`,
      'create table t (c int constraint "" null)',
      'create table t (c int constraint "\u200B" null)',
    ]) {
      const expected = firstLexicalRefusal(acceptText(sourceText));
      assert.deepEqual(expectRefused(recognizeText(sourceText)).refusal, expected, sourceText);
    }

    const quotedConstraint = expectRecognized(
      recognizeText('create table t ("CONSTRAINT" int, c int constraint "CONSTRAINT" null)'),
    ).coreShape;
    assert.equal(quotedConstraint.derived.columns[0]?.name.identity, "CONSTRAINT");
    assert.equal(quotedConstraint.derived.explicitConstraintNames[0]?.name.identity, "CONSTRAINT");

    const quotedClauseControl = acceptText('create table t (c int "CONSTRAINT")');
    assert.equal(
      spanText(
        quotedClauseControl,
        expectUnexpectedToken(
          quotedClauseControl,
          recognizeCreateTableCoreShape(quotedClauseControl),
        ),
      ),
      '"CONSTRAINT"',
    );
  });
  it("treats terminal PARTITION BY as one caller-bounded opaque expression", () => {
    const expression =
      "USING WITH ON TABLESPACE ([value; other]) $body$); USING WITH ON TABLESPACE [$body$";
    const sourceText = `create table t (c int) PARTITION BY ${expression}; -- trailing`;
    const input = acceptText(sourceText);
    const { coreShape } = expectRecognized(recognizeCreateTableCoreShape(input));

    assert.equal(
      spanText(input, coreShape.partitionByClause?.expressionSpan ?? assert.fail()),
      expression,
    );
    assert.equal(
      spanText(input, coreShape.span),
      `create table t (c int) PARTITION BY ${expression}`,
    );

    const boundaryInput = acceptText("create table t (c int) PARTITION BY hash(c); SELECT 1");
    assert.equal(
      spanText(
        boundaryInput,
        expectUnexpectedToken(boundaryInput, recognizeCreateTableCoreShape(boundaryInput)),
      ),
      "SELECT",
    );

    const twoSemicolons = acceptText("create table t (c int) PARTITION BY value;;");
    const secondSemicolon = expectUnexpectedToken(
      twoSemicolons,
      recognizeCreateTableCoreShape(twoSemicolons),
    );
    assert.equal(secondSemicolon.start.rawByteOffset, 42);
    assert.equal(spanText(twoSemicolons, secondSemicolon), ";");
  });
  it("requires PARTITION BY content without treating positive-depth semicolons as boundaries", () => {
    for (const sourceText of [
      "create table t (c int) PARTITION BY",
      "create table t (c int) PARTITION BY /* only */ -- trivia\r\n",
    ]) {
      const input = acceptText(sourceText);
      expectEndOfInput(input, recognizeCreateTableCoreShape(input));
    }

    const emptyAtSemicolon = acceptText("create table t (c int) PARTITION BY /* only */ ;");
    assert.equal(
      spanText(
        emptyAtSemicolon,
        expectUnexpectedToken(emptyAtSemicolon, recognizeCreateTableCoreShape(emptyAtSemicolon)),
      ),
      ";",
    );

    const nestedText = "create table t (c int) PARTITION BY ([left; right])";
    const nestedInput = acceptText(nestedText);
    const nested = expectRecognized(recognizeCreateTableCoreShape(nestedInput)).coreShape;
    assert.equal(
      spanText(nestedInput, nested.partitionByClause?.expressionSpan ?? assert.fail()),
      "([left; right])",
    );
  });
  it("keeps remaining extensions and statements outside the CREATE TABLE grammar", () => {
    const trailingCases = [
      { suffix: " CREATE TABLE other (c int)", boundary: "CREATE" },
      { suffix: "; CREATE TABLE other (c int)", boundary: "CREATE" },
      { suffix: "; -- gap\r\nSELECT 1", boundary: "SELECT" },
    ];
    for (const testCase of trailingCases) {
      const input = acceptText(`create table t (c int)${testCase.suffix}`);
      assert.equal(
        spanText(input, expectUnexpectedToken(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
      );
    }
  });
});
