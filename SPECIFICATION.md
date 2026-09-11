# pg-import-check — public specification

This repository implements a local DDL compatibility evaluator supporting ImportFlow,
using the frozen recognition contract and approved public v4 profile. The complete CLI,
browser shell and deployment remain the next milestone; executable release stays
separately gated. See docs/EVALUATOR.md for the semantic API and executable coverage.

The semantic API is `checkCompatibility(input: Uint8Array): string`. It identifies
explicit conflicts and unresolved declarations against **ImportFlow Founder-Assisted
Alpha — target-schema check profile**, a dated scope for Supabase-hosted PostgreSQL 17.
It never approves a database, installation, customer, migration or production import.

## Authorities

| File | Owns |
| --- | --- |
| `spec/importflow-envelope.v4.json` | Public policy sets, limits, applicability, outcomes and identity |
| `docs/PUBLIC_PROFILE_V4.md` | Complete public predicate meanings P01–P13 |
| `docs/DDL_RECOGNITION_V1.md` | Frozen input, structural grammar, refusal and safe-display mechanics |
| `docs/CHECK_BEHAVIOR_V2.md` | Reachable DDL-only results, report bytes and process behavior |
| `spec/reason-templates.v4.json` | Trusted explanations |
| `spec/public-profile-cases.v4.json` | Hand-reviewed examples for future evaluator implementation |
| `spec/provenance.json` | Public integrity and approval attestation |
| `spec/profile-catalogue.json`, `docs/GOVERNANCE.md` | Lifecycle, freshness and owner roles |
| `docs/THREAT_MODEL.md` | Core/adapter privacy and security boundaries |

Private ImportFlow production policy remains ImportFlow-owned. It is neither a build
input nor a runtime dependency. Public conformance means only conformance to this
finite dated public observation contract. Implementation cannot add or widen policy.

## Product boundaries

- No database connection, credentials, SQL execution or SQL/migration generation.
- No runtime model calls, remote analysis, accounts, persistence or saved reports.
- Browser analysis stays in the loaded page; CLI analysis stays in its process.
- No live fingerprint, contract identity or production-admission result.
- Fully consume the recognized input or refuse; never present a partial parse as complete.
- Return only deterministic safe plain text; never use input as code, HTML, URL state,
  network destination or terminal control data.
- Public installation, build and verification use only distributed public files.

See the README for intended usage and exact result meanings. Analysis success (CLI
exit 0) includes conflicts and unresolved observations. It never certifies production.

## Publication versus executable release

A candidate profile blocks semantic implementation. Matching `release_authoritative`
status requires independent projection review, independent publication GO, concrete
rights/disclosure clearance, conditional Founder authorization, and verified final
artifact identities. Public provenance attests that process; it does not prove a
live target is compatible. `npm run verify` checks local integrity, not private truth.

A runnable release additionally requires a complete evaluator and adapters, reviewed
expected report bytes, input-safety and hostile-rendering evidence, a pinned runtime
matrix, no runtime dependencies/I/O in the core, clean public builds, and verified
browser deployment boundaries. None is silently waived by publication of this policy.
