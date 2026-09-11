import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCompatibility } from "../src/index.js";
import { MAX_RAW_INPUT_BYTES } from "../src/input-profile.js";

const root = new URL("../../", import.meta.url);
const executable = fileURLToPath(new URL("cli/pg-import-check.mjs", root));
const runner = new URL("cli/runner.mjs", root).href;
const success = Buffer.from("CREATE TABLE public.t(id integer PRIMARY KEY);");
const internalError = Buffer.from(
  "pg-import-check could not complete the check because of an internal error.\n",
);

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

function start(args = [executable], env = process.env) {
  // Run outside the package directory to verify that module loading uses the
  // executable location, not the caller's working directory.
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("../", root)),
    env,
    stdio: "pipe",
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  // Early overflow refusal and load failures may close the producer's pipe.
  child.stdin.on("error", () => {});
  const done = new Promise<ProcessResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not finish within 10 seconds."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
  return { child, done };
}

async function run(input: Uint8Array, args = [executable], env = process.env) {
  const { child, done } = start(args, env);
  child.stdin.end(input);
  return done;
}

function assertReport(result: ProcessResult, input: Uint8Array, code: number) {
  assert.equal(result.signal, null);
  assert.equal(result.code, code);
  assert.deepEqual(result.stdout, Buffer.from(checkCompatibility(input), "utf8"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
}

function assertInternalError(result: ProcessResult) {
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  assert.deepEqual(result.stderr, internalError);
}

function harness(body: string) {
  // Only this separately spawned test module injects dependencies. The actual
  // executable exposes no checker override through flags, environment, or DDL.
  return [
    "--input-type=module",
    "--eval",
    `import { runCli } from ${JSON.stringify(runner)};\n${body}`,
  ];
}

for (const item of [
  {
    name: "structural success",
    ddl: success.toString(),
    verdict: "no_structural_conflict_observed",
    code: 0,
  },
  {
    name: "explicit conflict is a completed analysis",
    ddl: "CREATE TABLE other.t(id integer PRIMARY KEY);",
    verdict: "outside_envelope_observed",
    code: 0,
  },
  {
    name: "unresolved evidence is a completed analysis",
    ddl: "CREATE TABLE t(id integer PRIMARY KEY);",
    verdict: "more_evidence_required",
    code: 0,
  },
  {
    name: "unsupported statement is a refusal",
    ddl: "SELECT 'sensitive-input';",
    verdict: "REFUSED: unsupported_statement",
    code: 2,
  },
  { name: "empty input", ddl: "", verdict: "REFUSED: input_empty", code: 2 },
  {
    name: "grammar refusal at EOF",
    ddl: "CREATE TABLE",
    verdict: "  at end of input",
    code: 2,
  },
  {
    name: "verdict words in identifiers do not control the exit",
    ddl: 'CREATE TABLE public."REFUSED: invalid_utf8"("refused" integer PRIMARY KEY);',
    verdict: "TEXT-ONLY VERDICT:",
    code: 0,
  },
  {
    name: "hostile display characters preserve canonical escaping",
    ddl: 'CREATE TABLE public."<script>\u001b[31m\u202e"(id integer PRIMARY KEY);',
    verdict: "REFUSED: identifier_contains_unsafe_character",
    code: 2,
  },
]) {
  test(`CLI real process: ${item.name}`, async () => {
    const input = Buffer.from(item.ddl);
    const result = await run(input);
    assertReport(result, input, item.code);
    assert.ok(result.stdout.toString().includes(item.verdict));
  });
}

for (const [name, input] of [
  ["isolated continuation", Buffer.from([0x80])],
  ["overlong encoding", Buffer.from([0xc0, 0xaf])],
  ["surrogate encoding", Buffer.from([0xed, 0xa0, 0x80])],
  ["out of Unicode range", Buffer.from([0xf4, 0x90, 0x80, 0x80])],
  ["truncated multibyte tail", Buffer.concat([success, Buffer.from([0xe2, 0x82])])],
] as const) {
  test(`CLI raw bytes: malformed UTF-8 ${name}`, async () => {
    const result = await run(input);
    assertReport(result, input, 2);
    assert.match(result.stdout.toString(), /\nREFUSED: invalid_utf8\n/);
  });
}

test("CLI raw bytes: NUL is refused without text decoding", async () => {
  const input = Buffer.concat([success, Buffer.from([0])]);
  const result = await run(input);
  assertReport(result, input, 2);
  assert.match(result.stdout.toString(), /\nREFUSED: nul_byte_not_in_profile\n/);
});

test("CLI raw bytes: split UTF-8, BOM, and CRLF match the public API", async () => {
  const input = Buffer.from(
    '\ufeffCREATE TABLE public.t(\r\n id integer PRIMARY KEY, "é😀" text);\r\n',
  );
  const { child, done } = start();
  // Each byte is a separate producer write, including multibyte scalar bytes.
  for (const byte of input) {
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(Buffer.from([byte]), (error) => (error ? reject(error) : resolve()));
    });
  }
  child.stdin.end();
  assertReport(await done, input, 0);
});

for (const length of [MAX_RAW_INPUT_BYTES - 1, MAX_RAW_INPUT_BYTES]) {
  test(`CLI raw bytes: ${length} bytes reach the evaluator without truncation`, async () => {
    // Put the meaningful declaration at the end to detect premature truncation.
    const input = Buffer.alloc(length, 0x20);
    input.set(success, length - success.length);
    assertReport(await run(input), input, 0);
  });
}

test("CLI raw bytes: invalid UTF-8 in the last permitted byte is not lost", async () => {
  const input = Buffer.alloc(MAX_RAW_INPUT_BYTES, 0x20);
  input.set(success);
  input[input.length - 1] = 0xff;
  const result = await run(input);
  assertReport(result, input, 2);
  assert.match(result.stdout.toString(), /\nREFUSED: invalid_utf8\n/);
});

for (const length of [MAX_RAW_INPUT_BYTES + 1, MAX_RAW_INPUT_BYTES * 16]) {
  test(`CLI raw bytes: ${length} bytes refuse before malformed UTF-8 or NUL`, async () => {
    const input = Buffer.alloc(length, 0x20);
    input[0] = 0xff;
    input[1] = 0;
    const result = await run(input);
    assertReport(result, input, 2);
    assert.match(result.stdout.toString(), /\nREFUSED: input_too_large\n/);
  });
}

test("CLI overflow: refuses and exits while the producer withholds EOF", async () => {
  const input = Buffer.alloc(MAX_RAW_INPUT_BYTES + 1, 0x20);
  const { child, done } = start();
  child.stdin.write(input);
  // Do not call end(): the child must close its input when overflow is proven.
  const result = await done;
  assert.equal(child.stdin.writableEnded, false);
  assertReport(result, input, 2);
});

test("CLI overflow: the first excess byte can arrive in a later write", async () => {
  const input = Buffer.alloc(MAX_RAW_INPUT_BYTES, 0x20);
  const { child, done } = start();
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(input, (error) => (error ? reject(error) : resolve()));
  });
  child.stdin.write(Buffer.from([0xff]));
  const result = await done;
  assertReport(result, Buffer.concat([input, Buffer.from([0xff])]), 2);
});

test("CLI deterministic bytes do not depend on locale, timezone, or color settings", async () => {
  const input = Buffer.from('CREATE TABLE public."é"(id integer PRIMARY KEY);');
  const result = await run(input, [executable], {
    ...process.env,
    LANG: "tr_TR.UTF-8",
    LC_ALL: "tr_TR.UTF-8",
    TZ: "Pacific/Honolulu",
    FORCE_COLOR: "3",
    TERM: "xterm-256color",
  });
  assertReport(result, input, 0);
});

async function closeReader(stream: ChildProcessWithoutNullStreams["stdout"]) {
  const closed = once(stream, "close");
  stream.destroy();
  await closed;
}

for (const input of [success, Buffer.from("SELECT 1;")]) {
  test(`CLI broken pipe: closed stdout exits safely for ${input.toString()}`, async () => {
    const { child, done } = start();
    // Close the real OS pipe before the child can produce a report.
    await closeReader(child.stdout);
    child.stdin.end(input);
    const result = await done;
    assert.equal(result.signal, null);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, Buffer.alloc(0));
    assert.deepEqual(result.stderr, Buffer.alloc(0));
  });
}

test("CLI output backpressure: a large report is completely flushed before exit", async () => {
  const input = largeInput();
  const { child, done } = start();
  child.stdout.pause();
  child.stdin.end(input);
  // Let the child fill the pipe, then resume consumption. No forced process.exit
  // may discard the queued suffix of the report.
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdout.resume();
  assertReport(await done, input, 0);
});

test("CLI broken pipe: reader closes after a report prefix without an internal-error notice", async () => {
  const input = largeInput();
  const { child, done } = start();
  child.stdout.once("data", () => child.stdout.destroy());
  child.stdin.end(input);
  const result = await done;
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  const expected = Buffer.from(checkCompatibility(input));
  assert.ok(result.stdout.length > 0 && result.stdout.length < expected.length);
  assert.deepEqual(result.stdout, expected.subarray(0, result.stdout.length));
});

function largeInput() {
  return Buffer.from(
    `CREATE TABLE public.t(id integer PRIMARY KEY,${Array.from(
      { length: 1599 },
      (_, index) => `c${index}_${"x".repeat(50)} text`,
    ).join(",")});`,
  );
}

for (const [name, loadCheck] of [
  ["module load rejects", 'async () => { throw new Error("private/path/DDL/secret"); }'],
  ["evaluator throws", 'async () => () => { throw new Error("private/path/DDL/secret"); }'],
  [
    "evaluator throws an error named EPIPE",
    'async () => () => { throw Object.assign(new Error("secret"), { code: "EPIPE" }); }',
  ],
  ["evaluator throws a non-Error", 'async () => () => { throw "private DDL"; }'],
  ["missing evaluator export", "async () => undefined"],
  ["invalid report type", "async () => () => ({ secret: 'private DDL' })"],
  ["invalid report header", "async () => () => 'secret\\nREFUSED: invalid_utf8\\n'"],
  ["asynchronous evaluator", "async () => async () => 'private DDL'"],
  [
    "accidentally asynchronous evaluator rejects",
    'async () => async () => { throw new Error("private/path/DDL/secret"); }',
  ],
  [
    "missing final LF",
    `async () => () => ${JSON.stringify(checkCompatibility(success).trimEnd())}`,
  ],
] as const) {
  test(`CLI separate defect harness: ${name}`, async () => {
    const result = await run(
      success,
      harness(`process.exitCode = await runCli({ loadCheck: ${loadCheck} });`),
    );
    assertInternalError(result);
  });
}

test("CLI separate defect harness: load failure exits without waiting for stdin EOF", async () => {
  const { child, done } = start(
    harness('process.exitCode = await runCli({ loadCheck: async () => { throw "secret"; } });'),
  );
  assertInternalError(await done);
  assert.equal(child.stdin.writableEnded, false);
});

test("CLI separate defect harness: broken stderr cannot leak an uncaught stack", async () => {
  const { child, done } = start(
    harness(`process.exitCode = await runCli({
      loadCheck: async () => () => { throw new Error("private DDL"); }
    });`),
  );
  await closeReader(child.stderr);
  child.stdin.end(success);
  const result = await done;
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
});

test("CLI separate defect harness: stdin read error has only the fixed diagnostic", async () => {
  const result = await run(
    success,
    harness(`import { Readable } from "node:stream";
      const stdin = new Readable({
        read() { this.destroy(new Error("private input transport detail")); }
      });
      process.exitCode = await runCli({ stdin, loadCheck: async () => () => {
        throw new Error("must not evaluate failed input");
      } });`),
  );
  assertInternalError(result);
});

test("CLI production executable cannot enable defect injection through DDL or environment", async () => {
  const input = Buffer.from(
    "CREATE TABLE public.t(id integer PRIMARY KEY); -- PG_IMPORT_CHECK_TEST_THROW private DDL",
  );
  assertReport(
    await run(input, [executable], {
      ...process.env,
      PG_IMPORT_CHECK_TEST_THROW: "1",
      PG_IMPORT_CHECK_CHECKER: "file:///does-not-exist.mjs",
    }),
    input,
    0,
  );
});
