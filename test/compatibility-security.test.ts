import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkCompatibility } from "../src/index.js";
import { PROFILE } from "../src/public-profile.js";
import { assertReport, check, expectCheck, target } from "./compatibility-test-helpers.js";

const success = "no_structural_conflict_observed";
const outside = "outside_envelope_observed";

test("raw refusal precedence and the stable input snapshot reach the public API", () => {
  assertReport(checkCompatibility(new Uint8Array(262_145).fill(0xff)), "refused", [
    "input_too_large",
  ]);
  assertReport(checkCompatibility(Uint8Array.of(0, 0xff)), "refused", ["invalid_utf8"]);
  expectCheck("SELECT 1;\0", "refused", ["nul_byte_not_in_profile"]);
  const bytes = new TextEncoder().encode(target());
  const original = bytes.slice();
  const report = checkCompatibility(bytes);
  assert.deepEqual(bytes, original);
  for (let run = 0; run < 20; run += 1) assert.equal(checkCompatibility(bytes), report);
});

test("recognition and association refusals precede all public policy conflicts", () => {
  for (const [ddl, reason] of [
    [`${target("id jsonb PRIMARY KEY")} SELECT 'unterminated`, "unsupported_statement"],
    [
      `CREATE TYPE public.e AS ENUM ('a','a'); ${target("id jsonb PRIMARY KEY, value public.e")}`,
      "ambiguous_declaration",
    ],
    [
      `${target("id integer PRIMARY KEY PRIMARY KEY, value jsonb")} SELECT 1;`,
      "unsupported_statement",
    ],
    [
      `${target("id jsonb PRIMARY KEY")} CREATE INDEX i ON other.t(id);`,
      "statement_targets_other_relation",
    ],
    [
      `${target("id jsonb PRIMARY KEY")} CREATE TYPE unused AS ENUM ('a');`,
      "unassociated_auxiliary_declaration",
    ],
    [
      `${target("id jsonb PRIMARY KEY")} CREATE TABLE public.other(id text);`,
      "multiple_target_tables",
    ],
    [target("id serial DEFAULT 1 PRIMARY KEY"), "conflicting_column_declaration"],
    [target('id "serial" DEFAULT 1 PRIMARY KEY'), null],
  ] as const) {
    if (reason !== null) expectCheck(ddl, "refused", [reason]);
    else
      expectCheck(ddl, "more_evidence_required", [
        "type_review_required",
        "value_generation_review_required",
      ]);
  }
});

test("all findings survive result selection in exact profile order", () => {
  const ddl = `CREATE TEMP TABLE other."t é" ("id é" integer, value jsonb DEFAULT NULL CHECK(true), fk integer REFERENCES p(id), PRIMARY KEY("id é", value)) PARTITION BY HASH(value); CREATE UNIQUE INDEX u ON other."t é"(value); CREATE TRIGGER tr BEFORE INSERT ON other."t é" FOR EACH ROW EXECUTE FUNCTION f(); ALTER TABLE other."t é" ENABLE ROW LEVEL SECURITY;`;
  const reasons = [
    "target_schema_outside_profile",
    "partitioned_target",
    "relation_review_required",
    "composite_primary_key",
    "identifier_contains_space",
    "column_type_outside_profile",
    "value_generation_review_required",
    "foreign_key_mapping_review_required",
    "check_review_required",
    "index_review_required",
    "insert_trigger_review_required",
    "policy_review_required",
  ];
  expectCheck(ddl, outside, reasons);
  const auxiliary = [
    "CREATE UNIQUE INDEX u ON public.t(value);",
    "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;",
    "CREATE TRIGGER ins BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();",
  ];
  assert.equal(
    check(`${target()} ${auxiliary.join(" ")}`),
    check(`${auxiliary.reverse().join(" ")} ${target()}`),
  );
});

test("at-cap opaque regions, comments and modifier digits have bounded traversal", {
  timeout: 15_000,
}, () => {
  for (const [prefix, suffix, result, reasons] of [
    [`${target()} /*`, "*/", success, []],
    [
      "CREATE TABLE public.t (id integer PRIMARY KEY, value text DEFAULT ('",
      "'));",
      "more_evidence_required",
      ["value_generation_review_required"],
    ],
    ["CREATE TABLE public.t (id integer PRIMARY KEY, value numeric(", "1,0));", success, []],
  ] as const) {
    const padding = "0".repeat(262_144 - prefix.length - suffix.length);
    const ddl = prefix + padding + suffix;
    assert.equal(new TextEncoder().encode(ddl).length, 262_144);
    expectCheck(ddl, result, reasons);
  }
});

test("large enum shared by many columns is evaluated once per definition", {
  timeout: 15_000,
}, () => {
  const labels = Array.from({ length: 4096 }, (_, i) => `'${i}'`).join(",");
  const columns = Array.from({ length: 1599 }, (_, i) => `c${i} public.e`).join(",");
  expectCheck(
    `CREATE TYPE public.e AS ENUM (${labels}); ${target(`id integer PRIMARY KEY,${columns}`)}`,
    success,
    [],
  );
});

test("many checks, indexes, policies and triggers remain bounded by input and observations", {
  timeout: 15_000,
}, () => {
  const declarations: string[] = [target()];
  let bytes = target().length;
  for (let i = 0; ; i += 1) {
    const ddl = `CREATE POLICY p${i} ON public.t USING (true); CREATE TRIGGER t${i} BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();`;
    if (bytes + ddl.length > 262_144) break;
    bytes += ddl.length;
    declarations.push(ddl);
  }
  const report = expectCheck(declarations.join(""), "more_evidence_required", [
    "insert_trigger_review_required",
    "policy_review_required",
  ]);
  assert.ok(report.length < 2000, "deduplicated finite reasons cannot amplify auxiliary count");
});

test("public runtime source closure has no external modules or ambient I/O capability", () => {
  const root = new URL("../../src/", import.meta.url);
  const visited = new Set<string>();
  const pending = ["index.ts"];
  const forbidden =
    /\b(?:process|console|fetch|XMLHttpRequest|WebSocket|EventSource|navigator|document|window|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|Date|eval|Function)\s*[.(]|\bimport\s*\(|Math\.random|\.localeCompare\s*\(/;
  while (pending.length > 0) {
    const name = pending.pop();
    assert.ok(name !== undefined);
    if (visited.has(name)) continue;
    visited.add(name);
    const source = readFileSync(new URL(name, root), "utf8");
    assert.doesNotMatch(source, forbidden, name);
    for (const [, imported] of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.ok(imported !== undefined);
      assert.match(imported, /^\.\/[a-z0-9-]+\.js$/, `nonlocal core import in ${name}`);
      pending.push(`${imported.slice(2, -3)}.ts`);
    }
  }
  assert.ok(visited.size > 15, "check must traverse the actual parser/evaluator/renderer closure");
  assert.equal(PROFILE.authority_status, "release_authoritative");
});
