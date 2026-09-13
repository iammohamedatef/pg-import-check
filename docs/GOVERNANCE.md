# Profile governance

PG Import Check combines useful static PostgreSQL evidence with a clearly labeled
comparison against a dated target-schema profile. The profile is not a universal
PostgreSQL standard and does not decide current commercial eligibility.

## Reproducibility and versioning

Published profile bytes, predicates and deterministic report authorities are versioned
and immutable. Policy or semantic changes require a new applicable version and
regression evidence. Documentation and UI changes must not silently change that behavior.
There is no online profile substitution or automatic update during analysis.

The `spec/` directory contains the complete public profile, catalogue, provenance,
reason templates and synthetic profile cases used by the evaluator. Digests allow
readers to verify that the shipped material matches its declared identity.

The catalogue records whether a profile is active, deprecated or withdrawn and identifies
its replacement when available. Offline copies cannot establish a later policy change
or current commercial availability. A withdrawal cannot remotely revoke downloaded code.

## Reviewing a change

A meaningful change should explain its effect on recognized syntax, target association,
value authority, outcomes, coverage, evidence text and bounded-resource behavior.
Regressions must preserve the distinction between observation, derivation, unverified
behavior and recommendation. Security and privacy checks are release requirements.

UI-only work must retain deterministic engine output and privacy boundaries. New runtime
dependencies, remote services or changes to source/report handling require explicit review.

## Public distribution

This repository is a standalone, independently buildable source distribution. The
publication manifest records the exact distributed files and hashes. All public build
and test inputs are included; no internal repository or credential is needed to build it.

Use the documented supported boundary and versioned sources when reproducing a result.
For contribution and security-reporting procedures, see [Contributing](CONTRIBUTING.md)
and [Security](SECURITY.md).
