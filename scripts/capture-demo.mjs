// Capture the actual local application using only the adjacent synthetic fixture.
import { chromium } from "@playwright/test";
import { readFile, mkdir, rename } from "node:fs/promises";
const origin = process.env.BASE_URL || "http://127.0.0.1:4173";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("Capture requires a local preview.");
await mkdir("docs/demo", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  colorScheme: "light",
  reducedMotion: "reduce",
  recordVideo: { dir: "test-results/demo-capture", size: { width: 1280, height: 934 } },
});
const page = await context.newPage();
const video = page.video();
await page.goto(origin);
await page.waitForTimeout(2000);
await page
  .getByLabel("PostgreSQL migration / schema", { exact: true })
  .fill(await readFile("docs/demo/migration.sql", "utf8"));
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Discover tables" }).click();
await page.getByRole("button", { name: /public.contacts.*public profile candidate/ }).waitFor();
await page.waitForTimeout(3000);
await page.getByRole("button", { name: /public.contacts.*public profile candidate/ }).click();
await page.waitForFunction(() => !document.getElementById("copy").disabled);
await page.evaluate(() => {
  window.scrollTo(0, 0);
  document.getElementById("ddl").scrollTop = 0;
});
await page.screenshot({ path: "docs/demo/decision-report.png" });
await page.waitForTimeout(4000);
await page.locator("#technical-evidence").scrollIntoViewIfNeeded();
await page.locator("#technical-evidence > summary").click();
await page.waitForTimeout(4000);
await page.locator("#technical-evidence .report-section").first().scrollIntoViewIfNeeded();
await page.waitForTimeout(3000);
await context.close();
await rename(await video.path(), "docs/demo/walkthrough.webm");
await browser.close();
console.log(
  "Captured actual UI with synthetic input: docs/demo/decision-report.png and walkthrough.webm",
);
