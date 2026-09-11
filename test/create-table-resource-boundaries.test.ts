import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recognizeCreateTableCoreShape } from "../src/create-table-core-shape.js";
import { MAX_RAW_INPUT_BYTES } from "../src/input-profile.js";
import {
  acceptText,
  columnExpressionSpan,
  expectAmbiguous,
  expectConflict,
  expectRecognized,
  expectUnbalanced,
  recognizeText,
  spanText,
} from "./create-table-test-helpers.js";

const encoder = new TextEncoder();
describe("recognizeCreateTableCoreShape", () => {
  it("processes near-limit modeled key occurrences deterministically", () => {
    const prefix = "create table t (c int";
    const suffix = ")";
    const clause = " UNIQUE";
    const clauseCount = Math.floor(
      (MAX_RAW_INPUT_BYTES - encoder.encode(prefix + suffix).byteLength) / clause.length,
    );
    const sourceText = `${prefix}${clause.repeat(clauseCount)}${suffix}`;
    const input = acceptText(sourceText);
    assert.equal(input.rawBytes.byteLength > MAX_RAW_INPUT_BYTES - clause.length, true);

    const first = recognizeCreateTableCoreShape(input);
    assert.deepEqual(recognizeCreateTableCoreShape(input), first);
    const refusal = expectConflict(first);
    assert.deepEqual(refusal.clauseLabels, ["UNIQUE", "UNIQUE"]);
    assert.equal(spanText(input, refusal.span), "UNIQUE");
    assert.equal(refusal.span.start.rawByteOffset, sourceText.indexOf("UNIQUE") + clause.length);
  });
  it("processes a near-cap relation-wide explicit-name namespace in linear passes", () => {
    const columns: string[] = [];
    let rawByteLength = "create table t ()".length;
    for (let index = 0; ; index += 1) {
      const identity = index.toString().padStart(5, "0");
      const next = `c${identity} int constraint n${identity} null`;
      const nextRawByteLength = rawByteLength + next.length + (columns.length === 0 ? 0 : 1);
      if (nextRawByteLength > MAX_RAW_INPUT_BYTES) {
        break;
      }
      columns.push(next);
      rawByteLength = nextRawByteLength;
    }
    const sourceText = `create table t (${columns.join(",")})`;
    assert.equal(MAX_RAW_INPUT_BYTES - encoder.encode(sourceText).byteLength < 40, true);

    const first = recognizeText(sourceText);
    assert.deepEqual(recognizeText(sourceText), first);
    const shape = expectRecognized(first).coreShape;
    assert.equal(shape.derived.explicitConstraintNames.length, columns.length);
    assert.equal(shape.derived.explicitConstraintNames[0]?.name.identity, "n00000");
    assert.equal(
      shape.derived.explicitConstraintNames.at(-1)?.sourceOrder,
      shape.derived.explicitConstraintNames.length - 1,
    );

    const lastName = `n${(columns.length - 1).toString().padStart(5, "0")}`;
    const duplicateText = sourceText.replace(`${lastName} null)`, "n00000 null)");
    const duplicateInput = acceptText(duplicateText);
    const duplicate = expectAmbiguous(recognizeCreateTableCoreShape(duplicateInput));
    assert.equal(spanText(duplicateInput, duplicate.span), "constraint");
    assert.equal(duplicate.span.start.rawByteOffset, duplicateText.lastIndexOf("constraint"));
  });
  it("associates a near-limit table-key list in linear declaration and reference passes", () => {
    const fixedByteLength = encoder.encode("create table t (, unique ())").byteLength;
    const bytesPerFixedWidthMember = encoder.encode("c00000 int,c00000,").byteLength;
    const memberCount = Math.floor(
      (MAX_RAW_INPUT_BYTES - fixedByteLength) / bytesPerFixedWidthMember,
    );
    const names = Array.from(
      { length: memberCount },
      (_, ordinal) => `c${ordinal.toString().padStart(5, "0")}`,
    );
    const sourceText = `create table t (${names.map((name) => `${name} int`).join(",")}, unique (${names.join(",")}))`;
    const input = acceptText(sourceText);
    assert.equal(input.rawBytes.byteLength <= MAX_RAW_INPUT_BYTES, true);
    assert.equal(MAX_RAW_INPUT_BYTES - input.rawBytes.byteLength < bytesPerFixedWidthMember, true);

    const first = recognizeCreateTableCoreShape(input);
    assert.deepEqual(recognizeCreateTableCoreShape(input), first);
    const { coreShape } = expectRecognized(first);
    assert.equal(coreShape.derived.columns.length, memberCount);
    assert.equal(coreShape.derived.tableKeyConstraints[0]?.columnReferences.length, memberCount);
  });
  it("processes near-limit ordered nullability occurrences deterministically", () => {
    const prefix = "create table t (c int";
    const suffix = ")";
    const clauseCount = Math.floor(
      (MAX_RAW_INPUT_BYTES - encoder.encode(prefix + suffix).byteLength) / " NULL".length,
    );
    const sourceText = `${prefix}${" NULL".repeat(clauseCount)}${suffix}`;
    const input = acceptText(sourceText);
    assert.equal(input.rawBytes.byteLength > MAX_RAW_INPUT_BYTES - " NULL".length, true);

    const first = recognizeCreateTableCoreShape(input);
    assert.deepEqual(recognizeCreateTableCoreShape(input), first);
    const refusal = expectConflict(first);
    assert.deepEqual(refusal.clauseLabels, ["NULL", "NULL"]);
    assert.equal(refusal.span.start.rawByteOffset, sourceText.indexOf("NULL") + "NULL ".length);
  });
  it("traverses deeply nested DEFAULT parentheses iteratively", () => {
    const depth = 10_000;
    const expression = `${"([".repeat(depth)}x${"])".repeat(depth)}`;
    const sourceText = `create table t (c int DEFAULT ${expression})`;
    assert.equal(encoder.encode(sourceText).byteLength < MAX_RAW_INPUT_BYTES, true);

    const first = recognizeText(sourceText);
    assert.deepEqual(recognizeText(sourceText), first);
    const input = acceptText(sourceText);
    const column = expectRecognized(first).coreShape.derived.columns[0] ?? assert.fail();
    assert.equal(
      spanText(input, columnExpressionSpan(column, "default") ?? assert.fail()),
      expression,
    );
  });
  it("traverses near-cap mixed delimiter nesting iteratively", () => {
    const prefix = "create table t (c int CHECK (";
    const suffix = "))";
    const fixedLength = prefix.length + 1 + suffix.length;
    const depth = Math.floor((MAX_RAW_INPUT_BYTES - fixedLength) / 4);
    const sourceText = `${prefix}${"([".repeat(depth)}x${"])".repeat(depth)}${suffix}`;

    assert.equal(MAX_RAW_INPUT_BYTES - encoder.encode(sourceText).byteLength < 4, true);
    const first = recognizeText(sourceText);
    const second = recognizeText(sourceText);
    assert.deepEqual(second, first);
    const shape = expectRecognized(first).coreShape;
    assert.equal(
      columnExpressionSpan(shape.derived.columns[0], "check")?.start.rawByteOffset,
      prefix.length - 1,
    );
    assert.equal(shape.span.end.rawByteOffset, sourceText.length);
  });
  it("processes deep and many near-cap table CHECKs deterministically", () => {
    const deepPrefix = "create table t (CHECK (";
    const deepSuffix = "))";
    const deepFixedLength = deepPrefix.length + 1 + deepSuffix.length;
    const depth = Math.floor((MAX_RAW_INPUT_BYTES - deepFixedLength) / 4);
    const deepText = `${deepPrefix}${"([".repeat(depth)}x${"])".repeat(depth)}${deepSuffix}`;

    assert.equal(MAX_RAW_INPUT_BYTES - encoder.encode(deepText).byteLength < 4, true);
    const firstDeep = recognizeText(deepText);
    assert.deepEqual(recognizeText(deepText), firstDeep);
    const deepShape = expectRecognized(firstDeep).coreShape;
    assert.equal(deepShape.derived.tableCheckConstraints.length, 1);
    assert.equal(
      deepShape.derived.tableCheckConstraints[0]?.expressionSpan.start.rawByteOffset,
      deepPrefix.length - 1,
    );
    assert.equal(deepShape.span.end.rawByteOffset, deepText.length);

    const manyPrefix = "create table t (";
    const clause = "CHECK (true)";
    const manySuffix = ")";
    const clauseWidth = clause.length + 1;
    const checkCount = Math.floor(
      (MAX_RAW_INPUT_BYTES - manyPrefix.length - manySuffix.length + 1) / clauseWidth,
    );
    const manyText = `${manyPrefix}${Array.from({ length: checkCount }, () => clause).join(",")}${manySuffix}`;

    assert.equal(MAX_RAW_INPUT_BYTES - encoder.encode(manyText).byteLength < clauseWidth, true);
    const firstMany = recognizeText(manyText);
    assert.deepEqual(recognizeText(manyText), firstMany);
    const manyShape = expectRecognized(firstMany).coreShape;
    assert.equal(manyShape.derived.tableCheckConstraints.length, checkCount);
    assert.equal(manyShape.derived.columns.length, 0);
    assert.equal(manyShape.derived.explicitConstraintNames.length, 0);
    assert.equal(
      manyShape.derived.tableCheckConstraints.at(-1)?.keywordSpan.start.rawByteOffset,
      manyPrefix.length + (checkCount - 1) * clauseWidth,
    );
  });
  it("makes deterministic iterative progress on near-limit columns and array suffixes", () => {
    const columnCount = 20_000;
    const columns = Array.from(
      { length: columnCount },
      (_, index) => `c${index.toString().padStart(5, "0")} int`,
    );
    const manyColumnsText = `create table t (${columns.join(",")})`;
    assert.equal(encoder.encode(manyColumnsText).byteLength < MAX_RAW_INPUT_BYTES, true);

    const first = recognizeText(manyColumnsText);
    const second = recognizeText(manyColumnsText);
    assert.deepEqual(first, second);
    const manyColumnsShape = expectRecognized(first).coreShape;
    assert.equal(manyColumnsShape.derived.columns.length, columnCount);
    assert.equal(manyColumnsShape.derived.columns[0]?.name.identity, "c00000");
    assert.equal(manyColumnsShape.derived.columns[columnCount - 1]?.name.identity, "c19999");

    const duplicateColumnsText = manyColumnsText.replace("c19999 int)", "c00000 int)");
    const duplicateInput = acceptText(duplicateColumnsText);
    const duplicateFirst = recognizeCreateTableCoreShape(duplicateInput);
    assert.deepEqual(recognizeCreateTableCoreShape(duplicateInput), duplicateFirst);
    const duplicateRefusal = expectAmbiguous(duplicateFirst);
    assert.equal(spanText(duplicateInput, duplicateRefusal.span), "c00000");
    assert.equal(
      duplicateRefusal.span.start.rawByteOffset,
      duplicateColumnsText.lastIndexOf("c00000"),
    );

    const arrayPrefix = "create table t (c int";
    const arrayCount = (MAX_RAW_INPUT_BYTES - arrayPrefix.length - 1) / 2;
    assert.equal(Number.isInteger(arrayCount), true);
    const maximumArrayText = `${arrayPrefix}${"[]".repeat(arrayCount)})`;
    assert.equal(maximumArrayText.length, MAX_RAW_INPUT_BYTES);
    const maximumArrayShape = expectRecognized(recognizeText(maximumArrayText)).coreShape;
    assert.equal(maximumArrayShape.derived.columns[0]?.type.arrayDimensions, arrayCount);
    assert.equal(maximumArrayShape.span.end.rawByteOffset, MAX_RAW_INPUT_BYTES);

    const malformedArrayText = `${arrayPrefix}${"[]".repeat(arrayCount)}[`;
    assert.equal(malformedArrayText.length, MAX_RAW_INPUT_BYTES);
    const malformedInput = acceptText(malformedArrayText);
    assert.equal(
      spanText(malformedInput, expectUnbalanced(recognizeCreateTableCoreShape(malformedInput))),
      "[",
    );
  });
});
