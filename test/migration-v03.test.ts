import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMigrationInputProfile,
  createMigrationDocumentIndex,
  evaluateMigrationTarget,
  renderMigrationTargetReport,
} from "../src/migration-api.js";
import {
  deriveMigrationDecision,
  renderMigrationDecisionReport,
} from "../src/migration-decision.js";
import { acceptanceCases } from "./migration-v03-cases.js";

function analyze(sql: string, name = "t") {
  const admitted = applyMigrationInputProfile(Buffer.from(sql));
  assert.equal(admitted.kind, "accepted");
  if (admitted.kind !== "accepted") throw new Error("Admission failed");
  const indexed = createMigrationDocumentIndex(admitted.input);
  assert.equal(indexed.kind, "indexed");
  if (indexed.kind !== "indexed") throw new Error("Indexing failed");
  const target = indexed.index.targets.find((t) => t.identity.local.identity === name);
  assert.ok(target);
  const evaluation = evaluateMigrationTarget(indexed.index, target.key);
  assert.ok(evaluation?.coverage && evaluation.contract && evaluation.structure);
  return {
    ...evaluation,
    coverage: evaluation.coverage,
    contract: evaluation.contract,
    structure: evaluation.structure,
  };
}

test("v0.3 unresolved association is distinct from relevant and proven unrelated statements", () => {
  for (const [sql, state] of [
    ["ALTER TABLE public.t DROP COLUMN id;", "RELEVANT_NOT_EVALUATED"],
    ["ALTER TABLE other.t DROP COLUMN id;", "IRRELEVANT_TO_TARGET"],
    ["ALTER TABLE public.other DROP COLUMN id;", "IRRELEVANT_TO_TARGET"],
    ["ALTER TABLE t DROP COLUMN id;", "UNRESOLVED_TARGET_ASSOCIATION"],
    ['ALTER TABLE "t" DROP COLUMN id;', "UNRESOLVED_TARGET_ASSOCIATION"],
    ['ALTER TABLE "T" DROP COLUMN id;', "IRRELEVANT_TO_TARGET"],
    ['ALTER TABLE public."ｔ" DROP COLUMN id;', "IRRELEVANT_TO_TARGET"],
    ["CREATE TRIGGER broken;", "UNRESOLVED_TARGET_ASSOCIATION"],
    ["CREATE UNIQUE INDEX broken;", "UNRESOLVED_TARGET_ASSOCIATION"],
    ["CREATE POLICY broken;", "UNRESOLVED_TARGET_ASSOCIATION"],
  ]) {
    const e = analyze(`CREATE TABLE public.t (id integer PRIMARY KEY); ${sql}`);
    assert.equal(e.coverage.statements[0]?.state, "EVALUATED_FOR_TARGET", sql);
    assert.equal(e.coverage.statements[1]?.state, state, sql);
    assert.equal(
      Object.values(e.coverage.counts).reduce((a, b) => a + b, 0),
      2,
    );
    assert.equal(new Set(e.coverage.statements.map((s) => s.ordinal)).size, 2);
    if (state === "UNRESOLVED_TARGET_ASSOCIATION") {
      assert.equal(e.coverage.counts.UNRESOLVED_TARGET_ASSOCIATION, 1);
      assert.equal(e.coverage.counts.RELEVANT_NOT_EVALUATED, 0);
      assert.equal(e.coverage.counts.IRRELEVANT_TO_TARGET, 0);
      assert.equal(e.coverage.relevant, 1);
      assert.equal(e.coverage.state, "PARTIAL STATIC COVERAGE");
      assert.equal(e.contract.status, "provisional");
      assert.equal(e.contract.columns[0]?.state, "provisional");
      assert.equal(e.policy?.columns[0]?.disposition, "provisional");
      assert.equal(e.notEvaluated.length, 0);
      const raw = renderMigrationTargetReport(e);
      assert.match(raw, /could not be safely associated with a target/);
      assert.match(raw, /target association unresolved; relevance and effects not established/);
      assert.doesNotMatch(raw, /COMPLETE STATIC COVERAGE|NOT EVALUATED\n- none/);
      assert.doesNotMatch(raw, /Final mapping is provisional because target statements/);
    } else if (state === "IRRELEVANT_TO_TARGET") {
      assert.equal(e.coverage.state, "COMPLETE STATIC COVERAGE");
      assert.equal(e.contract.status, "established_static_shape");
    }
  }
});

test("v0.3 unresolved type association and referenced-key mutations do not establish final contracts", () => {
  const typed = analyze(
    "CREATE TYPE state AS ENUM ('a'); CREATE TABLE public.t (id integer PRIMARY KEY, status public.state);",
  );
  assert.equal(typed.coverage.counts.UNRESOLVED_TARGET_ASSOCIATION, 1);
  assert.equal(typed.coverage.state, "PARTIAL STATIC COVERAGE");
  assert.equal(typed.contract.status, "provisional");
  const fk = analyze(
    "CREATE TABLE public.parent (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY); " +
      "CREATE TABLE public.t (id integer PRIMARY KEY, parent_id integer REFERENCES public.parent(id)); " +
      "ALTER TABLE parent DROP COLUMN id;",
  );
  assert.equal(fk.structure.foreignKeys[0]?.identityResolutionMayBeRequired, false);
});

for (const scenario of acceptanceCases) {
  test(`v0.3 acceptance: ${scenario.name} machine and human evidence`, () => {
    const e = analyze(scenario.sql, scenario.name === "quoted" ? "Mixed Table" : "t");
    const decision = deriveMigrationDecision(e);
    const human = renderMigrationDecisionReport(decision);
    const raw = renderMigrationTargetReport(e);
    assert.equal(
      Object.values(e.coverage.counts).reduce((a, b) => a + b, 0),
      e.coverage.discovered,
    );
    assert.equal(new Set(e.coverage.statements.map((s) => s.ordinal)).size, e.coverage.discovered);
    assert.ok(human.includes(e.coverage.state));
    assert.ok(human.includes(decision.target));
    assert.ok(raw.includes("TECHNICAL EVIDENCE"));
    assert.ok(raw.includes("STATEMENT ACCOUNTING"));
    for (const c of e.contract.columns) {
      const profileColumn = e.policy?.columns.find((p) => p.name.identity === c.name.identity);
      assert.equal(profileColumn?.disposition, c.state);
      assert.equal(profileColumn?.authority, c.authority);
    }
    assert.ok(human.includes("Not production approval"));
    assert.ok(decision.bottomLine.length >= 1 && decision.bottomLine.length <= 3);
    const primary = decision.sections.find((s) => s.heading === "PRIMARY FINDINGS");
    assert.ok(primary && primary.facts.length <= 6);
    const column = (name: string) => {
      const c = e.contract.columns.find((c) => c.name.identity === name);
      assert.ok(c);
      return c;
    };
    switch (scenario.name) {
      case "clean":
        assert.equal(column("label").state, "required_source_value");
        assert.match(human, /Required from source: id, label/);
        break;
      case "identity-default":
        assert.equal(column("id").authority, "database_identity");
        assert.equal(column("status").authority, "database_default_available");
        assert.equal(column("memo").state, "optional_source_value");
        assert.match(human, /explicit source values are not prohibited/);
        assert.match(decision.bottomLine.join(" "), /id \(identity always\)/);
        assert.match(decision.bottomLine.join(" "), /defaults are available for status/);
        break;
      case "unique-check":
        assert.equal(e.structure.unique[0]?.name?.identity, "email_unique");
        assert.deepEqual(
          e.structure.unique[0]?.columns.map((c) => c.identity),
          ["email"],
        );
        assert.equal(e.structure.checks[0]?.name?.identity, "positive");
        assert.match(raw, /CHECK positive:.*amount > 0/);
        assert.match(raw, /Expression semantics not evaluated/);
        break;
      case "self-fk":
        assert.equal(e.structure.foreignKeys[0]?.referencedTable.local.identity, "t");
        assert.match(raw, /FK parent_fk: \(parent_id\) → public.t \(id\)/);
        break;
      case "composite-types":
        assert.equal(column("payload").state, "blocked_by_profile");
        assert.equal(column("tags").state, "blocked_by_profile");
        assert.match(human, /payload \(jsonb\)/);
        assert.match(raw, /tags: text\[\]/);
        break;
      case "staging":
        assert.deepEqual(e.observed?.primaryKeyColumns, []);
        assert.match(human, /No primary key is declared/);
        break;
      case "orders":
        assert.equal(column("customer_id").state, "required_source_value");
        assert.equal(column("customer_id").foreignKeySource, true);
        assert.match(raw, /public.customers \(id\)/);
        break;
      case "rls-policy":
        assert.equal(e.structure.rls[0]?.value, true);
        assert.equal(e.structure.policies[0]?.roles?.[0]?.identity, "authenticated");
        assert.match(raw, /POLICY insert_policy: INSERT.*roles authenticated.*WITH CHECK present/);
        break;
      case "trigger":
        assert.equal(e.structure.triggers[0]?.effects, "not_evaluated");
        assert.match(raw, /TRIGGER insert_guard: BEFORE INSERT.*row.*public.guard/);
        break;
      case "add-column":
        assert.equal(e.contract.status, "provisional");
        assert.equal(column("id").state, "provisional");
        assert.match(human, /Final mapping is provisional/);
        break;
      case "enum":
        assert.deepEqual(e.structure.enums[0]?.labels, ["new", "done"]);
        assert.match(raw, /ENUM state → public.state: "new", "done"/);
        break;
      case "generated":
        assert.equal(column("total").authority, "database_generated_expression");
        assert.equal(column("total").state, "database_generated");
        assert.match(human, /Database computed: total/);
        assert.match(decision.bottomLine.join(" "), /total \(computed expression\)/);
        break;
      case "non-public":
        assert.equal(e.result, "outside_envelope_observed");
        assert.match(human, /reporting.t/);
        assert.match(human, /qualify all proposed mapping/);
        break;
      case "quoted":
        assert.equal(column("Key").name.quoted, true);
        assert.match(human, /public\."Mixed Table"/);
        break;
      case "drop-rename":
        assert.equal(e.coverage.counts.RELEVANT_NOT_EVALUATED, 2);
        assert.match(raw, /DROP TABLE.*RELEVANT_NOT_EVALUATED/);
        break;
      case "generated-fk":
        assert.equal(e.structure.foreignKeys[0]?.identityResolutionMayBeRequired, true);
        assert.match(human, /identity resolution may be required/);
        break;
      case "mixed-dml":
        assert.equal(e.coverage.counts.UNSUPPORTED_DOCUMENT_STATEMENT, 3);
        assert.match(raw, /INSERT — unsupported document statement; not evaluated/);
        assert.match(raw, /UPDATE — unsupported document statement; not evaluated/);
        assert.match(raw, /DELETE — unsupported document statement; not evaluated/);
        assert.doesNotMatch(raw, /NOT EVALUATED\n- none/);
        break;
      case "large":
        assert.equal(e.coverage.discovered, 310);
        assert.equal(e.coverage.counts.UNSUPPORTED_DOCUMENT_STATEMENT, 2);
        assert.equal(e.structure.triggers[0]?.name.identity, "t_guard");
        assert.equal(e.structure.policies[0]?.name.identity, "t_insert");
        assert.deepEqual(e.structure.enums[0]?.labels, ["new", "accepted", "held"]);
        assert.equal(e.coverage.counts.IRRELEVANT_TO_TARGET, 300);
        assert.match(raw, /public.obj_1 \(id\)/);
        break;
    }
  });
}

test("v0.3 ledger accounts for unknown SQL, protected function/string bodies, types and empty statements", () => {
  const e = analyze(`-- comment ; INSERT
CREATE TYPE public.state AS ENUM ('a;b');
CREATE TABLE public.t (id integer PRIMARY KEY, state public.state);
ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON public.t USING (true);
CREATE TRIGGER tr BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.f();
CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RETURN NEW; END; $$;
INSERT INTO public.t VALUES (1, 'a;b'); UPDATE public.t SET id = 2; DELETE FROM public.t;
VACUUM public.t; ;`);
  assert.equal(e.coverage.discovered, 11);
  assert.equal(e.coverage.counts.EVALUATED_FOR_TARGET, 5);
  assert.equal(e.coverage.counts.UNSUPPORTED_DOCUMENT_STATEMENT, 5);
  assert.equal(e.coverage.counts.IRRELEVANT_TO_TARGET, 1);
  assert.equal(e.coverage.state, "PARTIAL STATIC COVERAGE");
});

test("v0.3 omission authority is independent from identity mode and profile conflicts", () => {
  const e =
    analyze(`CREATE TABLE public.t (id integer PRIMARY KEY, optional text, required text NOT NULL,
    default_nullable text DEFAULT 'a', default_required text NOT NULL DEFAULT 'b',
    identity_default bigint GENERATED BY DEFAULT AS IDENTITY, computed numeric GENERATED ALWAYS AS (1) STORED,
    "bad name" text, payload jsonb);`);
  const byName = new Map(e.contract.columns.map((c) => [c.name.identity, c]));
  assert.equal(byName.get("optional")?.state, "optional_source_value");
  assert.equal(byName.get("required")?.state, "required_source_value");
  assert.equal(byName.get("default_nullable")?.authority, "database_default_available");
  assert.equal(byName.get("default_required")?.authority, "database_default_available");
  assert.equal(byName.get("identity_default")?.identityMode, "by_default");
  assert.equal(byName.get("computed")?.state, "database_generated");
  assert.equal(byName.get("bad name")?.state, "blocked_by_profile");
  const raw = renderMigrationTargetReport(e);
  assert.match(raw, /"bad name" — blocked_by_profile/);
  assert.doesNotMatch(raw, /generation\/default evidence excludes/);
  for (const c of e.contract.columns) {
    if (c.authority === "database_identity" || c.authority === "database_generated_expression")
      assert.notEqual(c.state, "required_source_value");
  }
});

test("v0.3 original locations, multiword types and FK action ownership survive projection", () => {
  const e = analyze(`-- preceding text
CREATE TABLE public.parent (id integer PRIMARY KEY);
CREATE TABLE public.t (
 id integer PRIMARY KEY,
 created timestamp with time zone,
 a integer REFERENCES public.parent(id) ON DELETE CASCADE,
 b integer REFERENCES public.parent(id) ON DELETE SET NULL,
 CONSTRAINT positive CHECK (id > 0)
);
ALTER TABLE public.t ADD CONSTRAINT uq UNIQUE (a,b);`);
  assert.equal(
    e.structure.columns.find((c) => c.name.identity === "created")?.type,
    "timestamp with time zone",
  );
  assert.equal(e.structure.columns.find((c) => c.name.identity === "created")?.span.start.line, 5);
  assert.deepEqual(
    e.structure.foreignKeys.map((f) => f.actions),
    [["on delete cascade"], ["on delete set null"]],
  );
  assert.equal(e.structure.checks[0]?.span.start.line, 8);
  assert.equal(e.structure.unique[0]?.span.start.line, 10);
  assert.deepEqual(
    e.structure.unique[0]?.columns.map((c) => c.identity),
    ["a", "b"],
  );
  assert.match(
    renderMigrationTargetReport(e),
    /UNIQUE uq: \(a, b\) composite; constraint, line 10/,
  );
});

test("v0.3 trigger UPDATE OF identities are structural, function effects remain unknown", () => {
  const e = analyze(`CREATE TABLE public.t (id integer PRIMARY KEY, "Mixed" text);
CREATE TRIGGER audit BEFORE UPDATE OF id, "Mixed" OR INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.f();`);
  assert.deepEqual(
    e.structure.triggers[0]?.updateOf.map((c) => c.identity),
    ["id", "Mixed"],
  );
  assert.match(renderMigrationTargetReport(e), /OF id, "Mixed"/);
});

test("v0.3 relationship observation does not guess keys or use unresolved final shape", () => {
  for (const suffix of [
    "ALTER TABLE public.parent RENAME COLUMN id TO changed;",
    "ALTER TABLE public.parent DROP COLUMN id;",
  ]) {
    const e =
      analyze(`CREATE TABLE public.parent (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
CREATE TABLE public.t (id integer PRIMARY KEY, parent_id bigint REFERENCES public.parent(id)); ${suffix}`);
    assert.equal(e.structure.foreignKeys[0]?.identityResolutionMayBeRequired, false);
  }
  const omitted =
    analyze(`CREATE TABLE public.parent (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
CREATE TABLE public.t (id integer PRIMARY KEY, tenant_id bigint REFERENCES public.parent);`);
  assert.equal(omitted.structure.foreignKeys[0]?.referencedColumns, null);
  assert.equal(omitted.structure.foreignKeys[0]?.identityResolutionMayBeRequired, false);
  assert.doesNotMatch(
    renderMigrationTargetReport(omitted),
    /business key|external key|tenant isolation established/,
  );
});

test("v0.3 malformed, competing and nullable ALTER generation never establishes final authority", () => {
  for (const suffix of [
    "ALTER COLUMN value SET DEFAULT",
    "ALTER COLUMN value SET DEFAULT 1 NOT NULL",
    "ALTER COLUMN value SET DEFAULT 1 UNIQUE",
    "ALTER COLUMN value ADD GENERATED ALWAYS AS IDENTITY nonsense",
    "ALTER COLUMN value ADD GENERATED ALWAYS AS IDENTITY",
  ]) {
    const e = analyze(
      `CREATE TABLE public.t (id integer PRIMARY KEY, value bigint); ALTER TABLE public.t ${suffix};`,
    );
    assert.equal(e.coverage.state, "PARTIAL STATIC COVERAGE", suffix);
    assert.equal(e.coverage.counts.RELEVANT_NOT_EVALUATED, 1, suffix);
    assert.equal(
      e.contract.columns.find((c) => c.name.identity === "value")?.state,
      "provisional",
      suffix,
    );
    assert.doesNotMatch(renderMigrationTargetReport(e), /NOT EVALUATED\n- none/);
  }
  const conflicting =
    analyze(`CREATE TABLE public.t (id integer PRIMARY KEY, value bigint GENERATED ALWAYS AS IDENTITY);
ALTER TABLE public.t ALTER COLUMN value SET DEFAULT 1;`);
  assert.equal(
    conflicting.contract.columns.find((c) => c.name.identity === "value")?.nullable,
    false,
  );
  assert.equal(conflicting.coverage.counts.RELEVANT_NOT_EVALUATED, 1);
  const valid = analyze(`CREATE TABLE public.t (id integer PRIMARY KEY, value bigint NOT NULL);
ALTER TABLE public.t ALTER COLUMN value ADD GENERATED ALWAYS AS IDENTITY;`);
  assert.equal(
    valid.contract.columns.find((c) => c.name.identity === "value")?.authority,
    "database_identity",
  );
  assert.equal(valid.coverage.state, "COMPLETE STATIC COVERAGE");
});

test("v0.3 supporting relationship declarations are evaluated ledger evidence", () => {
  const e =
    analyze(`CREATE TABLE public.parent (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
CREATE TABLE public.t (id integer PRIMARY KEY, parent_id bigint REFERENCES public.parent(id));`);
  assert.equal(e.coverage.counts.EVALUATED_FOR_TARGET, 2);
  assert.equal(e.coverage.counts.IRRELEVANT_TO_TARGET, 0);
  assert.deepEqual(e.structure.foreignKeys[0]?.supportingStatementOrdinals, [0]);
  assert.equal(e.contract.columns[0]?.span.start.line, 2);
  assert.equal(e.contract.columns[0]?.name.span.start.line, 2);
  assert.equal(e.structure.foreignKeys[0]?.referencedTable.span.start.line, 2);
});

test("v0.3 supplemental relationship evidence has a shared work budget", () => {
  const manyConstraints = Array.from(
    { length: 65 },
    (_, i) => `ALTER TABLE public.parent ADD CONSTRAINT c_${i} CHECK (id > 0);`,
  ).join("\n");
  const e =
    analyze(`CREATE TABLE public.parent (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
${manyConstraints}
CREATE TABLE public.t (id integer PRIMARY KEY, parent_id bigint REFERENCES public.parent(id));`);
  assert.equal(e.structure.foreignKeys[0]?.identityResolutionMayBeRequired, false);
  assert.equal(e.structure.foreignKeys[0]?.referencedKeyEvidence, "not_established");
  assert.equal(e.coverage.discovered, 67);
  assert.equal(e.coverage.counts.EVALUATED_FOR_TARGET, 1);
});

test("v0.3 overflow, duplicate declarations and recognition refusal retain all indexed statements", () => {
  for (const sql of [
    "CREATE TABLE public.t (id integer PRIMARY KEY); CREATE TABLE public.t (id text);",
    "CREATE TABLE public.t (id integer PRIMARY KEY, value text COLLATE missing); INSERT INTO public.t VALUES (1);",
    `CREATE TABLE public.t (id integer PRIMARY KEY); ${Array.from({ length: 270 }, (_, i) => `ALTER TABLE public.t ADD COLUMN c_${i} text;`).join(" ")}`,
  ]) {
    const e = analyze(sql);
    assert.equal(
      e.coverage.discovered,
      Object.values(e.coverage.counts).reduce((a, b) => a + b, 0),
    );
    assert.notEqual(e.coverage.state, "COMPLETE STATIC COVERAGE");
    assert.doesNotMatch(renderMigrationTargetReport(e), /NOT EVALUATED\n- none/);
  }
});

test("v0.3 first-read detail stays bounded for wide targets while technical evidence keeps identities", () => {
  const e = analyze(
    `CREATE TABLE public.t (id integer PRIMARY KEY, ${Array.from({ length: 200 }, (_, i) => `field_${i} text`).join(", ")});`,
  );
  const decision = deriveMigrationDecision(e);
  const firstRead = renderMigrationDecisionReport(decision);
  assert.match(firstRead, /more in Technical Evidence/);
  assert.ok(decision.sections.every((s) => s.facts.every((f) => Array.from(f.text).length < 430)));
  assert.match(renderMigrationTargetReport(e), /field_199: text; optional_source_value/);
  assert.equal(e.contract.columns.length, 201);
});

test("v0.3 shared enum definitions cannot multiply label rendering by column count", () => {
  const labels = Array.from({ length: 500 }, (_, i) => `'label_${i}'`).join(", ");
  const columns = Array.from({ length: 500 }, (_, i) => `field_${i} public.shared_enum`).join(", ");
  const e = analyze(
    `CREATE TYPE public.shared_enum AS ENUM (${labels}); CREATE TABLE public.t (id integer PRIMARY KEY, ${columns});`,
  );
  assert.equal(e.structure.enums.length, 500);
  assert.equal(e.structure.enums[499]?.labels?.length, 500);
  const raw = renderMigrationTargetReport(e);
  assert.ok(Buffer.byteLength(raw) < 250_000);
  assert.equal(raw.split('"label_499"').length - 1, 1);
  assert.match(raw, /field_499/);
});
