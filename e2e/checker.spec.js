import { expect, test } from "@playwright/test";

const multiTarget = `
CREATE TABLE public.review_target (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES public.parents(id) ON DELETE CASCADE,
  value character varying(120)
);
CREATE TABLE public.conflict_target (
  a uuid NOT NULL,
  b uuid NOT NULL
);
ALTER TABLE public.conflict_target
  ADD CONSTRAINT "conflict_pk" PRIMARY KEY (a, b);
CREATE TABLE public.mutation_target (id uuid PRIMARY KEY, value text);
ALTER TABLE public.mutation_target ADD COLUMN later text;
CREATE TABLE auth.accounts (id uuid PRIMARY KEY);
CREATE TABLE loose_target (id uuid PRIMARY KEY);
ALTER TABLE public.alter_only ADD CONSTRAINT alter_only_pkey PRIMARY KEY (id);
CREATE TABLE public."Mixed Name" (id uuid PRIMARY KEY);
`;

async function discover(page, sql = multiTarget) {
  await page.locator("#ddl").fill(sql);
  await page.locator("#check").click();
  await expect(page.locator("#discovery")).toBeVisible();
  await expect(page.locator("#targets .target-button").first()).toBeVisible();
}

function targetButton(page, identity) {
  return page
    .locator("#targets .target-button")
    .filter({ has: page.locator("code", { hasText: identity }) });
}

async function selectTarget(page, identity) {
  const button = targetButton(page, identity);
  await expect(button).toHaveCount(1);
  await button.click();
  await expect(page.locator("#report-view")).toBeVisible();
  await expect(page.locator("#report")).toContainText("PG IMPORT CHECK — MIGRATION v0.3");
}

test("first load explains local full-document analysis and file input", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#ddl")).toHaveValue("");
  await expect(page.locator("#file-input")).toHaveAttribute("type", "file");
  await expect(page.locator("body")).toContainText(/locally.*browser|browser.*locally/i);
  await expect(page.locator("body")).toContainText(/not uploaded|not sent|stays.*browser/i);
  await expect(page.locator("body")).toContainText("2,097,152 UTF-8 bytes");
  await expect(page.locator("body")).toContainText("importflow-envelope-v4");
  await expect(page.locator("#copy")).toBeDisabled();
});

test("discovers exact identities and switches targets on one retained worker", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__workerCount = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        globalThis.__workerCount += 1;
      }
    };
  });
  await page.goto("/");
  await discover(page);
  await expect(page.locator("#targets")).toContainText("public.review_target");
  await expect(page.locator("#targets")).toContainText("auth.accounts");
  await expect(page.locator("#targets")).toContainText("loose_target");
  await expect(page.locator("#targets")).toContainText('public."Mixed Name"');
  await expect(targetButton(page, "auth.accounts")).toContainText("outside public-schema profile");
  await expect(targetButton(page, "loose_target")).toContainText("schema unresolved");
  await expect(targetButton(page, "public.alter_only")).toContainText(
    "base declaration incomplete",
  );

  await selectTarget(page, "public.review_target");
  await expect(page.locator("#result-title")).toHaveText("More evidence required");
  await expect(page.locator('[data-section="OBSERVED"]')).toContainText("foreign keys: 1");
  await expect(page.locator('[data-section="OBSERVED"]')).toContainText("character varying");

  await selectTarget(page, "public.conflict_target");
  await expect(page.locator("#result-title")).toHaveText("Structural conflict observed");
  await expect(page.locator('[data-section="STRUCTURAL CONFLICTS"]')).toContainText(
    "composite_primary_key",
  );
  await expect(page.locator('[data-section="STRUCTURAL CONFLICTS"]')).toContainText(
    'constraint "conflict_pk"',
  );
  await expect(page.locator('[data-section="STRUCTURAL CONFLICTS"]')).toContainText(/line \d+/);
  expect(await page.evaluate(() => globalThis.__workerCount)).toBe(1);
});

test("NOT_EVALUATED mutation and ALTER-only incomplete evidence are explicit", async ({ page }) => {
  await page.goto("/");
  await discover(page);
  await selectTarget(page, "public.mutation_target");
  await expect(page.locator("#result-title")).toHaveText("More evidence required");
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText("add_column");
  await expect(page.locator('[data-section="OBSERVED"]')).toContainText(
    "partial evaluated evidence",
  );
  await expect(page.locator('[data-section="FILE-MAPPABLE / FILE AUTHORITY"]')).toContainText(
    "provisional from evaluated declarations",
  );
  await expect(page.locator('[data-section="BOTTOM LINE"]')).toContainText("NOT_EVALUATED");

  await selectTarget(page, "public.alter_only");
  await expect(page.locator('[data-section="OBSERVED"]')).toContainText(
    "complete evaluated table shape is unavailable",
  );
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText(
    "missing_base_declaration",
  );
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText(
    "associated_statement_without_base",
  );
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText(
    "constraint alter_only_pkey",
  );
});

test("target-local policy and trigger DROP lifecycles stay explicit", async ({ page }) => {
  await page.goto("/");
  await discover(
    page,
    `
      CREATE TABLE public.lifecycle_target (id uuid PRIMARY KEY);
      CREATE POLICY reader ON public.lifecycle_target USING (true);
      DROP POLICY IF EXISTS reader ON public.lifecycle_target;
      CREATE TRIGGER refresh_row BEFORE UPDATE ON public.lifecycle_target
        FOR EACH ROW EXECUTE FUNCTION public.refresh_row();
      DROP TRIGGER IF EXISTS refresh_row ON public.lifecycle_target;
    `,
  );
  await selectTarget(page, "public.lifecycle_target");
  await expect(page.locator("#result-title")).toHaveText("More evidence required");
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText("drop_policy");
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText("drop_trigger");
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText(
    "final policy set is not established",
  );
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText(
    "final trigger set is not established",
  );
  await expect(page.locator('[data-section="OBSERVED"]')).toContainText(
    "partial evaluated evidence",
  );
});

test("non-public and unqualified targets stay visible and are evaluated truthfully", async ({
  page,
}) => {
  await page.goto("/");
  await discover(page);
  await selectTarget(page, "auth.accounts");
  await expect(page.locator('[data-section="TARGET"]')).toContainText("auth.accounts");
  await expect(page.locator("#result-title")).toHaveText(
    /Structural conflict observed|More evidence required/,
  );

  await selectTarget(page, "loose_target");
  await expect(page.locator('[data-section="TARGET"]')).toContainText("loose_target");
  await expect(page.locator('[data-section="REQUIRES IMPORTFLOW REVIEW"]')).toContainText(
    /schema|qualification|review/i,
  );
});

test("local .sql file selection discovers tables without a server upload", async ({ page }) => {
  await page.goto("/");
  const sql =
    "CREATE TABLE public.file_one (id uuid PRIMARY KEY); CREATE TABLE public.file_two (id uuid PRIMARY KEY);";
  await page.locator("#file-input").setInputFiles({
    name: "local-schema.sql",
    mimeType: "text/plain",
    buffer: Buffer.from(sql),
  });
  await expect(page.locator("#file-state")).toContainText("local-schema.sql");
  await expect(page.locator("#ddl")).toHaveValue(sql);
  await expect(page.locator("#discovery")).toBeVisible();
  await expect(page.locator("#targets .target-button")).toHaveCount(2);
});

test("drag/drop local .sql file uses the same local discovery path", async ({ page }) => {
  await page.goto("/");
  const sql =
    "CREATE TABLE public.drop_one (id uuid PRIMARY KEY); CREATE TABLE public.drop_two (id uuid PRIMARY KEY);";
  await page.locator("#drop-zone").evaluate((element, value) => {
    const data = new DataTransfer();
    data.items.add(new File([value], "dropped.sql", { type: "text/plain" }));
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  }, sql);
  await expect(page.locator("#file-state")).toContainText("dropped.sql");
  await expect(page.locator("#targets .target-button")).toHaveCount(2);
});

test("failed new analysis clears stale target/report state and reset clears everything", async ({
  page,
}) => {
  await page.goto("/");
  await discover(page);
  await selectTarget(page, "public.review_target");
  await expect(page.locator("#copy")).toBeEnabled();

  await page.locator("#ddl").fill("CREATE FUNCTION x() RETURNS void AS $broken$ SELECT 1;");
  await expect(page.locator("#report")).toHaveText("");
  await expect(page.locator("#discovery")).toBeHidden();
  await page.locator("#check").click();
  await expect(page.locator("#result-title")).toHaveText("Malformed or unsupported document");
  await expect(page.locator("#copy")).toBeDisabled();
  await expect(page.locator("#report-view")).toBeHidden();

  await page.locator("#reset").click();
  await expect(page.locator("#ddl")).toHaveValue("");
  await expect(page.locator("#file-input")).toHaveValue("");
  await expect(page.locator("#report")).toHaveText("");
  await expect(page.locator("#discovery")).toBeHidden();
});

test("near 2 MiB document is admitted and one byte over is refused without stale output", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const base = "CREATE TABLE public.near_cap (id uuid PRIMARY KEY);";
  const prefix = `${base} /*`;
  const suffix = "*/";
  const exact = prefix + "x".repeat(2_097_152 - Buffer.byteLength(prefix + suffix)) + suffix;
  expect(Buffer.byteLength(exact)).toBe(2_097_152);
  await page.locator("#ddl").fill(exact);
  await page.locator("#check").click();
  await expect(page.locator("#result-title")).toHaveText(
    /No structural conflict observed|More evidence required/,
  );
  await expect(page.locator("#report")).toContainText("public.near_cap");

  await page.locator("#ddl").evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, `${exact}x`);
  await page.locator("#check").click();
  await expect(page.locator("#result-title")).toHaveText("Document too large");
  await expect(page.locator("#report")).toHaveText("");
});

test("malicious identifiers remain text and unsafe bidi identity is refused before rendering", async ({
  page,
}) => {
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto("/");
  const xss = 'CREATE TABLE public."x<script>globalThis.__xss=1</script>" (id uuid PRIMARY KEY);';
  await page.locator("#ddl").fill(xss);
  await page.locator("#check").click();
  await expect(page.locator("#discovery")).toBeVisible();
  await expect(page.locator("#targets")).toContainText("<script>");
  await expect(page.locator("#report-view")).toBeVisible();
  expect(await page.evaluate(() => globalThis.__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  await expect(page.locator("#report-view script, #targets script")).toHaveCount(0);

  const bidi = 'CREATE TABLE public."x\u202E" (id uuid PRIMARY KEY);';
  await page.locator("#ddl").fill(bidi);
  await page.locator("#check").click();
  await expect(page.locator("#result-title")).toHaveText("Malformed or unsupported document");
  await expect(page.locator("#discovery")).toBeHidden();
});

test("report exposes the decision layer above expandable deterministic evidence", async ({
  page,
}) => {
  await page.goto("/");
  await discover(page);
  await selectTarget(page, "public.review_target");
  for (const heading of [
    "DECISION",
    "TARGET",
    "COVERAGE",
    "IMPORT CONTRACT",
    "PRIMARY FINDINGS",
    "DATABASE BEHAVIOR",
    "NEXT REVIEW",
    "BOTTOM LINE",
  ]) {
    await expect(page.locator(`[data-decision-section="${heading}"]`)).toBeVisible();
  }
  await expect(page.locator("#technical-evidence")).not.toHaveAttribute("open", "");
  await page.locator("#technical-evidence > summary").click();
  for (const heading of [
    "TARGET",
    "RESULT",
    "OBSERVED",
    "FILE-MAPPABLE / FILE AUTHORITY",
    "DATABASE / SYSTEM CONTROLLED",
    "STRUCTURAL CONFLICTS",
    "NOT EVALUATED",
    "REQUIRES IMPORTFLOW REVIEW",
    "BOTTOM LINE",
  ]) {
    await expect(
      page.locator(`.report-section[data-section=${JSON.stringify(heading)}]`),
    ).toBeVisible();
  }
  await expect(page.locator("#raw-report-details")).toBeVisible();
});

test("Chromium copies exact raw report only after explicit copy", async ({
  page,
  context,
  browserName,
  baseURL,
}) => {
  test.skip(browserName !== "chromium", "Clipboard permission is verified on Chromium.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL).origin,
  });
  await page.goto("/");
  await discover(page);
  await selectTarget(page, "public.review_target");
  const expected = await page.locator("#report").textContent();
  const sentinel = "unchanged-before-copy";
  await page.evaluate((value) => navigator.clipboard.writeText(value), sentinel);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
  await page.locator("#copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
});

test("controls and target/report content fit the mobile viewport", async ({ page }) => {
  await page.goto("/");
  await discover(page);
  await selectTarget(page, "public.review_target");
  for (const id of ["ddl", "check", "reset", "copy", "result"]) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize().width + 1,
  );
});
