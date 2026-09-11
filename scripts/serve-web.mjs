// Local preview only. Production serves dist/web as static assets.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const root = new URL("../dist/web/", import.meta.url);
const port = Number(process.env.PORT || 4173);
const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
const types = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};
createServer(async (request, response) => {
  let path;
  try {
    path = new URL(request.url, "http://localhost").pathname;
  } catch {
    response.writeHead(400, headers).end();
    return;
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  if (
    !/^(index\.html|[a-z]+-[A-Za-z0-9]+\.(js|css))$/.test(file) ||
    !["GET", "HEAD"].includes(request.method)
  ) {
    response.writeHead(404, headers).end();
    return;
  }
  try {
    const bytes = await readFile(new URL(file, root));
    const cache =
      file === "index.html"
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable";
    response.writeHead(200, {
      ...headers,
      "Content-Type": types[file.split(".").at(-1)],
      "Cache-Control": cache,
      "Content-Length": bytes.length,
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404, headers).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`Static preview: http://127.0.0.1:${port}`));
