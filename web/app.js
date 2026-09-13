// Browser presentation and bounded UTF-16/file transport only. SQL policy stays in the worker/core.
const ddl = document.getElementById("ddl");
const check = document.getElementById("check");
const example = document.getElementById("example");
const reset = document.getElementById("reset");
const copy = document.getElementById("copy");
const report = document.getElementById("report");
const reportView = document.getElementById("report-view");
const rawReportDetails = document.getElementById("raw-report-details");
const status = document.getElementById("status");
const result = document.getElementById("result");
const title = document.getElementById("result-title");
const summary = document.getElementById("result-summary");
const empty = document.getElementById("empty-state");
const inputNote = document.getElementById("input-note");
const discovery = document.getElementById("discovery");
const targets = document.getElementById("targets");
const documentMeta = document.getElementById("document-meta");
const fileInput = document.getElementById("file-input");
const fileState = document.getElementById("file-state");
const bridge = document.getElementById("commercial-bridge");
const dropZone = document.getElementById("drop-zone");

const MAX_BYTES = 2_097_152;
const MAX_CODE_UNITS = MAX_BYTES + 1;
const TIMEOUT_MS = 15_000;
const INTERNAL_ERROR =
  "pg-import-check could not complete the local analysis because of an internal error.";
const FILE_PROMPT = "Choose or drop a .sql file.";
const EXAMPLE = `CREATE TABLE public.contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE auth.contacts (
  id bigint PRIMARY KEY,
  email text NOT NULL
);

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_email_unique UNIQUE (email);
`;

const outcomes = new Map([
  [
    "outside_envelope_observed",
    [
      "Structural conflict observed",
      "Supplied deterministic evidence conflicts with the current Alpha target-schema profile.",
    ],
  ],
  [
    "more_evidence_required",
    [
      "More evidence required",
      "No evaluated conflict takes precedence, but profile or NOT_EVALUATED facts require technical review.",
    ],
  ],
  [
    "no_structural_conflict_observed",
    [
      "No structural conflict observed",
      "No structural conflict was observed in the evaluated evidence. Live/runtime review is still required.",
    ],
  ],
  [
    "refused",
    [
      "Analysis refused",
      "The selected target could not be safely evaluated under the bounded v0.3 recognition path.",
    ],
  ],
]);

let worker = null;
let timer = null;
let nextRequestId = 1;
let pending = null;
let currentReport = "";
let currentTargets = [];
let fileReadRevision = 0;
let documentLoaded = false;

function terminateWorker() {
  clearTimeout(timer);
  timer = null;
  pending = null;
  if (worker) worker.terminate();
  worker = null;
  result.setAttribute("aria-busy", "false");
}

function clearReport() {
  bridge.hidden = true;
  currentReport = "";
  copy.disabled = true;
  copy.textContent = "Copy report";
  report.textContent = "";
  reportView.replaceChildren();
  reportView.hidden = true;
  rawReportDetails.hidden = true;
  rawReportDetails.open = false;
}

function clearDiscovery() {
  currentTargets = [];
  documentLoaded = false;
  targets.replaceChildren();
  documentMeta.textContent = "";
  discovery.hidden = true;
}

function showReady(message) {
  clearReport();
  result.dataset.outcome = "empty";
  result.setAttribute("aria-busy", "false");
  title.textContent = "Ready when you are";
  summary.textContent =
    "Analyze a document, then select a discovered target to see its deterministic report.";
  empty.hidden = false;
  status.textContent = message;
  check.textContent = "Discover tables →";
}

function invalidateAnalysis(message) {
  terminateWorker();
  clearDiscovery();
  showReady(message);
}

function internalError() {
  terminateWorker();
  clearDiscovery();
  clearReport();
  result.dataset.outcome = "error";
  title.textContent = "Analysis could not complete";
  summary.textContent = INTERNAL_ERROR;
  empty.hidden = true;
  status.textContent = INTERNAL_ERROR;
  check.textContent = "Retry discovery →";
  title.focus({ preventScroll: true });
}

function showDocumentFailure(refusalId) {
  terminateWorker();
  clearDiscovery();
  clearReport();
  result.dataset.outcome = "refused";
  empty.hidden = true;
  const messages = {
    document_input_too_large: [
      "Document too large",
      "This v0.3 release accepts at most 2,097,152 UTF-8 bytes for one migration document.",
    ],
    invalid_utf8: [
      "Invalid UTF-8 document",
      "The supplied file is not valid UTF-8 and was not analyzed.",
    ],
    nul_byte_not_in_profile: [
      "Unsupported document byte",
      "The supplied document contains a NUL byte, which is outside the accepted input profile.",
    ],
    browser_lone_surrogate: [
      "Invalid browser text input",
      "The pasted text contains an unpaired UTF-16 surrogate and cannot be encoded without changing it.",
    ],
    document_too_many_statements: [
      "Document exceeds analysis limits",
      "The migration contains more top-level statements than this bounded analyzer permits.",
    ],
    document_too_many_tokens: [
      "Document exceeds analysis limits",
      "The migration contains more SQL tokens than this bounded analyzer permits.",
    ],
    document_too_many_targets: [
      "Document exceeds analysis limits",
      "The migration contains more target candidates than this bounded analyzer permits.",
    ],
    document_string_semantics_not_in_profile: [
      "Unsupported string semantics",
      "The migration changes standard_conforming_strings to a mode this bounded analyzer does not interpret.",
    ],
    document_target_lifecycle_not_bounded: [
      "Unsupported target lifecycle statement",
      "A target lifecycle statement could not be associated safely and the document was not analyzed.",
    ],
  };
  const malformed = new Set([
    "unterminated_block_comment",
    "unterminated_quoted_identifier",
    "unterminated_string",
    "unterminated_dollar_quote",
    "syntax_not_in_profile",
    "unicode_escape_syntax_not_in_profile",
    "unquoted_non_ascii_identifier",
    "identifier_outside_profile",
    "identifier_contains_unsafe_character",
  ]);
  const [heading, explanation] =
    messages[refusalId] ??
    (malformed.has(refusalId)
      ? [
          "Malformed or unsupported document",
          `Safe document discovery stopped at a bounded lexical rule (${refusalId}).`,
        ]
      : ["Document analysis refused", `Safe document discovery stopped (${refusalId}).`]);
  title.textContent = heading;
  summary.textContent = explanation;
  status.textContent = `${heading}. ${explanation}`;
  check.textContent = "Retry discovery →";
  title.focus({ preventScroll: true });
}

function showNoTargets(statementCount, byteLength) {
  clearReport();
  result.dataset.outcome = "refused";
  result.setAttribute("aria-busy", "false");
  title.textContent = "No table targets found";
  summary.textContent =
    "The document was indexed, but it contained no CREATE TABLE or meaningful ALTER TABLE target candidate.";
  empty.hidden = true;
  status.textContent = `Indexed ${statementCount} statements (${formatBytes(byteLength)}); no table targets were found.`;
  check.textContent = "Rediscover tables →";
  title.focus({ preventScroll: true });
}

function ensureWorker() {
  if (worker) return worker;
  const instance = new Worker(new URL("__WORKER_URL__", import.meta.url), { type: "module" });
  worker = instance;
  instance.onmessage = (event) => {
    if (worker !== instance) return;
    handleWorkerMessage(event.data);
  };
  instance.onerror = (event) => {
    event.preventDefault();
    if (worker === instance) internalError();
  };
  instance.onmessageerror = () => {
    if (worker === instance) internalError();
  };
  return instance;
}

function beginRequest(kind, targetKey = null) {
  if (pending !== null) throw new Error("Only one worker request may be active at a time.");
  const requestId = nextRequestId++;
  pending = { requestId, kind, targetKey };
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (pending?.requestId === requestId) internalError();
  }, TIMEOUT_MS);
  return requestId;
}

function finishRequest(requestId) {
  if (pending?.requestId !== requestId) return false;
  clearTimeout(timer);
  timer = null;
  pending = null;
  result.setAttribute("aria-busy", "false");
  setTargetButtonsDisabled(false);
  return true;
}

function handleWorkerMessage(data) {
  if (!data || !Number.isSafeInteger(data.requestId) || pending?.requestId !== data.requestId)
    return;
  const active = pending;
  if (data.kind === "error") {
    internalError();
    return;
  }
  if (data.kind === "document_refused" && typeof data.refusalId === "string") {
    finishRequest(data.requestId);
    showDocumentFailure(data.refusalId);
    return;
  }
  if (active.kind === "load" && data.kind === "discovered" && Array.isArray(data.targets)) {
    finishRequest(data.requestId);
    renderDiscovery(data);
    return;
  }
  if (
    active.kind === "evaluate" &&
    data.kind === "report" &&
    data.targetKey === active.targetKey &&
    typeof data.report === "string" &&
    outcomes.has(data.outcome)
  ) {
    finishRequest(data.requestId);
    renderEvaluation(data.outcome, data.report, data.decision, data.technicalSections);
    return;
  }
  internalError();
}

function scopeLabel(target) {
  if (!target.hasBaseDeclaration) return "base declaration incomplete";
  if (target.scope === "public") return "public profile candidate";
  if (target.scope === "outside_public_profile") return "outside public-schema profile";
  return "schema unresolved";
}

function renderDiscovery(data) {
  currentTargets = data.targets;
  documentLoaded = true;
  targets.replaceChildren();
  documentMeta.textContent = `${data.targets.length} target${data.targets.length === 1 ? "" : "s"} · ${data.statementCount} statements · ${formatBytes(data.byteLength)}`;
  discovery.hidden = false;
  check.textContent = "Rediscover tables →";

  for (const target of data.targets) {
    const item = document.createElement("div");
    item.className = "target-item";
    item.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";
    button.dataset.targetKey = target.key;
    button.setAttribute("aria-pressed", "false");
    const identity = document.createElement("code");
    identity.textContent = target.displayName;
    const meta = document.createElement("span");
    meta.className = "target-meta";
    meta.textContent = `${scopeLabel(target)} · line ${target.sourceLine}`;
    button.append(identity, meta);
    button.addEventListener("click", () => evaluateTarget(target.key));
    item.append(button);
    targets.append(item);
  }

  if (data.targets.length === 0) {
    discovery.hidden = true;
    showNoTargets(data.statementCount, data.byteLength);
    return;
  }

  result.dataset.outcome = "empty";
  empty.hidden = false;
  title.textContent = "Choose a target table";
  summary.textContent =
    "The migration is indexed locally. Select one exact table identity to generate its report.";
  status.textContent = `Found ${data.targets.length} target${data.targets.length === 1 ? "" : "s"}. Choose a table to evaluate.`;
  if (data.targets.length === 1) evaluateTarget(data.targets[0].key);
}

function setTargetButtonsDisabled(disabled) {
  for (const button of targets.querySelectorAll("button.target-button")) button.disabled = disabled;
}

function markSelectedTarget(targetKey) {
  for (const button of targets.querySelectorAll("button.target-button")) {
    const selected = button.dataset.targetKey === targetKey;
    button.setAttribute("aria-pressed", String(selected));
    button.classList.toggle("selected", selected);
  }
}

function evaluateTarget(targetKey) {
  if (
    !documentLoaded ||
    pending !== null ||
    !currentTargets.some((target) => target.key === targetKey)
  )
    return;
  clearReport();
  markSelectedTarget(targetKey);
  setTargetButtonsDisabled(true);
  result.dataset.outcome = "running";
  result.setAttribute("aria-busy", "true");
  title.textContent = "Evaluating selected target…";
  summary.textContent = "Using the retained local document index and associated target evidence.";
  empty.hidden = true;
  status.textContent = "Evaluating the selected target locally…";
  try {
    const requestId = beginRequest("evaluate", targetKey);
    ensureWorker().postMessage({ kind: "evaluate", requestId, targetKey });
  } catch {
    internalError();
  }
}

function renderEvaluation(outcome, text, decision, technicalSections) {
  if (!decision || !Array.isArray(decision.sections) || !Array.isArray(technicalSections)) {
    internalError();
    return;
  }
  currentReport = text;
  report.textContent = text;
  reportView.replaceChildren();
  const sectionOrder = [
    "DECISION",
    "TARGET",
    "IMPORT CONTRACT",
    "PRIMARY FINDINGS",
    "DATABASE BEHAVIOR",
    "COVERAGE",
    "BOTTOM LINE",
    "NEXT REVIEW",
  ];
  const presentedSections = [...decision.sections].sort(
    (a, b) => sectionOrder.indexOf(a.heading) - sectionOrder.indexOf(b.heading),
  );
  for (const section of presentedSections) {
    const container = document.createElement("section");
    container.className = "report-section decision-section";
    container.dataset.decisionSection = section.heading;
    const heading = document.createElement("h3");
    heading.textContent = section.heading.charAt(0) + section.heading.slice(1).toLowerCase();
    const body = document.createElement("ul");
    body.className = "decision-facts";
    for (const fact of section.facts) {
      const item = document.createElement("li");
      const basis = document.createElement("span");
      basis.className = "fact-basis";
      basis.textContent = `${fact.basis}: `;
      item.append(basis, document.createTextNode(fact.text));
      body.append(item);
    }
    container.append(heading, body);
    reportView.append(container);
  }
  const technical = document.createElement("details");
  technical.id = "technical-evidence";
  technical.className = "raw-report-details";
  const label = document.createElement("summary");
  label.textContent =
    "Technical Evidence — declarations, rule identifiers and statement accounting";
  technical.append(label);
  for (const section of technicalSections) {
    const container = document.createElement("section");
    container.className = "report-section";
    container.dataset.section = section.heading;
    const heading = document.createElement("h3");
    heading.textContent = section.heading.charAt(0) + section.heading.slice(1).toLowerCase();
    const body = document.createElement("pre");
    body.className = "report-section-body";
    body.textContent = section.body;
    container.append(heading, body);
    technical.append(container);
  }
  reportView.append(technical);
  reportView.hidden = false;
  rawReportDetails.hidden = false;
  copy.disabled = false;
  result.dataset.outcome = outcome;
  const [heading, explanation] = outcomes.get(outcome);
  title.textContent = heading;
  summary.textContent = `${decision.coverage}. ${explanation}`;
  empty.hidden = true;
  status.textContent = `${decision.decision}. Report ready; select another table to reuse the current document index.`;
  const outside = outcome === "outside_envelope_observed";
  document.getElementById("bridge-title").textContent = outside
    ? "This target has a conflict with the dated Alpha profile."
    : "Need to go beyond static analysis?";
  document.getElementById("bridge-copy").textContent = outside
    ? "ImportFlow’s current pilot covers a narrow one-table, insert-only Supabase scope. This report does not establish eligibility. Review the commercial scope before considering a pilot."
    : "If a real customer is waiting on this import, ImportFlow’s pilot helps you prepare a one-table, insert-only migration into Supabase. Your engineer executes the production import.";
  document.getElementById("bridge-price").hidden = outside;
  document.getElementById("bridge-link").textContent = outside
    ? "See the current pilot scope ↗"
    : "Talk through this migration ↗";
  bridge.hidden = false;
  title.focus({ preventScroll: true });
  if (window.matchMedia("(max-width: 68rem)").matches) result.scrollIntoView({ block: "start" });
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function oversizedSentinel() {
  return new Uint8Array(MAX_BYTES + 1);
}

function prepareText(text) {
  if (text.length > MAX_BYTES) return { kind: "load", bytes: oversizedSentinel() };
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
  if (byteLength > MAX_BYTES) return { kind: "load", bytes: oversizedSentinel() };
  return { kind: "load", bytes: new TextEncoder().encode(text) };
}

function analyzeBytes(bytes) {
  terminateWorker();
  clearDiscovery();
  clearReport();
  result.dataset.outcome = "running";
  result.setAttribute("aria-busy", "true");
  title.textContent = "Discovering tables locally…";
  summary.textContent = "Building the bounded document index in a Web Worker on this device.";
  empty.hidden = true;
  status.textContent = "Discovering table targets locally…";
  check.textContent = "Restart discovery →";
  try {
    const requestId = beginRequest("load");
    ensureWorker().postMessage({ kind: "load", requestId, bytes }, [bytes.buffer]);
  } catch {
    internalError();
  }
}

function analyzeText() {
  const prepared = prepareText(ddl.value);
  if (prepared.kind === "refusal") {
    invalidateAnalysis("Input could not be encoded safely.");
    showDocumentFailure(prepared.refusalId);
    return;
  }
  analyzeBytes(prepared.bytes);
}

async function loadLocalFile(file) {
  const revision = ++fileReadRevision;
  terminateWorker();
  clearDiscovery();
  showReady("Reading the selected local file…");
  if (!file.name.toLowerCase().endsWith(".sql")) {
    fileInput.value = "";
    fileState.textContent = FILE_PROMPT;
    status.textContent = "Choose a .sql file. No file content was analyzed.";
    return;
  }
  fileState.textContent = `${file.name} · ${formatBytes(file.size)}`;
  if (file.size > MAX_BYTES) {
    ddl.value = "";
    showDocumentFailure("document_input_too_large");
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (revision !== fileReadRevision) return;
    try {
      ddl.value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      ddl.value = "";
    }
    inputNote.textContent = `${file.name} is loaded from this device only; analysis runs in the local worker.`;
    analyzeBytes(bytes);
  } catch {
    if (revision !== fileReadRevision) return;
    internalError();
  }
}

document.getElementById("check-form").addEventListener("submit", (event) => {
  event.preventDefault();
  analyzeText();
});

ddl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    analyzeText();
  }
});

ddl.addEventListener("input", () => {
  fileReadRevision += 1;
  fileInput.value = "";
  fileState.textContent = FILE_PROMPT;
  invalidateAnalysis("Input changed. Discover tables again for the updated document.");
  inputNote.textContent =
    ddl.value.length >= MAX_CODE_UNITS
      ? "The editor limit is reached. Reduce the input; v0.3 accepts at most 2,097,152 UTF-8 bytes."
      : "Edits stay on this page. Discover tables when ready.";
});

ddl.addEventListener("paste", (event) => {
  if (!event.clipboardData) return;
  const pasted = event.clipboardData.getData("text/plain");
  const length = ddl.value.length - (ddl.selectionEnd - ddl.selectionStart) + pasted.length;
  if (length > MAX_CODE_UNITS) {
    event.preventDefault();
    const message =
      "Paste was not inserted: the editor accepts at most 2,097,153 code units so oversized input is never silently truncated.";
    inputNote.textContent = message;
    status.textContent = message;
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadLocalFile(file);
});

for (const name of ["dragenter", "dragover"]) {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dropZone.classList.add("drag-active");
  });
}
for (const name of ["dragleave", "dragend"]) {
  dropZone.addEventListener(name, () => dropZone.classList.remove("drag-active"));
}
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-active");
  const files = event.dataTransfer?.files;
  if (files?.length !== 1) {
    status.textContent = "Drop exactly one local .sql file.";
    return;
  }
  void loadLocalFile(files[0]);
});

example.addEventListener("click", () => {
  fileReadRevision += 1;
  fileInput.value = "";
  fileState.textContent = FILE_PROMPT;
  terminateWorker();
  clearDiscovery();
  ddl.value = EXAMPLE;
  showReady("Example loaded. Discover its tables to begin.");
  inputNote.textContent = "Synthetic example: one public target and one non-public target.";
  ddl.focus();
});

reset.addEventListener("click", () => {
  fileReadRevision += 1;
  fileInput.value = "";
  fileState.textContent = FILE_PROMPT;
  ddl.value = "";
  terminateWorker();
  clearDiscovery();
  showReady("Reset complete. Document, target index, file state, and report are cleared.");
  inputNote.textContent = "The document is indexed locally only when you analyze it.";
  ddl.focus();
});

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
  try {
    await navigator.clipboard.writeText(snapshot);
    if (snapshot !== currentReport) return;
    status.textContent = "Report copied to clipboard.";
  } catch {
    if (snapshot !== currentReport) return;
    rawReportDetails.hidden = false;
    rawReportDetails.open = true;
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(report);
      selection.removeAllRanges();
      selection.addRange(range);
      report.focus();
      status.textContent =
        "Clipboard access unavailable. Raw report selected; use your device’s Copy command.";
    } else {
      status.textContent =
        "Clipboard access unavailable. Open the raw report and copy it manually.";
    }
  }
});

window.addEventListener("pagehide", () => terminateWorker());
check.disabled = false;
example.disabled = false;
reset.disabled = false;
