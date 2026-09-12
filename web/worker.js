import { applyMigrationInputProfile } from "../src/migration-input.ts";
import { createMigrationDocumentIndex } from "../src/migration-document.ts";
import { evaluateMigrationTarget } from "../src/migration-evaluator.ts";
import { deriveMigrationDecision } from "../src/migration-decision.ts";
import {
  migrationTechnicalSections,
  renderMigrationTargetReport,
} from "../src/migration-report.ts";
import { displayQualifiedIdentity } from "../src/report-safe-display.ts";

let currentIndex = null;

function reply(requestId, message) {
  self.postMessage({ requestId, ...message });
}

function refusal(requestId, refusalId) {
  currentIndex = null;
  reply(requestId, { kind: "document_refused", refusalId });
}

self.onmessage = (event) => {
  const input = event.data;
  const requestId = input?.requestId;
  if (!Number.isSafeInteger(requestId) || requestId < 0) {
    self.postMessage({ kind: "error" });
    return;
  }

  try {
    if (input.kind === "reset") {
      currentIndex = null;
      reply(requestId, { kind: "reset" });
      return;
    }

    if (input.kind === "load") {
      currentIndex = null;
      if (!(input.bytes instanceof Uint8Array) || !(input.bytes.buffer instanceof ArrayBuffer)) {
        reply(requestId, { kind: "error" });
        return;
      }
      const admitted = applyMigrationInputProfile(input.bytes);
      if (admitted.kind === "refused") {
        refusal(requestId, admitted.refusal.refusalId);
        return;
      }
      const indexed = createMigrationDocumentIndex(admitted.input);
      if (indexed.kind === "refused") {
        refusal(requestId, indexed.refusal.refusalId);
        return;
      }
      currentIndex = indexed.index;
      reply(requestId, {
        kind: "discovered",
        byteLength: currentIndex.input.rawBytes.byteLength,
        statementCount: currentIndex.statements.length,
        targets: currentIndex.targets.map((target) => ({
          key: target.key,
          displayName: displayQualifiedIdentity(target.identity),
          scope: target.scope,
          hasBaseDeclaration: target.declarationStatementOrdinals.length === 1,
          declarationCount: target.declarationStatementOrdinals.length,
          sourceLine: target.firstSeenSpan.start.line,
        })),
      });
      return;
    }

    if (input.kind === "evaluate") {
      if (currentIndex === null || typeof input.targetKey !== "string") {
        reply(requestId, { kind: "error" });
        return;
      }
      const evaluation = evaluateMigrationTarget(currentIndex, input.targetKey);
      if (evaluation === null) {
        reply(requestId, { kind: "error" });
        return;
      }
      const decision = deriveMigrationDecision(evaluation);
      const technicalSections = migrationTechnicalSections(evaluation, decision);
      reply(requestId, {
        kind: "report",
        targetKey: input.targetKey,
        outcome: evaluation.result,
        report: renderMigrationTargetReport(evaluation, decision, technicalSections),
        decision,
        technicalSections,
      });
      return;
    }

    reply(requestId, { kind: "error" });
  } catch {
    currentIndex = null;
    reply(requestId, { kind: "error" });
  }
};
