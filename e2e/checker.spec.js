import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const cli = fileURLToPath(new URL("../cli/pg-import-check.mjs", import.meta.url));
const corpus = JSON.parse(
  readFileSync(new URL("../spec/public-profile-cases.v4.json", import.meta.url), "utf8"),
);
const simple = "CREATE TABLE public.contacts (id integer PRIMARY KEY, email text NOT NULL);";

function cliReport(ddl) {
  const result = spawnSync(process.execPath, [cli], {
    input: Buffer.from(ddl, "utf8"),
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect([0, 2]).toContain(result.status);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.at(-1)).toBe(10);
  return result.stdout;
}

async function check(page, ddl) {
  const expected = cliReport(ddl);
  if (ddl.includes(String.fromCharCode(27))) {
    // Firefox's simulated typing strips ESC before the app receives it. Assign
    // exact hostile bytes at the DOM boundary to exercise the actual evaluator.
    await page.locator("#ddl").evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, ddl);
  } else {
    await page.locator("#ddl").fill(ddl);
  }
  // Textarea newline normalization must not silently change the oracle input.
  expect(await page.locator("#ddl").inputValue()).toBe(ddl);
  await page.locator("#check").click();
  await expect.poll(() => page.locator("#report").textContent()).toBe(expected.toString("utf8"));
  await expect(page.locator("#copy")).toBeEnabled();
  expect(Buffer.from(await page.locator("#report").textContent(), "utf8")).toEqual(expected);
  return expected.toString("utf8");
}

test("first load explains local analysis and offers a labelled plain textarea", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const ddl = page.locator("#ddl");
  await expect(ddl).toHaveValue("");
  await expect(ddl).toHaveAccessibleName(/DDL|SQL|schema/i);
  expect(await ddl.evaluate((element) => element.tagName)).toBe("TEXTAREA");
  for (const id of ["check", "example", "reset", "copy"]) {
    await expect(page.locator(`#${id}`)).toHaveRole("button");
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(/\S/);
  }
  await expect(page.locator("#copy")).toBeDisabled();
  await expect(page.locator("body")).toContainText(/locally.*browser|browser.*locally/i);
  await expect(page.locator("body")).toContainText(
    /not uploaded|never uploaded|never leaves|not sent/i,
  );
  await expect(page.locator("body")).toContainText("importflow-envelope-v4");
  await expect(page.locator("time[datetime='2026-09-09']")).toBeVisible();
  await expect(page.locator("#status")).toHaveAttribute("aria-live", /polite|assertive/);
});

test("example, repeated checks, edits, and reset do not retain stale output", async ({ page }) => {
  await page.goto("/");
  await page.locator("#example").click();
  const example = await page.locator("#ddl").inputValue();
  expect(example).toMatch(/CREATE TABLE/i);
  await check(page, example);
  await check(page, example);
  await page.locator("#ddl").fill("SELECT 1;");
  await expect(page.locator("#copy")).toBeDisabled();
  await expect(page.locator("#report")).toHaveText("");
  await check(page, "SELECT 1;");
  await page.locator("#reset").click();
  await expect(page.locator("#ddl")).toHaveValue("");
  await expect(page.locator("#report")).toHaveText("");
  await expect(page.locator("#copy")).toBeDisabled();
  await check(page, simple);
});

for (const outcome of [
  "no_structural_conflict_observed",
  "outside_envelope_observed",
  "more_evidence_required",
  "refused",
]) {
  test(`${outcome}: exact CLI report bytes and distinct result presentation`, async ({ page }) => {
    const item = corpus.cases.find((entry) => entry.expected_result === outcome);
    expect(item).toBeDefined();
    await page.goto("/");
    const workers = [];
    page.on("worker", (worker) => workers.push(worker.url()));
    const report = await check(page, item.ddl);
    expect(report).toContain(
      outcome === "refused" ? "REFUSED: " : `TEXT-ONLY VERDICT: ${outcome}\n`,
    );
    await expect(page.locator("#result-title")).toBeVisible();
    const titles = {
      no_structural_conflict_observed: /no structural conflict/i,
      outside_envelope_observed: /structural conflict|outside.*profile/i,
      more_evidence_required: /more evidence|review required/i,
      refused: /refused|analysis unavailable/i,
    };
    await expect(page.locator("#result-title")).toHaveText(titles[outcome]);
    expect([...workers, ...page.workers().map((worker) => worker.url())]).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/worker-[A-Za-z0-9_-]+\.js$/)]),
    );
  });
}

test("all 56 conformance cases in one browser session match spawned CLI reports", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const columns = (additional) =>
    `CREATE TABLE public.t (id integer PRIMARY KEY, ${Array.from({ length: additional }, (_, i) => `c${i + 1} integer`).join(",")});`;
  const recipes = {
    columns_at_limit: () => columns(1599),
    columns_over_limit: () => columns(1600),
    constraint_limit: () =>
      `CREATE TABLE public.t (id integer PRIMARY KEY, ${Array.from({ length: 2048 }, (_, i) => `CONSTRAINT k${i} CHECK (id > 0)`).join(",")});`,
    enum_count_over: () =>
      `CREATE TYPE public.e AS ENUM (${Array.from({ length: 4097 }, (_, i) => `'${i}'`).join(",")}); CREATE TABLE public.t (id integer PRIMARY KEY, value public.e);`,
  };
  expect(Object.keys(recipes).sort()).toEqual(
    corpus.generated_boundaries.map((item) => item.id).sort(),
  );
  const cases = [
    ...corpus.cases,
    ...corpus.generated_boundaries.map((item) => ({ ...item, ddl: recipes[item.id]() })),
  ];
  expect(cases).toHaveLength(56);
  await page.goto("/");
  // Reuse a real page; each case still enters through the public UI and its worker.
  for (const item of cases) {
    await test.step(item.id, async () => {
      const report = await check(page, item.ddl);
      expect(report).toContain(
        item.expected_result === "refused"
          ? "REFUSED: "
          : `TEXT-ONLY VERDICT: ${item.expected_result}\n`,
      );
    });
  }
});

const hostileInputs = [
  [
    "HTML and quotes",
    'CREATE TABLE public."<img src=x onerror=globalThis.__xss=1>" (id integer PRIMARY KEY, "a""b<em>" text);',
  ],
  [
    "script identifier",
    'CREATE TABLE public."<script>globalThis.__xss=1</script>" (id integer PRIMARY KEY);',
  ],
  [
    "bidi and invisible Unicode",
    'CREATE TABLE public."a\u202eb\u2066c\u200bd\ufeff" (id integer PRIMARY KEY, "مدخل" text);',
  ],
  [
    "ANSI escape sequences",
    'CREATE TABLE public."a\u001b[31mred\u001b[0m" (id integer PRIMARY KEY);',
  ],
  ["hostile diagnostic", "<svg/onload=globalThis.__xss=1><script>globalThis.__xss=1</script>"],
  ["long diagnostic", "x".repeat(262_144)],
];
for (const [name, ddl] of hostileInputs) {
  test(`hostile input remains text: ${name}`, async ({ page }) => {
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.goto("/");
    const originalScripts = await page.locator("script").count();
    const report = await check(page, ddl);
    expect(await page.evaluate(() => globalThis.__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
    await expect(page.locator("#report *")).toHaveCount(0);
    await expect(page.locator("script")).toHaveCount(originalScripts);
    await expect(page.locator("[onerror], [onload], iframe, object, embed")).toHaveCount(0);
    expect(report).not.toMatch(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: assert hostile control characters never reach rendered reports
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u202e\u2066\ufeff]/u,
    );
    if (name === "long diagnostic") expect(report.length).toBeLessThan(2000);
  });
}

test("UTF-8 byte cap accepts exactly 262144 bytes and refuses one byte over", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const prefix = `${simple} /*`;
  const suffix = "*/";
  const paddingBytes = 262_144 - Buffer.byteLength(prefix + suffix);
  // Multibyte padding detects code-unit/UTF-8 size confusion in the UI adapter.
  const ddl =
    prefix + "é".repeat(Math.floor(paddingBytes / 2)) + " ".repeat(paddingBytes % 2) + suffix;
  expect(Buffer.byteLength(ddl)).toBe(262_144);
  expect(await check(page, ddl)).toContain("TEXT-ONLY VERDICT: no_structural_conflict_observed\n");
  expect(await check(page, `${ddl} `)).toContain("REFUSED: input_too_large\n");
  await check(page, simple);
});

test("keyboard can run a check and reset; controls and report fit the viewport", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#ddl").focus();
  await page.keyboard.insertText(simple);
  // Follow actual tab order rather than activating a button through evaluate().
  for (let step = 0; step < 15; step += 1) {
    if (await page.locator("#check").evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press("Tab");
  }
  await expect(page.locator("#check")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.locator("#report").textContent())
    .toBe(cliReport(simple).toString("utf8"));
  for (const id of ["ddl", "check", "reset", "copy", "report"]) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize().width + 1,
  );
  await page.locator("#reset").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#ddl")).toHaveValue("");
  await expect(page.locator("#copy")).toBeDisabled();
});

test("Chromium copies exact report bytes only after the user clicks Copy", async ({
  page,
  context,
  browserName,
  baseURL,
}) => {
  test.skip(
    browserName !== "chromium",
    "Clipboard permission names differ across browser engines.",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL).origin,
  });
  await page.goto("/");
  const sentinel = "clipboard unchanged before explicit copy";
  await page.evaluate((value) => navigator.clipboard.writeText(value), sentinel);
  for (const ddl of [simple, "SELECT 1;"]) {
    const previous = await page.evaluate(() => navigator.clipboard.readText());
    const report = await check(page, ddl);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(previous);
    await page.locator("#copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(report);
    expect(Buffer.from(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(
      cliReport(ddl),
    );
  }
});

test("clipboard denial offers a safe exact plain-text copy fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("clipboard denied");
        },
      },
    });
  });
  await page.goto("/");
  const expected = await check(page, simple);
  await page.locator("#copy").click();
  await expect(page.locator("#status")).toContainText("Report selected");
  const copied = await page.evaluate(() => {
    // Firefox makes synthetic ClipboardEvent data read-only. A test-owned data
    // store observes exactly what the app writes; real clipboard is tested above.
    const clipboard = new Map();
    const clipboardData = {
      setData: (type, value) => clipboard.set(type, value),
      getData: (type) => clipboard.get(type) || "",
    };
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    document.querySelector("#report").dispatchEvent(event);
    return {
      text: clipboardData.getData("text/plain"),
      html: clipboardData.getData("text/html"),
      prevented: event.defaultPrevented,
    };
  });
  expect(copied).toEqual({ text: expected, html: "", prevented: true });
});
