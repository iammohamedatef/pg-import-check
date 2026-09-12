# Security and privacy

Your migration/schema is analyzed locally in your browser and is not uploaded for analysis.
The site initially downloads static HTML, CSS, application JavaScript and worker
JavaScript. Pasted text or a locally selected `.sql` file is converted to UTF-8 bytes
and transferred to a dedicated worker. The worker retains a bounded document index,
returns exact target identities, and evaluates selected targets using the same approved
profile predicates. Reset, input edits, a new document, timeout or worker failure clears
that retained state. No backend receives migration text.

## Data handling

There are no analytics, telemetry, crash reporting, accounts, cookies, storage APIs,
service workers, database connections or application API requests. Input and report
state live in memory. Reset clears the page state; reloading starts a new session.
The application does not place schema or report content in URLs or browser storage.
Browser extensions, the operating system and browser-managed session restoration are
outside the application's control. Clipboard copying requires an explicit user action;
a copied report can contain schema identifiers and is then under the user's control.

The HTML disables spellcheck and autocomplete for the editor. All evaluator output
uses text nodes, never executable markup. Reports retain the core's escaping of
control, bidi, invisible and terminal-escape characters. Link destinations are static;
identifiers cannot become navigation targets or download filenames.

## Isolation and failure behavior

The v0.2 browser document layer caps input at 2,097,152 raw bytes before discovery. The
editor transfers at most that bound plus one content-free overflow sentinel. Document
indexing is also bounded at 20,000 statements, 150,000 tokens and 5,000 targets. A
document that selects non-standard `standard_conforming_strings` behavior refuses before
discovery, so session-dependent legacy escapes cannot change recognized boundaries.
Target-local association is limited to 256 statements; exceeding it creates explicit `association_limit_exceeded`
`NOT_EVALUATED` evidence and cannot produce a clean conclusion. The v0.1 CLI retains its
262,144-byte input cap.

The worker keeps parsing off the main thread. A worker exception, invalid response,
startup failure or wall-clock timeout shows a generic application error, never a
compatibility finding. Timeout is an adapter failure, not evaluator policy.
Shape-changing ordered mutations remain visible as `NOT_EVALUATED` when final state
cannot be projected safely. Exact table, policy and trigger DROP forms are associated
with their qualified target and remain `NOT_EVALUATED`; malformed or unbounded forms
refuse the document.

The CLI retains at most the byte limit plus one byte from stdin. Analyzed outcomes
exit 0; deterministic refusal exits 2. Internal defects exit 1 with a fixed diagnostic
and no stack trace. Exit 0 is not production approval.

## Static hosting headers

`vercel.json` sets a restrictive Content Security Policy on the document and worker:
self-hosted scripts/styles/workers only; no connection, image, font, object, form,
base-URL or frame-ancestor sources. There is no `unsafe-inline` or `unsafe-eval`.
`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS and a restricted
Permissions Policy complement CSP. HTML revalidates; content-hashed assets are immutable.
CSP is defense in depth; the implementation itself contains no schema egress path.

## Verification and reporting

`npm run verify` checks core behavior and package/authority integrity. After
`npm run build:web`, `npm run test:e2e` exercises real browsers, malicious identifiers,
input bounds, worker failures and a distinctive DDL canary while observing network
and browser APIs. These tests can target deployed HTTPS using `BASE_URL`.
Dependency audits and production headers must also be checked before a release.

Do not put real customer DDL, secrets or sensitive vulnerability details in public
issues. Email [mohamed@importflow.dev](mailto:mohamed@importflow.dev) privately for sensitive reports;
include a minimal synthetic reproduction. Ordinary reproducible bugs can use the
public repository's Issues tab. This checker is not a security certification,
PostgreSQL validator, migration guarantee or production-admission control.
