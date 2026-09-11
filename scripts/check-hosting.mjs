// Bounded static-delivery smoke: 32 total GETs, at most 4 in flight. No DDL.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const origin = new URL(process.env.BASE_URL || "http://127.0.0.1:4173");
assert.ok(
  origin.protocol === "https:" ||
    (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)),
);
assert.equal(origin.pathname, "/");
assert.equal(origin.search, "");
assert.equal(origin.hash, "");
const files = (await readdir("dist/web")).sort();
assert.ok(files.every((p) => p === "index.html" || /^[a-z]+-[A-Za-z0-9]+\.(js|css)$/.test(p)));
const expected = new Map(
  await Promise.all(files.map(async (name) => [name, await readFile(`dist/web/${name}`)])),
);
const rows = [];
for (let offset = 0; offset < 32; offset += 4) {
  const batch = await Promise.all(
    Array.from({ length: 4 }, async (_, i) => {
      const name = files[(offset + i) % files.length];
      const started = performance.now();
      const response = await fetch(new URL(name === "index.html" ? "/" : name, origin), {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes, expected.get(name), `Asset content differs: ${name}`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(response.headers.get("content-security-policy") || "", /connect-src 'none'/);
      assert.match(response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
      const cache = response.headers.get("cache-control");
      assert.match(cache || "", name === "index.html" ? /max-age=0/ : /immutable/);
      assert.equal(response.headers.get("set-cookie"), null);
      return {
        name,
        status: response.status,
        bytes: bytes.length,
        latencyMs: performance.now() - started,
        cacheControl: cache,
        edgeCache: response.headers.get("x-vercel-cache"),
        contentType: response.headers.get("content-type"),
      };
    }),
  );
  rows.push(...batch);
}
console.log(
  JSON.stringify(
    {
      origin: origin.origin,
      requests: rows.length,
      concurrency: 4,
      errors: 0,
      totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
      note: "Small static-asset delivery smoke; no evaluation service, no sustained stress, no maximum-user estimate.",
      rows,
    },
    null,
    2,
  ),
);
