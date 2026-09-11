import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const workerPath = /\/worker-[A-Za-z0-9_-]+\.js$/;
const cli = fileURLToPath(new URL("../cli/pg-import-check.mjs", import.meta.url));

// Runs before application code, in both the document and the actual bundled
// worker. Calls remain observable even when CSP prevents a request from existing.
function installEgressAudit() {
  const scope = globalThis;
  const events = [];
  scope.__egressAudit = events;
  const record = (api, args) => {
    events.push({
      api,
      args: Array.from(args, (value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }),
    });
  };
  const method = (object, key, label) => {
    if (!object || typeof object[key] !== "function") return;
    const original = object[key];
    object[key] = function (...args) {
      record(label, args);
      return Reflect.apply(original, this, args);
    };
  };
  method(scope, "fetch", "fetch");
  method(scope.XMLHttpRequest?.prototype, "open", "XHR.open");
  method(scope.XMLHttpRequest?.prototype, "send", "XHR.send");
  method(scope.navigator, "sendBeacon", "beacon");
  method(scope.WebSocket?.prototype, "send", "WebSocket.send");
  for (const key of ["WebSocket", "EventSource", "SharedWorker"]) {
    if (typeof scope[key] === "function") {
      scope[key] = new Proxy(scope[key], {
        construct(target, args, newTarget) {
          record(key, args);
          return Reflect.construct(target, args, newTarget);
        },
      });
    }
  }
  method(scope.indexedDB, "open", "indexedDB.open");
  method(scope.indexedDB, "deleteDatabase", "indexedDB.deleteDatabase");
  method(scope.caches, "open", "caches.open");
  method(scope.caches, "delete", "caches.delete");
  for (const name of ["log", "info", "warn", "error", "debug", "trace", "table", "dir"]) {
    method(scope.console, name, `console.${name}`);
  }
  if (typeof document === "undefined") return;

  for (const name of ["localStorage", "sessionStorage"]) {
    const storage = scope[name];
    const proxy = new Proxy(storage, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          if (["setItem", "removeItem", "clear"].includes(key)) record(`${name}.${key}`, args);
          return Reflect.apply(value, target, args);
        };
      },
      set(target, key, value) {
        record(`${name}.property`, [key, value]);
        return Reflect.set(target, key, value, target);
      },
      deleteProperty(target, key) {
        record(`${name}.delete`, [key]);
        return Reflect.deleteProperty(target, key);
      },
    });
    Object.defineProperty(scope, name, { configurable: true, get: () => proxy });
  }
  let prototype = document;
  while (prototype && !Object.getOwnPropertyDescriptor(prototype, "cookie"))
    prototype = Object.getPrototypeOf(prototype);
  const cookie = prototype && Object.getOwnPropertyDescriptor(prototype, "cookie");
  if (cookie?.set) {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookie.get.call(document),
      set: (value) => {
        record("cookie", [value]);
        cookie.set.call(document, value);
      },
    });
  }
  method(scope, "open", "window.open");
  method(scope.history, "pushState", "history.pushState");
  method(scope.history, "replaceState", "history.replaceState");
  method(scope.HTMLFormElement?.prototype, "submit", "form.submit");
  // A prevented local submit is the normal Check action. A real submission is
  // forbidden; evaluate cancellation after all application listeners have run.
  document.addEventListener(
    "submit",
    (event) => {
      setTimeout(() => {
        if (!event.defaultPrevented)
          record("form.navigation", [event.target.action, Array.from(new FormData(event.target))]);
      });
    },
    true,
  );
  for (const name of ["hashchange", "popstate", "beforeunload"]) {
    scope.addEventListener(name, () => record(`navigation.${name}`, [scope.location.href]));
  }
  const NativeWorker = scope.Worker;
  scope.__workerAudit = [];
  scope.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const entry = { url: String(args[0]), events: null };
      scope.__workerAudit.push(entry);
      this.addEventListener("message", (event) => {
        entry.events = event.data?.__testEgressAudit ?? null;
      });
    }
  };
}

test("canary DDL never reaches egress APIs, URLs, storage, cookies, console, or worker network", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const canary = "SCHEMA_CANARY_8f29d6b4_秘密";
  const ddl = `CREATE TABLE public."${canary}" (id integer PRIMARY KEY, "${canary}_column" text);`;
  const oracle = spawnSync(process.execPath, [cli], { input: Buffer.from(ddl), timeout: 15_000 });
  expect(oracle.error).toBeUndefined();
  expect(oracle.status).toBe(0);
  expect(oracle.stderr.toString()).toBe("");
  const expected = oracle.stdout.toString("utf8");
  const origin = new URL(baseURL).origin;
  const requests = [];
  const workerRequests = [];
  const consoles = [];
  const navigations = [];
  const webSockets = [];
  const popups = [];
  const violations = [];
  let loaded = false;
  context.on("request", (request) => {
    const entry = {
      url: request.url(),
      method: request.method(),
      body: request.postData(),
      afterLoad: loaded,
    };
    requests.push(entry);
    if (request.serviceWorker()) violations.push("service worker request");
  });
  page.on("request", (request) =>
    workerRequests.push({ url: request.url(), body: request.postData() }),
  );
  page.on("console", (message) => consoles.push(message.text()));
  page.on("websocket", (socket) => webSockets.push(socket.url()));
  page.on("popup", (popup) => popups.push(popup.url()));
  page.on("framenavigated", (frame) => {
    if (loaded) navigations.push(frame.url());
  });
  await context.routeWebSocket(/.*/, (socket) => {
    webSockets.push(socket.url());
    socket.close();
  });
  await context.addInitScript(installEgressAudit);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isWorker = workerPath.test(url.pathname);
    const bootAsset =
      url.pathname === "/" || /^\/[a-z]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname);
    if (
      url.origin !== origin ||
      url.search ||
      request.method() !== "GET" ||
      request.postData() !== null ||
      (loaded ? !isWorker : !bootAsset)
    ) {
      violations.push({ url: request.url(), method: request.method(), body: request.postData() });
      await route.abort();
      return;
    }
    if (!isWorker) {
      await route.continue();
      return;
    }
    // Prepend test instrumentation to the real hashed worker. Its original
    // evaluator and report stay intact; no application test hook is required.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const prefix = `(${installEgressAudit.toString()})();\nconst __originalPostMessage = self.postMessage.bind(self);\nself.postMessage = (data, ...rest) => __originalPostMessage({ ...data, __testEgressAudit: self.__egressAudit }, ...rest);\n`;
    await route.fulfill({ response, body: prefix + (await response.text()) });
  });
  await page.goto("/");
  await expect(page.locator("#check")).toBeEnabled();
  loaded = true;
  for (let run = 0; run < 3; run += 1) {
    await page.locator("#ddl").fill(ddl);
    await page.locator("#check").click();
    await expect.poll(() => page.locator("#report").textContent()).toBe(expected);
    expect(Buffer.from(await page.locator("#report").textContent())).toEqual(oracle.stdout);
    await page.locator("#reset").click();
  }
  // Two animation frames let queued DOM work run without an arbitrary sleep.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const audit = await page.evaluate(() => ({
    document: globalThis.__egressAudit,
    workers: globalThis.__workerAudit,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookies: document.cookie,
    url: location.href,
  }));
  expect(audit.document).toEqual([]);
  expect(audit.workers).toHaveLength(3);
  for (const worker of audit.workers) {
    expect(new URL(worker.url).origin).toBe(origin);
    expect(new URL(worker.url).pathname).toMatch(workerPath);
    // null would mean worker instrumentation never reached the actual response.
    expect(worker.events).toEqual([]);
  }
  expect(audit.local).toEqual([]);
  expect(audit.session).toEqual([]);
  expect(audit.cookies).toBe("");
  expect(await context.cookies()).toEqual([]);
  expect(context.serviceWorkers()).toEqual([]);
  expect(audit.url).toBe(new URL("/", baseURL).href);
  expect(violations).toEqual([]);
  expect(navigations).toEqual([]);
  expect(webSockets).toEqual([]);
  expect(popups).toEqual([]);
  // Firefox's native favicon loader may report the deliberate img-src denial.
  // This is a browser-internal message, not application console/telemetry. Keep
  // it in captured canary checks and allow only that exact non-schema URL case.
  for (const message of consoles) {
    expect(message).toContain("resource:///modules/FaviconLoader.sys.mjs");
    expect(message).toContain(`${origin}/favicon.ico`);
    expect(message).toContain("img-src 'none'");
  }
  const afterLoad = requests.filter((request) => request.afterLoad);
  expect(afterLoad.length).toBeGreaterThan(0);
  for (const request of afterLoad) {
    const url = new URL(request.url);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toMatch(workerPath);
    expect(url.search).toBe("");
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
  }
  const captured = JSON.stringify({ requests, workerRequests, consoles, navigations, webSockets });
  for (const token of [
    canary,
    encodeURIComponent(canary),
    Buffer.from(canary).toString("base64"),
  ]) {
    expect(captured).not.toContain(token);
  }
  // Reset and reload must not restore the schema from any browser persistence.
  loaded = false;
  await page.reload();
  await expect(page.locator("#ddl")).toHaveValue("");
  await expect(page.locator("#report")).toHaveText("");
});

test("served application enforces restrictive security headers", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response.headers();
  const directives = new Map(
    (headers["content-security-policy"] || "").split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
  for (const name of [
    "default-src",
    "connect-src",
    "object-src",
    "base-uri",
    "form-action",
    "frame-ancestors",
  ]) {
    expect(directives.get(name), name).toEqual(["'none'"]);
  }
  expect(directives.get("script-src")).toEqual(["'self'"]);
  expect(directives.get("worker-src")).toEqual(["'self'"]);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]?.toUpperCase()).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["permissions-policy"]).toContain("microphone=()");
});
