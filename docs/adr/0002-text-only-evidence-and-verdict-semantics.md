# ADR 0002: Reachable structural results

Status: adopted for check-behavior-v2.

A DDL-only API can report a recognized conflict, an unresolved declaration, structural
success within a finite public profile, or refusal. It cannot prove a live database,
installation or production approval. External ImportFlow review remains mandatory even
when every static predicate is resolved. No live-evidence channel is introduced.

This separates useful schema screening from production admission and prevents private
approval requirements from becoming an inaccessible public evaluator contract.
