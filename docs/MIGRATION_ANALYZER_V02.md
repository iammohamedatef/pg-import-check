# Migration analyzer v0.2

The browser checker accepts a bounded PostgreSQL migration or schema document and lets
you select one discovered table for deterministic ImportFlow target-schema analysis.
All discovery and evaluation run in a Web Worker on the device. The application has no
schema upload endpoint, database connection, analytics, telemetry or persistence.

## Document boundary

A browser document is limited to **2,097,152 UTF-8 bytes (2 MiB)**, 20,000 statements,
150,000 tokens and 5,000 discovered targets. The analyzer first segments the document
while protecting strings, quoted identifiers, nested block comments and dollar-quoted
bodies. A document that selects non-standard `standard_conforming_strings` semantics is
refused rather than scanned under the wrong lexical rules. The analyzer preserves exact
qualified identifier identity; an unqualified table remains schema-unresolved and is
never assumed to be `public`. Cross-statement evidence for an unresolved relation is not
projected through `search_path` assumptions.

The document layer discovers `CREATE TABLE` declarations and meaningful table-local
`ALTER TABLE` evidence. Non-public and unresolved targets stay visible in discovery.
The current ImportFlow Alpha profile still evaluates an explicitly `public` target; the
analyzer does not broaden that product policy.

For the selected target, v0.2 can associate only the bounded forms justified by the
reviewed release evidence: the base `CREATE TABLE`, supported `ALTER TABLE ... ADD`
constraint forms, referenced enum/type declarations where exact identity is available,
profile-relevant unique indexes, policies/RLS evidence, supported target trigger forms,
and later default/identity generation evidence. Association uses exact structural
identity rather than table-name substring matching.

Target-local association is itself bounded. If more than 256 target-local statements
require association, the report records `association_limit_exceeded` as
`NOT_EVALUATED`; no statement beyond that bound is silently treated as evaluated.

## Narrow v0.2 recognition

The v0.1 single-target recognizer remains unchanged. The v0.2 document path adds only
reviewed recognition needed by realistic migration files, including the supported
multiword timestamp spellings, `character varying`, `double precision` classification,
the reviewed foreign-key action forms, reviewed dump storage clauses and reviewed
trigger spellings. Recognition means the structural semantics required by the profile
are known; unsupported lookalikes still refuse or become `NOT_EVALUATED` when they are
relevant to the selected target.

## Ordered mutations

v0.2 does not implement general ordered migration projection. Shape-changing operations
such as `ADD COLUMN`, `DROP COLUMN`, `DROP CONSTRAINT`, rename operations and column type
changes remain explicit `NOT_EVALUATED` evidence. Multi-action `ALTER TABLE` statements
are not partially projected. Exact target-local `DROP TABLE`, `DROP POLICY ... ON`, and
`DROP TRIGGER ... ON` forms are associated and reported as `NOT_EVALUATED`; the analyzer
does not infer the final lifecycle state. Malformed or unbounded forms of those target
lifecycle statements refuse document discovery. The report therefore does not pretend
that an earlier declaration necessarily describes the final target after an unsupported
mutation sequence.

## What the report establishes

The report can establish facts present in the supplied DDL: exact target identity,
column and key shape, supported associated constraints, relevant enum/type evidence,
value-generation/default evidence, supported indexes/triggers/policies, deterministic
profile conflicts and explicit unevaluated target-local statements. File authority is
shown only where the public profile deterministically establishes it; column names do
not carry business meaning.

The report does **not** establish production safety, migration approval, live table
state, effective permissions or RLS authorization, runtime function/trigger effects,
omitted objects, workload suitability or final customer mapping. Those remain ImportFlow
review items.

## Privacy model

The browser downloads static application assets before analysis. Migration bytes then
move only from the page to its same-origin Web Worker. The application does not call
`fetch`, XHR, beacons, WebSockets, form submission, browser storage or cookies with the
input or report. It does not log migration content. Choosing a file reads that file in
the browser; there is no upload endpoint. Copying a report is an explicit user action.

## Known limitations

- Discovery is a bounded structural index, not a general PostgreSQL parser or validator.
- Unqualified table/type identities remain unresolved because no `search_path` or live
  catalog is consulted.
- A target with no unique base `CREATE TABLE` declaration cannot receive a complete
  evaluated shape. Recognized target-local statements are still listed with source
  provenance as `NOT_EVALUATED`; their effects are not projected without that base.
- Ordered shape mutations are reported as `NOT_EVALUATED` rather than projected.
- Policy, trigger and table DROP lifecycles are reported as `NOT_EVALUATED`; final
  lifecycle state is not inferred.
- Unsupported target-relevant statements are reported as refused or `NOT_EVALUATED`;
  unrelated surrounding statements may remain outside target evaluation.
- The current profile is limited to explicitly `public` targets in the dated ImportFlow
  Founder-Assisted Alpha scope.

## v0.1 compatibility

`checkCompatibility(Uint8Array): string` and the existing stdin CLI retain the v0.1
single-target contract and its 262,144-byte input limit. v0.2 is additive: the browser
uses the document index and target-selection path, while existing v0.1 callers keep the
same behavior and deterministic reports.
