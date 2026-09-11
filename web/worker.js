import { checkCompatibility } from "../src/index.ts";
import { renderRefusalReport } from "../src/report-renderer.ts";

// One request per worker. A fresh worker isolates every check and can be terminated.
self.onmessage = (event) => {
  try {
    const input = event.data;
    let report;
    if (
      input?.kind === "check" &&
      input.bytes instanceof Uint8Array &&
      input.bytes.buffer instanceof ArrayBuffer
    ) {
      report = checkCompatibility(input.bytes);
    } else if (input?.kind === "refusal" && input.refusalId === "browser_lone_surrogate") {
      // Browser-only admission checks use the existing authoritative renderer.
      report = renderRefusalReport({ refusalId: input.refusalId });
    } else {
      self.postMessage({ kind: "error" });
      return;
    }
    self.postMessage({ kind: "report", report });
  } catch {
    self.postMessage({ kind: "error" });
  }
};
