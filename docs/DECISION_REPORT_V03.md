# Decision Report and Import Contract (v0.3)

The migration analyzer turns supplied PostgreSQL declarations into a deterministic,
target-local decision report. It does not execute SQL, inspect a database, read source
rows or establish production readiness. The dated ImportFlow Alpha profile remains
`importflow-envelope-v4`. The stdin CLI and its v0.1 reports remain reproducible.

## Report layers

The first layer shows the exact target, decision, coverage, grouped import contract,
up to six primary findings, concise database behavior, next review needs and a
one-to-three-fact bottom line. Technical Evidence expands into columns, named
constraints, enum labels, FK identities, trigger/policy declarations, original source
locations, rule identifiers and the complete statement ledger. The copied plain-text
report contains both layers. First-read groups show up to eight identities, with an
explicit pointer to remaining Technical Evidence. Long first-read facts are bounded
to a 384-scalar preview; the contract and technical participant lists retain identities. Rendering uses text nodes, including hostile identifiers.

Each first-layer statement is labeled Observed, Derived, Not evaluated or
Recommendation. Recommendations use fixed templates and never prescribe destructive
schema changes. Neither layer uses an LLM or infers business meaning from column names.

## Statement accounting and coverage

Each indexed top-level statement has exactly one accounting state:

| State | Meaning |
| --- | --- |
| EVALUATED_FOR_TARGET | Recognized structural evidence used for the selected target |
| RELEVANT_NOT_EVALUATED | Associated target/type evidence not evaluated by this bounded model |
| IRRELEVANT_TO_TARGET | Established different objects or empty statements |
| UNRESOLVED_TARGET_ASSOCIATION | A supplied statement could not be safely associated; relevance is not established |
| UNSUPPORTED_DOCUMENT_STATEMENT | Contents/effects of an unmodeled statement were not interpreted |
| PARSE_REFUSED | The selected base declaration could not be safely recognized |

The sum of these categories equals statements discovered, by construction. INSERT,
UPDATE, DELETE, functions and unknown statements retain explicit ledger entries. Their
bodies are not interpreted to infer relevance. This conservatively makes coverage
partial even if such statements might concern another target. Comments and semicolons
inside protected string/function bodies do not create extra top-level statements.

Coverage is COMPLETE STATIC COVERAGE, PARTIAL STATIC COVERAGE or REFUSED. Complete
means the bounded structural declarations relevant to this selected target were
accounted for; it does not mean expressions, runtime effects, effective authorization,
live database state or source data were evaluated. Input/indexing refusal stops safely;
no complete document or target conclusion is manufactured after a refusal.

## Column contract

Column authority and proposed mapping state are separate. Authority distinguishes
file-supplied values, ordinary database DEFAULT availability, identities, computed
expressions, serial sequence defaults and unknown/review cases. Identity ALWAYS and
BY DEFAULT are distinguished where recognized in a base declaration.

Required source values follow explicit NOT NULL or primary-key evidence with no
recognized default/generation provision. Nullable source columns are optional.
An ordinary DEFAULT can provide a value when omitted; its presence does not prohibit
an explicit file value. Default expression semantics are not evaluated, so DEFAULT
availability does not guarantee that omission succeeds. Identity and computed columns
are not ordinary required source inputs. Serial is retained as a sequence-default
case rather than mislabeled as SQL identity.

Any per-column profile conflict blocks that column's proposed mapping. Unknown type
or identifier classification remains unresolved. Unevaluated target statements make
mapping provisional. Target-wide profile conflicts qualify every proposed mapping.
The contract is not a promise of support or an executable import specification.

## Structural evidence and relationships

UNIQUE constraints/indexes identify participants and composite status. FKs retain
local/referenced identities, explicit referenced columns, local nullability and the
bounded action clauses recognized by the migration path. Omitted referenced columns
are not guessed. No existing-row duplicate check occurs.

Enum labels are shown only from safely associated definitions, grouped once per type
with all affected column identities to avoid multiplying label output by column count. CHECK expressions are
bounded display previews with original source locations; expression semantics and
column references inside expressions are not inferred. Trigger timing, events, UPDATE
OF, level, WHEN presence and function identity are structural evidence. Function body
and effects remain unevaluated. RLS state declarations and policy command, roles,
USING and WITH CHECK presence do not establish effective authorization.

When an explicit FK references a visible unique/primary key with recognized database
generation, a deterministic observation says identity resolution **may** be required.
At most 32 distinct referenced targets, 64 supplemental statements and 256 KiB of
supplemental source are inspected per target report; unavailable,
unresolved or further referenced targets produce no positive generation claim.
There is no recursive dependency traversal, business-key selection, source-column
inference or multi-table plan.

## Architecture and tests

The boundaries are document indexing, target association, normalization/recognition,
profile evaluation, exhaustive coverage, import contract, structural details, decision
derivation, text rendering and browser presentation. The worker retains the document
index for target switching. The browser consumes structured presentation data and
contains no import reasoning or report-text parser.

`migration-v03.test.ts` adds eighteen independently authored acceptance cases plus
accounting, authority, source-location, FK-action and conservative relationship tests.
Cases assert machine fields and human-facing identities. Existing grammar, profile,
CLI, resource-boundary and browser privacy tests remain required. Raw third-party
corpus inputs are excluded from the public source distribution.

All prior bounds remain: 2 MiB document, 150,000 tokens, 20,000 statements, 5,000
targets, 256 associated target statements and the frozen 256 KiB target recognition
limit. No backend processing, telemetry, SQL execution or DDL network request is added.
This is an experimental internal semantic model, not a stable public JSON API contract.

Later DEFAULT/identity clauses are checked using the same bounded column grammar.
Malformed suffixes, extra clauses, competing generation declarations, or missing
integer/NOT NULL evidence for identity remain not evaluated. Suffix validation has
a shared 256 KiB budget. It does not execute default expressions or project migration
order. Supporting declarations used for a generated-key observation are counted as
evaluated target evidence in the ledger.
