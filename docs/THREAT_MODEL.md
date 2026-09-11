# Threat Model

> Status: normative security requirements for the public source/policy snapshot and the future runnable checker. Reviewed structural foundations exist; publication of the profile does not certify an evaluator, CLI, browser shell or deployment.

## 1. Security objective

`pg-import-check` accepts untrusted DDL and produces text. Its security objective is to keep that operation local, bounded, non-executing, non-persistent, and safe to render in terminals and browsers.

The checker is not a confidentiality boundary against a compromised endpoint or host. It is responsible for the behavior of its own core, CLI adapter, browser shell, build, and documented deployment configuration.

Input, structural grammar, refusal selection and safe-display mechanics are owned by [`DDL_RECOGNITION_V1.md`](DDL_RECOGNITION_V1.md). Exact report bytes and process behavior are owned by [`CHECK_BEHAVIOR_V2.md`](CHECK_BEHAVIOR_V2.md). This document owns the security boundaries and verification requirements; it does not redefine those contracts.

## 2. Assets

The design protects:

- supplied DDL, which may reveal schema names, business concepts, policy expressions, function bodies, and infrastructure identifiers;
- report integrity, so hostile input cannot impersonate trusted diagnostics or hide/reorder findings;
- terminal integrity, including control state, hyperlinks, title, clipboard-affecting sequences, and subsequent prompt display;
- browser DOM integrity and origin state;
- availability of the CLI process and browser page within the documented input boundary;
- the correctness and provenance of the public ImportFlow envelope;
- release artifacts and the public dependency/build boundary.

## 3. Attacker capabilities

Assume an attacker can supply any byte sequence up to and beyond the raw input cap and can intentionally craft:

- invalid UTF-8, NUL, controls, bidi controls, zero-width/invisible characters, combining text, and visually confusable identifiers;
- enormous tokens or quoted bodies within the total input cap;
- nested comments and parentheses;
- unterminated strings, quoted identifiers, block comments, and dollar quotes;
- delimiter-like text inside comments, strings, and function bodies;
- thousands of short declarations, columns, constraints, enum labels, policies, indexes, or observations permitted by the total bytes;
- SQL keywords inside comments, identifiers, literals, or dynamic SQL text;
- tokens designed to trigger catastrophic regular-expression behavior or repeated rescans;
- identifiers and labels containing terminal/HTML-looking payloads;
- SQL that would be destructive if executed;
- function bodies containing helper calls, dynamic SQL, DML, notifications, or network-like call syntax;
- browser interaction patterns involving analyze, copy, reload, back/forward navigation, and developer tools.

Assume public contributions and dependency/workflow changes may be malicious or compromised.

## 4. Trust boundaries

### 4.1 Pure core

The core receives a stable byte array and returns handled report/refusal text. It has no filesystem, process, database, network, DOM, clipboard, storage, timer, randomness, environment, or logging capability.

Unexpected internal failures are software defects rather than compatibility results. The core must not make raw exception information part of its semantic output.

### 4.2 CLI adapter

The CLI may read stdin and write stdout/stderr. It must not:

- interpret input as a path, option, shell fragment, or SQL command;
- connect to a database or network service;
- add terminal styling or hyperlinks;
- log input or raw exceptions;
- include environment paths or stack traces in production output.

On an unexpected internal failure, it emits only the fixed generic production message and a failure exit status. Developer diagnostics, if enabled in a development-only build or test, must be impossible to enable through DDL input.

The exact exit/stdout/stderr contract and generic internal-error message bytes are owned by `CHECK_BEHAVIOR_V2.md` §2. This threat model does not define a second process contract.

### 4.3 Browser UTF-16 adapter

The adapter validates lone surrogates before encoding and passes bytes to the core. It must not place DDL into a URL, message to an unrelated context, telemetry call, storage entry, or DOM HTML sink.

### 4.4 Browser rendering shell

The shell may read textarea text, invoke analysis, display returned text, and copy the report on an explicit user action. It uses text-node APIs for input-derived output. It has no runtime analytics, telemetry, third-party code, external font/icon dependency, or persistence feature.

### 4.5 Static hosting and origin

`importflow.dev/check` may share an origin with other pages, but the checker response and its loaded resources form a deliberately isolated static application. Repository requirements cover checker assets and configuration. Deployment verification covers the actual response headers, requests, storage behavior, and service-worker controller.

### 4.6 Public envelope

A candidate profile may not be used for semantic implementation or release. Matching release-authoritative profile/provenance status records the completed projection, publication and Founder approval gates defined in `GOVERNANCE.md`. A public build must never silently replace or augment it from a private checkout.

## 5. Parser availability and resource threats

### 5.1 Raw allocation

The core rejects raw input over 262,144 bytes before decoding, normalization, token allocation, or diagnostic construction. A leading BOM counts.

The browser adapter first uses UTF-16 code-unit length as a no-allocation lower bound, then validates at most 262,144 code units while computing UTF-8 length before encoding. It therefore does not allocate an arbitrarily large encoded copy merely to discover that browser input exceeds the core cap.

The byte cap is the primary quantitative availability boundary. Additional numeric limits require evidence rather than speculation.

### 5.2 Nontermination and excessive work

Crafted tokens, nesting, delimiters, and declaration graphs can cause nontermination or superlinear work. Eager whole-input delimiter scans, backtracking, or repeated traversal of an admitted opaque region are specifically untrusted-input amplification risks. The exact cursor-progress, scan-count, nesting, lookup, ordering, and timeout invariants are owned by `DDL_RECOGNITION_V1.md` §16. Security review must produce adversarial growth evidence against those invariants; this document does not restate them as a second normative list.

### 5.3 Memory amplification

Small input can be amplified through copied lexemes, duplicated decoded/raw forms, repeated observations, or report construction. `DDL_RECOGNITION_V1.md` §16 owns the exact retained-state and output-growth invariants. Security review must measure representative and adversarial amplification and inspect allocation strategy against that authority.

### 5.4 Stack exhaustion

Nested block comments, parentheses, brackets, and opaque-expression boundaries are attacker-controlled stack-exhaustion inputs. Comment nesting and typed parser structural nesting must be iterative rather than recursive. The exact invariant is owned by `DDL_RECOGNITION_V1.md` §16 and must be verified there.

## 6. Lexical and semantic attacks

### 6.1 Quote/comment confusion

The lexer, not a regular-expression preprocessor, owns protected comment, string, quoted-identifier, and dollar-body formation and their lexical refusals. The parser owns typed `()`/`[]` structural balance and caller-selected depth-zero boundaries. Protected contents cannot alter parser delimiters, commas, semicolons, keywords, statement boundaries, or public structural observations.

### 6.2 Dollar delimiter abuse

Repeated near-matches to a long dollar delimiter can trigger quadratic searching or incorrect early closure. Once safely formed, a dollar body is atomic during admitted opaque traversal, so delimiter-, semicolon-, and keyword-looking body content cannot alter structural state. The exact matching and complexity invariant is owned by `DDL_RECOGNITION_V1.md` §16; hostile repeated-prefix fixtures must verify it.

### 6.3 Dynamic SQL and helper calls

Function bodies are safely delimited and otherwise UNEVALUATED by this profile. The checker performs no direct-effect scan and does not resolve dynamic SQL, helper behavior, overloaded names, triggers on written relations or extension effects. These effects remain ImportFlow-review-only under P11 in `PUBLIC_PROFILE_V4.md` and the exact report contract.

This epistemic restriction is also a security control: a crafted body cannot cause the report to bless an effect as internal or harmless.

### 6.4 Accidental SQL execution

Production code must contain no path from input to:

- a PostgreSQL client;
- an embedded SQL engine;
- shell/process execution;
- `eval`, `Function`, dynamic import, or generated module code;
- navigation, a request destination, location/history state, or another URL sink constructed from input.

Safely rendered text may visibly contain inert URL-shaped characters. It must not become a clickable/input-derived link, URL attribute, request, navigation, asset load, or OSC terminal hyperlink.

Only trusted, reviewed fixtures may later be run against an isolated disposable PostgreSQL instance for independent syntax/catalog checks. Fuzzed or user-supplied input must never be executed.

## 7. Unicode and identity threats

### 7.1 Invalid encoding

Strict decoding prevents two invalid byte sequences from being silently replaced with the same text. The browser adapter prevents lone UTF-16 surrogates from being replaced before the byte boundary.

### 7.2 Identifier ambiguity

Recognition v1 accepts ASCII unquoted identifiers and safe Unicode double-quoted identifiers. Unquoted non-ASCII identifiers refuse because the project does not claim locale-independent PostgreSQL-compatible classification and case folding.

No Unicode normalization occurs. Quoted identifiers that differ by normalization form remain different.

### 7.3 Controls, bidi, and invisible formatting

Identifiers containing the recognition contract's closed unsafe table refuse. Other input-derived display fragments selectively escape controls, bidi-control characters, line separators, non-ASCII whitespace, and invisible formatting.

The project does not attempt to detect all visual confusables. Useful printable Unicode is retained where the recognition contract permits it, and visual similarity alone is not treated as identity.

### 7.4 Display width

Exact UTF-8 bytes are protected; universal glyph or terminal-cell width is not. Reports use delimiter-based rows and do not depend on Unicode display width for semantic structure.

## 8. Terminal and diagnostic injection

Threats include ANSI CSI, OSC hyperlinks, title changes, C0/C1 controls, BEL, embedded line breaks, bidi reordering, fake reason lines, and extremely long tokens.

Required controls:

- no raw input substring is written to stdout/stderr;
- all templates and structural separators are trusted literals;
- interpolation uses the recognition contract's safe-display rules;
- unsupported syntax uses a scalar- and byte-bounded preview;
- backslash is escaped where necessary so rendered escape notation is distinguishable;
- raw exception messages and stack traces never reach production users;
- the CLI does not add ANSI color or terminal hyperlinks.

Executable-release verification must test hostile rendering examples and inspect the single controlled interpolation boundary.

## 9. Browser DOM and privacy threats

### 9.1 DOM XSS and HTML injection

Report and diagnostic output is inserted using `textContent` or equivalent text-node APIs. Input must never reach `innerHTML`, `outerHTML`, `insertAdjacentHTML`, HTML template parsing, CSS construction, script text, event-handler attributes, or URL attributes.

The shell does not linkify input-derived URL-shaped text. Such text may appear only as inert text-node content after the recognition contract's safe rendering.

### 9.2 Network behavior

The checker may claim:

> The checker processes DDL locally in the loaded page. Its analyze and copy actions make no network requests, and the checker does not place DDL in URLs or browser storage.

Initial requests for the checker's own static assets are not described as zero network.

Required repository behavior:

- no fetch/XHR/WebSocket/EventSource/beacon or remote module path;
- no runtime analytics, telemetry, error reporting, or third-party scripts;
- no external fonts, images, or icons;
- no form submission;
- no DDL in navigation, query, fragment, resource URL, or worker message to an unrelated context;
- no production `sourceMappingURL` or lazy asset path that can create a post-load request;
- no source map or production error report carrying input.

Required deployment verification:

- after the checker is ready, typing, analysis, and copy produce no network request;
- request URLs and bodies contain no DDL;
- the production CSP is present and effective;
- `navigator.serviceWorker.controller === null` for the loaded production checker page.

### 9.3 Content Security Policy

The expected minimum checker policy is approximately:

```text
default-src 'none';
script-src 'self';
style-src 'self';
connect-src 'none';
img-src 'none';
font-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
worker-src 'self'
```

The deployed header is authoritative; a meta tag alone cannot provide every directive. CSP is defense in depth, not proof against malicious hosting or a compromised allowed script.

### 9.4 Service workers

The checker repository must not register a service worker. That is insufficient by itself: the deployed checker page must not be controlled by any existing service worker whose scope includes `/check`.

Production acceptance therefore requires a browser assertion equivalent to:

```text
navigator.serviceWorker.controller === null
```

How hosting achieves that is a deployment decision outside this design authority. The assertion is required regardless of mechanism.

### 9.5 Browser storage and navigation

The checker does not read or set cookies and does not write input or report content to cookies, local storage, session storage, IndexedDB, Cache Storage, URL state, history state, or persisted form state intentionally controlled by the application.

The textarea should not participate in a form submission. Browser-native restoration, clipboard history, or extension storage outside application control is an explicit external limitation.

### 9.6 Clipboard

Only the rendered report may be copied, and only after an explicit user action. The checker does not read existing clipboard contents. Clipboard contents leave the application's control after the copy succeeds; the UI must not imply otherwise.

### 9.7 Optional worker

The pure core is synchronous. A same-origin static module worker may be used only if measurement shows that maximum accepted input materially harms responsiveness.

If used:

- it is loaded from `'self'`;
- it receives only the DDL bytes needed for analysis;
- it is ready before the page is presented as ready, so analyze does not initiate a new request;
- it does not change result semantics;
- unexpected worker failures produce only the fixed generic production message.

No Blob worker is required.

## 10. Same-origin and hosting considerations

Sharing `importflow.dev` does not grant the checker control over unrelated pages or infrastructure. The checker must avoid dependencies on shared application state, cookies, frameworks, service workers, or runtime bundles.

Hosting operators can observe requests for static assets and can replace those assets. DNS/TLS and hosting integrity are outside the guarantees of application code. Reproducible artifacts, restrictive deployment configuration, and independent browser verification reduce but do not eliminate that trust.

Because `/check` may share an origin, pre-existing cookies scoped by the host may accompany the initial navigation even though checker code neither reads nor writes them. That initial hosting behavior is not described as local-only analysis; DDL must still never enter a request.

DDL must never be placed in a request, so ordinary static access logs should not receive it from checker behavior.

## 11. Envelope integrity

The public envelope is data that affects reports. Required controls before implementation/release:

- require the envelope and provenance `authority_status` values to match;
- treat `candidate_pending_projection_and_publication_review` as a hard semantic-implementation/build block and evaluate product rules only at `release_authoritative`;
- validate the snapshot's closed shape;
- reject unknown/malformed rule values;
- review every envelope and provenance change together;
- never download or regenerate rules during a public build;
- increment the envelope version for behavior-changing rule updates;
- update affected normative examples and fixtures.

Public CI can prove internal consistency. It cannot prove that a private authority has not drifted.

## 12. Dependency and supply-chain boundary

The core has zero runtime dependencies. This reduces but does not remove supply-chain risk because compilers, test tools, bundlers, browser tooling, CI actions, registries, and hosting remain dependencies of development and release.

Before implementation/release, the repository must define and verify:

- a pinned Node 24 LTS patch and npm lockfile;
- exact development dependency versions with a stated job for each tool;
- lockfile review and clean-install verification;
- least-privilege CI permissions and no secrets for untrusted pull requests;
- immutable full-commit pins for third-party CI actions;
- reproducible package/static builds;
- release provenance appropriate to the published artifacts.

Source-snapshot publication verifies the applicable dependency and source-build controls. Bundler, adapter and hosting controls additionally require evidence before a runnable release; policy approval does not waive them.

## 13. Threats explicitly outside project control

The project does not claim protection against:

- a malicious or compromised browser, operating system, terminal emulator, or clipboard manager;
- browser extensions that can read or alter the page;
- compromised DNS, TLS termination, CDN, hosting infrastructure, npm registry, or maintainer account;
- a user intentionally sharing DDL or reports;
- application behavior after copied text leaves the checker;
- undisclosed live PostgreSQL objects or runtime behavior absent from supplied text;
- denial of service by exhausting resources below JavaScript or process control.

These limits must not be rewritten as absolute privacy or compatibility promises.

## 14. Residual risks

- The closed recognizer may refuse valid PostgreSQL DDL. This is intentional and must be explained with a safe remediation.
- The recognizer may accept profile syntax that has not been independently checked against every supported PostgreSQL runtime. Accepted fixtures that make PostgreSQL claims require trusted differential validation.
- Safe printable Unicode can remain visually confusable even when controls and invisible formatting are excluded.
- Ordinary printable right-to-left letters can affect visual ordering without using bidi controls; report semantics rely on trusted delimiters and exact bytes, not visual order.
- Function bodies and trigger/privileged-function/rewrite effects remain unevaluated; analyzed reports must retain the external-review block owned by `CHECK_BEHAVIOR_V2.md` §3.
- A 262,144-byte adversarial input may still be perceptibly expensive. Measurement determines whether a static worker or evidence-backed additional limit is necessary.
- Same-origin hosting retains infrastructure trust even with an isolated static shell.
- A candidate profile blocks semantic implementation until projection, publication and Founder approval complete. An approved source/policy snapshot still requires the separate executable-release evidence below.

## 15. Future verification requirements

Before the first runnable checker release, evidence must include:

1. raw-size and strict UTF-8 boundary tests;
2. nested comment, quote, dollar-body, delimiter, and full-consumption hostile tests;
3. growth tests showing lexer, parser, body scanning, association, and rendering remain within the structural complexity invariants;
4. terminal-byte assertions for controls, OSC/ANSI payloads, bidi, invisibles, newlines, and long diagnostics;
5. DOM-sink review and browser XSS fixtures;
6. browser assertions for no analyze/copy requests, no DDL in URL/storage, effective CSP, and null service-worker controller;
7. CLI assertions for stdout/stderr separation and generic unexpected-failure behavior;
8. clean public build/test/package without private files;
9. envelope/provenance validation and approved private-to-public projection and independent publication review;
10. dependency, workflow-permission, action-pin, and release-provenance review.
