# pg-import-check

**Check your PostgreSQL DDL against ImportFlow's reviewed Alpha target-schema profile.**

Find explicit structural conflicts and questions to bring to an ImportFlow review.
**Your schema is analyzed locally in your browser and is not uploaded for analysis.**
The checker also runs offline as a stdin CLI. No account, database connection or
telemetry is involved.

## Use the browser checker

Paste DDL, choose **Check schema**, then read the result and full text report. Try the
built-in example first. **Reset** clears the input and report; **Copy report** copies
only after you request it. Reports can contain schema identifiers.

To run the browser version locally from this source distribution:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:web
npm run preview
```

Open `http://127.0.0.1:4173`. Static assets load first; a dedicated Web Worker performs
all analysis on your device. The application sends no DDL or reports to any endpoint
and does not put them in URLs, cookies or browser storage.

## Use the CLI

Use Node **24.20.0 or later within Node 24** and the pinned npm version. After installing
as above:

```sh
npm run build
node cli/pg-import-check.mjs < schema.sql
```

Optionally run `npm link --ignore-scripts` after building to make the local command
available as `pg-import-check < schema.sql`. No npm registry executable is published.
Arguments (including filenames, `--help`, and `--version`) are not interpreted; use
stdin redirection as shown above. The CLI accepts up to **262,144 bytes** of UTF-8 DDL and writes a
deterministic plain-text report to stdout. It makes no network or database requests.

```sql
CREATE TABLE public.contacts (
  id integer PRIMARY KEY,
  email text NOT NULL
);
```

This example yields `no_structural_conflict_observed`. Adding a `jsonb` column establishes
a profile conflict; omitting the primary key declaration requires more evidence.
Valid PostgreSQL outside the checker's closed recognition language can be refused.

## Understand the result

| Result | Meaning | CLI exit |
| --- | --- | --- |
| `no_structural_conflict_observed` | No conflict or unresolved predicate among the declarations evaluated; ImportFlow review remains required | 0 |
| `more_evidence_required` | A feature or missing declaration requires more evidence or ImportFlow review | 0 |
| `outside_envelope_observed` | Explicit declarations conflict with the dated target-schema profile | 0 |
| `refused` | Analysis is unavailable under the recognition contract; this is not a finding of incompatibility | 2 |
| Internal application error | The program could not complete analysis; no compatibility verdict | 1 (CLI) |

**Exit 0 means analysis completed. It does not mean compatibility passed.** Every analyzed
report includes the ImportFlow review notice. Do not use an exit code to approve production.

## Scope and limits

- Profile: **`importflow-envelope-v4`**, reviewed snapshot **2026-09-09**.
- ImportFlow Founder-Assisted Alpha: Supabase-hosted PostgreSQL 17, one `public` target,
  insert-only imports. This checker itself has no Supabase integration.
- The Alpha offering's React/Next.js integration eligibility is outside DDL analysis.
- An offline snapshot does not verify today's product availability or profile freshness.
  These are dated Alpha restrictions, not permanent product limits.

This is **not production approval, a migration guarantee, a PostgreSQL validator or a
security certification**. No live database is inspected. Live permissions, effective
RLS/tenant isolation, trigger/function/rewrite effects, omitted objects, trusted system
values, final mapping, installation and actual workload still require ImportFlow review.

Use the report to prepare an [ImportFlow](https://importflow.dev/) review conversation.
The checker does not automatically share your report or contact information.

## Source, verification and issues

Start with [architecture](docs/ARCHITECTURE.md), [security and privacy](docs/SECURITY.md),
and [evaluator API / predicate traceability](docs/EVALUATOR.md). Exact authority lives in
[the public profile](docs/PUBLIC_PROFILE_V4.md), [report/process behavior](docs/CHECK_BEHAVIOR_V2.md),
[recognition contract](docs/DDL_RECOGNITION_V1.md) and [provenance](spec/provenance.json).
Historical readiness wording in normative documents is preserved; this README describes
the executable source in this distribution.

```sh
npm run verify
npm run build:web
npx playwright install chromium firefox webkit
npm run test:e2e
```

Core checks include all 56 approved conformance cases, exact reports, hostile inputs
and frozen recognition parity. See [contributing](docs/CONTRIBUTING.md) for browser
checks and development. File ordinary bugs in the public repository's Issues tab with
a minimal synthetic example. Email [mohamed@importflow.dev](mailto:mohamed@importflow.dev) privately for
sensitive findings; never post customer schemas or credentials in public issues.

[MIT licensed](LICENSE), with [third-party notices](NOTICE). Modified profiles do not
carry ImportFlow approval. Licensing does not confer endorsement or production authority.
