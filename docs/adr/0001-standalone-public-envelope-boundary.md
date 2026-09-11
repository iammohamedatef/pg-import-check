# ADR 0001: Public target-schema observation boundary

Status: adopted for the successor public profile.

ImportFlow owns product and production-admission authority. A public DDL checker
consumes an explicitly reviewed, dated projection of observable schema restrictions.
Its rules and evaluation mechanics are wholly available in this distribution. Private
traceability is maintained outside public builds. No production gate state or internal
architecture is a public evaluator input.

Publication requires separate projection and independent publication reviews. The
selected public export preserves reproducibility without redistributing private audit
lineage. Detailed lifecycle and ownership are in `docs/GOVERNANCE.md`.
