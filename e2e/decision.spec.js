import { expect, test } from "@playwright/test";

async function analyze(page, sql) {
  await page.goto("/");
  await page.locator("#ddl").fill(sql);
  await page.locator("#check").click();
  await expect(page.locator("#report-view")).toBeVisible();
}

test("decision shows partial DML coverage and distinct ordinary defaults and database generation", async ({
  page,
}) => {
  await analyze(
    page,
    `CREATE TABLE public.t (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    required text NOT NULL, optional text, status text DEFAULT 'active',
    computed numeric GENERATED ALWAYS AS (1) STORED
  ); INSERT INTO public.t (required) VALUES ('example');`,
  );
  await expect(page.locator('[data-decision-section="DECISION"]')).toContainText(
    "STATIC ANALYSIS INCOMPLETE",
  );
  await expect(page.locator('[data-decision-section="COVERAGE"]')).toContainText(
    "PARTIAL STATIC COVERAGE",
  );
  const contract = page.locator('[data-decision-section="IMPORT CONTRACT"]');
  for (const text of [
    "Required from source: required",
    "Optional source values: optional",
    "Database default available: status",
    "Database identity: id",
    "Database computed: computed",
    "explicit source values are not prohibited",
  ]) {
    await expect(contract).toContainText(text);
  }
  await expect(page.locator("#technical-evidence")).not.toHaveAttribute("open", "");
  await page.locator("#technical-evidence > summary").click();
  await expect(page.locator('[data-section="STATEMENT ACCOUNTING"]')).toContainText(
    "INSERT: UNSUPPORTED_DOCUMENT_STATEMENT",
  );
  await expect(page.locator('[data-section="NOT EVALUATED"]')).toContainText(
    "INSERT — unsupported document statement; not evaluated",
  );
});

test("decision names blocked fields and keeps source mutation provisional", async ({ page }) => {
  await analyze(
    page,
    `CREATE TABLE public.t (id integer PRIMARY KEY, "bad name" text, payload jsonb);
ALTER TABLE public.t ADD COLUMN later text NOT NULL;`,
  );
  const contract = page.locator('[data-decision-section="IMPORT CONTRACT"]');
  await expect(contract).toContainText('Blocked by profile: "bad name", payload');
  await expect(contract).toContainText("Provisional: id");
  await expect(page.locator('[data-decision-section="PRIMARY FINDINGS"]')).toContainText(
    "payload (jsonb)",
  );
  await expect(page.locator('[data-decision-section="BOTTOM LINE"]')).toContainText("provisional");
  await expect(contract).not.toContainText("Required from source: id");
});

test("technical evidence names enum, unique, check, policy and trigger declarations", async ({
  page,
}) => {
  await analyze(
    page,
    `CREATE TYPE public.state AS ENUM ('new', 'done');
CREATE TABLE public.t (id integer PRIMARY KEY, state public.state, amount numeric CONSTRAINT positive CHECK (amount > 0), code text CONSTRAINT code_unique UNIQUE);
ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
CREATE POLICY allow_insert ON public.t FOR INSERT TO authenticated WITH CHECK (true);
CREATE TRIGGER guard BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.guard();`,
  );
  await page.locator("#technical-evidence > summary").click();
  const detail = page.locator('[data-section="STRUCTURAL DETAILS"]');
  for (const text of [
    'ENUM state → public.state: "new", "done"',
    "UNIQUE code_unique: (code)",
    "CHECK positive:",
    "Expression semantics not evaluated",
    "POLICY allow_insert: INSERT",
    "roles authenticated",
    "TRIGGER guard: BEFORE INSERT",
    "Function body/effects not evaluated",
  ]) {
    await expect(detail).toContainText(text);
  }
  await page.locator("#reset").click();
  await expect(page.locator("#report-view")).toBeHidden();
  await expect(page.locator("#report")).toHaveText("");
});
