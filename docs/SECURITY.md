# Security and privacy

Your schema is analyzed locally in your browser and is not uploaded for analysis.
The site initially downloads static HTML, CSS, application JavaScript and worker
JavaScript. DDL is converted to UTF-8 bytes and transferred to a dedicated worker.
The worker invokes the same approved evaluator as the CLI, returns deterministic
plain text, and is terminated after the run. No backend receives DDL.

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

The core caps input at 262,144 raw bytes before recognition. The editor bounds its
accepted text and transfers at most the byte limit plus one overflow-proof byte.
The evaluator remains responsible for deterministic refusals. The worker keeps parsing
off the main thread; reset terminates a running worker. A worker exception, invalid
response, startup failure or wall-clock timeout shows a generic application error,
never a compatibility finding. Timeout is an adapter failure, not evaluator policy.

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
