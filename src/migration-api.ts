import {
  createMigrationDocumentIndex,
  type MigrationDocumentRefusal,
  type MigrationTargetCandidate,
} from "./migration-document.js";
import { evaluateMigrationTarget } from "./migration-evaluator.js";
import { applyMigrationInputProfile, type MigrationInputRefusal } from "./migration-input.js";
import { renderMigrationTargetReport } from "./migration-report.js";
import { displayQualifiedIdentity } from "./report-safe-display.js";

export type MigrationDiscoveryTarget = {
  readonly key: string;
  readonly displayName: string;
  readonly scope: MigrationTargetCandidate["scope"];
  readonly hasBaseDeclaration: boolean;
  readonly declarationCount: number;
  readonly sourceLine: number;
};

export type MigrationDiscoveryResult =
  | {
      readonly kind: "discovered";
      readonly byteLength: number;
      readonly statementCount: number;
      readonly targets: readonly MigrationDiscoveryTarget[];
    }
  | {
      readonly kind: "refused";
      readonly refusal: MigrationInputRefusal | MigrationDocumentRefusal;
    };

/** v0.2 bounded document discovery. No SQL is executed and no schema is inferred. */
export function discoverMigration(input: Uint8Array): MigrationDiscoveryResult {
  const admitted = applyMigrationInputProfile(input);
  if (admitted.kind === "refused") return admitted;
  const indexed = createMigrationDocumentIndex(admitted.input);
  if (indexed.kind === "refused") return indexed;
  return {
    kind: "discovered",
    byteLength: admitted.input.rawBytes.byteLength,
    statementCount: indexed.index.statements.length,
    targets: indexed.index.targets.map(discoveryTarget),
  };
}

/** Stateless v0.2 convenience API. Browser target switching retains an index in its worker. */
export function checkMigrationTarget(input: Uint8Array, targetKey: string): string | null {
  const admitted = applyMigrationInputProfile(input);
  if (admitted.kind === "refused") return null;
  const indexed = createMigrationDocumentIndex(admitted.input);
  if (indexed.kind === "refused") return null;
  const evaluated = evaluateMigrationTarget(indexed.index, targetKey);
  return evaluated === null ? null : renderMigrationTargetReport(evaluated);
}

function discoveryTarget(target: MigrationTargetCandidate): MigrationDiscoveryTarget {
  return {
    key: target.key,
    displayName: displayQualifiedIdentity(target.identity),
    scope: target.scope,
    hasBaseDeclaration: target.declarationStatementOrdinals.length === 1,
    declarationCount: target.declarationStatementOrdinals.length,
    sourceLine: target.firstSeenSpan.start.line,
  };
}

export { createMigrationDocumentIndex } from "./migration-document.js";
export { evaluateMigrationTarget } from "./migration-evaluator.js";
export { applyMigrationInputProfile, MAX_MIGRATION_DOCUMENT_BYTES } from "./migration-input.js";
export { renderMigrationTargetReport } from "./migration-report.js";
