#!/usr/bin/env node
import { runCli } from "./runner.mjs";

process.exitCode = await runCli({
  loadCheck: async () => (await import("../dist/src/index.js")).checkCompatibility,
});
