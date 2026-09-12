# Architecture

The v0.1 synchronous `checkCompatibility(Uint8Array): string` remains the CLI's frozen
single-target entry point. The v0.2 browser adds a bounded document layer above the same
profile evaluator. Both paths perform no I/O and neither connects to a database.

```mermaid
flowchart TD
  CLI[CLI: bounded stdin bytes] --> API[src/index.ts]
  UI[Browser: paste or local file] --> Worker[Persistent dedicated Web Worker]
  Worker --> Document[Migration document admission and index]
  Document --> Targets[Exact table identities and target selection]
  Targets --> Association[Bounded target statement association]
  Association --> V02[v0.2 recognition and evidence projection]
  V02 --> Policy
  Worker --> BrowserOutput[Target list and deterministic report]
  API --> Input[input-profile: bounded byte snapshot]
  Input --> Recognition[ddl-* and create-table-*: frozen v0.1 recognition]
  Recognition --> Policy[policy-*: P01–P13]
  Policy --> Report[report-*: deterministic safe text]
  Profile[Approved embedded public profile] --> Policy
  Profile --> Report
  Report --> CLIOutput[CLI stdout]
```

## Where to start

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Frozen v0.1 semantic API used by the stdin CLI |
| `src/migration-api.ts`, `migration-input.ts`, `migration-document.ts` | Additive v0.2 admission, discovery and document index |
| `src/migration-association.ts`, `migration-normalization.ts`, `migration-evaluator.ts` | Exact target association, narrow v0.2 recognition and evidence projection |
| `src/migration-report.ts` | Deterministic v0.2 target report |
| `src/input-profile.ts`, `source-cursor`, `utf8`, `lexical-trivia` | Raw bounds, UTF-8, source spans and lexical primitives |
| `src/create-table-*` | Frozen bounded recognition grammar and declaration conflict selectors |
| `src/ddl-*` | Statement adapters, typed evidence, complete declaration association |
| `src/policy-*` | Approved predicate evaluation and ordered findings |
| `src/report-*` | Governed report bytes and safe dynamic display |
| `src/public-profile.ts` | Embedded public data; verified against approved JSON before build |
| `cli/` | Bounded stdin and process exit/error handling |
| `web/` | Static page, local file/paste input, target selection, DOM presentation and persistent worker boundary |
| `test/` | Core, conformance, exact reports, recognition parity and real CLI processes |
| `e2e/` | Browser flows, failure handling, XSS and privacy tests |
| `scripts/` | Build and verification, not application runtime |
| `spec/`, `docs/` | Reviewed profile, behavior, recognition and contributor documentation |

The flat core uses descriptive family prefixes. Keeping these paths stable preserves
reviewed grammar and test traceability. Parser evidence types refer to each other;
the compiled runtime dependency graph is acyclic. Adapters depend on the core, never
the reverse. Recognition does not depend on policy. There is no general PostgreSQL
parser, dynamic plugin system, runtime profile fetch or second browser policy
implementation. The worker retains one admitted document index so target switching
does not reparse the full migration.

## Build and dependencies

TypeScript compiles the CLI's semantic core. esbuild bundles the same source into an
isolated browser worker and a small separate DOM application. Native HTML/CSS controls
need no frontend framework, editor package, UI kit or runtime npm dependency.
Playwright is development-only browser automation. All direct dependencies are pinned
and the npm lockfile records transitive integrity. Installs use `--ignore-scripts`.

The web output contains only HTML, hashed JavaScript and CSS. There are no functions,
server rendering, source maps or environment-variable substitutions. No private
repository is needed to install, build or verify the public source distribution.

See [migration analyzer v0.2](MIGRATION_ANALYZER_V02.md),
[security and privacy](SECURITY.md), [evaluator traceability](EVALUATOR.md), and
[the exact report/process contract](CHECK_BEHAVIOR_V2.md). Normative documents preserve
their original historical milestone wording; runnable implementation status belongs
to the README and implementation documentation.
