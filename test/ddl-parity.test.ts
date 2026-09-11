import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import test from "node:test";

/**
 * Replay unmodified compiled frozen fixtures. An in-memory loader decorates ONLY
 * their frozen entry point: each invocation checks the new adapter against the
 * frozen result, then returns the original result to the original assertions.
 * No fixture files, source files, generated fixtures or allowlists are rewritten.
 */
test("all frozen fixtures replay with differential checks at the table entry point", async () => {
  const directory = new URL("./", import.meta.url);
  const names = (await readdir(directory)).filter((name) =>
    /^(create-table-.*|input-profile|lexical-trivia|source-cursor)\.test\.js$/.test(name),
  );
  assert.equal(names.length, 17);
  const otherFamilyPrefixes = [
    "ALTER TABLE",
    "COMMENT ON",
    "CREATE TYPE",
    "CREATE POLICY",
    "CREATE FUNCTION",
    "CREATE TRIGGER",
    "CREATE CONSTRAINT TRIGGER",
    "CREATE INDEX",
    "CREATE UNIQUE INDEX",
    "CREATE OR REPLACE FUNCTION",
  ];
  const otherFamilyCases = otherFamilyPrefixes.map((prefix) => `${prefix} 'unterminated`);
  const decoration = `
import ddlAssert from 'node:assert/strict';
import { recognizeDdl as ddlRecognize } from './ddl-recognizer.js';
let ddlComparisons = 0;
process.on('exit', () => console.log('DDL_PARITY_CALLS=' + ddlComparisons));
export function recognizeCreateTableCoreShape(input) {
  const frozen = frozenRecognizeCreateTableCoreShape(input);
  const actual = ddlRecognize(input);
  ddlComparisons++;
  if (frozen.kind === 'recognized_core_shape') {
    ddlAssert.equal(actual.kind, 'recognized');
    ddlAssert.deepEqual(actual.evidence.target, frozen.coreShape);
    ddlAssert.deepEqual(actual.evidence.associated, frozen.coreShape.derived);
  } else if (frozen.kind === 'refused') {
    ddlAssert.deepEqual(actual, frozen);
  } else {
    ddlAssert.equal(actual.kind, 'refused');
    const id = actual.refusal.refusalId;
    if (id === 'syntax_not_in_profile') {
      if (frozen.boundary.kind === 'unexpected_token') {
        ddlAssert.deepEqual(actual.refusal.span, frozen.boundary.span);
      } else {
        ddlAssert.equal(actual.refusal.atEndOfInput, true);
        ddlAssert.deepEqual(actual.refusal.location, frozen.boundary.location);
      }
    } else if (${JSON.stringify(otherFamilyCases)}.includes(input.sourceText)) {
      // These exact frozen fixtures deliberately select a DIFFERENT family.
      // Their new family now demands the previously untouched malformed string.
      ddlAssert.equal(id, 'unterminated_string');
      ddlAssert.equal(actual.refusal.span.start.rawByteOffset, input.sourceText.indexOf("'"));
      ddlAssert.equal(actual.refusal.span.end.rawByteOffset, input.rawBytes.length);
    } else {
      // Public dispatch/statement-count reasons intentionally replace the private
      // single-family grammar miss. Their own tests check exact public locations.
      ddlAssert.ok(['unsupported_statement', 'multiple_target_tables',
        'empty_statement_not_in_profile',
        'input_empty'].includes(id), id);
      if (id === 'empty_statement_not_in_profile') {
        ddlAssert.equal(frozen.boundary.kind, 'unexpected_token');
        ddlAssert.deepEqual(actual.refusal.span, frozen.boundary.span);
      } else if (id === 'multiple_target_tables') {
        ddlAssert.equal(actual.refusal.actualTargetCount, 2);
        ddlAssert.deepEqual(actual.refusal.span, frozen.boundary.span);
      } else if (id === 'input_empty') {
        ddlAssert.equal(frozen.boundary.kind, 'end_of_input');
      } else {
        const fragment = new TextDecoder().decode(input.rawBytes.subarray(actual.refusal.span.start.rawByteOffset, actual.refusal.span.end.rawByteOffset));
        ddlAssert.ok(['SELECT', 'CREATE VIEW', 'CREATE UNLOGGED', 'CREATE TEMP VIEW'].includes(fragment), fragment);
      }
    }
  }
  return frozen;
}
`;
  const hook = `
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/src/create-table-core-shape.js')) return result;
  const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
  return {...result, source: source.replace('export function recognizeCreateTableCoreShape(', 'function frozenRecognizeCreateTableCoreShape(') + ${JSON.stringify(decoration)}};
}});
`;
  const args = [
    "--import",
    `data:text/javascript,${encodeURIComponent(hook)}`,
    "--test",
    "--test-reporter=tap",
    ...names.map((name) => new URL(name, directory).pathname),
  ];
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout.setEncoding("utf8").on("data", (data) => output.push(data));
  child.stderr.setEncoding("utf8").on("data", (data) => output.push(data));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const text = output.join("");
  assert.equal(
    code,
    0,
    text
      .split("\n")
      .filter((_line, index, lines) =>
        lines
          .slice(Math.max(0, index - 45), index + 1)
          .some((previous) => previous.includes("not ok")),
      )
      .join("\n") || text,
  );
  assert.match(text, /# tests 187\b/);
  const calls = [...text.matchAll(/DDL_PARITY_CALLS=(\d+)/g)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  assert.ok(calls >= 500, `Expected comprehensive replay, observed ${calls} calls`);
});
