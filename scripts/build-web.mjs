import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const outdir = "dist/web";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// Keep redistribution notices attached to the actual downloaded bundles.
const license = await readFile("LICENSE", "utf8");
const notice = await readFile("NOTICE", "utf8");
if (license.includes("*/") || notice.includes("*/")) throw new Error("Unsafe license comment");
const common = {
  banner: { js: `/*!\n${license}\n${notice}*/` },
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  legalComments: "none",
  metafile: true,
  outdir,
  entryNames: "[name]-[hash]",
};
const worker = await build({ ...common, entryPoints: { worker: "web/worker.js" } });
const workerFile = Object.keys(worker.metafile.outputs).find((p) => p.endsWith(".js"));
if (!workerFile) throw new Error("Worker output missing");
const app = await build({
  ...common,
  stdin: {
    contents: (await readFile("web/app.js", "utf8")).replaceAll(
      "__WORKER_URL__",
      `./${basename(workerFile)}`,
    ),
    resolveDir: resolve("web"),
    sourcefile: "app.js",
  },
});
const appFile = Object.keys(app.metafile.outputs).find((p) => p.endsWith(".js"));
if (!appFile) throw new Error("Application output missing");
const css = await readFile("web/style.css");
const cssFile = `style-${createHash("sha256").update(css).digest("hex").slice(0, 12)}.css`;
await writeFile(`${outdir}/${cssFile}`, css);
const html = (await readFile("web/index.html", "utf8"))
  .replaceAll("__APP_JS__", `/${basename(appFile)}`)
  .replaceAll("__STYLE_CSS__", `/${cssFile}`);
if (/__[A-Z_]+__/.test(html)) throw new Error("Unresolved HTML build placeholder");
await writeFile(`${outdir}/index.html`, html);
await writeFile(
  "dist/web-metafile.json",
  `${JSON.stringify({ worker: worker.metafile, app: app.metafile }, null, 2)}\n`,
);
await copyFile("docs/demo/social.png", `${outdir}/social.png`);
await writeFile(`${outdir}/robots.txt`, "User-agent: *\nAllow: /\n");
console.log(`Static application built in ${outdir}; no server functions or source maps.`);
