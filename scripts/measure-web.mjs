import { chromium } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { gzipSync, brotliCompressSync } from "node:zlib";
const baseURL = process.env.BASE_URL || "http://127.0.0.1:4173";
const files = await readdir("dist/web");
const assets = await Promise.all(
  files.map(async (name) => {
    const bytes = await readFile(`dist/web/${name}`);
    return {
      name,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      brotliBytes: brotliCompressSync(bytes).length,
    };
  }),
);
const browser = await chromium.launch();
const measurements = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      globalThis.measurements = { longTasks: [], frames: [], workerLifetimes: [] };
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          const started = performance.now();
          super(...args);
          this.addEventListener("message", () => {
            globalThis.measurements.workerLifetimes.push(performance.now() - started);
          });
        }
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          globalThis.measurements.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
      let previous = performance.now();
      function frame(now) {
        globalThis.measurements.frames.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    await page.goto(baseURL);
    await page.locator("#ddl").waitFor();
    const startup = await page.evaluate(() => ({
      navigation: performance.getEntriesByType("navigation")[0].toJSON(),
      paint: performance.getEntriesByType("paint").map((p) => p.toJSON()),
    }));
    const times = [];
    const ddl =
      `CREATE TABLE public.t(id integer PRIMARY KEY,${Array.from({ length: 1500 }, (_, i) => `c${i} text`).join(",")});`.padEnd(
        262_144,
        " ",
      );
    await page.locator("#ddl").fill(ddl);
    // Separate paste/layout costs from the period in which evaluation runs.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.evaluate(() => {
      globalThis.measurements.longTasks = [];
      globalThis.measurements.frames = [];
    });
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      await page.locator("#check").click();
      await page.locator("#copy").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#copy").disabled);
      times.push(performance.now() - start);
    }
    const responsiveness = await page.evaluate(() => ({
      ...globalThis.measurements,
      resources: performance
        .getEntriesByType("resource")
        .map((r) => ({ name: r.name, duration: r.duration, transferSize: r.transferSize })),
    }));
    const frames = responsiveness.frames.sort((a, b) => a - b);
    measurements.push({
      viewport,
      startup,
      workerAndRenderMs: times,
      workerStartupAndEvaluationMs: responsiveness.workerLifetimes,
      frameP95Ms: frames[Math.floor(frames.length * 0.95)],
      frameMaxMs: frames.at(-1),
      longTasksMs: responsiveness.longTasks,
      resources: responsiveness.resources,
    });
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      baseURL,
      assets,
      measurements,
      note: "Chromium local navigation/resource/paint/long-task and animation-frame measurements. Worker+render times include browser automation and fresh worker startup; not isolated CPU timings or Lighthouse scores. No network/CPU throttling; mobile viewport is layout emulation only.",
    },
    null,
    2,
  ),
);
