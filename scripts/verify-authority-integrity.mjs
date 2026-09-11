import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url));
const json = async (path) => JSON.parse(await read(path));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys, label) => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}: closed keys`);
};
const [profile, provenance, templates, cases, catalogue] = await Promise.all([
  json("spec/importflow-envelope.v4.json"),
  json("spec/provenance.json"),
  json("spec/reason-templates.v4.json"),
  json("spec/public-profile-cases.v4.json"),
  json("spec/profile-catalogue.json"),
]);
exactKeys(
  profile,
  [
    "envelope_version",
    "authority_status",
    "purpose",
    "display_name",
    "applicability",
    "lifecycle",
    "behavior_version",
    "predicate_authority",
    "recognition_authority",
    "input",
    "results",
    "operation",
    "limits",
    "builtin_type_spellings",
    "known_rejected_type_spellings",
    "rules",
    "external_review_always_required",
    "report_notice_authority",
  ],
  "profile",
);
exactKeys(
  provenance,
  [
    "provenance_version",
    "envelope_version",
    "authority_status",
    "profile_sha256",
    "authority_files",
    "projection_review",
    "publication_review",
    "founder_approval",
    "redistribution_approval",
    "license",
    "owner_roles",
    "applicability",
    "attestation_note",
  ],
  "provenance",
);
assert.equal(profile.envelope_version, "importflow-envelope-v4");
assert.equal(profile.behavior_version, "check-behavior-v2");
exactKeys(
  profile.report_notice_authority,
  ["semantics", "rendering_authority", "section"],
  "notice authority",
);
assert.equal(profile.report_notice_authority.rendering_authority, "docs/CHECK_BEHAVIOR_V2.md");
assert.equal(profile.report_notice_authority.section, "3");
assert.ok(profile.report_notice_authority.semantics.includes("non-rendered"));
assert.equal(provenance.provenance_version, 5);
assert.equal(provenance.envelope_version, profile.envelope_version);
assert.equal(provenance.authority_status, profile.authority_status);
assert.deepEqual(provenance.applicability, profile.applicability);
assert.match(profile.applicability.as_of, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(profile.applicability.stage, "Founder-Assisted Alpha");
assert.equal(profile.applicability.offline_currentness_claim, false);
assert.equal(profile.input.api, "checkCompatibility(input: Uint8Array): string");
assert.equal(profile.input.evidence, "supplied_ddl_only");
assert.equal(profile.input.live_evidence_input_allowed, false);
assert.equal(profile.results.production_admission_result_allowed, false);
assert.deepEqual(profile.results.precedence, [
  "refused",
  "outside_envelope_observed",
  "more_evidence_required",
  "no_structural_conflict_observed",
]);
assert.equal(provenance.license, "MIT");
const approved = profile.authority_status === "release_authoritative";
if (approved) {
  assert.equal(provenance.projection_review.outcome, "PASS");
  assert.equal(provenance.publication_review.outcome, "GO");
  assert.equal(provenance.founder_approval.status, "approved_under_conditional_authorization");
  assert.equal(provenance.redistribution_approval, "approved");
} else {
  assert.equal(profile.authority_status, "candidate_pending_projection_and_publication_review");
  assert.equal(provenance.redistribution_approval, "pending");
  assert.equal(provenance.founder_approval.status, "conditional_pending_independent_go");
}
for (const key of ["projection_review", "publication_review"]) {
  exactKeys(provenance[key], ["record_id", "outcome"], key);
  assert.ok(provenance[key].record_id.length > 0);
}
const catalogueEntry = catalogue.profiles.find(({ id }) => id === profile.envelope_version);
assert.ok(catalogueEntry, "Pinned profile must have a lifecycle record");
assert.equal(new Set(catalogue.profiles.map(({ id }) => id)).size, catalogue.profiles.length);
assert.ok(
  (approved ? ["active", "deprecated", "withdrawn"] : ["candidate"]).includes(
    catalogueEntry.status,
  ),
);
if (["deprecated", "withdrawn"].includes(catalogueEntry.status)) {
  assert.ok(typeof catalogueEntry.reason === "string" && catalogueEntry.reason.length > 0);
  assert.match(catalogueEntry.effective_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(catalogueEntry.replaced_by === null || typeof catalogueEntry.replaced_by === "string");
}
const expectedFiles = [
  "spec/importflow-envelope.v4.json",
  "docs/PUBLIC_PROFILE_V4.md",
  "docs/DDL_RECOGNITION_V1.md",
  "docs/CHECK_BEHAVIOR_V2.md",
  "spec/reason-templates.v4.json",
  "spec/public-profile-cases.v4.json",
];
assert.deepEqual(
  provenance.authority_files.map(({ path }) => path),
  expectedFiles,
);
for (const entry of provenance.authority_files) {
  exactKeys(entry, ["path", "sha256"], "authority digest");
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    hash(await read(entry.path)),
    entry.sha256,
    `Unreviewed authority bytes: ${entry.path}`,
  );
}
assert.equal(provenance.profile_sha256, provenance.authority_files[0].sha256);
const ruleIds = profile.rules.map(({ id }) => id);
assert.equal(new Set(ruleIds).size, ruleIds.length);
assert.deepEqual(Object.keys(templates.messages), ruleIds);
assert.equal(templates.envelope_version, profile.envelope_version);
const predicates = new Set();
for (const rule of profile.rules) {
  exactKeys(rule, ["id", "outcome", "predicate"], "rule");
  assert.ok(["outside_envelope_observed", "more_evidence_required"].includes(rule.outcome));
  assert.match(rule.predicate, /^P(?:0[1-9]|1[0-3])$/);
  predicates.add(rule.predicate);
}
assert.equal(predicates.size, 13);
const publicAuthority = (await read(profile.predicate_authority)).toString();
for (const predicate of predicates) assert.ok(publicAuthority.includes(`## ${predicate} —`));
assert.equal(cases.envelope_version, profile.envelope_version);
assert.equal(cases.evidence_kind, "hand_derived_contract_examples_not_executed_evaluator_tests");
const covered = new Set();
const outcomes = new Set();
for (const item of [...cases.cases, ...cases.generated_boundaries]) {
  outcomes.add(item.expected_result);
  assert.ok(profile.results.precedence.includes(item.expected_result));
  for (const id of item.expected_reason_ids) {
    if (item.expected_result !== "refused") assert.ok(ruleIds.includes(id), id);
    covered.add(id);
  }
}
for (const id of ruleIds)
  assert.ok(covered.has(id), `Missing hand-reviewed contract example: ${id}`);
assert.deepEqual([...outcomes].sort(), [...profile.results.precedence].sort());
assert.ok(profile.external_review_always_required.length >= 7);
assert.match(publicAuthority, /not full ImportFlow/);
// Check numbered cross-references only within the selected public documentation.
// This catches missing owners/sections; semantic ownership still requires review.
const publicMarkdown = (await json("package.json")).files.filter((path) => path.endsWith(".md"));
for (const path of publicMarkdown) {
  const document = (await read(path)).toString();
  for (const [, reference, section] of document.matchAll(/`([\w./-]+\.md)` §(\d+(?:\.\d+)*)/g)) {
    const local = posix.normalize(posix.join(posix.dirname(path), reference));
    const target = publicMarkdown.includes(local) ? local : reference;
    assert.ok(publicMarkdown.includes(target), `Missing public authority: ${path} -> ${reference}`);
    const headings = [
      ...(await read(target)).toString().matchAll(/^#{1,6} (\d+(?:\.\d+)*)(?:\.|\s)/gm),
    ];
    assert.ok(
      headings.some(([, number]) => number === section),
      `Missing normative section: ${path} -> ${target} §${section}`,
    );
  }
}
console.log(
  `Public profile integrity verified (${profile.authority_status}); examples are specifications, not evaluator test results.`,
);
