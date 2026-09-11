# Public evaluator implementation

The synchronous source entry point is `src/index.ts`; after `npm run build`, import
`checkCompatibility` from `dist/src/index.js`. It accepts stable `Uint8Array` bytes and
returns the exact plain-text report defined by CHECK_BEHAVIOR_V2. The CLI and browser worker use this same API; see [architecture](ARCHITECTURE.md).
The project is distributed as buildable source, not a published npm registry package.

```js
import { checkCompatibility } from './dist/src/index.js';
const bytes = new TextEncoder().encode(
  'CREATE TABLE public.contacts (id integer PRIMARY KEY, email text);',
);
const report = checkCompatibility(bytes);
```

## Architecture and authority

`input-profile` snapshots and validates bytes. The `ddl-*` adapters implement the
already-specified statement shells using unchanged lexical/structural primitives,
then associate the complete declaration set and select recognition refusals.
`policy-evaluator`, `policy-types` and `policy-findings` consume that typed evidence.
`report-renderer` and `report-safe-display` own trusted text and input interpolation.
The public entry point composes these responsibilities without I/O or catch-all error
conversion. Unexpected programming defects propagate separately from handled refusals.

`public-profile.ts` embeds the full approved JSON and trusted messages. Every build
compares them with the public JSON, verifies the approved authority digests and requires
matching release-authoritative status. There is no runtime JSON parsing, filesystem
read, profile download, private checkout or caller-selected policy.

## Maintained predicate traceability

Each row names the evidence consumed after successful recognition. “None” means that
predicate adds no reason; it never means live approval. Every numbered predicate has
executable public conformance coverage in `compatibility-conformance.test.ts` and
boundary/interaction coverage in `compatibility-predicates.test.ts`.

| Predicate | Evidence | Disposition and reason identity | Representative executable cases |
| --- | --- | --- | --- |
| P01 | Exact target schema component or absent qualification | Conflict `target_schema_outside_profile`; unresolved `target_schema_unresolved`; otherwise none | simple_target, other_schema, unqualified_target, quoted_schema_case |
| P02 | TEMP, INHERITS and terminal PARTITION BY observations | Conflict `partitioned_target`; unresolved `relation_review_required`; otherwise none | partitioned, temporary, inherits |
| P03 | Unique associated inline/table/ALTER PK and its member count | Conflict `composite_primary_key`; unresolved `primary_key_missing_from_input`; otherwise none | missing_key, composite_key; ALTER positive and composite boundary tests |
| P04 | Target/column/constraint/used-enum normalized identifier components | Conflict `identifier_contains_space`; unresolved `identifier_review_required`; otherwise none | spaced_identifier, unicode_identifier; per-component and column association tests |
| P05 | Frozen type identity/qualification/quoted form, unsigned modifier spans, array count | Conflict `column_type_outside_profile`; unresolved `type_review_required`; otherwise none | all public type cases; every approved builtin and rejected spelling; numeric boundaries |
| P06 | Associated enum identity, exact decoded ordered labels | Conflict `enum_definition_outside_profile`; unresolved `enum_review_required`; otherwise none | enum_ascii, enum_unicode, enum_long, enum_count_over; control/UTF-8/count/shared-enum boundaries |
| P07 | Resolved family plus identity/stored/default/serial observations | Conflict `identity_type_outside_profile`; unresolved `value_generation_review_required`; otherwise none | ordinary_default, identity_integer, identity_uuid, all serial cases; defaults/stored/zero-candidate tests |
| P08 | All associated FK occurrences and local member identities | Unresolved `foreign_key_mapping_review_required`; otherwise none; no DDL-only hard mapping conflict | foreign_key; NULL/NOT NULL/default/identity FK and composite ALTER tests |
| P09 | All inline/table/ALTER CHECK occurrences | Unresolved `check_review_required`; otherwise none; opaque expressions never classified | check, check_cross_column; ALTER CHECK and constraint-count tests |
| P10 | Fully consumed standalone index and uniqueness flag | Unresolved `index_review_required` for unique; otherwise none | unique_index, non_unique_index, partial_index_refusal |
| P11 | Trigger INSERT event membership, constraint and WHEN flags | Conflict `insert_trigger_shape_outside_profile`; unresolved `insert_trigger_review_required`; otherwise none | insert_trigger, trigger_when; mixed triggers, constraint trigger, non-INSERT SECURITY DEFINER function tests |
| P12 | Any associated policy or either RLS state axis | Unresolved `policy_review_required`; otherwise none | rls; default policy, disable/no-force tests |
| P13 | Column count and modeled PK/UNIQUE/FK/CHECK counts including ALTER | Conflict `schema_size_outside_profile`; otherwise none | columns_at_limit, columns_over_limit, constraint_limit; exact constraint ceiling and simultaneous ceiling tests |

Recognition ambiguity (including duplicate enum labels) prevents policy evaluation.
Names inside defaults, CHECKs and function bodies do not create policy evidence.
Qualified/quoted/modified serial lookalikes remain ordinary accepted type spans;
recognition §5.0 defines only smallserial/serial/bigserial lowering.

## Ordering and output

Input and recognition refusal stages finish before policy runs. Every applicable
predicate runs. Result selection uses the profile's explicit precedence list;
distinct reasons and each column's associated reasons use the profile's explicit
rule order. Discovery order and collection insertion order do not choose report bytes.
Columns retain declaration order. Column presentation follows the behavior contract's
type conflict, type review, generation/default exclusion, then candidate precedence.

Every analyzed outcome includes exactly the behavior-owned ImportFlow review block.
External category identifiers are metadata, never additional notice text. Missing
static evidence does not establish live absence; function semantics, mapping,
authorization, installation and production admission remain external.

## Verification and resource bounds

`npm run verify` checks formatting, lint, types, all existing structural tests, the
56 real evaluator cases, additional predicate/precedence/refusal/report/security
coverage, package safety and public authority integrity. Renderer tests use bounded
exact goldens; evaluator tests also check report grammar, notices, reason order and
repeat-call byte equality. A deterministic 2,000-input mutation corpus exercises
the public API with hostile bytes. Frozen-fixture replay compares the new adapter
against the original table reader without changing either the original source or
its fixtures. Source-only public exports run the same checks independently.

The raw 262,144-byte cap and frozen demand-driven delimiter/token behavior remain.
Enum policy is scanned once per supplied definition and reused across columns.
Modifier digits are read only from established spans with saturated arithmetic.
Policy findings are a finite set, column lookup is indexed, and report construction
is linear in emitted rows. Structural modeled-set ordering and semantic-candidate
sorting may require O(observations log observations); no pairwise declaration scans
or source rescans per predicate are used. Hostile near-cap tests exercise long opaque
regions, modifier digits, shared large enums and many auxiliary declarations. Test
runner timeouts detect regressions; elapsed time never selects a semantic outcome.
