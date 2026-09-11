import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConflictSelectableColumn } from "../src/create-table-column-conflicts.js";
import {
  recognizeCreateTableCoreShape,
  type CreateTableCoreShapeResult,
  type IdentifierIdentity,
} from "../src/create-table-core-shape.js";
import {
  type ForeignKeyReferencedColumns,
  type ParsedColumnReferencesClauseOccurrence,
  type ParsedTableForeignKeyConstraint,
  selectModeledForeignKeyDeclarationCandidate,
} from "../src/create-table-foreign-key-constraints.js";
import {
  buildTargetColumnAssociations,
  NO_TARGET_COLUMN_ORDINAL,
  uniquelyAssociatedOrdinal,
} from "../src/create-table-target-column-association.js";
import type { SourceSpan } from "../src/create-table-token-source.js";
import {
  applyRawInputProfile,
  MAX_RAW_INPUT_BYTES,
  type AcceptedRawInput,
} from "../src/input-profile.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RecognizedResult = Extract<CreateTableCoreShapeResult, { kind: "recognized_core_shape" }>;
type RefusedResult = Extract<CreateTableCoreShapeResult, { kind: "refused" }>;

function acceptText(sourceText: string): AcceptedRawInput {
  const result = applyRawInputProfile(encoder.encode(sourceText));
  if (result.kind !== "accepted") {
    assert.fail(`Expected accepted input, received ${result.refusalId}`);
  }
  return result;
}

function recognizeText(sourceText: string): CreateTableCoreShapeResult {
  return recognizeCreateTableCoreShape(acceptText(sourceText));
}

function expectRecognized(result: CreateTableCoreShapeResult): RecognizedResult {
  if (result.kind !== "recognized_core_shape") {
    assert.fail(`Expected recognized core shape, received ${result.kind}`);
  }
  return result;
}

function expectRefused(result: CreateTableCoreShapeResult): RefusedResult {
  if (result.kind !== "refused") {
    assert.fail(`Expected refusal, received ${result.kind}`);
  }
  return result;
}

function expectAmbiguous(result: CreateTableCoreShapeResult): SourceSpan {
  const { refusal } = expectRefused(result);
  assert.equal(refusal.refusalId, "ambiguous_declaration");
  return refusal.span;
}

function expectUnexpected(input: AcceptedRawInput, result: CreateTableCoreShapeResult): SourceSpan {
  if (result.kind !== "not_recognized_by_create_table_grammar") {
    assert.fail(`Expected CREATE TABLE grammar miss, received ${result.kind}`);
  }
  if (result.boundary.kind !== "unexpected_token") {
    assert.fail("Expected an unexpected-token boundary");
  }
  assert.equal(result.boundary.span.end.rawByteOffset <= input.rawBytes.byteLength, true);
  return result.boundary.span;
}

function spanText(input: AcceptedRawInput, span: SourceSpan): string {
  return decoder.decode(input.rawBytes.subarray(span.start.rawByteOffset, span.end.rawByteOffset));
}

function columnReferences(
  result: RecognizedResult,
  columnOrdinal: number,
): ParsedColumnReferencesClauseOccurrence {
  const occurrence = result.coreShape.derived.columns[columnOrdinal]?.clauseOccurrences.find(
    (item) => item.kind === "references",
  );
  if (occurrence?.kind !== "references") {
    assert.fail("Expected a column REFERENCES occurrence");
  }
  return occurrence;
}

function locationSpan(rawByteOffset: number, width = 1): SourceSpan {
  return {
    start: { rawByteOffset, line: 1, column: rawByteOffset + 1 },
    end: { rawByteOffset: rawByteOffset + width, line: 1, column: rawByteOffset + width + 1 },
  };
}

function identity(identityText: string, rawByteOffset: number): IdentifierIdentity {
  return {
    identity: identityText,
    quoted: false,
    span: locationSpan(rawByteOffset, identityText.length),
  };
}

function selectableColumn(identityText: string, ordinal: number): ConflictSelectableColumn {
  const name = identity(identityText, ordinal * 10);
  return {
    name,
    type: {
      name: { qualifier: null, local: identity("int", ordinal * 10 + 2) },
      modifierDigitSpans: [],
      arrayDimensions: 0,
    },
    clauseOccurrences: [],
  };
}

function tableForeignKeyFixture(
  localIdentities: readonly string[],
  referencedIdentities: readonly string[],
  options: {
    readonly anchorOffset?: number;
    readonly referencedRelation?: string;
  } = {},
): ParsedTableForeignKeyConstraint {
  const anchorOffset = options.anchorOffset ?? 100;
  const foreignKeywordSpan = locationSpan(anchorOffset, 7);
  const referencedColumns: ForeignKeyReferencedColumns = {
    kind: "explicit_referenced_columns",
    list: {
      span: locationSpan(anchorOffset + 80, 20),
      columnReferences: referencedIdentities.map((name, ordinal) =>
        identity(name, anchorOffset + 81 + ordinal * 3),
      ),
    },
  };
  return {
    kind: "foreign_key",
    foreignKeywordSpan,
    keyKeywordSpan: locationSpan(anchorOffset + 8, 3),
    referencesKeywordSpan: locationSpan(anchorOffset + 50, 10),
    establishmentSpan: foreignKeywordSpan,
    underlyingClauseSpan: { start: foreignKeywordSpan.start, end: referencedColumns.list.span.end },
    clauseSpan: { start: foreignKeywordSpan.start, end: referencedColumns.list.span.end },
    localColumns: {
      span: locationSpan(anchorOffset + 12, 30),
      columnReferences: localIdentities.map((name, ordinal) =>
        identity(name, anchorOffset + 13 + ordinal * 3),
      ),
    },
    referencedRelation: {
      qualifier: null,
      local: identity(options.referencedRelation ?? "parent", anchorOffset + 61),
      span: locationSpan(anchorOffset + 61, (options.referencedRelation ?? "parent").length),
    },
    referencedColumns,
    explicitConstraintName: null,
  };
}

describe("CREATE TABLE foreign-key recognition", () => {
  it("builds one discriminated target association index and uses complete table declarations", () => {
    const columns = [selectableColumn("a", 0), selectableColumn("b", 1)];
    const associations = buildTargetColumnAssociations(columns);
    assert.deepEqual(associations.get("a"), { kind: "unique", ordinal: 0 });
    assert.equal(uniquelyAssociatedOrdinal(associations.get("b")), 1);
    assert.equal(uniquelyAssociatedOrdinal(associations.get("missing")), NO_TARGET_COLUMN_ORDINAL);

    const duplicateAssociations = buildTargetColumnAssociations([
      ...columns,
      selectableColumn("a", 2),
    ]);
    assert.deepEqual(duplicateAssociations.get("a"), { kind: "ambiguous" });
    assert.equal(
      uniquelyAssociatedOrdinal(duplicateAssociations.get("a")),
      NO_TARGET_COLUMN_ORDINAL,
    );

    for (const foreignKey of [
      tableForeignKeyFixture(["missing", "b", "a"], ["x", "y", "z"]),
      tableForeignKeyFixture(["b", "b", "a"], ["x", "y", "z"]),
    ]) {
      const candidate = selectModeledForeignKeyDeclarationCandidate(
        columns,
        [foreignKey],
        associations,
      );
      assert.equal(candidate?.kind, "ambiguous_declaration");
      assert.equal(candidate.targetColumnOrdinal, 0);
      assert.deepEqual(candidate.refusal.span, foreignKey.foreignKeywordSpan);
    }
  });

  it("canonicalizes pair sets independently of physical order with scalar-ordered tie keys", () => {
    const declarations = [
      tableForeignKeyFixture(["a", "b"], ["x", "y"], { anchorOffset: 100 }),
      tableForeignKeyFixture(["b", "a"], ["y", "x"], { anchorOffset: 200 }),
    ];
    const columnsInSourceOrder = [selectableColumn("a", 0), selectableColumn("b", 1)];
    const reversedColumns = [selectableColumn("b", 0), selectableColumn("a", 1)];
    const sourceOrderCandidate = selectModeledForeignKeyDeclarationCandidate(
      columnsInSourceOrder,
      declarations,
      buildTargetColumnAssociations(columnsInSourceOrder),
    );
    const reversedOrderCandidate = selectModeledForeignKeyDeclarationCandidate(
      reversedColumns,
      declarations,
      buildTargetColumnAssociations(reversedColumns),
    );
    assert.equal(sourceOrderCandidate?.kind, "ambiguous_declaration");
    assert.equal(reversedOrderCandidate?.kind, "ambiguous_declaration");
    assert.equal(
      sourceOrderCandidate.normalizedIdentity,
      reversedOrderCandidate.normalizedIdentity,
    );

    const singletonColumns = [selectableColumn("a", 0)];
    const duplicateGroup = (
      referencedRelation: string,
      localIdentity = "a",
      remoteIdentity = "x",
    ): readonly [ParsedTableForeignKeyConstraint, ParsedTableForeignKeyConstraint] => [
      tableForeignKeyFixture([localIdentity], [remoteIdentity], {
        anchorOffset: 50,
        referencedRelation,
      }),
      tableForeignKeyFixture([localIdentity], [remoteIdentity], {
        anchorOffset: 100,
        referencedRelation,
      }),
    ];
    const aaCandidate = selectModeledForeignKeyDeclarationCandidate(
      singletonColumns,
      duplicateGroup("aa"),
      buildTargetColumnAssociations(singletonColumns),
    );
    const aaGroup = duplicateGroup("aa");
    const bGroup = duplicateGroup("b");
    const scalarTieCandidate = selectModeledForeignKeyDeclarationCandidate(
      singletonColumns,
      [aaGroup[0], bGroup[0], aaGroup[1], bGroup[1]],
      buildTargetColumnAssociations(singletonColumns),
    );
    assert.equal(aaCandidate?.kind, "ambiguous_declaration");
    assert.equal(scalarTieCandidate?.kind, "ambiguous_declaration");
    assert.equal(scalarTieCandidate.normalizedIdentity, aaCandidate.normalizedIdentity);

    const collisionColumns = [selectableColumn("a", 0), selectableColumn("ab", 1)];
    const shortParts = selectModeledForeignKeyDeclarationCandidate(
      collisionColumns,
      duplicateGroup("p", "a", "bc"),
      buildTargetColumnAssociations(collisionColumns),
    );
    const longParts = selectModeledForeignKeyDeclarationCandidate(
      collisionColumns,
      duplicateGroup("p", "ab", "c"),
      buildTargetColumnAssociations(collisionColumns),
    );
    assert.equal(shortParts?.kind, "ambiguous_declaration");
    assert.equal(longParts?.kind, "ambiguous_declaration");
    assert.notEqual(shortParts.normalizedIdentity, longParts.normalizedIdentity);

    const multibyte = selectModeledForeignKeyDeclarationCandidate(
      singletonColumns,
      duplicateGroup("é", "a", "𐀀"),
      buildTargetColumnAssociations(singletonColumns),
    );
    const decomposed = selectModeledForeignKeyDeclarationCandidate(
      singletonColumns,
      duplicateGroup("é", "a", "é"),
      buildTargetColumnAssociations(singletonColumns),
    );
    assert.equal(multibyte?.kind, "ambiguous_declaration");
    assert.equal(decomposed?.kind, "ambiguous_declaration");
    assert.notEqual(multibyte.normalizedIdentity, aaCandidate.normalizedIdentity);
    assert.notEqual(multibyte.normalizedIdentity, decomposed.normalizedIdentity);
  });

  it("retains source-faithful inline and table FK evidence with exact Unicode coordinates", () => {
    const sourceText = [
      '\uFEFFCREATE TABLE "目标" (\r\n',
      '  "甲" int CONSTRAINT "联" REFERENCES "架"."表"("列") NULL,\r\n',
      '  "乙" int,\r\n',
      '  CONSTRAINT fk FOREIGN KEY ("乙","甲") REFERENCES remote ("远","远")\r\n',
      ")",
    ].join("");
    const input = acceptText(sourceText);
    const result = expectRecognized(recognizeCreateTableCoreShape(input));
    const inline = columnReferences(result, 0);

    assert.equal(spanText(input, inline.keywordSpan), "REFERENCES");
    assert.equal(inline.keywordSpan.start.line, 2);
    assert.equal(spanText(input, inline.underlyingClauseSpan), 'REFERENCES "架"."表"("列")');
    assert.equal(spanText(input, inline.clauseSpan), 'CONSTRAINT "联" REFERENCES "架"."表"("列")');
    assert.equal(inline.referencedRelation.qualifier?.identity, "架");
    assert.equal(inline.referencedRelation.local.identity, "表");
    assert.equal(inline.referencedRelation.qualifier?.quoted, true);
    assert.equal(spanText(input, inline.referencedRelation.span), '"架"."表"');
    assert.equal(inline.referencedColumns.kind, "explicit_referenced_columns");
    if (inline.referencedColumns.kind === "explicit_referenced_columns") {
      assert.equal(spanText(input, inline.referencedColumns.list.span), '("列")');
      assert.deepEqual(
        inline.referencedColumns.list.columnReferences.map((reference) => reference.identity),
        ["列"],
      );
    }

    const table = result.coreShape.derived.tableForeignKeyConstraints[0];
    assert.ok(table);
    assert.equal(table.foreignKeywordSpan.start.line, 4);
    assert.equal(spanText(input, table.foreignKeywordSpan), "FOREIGN");
    assert.equal(spanText(input, table.keyKeywordSpan), "KEY");
    assert.equal(spanText(input, table.referencesKeywordSpan), "REFERENCES");
    assert.equal(
      spanText(input, table.underlyingClauseSpan),
      'FOREIGN KEY ("乙","甲") REFERENCES remote ("远","远")',
    );
    assert.equal(
      spanText(input, table.clauseSpan),
      'CONSTRAINT fk FOREIGN KEY ("乙","甲") REFERENCES remote ("远","远")',
    );
    assert.deepEqual(
      table.localColumns.columnReferences.map((reference) => reference.identity),
      ["乙", "甲"],
    );
    assert.equal(spanText(input, table.localColumns.span), '("乙","甲")');
    assert.equal(table.referencedColumns.kind, "explicit_referenced_columns");
    if (table.referencedColumns.kind === "explicit_referenced_columns") {
      assert.deepEqual(
        table.referencedColumns.list.columnReferences.map((reference) => reference.identity),
        ["远", "远"],
      );
    }

    assert.deepEqual(
      result.coreShape.derived.explicitConstraintNames.map((name) => [
        name.scope,
        name.kind,
        name.name.identity,
      ]),
      [
        ["column", "references", "联"],
        ["table", "foreign_key", "fk"],
      ],
    );
  });

  it("keeps REFERENCES contextual and preserves existing column-clause boundaries", () => {
    const sourceText =
      "create table t (" +
      "a int DEFAULT 'REFERENCES, FOREIGN KEY' REFERENCES parent(id) CHECK (true) NOT NULL UNIQUE," +
      '"FOREIGN" KEY,' +
      '"REFERENCES" int' +
      ")";
    const result = expectRecognized(recognizeText(sourceText));

    assert.deepEqual(
      result.coreShape.derived.columns[0]?.clauseOccurrences.map((occurrence) => occurrence.kind),
      ["default", "references", "check", "not_null", "unique"],
    );
    assert.equal(result.coreShape.derived.columns[1]?.name.identity, "FOREIGN");
    assert.equal(result.coreShape.derived.columns[1]?.type.name.local.identity, "key");
    assert.equal(result.coreShape.derived.columns[2]?.name.identity, "REFERENCES");

    for (const accepted of [
      "create table t (REFERENCES int)",
      'create table t (c "REFERENCES")',
      "create table t (A int, foreign key (a) references p(x))",
      'create table t ("A" int, foreign key ("A") references p(x))',
      "create table t (a int, foreign key (a) references p, b int)",
    ]) {
      expectRecognized(recognizeText(accepted));
    }

    const apparentSelfReference = expectRecognized(
      recognizeText("create table t (a int references t)"),
    );
    const selfReference = columnReferences(apparentSelfReference, 0);
    assert.equal(selfReference.referencedRelation.local.identity, "t");
    assert.equal(selfReference.referencedColumns.kind, "referenced_columns_omitted");

    const quotedMismatch = acceptText('create table t ("A" int, foreign key (a) references p(x))');
    assert.equal(
      spanText(quotedMismatch, expectAmbiguous(recognizeCreateTableCoreShape(quotedMismatch))),
      "foreign",
    );
  });

  it("matches explicit FK declarations by an unordered set of positional pairs", () => {
    type Model = {
      readonly relation: readonly string[];
      readonly local: readonly string[];
      readonly remote: readonly string[] | null;
    };

    const models: readonly Model[] = [
      { relation: ["p"], local: ["a", "b"], remote: ["x", "y"] },
      { relation: ["p"], local: ["b", "a"], remote: ["y", "x"] },
      { relation: ["p"], local: ["b", "a"], remote: ["x", "y"] },
      { relation: ["p"], local: ["a", "b"], remote: ["y", "x"] },
      { relation: ["p"], local: ["a", "b"], remote: ["x", "x"] },
      { relation: ["p"], local: ["b", "a"], remote: ["x", "x"] },
      { relation: ["p"], local: ["a", "b"], remote: null },
      { relation: ["p"], local: ["b", "a"], remote: null },
      { relation: ["q", "p"], local: ["a", "b"], remote: ["x", "y"] },
    ];

    const equalIdentities = (left: Model, right: Model): boolean => {
      if (
        left.relation.length !== right.relation.length ||
        left.relation.some((part, index) => part !== right.relation[index]) ||
        (left.remote === null) !== (right.remote === null)
      ) {
        return false;
      }
      if (left.remote === null || right.remote === null) {
        return (
          left.remote === right.remote &&
          left.local.length === right.local.length &&
          left.local.every((member, index) => member === right.local[index])
        );
      }

      const leftPairs = left.local.map((local, index) => [local, left.remote?.[index]] as const);
      const rightPairs = right.local.map((local, index) => [local, right.remote?.[index]] as const);
      return (
        leftPairs.length === rightPairs.length &&
        leftPairs.every(([local, remote]) =>
          rightPairs.some(
            ([candidateLocal, candidateRemote]) =>
              local === candidateLocal && remote === candidateRemote,
          ),
        )
      );
    };
    const clause = (model: Model): string => {
      const relation = model.relation.join(".");
      const remote = model.remote === null ? "" : `(${model.remote.join(",")})`;
      return `foreign key (${model.local.join(",")}) references ${relation}${remote}`;
    };

    for (const [leftOrdinal, left] of models.entries()) {
      for (const right of models.slice(leftOrdinal)) {
        const sourceText = `create table t (a int,b int,${clause(left)},${clause(right)})`;
        const input = acceptText(sourceText);
        const result = recognizeCreateTableCoreShape(input);
        if (equalIdentities(left, right)) {
          assert.equal(
            spanText(input, expectAmbiguous(result)),
            "foreign",
            `${clause(left)} / ${clause(right)}`,
          );
          assert.equal(
            expectAmbiguous(result).start.rawByteOffset,
            sourceText.lastIndexOf("foreign"),
          );
        } else {
          expectRecognized(result);
        }
      }
    }
  });

  it("unifies inline and table singleton FKs while separating omitted and explicit lists", () => {
    const duplicateCases = [
      {
        sourceText: "create table t (a int references p(x), foreign key (a) references p(x))",
        anchor: "foreign",
      },
      {
        sourceText: "create table t (foreign key (a) references p(x), a int references p(x))",
        anchor: "references",
      },
      {
        sourceText: "create table t (a int references p, foreign key (a) references p)",
        anchor: "foreign",
      },
    ];
    for (const testCase of duplicateCases) {
      const input = acceptText(testCase.sourceText);
      const span = expectAmbiguous(recognizeCreateTableCoreShape(input));
      assert.equal(spanText(input, span), testCase.anchor);
      assert.equal(span.start.rawByteOffset, testCase.sourceText.lastIndexOf(testCase.anchor));
    }

    for (const distinct of [
      "create table t (a int references p, foreign key (a) references p(x))",
      "create table t (a int,b int,foreign key (a,b) references p,foreign key (b,a) references p)",
      "create table t (a int,foreign key (a) references p(x),foreign key (a) references q.p(x))",
      'create table t (a int,foreign key (a) references p(x),foreign key (a) references "P"(x))',
      "create table t (a int,ab int,foreign key (a) references p(bc),foreign key (ab) references p(c))",
    ]) {
      expectRecognized(recognizeText(distinct));
    }
  });

  it("validates local association and list cardinality only after complete parsing", () => {
    const foreignAmbiguities = [
      "create table t (a int, foreign key (missing) references p(x))",
      "create table t (a int,b int, foreign key (a,a) references p(x,y))",
      "create table t (a int,b int, foreign key (a,b) references p(x))",
      "create table t (a int,b int, foreign key (missing,b,a) references p(x))",
    ];
    for (const sourceText of foreignAmbiguities) {
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectAmbiguous(recognizeCreateTableCoreShape(input))),
        "foreign",
        sourceText,
      );
    }

    const columnCardinality = acceptText("create table t (a int references p(x,y))");
    assert.equal(
      spanText(
        columnCardinality,
        expectAmbiguous(recognizeCreateTableCoreShape(columnCardinality)),
      ),
      "references",
    );

    expectRecognized(
      recognizeText("create table t (foreign key (later) references p(x), later int)"),
    );
    expectRecognized(
      recognizeText("create table t (a int,b int,foreign key (a,b) references p(x,x))"),
    );

    const duplicateTargetText = "create table t (a int, A int, foreign key (a) references p(x))";
    const duplicateTargetInput = acceptText(duplicateTargetText);
    const duplicateTargetSpan = expectAmbiguous(
      recognizeCreateTableCoreShape(duplicateTargetInput),
    );
    assert.equal(spanText(duplicateTargetInput, duplicateTargetSpan), "A");
    assert.equal(duplicateTargetSpan.start.rawByteOffset, duplicateTargetText.indexOf("A int"));
  });

  it("keeps REFERENCES cardinality and FK/name ambiguity in the shared selector", () => {
    const distinctRepeated = acceptText("create table t (a int references p references q)");
    const conflict = expectRefused(recognizeCreateTableCoreShape(distinctRepeated)).refusal;
    assert.equal(conflict.refusalId, "conflicting_column_declaration");
    if (conflict.refusalId === "conflicting_column_declaration") {
      assert.deepEqual(conflict.clauseLabels, ["REFERENCES", "REFERENCES"]);
      assert.equal(spanText(distinctRepeated, conflict.span), "references");
      assert.equal(
        conflict.span.start.rawByteOffset,
        distinctRepeated.sourceText.lastIndexOf("references"),
      );
    }

    const equivalentRepeated = acceptText("create table t (a int references p references p)");
    assert.equal(
      spanText(
        equivalentRepeated,
        expectAmbiguous(recognizeCreateTableCoreShape(equivalentRepeated)),
      ),
      "references",
    );

    const nameWinsText =
      "create table t (a int,constraint n check(true),constraint N foreign key (missing) references p(x))";
    const nameWinsInput = acceptText(nameWinsText);
    assert.equal(
      spanText(nameWinsInput, expectAmbiguous(recognizeCreateTableCoreShape(nameWinsInput))),
      "constraint",
    );
    assert.equal(
      expectAmbiguous(recognizeCreateTableCoreShape(nameWinsInput)).start.rawByteOffset,
      nameWinsText.lastIndexOf("constraint"),
    );

    const foreignWinsText =
      "create table t (constraint n foreign key (missing) references p(x),a int,constraint N check(true))";
    const foreignWinsInput = acceptText(foreignWinsText);
    assert.equal(
      spanText(foreignWinsInput, expectAmbiguous(recognizeCreateTableCoreShape(foreignWinsInput))),
      "foreign",
    );

    const duplicateNameAndModelText =
      "create table t (a int,constraint n foreign key (a) references p(x),constraint N foreign key (a) references p(x))";
    const duplicateNameAndModelInput = acceptText(duplicateNameAndModelText);
    assert.equal(
      spanText(
        duplicateNameAndModelInput,
        expectAmbiguous(recognizeCreateTableCoreShape(duplicateNameAndModelInput)),
      ),
      "constraint",
    );
  });

  it("commits FK productions without scanning unsupported options or malformed tails", () => {
    const cases = [
      { body: "a int, FOREIGN wrong E'open", boundary: "wrong" },
      { body: "a int, FOREIGN KEY ) E'open", boundary: ")" },
      { body: "a int, FOREIGN KEY (a,) REFERENCES p E'open", boundary: ")" },
      { body: "a int,b int, FOREIGN KEY (a,,b) REFERENCES p(x,y)", boundary: "," },
      { body: "a int, FOREIGN KEY (a) WRONG E'open", boundary: "WRONG" },
      { body: "a int, FOREIGN KEY (a) REFERENCES ) E'open", boundary: ")" },
      { body: "a int, FOREIGN KEY (a) REFERENCES p. ) E'open", boundary: ")" },
      { body: "a int, FOREIGN KEY (a) REFERENCES p MATCH E'open", boundary: "MATCH" },
      { body: "a int REFERENCES p ON E'open", boundary: "ON" },
      { body: "a int CONSTRAINT fk REFERENCES p DEFERRABLE E'open", boundary: "DEFERRABLE" },
      { body: "a int, CONSTRAINT fk FOREIGN KEY (a) REFERENCES p ON E'open", boundary: "ON" },
      { body: "a int REFERENCES p() E'open", boundary: ")" },
      { body: "a int REFERENCES p(x,) E'open", boundary: ")" },
      { body: "a int REFERENCES p(x,,y) E'open", boundary: "," },
      { body: "a int, FOREIGN KEY () REFERENCES p E'open", boundary: ")" },
    ];

    for (const testCase of cases) {
      const sourceText = `create table t (${testCase.body})`;
      const input = acceptText(sourceText);
      assert.equal(
        spanText(input, expectUnexpected(input, recognizeCreateTableCoreShape(input))),
        testCase.boundary,
        sourceText,
      );
    }
  });

  it("preserves demanded lexical and typed-delimiter ownership inside FK grammar", () => {
    const refusedCases = [
      {
        sourceText: "create table t (a int references 'unterminated",
        refusalId: "unterminated_string",
        opening: "'",
        spanText: "'unterminated",
      },
      {
        sourceText: 'create table t (a int references "unterminated',
        refusalId: "unterminated_quoted_identifier",
        opening: '"',
        spanText: '"unterminated',
      },
      {
        sourceText: 'create table t (a int, foreign key (a) references U&"x")',
        refusalId: "unicode_escape_syntax_not_in_profile",
        opening: "U",
        spanText: "U&",
      },
      {
        sourceText: "create table t (a int references \uFEFFparent)",
        refusalId: "unexpected_bom",
        opening: "\uFEFF",
        spanText: "",
      },
    ];
    for (const testCase of refusedCases) {
      const input = acceptText(testCase.sourceText);
      const refusal = expectRefused(recognizeCreateTableCoreShape(input)).refusal;
      assert.equal(refusal.refusalId, testCase.refusalId, testCase.sourceText);
      assert.equal(spanText(input, refusal.span), testCase.spanText, testCase.sourceText);
      assert.equal(
        refusal.span.start.rawByteOffset,
        encoder.encode(
          testCase.sourceText.slice(0, testCase.sourceText.lastIndexOf(testCase.opening)),
        ).byteLength,
        testCase.sourceText,
      );
    }

    const mismatched = acceptText("create table t (a int references p(x])");
    const mismatchRefusal = expectRefused(recognizeCreateTableCoreShape(mismatched)).refusal;
    assert.equal(mismatchRefusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(mismatched, mismatchRefusal.span), "]");

    const outstandingText = "create table t (a int references p(x";
    const outstanding = acceptText(outstandingText);
    const outstandingRefusal = expectRefused(recognizeCreateTableCoreShape(outstanding)).refusal;
    assert.equal(outstandingRefusal.refusalId, "unbalanced_delimiter");
    assert.equal(spanText(outstanding, outstandingRefusal.span), "(");
    assert.equal(outstandingRefusal.span.start.rawByteOffset, outstandingText.lastIndexOf("("));
  });

  it("processes a near-cap composite FK in linear association and identity passes", () => {
    const fixedByteLength = encoder.encode(
      "create table t (,foreign key () references parent())",
    ).byteLength;
    const bytesPerMember = encoder.encode("c00000 int,c00000,r00000,").byteLength;
    const memberCount = Math.floor((MAX_RAW_INPUT_BYTES - fixedByteLength) / bytesPerMember);
    const localNames = Array.from(
      { length: memberCount },
      (_, ordinal) => `c${ordinal.toString().padStart(5, "0")}`,
    );
    const remoteNames = Array.from(
      { length: memberCount },
      (_, ordinal) => `r${ordinal.toString().padStart(5, "0")}`,
    );
    const sourceText =
      `create table t (${localNames.map((name) => `${name} int`).join(",")},` +
      `foreign key (${localNames.join(",")}) references parent(${remoteNames.join(",")}))`;
    const input = acceptText(sourceText);
    assert.equal(MAX_RAW_INPUT_BYTES - input.rawBytes.byteLength < bytesPerMember, true);

    const first = recognizeCreateTableCoreShape(input);
    assert.deepEqual(recognizeCreateTableCoreShape(input), first);
    const result = expectRecognized(first);
    assert.equal(result.coreShape.derived.columns.length, memberCount);
    const foreignKey = result.coreShape.derived.tableForeignKeyConstraints[0];
    assert.equal(foreignKey?.localColumns.columnReferences.length, memberCount);
    assert.equal(foreignKey?.referencedColumns.kind, "explicit_referenced_columns");
    if (foreignKey?.referencedColumns.kind === "explicit_referenced_columns") {
      assert.equal(foreignKey.referencedColumns.list.columnReferences.length, memberCount);
    }
  });
});
