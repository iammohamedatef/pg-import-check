import { expect, test } from "@playwright/test";

const simple = "CREATE TABLE public.t (id uuid PRIMARY KEY);";
const maxBytes = 2_097_152;

async function setExactCodeUnits(page, text) {
  const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  await page.evaluate((units) => {
    let value = "";
    for (let i = 0; i < units.length; i += 8192)
      value += String.fromCharCode(...units.slice(i, i + 8192));
    globalThis.__adapterAudit.encodes = [];
    globalThis.__adapterAudit.messages = [];
    const textarea = document.getElementById("ddl");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, units);
}

test("v0.2 UTF-16 adapter validates scalar text and transfers only bounded bytes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const NativeEncoder = globalThis.TextEncoder;
    const NativeWorker = globalThis.Worker;
    globalThis.__adapterAudit = { encodes: [], messages: [] };
    globalThis.TextEncoder = class extends NativeEncoder {
      encode(text) {
        globalThis.__adapterAudit.encodes.push({ method: "encode", units: text.length });
        return super.encode(text);
      }
    };
    globalThis.Worker = class extends NativeWorker {
      postMessage(message, transfer) {
        const entry = {
          kind: message.kind,
          isBytes: message.bytes instanceof Uint8Array,
          byteLength: message.bytes?.byteLength,
          transferred: transfer?.length === 1 && transfer[0] === message.bytes?.buffer,
        };
        globalThis.__adapterAudit.messages.push(entry);
        super.postMessage(message, transfer);
        entry.detached = message.bytes?.buffer.byteLength === 0;
      }
    };
  });
  await page.goto("/");

  await test.step("valid surrogate pair encodes exactly", async () => {
    const text = `${simple} /*😀*/`;
    await setExactCodeUnits(page, text);
    await page.locator("#check").click();
    await expect(page.locator("#report")).toContainText("public.t");
    const audit = await page.evaluate(() => globalThis.__adapterAudit);
    expect(audit.encodes).toEqual([{ method: "encode", units: text.length }]);
    expect(audit.messages[0]).toEqual({
      kind: "load",
      isBytes: true,
      byteLength: Buffer.byteLength(text),
      transferred: true,
      detached: true,
    });
    expect(audit.messages[1]?.kind).toBe("evaluate");
  });

  for (const [name, text] of [
    ["lone high surrogate", `${simple}\ud800`],
    ["lone low surrogate", `\udc00${simple}`],
  ]) {
    await test.step(name, async () => {
      await setExactCodeUnits(page, text);
      await page.locator("#check").click();
      await expect(page.locator("#result-title")).toHaveText("Invalid browser text input");
      const audit = await page.evaluate(() => globalThis.__adapterAudit);
      expect(audit.encodes).toEqual([]);
      expect(audit.messages).toEqual([]);
    });
  }

  await test.step("NUL is transferred unchanged and refused by document admission", async () => {
    const text = `${simple}\0`;
    await setExactCodeUnits(page, text);
    await page.locator("#check").click();
    await expect(page.locator("#result-title")).toHaveText("Unsupported document byte");
    const audit = await page.evaluate(() => globalThis.__adapterAudit);
    expect(audit.messages[0].byteLength).toBe(Buffer.byteLength(text));
    expect(audit.messages[0].transferred).toBe(true);
  });

  await test.step("byte overflow uses a fixed cap-plus-one sentinel without encoding the rejected text", async () => {
    const text = "😀".repeat(Math.floor(maxBytes / 4) + 1);
    expect(text.length).toBeLessThan(maxBytes);
    expect(Buffer.byteLength(text)).toBeGreaterThan(maxBytes);
    await setExactCodeUnits(page, text);
    await page.locator("#check").click();
    await expect(page.locator("#result-title")).toHaveText("Document too large");
    const audit = await page.evaluate(() => globalThis.__adapterAudit);
    expect(audit.encodes).toEqual([]);
    expect(audit.messages).toEqual([
      { kind: "load", isBytes: true, byteLength: maxBytes + 1, transferred: true, detached: true },
    ]);
  });
});

test("invalid UTF-8 local file is refused without replacement decoding", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "invalid.sql",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0x80]),
  });
  await expect(page.locator("#ddl")).toHaveValue("");
  await expect(page.locator("#result-title")).toHaveText("Invalid UTF-8 document");
  await expect(page.locator("#report")).toHaveText("");
});
