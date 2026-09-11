import assert from "node:assert/strict";
import test from "node:test";
import { recognizeDdl } from "../src/ddl-recognizer.js";
import { applyRawInputProfile } from "../src/input-profile.js";

function run(sql: string) {
  const input = applyRawInputProfile(new TextEncoder().encode(sql));
  assert.equal(input.kind, "accepted");
  if (input.kind !== "accepted") throw new Error("fixture input");
  return recognizeDdl(input);
}
function refusal(sql: string, id = "ambiguous_declaration", anchor?: string, occurrence = "last") {
  const result = run(sql);
  assert.equal(result.kind, "refused", sql);
  if (result.kind !== "refused") throw new Error("fixture refusal");
  assert.equal(result.refusal.refusalId, id, sql);
  if (anchor !== undefined) {
    assert.ok("span" in result.refusal);
    const offset = occurrence === "first" ? sql.indexOf(anchor) : sql.lastIndexOf(anchor);
    assert.equal(
      result.refusal.span.start.rawByteOffset,
      new TextEncoder().encode(sql.slice(0, offset)).length,
      sql,
    );
  }
  return result.refusal;
}
function accepted(sql: string) {
  const result = run(sql);
  assert.equal(result.kind, "recognized", JSON.stringify(result));
  if (result.kind !== "recognized") throw new Error("fixture recognition");
  return result.evidence;
}
const table = "CREATE TABLE public.t (a int, b int, c int)";
const func = "CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE plpgsql AS $$body$$";
const trigger = "CREATE TRIGGER tr AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()";

test("postparse stage ordering: target count, association, conflicts, unused auxiliaries", () => {
  refusal("CREATE TYPE e AS ENUM ('a', 'a')", "no_target_table");
  const two = refusal(
    `${table}; CREATE TABLE x (a int, a int); ALTER TABLE wrong.t ADD UNIQUE (missing)`,
    "multiple_target_tables",
    "CREATE TABLE x",
  );
  assert.ok("actualTargetCount" in two);
  assert.equal(two.actualTargetCount, 2);
  refusal(
    "CREATE TABLE t (a int, a int); CREATE INDEX i ON wrong (a)",
    "statement_targets_other_relation",
    "wrong",
  );
  refusal(
    `CREATE TYPE unused AS ENUM ('a'); ${table}; ALTER TABLE public.t ADD UNIQUE (missing)`,
    "ambiguous_declaration",
    "UNIQUE",
  );
  refusal(
    `CREATE TYPE unused AS ENUM ('a'); ${table}`,
    "unassociated_auxiliary_declaration",
    "CREATE TYPE",
  );
});

for (const shell of [
  "ALTER TABLE t ADD UNIQUE (a)",
  "CREATE POLICY p ON t",
  "CREATE INDEX i ON t (a)",
  "CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
])
  test(`strict qualification: ${shell}`, () => {
    refusal(`${table}; ${shell}`, "statement_targets_other_relation");
  });

test("auxiliary association has no search_path and does not inspect bodies/defaults", () => {
  refusal(
    "CREATE TYPE public.e AS ENUM ('x'); CREATE TABLE t (a e)",
    "unassociated_auxiliary_declaration",
  );
  refusal(
    "CREATE TYPE e AS ENUM ('x'); CREATE TABLE t (a public.e)",
    "unassociated_auxiliary_declaration",
  );
  refusal(
    `CREATE FUNCTION public.f() RETURNS TRIGGER LANGUAGE plpgsql AS $$f()$$; ${table}; ${trigger}`,
    "unassociated_auxiliary_declaration",
  );
  refusal(
    `CREATE TYPE e AS ENUM ('x'); CREATE TABLE t (a text DEFAULT ('e'), b text CHECK (e))`,
    "unassociated_auxiliary_declaration",
  );
  accepted("CREATE TYPE E AS ENUM ('x'); CREATE TABLE t (a \"e\"[])");
  accepted(`${trigger}; ${table}; ${func}`);
  accepted(`${table}; ${trigger}`); // An omitted declaration is not invented.
  accepted(`${table}; COMMENT ON nonexistent IS 'f() e'`);
});

test("associated derived views merge ALTER before/after table without disturbing column ordinals", () => {
  const sql = `ALTER TABLE public.t ADD CONSTRAINT k PRIMARY KEY (b, a); CREATE TABLE public.t (a int CONSTRAINT na NOT NULL, b int, c int CONSTRAINT uc UNIQUE); ALTER TABLE public.t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p(x)`;
  const e = accepted(sql);
  assert.deepEqual(
    e.columns.map((c) => c.name.identity),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    e.associated.explicitConstraintNames.map((n) => [
      n.name.identity,
      n.targetColumnOrdinal,
      n.sourceOrder,
    ]),
    [
      ["k", null, 0],
      ["na", 0, 1],
      ["uc", 2, 2],
      ["fk", null, 3],
    ],
  );
  assert.deepEqual(
    e.associated.tableKeyConstraints[0]?.columnReferences.map((c) => c.identity),
    ["b", "a"],
  );
  assert.equal(e.target.derived.tableKeyConstraints.length, 0);
});

for (const [first, second] of [
  ["CREATE POLICY p ON public.t", 'CREATE POLICY "p" ON public.t'],
  [trigger, trigger],
  ["CREATE INDEX i ON public.t (a)", "CREATE UNIQUE INDEX I ON public.t (b)"],
  [
    "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE public.t DISABLE ROW LEVEL SECURITY",
  ],
  [
    "ALTER TABLE public.t FORCE ROW LEVEL SECURITY",
    "ALTER TABLE public.t NO FORCE ROW LEVEL SECURITY",
  ],
  [
    "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY",
  ],
  ["CREATE TYPE e AS ENUM ('x')", "CREATE TYPE E AS ENUM ('y')"],
  [func, func.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")],
])
  test(`duplicate namespace or RLS: ${first}`, () => {
    refusal(`${first}; ${table}; ${second}`);
  });

test("enum label duplication uses decoded exact values without normalization", () => {
  refusal("CREATE TYPE e AS ENUM ('it''s', 'it''s'); CREATE TABLE t (a e)");
  const e = accepted("CREATE TYPE e AS ENUM ('é', 'é', 'X', 'x', ''); CREATE TABLE t (a e)");
  assert.equal(e.enums.size, 1);
});

test("object namespaces remain separate and identifiers keep quote identity", () => {
  accepted(
    `${table}; CREATE POLICY x ON public.t; CREATE TRIGGER x AFTER UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION f(); CREATE INDEX x ON public.t (a); ALTER TABLE public.t ADD CONSTRAINT x CHECK (true); CREATE POLICY "X" ON public.t`,
  );
});

for (const addition of [
  "PRIMARY KEY (a, a)",
  "UNIQUE (missing)",
  "FOREIGN KEY (a, a) REFERENCES p(x, y)",
  "FOREIGN KEY (missing) REFERENCES p(x)",
  "FOREIGN KEY (a, b) REFERENCES p(x)",
])
  test(`ALTER constraint association refuses ${addition}`, () => {
    refusal(`ALTER TABLE public.t ADD ${addition}; ${table}`);
  });

for (const sql of [
  `${table}; CREATE INDEX i ON public.t (a, a)`,
  `${table}; CREATE INDEX i ON public.t (missing)`,
  `${table}; CREATE INDEX i ON public.t (a,b); CREATE INDEX j ON public.t (a,b)`,
  `${table}; CREATE UNIQUE INDEX i ON public.t (a,b); CREATE UNIQUE INDEX j ON public.t (a,b)`,
  `ALTER TABLE public.t ADD UNIQUE (a,b); ${table}; ALTER TABLE public.t ADD UNIQUE (b,a)`,
  `ALTER TABLE public.t ADD UNIQUE (a); CREATE TABLE public.t (a int UNIQUE)`,
  `ALTER TABLE public.t ADD PRIMARY KEY (a); CREATE TABLE public.t (a int, b int PRIMARY KEY)`,
  `ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p(x,y); ${table}; ALTER TABLE public.t ADD FOREIGN KEY (b,a) REFERENCES p(y,x)`,
  `ALTER TABLE public.t ADD FOREIGN KEY (a) REFERENCES p(x); CREATE TABLE public.t (a int REFERENCES p(x))`,
  `ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p; ${table}; ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p`,
])
  test(`modeled duplicate: ${sql}`, () => {
    refusal(sql);
  });

test("index identity uses ordered list and uniqueness; FK identity uses positional pairs", () => {
  accepted(
    `${table}; CREATE INDEX i ON public.t (a,b); CREATE INDEX j ON public.t (b,a); CREATE UNIQUE INDEX k ON public.t (a,b)`,
  );
  accepted(
    `${table}; ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p(x,y); ALTER TABLE public.t ADD FOREIGN KEY (b,a) REFERENCES p(x,y)`,
  );
  accepted(
    `${table}; ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p; ALTER TABLE public.t ADD FOREIGN KEY (b,a) REFERENCES p; ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p(x,y)`,
  );
  accepted(`${table}; ALTER TABLE public.t ADD FOREIGN KEY (a,b) REFERENCES p(x,x)`);
});

test("explicit NULL/ALTER PK refusal preserves clause order, physical ordinal and precise span", () => {
  const before = refusal(
    "ALTER TABLE public.t ADD PRIMARY KEY (b,a); CREATE TABLE public.t (a int NULL, b int NULL)",
    "conflicting_column_declaration",
    "NULL,",
    "first",
  );
  assert.ok("clauseLabels" in before);
  assert.deepEqual(before.clauseLabels, ["PRIMARY KEY", "NULL"]);
  const after = refusal(
    "CREATE TABLE public.t (a int NULL, b int NULL); ALTER TABLE public.t ADD PRIMARY KEY (b,a)",
    "conflicting_column_declaration",
    "PRIMARY",
  );
  assert.ok("column" in after);
  assert.equal(after.column.identity, "a");
  assert.deepEqual(after.clauseLabels, ["NULL", "PRIMARY KEY"]);
});

test("independent names and invalid member candidates compete through frozen selector", () => {
  refusal(
    "ALTER TABLE public.t ADD CONSTRAINT n UNIQUE (missing); CREATE TABLE public.t (a int CONSTRAINT n CHECK (true))",
    "ambiguous_declaration",
    "UNIQUE",
  );
  refusal(
    "CREATE TABLE public.t (a int CONSTRAINT n UNIQUE); ALTER TABLE public.t ADD CONSTRAINT n UNIQUE (missing)",
    "ambiguous_declaration",
    "CONSTRAINT",
  );
  // Non-unique local association cannot invent a column-specific NULL conflict.
  refusal(
    "ALTER TABLE public.t ADD PRIMARY KEY (a); CREATE TABLE public.t (a int NULL, a int)",
    "ambiguous_declaration",
    "a int)",
  );
  refusal(
    "ALTER TABLE public.t ADD FOREIGN KEY (a) REFERENCES p(x); CREATE TABLE public.t (a int, a int)",
    "ambiguous_declaration",
    "a int)",
  );
});
