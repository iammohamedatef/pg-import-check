import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const packageJson = await readJson(new URL("../package.json", import.meta.url));
const packageLock = await readJson(new URL("../package-lock.json", import.meta.url));

assert.equal(packageJson.private, true, "package.json must remain private");

assert.ok(
  typeof packageJson.scripts === "object" &&
    packageJson.scripts !== null &&
    !Array.isArray(packageJson.scripts),
  "package.json scripts must be an object",
);

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  assert.equal(
    Object.keys(packageJson[field] ?? {}).length,
    0,
    `package.json ${field} must remain absent or empty`,
  );
}

for (const field of ["exports", "main", "types", "publishConfig"]) {
  assert.equal(field in packageJson, false, `package.json ${field} must remain absent`);
}

for (const script of [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]) {
  assert.equal(
    script in packageJson.scripts,
    false,
    `package.json script ${script} must remain absent`,
  );
}

assert.deepEqual(packageJson.bin, { "pg-import-check": "cli/pg-import-check.mjs" });
assert.equal(packageJson.license, "MIT");
assert.ok(Array.isArray(packageJson.files) && packageJson.files.length > 0);
for (const path of packageJson.files) {
  assert.equal(typeof path, "string");
  assert.ok(!path.includes("*") && !path.includes("..") && !path.startsWith("/"));
  assert.ok(!/^(audit|publication|docs\/history|docs\/evidence)\//.test(path));
  assert.ok(!/^test\/fixtures\//.test(path));
}
assert.ok(packageJson.files.includes("LICENSE"));
assert.ok(packageJson.files.includes("NOTICE"));
assert.ok(packageJson.files.includes("UNICODE-LICENSE.txt"));

const lockRoot = packageLock.packages?.[""];
assert.ok(lockRoot, "package-lock.json must contain a root package entry");
assert.equal(packageLock.name, packageJson.name, "package-lock.json name must match package.json");
assert.equal(
  packageLock.version,
  packageJson.version,
  "package-lock.json version must match package.json",
);
assert.equal(lockRoot.name, packageJson.name, "lockfile root name must match package.json");
assert.equal(
  lockRoot.version,
  packageJson.version,
  "lockfile root version must match package.json",
);

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  assert.equal(
    Object.keys(lockRoot[field] ?? {}).length,
    0,
    `lockfile root ${field} must remain absent or empty`,
  );
}

console.log(
  "Package safety verified: private package, zero runtime dependencies, source-only allowlist, reviewed stdin CLI entry point, aligned lockfile root.",
);
