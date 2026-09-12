import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrationInputProfile,
  MAX_MIGRATION_DOCUMENT_BYTES,
} from "../src/migration-input.js";
import {
  createMigrationDocumentIndex,
  MAX_MIGRATION_STATEMENTS,
  MAX_MIGRATION_TARGETS,
  MAX_MIGRATION_TOKENS,
} from "../src/migration-document.js";
import { evaluateMigrationTarget } from "../src/migration-evaluator.js";
import { MAX_TARGET_ASSOCIATED_STATEMENTS } from "../src/migration-association.js";
import { renderMigrationTargetReport } from "../src/migration-report.js";

const encoder = new TextEncoder();

function index(sql: string) {
  const admitted = applyMigrationInputProfile(encoder.encode(sql));
  assert.equal(admitted.kind, "accepted", JSON.stringify(admitted));
  if (admitted.kind !== "accepted") throw new Error("fixture admission");
  return createMigrationDocumentIndex(admitted.input);
}

test("v0.2 hostile lexical truncation fails closed", () => {
  const cases = [
    [
      "unterminated dollar quote",
      "CREATE FUNCTION f() RETURNS void AS $body$ SELECT 1;",
      "unterminated_dollar_quote",
    ],
    [
      "unterminated quoted identifier",
      'CREATE TABLE public."broken (id uuid);',
      "unterminated_quoted_identifier",
    ],
    [
      "unterminated string",
      "CREATE TABLE public.t (id uuid DEFAULT 'broken);",
      "unterminated_string",
    ],
    ["unterminated nested comment", "/* outer /* inner */", "unterminated_block_comment"],
  ] as const;
  for (const [name, sql, refusalId] of cases) {
    const result = index(sql);
    assert.equal(result.kind, "refused", name);
    if (result.kind === "refused") assert.equal(result.refusal.refusalId, refusalId, name);
  }
});

test("documents selecting non-standard string semantics refuse before discovery", () => {
  const unsafe = index(`
    SET standard_conforming_strings = off;
    SELECT 'abc\\'; CREATE TABLE public.fake (id uuid PRIMARY KEY); --';
  `);
  assert.equal(unsafe.kind, "refused");
  if (unsafe.kind === "refused")
    assert.equal(unsafe.refusal.refusalId, "document_string_semantics_not_in_profile");

  const auditedSafeForm = index(`
    SET standard_conforming_strings = on;
    CREATE TABLE public.real (id uuid PRIMARY KEY);
  `);
  assert.equal(auditedSafeForm.kind, "indexed");
  if (auditedSafeForm.kind === "indexed")
    assert.equal(auditedSafeForm.index.targets[0]?.identity.local.identity, "real");

  const malformed = index(`
    SET standard_conforming_strings on;
    CREATE TABLE public.not_scanned (id uuid PRIMARY KEY);
  `);
  assert.equal(malformed.kind, "refused");
  if (malformed.kind === "refused")
    assert.equal(malformed.refusal.refusalId, "document_string_semantics_not_in_profile");

  for (const parameter of ['"standard_conforming_strings"', '"STANDARD_CONFORMING_STRINGS"']) {
    const quotedUnsafe = index(`
      SET ${parameter} = off;
      SELECT 'abc\\'; CREATE TABLE public.fake (id uuid PRIMARY KEY); --';
    `);
    assert.equal(quotedUnsafe.kind, "refused", parameter);
    if (quotedUnsafe.kind === "refused") {
      assert.equal(
        quotedUnsafe.refusal.refusalId,
        "document_string_semantics_not_in_profile",
        parameter,
      );
    }
  }

  const quotedSafe = index(`
    SET "standard_conforming_strings" TO on;
    CREATE TABLE public.quoted_safe (id uuid PRIMARY KEY);
  `);
  assert.equal(quotedSafe.kind, "indexed");
  if (quotedSafe.kind === "indexed") {
    assert.equal(quotedSafe.index.targets[0]?.identity.local.identity, "quoted_safe");
  }
});

test("overlength unquoted target identities refuse instead of splitting PostgreSQL identity", () => {
  const prefix = "a".repeat(63);
  for (const sql of [
    `CREATE TABLE public.${prefix}x (id uuid PRIMARY KEY);`,
    `CREATE TABLE ${prefix}x.t (id uuid PRIMARY KEY);`,
    `ALTER TABLE public.${prefix}x ADD CONSTRAINT c CHECK (id IS NOT NULL);`,
    `CREATE TABLE public.${prefix}x (id uuid PRIMARY KEY); ALTER TABLE public.${prefix}y ADD CONSTRAINT c CHECK (id IS NOT NULL);`,
  ]) {
    const result = index(sql);
    assert.equal(result.kind, "refused", sql);
    if (result.kind === "refused") {
      assert.equal(result.refusal.refusalId, "identifier_outside_profile", sql);
      if (result.refusal.refusalId === "identifier_outside_profile") {
        assert.equal(result.refusal.actualUtf8ByteLength, 64, sql);
      }
    }
  }

  const unrelatedLongWord = index(`
    SELECT ${"x".repeat(64)};
    CREATE TABLE public.real_target (id uuid PRIMARY KEY);
  `);
  assert.equal(unrelatedLongWord.kind, "indexed");
  if (unrelatedLongWord.kind === "indexed") {
    assert.equal(unrelatedLongWord.index.targets[0]?.identity.local.identity, "real_target");
  }
});

test("recognized target identities refuse leading unquoted non-ASCII without losing evidence", () => {
  for (const sql of [
    "CREATE TABLE öffentliche (id uuid PRIMARY KEY);",
    "CREATE TABLE public.öffentliche (id uuid PRIMARY KEY);",
    "CREATE TYPE public.öffentliche AS ENUM ('open');",
    'CREATE TABLE public."öffentliche" (id uuid PRIMARY KEY); ALTER TABLE öffentliche ADD CONSTRAINT c CHECK (id IS NOT NULL);',
    'CREATE TABLE public."öffentliche" (id uuid PRIMARY KEY); ALTER TABLE public.öffentliche ADD CONSTRAINT c CHECK (id IS NOT NULL);',
    'CREATE TABLE public."öffentliche" (id uuid PRIMARY KEY); CREATE INDEX ix ON public.öffentliche (id);',
    'CREATE TABLE public."öffentliche" (id uuid PRIMARY KEY); CREATE POLICY p ON public.öffentliche USING (true);',
    'CREATE TABLE public."öffentliche" (id uuid PRIMARY KEY); CREATE TRIGGER tr BEFORE INSERT ON public.öffentliche EXECUTE FUNCTION public.f();',
  ]) {
    const result = index(sql);
    assert.equal(result.kind, "refused", sql);
    if (result.kind === "refused") {
      assert.equal(result.refusal.refusalId, "unquoted_non_ascii_identifier", sql);
    }
  }

  const unrelated = index(`
    SELECT öffentliche;
    CREATE TABLE public.real_target (id uuid PRIMARY KEY);
  `);
  assert.equal(unrelated.kind, "indexed");
  if (unrelated.kind === "indexed") {
    assert.equal(unrelated.index.targets[0]?.identity.local.identity, "real_target");
  }
});

test("large protected regions stay bounded and do not create false statements", () => {
  const payload = "x".repeat(900_000);
  for (const sql of [
    `/* ${payload}; CREATE TABLE public.fake (id uuid); */ CREATE TABLE public.real_comment (id uuid PRIMARY KEY);`,
    `SELECT '${payload}; CREATE TABLE public.fake (id uuid);'; CREATE TABLE public.real_string (id uuid PRIMARY KEY);`,
    `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $body$ SELECT '${payload};'; $body$; CREATE TABLE public.real_dollar (id uuid PRIMARY KEY);`,
  ]) {
    const result = index(sql);
    assert.equal(result.kind, "indexed");
    if (result.kind !== "indexed") continue;
    assert.equal(result.index.targets.length, 1);
    assert.match(result.index.targets[0]?.identity.local.identity ?? "", /^real_/);
  }
});

test("statement and target cardinality caps refuse excessive documents", () => {
  const statements = `${";".repeat(MAX_MIGRATION_STATEMENTS + 1)}`;
  const statementResult = index(statements);
  assert.equal(statementResult.kind, "refused");
  if (statementResult.kind === "refused") {
    assert.equal(statementResult.refusal.refusalId, "document_too_many_statements");
  }

  const targets = Array.from(
    { length: MAX_MIGRATION_TARGETS + 1 },
    (_, i) => `ALTER TABLE public.t_${i} ADD CONSTRAINT c_${i} CHECK (id IS NOT NULL);`,
  ).join("\n");
  const targetResult = index(targets);
  assert.equal(targetResult.kind, "refused");
  if (targetResult.kind === "refused") {
    assert.equal(targetResult.refusal.refusalId, "document_too_many_targets");
  }
});

test("the token cap has an exact hostile-input boundary", () => {
  const dense = (count: number) => `SELECT ${"x ".repeat(count - 2)};`;
  const exact = index(dense(MAX_MIGRATION_TOKENS));
  assert.equal(exact.kind, "indexed");
  const over = index(dense(MAX_MIGRATION_TOKENS + 1));
  assert.equal(over.kind, "refused");
  if (over.kind === "refused") assert.equal(over.refusal.refusalId, "document_too_many_tokens");
});

test("many associations remain deterministic without cross-target leakage", () => {
  const alters = Array.from(
    { length: 4_000 },
    (_, i) => `ALTER TABLE public.busy ADD CONSTRAINT busy_${i} CHECK (id IS NOT NULL);`,
  ).join("\n");
  const sql = `CREATE TABLE public.busy (id uuid PRIMARY KEY);\n${alters}\nCREATE TABLE private.busy (id uuid PRIMARY KEY);`;
  const result = index(sql);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  assert.equal(result.index.targets.length, 2);
  const target = result.index.targets.find((candidate) => candidate.scope === "public");
  assert.ok(target);
  const evaluated = evaluateMigrationTarget(result.index, target.key);
  assert.ok(evaluated);
  assert.equal(evaluated.target.identity.qualifier?.identity, "public");
  assert.equal(evaluated.includedStatements.length, MAX_TARGET_ASSOCIATED_STATEMENTS + 1);
  assert.ok(evaluated.notEvaluated.some((item) => item.kind === "association_limit_exceeded"));
  assert.equal(evaluated.result, "more_evidence_required");
});

test("the association overflow marker alone prevents a clean result", () => {
  const indexes = Array.from(
    { length: MAX_TARGET_ASSOCIATED_STATEMENTS },
    (_, i) => `CREATE INDEX ignored_${i} ON public.capped (value);`,
  ).join("\n");
  const result = index(`
    CREATE TABLE public.capped (id uuid PRIMARY KEY, value uuid NOT NULL);
    ${indexes}
    ALTER TABLE public.capped ADD CONSTRAINT capped_pk PRIMARY KEY (id, value);
  `);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  const target = result.index.targets[0];
  assert.ok(target);
  const evaluated = evaluateMigrationTarget(result.index, target.key);
  assert.ok(evaluated);
  assert.equal(evaluated.result, "more_evidence_required");
  assert.ok(evaluated.notEvaluated.some((item) => item.kind === "association_limit_exceeded"));
  assert.ok(!evaluated.policy?.reasonIds.includes("composite_primary_key"));
  assert.match(renderMigrationTargetReport(evaluated), /association_limit_exceeded/);
});

test("DROP TABLE is exact target-local NOT_EVALUATED evidence", () => {
  const result = index(`
    CREATE TABLE public.t (id uuid PRIMARY KEY);
    DROP TABLE IF EXISTS public.t CASCADE;
  `);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  const target = result.index.targets[0];
  assert.ok(target);
  const evaluated = evaluateMigrationTarget(result.index, target.key);
  assert.ok(evaluated);
  assert.equal(evaluated.result, "more_evidence_required");
  assert.ok(evaluated.notEvaluated.some((item) => item.kind === "drop_table"));
});

test("schema-unresolved cross-statement evidence is not projected", () => {
  const result = index(`
    SET search_path = a;
    CREATE TABLE t (id uuid NOT NULL, value uuid NOT NULL);
    SET search_path = b;
    ALTER TABLE t ADD CONSTRAINT t_pk PRIMARY KEY (id, value);
  `);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  const target = result.index.targets[0];
  assert.ok(target);
  const evaluated = evaluateMigrationTarget(result.index, target.key);
  assert.ok(evaluated);
  assert.equal(evaluated.result, "more_evidence_required");
  assert.ok(evaluated.notEvaluated.some((item) => item.kind === "unresolved_schema_association"));
  assert.ok(!evaluated.policy?.reasonIds.includes("composite_primary_key"));
});

test("malformed trigger UPDATE OF lists remain conservative", () => {
  const result = index(`
    CREATE TABLE public.t (id uuid PRIMARY KEY, value text);
    CREATE TRIGGER tr BEFORE UPDATE OF id value ON public.t
      FOR EACH ROW EXECUTE FUNCTION public.f();
  `);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  const target = result.index.targets[0];
  assert.ok(target);
  const evaluated = evaluateMigrationTarget(result.index, target.key);
  assert.ok(evaluated);
  assert.equal(evaluated.result, "more_evidence_required");
  assert.ok(
    evaluated.notEvaluated.some((item) => item.kind === "relevant_statement_not_recognized"),
  );
});

test("multi-action ALTER statements are wholly NOT_EVALUATED", () => {
  const result = index(`
    CREATE TABLE public.t (id bigint PRIMARY KEY, value text);
    ALTER TABLE public.t ALTER COLUMN id SET DEFAULT 1, DROP COLUMN value;
  `);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  const target = result.index.targets[0];
  assert.ok(target);
  const evaluated = evaluateMigrationTarget(result.index, target.key);
  assert.ok(evaluated);
  assert.equal(evaluated.result, "more_evidence_required");
  assert.equal(evaluated.generatedColumns.length, 0);
  assert.ok(evaluated.notEvaluated.some((item) => item.kind === "unsupported_target_alter"));
});

test("duplicate declarations and schema lookalikes do not collapse incorrectly", () => {
  const result = index(`
    CREATE TABLE public.dup (id uuid PRIMARY KEY);
    CREATE TABLE public.dup (id uuid PRIMARY KEY);
    CREATE TABLE public.same_name (id uuid PRIMARY KEY);
    CREATE TABLE private.same_name (id uuid PRIMARY KEY);
    CREATE TABLE public.foo (id uuid PRIMARY KEY);
    CREATE TABLE public."Foo" (id uuid PRIMARY KEY);
  `);
  assert.equal(result.kind, "indexed");
  if (result.kind !== "indexed") return;
  assert.equal(result.index.targets.length, 5);

  const duplicate = result.index.targets.find(
    (candidate) => candidate.identity.local.identity === "dup",
  );
  assert.ok(duplicate);
  assert.equal(duplicate.declarationStatementOrdinals.length, 2);
  const duplicateEvaluation = evaluateMigrationTarget(result.index, duplicate.key);
  assert.ok(duplicateEvaluation);
  assert.ok(
    duplicateEvaluation.notEvaluated.some((item) => item.kind === "multiple_base_declarations"),
  );

  const sameName = result.index.targets.filter(
    (candidate) => candidate.identity.local.identity === "same_name",
  );
  assert.equal(sameName.length, 2);
  assert.notEqual(sameName[0]?.key, sameName[1]?.key);

  const foo = result.index.targets.filter(
    (candidate) => candidate.identity.local.identity.toLowerCase() === "foo",
  );
  assert.equal(foo.length, 2);
  assert.notEqual(foo[0]?.key, foo[1]?.key);
});

test("unsafe control identifiers refuse before reportable target discovery", () => {
  for (const scalar of ["\u202e", "\u2066", "\u200b", "\u001b"]) {
    const result = index(`CREATE TABLE public."x${scalar}y" (id uuid PRIMARY KEY);`);
    assert.equal(result.kind, "refused");
    if (result.kind === "refused")
      assert.equal(result.refusal.refusalId, "identifier_contains_unsafe_character");
  }
});

test("malformed target syntax never becomes a fabricated compatible shape", () => {
  for (const sql of [
    "CREATE TABLE public.t (",
    "CREATE TABLE public.t id uuid PRIMARY KEY);",
    "CREATE TABLE public.t (id uuid PRIMARY KEY); ALTER TABLE public.t ADD",
    "CREATE TABLE a.b.c (id uuid PRIMARY KEY);",
  ]) {
    const result = index(sql);
    if (result.kind === "refused") continue;
    for (const target of result.index.targets) {
      const evaluated = evaluateMigrationTarget(result.index, target.key);
      assert.ok(evaluated);
      assert.notEqual(evaluated.result, "no_structural_conflict_observed", sql);
    }
  }
});

test("document byte cap is exact and allocation remains bounded", () => {
  const exact = new Uint8Array(MAX_MIGRATION_DOCUMENT_BYTES);
  exact.fill(0x20);
  assert.equal(applyMigrationInputProfile(exact).kind, "accepted");
  assert.deepEqual(applyMigrationInputProfile(new Uint8Array(MAX_MIGRATION_DOCUMENT_BYTES + 1)), {
    kind: "refused",
    refusal: { refusalId: "document_input_too_large" },
  });
});
