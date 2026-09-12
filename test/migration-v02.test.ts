import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MIGRATION_DOCUMENT_BYTES,
  applyMigrationInputProfile,
} from "../src/migration-input.js";
import { createMigrationDocumentIndex } from "../src/migration-document.js";
import { evaluateMigrationTarget } from "../src/migration-evaluator.js";
import { renderMigrationTargetReport } from "../src/migration-report.js";

const encoder = new TextEncoder();

function index(sql: string) {
  const result = indexResult(sql);
  assert.equal(result.kind, "indexed", JSON.stringify(result));
  if (result.kind !== "indexed") throw new Error("fixture index");
  return result.index;
}

function indexResult(sql: string) {
  const admitted = applyMigrationInputProfile(encoder.encode(sql));
  assert.equal(admitted.kind, "accepted", JSON.stringify(admitted));
  if (admitted.kind !== "accepted") throw new Error("fixture admission");
  return createMigrationDocumentIndex(admitted.input);
}

function evaluate(sql: string, targetName = "t", schema: string | null = "public") {
  const document = index(sql);
  const target = document.targets.find(
    (candidate) =>
      candidate.identity.local.identity === targetName &&
      (candidate.identity.qualifier?.identity ?? null) === schema,
  );
  assert.ok(target, `target ${schema}.${targetName}`);
  const result = evaluateMigrationTarget(document, target.key);
  assert.ok(result);
  return result;
}

test("v0.2 document admission is separately bounded and strict", () => {
  assert.equal(MAX_MIGRATION_DOCUMENT_BYTES, 2_097_152);
  assert.equal(
    applyMigrationInputProfile(new Uint8Array(MAX_MIGRATION_DOCUMENT_BYTES + 1)).kind,
    "refused",
  );
  assert.deepEqual(applyMigrationInputProfile(Uint8Array.of(0x80)), {
    kind: "refused",
    refusal: { refusalId: "invalid_utf8" },
  });
  assert.equal(
    applyMigrationInputProfile(encoder.encode("CREATE TABLE t (x int);\0")).kind,
    "refused",
  );
});

test("document segmentation protects strings, comments, quoted identifiers and dollar bodies", () => {
  const document = index(`
    /* outer ; /* nested ; */ still comment */
    CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN RAISE NOTICE 'semi;colon'; RETURN NEW; END
    $body$;
    CREATE TABLE public."a;b" (id uuid PRIMARY KEY, note text DEFAULT 'x;y');
    CREATE TABLE public.t (id uuid PRIMARY KEY);
  `);
  assert.equal(document.targets.length, 2);
  assert.deepEqual(
    document.targets.map((target) => target.identity.local.identity),
    ["a;b", "t"],
  );
});

test("table identity preserves schema and quoting without search_path inference", () => {
  const document = index(`
    CREATE TABLE public.t (id uuid PRIMARY KEY);
    CREATE TABLE private.t (id uuid PRIMARY KEY);
    CREATE TABLE loose (id uuid PRIMARY KEY);
    ALTER TABLE private.t ADD UNIQUE (id);
  `);
  assert.equal(document.targets.length, 3);
  assert.deepEqual(
    document.targets.map((target) => target.scope),
    ["public", "outside_public_profile", "schema_unresolved"],
  );
  const publicTarget = evaluateMigrationTarget(document, document.targets[0]?.key ?? "");
  assert.ok(publicTarget);
  assert.equal(publicTarget.observed?.associatedAlterConstraintCount, 0);
});

test("audited multiword type spellings have exact v0.2 semantics", () => {
  const supported = evaluate(`
    CREATE TABLE public.t (
      id uuid PRIMARY KEY,
      a timestamp WITH TIME ZONE,
      b timestamp without time zone,
      c character varying(20),
      d text DEFAULT ''::character varying
    );
  `);
  assert.notEqual(supported.result, "refused");
  assert.equal(
    supported.recognitionObservations.filter((item) => item.kind === "type_spelling").length,
    4,
  );

  const rejected = evaluate("CREATE TABLE public.t (id uuid PRIMARY KEY, x double precision);");
  assert.equal(rejected.result, "outside_envelope_observed");
  assert.ok(rejected.policy?.reasonIds.includes("column_type_outside_profile"));

  const lookalike = evaluate('CREATE TABLE public.t (id uuid PRIMARY KEY, x "double" precision);');
  assert.equal(lookalike.result, "refused");
});

test("only audited foreign-key actions pass through bounded recognition", () => {
  for (const action of [
    "ON DELETE CASCADE",
    "ON DELETE SET NULL",
    "ON DELETE RESTRICT",
    "ON UPDATE CASCADE",
  ]) {
    const result = evaluate(
      `CREATE TABLE public.t (id uuid PRIMARY KEY, parent_id uuid REFERENCES public.parent(id) ${action});`,
    );
    assert.notEqual(result.result, "refused", action);
    assert.ok(result.policy?.reasonIds.includes("foreign_key_mapping_review_required"), action);
  }
  assert.equal(
    evaluate(
      "CREATE TABLE public.t (id uuid PRIMARY KEY, parent_id uuid REFERENCES public.parent(id) ON DELETE NO ACTION);",
    ).result,
    "refused",
  );
});

test("later ALTER constraints are associated and can reveal a composite-PK conflict", () => {
  const result = evaluate(`
    CREATE TABLE public.t (a uuid NOT NULL, b uuid NOT NULL, value text);
    ALTER TABLE public.t ADD CONSTRAINT "t_pk" PRIMARY KEY (a, b);
  `);
  assert.equal(result.result, "outside_envelope_observed");
  assert.ok(result.policy?.reasonIds.includes("composite_primary_key"));
  assert.deepEqual(
    result.observed?.primaryKeyColumns.map((column) => column.identity),
    ["a", "b"],
  );
  const report = renderMigrationTargetReport(result);
  assert.ok(report.includes("composite_primary_key"));
  assert.ok(report.includes('source: ALTER TABLE constraint "t_pk" at line 3, column 5'));
});

test("referenced enum declaration is associated without inventing schema resolution", () => {
  const result = evaluate(`
    CREATE TYPE public.status AS ENUM ('new', 'done');
    CREATE TABLE public.t (id uuid PRIMARY KEY, status public.status NOT NULL);
  `);
  assert.notEqual(result.result, "refused");
  assert.equal(result.observed?.enumBackedColumnCount, 1);

  const unresolved = evaluate(`
    CREATE TYPE public.status AS ENUM ('new');
    CREATE TABLE public.t (id uuid PRIMARY KEY, status status NOT NULL);
  `);
  assert.equal(unresolved.observed?.enumBackedColumnCount, 0);
});

test("shape-changing lifecycle mutations are explicit NOT_EVALUATED", () => {
  for (const mutation of [
    "ADD COLUMN later text",
    "DROP COLUMN value",
    "DROP CONSTRAINT t_pkey",
    "RENAME COLUMN value TO renamed",
    "ALTER COLUMN value TYPE varchar",
  ]) {
    const result = evaluate(`
      CREATE TABLE public.t (id uuid PRIMARY KEY, value text);
      ALTER TABLE public.t ${mutation};
    `);
    assert.notEqual(result.result, "no_structural_conflict_observed", mutation);
    assert.ok(result.notEvaluated.length > 0, mutation);
  }

  const partial = evaluate(`
    CREATE TABLE public.t (id uuid PRIMARY KEY, value text);
    ALTER TABLE public.t ADD COLUMN later text;
  `);
  const report = renderMigrationTargetReport(partial);
  assert.ok(
    report.includes(
      "partial evaluated evidence: NOT EVALUATED statements may change the final target shape or state",
    ),
  );
  assert.ok(
    report.includes(
      "provisional from evaluated declarations; NOT EVALUATED statements may change final file authority",
    ),
  );
  assert.ok(report.includes("No evaluated conflict takes precedence"));
  assert.ok(!report.includes("columns: 2"));
});

test("audited DROP POLICY and DROP TRIGGER forms associate exactly as NOT_EVALUATED", () => {
  const document = index(`
    CREATE TABLE public.t (id uuid PRIMARY KEY);
    CREATE TABLE private.t (id uuid PRIMARY KEY);
    CREATE POLICY "reader policy" ON public.t USING (true);
    DROP POLICY IF EXISTS "reader policy" ON public.t;
    CREATE TRIGGER refresh_row BEFORE UPDATE ON public.t
      FOR EACH ROW EXECUTE FUNCTION public.refresh_row();
    drop trigger if exists refresh_row on "public"."t" restrict;
    DROP POLICY private_policy ON private.t CASCADE;
  `);
  const publicTarget = document.targets.find(
    (target) =>
      target.identity.qualifier?.identity === "public" && target.identity.local.identity === "t",
  );
  assert.ok(publicTarget);
  const result = evaluateMigrationTarget(document, publicTarget.key);
  assert.ok(result);
  assert.equal(result.result, "more_evidence_required");
  assert.deepEqual(
    result.notEvaluated.map((item) => item.kind),
    ["drop_policy", "drop_trigger"],
  );
  assert.ok(result.notEvaluated.every((item) => item.statementKind.startsWith("DROP ")));
});

test("DROP lifecycle identity does not collapse schemas or quoted lookalikes", () => {
  const document = index(`
    CREATE TABLE public.t (id uuid PRIMARY KEY);
    CREATE TABLE public."T" (id uuid PRIMARY KEY);
    CREATE TABLE private.t (id uuid PRIMARY KEY);
    DROP POLICY p ON private.t;
    DROP TRIGGER tr ON public."T";
  `);
  const target = document.targets.find(
    (candidate) =>
      candidate.identity.qualifier?.identity === "public" &&
      candidate.identity.local.identity === "t",
  );
  assert.ok(target);
  const result = evaluateMigrationTarget(document, target.key);
  assert.ok(result);
  assert.equal(result.notEvaluated.length, 0);
});

test("malformed or truncated target lifecycle DROP forms refuse the document", () => {
  for (const sql of [
    "CREATE TABLE public.t (id uuid PRIMARY KEY); DROP POLICY p public.t;",
    "CREATE TABLE public.t (id uuid PRIMARY KEY); DROP TRIGGER tr ON public.t EXTRA;",
    "CREATE TABLE public.t (id uuid PRIMARY KEY); DROP POLICY p ON public.",
  ]) {
    const result = indexResult(sql);
    assert.equal(result.kind, "refused", sql);
    if (result.kind === "refused")
      assert.equal(result.refusal.refusalId, "document_target_lifecycle_not_bounded", sql);
  }
});

test("unrelated DROP forms remain surrounding SQL", () => {
  const result = evaluate(`
    CREATE TABLE public.t (id uuid PRIMARY KEY);
    DROP VIEW IF EXISTS public.old_view;
    DROP FUNCTION IF EXISTS public.old_function();
  `);
  assert.equal(result.notEvaluated.length, 0);
});

test("ALTER-only target remains discoverable but cannot manufacture a base shape", () => {
  const result = evaluate(`
    ALTER TABLE public.t ADD CONSTRAINT "valid_check" CHECK (id IS NOT NULL);
  `);
  assert.equal(result.result, "more_evidence_required");
  assert.ok(result.notEvaluated.some((item) => item.kind === "missing_base_declaration"));
  assert.ok(
    result.notEvaluated.some(
      (item) =>
        item.kind === "associated_statement_without_base" &&
        item.constraintName?.identity === "valid_check" &&
        item.span.start.line === 2,
    ),
  );
  assert.equal(result.evidence, null);
  const report = renderMigrationTargetReport(result);
  assert.ok(report.includes("associated_statement_without_base"));
  assert.ok(report.includes('constraint "valid_check"'));
  assert.ok(report.includes('ALTER TABLE, constraint "valid_check", line 2, column 5'));
});

test("ALTER-only association preserves every exact target statement without lookalike leakage", () => {
  const document = index(`
    ALTER TABLE public."Example"
      ADD CONSTRAINT "first check" CHECK (first_value IS NOT NULL);
    ALTER TABLE public."Example"
      ADD CONSTRAINT second_check CHECK (second_value IS NOT NULL);
    ALTER TABLE private."Example"
      ADD CONSTRAINT private_check CHECK (private_value IS NOT NULL);
    ALTER TABLE public.example
      ADD CONSTRAINT lowercase_check CHECK (lowercase_value IS NOT NULL);
  `);
  const target = document.targets.find(
    (candidate) =>
      candidate.identity.qualifier?.identity === "public" &&
      candidate.identity.local.quoted &&
      candidate.identity.local.identity === "Example",
  );
  assert.ok(target);

  const result = evaluateMigrationTarget(document, target.key);
  assert.ok(result);
  assert.equal(result.result, "more_evidence_required");
  assert.equal(result.evidence, null);
  assert.deepEqual(
    result.notEvaluated
      .filter((item) => item.kind === "associated_statement_without_base")
      .map((item) => ({
        constraint: item.constraintName?.identity,
        quoted: item.constraintName?.quoted,
        line: item.span.start.line,
      })),
    [
      { constraint: "first check", quoted: true, line: 2 },
      { constraint: "second_check", quoted: false, line: 4 },
    ],
  );

  const report = renderMigrationTargetReport(result);
  assert.ok(report.includes('constraint "first check", line 2'));
  assert.ok(report.includes("constraint second_check, line 4"));
  assert.ok(!report.includes("private_check"));
  assert.ok(!report.includes("lowercase_check"));
});

test("later default and identity evidence removes ordinary file authority", () => {
  for (const alter of [
    "ALTER COLUMN id SET DEFAULT gen_random_uuid()",
    "ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY",
  ]) {
    const result = evaluate(`
      CREATE TABLE public.t (id bigint PRIMARY KEY, value text);
      ALTER TABLE public.t ${alter};
    `);
    assert.notEqual(result.result, "refused", alter);
    assert.equal(
      result.policy?.columns.find((column) => column.name.identity === "id")?.disposition,
      "excluded from file mapping by the ordinary generation/default rule",
    );
  }
});

test("audited physical storage clauses do not kill structural analysis", () => {
  const result = evaluate(`
    CREATE TABLE public.t (
      id uuid PRIMARY KEY,
      created_at timestamp with time zone DEFAULT now()
    ) WITH (autovacuum_vacuum_scale_factor='0.05') TABLESPACE pg_default;
  `);
  assert.notEqual(result.result, "refused");
  assert.equal(
    result.recognitionObservations.filter((item) => item.kind === "relation_storage").length,
    2,
  );
});

test("audited trigger forms preserve INSERT/WHEN evidence", () => {
  const result = evaluate(`
    CREATE TABLE public.t (id uuid PRIMARY KEY, owner_id uuid, updated_at timestamp with time zone);
    CREATE OR REPLACE TRIGGER guard BEFORE INSERT OR UPDATE OF owner_id, updated_at ON public.t
      FOR EACH ROW WHEN (NEW.owner_id IS NULL) EXECUTE FUNCTION public.guard_row();
  `);
  assert.equal(result.result, "outside_envelope_observed");
  assert.ok(result.policy?.reasonIds.includes("insert_trigger_shape_outside_profile"));
});

test("report preserves XSS-like identifiers as text and exposes NOT_EVALUATED provenance", () => {
  const result = evaluate(
    `
    CREATE TABLE public."x<script>" (id uuid PRIMARY KEY, value text);
    ALTER TABLE public."x<script>" ADD COLUMN later text;
  `,
    "x<script>",
  );
  const report = renderMigrationTargetReport(result);
  assert.ok(report.includes("NOT EVALUATED"));
  assert.ok(report.includes("add_column"));
  assert.ok(report.includes("<script>"));
});

test("bidi/control identifiers are refused before report rendering", () => {
  const admitted = applyMigrationInputProfile(
    encoder.encode('CREATE TABLE public."x\u202E" (id uuid PRIMARY KEY);'),
  );
  assert.equal(admitted.kind, "accepted");
  if (admitted.kind !== "accepted") throw new Error("fixture admission");
  const indexed = createMigrationDocumentIndex(admitted.input);
  assert.equal(indexed.kind, "refused");
  if (indexed.kind !== "refused") throw new Error("expected unsafe identifier refusal");
  assert.equal(indexed.refusal.refusalId, "identifier_contains_unsafe_character");
});
