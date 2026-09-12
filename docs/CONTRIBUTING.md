# Contributions

Submit contributions under the repository's MIT license and only when you have the
right to do so. Do not include customer schemas, credentials, confidential review
records or third-party material without its attribution and compatible rights.

Public policy changes require ImportFlow product-owner authorization, projection
review and independent publication review under GOVERNANCE.md. A checker patch cannot
independently broaden ImportFlow support. Structural language changes require a
separate reviewed behavior change; no parser expansion is part of this release.

Never describe tests, static findings or a fork as production approval. Report
potentially sensitive security findings by email to [mohamed@importflow.dev](mailto:mohamed@importflow.dev) rather than putting customer or secret material in a public issue.

## Development

Use Node 24 and the npm version pinned in package metadata:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run build:web
npx playwright install chromium firefox webkit
npm run test:e2e
npm run preview
```

The preview listens on `http://127.0.0.1:4173`. Rebuild after source changes. `src/`
is the no-I/O semantic core, `cli/` is the stdin adapter, and `web/` owns browser
presentation and the worker. See [architecture](ARCHITECTURE.md) and
[migration analyzer v0.2](MIGRATION_ANALYZER_V02.md) before changing a document
boundary. Do not add analytics or send DDL to any endpoint. Keep schema examples
synthetic and never record real input in test traces or issue attachments.

Frozen recognition and release-authoritative policy changes require a separate
reviewed proposal; UI work must not change those semantics. Meaningful checks include
exact reports and process exits, real browser privacy/XSS tests, input limits,
keyboard/mobile behavior, and clean production builds. Tests use no live database.

For a future approved profile update, update the browser's fixed-position report
header metadata and visible profile/date together with the embedded profile; the
CLI/browser conformance matrix must continue to compare exact report bytes.
