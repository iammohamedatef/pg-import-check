import { recognizeDdl } from "./ddl-recognizer.js";
import { applyRawInputProfile } from "./input-profile.js";
import { evaluatePublicProfile } from "./policy-evaluator.js";
import { renderAnalyzedReport, renderRefusalReport } from "./report-renderer.js";

/** Supplied DDL observations only; no I/O, live evidence or production approval. */
export function checkCompatibility(input: Uint8Array): string {
  const admitted = applyRawInputProfile(input);
  if (admitted.kind === "refused") return renderRefusalReport(admitted);
  const recognized = recognizeDdl(admitted);
  if (recognized.kind === "refused")
    return renderRefusalReport(recognized.refusal, admitted.rawBytes);
  return renderAnalyzedReport(evaluatePublicProfile(recognized.evidence, admitted.rawBytes));
}
