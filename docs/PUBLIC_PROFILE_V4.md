# Public target-schema predicates v4

This document and `spec/importflow-envelope.v4.json` jointly define the complete
public policy. JSON owns literal sets, limits, identifiers and outcomes; the
numbered predicates below own exact interpretation. Neither delegates to private
files. The vocabulary is for supplied declarations, not catalog or runtime truth.
Candidate status does not authorize semantic implementation or release.

## Applicability and evidence

The profile describes the reviewed Founder-Assisted Alpha scope for Supabase-hosted
PostgreSQL 17 as of the date in JSON. PostgreSQL DDL alone cannot establish hosting,
server version, application integration, or ImportFlow availability. They are stated
applicability conditions, never inferred facts. Unsupported operations listed in JSON
are use-case restrictions, not an input mode: SQL DML statements refuse under the
recognition grammar rather than pretending to evaluate an operation request.

Fully parse and associate the whole input under DDL recognition v1 before evaluating
any predicate. A structural refusal takes precedence over all policy results. Never
search opaque SQL, comments or string literals to infer a type, mapping, tenant,
permission, trigger effect, operation, or a hidden declaration. Unsupported language
is analysis unavailable, not evidence of product incompatibility.

All target columns participate, including nullable, defaulted and generated columns.
Omitting a column from eventual mapping cannot rescue a proven unsupported type.
Identifier identity is precisely the recognizer's decoded identity (ASCII folding
only for unquoted words; exact quoted code points). No live name resolution occurs.

## P01 — Explicit target schema

An unqualified target produces `target_schema_unresolved`. An explicitly qualified
target whose normalized schema identity is not exactly `public` produces
`target_schema_outside_profile`. Exactly `public` adds no reason. Quoted `"public"`
matches; quoted `"Public"` does not. Names of unrelated objects never select a target.

## P02 — Relation shape

A target with a declared PARTITION BY suffix produces `partitioned_target` even if
that expression is opaque. TEMP/TEMPORARY or INHERITS produces
`relation_review_required`; neither is automatically a product conflict. An ordinary
CREATE TABLE adds no relation reason. Views, foreign tables, partition-child syntax,
and other unsupported statement forms refuse under recognition v1. A declaration
never proves that the live relation is an ordinary base table.

## P03 — Primary key

Count columns in the unique modeled primary key after inline and ALTER TABLE
association. No declared key produces `primary_key_missing_from_input`, not a claim
that the live key is absent. More than one participating column produces
`composite_primary_key`. Exactly one adds no key reason. Conflicting/repeated key
models are recognition refusals, not a policy precedence choice.

## P04 — Identifier content

Inspect target schema/table identities, all target column identities, names of target
constraints, and identities of supplied enum types used by the target. An inspected
component containing U+0020 produces `identifier_contains_space`. Any other component
containing a scalar above U+007E produces `identifier_review_required` (unless the
recognizer already refused it). Otherwise it adds no identifier reason. The fixed
recognizer safety/63-byte rules apply first. Non-ASCII review is deliberately not a
claim that ImportFlow rejects Unicode. Names outside this enumerated set are not
subject to P04; their containing objects are either unevaluated or covered below.

## P05 — Column type shapes

Operate on the accepted type span, never on arbitrary expression text. A nonempty
array suffix (`[]`, repeated any positive number of times) produces
`column_type_outside_profile`, regardless of base identity, modifiers, default or
nullability. Otherwise use the following exhaustive selection:

1. A schema-qualified reference matched by exact normalized identity to a supplied
   enum declaration is handled by P06. Modifiers on that reference produce
   `type_review_required` instead; do not interpret them as enum metadata.
2. Every other quoted or schema-qualified type name produces `type_review_required`.
   Do not treat quoted aliases as PostgreSQL built-ins or infer search_path.
3. An unqualified, unquoted name in `builtin_type_spellings` selects its listed
   family. A name in `known_rejected_type_spellings` produces
   `column_type_outside_profile`. Any other name, including `citext`, `serial` aliases
   not recognized as serial by the grammar, and unresolved custom/enum/domain types,
   produces `type_review_required`, subject to the serial rule below.
4. For a selected family without modifiers, no type reason is added.
5. For selected numeric with exactly two unsigned integer modifiers, precision must
   be 1..1000 and scale 0..1000 inclusive; a violation produces
   `column_type_outside_profile`. A numeric with one modifier requires review.
   Negative-scale syntax is outside recognition v1, not a product prohibition.
6. Every other modifier shape produces `type_review_required`, including varchar
   lengths and timestamp precision. Do not infer private bounds or catalog formatting.

A recognizer-established serial shorthand uses its corresponding smallint/integer/
bigint base family for type and identity checks; P07 still requires generation review.
Recognition §5.0 completely defines the three forms and their family mapping.
This is syntax lowering into already-listed integer/default observations, not a new
supported product type. It always remains unresolved under P07; no serial spelling
can earn structural success. Qualified, quoted or modified lookalikes remain unresolved
under the ordinary type rules (an array suffix instead triggers the array conflict).

Quoted, qualified and unknown type references intentionally remain unresolved, even
where a human could resolve them. Multiword spellings and syntax outside recognition
v1 refuse. This profile does not claim PostgreSQL syntax/typechecking validity for
opaque defaults or expressions, nor completeness of a dump.

## P06 — Supplied enum declarations

Only a schema-qualified column reference exactly matching an associated supplied enum
identity qualifies. Preserve declared label order and exact decoded standard-string
values. If labels exceed `enum_labels_per_type`, any label exceeds
`enum_label_utf8_bytes`, produce `enum_definition_outside_profile`. Duplicate decoded labels already refuse
with `ambiguous_declaration` during recognition and cannot reach P06. No deduplication
or Unicode normalization occurs.
A label with C0/C1 or DEL content (U+0000..001F or U+007F..009F) also produces that
conflict; raw NUL is already a recognition refusal. Any other label scalar above
U+007E produces `enum_review_required`. ASCII printable labels, including empty labels,
otherwise add no reason. Non-ASCII review never implies a product prohibition.
P04 also applies to the enum identity. Unqualified enum references remain unresolved.
No CREATE TYPE declaration proves a live enum identity or live label order.

## P07 — Generated, identity and defaulted columns

A recognized identity declaration on a resolved family other than smallint/integer/
bigint produces `identity_type_outside_profile`. An unresolved type retains its type
review reason; do not manufacture an identity conflict from it.

Every DEFAULT, serial shorthand, stored-generated or identity declaration produces
`value_generation_review_required`. Display `excluded from file mapping by the
ordinary generation/default rule` for these columns. This is conservative mapping
guidance, not an actual mapping or a source of values. Distinct structural facts remain
visible; precedence for the display cause is stored generation, identity, serial,
then ordinary default. No such declaration yields a mapped-file recommendation.

Trusted preassigned identity choices can require a different reviewed mapping. This
checker neither selects those choices nor proves acceptance/preservation of supplied
values. Ordinary defaults remain excluded without a blanket approval gate merely to
exclude them; the review reason concerns expression semantics, resolved identities,
and actual generation behavior. No arbitrary default call is evaluated, including
sequence/session calls. Columns without those declarations are only `file mapping
candidate — final classification requires ImportFlow review`. Zero candidates alone
is not a conflict.

## P08 — Foreign keys

Every associated target foreign-key declaration produces
`foreign_key_mapping_review_required`, with the participating column names as
structural observations. No name, type or referenced table establishes final value
origin. A required column ultimately mapped from file input cannot be a foreign key
in this Alpha scope; reviewed trusted/system or destination-generated values may
require a different decision. The DDL-only checker cannot establish the final mapping
and must not convert a NOT NULL FK directly to a product conflict or success.

Generic reference lookup, related-record creation and multi-table imports are outside
this profile's supported use case. They are not inferred from pasted FK syntax.

## P09 — CHECK constraints

Every associated CHECK produces `check_review_required`. Its safely delimited expression
is explicitly UNEVALUATED. Do not normalize SQL, resolve column/operator/function
identities, implement a private CHECK grammar, or classify a lexical pattern as safe.
This prevents structural success from hiding a possibly incompatible CHECK while
keeping exact live expression conformance in ImportFlow review.

Simple accepted primary/unique constraints add no constraint reason beyond P03/P04/P13.
Deferrable, exclusion and richer key/constraint syntax refuses under recognition v1.
No claim is made that all valid PostgreSQL constraints are recognized.

## P10 — Unique indexes

Every accepted standalone UNIQUE INDEX produces `index_review_required`: it is an
observed simple declared btree, but relevance to the chosen import needs review.
A non-unique index is consumed but not evaluated. Richer index forms refuse; the
checker must never project them into a simple index. Relevant functional, partial,
included-column, custom-opclass/collation and non-btree unique indexes require a
separately supported product scope. This checker offers no duplicate lookup or proof
of conflict-free insertion; live uniqueness remains authoritative when writing.

## P11 — Triggers, functions and rewrite behavior

For a supplied trigger whose event list includes INSERT, a CONSTRAINT trigger or
WHEN clause produces `insert_trigger_shape_outside_profile`. Otherwise produce
`insert_trigger_review_required`. Both observations can be recorded for distinct
triggers; each trigger has only its selected reason. Function bodies are UNEVALUATED,
including supplied SECURITY DEFINER functions. No body marker proves effects,
reversibility, permissions, target identity preservation or absence of external actions.

Non-insert triggers are consumed but not evaluated. Omitted triggers cannot be ruled
out. Rewrite-rule statements are not in recognition v1 and refuse. Live rewrite
behavior always requires ImportFlow review. None of these limitations authorizes
silently changing customer triggers, functions, rules or grants.

## P12 — Policies and RLS state

Any associated CREATE POLICY or RLS state declaration produces the single target-level
`policy_review_required`. Supplied enablement, force state, role names, permissive/
restrictive syntax and expressions never establish effective authorization or tenant
isolation. No RLS architecture or caller-provided approval state is evaluated.

## P13 — Observable size restrictions

If the target has more columns than `limits.columns`, or more modeled target constraints
than `limits.target_constraints`, produce `schema_size_outside_profile` (once per
exceeded category). Count PRIMARY KEY, UNIQUE, FOREIGN KEY and CHECK constraints,
inline or table-level, including accepted ALTER additions. Do not count NOT NULL,
DEFAULT, identity, generation, indexes, or wrapper names as separate constraints.
Counts refer to the associated model after recognition has resolved duplicates.
These are schema-profile ceilings, not upload-file, batch, request or service-capacity
promises. Other runtime/installation limits are outside this profile.

## Coverage and result reachability

Evaluate every applicable predicate; do not stop after the first conflict. A conflict
outranks unresolved observations. If there are no conflicts but any predicate yields
review/unresolved evidence, return `more_evidence_required`. If neither exists, return
`no_structural_conflict_observed`. Every analyzed report, including structural success,
must contain exactly the ImportFlow review block defined in `CHECK_BEHAVIOR_V2.md` §3.
The JSON external-review identifiers are semantic categories, not report text or extra
lines to render. Refusals use the separate exact refusal format in that same section.
These always-external categories do not pretend to be evaluated predicates and do not
force the unresolved verdict by themselves.

Structural success means only that the fully recognized declarations contain no
conflict or unresolved predicate in this finite public check. It is not full ImportFlow
compatibility. The same DDL cannot carry flags, comments, attestations or alternate
inputs that satisfy live review. Never expose `no_envelope_conflict_observed`, a private
admission result, an installation status, or a live fingerprint through this API.
