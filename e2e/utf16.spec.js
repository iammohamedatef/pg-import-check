import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const cli = fileURLToPath(new URL("../cli/pg-import-check.mjs", import.meta.url));
const renderer = new URL("../dist/src/report-renderer.js", import.meta.url).href;
const simple = "CREATE TABLE public.t (id integer PRIMARY KEY);";

function expectedReport(text, refusalId) {
  // Lone surrogates have no scalar-valid UTF-8 CLI equivalent. For that single
  // browser-only outcome, spawn the authoritative renderer rather than silently
  // replacing the surrogate with U+FFFD and claiming CLI parity.
  const result =
    refusalId === "browser_lone_surrogate"
      ? spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { renderRefusalReport } from ${JSON.stringify(renderer)}; process.stdout.write(renderRefusalReport({ refusalId: "browser_lone_surrogate" }));`,
          ],
          { timeout: 15_000 },
        )
      : spawnSync(process.execPath, [cli], { input: Buffer.from(text), timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect([0, 2]).toContain(result.status);
  expect(result.stderr.toString()).toBe("");
  return result.stdout;
}

const cases = [
  { name: "valid surrogate pair is encoded without replacement", text: `${simple} /*😀*/` },
  { name: "leading BOM remains in transported UTF-8 bytes", text: `\ufeff${simple}` },
  { name: "lone high surrogate", text: `${simple}\ud800`, refusalId: "browser_lone_surrogate" },
  { name: "lone low surrogate", text: `\udc00${simple}`, refusalId: "browser_lone_surrogate" },
  {
    name: "high surrogate followed by a non-low unit",
    text: "\ud800a",
    refusalId: "browser_lone_surrogate",
  },
  {
    name: "size lower bound wins over a lone surrogate",
    text: "\ud800" + "a".repeat(262_144),
    refusalId: "input_too_large",
  },
  {
    name: "at-limit code units still scan for a lone surrogate",
    text: "a".repeat(262_143) + "\udc00",
    refusalId: "browser_lone_surrogate",
  },
  {
    name: "late lone surrogate wins over already exceeded UTF-8 byte count",
    text: "é".repeat(131_073) + "\ud800",
    refusalId: "browser_lone_surrogate",
  },
  {
    name: "valid scalars under code-unit cap can exceed byte cap",
    text: "😀".repeat(65_537),
    refusalId: "input_too_large",
  },
  {
    name: "NUL reaches the core without being silently removed",
    text: `${simple}\0`,
    coreRefusal: "nul_byte_not_in_profile",
  },
  {
    name: "empty input reaches the core for deterministic refusal",
    text: "",
    coreRefusal: "input_empty",
  },
];

test("UTF-16 adapter follows recognition section 3.7 and transfers only admitted bytes", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const NativeEncoder = globalThis.TextEncoder;
    const NativeWorker = globalThis.Worker;
    globalThis.__adapterAudit = { encodes: [], messages: [] };
    globalThis.TextEncoder = class extends NativeEncoder {
      encode(text) {
        globalThis.__adapterAudit.encodes.push({ method: "encode", units: text.length });
        return super.encode(text);
      }
      encodeInto(text, destination) {
        globalThis.__adapterAudit.encodes.push({ method: "encodeInto", units: text.length });
        return super.encodeInto(text, destination);
      }
    };
    globalThis.Worker = class extends NativeWorker {
      postMessage(message, transfer) {
        const entry = {
          kind: message.kind,
          refusalId: message.refusalId,
          isBytes: message.bytes instanceof Uint8Array,
          byteLength: message.bytes?.byteLength,
          bytes: message.bytes?.length < 1000 ? Array.from(message.bytes) : undefined,
          transferred: transfer?.length === 1 && transfer[0] === message.bytes?.buffer,
        };
        globalThis.__adapterAudit.messages.push(entry);
        super.postMessage(message, transfer);
        entry.detached = message.bytes?.buffer.byteLength === 0;
      }
    };
  });
  await page.goto("/");
  for (const item of cases) {
    await test.step(item.name, async () => {
      const expected = expectedReport(item.text, item.refusalId);
      // Build code units inside the browser: protocol string conversion must not
      // normalize a lone surrogate before the application can validate it.
      const units = Array.from({ length: item.text.length }, (_, i) => item.text.charCodeAt(i));
      await page.evaluate((units) => {
        let text = "";
        for (let i = 0; i < units.length; i += 8192)
          text += String.fromCharCode(...units.slice(i, i + 8192));
        globalThis.__adapterAudit.encodes = [];
        globalThis.__adapterAudit.messages = [];
        const textarea = document.getElementById("ddl");
        textarea.value = text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }, units);
      await page.locator("#check").click();
      await expect
        .poll(() => page.locator("#report").textContent())
        .toBe(expected.toString("utf8"));
      expect(Buffer.from(await page.locator("#report").textContent())).toEqual(expected);
      const audit = await page.evaluate(() => globalThis.__adapterAudit);
      expect(audit.messages).toHaveLength(1);
      const message = audit.messages[0];
      if (item.refusalId === "input_too_large") {
        // A fixed cap+one sentinel invokes the core size gate without encoding
        // the rejected string; it carries no original schema content.
        expect(audit.encodes).toEqual([]);
        expect(message.kind).toBe("check");
        expect(message.byteLength).toBe(262_145);
        expect(message.transferred).toBe(true);
        expect(message.detached).toBe(true);
      } else if (item.refusalId) {
        expect(audit.encodes).toEqual([]);
        expect(message.kind).toBe("refusal");
        expect(message.refusalId).toBe(item.refusalId);
        expect(message.isBytes).toBe(false);
        expect(message.transferred).toBe(false);
      } else {
        expect(audit.encodes).toEqual([{ method: "encode", units: item.text.length }]);
        expect(message.kind).toBe("check");
        expect(message.isBytes).toBe(true);
        expect(message.byteLength).toBe(Buffer.byteLength(item.text));
        expect(message.bytes).toEqual(Array.from(Buffer.from(item.text)));
        expect(message.transferred).toBe(true);
        expect(message.detached).toBe(true);
      }
      if (item.coreRefusal) expect(expected.toString()).toContain(`REFUSED: ${item.coreRefusal}\n`);
    });
  }
});
