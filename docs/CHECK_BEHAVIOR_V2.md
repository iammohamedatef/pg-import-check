# check-behavior-v2 — DDL-only evaluator contract

Status: normative public contract; implementation remains a later goal. Publication
of the profile is not a claim that a complete checker, CLI or browser is implemented.
The active profile and provenance statuses govern semantic implementation eligibility.

## 1. Authority and processing

`checkCompatibility(input: Uint8Array): string` is synchronous and performs no I/O.
Snapshot stable bytes, validate input, recognize the complete declaration set,
associate the one target, evaluate all public P01–P13 predicates, collect reasons,
select a result, and render trusted text. The exact structural grammar, recognition
refusal precedence and safe-display functions live in DDL_RECOGNITION_V1.md.
Recognized syntax and product compatibility are separate. The structural parser stays
frozen. Multi-statement family adapters remain implementation work; do not pretend a
partial CREATE TABLE reader implements this whole API.

Candidate authority is a configuration/build block, never a user refusal. A semantic
build requires matching `release_authoritative` profile/provenance status and valid
integrity checks. It may not download rules, resolve private references, accept gate
state, fabricate live evidence, or choose another profile silently.

## 2. Reachable outcomes and process contract

| Outcome | Exact meaning | Intended CLI exit |
| --- | --- | --- |
| `refused` | Full analysis unavailable under the closed recognition contract | 2 |
| `outside_envelope_observed` | Supplied declarations establish at least one public-profile conflict | 0 |
| `more_evidence_required` | No conflict is proven, but at least one evaluated predicate remains unresolved | 0 |
| `no_structural_conflict_observed` | No conflict or unresolved predicate among the declarations evaluated | 0 |

All four are reachable with DDL-only input. Result precedence is the JSON order.
Analysis completion (exit 0) is not compatibility success. Do not use this CLI as a
production-admission CI gate. Unexpected software defects use exit 1, empty stdout,
and only `pg-import-check could not complete the check because of an internal error.\n`
on stderr. Analyzed/refused output goes only to stdout with empty stderr.
There is no JSON report API. CLI help/version remain adapter work.

Live schema, omitted objects, effective permissions/RLS, reviewed tenant/system values,
final mapping/identity choice, trigger and rewrite effects, installation, workload,
and production approval ALWAYS remain with ImportFlow. Every analyzed report includes those external review categories, including on
structural success. Refusals use the separate notice defined in §3. The categories are
not represented as satisfied booleans.
The old comprehensive `no_envelope_conflict_observed` result is not emitted by v2.

## 3. Deterministic report grammar

This section exclusively owns exact report and notice bytes. The profile JSON names
external-review categories as semantic metadata; never render those identifiers or
its `report_notice_authority` metadata as additional report text.

UTF-8, LF only, no BOM, no ANSI/OSC, no terminal-dependent styling, one final LF,
no trailing spaces. Blank lines occur only where shown. Fixed strings are trusted;
all dynamic identifiers use recognition §13 safe display. Never render expression or
function bodies in analyzed output. Never infer report semantics from display strings.

An analyzed report is exactly this shape (angle-bracket slots are not literal):

```text
PG IMPORT CHECK
profile: <envelope_version> | <display_name>
as of: <applicability.as_of> | offline snapshot; current availability not verified
target: <target>
TEXT-ONLY VERDICT: <result>
<result-note>

FINDINGS
<finding-lines>

COLUMNS
<column-lines>

IMPORTFLOW REVIEW REQUIRED
Only supplied DDL was analyzed. No live database was queried.
This is not production approval or a migration guarantee.
Review live schema and omitted objects, effective authorization and tenant isolation,
trusted system values and final mapping, trigger/function/rewrite effects,
installation, workload, and production approval with ImportFlow.
Profile restrictions describe the dated Alpha scope, not permanent product limits.

check-behavior-v2 | <envelope_version> | <applicability.as_of>
```

`target` is the safely displayed qualified identity, or the displayed unqualified
identity plus the trusted suffix ` (schema not declared)`.

Result notes are exactly:

- outside: `Explicit declarations conflict with the dated public target-schema profile.`
- unresolved: `A declared feature or missing declaration requires ImportFlow review.`
- success: `No structural conflict was observed among the declarations evaluated.`

Finding lines are `  <reason_id> — <message>`, one per distinct fired reason ID, in
`profile.rules` order, with messages read from `spec/reason-templates.v4.json`.
No user text is inserted into a message. If no reason fires, the only finding line is
`  No profile conflicts or unresolved predicates were found in the evaluated declarations.`
P13 may discover two exceeded categories; its single trusted reason appears once.
No higher-precedence reason suppresses other material findings.

Each column line is `  <safe-name> — <disposition>`, in declaration order. Disposition
selection is: a column type/identity/enum conflict => `outside public type profile`;
unresolved type/enum identity => `type requires ImportFlow review`; otherwise any
P07 generation/default declaration => `excluded from file mapping by the ordinary generation/default rule`;
otherwise => `file mapping candidate; final classification requires ImportFlow review`.
These are presentation choices, not factual assignments of trusted or mapped authority.
Append ` | <comma-separated-reason-ids>` for column-associated reasons, in profile.rules
order, when nonempty. P04 associates column-name reasons to that column. P05/P07
associate to their column. P06 associates to all columns using that enum. P08 associates
to participating local FK columns. Other reasons remain target findings only. A
column associated with a CHECK does not imply the opaque expression was resolved.

For a refusal, emit exactly:

```text
PG IMPORT CHECK
profile: <envelope_version> | <applicability.as_of>
REFUSED: <reason_id>
  <trusted-explanation>
<optional-location-line>
  <trusted-remediation>
Analysis unavailable; this is not a finding of ImportFlow incompatibility.
No live database was queried. No production approval or migration guarantee is given.
check-behavior-v2 | <envelope_version> | <applicability.as_of>
```

The trusted refusal explanation/remediation and selection rules are recognition
§12.3. Embedded references to `check-behavior-v1` identify the unchanged recognition
vocabulary. For a source fragment the optional location line is
`  at line <line>, column <column>; <byte-length> bytes; "<safe-preview>"`.
For a grammar failure established at EOF without a source fragment it is
`  at end of input`. Refusals whose recognition contract specifies no location omit
that line entirely. Previews obey recognition §13 bounds and escaping.

No shared report claims that page loading itself makes no network requests. The
browser adapter's privacy promise is limited to local processing after static assets
load and must be verified before deployment.

## 4. Determinism and readiness

For a fixed public profile, behavior version and stable input bytes, conforming builds
must produce identical report bytes on the release's verified runtime matrix. No
clock, locale APIs, environment, randomness, database or network may affect the result.
The profile date is a literal, not the evaluation time. Do not fetch a freshness check.

`spec/public-profile-cases.v4.json` contains reviewed hand-derived contract cases. They
are obligations for future evaluator tests, not claims that an evaluator exists.
Before a runnable checker ships, implement all declared statement families or version
an explicitly narrower API; prove fixture reports, safe rendering, deterministic
refusals, CLI exits and browser no-I/O boundaries on the declared runtime matrix.
Policy-publication GO alone does not satisfy those executable-release gates.
