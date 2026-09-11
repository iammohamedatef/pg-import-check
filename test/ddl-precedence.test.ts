import assert from "node:assert/strict";
import test from "node:test";
import { recognizeDdl } from "../src/ddl-recognizer.js";
import { recognizeCreateTableCoreShape } from "../src/create-table-core-shape.js";
import { applyRawInputProfile, MAX_RAW_INPUT_BYTES } from "../src/input-profile.js";

function input(sql: string) {
  const accepted = applyRawInputProfile(new TextEncoder().encode(sql));
  if (accepted.kind !== "accepted") throw new Error("fixture input");
  return accepted;
}
function refusal(sql: string, id: string, anchor?: string) {
  const accepted = input(sql);
  const result = recognizeDdl(accepted);
  assert.equal(result.kind, "refused", sql);
  if (result.kind !== "refused") throw new Error("fixture refusal");
  assert.equal(result.refusal.refusalId, id, sql);
  if (anchor !== undefined) {
    assert.ok("span" in result.refusal);
    assert.equal(
      new TextDecoder().decode(
        accepted.rawBytes.subarray(
          result.refusal.span.start.rawByteOffset,
          result.refusal.span.end.rawByteOffset,
        ),
      ),
      anchor,
      sql,
    );
  }
  return result.refusal;
}
const table = "CREATE TABLE t (a int)";

test("empty input is distinct from a discarded comment statement and empty SQL statements", () => {
  refusal("--comment\n/* nested /*x*/ */", "input_empty");
  refusal("COMMENT ON t IS NULL", "no_target_table");
  refusal("; '\\", "empty_statement_not_in_profile", ";");
  refusal(`${table};; '\\`, "empty_statement_not_in_profile", ";");
  assert.equal(recognizeDdl(input(`${table}; -- trailing\n/* ok */`)).kind, "recognized");
});

for (const prefix of [
  "CREATE",
  "CREATE TEMP",
  "CREATE TEMPORARY",
  "CREATE OR",
  "CREATE OR REPLACE",
  "CREATE UNIQUE",
  "CREATE CONSTRAINT",
  "ALTER",
  "COMMENT",
]) {
  test(`proper dispatch prefix EOF: ${prefix}`, () => {
    const result = refusal(prefix, "syntax_not_in_profile");
    assert.ok("atEndOfInput" in result);
  });
}
for (const prefix of [
  "SELECT",
  "CREATE VIEW",
  "CREATE UNLOGGED",
  "CREATE FOREIGN",
  "CREATE GLOBAL",
  "CREATE SEQUENCE",
  "CREATE OR REPLACE TRIGGER",
  "DO",
  "COPY",
]) {
  test(`unsupported dispatch stops demand: ${prefix}`, () => {
    refusal(`${prefix} $bad$unterminated`, "unsupported_statement", prefix);
  });
}

for (const [sql, anchor] of [
  ["CREATE TYPE e AS BAD", "BAD"],
  ["ALTER TABLE wrong RENAME", "RENAME"],
  ["CREATE POLICY p ON wrong FOR INSERT USING", "USING"],
  ["CREATE POLICY p ON wrong FOR SELECT WITH", "WITH"],
  ["CREATE FUNCTION f() RETURNS int", "int"],
  ["CREATE FUNCTION f() RETURNS trigger LANGUAGE sql", "sql"],
  ["CREATE CONSTRAINT TRIGGER tr BEFORE", "BEFORE"],
  ["CREATE CONSTRAINT TRIGGER tr AFTER TRUNCATE", "TRUNCATE"],
  ["CREATE TRIGGER tr AFTER INSERT OR INSERT", "INSERT"],
  ["CREATE TRIGGER tr AFTER INSERT ON t FROM", "FROM"],
  ["CREATE TRIGGER tr AFTER TRUNCATE ON t FOR EACH ROW", "ROW"],
  ["CREATE INDEX ix ON wrong USING hash", "hash"],
  ["CREATE INDEX ix ON t (a) WHERE", "WHERE"],
  ["CREATE TABLE t (a int) USING", "USING"],
  ["CREATE TABLE t (a int COLLATE", "COLLATE"],
  ["CREATE TABLE t (a int CONSTRAINT n DEFAULT", "DEFAULT"],
])
  test(`decisive family grammar precedes malformed tail: ${sql}`, () => {
    refusal(`${sql} U&'unterminated (]`, "syntax_not_in_profile", anchor);
  });

test("grammar completion outranks every postparse model stage", () => {
  for (const prefix of [
    "CREATE TYPE e AS ENUM ('x')", // no target
    `${table}; CREATE TABLE u (a int)`, // multiple targets
    `${table}; CREATE POLICY p ON wrong`, // association
    "CREATE TABLE t (a int NULL NOT NULL)", // column conflict
    "CREATE TABLE t (a int, a int)", // duplicate columns
    `${table}; CREATE INDEX i ON t (missing)`, // member validation
    `${table}; CREATE TYPE e AS ENUM ('x', 'x')`, // duplicate labels
    `${table}; CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$$$`, // unused auxiliary
  ])
    refusal(`${prefix}; CREATE POLICY p ON t USING ()`, "syntax_not_in_profile", ")");
});

test("demanded lexical errors and committed typed delimiter ownership stay ordered", () => {
  refusal("CREATE U&'unterminated", "unicode_escape_syntax_not_in_profile", "U&");
  refusal("CREATE TYPE e AS ENUM ('unterminated", "unterminated_string", "'unterminated");
  refusal("CREATE TYPE e AS ENUM ('x'", "unbalanced_delimiter", "(");
  refusal("CREATE POLICY p ON t USING ([", "unbalanced_delimiter", "[");
  refusal("CREATE POLICY p ON t USING ([) 'unterminated", "unbalanced_delimiter", ")");
  refusal(
    "CREATE POLICY p ON t USING ([ $$unterminated",
    "unterminated_dollar_quote",
    "$$unterminated",
  );
  refusal("CREATE INDEX i ON t (a] 'unterminated", "unbalanced_delimiter", "]");
  refusal("COMMENT ON (x [y) IS 'unterminated", "unbalanced_delimiter", ")");
  refusal(
    "CREATE FUNCTION f() RETURNS trigger AS $a$unterminated",
    "unterminated_dollar_quote",
    "$a$unterminated",
  );
  refusal("CREATE TYPE e AS ENUM (E'unterminated", "unterminated_string", "E'unterminated");
});

test("E-string semantic refusals distinguish safely closed values from frozen type grammar misses", () => {
  const frozenInput = input("CREATE TABLE t (a E'closed')");
  const frozen = recognizeCreateTableCoreShape(frozenInput);
  assert.equal(frozen.kind, "not_recognized_by_create_table_grammar");
  refusal(frozenInput.sourceText, "syntax_not_in_profile", "E'closed'");
  refusal(
    "CREATE TYPE e AS ENUM (E'closed')",
    "escape_string_semantics_not_in_profile",
    "E'closed'",
  );
  refusal("COMMENT ON t IS E'closed'", "escape_string_semantics_not_in_profile", "E'closed'");
  assert.equal(
    recognizeDdl(input("CREATE TABLE t (a text DEFAULT E'closed' CHECK (a = E'opaque'))")).kind,
    "recognized",
  );
});

test("near-cap opaque bodies and nested comments delimit once without revealing hidden statements", () => {
  const prefix = "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $body$";
  const suffix = `$body$; ${table}; CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()`;
  const body = "CREATE TABLE secret (x x); U&' ] /*";
  const padding = "x".repeat(MAX_RAW_INPUT_BYTES - prefix.length - suffix.length - body.length);
  const accepted = input(prefix + body + padding + suffix);
  assert.equal(accepted.rawBytes.byteLength, MAX_RAW_INPUT_BYTES);
  const result = recognizeDdl(accepted);
  assert.equal(result.kind, "recognized");
  assert.deepEqual(recognizeDdl(accepted), result);
  const depth = 12000;
  const deep = `${table}; CREATE POLICY p ON t USING (${"[".repeat(depth)}1${"]".repeat(depth)}); COMMENT ON ${"(".repeat(depth)}IS${")".repeat(depth)} IS NULL`;
  assert.equal(recognizeDdl(input(deep)).kind, "recognized");
});

// Audit note: the frozen family API represents these as private grammar misses,
// which the adapter maps to public syntax_not_in_profile at the same boundary.
// Its established table/name/type/constraint productions are reused unchanged.
// New-family decoded values and names instead use the explicit §4.4 semantic
// refusal. This distinction adds neither table syntax nor successful recognition.
test("table E-string name/type/constraint misses retain the exact frozen boundary", () => {
  for (const sql of [
    "CREATE TABLE E't' (a int)",
    "CREATE TABLE s.E't' (a int)",
    "CREATE TABLE t (E'a' int)",
    "CREATE TABLE t (a E'int')",
    "CREATE TABLE t (a s.E'int')",
    "CREATE TABLE t (a int CONSTRAINT E'n' UNIQUE)",
    "CREATE TABLE t (a int, CONSTRAINT E'n' UNIQUE (a))",
    "CREATE TABLE t (a int REFERENCES E'p')",
    "CREATE TABLE t (a int, UNIQUE (E'a'))",
    "CREATE TABLE t (a int) INHERITS (E'p')",
  ]) {
    const accepted = input(sql);
    const frozen = recognizeCreateTableCoreShape(accepted);
    assert.equal(frozen.kind, "not_recognized_by_create_table_grammar");
    if (frozen.kind !== "not_recognized_by_create_table_grammar") throw new Error("fixture miss");
    const result = refusal(sql, "syntax_not_in_profile");
    assert.ok("span" in result);
    assert.equal(frozen.boundary.kind, "unexpected_token");
    if (frozen.boundary.kind === "unexpected_token")
      assert.deepEqual(result.span, frozen.boundary.span);
  }
});
