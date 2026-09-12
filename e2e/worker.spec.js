import { expect, test } from "@playwright/test";

const ddl = "CREATE TABLE public.t (id uuid PRIMARY KEY, value text);";
const errorMessage =
  "pg-import-check could not complete the local analysis because of an internal error.";

async function installFault(page, mode) {
  await page.addInitScript(
    ({ mode }) => {
      const NativeWorker = globalThis.Worker;
      globalThis.__workerFaultAudit = { constructed: 0, terminated: 0 };
      globalThis.Worker = class {
        constructor(...args) {
          globalThis.__workerFaultAudit.constructed += 1;
          // biome-ignore lint/correctness/noConstructorReturn: retry delegates to the genuine Worker
          if (globalThis.__workerFaultAudit.constructed > 1) return new NativeWorker(...args);
          if (mode === "constructor")
            throw new Error("PRIVATE_WORKER_STACK_SENTINEL constructor defect");
          globalThis.__failedWorker = this;
        }
        postMessage(message) {
          if (mode === "postMessage")
            throw new Error("PRIVATE_WORKER_STACK_SENTINEL transport defect");
          if (mode === "delay") return;
          queueMicrotask(() => {
            if (mode === "error") {
              this.onerror?.(
                new ErrorEvent("error", {
                  message: "PRIVATE_WORKER_STACK_SENTINEL",
                  error: new Error("PRIVATE_WORKER_STACK_SENTINEL"),
                }),
              );
            } else if (mode === "messageerror") {
              this.onmessageerror?.(new MessageEvent("messageerror"));
            } else {
              this.onmessage?.(
                new MessageEvent("message", {
                  data: {
                    requestId: message.requestId,
                    kind: "report",
                    outcome: "outside_envelope_observed",
                    report: "PRIVATE_WORKER_STACK_SENTINEL",
                  },
                }),
              );
            }
          });
        }
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
  await expect(page.locator("#result-title")).toHaveText("Analysis could not complete");
  await expect(page.locator("#report")).toHaveText("");
  await expect(page.locator("#copy")).toBeDisabled();
  await expect(page.locator("#discovery")).toBeHidden();
  await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#result")).toHaveAttribute("data-outcome", "error");
  await expect(page.locator("body")).not.toContainText("PRIVATE_WORKER_STACK_SENTINEL");
}

for (const mode of ["constructor", "postMessage", "error", "messageerror", "malformed"]) {
  test(`worker ${mode} failure is safe and the next discovery recovers`, async ({ page }) => {
    await installFault(page, mode);
    await page.goto("/");
    await page.locator("#ddl").fill(ddl);
    await page.locator("#check").click();
    await expectSafeError(page);
    await page.locator("#check").click();
    await expect(page.locator("#discovery")).toBeVisible();
    await expect(page.locator("#report")).toContainText("public.t");
    expect(await page.evaluate(() => globalThis.__workerFaultAudit.constructed)).toBe(2);
  });
}

test("unresponsive discovery worker times out safely and can be retried", async ({ page }) => {
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
  await expect(page.locator("#report")).toContainText("public.t");
});

test("editing or reset cancels delayed work and stale fake-worker messages cannot restore it", async ({
  page,
}) => {
  await installFault(page, "delay");
  await page.goto("/");
  await page.locator("#ddl").fill(ddl);
  await page.locator("#check").click();
  await expect(page.locator("#result")).toHaveAttribute("aria-busy", "true");
  await page.locator("#reset").click();
  await expect(page.locator("#ddl")).toHaveValue("");
  await page.evaluate(() => {
    globalThis.__failedWorker.onmessage?.(
      new MessageEvent("message", {
        data: {
          requestId: 1,
          kind: "discovered",
          byteLength: 1,
          statementCount: 1,
          targets: [
            {
              key: "stale",
              displayName: "public.stale",
              scope: "public",
              hasBaseDeclaration: true,
              declarationCount: 1,
              sourceLine: 1,
            },
          ],
        },
      }),
    );
  });
  await expect(page.locator("#discovery")).toBeHidden();
  await expect(page.locator("body")).not.toContainText("public.stale");
  await page.locator("#ddl").fill(ddl);
  await page.locator("#check").click();
  await expect(page.locator("#report")).toContainText("public.t");
});

test("actual bundled worker rejects an invalid load message and recovers on retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    let first = true;
    globalThis.Worker = class extends NativeWorker {
      postMessage(message, transfer) {
        if (first) {
          first = false;
          super.postMessage({ ...message, bytes: "not bytes" });
        } else super.postMessage(message, transfer);
      }
    };
  });
  await page.goto("/");
  await page.locator("#ddl").fill(ddl);
  await page.locator("#check").click();
  await expectSafeError(page);
  await page.locator("#check").click();
  await expect(page.locator("#report")).toContainText("public.t");
});

test("token-dense input reaches the exact worker bound and refuses one token over", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const exact = `SELECT ${"x ".repeat(150_000 - 2)};`;
  await page.locator("#ddl").fill(exact);
  await page.locator("#check").click();
  await expect(page.locator("#result-title")).toHaveText("No table targets found");

  await page.locator("#ddl").fill(`SELECT ${"x ".repeat(150_000 - 1)};`);
  await page.locator("#check").click();
  await expect(page.locator("#result-title")).toHaveText("Document exceeds analysis limits");
  await expect(page.locator("#report")).toHaveText("");
});
