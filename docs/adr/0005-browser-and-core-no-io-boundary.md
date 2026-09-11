# ADR 0005: Browser and core no-I/O boundary

## Status

Accepted

## Context

DDL may contain sensitive schema and infrastructure detail. The checker must work at `importflow.dev/check` without sending DDL to a server, storing it, or exposing it through diagnostics. Sharing an origin does not justify absolute claims about extensions, browsers, hosting, or pre-existing service workers.

## Decision

The synchronous core performs no I/O. The browser checker is an isolated static shell with no runtime analytics, telemetry, third-party scripts, externally hosted fonts/icons/assets, persistence, or DDL-bearing URL state. Analyze and copy actions initiate no network requests. Output is inserted through text APIs.

Production deployment verification must establish a restrictive CSP and that the loaded checker page has no controlling service worker, including an assertion equivalent to `navigator.serviceWorker.controller === null`.

A same-origin static module worker may be added only if measurement justifies it; worker use does not alter core semantics.

## Consequences

- The repository can make a precise claim about checker behavior without claiming control over the endpoint or host.
- Initial static asset requests remain visible to hosting infrastructure but carry no DDL from checker behavior.
- Deployment configuration is part of release acceptance, not merely repository intent.
- Unexpected adapter failures expose only generic non-sensitive production output.

## Rejected alternatives

- Server-side DDL analysis or optional metadata connections.
- Runtime analytics or error telemetry on the checker page.
- Treating “we do not register a worker” as sufficient service-worker isolation.
- Requiring a dedicated origin for v1.
- Requiring Blob workers or making a worker part of core behavior.
