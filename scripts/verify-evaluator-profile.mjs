import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PROFILE, REASON_MESSAGES } from "../src/public-profile.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const profile = JSON.parse(await read("spec/importflow-envelope.v4.json"));
const provenance = JSON.parse(await read("spec/provenance.json"));
const templates = JSON.parse(await read("spec/reason-templates.v4.json"));
assert.equal(profile.authority_status, "release_authoritative", "Semantic build requires approval");
assert.equal(provenance.authority_status, profile.authority_status);
assert.deepEqual(PROFILE, profile, "Embedded evaluator profile drifted from approved JSON");
assert.deepEqual(REASON_MESSAGES, templates.messages, "Embedded report messages drifted");
assert.equal(templates.envelope_version, PROFILE.envelope_version);
await import("./verify-authority-integrity.mjs");
console.log("Semantic build authority and embedded profile/templates verified.");
