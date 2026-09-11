import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const cli = fileURLToPath(new URL("../cli/pg-import-check.mjs", import.meta.url));
const ddl = "CREATE TABLE public.t (id integer PRIMARY KEY, value text);";
const errorMessage = "pg-import-check could not complete the check because of an internal error.";

function reportFor(input) {
  const result = spawnSync(process.execPath, [cli], { input: Buffer.from(input), timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString("utf8");
}

async function installFault(page, mode) {
  await page.addInitScript(
    ({ mode }) => {
      const NativeWorker = globalThis.Worker;
      globalThis.__workerFaultAudit = { constructed: 0, terminated: 0 };
      globalThis.Worker = class {
        constructor(...args) {
          globalThis.__workerFaultAudit.constructed += 1;
          if (globalThis.__workerFaultAudit.constructed > 1) {
            // biome-ignore lint/correctness/noConstructorReturn: fault harness delegates retries to the genuine Worker
            return new NativeWorker(...args);
          }
          if (mode === "constructor")
            throw new Error("PRIVATE_WORKER_STACK_SENTINEL constructor defect");
          globalThis.__failedWorker = this;
        }
        postMessage() {
          if (mode === "postMessage")
            throw new Error("PRIVATE_WORKER_STACK_SENTINEL transport defect");
          if (mode === "delay") return;
          queueMicrotask(() => {
            if (mode === "error")
              this.onerror?.(
                new ErrorEvent("error", {
                  message: "PRIVATE_WORKER_STACK_SENTINEL",
                  error: new Error("PRIVATE_WORKER_STACK_SENTINEL"),
                }),
              );
            else if (mode === "messageerror")
              this.onmessageerror?.(new MessageEvent("messageerror"));
            else
              this.onmessage?.(
                new MessageEvent("message", {
                  data: {
                    kind: "report",
                    report:
                      "<script>PRIVATE_WORKER_STACK_SENTINEL</script>\nTEXT-ONLY VERDICT: outside_envelope_observed\n",
                  },
                }),
              );
          });
        }
        // Deliberately retain callbacks after terminate so cancellation tests can
        // deliver an already queued stale message even after a newer run succeeds.
        terminate() {
          globalThis.__workerFaultAudit.terminated += 1;
        }
      };
    },
    { mode },
  );
}

async function expectSafeError(page) {
  await expect(page.locator("#status")).toHaveText(errorMessage);
  await expect(page.locator("#result-title")).toHaveText("Check could not complete");
  await expect(page.locator("#report")).toHaveText("");
  await expect(page.locator("#copy")).toBeDisabled();
  await expect(page.locator("#check")).toBeEnabled();
  await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#result")).toHaveAttribute("data-outcome", "error");
  await expect(page.locator("body")).not.toContainText("PRIVATE_WORKER_STACK_SENTINEL");
}

for (const mode of ["constructor", "postMessage", "error", "messageerror", "malformed"]) {
  test(`worker ${mode} failure is a safe application error; next check starts a real worker`, async ({
    page,
  }) => {
    await installFault(page, mode);
    await page.goto("/");
    await page.locator("#ddl").fill(ddl);
    await page.locator("#check").click();
    await expectSafeError(page);
    await page.locator("#check").click();
    await expect.poll(() => page.locator("#report").textContent()).toBe(reportFor(ddl));
    await expect(page.locator("#result-title")).toHaveText("No structural conflict observed");
    expect(await page.evaluate(() => globalThis.__workerFaultAudit.constructed)).toBe(2);
  });
}

test("unresponsive worker times out safely and can be retried", async ({ page }) => {
  await installFault(page, "delay");
  await page.clock.install();
  await page.goto("/");
  await page.locator("#ddl").fill(ddl);
  await page.locator("#check").click();
  await expect(page.locator("#result")).toHaveAttribute("aria-busy", "true");
  await page.clock.fastForward(15_001);
  await expectSafeError(page);
  expect(await page.evaluate(() => globalThis.__workerFaultAudit.terminated)).toBe(1);
  await page.locator("#check").click();
  await expect.poll(() => page.locator("#report").textContent()).toBe(reportFor(ddl));
});

for (const action of ["reset", "edit", "restart"]) {
  test(`${action} stays responsive during delayed near-cap work and ignores stale results`, async ({
    page,
  }) => {
    await installFault(page, "delay");
    await page.goto("/");
    const nearCap = ddl + " /*" + "x".repeat(262_144 - ddl.length - 5) + "*/";
    expect(Buffer.byteLength(nearCap)).toBe(262_144);
    await page.locator("#ddl").fill(nearCap);
    await page.locator("#check").click();
    await expect(page.locator("#result")).toHaveAttribute("aria-busy", "true");
    // Main-thread keyboard work runs while the worker has not returned.
    await page.locator("#ddl").focus();
    await expect(page.locator("#ddl")).toBeFocused();
    if (action === "reset") {
      await page.locator("#reset").click();
      await expect(page.locator("#ddl")).toHaveValue("");
      await expect(page.locator("#report")).toHaveText("");
      await expect(page.locator("#copy")).toBeDisabled();
      await page.locator("#ddl").fill(ddl);
    } else if (action === "edit") {
      await page.locator("#ddl").fill(ddl);
      await expect(page.locator("#report")).toHaveText("");
      await expect(page.locator("#copy")).toBeDisabled();
    }
    // Restart also exercises the advertised keyboard shortcut while busy.
    await page.locator("#ddl").press("Control+Enter");
    const expected = reportFor(action === "restart" ? nearCap : ddl);
    await expect.poll(() => page.locator("#report").textContent()).toBe(expected);
    const stale = reportFor("CREATE TABLE other.stale (id integer PRIMARY KEY);");
    await page.evaluate((report) => {
      globalThis.__failedWorker.onmessage?.(
        new MessageEvent("message", { data: { kind: "report", report } }),
      );
      globalThis.__failedWorker.onerror?.(new ErrorEvent("error", { message: "stale failure" }));
      globalThis.__failedWorker.onmessageerror?.(new MessageEvent("messageerror"));
    }, stale);
    expect(await page.locator("#report").textContent()).toBe(expected);
    await expect(page.locator("#result-title")).toHaveText("No structural conflict observed");
    await expect(page.locator("#copy")).toBeEnabled();
    expect(await page.evaluate(() => globalThis.__workerFaultAudit.terminated)).toBe(1);
  });
}

test("actual bundled worker rejects an invalid message without a verdict", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    let first = true;
    globalThis.Worker = class extends NativeWorker {
      postMessage(message, transfer) {
        if (first) {
          first = false;
          super.postMessage({ kind: "check", bytes: "not bytes" });
        } else super.postMessage(message, transfer);
      }
    };
  });
  await page.goto("/");
  await page.locator("#ddl").fill(ddl);
  await page.locator("#check").click();
  await expectSafeError(page);
  await page.locator("#check").click();
  await expect.poll(() => page.locator("#report").textContent()).toBe(reportFor(ddl));
});
