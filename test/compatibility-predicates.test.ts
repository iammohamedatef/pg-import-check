import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILE } from "../src/public-profile.js";
import { expectCheck, target } from "./compatibility-test-helpers.js";

const success = "no_structural_conflict_observed";
const review = "more_evidence_required";
const outside = "outside_envelope_observed";

test("P01–P04 exact identity, missing evidence, and constraint name scope", () => {
  expectCheck('CREATE TABLE "public".t (id integer PRIMARY KEY);', success, []);
  expectCheck('CREATE TABLE "public"."t é" (id integer PRIMARY KEY);', outside, [
    "identifier_contains_space",
  ]);
  expectCheck('CREATE TABLE "public"."t é" ("é" integer PRIMARY KEY);', outside, [
    "identifier_contains_space",
    "identifier_review_required",
  ]);
  const report = expectCheck(
    target('id integer PRIMARY KEY, "a b" text CONSTRAINT "c é" UNIQUE'),
    outside,
    ["identifier_contains_space"],
  );
  assert.match(
    report,
    / {2}"a b" — file mapping candidate; final classification requires ImportFlow review \| identifier_contains_space\n/,
  );
  expectCheck(`${target()} CREATE INDEX "index é" ON public.t(value);`, success, []);
  expectCheck(`${target("id integer")} ALTER TABLE public.t ADD PRIMARY KEY(id);`, success, []);
  expectCheck(
    "CREATE TABLE public.t (id integer, x text); ALTER TABLE public.t ADD PRIMARY KEY(id,x);",
    outside,
    ["composite_primary_key"],
  );
});

test("P05 every approved supported and rejected type spelling", () => {
  for (const spellings of Object.values(PROFILE.builtin_type_spellings)) {
    for (const spelling of spellings)
      expectCheck(target(`id integer PRIMARY KEY, value ${spelling}`), success, []);
  }
  for (const spelling of PROFILE.known_rejected_type_spellings) {
    expectCheck(target(`id integer PRIMARY KEY, value ${spelling} DEFAULT NULL`), outside, [
      "column_type_outside_profile",
      "value_generation_review_required",
    ]);
  }
});

test("P05 numeric/modifier/array boundaries without source reinterpretation", () => {
  for (const shape of [
    "numeric(1,0)",
    "numeric(1000,1000)",
    "decimal(0001,0000)",
    `numeric(${"0".repeat(1000)}1,0)`,
  ])
    expectCheck(target(`id integer PRIMARY KEY, value ${shape}`), success, []);
  for (const shape of [
    "numeric(0,0)",
    "numeric(1001,0)",
    "numeric(1,1001)",
    `numeric(${"9".repeat(1000)},0)`,
    "unknown[][]",
    '"text"[]',
    "numeric(1)[]",
  ])
    expectCheck(target(`id integer PRIMARY KEY, value ${shape}`), outside, [
      "column_type_outside_profile",
    ]);
  for (const shape of ["numeric(1)", "text(1,2)", "integer(1)", "unknown(1,2)"])
    expectCheck(target(`id integer PRIMARY KEY, value ${shape}`), review, ["type_review_required"]);
  expectCheck(target("id integer PRIMARY KEY, value numeric(1,-1)"), "refused", [
    "syntax_not_in_profile",
  ]);
});

test("P06 enum order, exact qualification, labels and multi-column reason association", () => {
  const enumDdl = (labels: string, type = "public.e") =>
    `CREATE TYPE public.e AS ENUM (${labels}); ${target(`id integer PRIMARY KEY, a ${type}, b ${type}`)}`;
  expectCheck(enumDdl("'', 'a''b', 'a', 'A'"), success, []);
  const unicode = expectCheck(enumDdl("'é'"), review, ["enum_review_required"]);
  assert.equal(
    [...unicode.matchAll(/type requires ImportFlow review \| enum_review_required/g)].length,
    2,
  );
  expectCheck(enumDdl("'\x01'"), outside, ["enum_definition_outside_profile"]);
  expectCheck(enumDdl("'\x7f', 'é'"), outside, [
    "enum_definition_outside_profile",
    "enum_review_required",
  ]);
  expectCheck(enumDdl(`'${"a".repeat(63)}'`), success, []);
  expectCheck(enumDdl(`'${"é".repeat(32)}'`), outside, [
    "enum_definition_outside_profile",
    "enum_review_required",
  ]);
  expectCheck(enumDdl("'a'", "public.e(1)"), review, ["type_review_required"]);
  expectCheck(enumDdl("'a'", "public.e[]"), outside, ["column_type_outside_profile"]);
  expectCheck(`CREATE TYPE e AS ENUM ('a'); ${target("id integer PRIMARY KEY, value e")}`, review, [
    "type_review_required",
  ]);
  expectCheck(enumDdl("'a'", "e"), "refused", ["unassociated_auxiliary_declaration"]);
  expectCheck(
    `CREATE TYPE public."e é" AS ENUM ('a'); ${target('id integer PRIMARY KEY, value public."e é"')}`,
    outside,
    ["identifier_contains_space"],
  );
});

test("P07 generation remains excluded and review-only, including zero mapping candidates", () => {
  for (const type of ["smallserial", "serial", "bigserial", "SMALLSERIAL", "SERIAL", "BIGSERIAL"])
    expectCheck(target(`id ${type} PRIMARY KEY`), review, ["value_generation_review_required"]);
  for (const type of ['"smallserial"', "public.bigserial", "smallserial(1)", "serial2", "serial8"])
    expectCheck(target(`id ${type} PRIMARY KEY`), review, ["type_review_required"]);
  for (const clause of [
    "DEFAULT nextval('public.seq')",
    "DEFAULT current_date",
    "DEFAULT (dangerous_call())",
    "GENERATED ALWAYS AS (arbitrary_expression()) STORED",
  ]) {
    const report = expectCheck(target(`id integer PRIMARY KEY, value text ${clause}`), review, [
      "value_generation_review_required",
    ]);
    assert.match(
      report,
      / {2}value — excluded from file mapping by the ordinary generation\/default rule \| value_generation_review_required/,
    );
    assert.doesNotMatch(report, /arbitrary_expression|dangerous_call|public.seq/);
  }
  expectCheck(target("id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"), review, [
    "value_generation_review_required",
  ]);
  expectCheck(target("id mystery GENERATED ALWAYS AS IDENTITY PRIMARY KEY"), review, [
    "type_review_required",
    "value_generation_review_required",
  ]);
  expectCheck(target("id text GENERATED ALWAYS AS IDENTITY PRIMARY KEY"), outside, [
    "identity_type_outside_profile",
    "value_generation_review_required",
  ]);
});

test("P08–P10 FK requiredness never selects final value origin and CHECK stays opaque", () => {
  for (const clause of ["NULL", "NOT NULL", "DEFAULT 1", "GENERATED ALWAYS AS IDENTITY"]) {
    const reasons =
      clause.startsWith("DEFAULT") || clause.startsWith("GENERATED")
        ? ["value_generation_review_required", "foreign_key_mapping_review_required"]
        : ["foreign_key_mapping_review_required"];
    expectCheck(
      target(`id integer PRIMARY KEY, value integer ${clause} REFERENCES public.parents(id)`),
      review,
      reasons,
    );
  }
  const report = expectCheck(
    `${target("id integer PRIMARY KEY, a integer, b integer")} ALTER TABLE public.t ADD FOREIGN KEY(a,b) REFERENCES x(y,z);`,
    review,
    ["foreign_key_mapping_review_required"],
  );
  assert.equal(
    [
      ...report.matchAll(
        /final classification requires ImportFlow review \| foreign_key_mapping_review_required/g,
      ),
    ].length,
    2,
  );
  expectCheck(`${target()} ALTER TABLE public.t ADD CHECK(value ~ 'anything');`, review, [
    "check_review_required",
  ]);
  expectCheck(`${target()} ALTER TABLE public.t ADD UNIQUE(value);`, success, []);
  expectCheck(`${target()} CREATE UNIQUE INDEX u ON ONLY public.t USING BTREE(value);`, review, [
    "index_review_required",
  ]);
});

test("P11/P12 inspect shells without evaluating function bodies or effective policy", () => {
  const trigger = (name: string, events: string, when = "") =>
    `CREATE TRIGGER ${name} BEFORE ${events} ON public.t FOR EACH ROW ${when} EXECUTE FUNCTION public.effect();`;
  const body =
    "CREATE FUNCTION public.effect() RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER AS $$ BEGIN DELETE FROM private_secret; RETURN NEW; END $$;";
  const report = expectCheck(`${target()} ${body} ${trigger("u", "UPDATE")}`, success, []);
  assert.doesNotMatch(report, /private_secret|DELETE FROM|SECURITY DEFINER/);
  expectCheck(
    `${target()} ${trigger("ins", "INSERT OR UPDATE")} ${trigger("conditional", "INSERT", "WHEN (true)")}`,
    outside,
    ["insert_trigger_shape_outside_profile", "insert_trigger_review_required"],
  );
  expectCheck(
    `${target()} CREATE CONSTRAINT TRIGGER c AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION effect();`,
    outside,
    ["insert_trigger_shape_outside_profile"],
  );
  expectCheck(
    `${target()} ALTER TABLE public.t DISABLE ROW LEVEL SECURITY; ALTER TABLE public.t NO FORCE ROW LEVEL SECURITY;`,
    review,
    ["policy_review_required"],
  );
  expectCheck(`${target()} CREATE POLICY p ON public.t;`, review, ["policy_review_required"]);
});

test("P13 counts only modeled constraints and emits its reason once for two exceeded categories", () => {
  const checks = (count: number) =>
    Array.from({ length: count }, (_, i) => `CONSTRAINT k${i} CHECK(id > 0)`).join(",");
  expectCheck(target(`id integer PRIMARY KEY, ${checks(2047)}`), review, ["check_review_required"]);
  const columns = Array.from({ length: 1600 }, (_, i) => `c${i} integer NOT NULL DEFAULT 1`).join(
    ",",
  );
  expectCheck(target(`id integer PRIMARY KEY, ${columns}, ${checks(2048)}`), outside, [
    "value_generation_review_required",
    "check_review_required",
    "schema_size_outside_profile",
  ]);
  const unique = Array.from({ length: 1600 }, (_, i) => `c${i} integer UNIQUE`).join(",");
  expectCheck(target(`id integer PRIMARY KEY, ${unique}`), outside, [
    "schema_size_outside_profile",
  ]);
});
