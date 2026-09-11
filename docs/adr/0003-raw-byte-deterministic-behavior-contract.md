# ADR 0003: Raw-byte deterministic behavior contract

## Status

Accepted

## Context

CLI input arrives as bytes, while browser input arrives as a JavaScript UTF-16 string. Invalid UTF-8, BOM handling, lone surrogates, line endings, Unicode normalization, locale behavior, and rendering changes can otherwise make “same input” ambiguous. A promise covering every runtime forever is not testable.

## Decision

The canonical core accepts `Uint8Array`. The browser rejects lone UTF-16 surrogates before UTF-8 encoding. DDL recognition v1 defines strict decoding, BOM, line, Unicode and accepted-language behavior. `check-behavior-v2` defines reports; `importflow-envelope-v4` independently versions the public compatibility profile.

For fixed behavior/envelope versions and a stable raw input byte sequence, conforming released builds must emit identical UTF-8 result bytes on the declared runtime matrix. Expected handled refusals are covered; unexpected software defects are not.

## Consequences

- CLI and browser share one byte-oriented core after an explicit browser adapter.
- Intentional byte changes require behavior-version review.
- Envelope changes do not require inventing additional public profile versions.
- Visual font/terminal width and pre-adapter browser transformations are outside the contract.

## Rejected alternatives

- A string-only canonical API.
- Silent replacement of invalid UTF-8 or lone surrogates.
- Unicode normalization of PostgreSQL identifiers.
- Four independent user-facing behavior profile versions.
- “Every runtime, forever” and universal visual-alignment claims.
