import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompatibility } from "../src/index.js";

// A fixed seed is test infrastructure only; the semantic core never draws randomness.
function generator(seed: number): () => number {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value;
  };
}

test("deterministic hostile bytes and mutated declarations remain handled input", {
  timeout: 20_000,
}, () => {
  const next = generator(0x734c17);
  const encoder = new TextEncoder();
  const fixtures = [
    "CREATE TABLE public.t(id integer PRIMARY KEY, a text DEFAULT f('[)]'), b text CHECK ((a <> '')));",
    "CREATE TYPE public.e AS ENUM ('a','b'); CREATE TABLE public.t(id int PRIMARY KEY, a public.e);",
    "CREATE TABLE public.t(id int PRIMARY KEY); CREATE TRIGGER t BEFORE INSERT ON public.t FOR EACH ROW WHEN(true) EXECUTE FUNCTION f('a');",
    "CREATE TABLE public.t(id int PRIMARY KEY); CREATE POLICY p ON public.t USING (id > 0);",
    "CREATE TABLE public.t(id int PRIMARY KEY); COMMENT ON TABLE public.t IS 'hello';",
    "CREATE TABLE public.t(id int PRIMARY KEY); CREATE FUNCTION f() RETURNS TRIGGER AS $$a$$ LANGUAGE plpgsql; CREATE TRIGGER t AFTER UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION f();",
  ].map((sql) => encoder.encode(sql));
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const fixture = fixtures[next() % fixtures.length];
    assert.ok(fixture);
    const bytes =
      iteration % 2 === 0 ? fixture.slice(0, next() % (fixture.length + 1)) : fixture.slice();
    if (bytes.length > 0) {
      const edits = 1 + (next() % 4);
      for (let i = 0; i < edits; i += 1) bytes[next() % bytes.length] = next() % 256;
    }
    const report = checkCompatibility(bytes);
    assert.equal(checkCompatibility(bytes), report);
    assert.match(report, /^PG IMPORT CHECK\nprofile: importflow-envelope-v4 \| /);
    assert.match(
      report,
      /(?:REFUSED: \w+|TEXT-ONLY VERDICT: (?:outside_envelope_observed|more_evidence_required|no_structural_conflict_observed))\n/,
    );
    for (const scalar of report) {
      const code = scalar.charCodeAt(0);
      assert.ok(code === 10 || (code >= 32 && (code < 127 || code > 159)));
    }
  }
});
