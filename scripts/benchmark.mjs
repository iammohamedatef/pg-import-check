import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { checkCompatibility } from "../dist/src/index.js";
const simple = "CREATE TABLE public.contacts (id integer PRIMARY KEY, email text NOT NULL);";
const cases = {
  tiny: "CREATE TABLE public.t(id int PRIMARY KEY);",
  representative: `${simple} CREATE INDEX contacts_email ON public.contacts(email);`,
  large: `CREATE TABLE public.t(id int PRIMARY KEY,${Array.from({ length: 1500 }, (_, i) => `c${i} text`).join(",")});`,
  near_cap: simple.padEnd(262_144, " "),
  hostile_nested: `CREATE TABLE public.t(id int PRIMARY KEY, x text DEFAULT ${"(".repeat(4096)}1${")".repeat(4096)});`,
  hostile_opaque: `CREATE TABLE public.t(id int PRIMARY KEY, x text DEFAULT '${"x".repeat(260_000)}');`,
  repeated_enum: `CREATE TYPE public.e AS ENUM (${Array.from({ length: 1500 }, (_, i) => `'e${i}'`).join(",")}); CREATE TABLE public.t(id int PRIMARY KEY,${Array.from({ length: 1500 }, (_, i) => `c${i} public.e`).join(",")});`,
};
const rows = [];
for (const [name, ddl] of Object.entries(cases)) {
  const bytes = new TextEncoder().encode(ddl);
  for (let i = 0; i < 3; i++) checkCompatibility(bytes);
  global.gc?.();
  const before = process.memoryUsage();
  const times = [];
  let report;
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    report = checkCompatibility(bytes);
    times.push(performance.now() - start);
  }
  const after = process.memoryUsage();
  global.gc?.();
  const retained = process.memoryUsage();
  times.sort((a, b) => a - b);
  rows.push({
    name,
    inputBytes: bytes.length,
    iterations: times.length,
    p50Ms: times[10],
    p95Ms: times[19],
    maxMs: times[20],
    heapDeltaBeforeGcBytes: after.heapUsed - before.heapUsed,
    heapDeltaAfterGcBytes: retained.heapUsed - before.heapUsed,
    rssBytes: after.rss,
    reportBytes: Buffer.byteLength(report),
  });
}
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      gcExposed: !!global.gc,
      note: "Local device measurements, 3 warmups + 21 sequential evaluations per corpus. Not a hosting capacity or universal latency claim. Heap includes runtime/JIT allocations.",
      rows,
    },
    null,
    2,
  ),
);
