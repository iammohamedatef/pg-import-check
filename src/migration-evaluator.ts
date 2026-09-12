import { validateMigrationGeneration } from "./migration-generation.js";
import {
  deriveImportContract,
  type ImportContract,
  type ImportContractColumn,
} from "./migration-contract.js";
import { deriveMigrationStructure, type MigrationStructure } from "./migration-structure.js";
import { deriveMigrationCoverage, type MigrationCoverage } from "./migration-coverage.js";
import {
  ddlQualifiedIdentityKey,
  type DdlAlterConstraint,
  type DdlEvidence,
  type DdlRefusal,
} from "./ddl-evidence.js";
import type { IdentifierIdentity } from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import { recognizeDdl } from "./ddl-recognizer.js";
import { applyRawInputProfile, type RawInputResult } from "./input-profile.js";
import {
  planMigrationTargetAssociation,
  type GeneratedColumnEvidence,
  type MigrationNotEvaluated,
} from "./migration-association.js";
import type {
  MigrationDocumentIndex,
  MigrationStatement,
  MigrationTargetCandidate,
} from "./migration-document.js";
import {
  normalizeStatementForV02,
  type V02RecognitionObservation,
} from "./migration-normalization.js";
import {
  evaluatePublicProfile,
  type EvaluatedColumn,
  type PolicyEvaluation,
} from "./policy-evaluator.js";
import { orderedReasons, selectResult } from "./policy-findings.js";
import { PROFILE, type AnalyzedResult, type ReasonId } from "./public-profile.js";

export type MigrationTargetRefusal =
  | DdlRefusal
  | Extract<RawInputResult, { readonly kind: "refused" }>;

export type MigrationObserved = {
  readonly columnCount: number;
  readonly primaryKeyColumns: readonly IdentifierIdentity[];
  readonly uniqueConstraintCount: number;
  readonly foreignKeyCount: number;
  readonly enumBackedColumnCount: number;
  readonly generatedColumnCount: number;
  readonly associatedAlterConstraintCount: number;
  readonly uniqueIndexCount: number;
  readonly triggerCount: number;
  readonly policyCount: number;
  readonly rlsStatementCount: number;
};

export type MigrationProfileEvaluation = Omit<PolicyEvaluation, "columns"> & {
  readonly columns: readonly {
    readonly name: IdentifierIdentity;
    readonly disposition: ImportContractColumn["state"];
    readonly authority: ImportContractColumn["authority"];
    readonly reasonIds: readonly ReasonId[];
  }[];
};

export type MigrationTargetEvidence = {
  readonly target: MigrationTargetCandidate;
  readonly result: AnalyzedResult | "refused";
  readonly policy: PolicyEvaluation | MigrationProfileEvaluation | null;
  readonly evidence: DdlEvidence | null;
  readonly refusal: MigrationTargetRefusal | null;
  readonly notEvaluated: readonly MigrationNotEvaluated[];
  readonly recognitionObservations: readonly V02RecognitionObservation[];
  readonly includedStatements: readonly MigrationStatement[];
  readonly alterConstraintSources: readonly MigrationAlterConstraintSource[];
  readonly generatedColumns: readonly GeneratedColumnEvidence[];
  readonly observed: MigrationObserved | null;
  readonly coverage?: MigrationCoverage;
  readonly contract?: ImportContract;
  readonly structure?: MigrationStructure;
};

export type MigrationTargetEvaluation = Omit<MigrationTargetEvidence, "policy"> & {
  readonly policy: MigrationProfileEvaluation | null;
  readonly coverage: MigrationCoverage;
  readonly contract: ImportContract;
  readonly structure: MigrationStructure;
};

export type MigrationAlterConstraintSource = {
  readonly constraintKind: "primary_key" | "unique" | "foreign_key" | "check";
  readonly constraintName: IdentifierIdentity | null;
  readonly columnCount: number | null;
  /** Original full-document source span, before target projection. */
  readonly span: SourceSpan;
};

export function evaluateMigrationTarget(
  index: MigrationDocumentIndex,
  targetKey: string,
): MigrationTargetEvaluation | null {
  const evaluation = evaluateMigrationTargetCore(index, targetKey);
  if (evaluation === null) return null;
  const covered = { ...evaluation, coverage: deriveMigrationCoverage(index, evaluation) };
  let referenceStatementsRemaining = 64;
  let referenceBytesRemaining = 262_144;
  const typeStatements = index.statements.filter((s) => s.kind === "create_type");
  const structure = deriveMigrationStructure(index, covered, (key) => {
    const candidate = index.targetByKey.get(key);
    if (candidate === undefined) return null;
    const plan = planMigrationTargetAssociation(index, candidate);
    if (plan.base === null) return null;
    // Bound all supplemental recognition work, including type declarations, before parsing.
    const supporting = [plan.base, ...plan.supportedStatements, ...typeStatements];
    const statementCost = supporting.length + plan.generatedColumns.length;
    const byteCost =
      supporting.reduce(
        (sum, s) => sum + s.span.end.rawByteOffset - s.span.start.rawByteOffset,
        0,
      ) +
      plan.generatedColumns.reduce(
        (sum, g) => sum + g.span.end.rawByteOffset - g.span.start.rawByteOffset,
        0,
      );
    if (statementCost > referenceStatementsRemaining || byteCost > referenceBytesRemaining)
      return null;
    referenceStatementsRemaining -= statementCost;
    referenceBytesRemaining -= byteCost;
    const referenced = evaluateMigrationTargetCore(index, key);
    return referenced === null
      ? null
      : { ...referenced, coverage: deriveMigrationCoverage(index, referenced) };
  });
  const contract = deriveImportContract(covered);
  return {
    ...covered,
    policy:
      covered.policy === null
        ? null
        : {
            ...covered.policy,
            columns: contract.columns.map((column, ordinal) => ({
              name: structure.columns[ordinal]?.name ?? column.name,
              disposition: column.state,
              authority: column.authority,
              reasonIds: column.reasonIds,
            })),
          },
    coverage: deriveMigrationCoverage(
      index,
      evaluation,
      structure.foreignKeys.flatMap((f) => f.supportingStatementOrdinals),
    ),
    contract: {
      ...contract,
      columns: contract.columns.map((column, ordinal) => {
        const original = structure.columns[ordinal];
        if (original === undefined) throw new Error("Contract source association invariant");
        return { ...column, name: original.name, span: original.span };
      }),
    },
    structure,
  };
}

function evaluateMigrationTargetCore(
  index: MigrationDocumentIndex,
  targetKey: string,
): MigrationTargetEvidence | null {
  const target = index.targetByKey.get(targetKey);
  if (target === undefined) return null;
  const plan = planMigrationTargetAssociation(index, target);
  const notEvaluated = [...plan.notEvaluated];
  if (plan.base === null || plan.base.relationModifier === "unlogged") {
    return {
      target,
      result: "more_evidence_required",
      policy: null,
      evidence: null,
      refusal: null,
      notEvaluated,
      recognitionObservations: [],
      includedStatements: [],
      alterConstraintSources: [],
      generatedColumns: plan.generatedColumns,
      observed: null,
    };
  }

  const baseNormalized = normalizeStatementForV02(index.input, plan.base);
  let chunks: Uint8Array[] = [baseNormalized.bytes];
  const observations: V02RecognitionObservation[] = [...baseNormalized.observations];
  const baseRecognition = recognizeChunks(chunks);
  if (baseRecognition.kind === "refused") {
    return {
      target,
      result: "refused",
      policy: null,
      evidence: null,
      refusal: baseRecognition.refusal,
      notEvaluated,
      recognitionObservations: observations,
      includedStatements: [plan.base],
      alterConstraintSources: [],
      generatedColumns: plan.generatedColumns,
      observed: null,
    };
  }

  const includedStatements: MigrationStatement[] = [plan.base];
  const alterConstraintSources: MigrationAlterConstraintSource[] = [];
  let projectedEvidence = baseRecognition.evidence;
  const typeKeys = new Set(
    baseRecognition.evidence.columns.map((column) => ddlQualifiedIdentityKey(column.type.name)),
  );
  for (const typeKey of typeKeys) {
    const declarations = index.typeDeclarations.get(typeKey);
    if (declarations === undefined) continue;
    if (declarations.length !== 1) {
      notEvaluated.push({
        kind: "duplicate_type_declaration",
        statementKind: "CREATE TYPE",
        span: declarations[1]?.span ?? declarations[0]?.span ?? target.firstSeenSpan,
        detail: "The referenced type has multiple declarations in this document.",
      });
      continue;
    }
    const declaration = declarations[0];
    if (declaration === undefined) continue;
    const normalized = normalizeStatementForV02(index.input, declaration);
    const candidate = recognizeChunks([...chunks, normalized.bytes]);
    if (candidate.kind === "refused") {
      notEvaluated.push(
        notRecognized(
          declaration,
          "The referenced CREATE TYPE uses syntax this v0.2 analyzer does not evaluate.",
        ),
      );
      continue;
    }
    chunks = [...chunks, normalized.bytes];
    projectedEvidence = candidate.evidence;
    observations.push(...normalized.observations);
    includedStatements.push(declaration);
  }

  for (const statement of plan.supportedStatements) {
    const normalized = normalizeStatementForV02(index.input, statement);
    const candidate = recognizeChunks([...chunks, normalized.bytes]);
    if (candidate.kind === "refused") {
      notEvaluated.push(
        notRecognized(
          statement,
          "This exact target statement uses syntax this v0.2 analyzer does not evaluate.",
        ),
      );
      continue;
    }
    for (const addition of candidate.evidence.additions.slice(projectedEvidence.additions.length)) {
      alterConstraintSources.push(alterConstraintSource(addition, statement.span));
    }
    chunks = [...chunks, normalized.bytes];
    projectedEvidence = candidate.evidence;
    observations.push(...normalized.observations);
    includedStatements.push(statement);
  }

  const recognized = recognizeChunks(chunks);
  if (recognized.kind === "refused") {
    throw new Error("v0.2 incremental projection invariant");
  }
  const rawBytes = joinChunks(chunks);
  let policy = evaluatePublicProfile(recognized.evidence, rawBytes);
  const generation = validateMigrationGeneration(
    index,
    recognized.evidence,
    rawBytes,
    plan.generatedColumns,
  );
  notEvaluated.push(...generation.notEvaluated);
  const augmentation = augmentGeneratedColumns(policy, generation.accepted, notEvaluated);
  policy = augmentation.policy;
  notEvaluated.splice(0, notEvaluated.length, ...augmentation.notEvaluated);
  const result =
    policy.result === "outside_envelope_observed"
      ? policy.result
      : notEvaluated.length > 0
        ? "more_evidence_required"
        : policy.result;

  return {
    target,
    result,
    policy: { ...policy, result },
    evidence: recognized.evidence,
    refusal: null,
    notEvaluated,
    recognitionObservations: observations,
    includedStatements,
    alterConstraintSources,
    generatedColumns: generation.accepted,
    observed: summarizeEvidence(recognized.evidence, generation.accepted),
  };
}

function alterConstraintSource(
  addition: DdlAlterConstraint,
  span: SourceSpan,
): MigrationAlterConstraintSource {
  switch (addition.element.kind) {
    case "table_key": {
      const constraint = addition.element.constraint;
      return {
        constraintKind: constraint.kind,
        constraintName: constraint.explicitConstraintName?.name ?? null,
        columnCount: constraint.columnReferences.length,
        span,
      };
    }
    case "table_foreign_key": {
      const constraint = addition.element.constraint;
      return {
        constraintKind: "foreign_key",
        constraintName: constraint.explicitConstraintName?.name ?? null,
        columnCount: constraint.localColumns.columnReferences.length,
        span,
      };
    }
    case "table_check": {
      const constraint = addition.element.constraint;
      return {
        constraintKind: "check",
        constraintName: constraint.explicitConstraintName?.name ?? null,
        columnCount: null,
        span,
      };
    }
  }
}

type RecognitionAttempt =
  | { readonly kind: "recognized"; readonly evidence: DdlEvidence }
  | { readonly kind: "refused"; readonly refusal: MigrationTargetRefusal };

function recognizeChunks(chunks: readonly Uint8Array[]): RecognitionAttempt {
  const bytes = joinChunks(chunks);
  const admitted = applyRawInputProfile(bytes);
  if (admitted.kind === "refused") return { kind: "refused", refusal: admitted };
  const recognized = recognizeDdl(admitted);
  return recognized.kind === "recognized"
    ? { kind: "recognized", evidence: recognized.evidence }
    : { kind: "refused", refusal: recognized.refusal };
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const separators = Math.max(0, chunks.length - 1);
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) + separators;
  const output = new Uint8Array(size);
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) output[offset++] = 0x0a;
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function notRecognized(statement: MigrationStatement, detail: string): MigrationNotEvaluated {
  return {
    kind: "relevant_statement_not_recognized",
    statementKind: statementLabel(statement),
    span: statement.span,
    detail,
  };
}

function statementLabel(statement: MigrationStatement): string {
  switch (statement.kind) {
    case "alter_table":
      return "ALTER TABLE";
    case "create_type":
      return "CREATE TYPE";
    case "create_index":
      return "CREATE UNIQUE INDEX";
    case "create_policy":
      return "CREATE POLICY";
    case "create_trigger":
      return "CREATE TRIGGER";
    case "drop_policy":
      return "DROP POLICY";
    case "drop_table":
      return "DROP TABLE";
    case "drop_trigger":
      return "DROP TRIGGER";
    case "create_table":
      return "CREATE TABLE";
    case "other":
      return "SQL statement";
    case "empty":
      return "empty statement";
  }
}

function augmentGeneratedColumns(
  evaluation: PolicyEvaluation,
  generated: readonly GeneratedColumnEvidence[],
  existingNotEvaluated: readonly MigrationNotEvaluated[],
): { readonly policy: PolicyEvaluation; readonly notEvaluated: MigrationNotEvaluated[] } {
  const reasons = new Set<ReasonId>(evaluation.reasonIds);
  const columns = evaluation.columns.map((column) => ({
    ...column,
    reasonIds: [...column.reasonIds],
  }));
  const notEvaluated = [...existingNotEvaluated];

  for (const generation of generated) {
    const matching = columns
      .map((column, ordinal) => ({ column, ordinal }))
      .filter(({ column }) => column.name.identity === generation.column.identity);
    if (matching.length !== 1) {
      notEvaluated.push({
        kind: "generation_column_not_in_base",
        statementKind: "ALTER TABLE",
        span: generation.span,
        detail: `Value-generation evidence could not be associated with exactly one declared column (${generation.column.identity}).`,
      });
      continue;
    }
    const matched = matching[0];
    if (matched === undefined) continue;
    reasons.add("value_generation_review_required");
    const columnReasons = new Set<ReasonId>(matched.column.reasonIds);
    columnReasons.add("value_generation_review_required");
    const disposition: EvaluatedColumn["disposition"] =
      matched.column.disposition === "outside public type profile" ||
      matched.column.disposition === "type requires ImportFlow review"
        ? matched.column.disposition
        : "excluded from file mapping by the ordinary generation/default rule";
    columns[matched.ordinal] = {
      ...matched.column,
      disposition,
      reasonIds: orderedReasons(columnReasons),
    };
  }

  return {
    policy: {
      ...evaluation,
      result: selectResult(reasons),
      reasonIds: orderedReasons(reasons),
      columns,
    },
    notEvaluated,
  };
}

function summarizeEvidence(
  evidence: DdlEvidence,
  generated: readonly GeneratedColumnEvidence[],
): MigrationObserved {
  const primaryKeyColumns: IdentifierIdentity[] = [];
  let uniqueConstraintCount = 0;
  let foreignKeyCount = evidence.associated.tableForeignKeyConstraints.length;
  for (const constraint of evidence.associated.tableKeyConstraints) {
    if (constraint.kind === "primary_key") {
      primaryKeyColumns.push(...constraint.columnReferences);
    } else uniqueConstraintCount += 1;
  }
  for (const column of evidence.columns) {
    for (const clause of column.clauseOccurrences) {
      if (clause.kind === "primary_key") primaryKeyColumns.push(column.name);
      else if (clause.kind === "unique") uniqueConstraintCount += 1;
      else if (clause.kind === "references") foreignKeyCount += 1;
    }
  }
  const enumKeys = new Set(evidence.enums.keys());
  return {
    columnCount: evidence.columns.length,
    primaryKeyColumns,
    uniqueConstraintCount,
    foreignKeyCount,
    enumBackedColumnCount: evidence.columns.filter((column) =>
      enumKeys.has(ddlQualifiedIdentityKey(column.type.name)),
    ).length,
    generatedColumnCount: new Set([
      ...evidence.columns.flatMap((column) =>
        column.clauseOccurrences.some(
          (clause) =>
            clause.kind === "default" ||
            clause.kind === "generated_stored" ||
            clause.kind === "identity",
        )
          ? [column.name.identity]
          : [],
      ),
      ...generated.map((entry) => entry.column.identity),
    ]).size,
    associatedAlterConstraintCount: evidence.additions.length,
    uniqueIndexCount: evidence.indexes.filter((index) => index.unique).length,
    triggerCount: evidence.triggers.length,
    policyCount: evidence.policies.length,
    rlsStatementCount: evidence.rls.length,
  };
}

export function reasonOutcome(reasonId: ReasonId): AnalyzedResult {
  const rule = PROFILE.rules.find((candidate) => candidate.id === reasonId);
  if (rule === undefined) throw new Error(`Unknown profile reason: ${reasonId}`);
  return rule.outcome;
}
