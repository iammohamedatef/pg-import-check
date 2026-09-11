// Checked against the approved public JSON before every build. No runtime I/O.
export const PROFILE = {
  envelope_version: "importflow-envelope-v4",
  authority_status: "release_authoritative",
  purpose:
    "DDL-only observations against a bounded ImportFlow target-schema profile; never production admission",
  display_name: "ImportFlow Founder-Assisted Alpha — target-schema check profile",
  applicability: {
    stage: "Founder-Assisted Alpha",
    as_of: "2026-09-09",
    destination_context: "Supabase-hosted PostgreSQL",
    postgresql_major: 17,
    integration_context:
      "The Alpha offering uses a supported React/Next.js integration; this checker does not assess application eligibility.",
    offline_currentness_claim: false,
  },
  lifecycle: {
    supersedes: "importflow-envelope-v3",
    supersedes_scope: "unpublished candidate lineage only; no earlier public support commitment",
    replaced_by: null,
    status_catalogue: "spec/profile-catalogue.json",
  },
  behavior_version: "check-behavior-v2",
  predicate_authority: "docs/PUBLIC_PROFILE_V4.md",
  recognition_authority: "docs/DDL_RECOGNITION_V1.md",
  input: {
    api: "checkCompatibility(input: Uint8Array): string",
    evidence: "supplied_ddl_only",
    live_evidence_input_allowed: false,
  },
  results: {
    refusal: "refused",
    conflict: "outside_envelope_observed",
    unresolved: "more_evidence_required",
    structural_success: "no_structural_conflict_observed",
    precedence: [
      "refused",
      "outside_envelope_observed",
      "more_evidence_required",
      "no_structural_conflict_observed",
    ],
    production_admission_result_allowed: false,
  },
  operation: {
    evaluated: "insert_target_structure",
    unsupported_use_cases: [
      "update",
      "upsert",
      "merge",
      "overwrite",
      "delete",
      "row_tolerant_write",
    ],
    operation_input_allowed: false,
  },
  limits: {
    columns: 1600,
    target_constraints: 2048,
    enum_labels_per_type: 4096,
    enum_label_utf8_bytes: 63,
  },
  builtin_type_spellings: {
    text: ["text"],
    varchar: ["varchar"],
    smallint: ["smallint", "int2"],
    integer: ["integer", "int", "int4"],
    bigint: ["bigint", "int8"],
    numeric: ["numeric", "decimal"],
    boolean: ["boolean", "bool"],
    date: ["date"],
    timestamp: ["timestamp"],
    timestamptz: ["timestamptz"],
    uuid: ["uuid"],
  },
  known_rejected_type_spellings: [
    "json",
    "jsonb",
    "bytea",
    "real",
    "float4",
    "float8",
    "money",
    "time",
    "timetz",
    "interval",
    "inet",
    "cidr",
    "macaddr",
    "macaddr8",
    "bit",
    "varbit",
    "xml",
    "tsvector",
    "tsquery",
    "int4range",
    "int8range",
    "numrange",
    "tsrange",
    "tstzrange",
    "daterange",
    "int4multirange",
    "int8multirange",
    "nummultirange",
    "tsmultirange",
    "tstzmultirange",
    "datemultirange",
  ],
  rules: [
    {
      id: "target_schema_outside_profile",
      outcome: "outside_envelope_observed",
      predicate: "P01",
    },
    {
      id: "target_schema_unresolved",
      outcome: "more_evidence_required",
      predicate: "P01",
    },
    {
      id: "partitioned_target",
      outcome: "outside_envelope_observed",
      predicate: "P02",
    },
    {
      id: "relation_review_required",
      outcome: "more_evidence_required",
      predicate: "P02",
    },
    {
      id: "primary_key_missing_from_input",
      outcome: "more_evidence_required",
      predicate: "P03",
    },
    {
      id: "composite_primary_key",
      outcome: "outside_envelope_observed",
      predicate: "P03",
    },
    {
      id: "identifier_contains_space",
      outcome: "outside_envelope_observed",
      predicate: "P04",
    },
    {
      id: "identifier_review_required",
      outcome: "more_evidence_required",
      predicate: "P04",
    },
    {
      id: "column_type_outside_profile",
      outcome: "outside_envelope_observed",
      predicate: "P05",
    },
    {
      id: "type_review_required",
      outcome: "more_evidence_required",
      predicate: "P05",
    },
    {
      id: "enum_definition_outside_profile",
      outcome: "outside_envelope_observed",
      predicate: "P06",
    },
    {
      id: "enum_review_required",
      outcome: "more_evidence_required",
      predicate: "P06",
    },
    {
      id: "identity_type_outside_profile",
      outcome: "outside_envelope_observed",
      predicate: "P07",
    },
    {
      id: "value_generation_review_required",
      outcome: "more_evidence_required",
      predicate: "P07",
    },
    {
      id: "foreign_key_mapping_review_required",
      outcome: "more_evidence_required",
      predicate: "P08",
    },
    {
      id: "check_review_required",
      outcome: "more_evidence_required",
      predicate: "P09",
    },
    {
      id: "index_review_required",
      outcome: "more_evidence_required",
      predicate: "P10",
    },
    {
      id: "insert_trigger_shape_outside_profile",
      outcome: "outside_envelope_observed",
      predicate: "P11",
    },
    {
      id: "insert_trigger_review_required",
      outcome: "more_evidence_required",
      predicate: "P11",
    },
    {
      id: "policy_review_required",
      outcome: "more_evidence_required",
      predicate: "P12",
    },
    {
      id: "schema_size_outside_profile",
      outcome: "outside_envelope_observed",
      predicate: "P13",
    },
  ],
  external_review_always_required: [
    "actual_live_schema_and_omitted_objects",
    "effective_destination_authorization",
    "tenant_isolation_and_trusted_system_values",
    "final_mapping_and_identity_choices",
    "trigger_privileged_function_and_rewrite_effects",
    "installation_and_production_approval",
    "workload_and_data_validation",
  ],
  report_notice_authority: {
    semantics:
      "external_review_always_required identifiers are non-rendered policy categories. The rendering authority exclusively owns exact analyzed-report and refusal notice bytes.",
    rendering_authority: "docs/CHECK_BEHAVIOR_V2.md",
    section: "3",
  },
} as const;

export const REASON_MESSAGES = {
  target_schema_outside_profile:
    "The explicitly named target schema is outside this public profile.",
  target_schema_unresolved: "The supplied target does not name its schema.",
  partitioned_target: "The supplied target declares partitioning, outside this public profile.",
  relation_review_required: "Temporary or inherited target behavior requires ImportFlow review.",
  primary_key_missing_from_input: "No primary key was declared in the supplied input.",
  composite_primary_key: "The declared primary key contains more than one column.",
  identifier_contains_space: "A target-profile identifier contains an ASCII space.",
  identifier_review_required: "A target-profile identifier requires Unicode compatibility review.",
  column_type_outside_profile:
    "A supplied column declares a type shape outside this public profile.",
  type_review_required:
    "A supplied type identity or modifier cannot be resolved by this public check.",
  enum_definition_outside_profile: "A supplied enum violates a public label restriction.",
  enum_review_required: "A supplied enum requires Unicode label review.",
  identity_type_outside_profile: "A declared identity column has a resolved non-integer type.",
  value_generation_review_required:
    "Declared generation/default behavior requires ImportFlow review.",
  foreign_key_mapping_review_required: "Foreign-key mapping requires a reviewed source of values.",
  check_review_required: "A supplied CHECK expression is not evaluated by this public check.",
  index_review_required: "A supplied unique index requires import-relevance review.",
  insert_trigger_shape_outside_profile:
    "An INSERT trigger declares an unsupported constraint or WHEN shape.",
  insert_trigger_review_required:
    "An INSERT trigger and its function effects require ImportFlow review.",
  policy_review_required:
    "Supplied RLS or policy declarations require effective-authorization review.",
  schema_size_outside_profile: "The supplied target exceeds a public schema-profile ceiling.",
} as const;

export type ReasonId = keyof typeof REASON_MESSAGES;
export type AnalyzedResult = Exclude<(typeof PROFILE.results.precedence)[number], "refused">;
export type TypeFamily = keyof typeof PROFILE.builtin_type_spellings;
