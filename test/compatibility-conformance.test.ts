import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertReport, check } from "./compatibility-test-helpers.js";

const suite = JSON.parse(
  readFileSync(new URL("../../spec/public-profile-cases.v4.json", import.meta.url), "utf8"),
) as {
  cases: { id: string; ddl: string; expected_result: string; expected_reason_ids: string[] }[];
  generated_boundaries: { id: string; expected_result: string; expected_reason_ids: string[] }[];
};

// Explicit implementations of the four approved human-readable recipes.
const recipes: Record<string, () => string> = {
  columns_at_limit: () => columns(1599),
  columns_over_limit: () => columns(1600),
  constraint_limit: () =>
    `CREATE TABLE public.t (id integer PRIMARY KEY, ${Array.from({ length: 2048 }, (_, i) => `CONSTRAINT k${i} CHECK (id > 0)`).join(",")});`,
  enum_count_over: () =>
    `CREATE TYPE public.e AS ENUM (${Array.from({ length: 4097 }, (_, i) => `'${i}'`).join(",")}); CREATE TABLE public.t (id integer PRIMARY KEY, value public.e);`,
};
function columns(additional: number): string {
  return `CREATE TABLE public.t (id integer PRIMARY KEY, ${Array.from({ length: additional }, (_, i) => `c${i + 1} integer`).join(",")});`;
}
assert.equal(suite.cases.length + suite.generated_boundaries.length, 56);
assert.deepEqual(Object.keys(recipes).sort(), suite.generated_boundaries.map((c) => c.id).sort());
for (const item of [
  ...suite.cases,
  ...suite.generated_boundaries.map((item) => {
    const recipe = recipes[item.id];
    assert.ok(recipe);
    return { ...item, ddl: recipe() };
  }),
]) {
  test(`public v4 conformance: ${item.id}`, () => {
    const ddl = item.ddl;
    assert.ok(new TextEncoder().encode(ddl).length <= 262_144);
    const report = check(ddl);
    assertReport(report, item.expected_result, item.expected_reason_ids);
    assert.equal(check(ddl), report, "same bytes must produce identical report bytes");
  });
}
