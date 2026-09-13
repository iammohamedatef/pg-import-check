import { test, expect } from "@playwright/test";
const input = `CREATE TABLE public.contacts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL); CREATE TABLE public.teams(id bigint PRIMARY KEY);`;
test("complete report precedes an optional link with no technical payload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#commercial-bridge")).toBeHidden();
  await page.locator("#ddl").fill(input);
  await page.locator("#check").click();
  await page.getByRole("button", { name: /public.contacts.*public profile candidate/ }).click();
  await expect(page.locator("#copy")).toBeEnabled();
  await expect(page.locator("#report-view")).toBeVisible();
  await expect(page.locator("#commercial-bridge")).toBeVisible();
  const href = await page.locator("#bridge-link").getAttribute("href");
  expect(href).toBe("https://importflow.dev/design-partner");
  expect(await page.locator("#bridge-link").getAttribute("rel")).toContain("noreferrer");
  await expect(page.locator("#commercial-bridge")).toContainText(
    "Your SQL and report are not sent",
  );
  expect(
    await page.evaluate(
      () =>
        document
          .getElementById("raw-report-details")
          .compareDocumentPosition(document.getElementById("commercial-bridge")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  await page.locator("#ddl").fill("CREATE TABLE public.changed(id bigint);");
  await expect(page.locator("#commercial-bridge")).toBeHidden();
});
test("profile conflict uses scope-first continuation", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("#ddl")
    .fill("CREATE TABLE public.events(id bigint PRIMARY KEY, payload jsonb);");
  await page.locator("#check").click();
  await expect(page.locator("#copy")).toBeEnabled();
  await expect(page.locator("#bridge-title")).toContainText(
    "conflict with the dated Alpha profile",
  );
  await expect(page.locator("#bridge-price")).toBeHidden();
  await expect(page.locator("#bridge-link")).toHaveText("See the current pilot scope ↗");
});
test("320px input and expanded report stay within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Try an example" })).toBeVisible();
  const upload = await page.locator(".file-button").boundingBox();
  expect(upload.y + upload.height).toBeLessThanOrEqual(568);
  await page.locator("#ddl").fill(input);
  await page.locator("#check").click();
  await page.getByRole("button", { name: /public.contacts.*public profile candidate/ }).click();
  await expect(page.locator("#copy")).toBeEnabled();
  await page.locator("#technical-evidence > summary").click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
});
