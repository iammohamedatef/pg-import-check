// Presentation and the bounded UTF-16 transport adapter only. Policy stays in the worker.
const ddl = document.getElementById("ddl");
const check = document.getElementById("check");
const example = document.getElementById("example");
const reset = document.getElementById("reset");
const copy = document.getElementById("copy");
const report = document.getElementById("report");
const status = document.getElementById("status");
const result = document.getElementById("result");
const title = document.getElementById("result-title");
const summary = document.getElementById("result-summary");
const empty = document.getElementById("empty-state");
const inputNote = document.getElementById("input-note");

const MAX_BYTES = 262_144;
const MAX_CODE_UNITS = MAX_BYTES + 1;
const TIMEOUT_MS = 15_000;
const INTERNAL_ERROR = "pg-import-check could not complete the check because of an internal error.";
const EXAMPLE = `CREATE TABLE public.contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  full_name text,
  subscribed boolean,
  created_at timestamptz DEFAULT now()
);
`;

const outcomes = new Map([
  [
    "outside_envelope_observed",
    [
      "Structural conflict observed",
      "Explicit declarations conflict with the dated Alpha profile. Review the findings below with ImportFlow.",
    ],
  ],
  [
    "more_evidence_required",
    [
      "More evidence required",
      "A declared feature or missing declaration requires ImportFlow review. See the findings below.",
    ],
  ],
  [
    "no_structural_conflict_observed",
    [
      "No structural conflict observed",
      "No structural conflict was observed among the declarations evaluated. ImportFlow review is still required; this is not production approval.",
    ],
  ],
  [
    "refused",
    [
      "Analysis refused",
      "Full analysis is unavailable for this input. This is not a finding of ImportFlow incompatibility. See the report for the reason and next step.",
    ],
  ],
]);

let worker = null;
let timer = null;
let revision = 0;
let currentReport = "";

function stopWorker() {
  revision += 1;
  clearTimeout(timer);
  timer = null;
  if (worker) worker.terminate();
  worker = null;
  result.setAttribute("aria-busy", "false");
  check.textContent = "Check schema →";
}

function clearReport() {
  currentReport = "";
  copy.disabled = true;
  copy.textContent = "Copy report";
  report.textContent = "";
  report.hidden = true;
  report.scrollTop = 0;
  report.scrollLeft = 0;
}

function ready(message) {
  stopWorker();
  clearReport();
  result.dataset.outcome = "empty";
  title.textContent = "Ready when you are";
  summary.textContent =
    "Run a check to see observations, findings, and the areas that need ImportFlow review.";
  empty.hidden = false;
  status.textContent = message;
}

function internalError() {
  stopWorker();
  clearReport();
  result.dataset.outcome = "error";
  title.textContent = "Check could not complete";
  summary.textContent = INTERNAL_ERROR;
  empty.hidden = true;
  status.textContent = INTERNAL_ERROR;
  title.focus({ preventScroll: true });
}

// Only the trusted, fixed-position report header determines the summary.
// Never search diagnostics or identifiers for verdict-like text.
function reportOutcome(text) {
  const lines = text.split("\n", 6);
  if (lines[0] !== "PG IMPORT CHECK" || !text.endsWith("\n")) return null;
  if (
    lines[1] === "profile: importflow-envelope-v4 | 2026-09-09" &&
    /^REFUSED: [a-z0-9_]+$/.test(lines[2])
  )
    return "refused";
  if (
    lines[1] !==
      "profile: importflow-envelope-v4 | ImportFlow Founder-Assisted Alpha — target-schema check profile" ||
    lines[2] !== "as of: 2026-09-09 | offline snapshot; current availability not verified" ||
    !lines[3]?.startsWith("target: ")
  )
    return null;
  const match =
    /^TEXT-ONLY VERDICT: (outside_envelope_observed|more_evidence_required|no_structural_conflict_observed)$/.exec(
      lines[4],
    );
  return match ? match[1] : null;
}

// Recognition contract §3.7: size lower bound, lone-surrogate validation,
// exact byte length, then encoding. No allocation proportional to unbounded input.
function prepareInput(text) {
  // A cap-plus-one sentinel lets the core own the size refusal without encoding
  // or transferring an oversized string. The core checks length before content.
  if (text.length > MAX_BYTES) return { kind: "check", bytes: new Uint8Array(MAX_CODE_UNITS) };
  let byteLength = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        return { kind: "refusal", refusalId: "browser_lone_surrogate" };
      i += 1;
      byteLength += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { kind: "refusal", refusalId: "browser_lone_surrogate" };
    } else {
      byteLength += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  if (byteLength > MAX_BYTES) return { kind: "check", bytes: new Uint8Array(MAX_CODE_UNITS) };
  return { kind: "check", bytes: new TextEncoder().encode(text) };
}

function runCheck() {
  stopWorker();
  clearReport();
  const run = revision;
  result.dataset.outcome = "running";
  result.setAttribute("aria-busy", "true");
  title.textContent = "Checking locally…";
  summary.textContent =
    "Analyzing the supplied DDL on your device. You can reset or edit the input to cancel.";
  empty.hidden = true;
  check.textContent = "Restart check →";
  status.textContent = "Checking your schema locally…";
  try {
    // The static build replaces this placeholder with the bundled worker URL.
    worker = new Worker(new URL("__WORKER_URL__", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      if (run !== revision) return;
      const data = event.data;
      const outcome =
        data?.kind === "report" && typeof data.report === "string"
          ? reportOutcome(data.report)
          : null;
      if (!outcome) {
        internalError();
        return;
      }
      stopWorker();
      currentReport = data.report;
      report.textContent = currentReport;
      report.hidden = false;
      copy.disabled = false;
      result.dataset.outcome = outcome;
      const [heading, explanation] = outcomes.get(outcome);
      title.textContent = heading;
      summary.textContent = explanation;
      status.textContent = `${heading}. Report ready.`;
      title.focus({ preventScroll: true });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (run === revision) internalError();
    };
    worker.onmessageerror = () => {
      if (run === revision) internalError();
    };
    timer = setTimeout(() => {
      if (run === revision) internalError();
    }, TIMEOUT_MS);
    const input = prepareInput(ddl.value);
    worker.postMessage(input, input.kind === "check" ? [input.bytes.buffer] : []);
  } catch {
    internalError();
  }
}

document.getElementById("check-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runCheck();
});

ddl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    runCheck();
  }
});

ddl.addEventListener("input", () => {
  ready("Input changed. Run a check for an updated report.");
  inputNote.textContent =
    ddl.value.length >= MAX_CODE_UNITS
      ? "The editor limit is reached. Reduce the input; the checker accepts at most 262,144 UTF-8 bytes."
      : "Your edits stay in this page. Run a check when ready.";
});

ddl.addEventListener("paste", (event) => {
  if (!event.clipboardData) return;
  const pasted = event.clipboardData.getData("text/plain");
  const length = ddl.value.length - (ddl.selectionEnd - ddl.selectionStart) + pasted.length;
  if (length > MAX_CODE_UNITS) {
    // Reject instead of silently checking a browser-truncated schema.
    event.preventDefault();
    const message =
      "Paste was not inserted: the editor accepts at most 262,145 code units. Reduce the DDL to 262,144 UTF-8 bytes for analysis.";
    inputNote.textContent = message;
    status.textContent = message;
  }
});

example.addEventListener("click", () => {
  ddl.value = EXAMPLE;
  ready("Example loaded. Run a check to see its report.");
  inputNote.textContent = "Example: one public.contacts table. Edit it or check it as supplied.";
  ddl.focus();
});

reset.addEventListener("click", () => {
  ddl.value = "";
  ready("Reset complete. Input and report cleared.");
  inputNote.textContent = "Start with your DDL or load the example.";
  ddl.focus();
});

// Native selection copying can omit the final LF or include visual wrapping.
// Preserve exact bytes when the complete report is selected for manual copying.
report.addEventListener("copy", (event) => {
  const selection = window.getSelection();
  if (
    currentReport &&
    event.clipboardData &&
    selection?.rangeCount === 1 &&
    selection.getRangeAt(0).toString() === currentReport
  ) {
    event.preventDefault();
    event.clipboardData.setData("text/plain", currentReport);
  }
});

copy.addEventListener("click", async () => {
  if (!currentReport) return;
  const snapshot = currentReport;
  const run = revision;
  try {
    await navigator.clipboard.writeText(snapshot);
    if (run !== revision) return;
    status.textContent = "Report copied to clipboard.";
  } catch {
    if (run !== revision) return;
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(report);
      selection.removeAllRanges();
      selection.addRange(range);
      report.focus();
      status.textContent =
        "Clipboard access unavailable. Report selected; use your device’s Copy command.";
    } else {
      status.textContent = "Clipboard access unavailable. Select and copy the report manually.";
    }
  }
});

window.addEventListener("pagehide", () => ready("Ready. Run a new check to see your report."));
check.disabled = false;
example.disabled = false;
reset.disabled = false;
