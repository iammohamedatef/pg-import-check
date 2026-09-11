# ADR 0004: Bounded PostgreSQL-shaped recognition profile

## Status

Accepted

## Context

The checker needs a small, browser-capable recognition profile and must refuse rather than guess. It accepts selected PostgreSQL-shaped statement shells and safely delimited opaque regions; those regions prevent a claim that the whole accepted language is literally a PostgreSQL grammar subset. A full PostgreSQL grammar accepts far more syntax than the product analyzes, adds a substantial dependency and browser surface, and still requires a separate semantic allowlist. A casual SQL splitter or keyword regex cannot safely handle nested comments, strings, dollar bodies, or hostile input.

## Decision

Production uses a hand-written lexer and parser for the exact language in `DDL_RECOGNITION_V1.md`. It fully consumes input, retains opaque expressions only where their boundaries are safe, rejects ambiguity, and uses iterative input-bounded scanning.

The recognizer does not claim to validate arbitrary PostgreSQL. Trusted fixtures may be checked offline against disposable PostgreSQL instances. Arbitrary user or fuzz input is never executed.

## Consequences

- Accepted syntax is intentionally smaller than PostgreSQL.
- Valid PostgreSQL outside the profile may refuse with an actionable reason.
- Language expansion is a reviewed behavior change, not an incidental parser fix.
- The lexer and parser become security-sensitive code requiring hostile-input and complexity evidence.

## Rejected alternatives

- Shipping PostgreSQL grammar/WASM in the production browser bundle.
- Regex-based statement splitting or body-effect classification.
- Parsing a recognized prefix and ignoring remaining tokens.
- Accepting uncertain unquoted non-ASCII identifier semantics.
- Broad permissive parsing followed by undocumented semantic guesses.
