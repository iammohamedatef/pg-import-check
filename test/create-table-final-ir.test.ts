import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  recognizeCreateTableCoreShape,
  type CreateTableElement,
} from "../src/create-table-core-shape.js";
import type { SourceSpan } from "../src/create-table-token-source.js";
import {
  acceptText,
  columnExpressionSpan,
  expectRecognized,
  spanText,
} from "./create-table-test-helpers.js";

function elementSpan(element: CreateTableElement): SourceSpan {
  return element.kind === "column" ? element.column.span : element.constraint.clauseSpan;
}

describe("final private CREATE TABLE structural IR", () => {
  it("keeps one canonical source-ordered body and derives selector views across representative syntax", () => {
    const sourceText = [
      'CREATE TABLE "app"."orders" (',
      "  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,",
      "  code text CONSTRAINT uq_code UNIQUE DEFAULT 'x' CHECK (code <> ''),",
      "  parent_id bigint CONSTRAINT fk_parent REFERENCES app.parent(id),",
      "  note text DEFAULT E'raw\\\\n',",
      "  CONSTRAINT table_uq UNIQUE (code, parent_id),",
      "  CONSTRAINT table_check CHECK (id > 0),",
      "  CONSTRAINT table_fk FOREIGN KEY (code) REFERENCES lookup.codes(code)",
      ") INHERITS (base_orders, archive.base_orders)",
      "PARTITION BY hash(id);",
    ].join("\n");
    const input = acceptText(sourceText);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;

    assert.deepEqual(
      shape.body.elements.map((element) => element.kind),
      ["column", "column", "column", "column", "table_key", "table_check", "table_foreign_key"],
    );
    assert.deepEqual(
      shape.body.elements.map((element) => spanText(input, elementSpan(element))),
      [
        "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        "code text CONSTRAINT uq_code UNIQUE DEFAULT 'x' CHECK (code <> '')",
        "parent_id bigint CONSTRAINT fk_parent REFERENCES app.parent(id)",
        "note text DEFAULT E'raw\\\\n'",
        "CONSTRAINT table_uq UNIQUE (code, parent_id)",
        "CONSTRAINT table_check CHECK (id > 0)",
        "CONSTRAINT table_fk FOREIGN KEY (code) REFERENCES lookup.codes(code)",
      ],
    );
    assert.equal(spanText(input, shape.body.openingParenthesisSpan), "(");
    assert.equal(spanText(input, shape.body.closingParenthesisSpan), ")");
    assert.equal(spanText(input, shape.body.span).startsWith("(\n  id bigint"), true);
    assert.equal(
      spanText(input, shape.body.span).endsWith(
        "CONSTRAINT table_fk FOREIGN KEY (code) REFERENCES lookup.codes(code)\n)",
      ),
      true,
    );

    assert.deepEqual(
      shape.derived.columns.map((column) => column.name.identity),
      ["id", "code", "parent_id", "note"],
    );
    assert.deepEqual(
      shape.derived.tableKeyConstraints.map((constraint) => constraint.kind),
      ["unique"],
    );
    assert.equal(shape.derived.tableCheckConstraints.length, 1);
    assert.equal(shape.derived.tableForeignKeyConstraints.length, 1);
    assert.deepEqual(
      shape.derived.explicitConstraintNames.map((occurrence) => [
        occurrence.name.identity,
        occurrence.scope,
        occurrence.sourceOrder,
      ]),
      [
        ["uq_code", "column", 0],
        ["fk_parent", "column", 1],
        ["table_uq", "table", 2],
        ["table_check", "table", 3],
        ["table_fk", "table", 4],
      ],
    );

    const id = shape.derived.columns[0] ?? assert.fail("missing id column");
    assert.deepEqual(
      id.clauseOccurrences.map((occurrence) => occurrence.kind),
      ["identity", "primary_key"],
    );
    const code = shape.derived.columns[1] ?? assert.fail("missing code column");
    assert.deepEqual(
      code.clauseOccurrences.map((occurrence) => occurrence.kind),
      ["unique", "default", "check"],
    );
    assert.equal(spanText(input, columnExpressionSpan(code, "default") ?? assert.fail()), "'x'");
    assert.equal(
      spanText(input, columnExpressionSpan(code, "check") ?? assert.fail()),
      "(code <> '')",
    );

    assert.equal(
      spanText(input, shape.inheritsClause?.span ?? assert.fail()),
      "INHERITS (base_orders, archive.base_orders)",
    );
    assert.deepEqual(
      shape.inheritsClause?.relations.map((relation) => [
        relation.qualifier?.identity ?? null,
        relation.local.identity,
      ]),
      [
        [null, "base_orders"],
        ["archive", "base_orders"],
      ],
    );

    const partition = shape.partitionByClause ?? assert.fail("missing PARTITION BY clause");
    assert.equal(spanText(input, partition.partitionKeywordSpan), "PARTITION");
    assert.equal(spanText(input, partition.byKeywordSpan), "BY");
    assert.equal(spanText(input, partition.expressionSpan), "hash(id)");
    assert.equal(spanText(input, partition.span), "PARTITION BY hash(id)");
    assert.equal(spanText(input, shape.span), sourceText.slice(0, -1));
  });

  it("retains CHECK and DEFAULT evidence only in canonical clause occurrences", () => {
    const sourceText = "create table t (c int DEFAULT 42 CHECK (c > 0))";
    const input = acceptText(sourceText);
    const shape = expectRecognized(recognizeCreateTableCoreShape(input)).coreShape;
    const column = shape.derived.columns[0] ?? assert.fail("missing column");

    assert.equal(Object.hasOwn(column, "checkExpressionSpan"), false);
    assert.equal(Object.hasOwn(column, "defaultExpressionSpan"), false);
    assert.deepEqual(
      column.clauseOccurrences.map((occurrence) => occurrence.kind),
      ["default", "check"],
    );
    assert.equal(spanText(input, columnExpressionSpan(column, "default") ?? assert.fail()), "42");
    assert.equal(
      spanText(input, columnExpressionSpan(column, "check") ?? assert.fail()),
      "(c > 0)",
    );
  });
});
