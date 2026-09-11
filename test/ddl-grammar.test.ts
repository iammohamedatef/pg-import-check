import assert from "node:assert/strict";
import test from "node:test";
import { recognizeDdl } from "../src/ddl-recognizer.js";
import { ddlQualifiedIdentityKey } from "../src/ddl-evidence.js";
import { applyRawInputProfile } from "../src/input-profile.js";

function recognize(sql: string) {
  const input = applyRawInputProfile(new TextEncoder().encode(sql));
  assert.equal(input.kind, "accepted");
  if (input.kind !== "accepted") throw new Error("fixture input");
  return recognizeDdl(input);
}
function accepted(sql: string) {
  const result = recognize(sql);
  assert.equal(result.kind, "recognized", JSON.stringify(result));
  if (result.kind !== "recognized") throw new Error("fixture recognition");
  return result.evidence;
}
const table = "CREATE TABLE public.t (id integer PRIMARY KEY, b text)";

test("complete interleaved statement set retains frozen evidence and absolute BOM/multibyte spans", () => {
  const sql = `\uFEFF-- é\r\nCREATE TYPE public.mood AS ENUM ('', 'it''s', 'é', '\uFEFF');
ALTER TABLE public.t ADD CONSTRAINT positive CHECK (id > 0);
CREATE FUNCTION public.f() RETURNS TRIGGER AS $fn$malformed SQL ) U&' ; CREATE TABLE hidden(x x)$fn$ SECURITY DEFINER LANGUAGE PLPGSQL;
CREATE TABLE public.t (id integer PRIMARY KEY, mood public.mood DEFAULT 'é');
CREATE UNIQUE INDEX ix ON ONLY public.t USING BTREE (mood);
CREATE POLICY pol ON public.t AS RESTRICTIVE FOR UPDATE TO PUBLIC, "current_user" USING (id > 0) WITH CHECK (mood <> '');
ALTER TABLE ONLY public.t ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.t NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER tr AFTER INSERT OR UPDATE ON public.t FOR EACH ROW WHEN (NEW.id > 0) EXECUTE FUNCTION public.f('it''s', '\\');
COMMENT ON COLUMN public.t.mood IS 'semicolons ; and quote '' content';`;
  const evidence = accepted(sql);
  assert.equal(evidence.columns.length, 2);
  assert.equal(evidence.target.derived.tableCheckConstraints.length, 0);
  assert.equal(evidence.associated.tableCheckConstraints.length, 1);
  assert.equal(evidence.associated.explicitConstraintNames[0]?.name.identity, "positive");
  const mood = evidence.columns[1];
  assert.ok(mood);
  const enumeration = evidence.enums.get(ddlQualifiedIdentityKey(mood.type.name));
  assert.ok(enumeration);
  assert.deepEqual(enumeration.labels, ["", "it's", "é", "\uFEFF"]);
  const raw = new TextEncoder().encode(sql);
  const span = enumeration.labelSpans[2];
  assert.ok(span);
  assert.equal(
    new TextDecoder().decode(raw.subarray(span.start.rawByteOffset, span.end.rawByteOffset)),
    "'é'",
  );
  assert.equal(
    enumeration.span.start.rawByteOffset,
    new TextEncoder().encode("\uFEFF-- é\r\n").length,
  );
  assert.equal(enumeration.span.start.line, 2);
  assert.equal(evidence.functions.values().next().value?.security, "definer");
  assert.equal(evidence.indexes[0]?.unique, true);
  assert.deepEqual(evidence.triggers[0]?.events, ["insert", "update"]);
  assert.deepEqual(evidence.triggers[0]?.arguments, ["it's", "\\"]);
  assert.ok(evidence.triggers[0]?.whenSpan);
  assert.deepEqual(
    evidence.rls.map((r) => [r.axis, r.value]),
    [
      ["enabled", true],
      ["forced", false],
    ],
  );
  assert.equal(evidence.policies[0]?.mode, "restrictive");
});

const validShells = [
  "CREATE POLICY p ON public.t",
  "CREATE POLICY p ON public.t FOR INSERT WITH CHECK (true)",
  "CREATE POLICY p ON public.t FOR SELECT USING (true)",
  "CREATE POLICY p ON public.t FOR DELETE USING (true)",
  "CREATE POLICY p ON public.t FOR ALL TO CURRENT_ROLE, CURRENT_USER, SESSION_USER, PUBLIC USING ([($$;]$$)]) WITH CHECK (E'\\n')",
  "CREATE INDEX i ON public.t (id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS i ON ONLY public.t USING BTREE (id, b)",
  "ALTER TABLE ONLY public.t ADD UNIQUE (b)",
  "ALTER TABLE public.t ADD FOREIGN KEY (id) REFERENCES other.p (x)",
  "ALTER TABLE public.t ADD CHECK (id ; > 0)",
  "ALTER TABLE public.t DISABLE ROW LEVEL SECURITY",
  "ALTER TABLE public.t FORCE ROW LEVEL SECURITY",
  "CREATE TRIGGER tr BEFORE DELETE ON public.t FOR EACH ROW EXECUTE PROCEDURE f()",
  "CREATE TRIGGER tr AFTER TRUNCATE OR UPDATE ON public.t FOR EACH STATEMENT EXECUTE FUNCTION f('a')",
  "CREATE CONSTRAINT TRIGGER tr AFTER INSERT ON public.t FROM other.t NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (true) EXECUTE FUNCTION f()",
  "CREATE CONSTRAINT TRIGGER tr AFTER UPDATE ON public.t DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f()",
  "COMMENT ON TABLE public.t IS 'text'",
  "COMMENT ON (IS (1 ; 2)) IS NULL",
  "COMMENT ON TABLE IS IS 'rightmost'",
  "COMMENT ON TABLE t IS E'not the final value' IS NULL",
  "COMMENT ON TABLE t IS 'bad candidate' extra IS 'final'",
  "COMMENT ON $$ IS ; ([ malformed $$ IS NULL",
];
for (const shell of validShells)
  test(`accepted shell: ${shell}`, () => {
    accepted(`${table}; ${shell}`);
  });

for (const options of [
  "LANGUAGE PLPGSQL AS $$; ) broken SQL U&'$$",
  "AS $x$begin ; return new; end$x$ LANGUAGE plpgsql",
  "SECURITY DEFINER AS $$$$ LANGUAGE PLPGSQL",
  "LANGUAGE plpgsql SECURITY INVOKER AS $$body$$",
  "AS $$body$$ SECURITY DEFINER LANGUAGE plpgsql",
])
  test(`function options: ${options}`, () => {
    accepted(
      `CREATE OR REPLACE FUNCTION f() RETURNS TRIGGER ${options}; ${table}; CREATE TRIGGER tr AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()`,
    );
  });

const invalidShells = [
  "CREATE TYPE m AS ENUM ()",
  "CREATE TYPE m AS ENUM ('a',)",
  "CREATE TYPE m AS text",
  "CREATE TYPE m AS ENUM ($$a$$)",
  "ALTER TABLE public.t ADD UNIQUE (id), ADD CHECK (true)",
  "ALTER TABLE public.t ADD COLUMN c integer",
  "ALTER TABLE public.t ENABLE SECURITY",
  "ALTER TABLE public.t ADD CONSTRAINT q EXCLUDE (id)",
  "CREATE POLICY p ON public.t FOR INSERT USING (true)",
  "CREATE POLICY p ON public.t FOR SELECT WITH CHECK (true)",
  "CREATE POLICY p ON public.t FOR DELETE WITH CHECK (true)",
  "CREATE POLICY p ON public.t USING ()",
  "CREATE POLICY p ON public.t USING (true) TO public",
  "CREATE POLICY p ON public.t AS OTHER",
  "CREATE POLICY p ON public.t FOR TRUNCATE",
  "CREATE POLICY p ON public.t TO",
  "CREATE POLICY p ON public.t WITH CHECK (true) USING (true)",
  "CREATE FUNCTION f(x integer) RETURNS TRIGGER LANGUAGE plpgsql AS $$$$",
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$$$",
  "CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE sql AS $$$$",
  'CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE "plpgsql" AS $$$$',
  "CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE plpgsql AS 'body'",
  "CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE plpgsql",
  "CREATE FUNCTION f() RETURNS TRIGGER AS $$$$",
  "CREATE FUNCTION f() RETURNS TRIGGER AS $$$$ LANGUAGE plpgsql LANGUAGE plpgsql",
  "CREATE FUNCTION f() RETURNS TRIGGER AS $$$$ LANGUAGE plpgsql AS $$$$",
  "CREATE FUNCTION f() RETURNS TRIGGER AS $$$$ LANGUAGE plpgsql SECURITY DEFINER SECURITY INVOKER",
  "CREATE FUNCTION f() RETURNS TRIGGER AS $$$$ LANGUAGE plpgsql IMMUTABLE",
  "CREATE TRIGGER tr INSTEAD OF INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER INSERT OR INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER UPDATE OF id ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER INSERT ON public.t FROM other.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER INSERT ON public.t DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER INSERT ON public.t INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE CONSTRAINT TRIGGER tr BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE CONSTRAINT TRIGGER tr AFTER TRUNCATE ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE CONSTRAINT TRIGGER tr AFTER INSERT ON public.t FOR EACH STATEMENT EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER TRUNCATE ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER INSERT ON public.t FOR EACH ROW WHEN () EXECUTE FUNCTION f()",
  "CREATE TRIGGER tr AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f(1)",
  "CREATE TRIGGER tr AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f('a',)",
  "CREATE TRIGGER tr AFTER INSERT ON public.t REFERENCING NEW TABLE AS n FOR EACH ROW EXECUTE FUNCTION f()",
  "CREATE INDEX CONCURRENTLY i ON public.t (id)",
  "CREATE INDEX s.i ON public.t (id)",
  "CREATE INDEX i ON public.t USING hash (id)",
  "CREATE INDEX i ON public.t ((id))",
  "CREATE INDEX i ON public.t (id DESC)",
  "CREATE INDEX i ON public.t (id COLLATE c)",
  "CREATE INDEX i ON public.t (id) WHERE true",
  "CREATE INDEX i ON public.t (id) INCLUDE (b)",
  "CREATE INDEX i ON public.t ()",
  "CREATE INDEX i ON public.t (id,)",
  "COMMENT ON IS 'x'",
  "COMMENT ON TABLE t",
  "COMMENT ON TABLE t IS",
  "COMMENT ON TABLE t IS 1",
  "COMMENT ON TABLE t IS 'x' extra",
  "COMMENT ON TABLE t IS $$x$$",
];
for (const shell of invalidShells)
  test(`refused closed grammar: ${shell}`, () => {
    const result = recognize(`${table}; ${shell}`);
    assert.equal(result.kind, "refused");
    if (result.kind === "refused")
      assert.equal(result.refusal.refusalId, "syntax_not_in_profile", JSON.stringify(result));
  });

for (const shell of [
  "CREATE TYPE e AS ENUM (E'x')",
  "CREATE POLICY E'p' ON public.t",
  "CREATE INDEX E'i' ON public.t (id)",
  "CREATE TYPE public.E't' AS ENUM ('a')",
  "CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE plpgsql AS E'body'",
  "CREATE TRIGGER tr AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f(E'arg')",
  "COMMENT ON TABLE t IS E'x'",
])
  test(`semantic escape-string refusal: ${shell}`, () => {
    const result = recognize(`${table}; ${shell}`);
    assert.equal(result.kind, "refused");
    if (result.kind === "refused")
      assert.equal(result.refusal.refusalId, "escape_string_semantics_not_in_profile");
  });

test("policy omitted defaults and supplied clauses remain distinct", () => {
  const evidence = accepted(
    `${table}; CREATE POLICY p ON public.t; CREATE POLICY q ON public.t USING (true)`,
  );
  assert.deepEqual(
    evidence.policies.map((p) => [p.mode, p.command, p.roles, p.withCheckSpan]),
    [
      ["permissive", "all", null, null],
      ["permissive", "all", null, null],
    ],
  );
});

test("temporary, inherits and terminal partition spans remain structural", () => {
  const evidence = accepted(
    "CREATE TEMPORARY TABLE IF NOT EXISTS t (a int) INHERITS (s.p, q) PARTITION BY RANGE(a) USING WITH ON TABLESPACE $$;$$; COMMENT ON t IS NULL",
  );
  assert.equal(evidence.target.temporary, true);
  assert.ok(evidence.target.inheritsClause);
  assert.ok(evidence.target.partitionByClause);
});
