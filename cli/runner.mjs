// Process adapter only. The evaluator owns validation, policy, and report bytes.
const INPUT_CAP = 262_144;
const INTERNAL_ERROR =
  "pg-import-check could not complete the check because of an internal error.\n";

/**
 * Dependency injection is for a separate test harness; the executable always loads
 * the built public API. No arguments or environment variables select a checker.
 */
export async function runCli({
  loadCheck,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  // Node emits 'error' as well as calling the write callback. Keep listeners for
  // the process lifetime, including errors emitted after a failed callback.
  stdout.on("error", ignoreStreamError);
  stderr.on("error", ignoreStreamError);
  let report;
  let code;
  try {
    const checkCompatibility = await loadCheck();
    const bytes = await readBoundedInput(stdin);
    // The public evaluator is synchronous. Await also contains a rejection if
    // a defective build accidentally returns a promise, avoiding a raw trace.
    report = await checkCompatibility(bytes);
    code = reportExitCode(report);
  } catch {
    stdin.destroy();
    try {
      await write(stderr, INTERNAL_ERROR);
    } catch {
      // A closed stderr cannot carry a diagnostic. Still fail without a trace.
    }
    return 1;
  }

  // A downstream reader may close before consuming the report (EPIPE). Output
  // transport failure is not an evaluator defect or a semantic refusal. Fail
  // silently, without claiming that a possibly partial report was delivered.
  // In particular, do not append an internal-error notice after report output.
  try {
    await write(stdout, report);
    return code;
  } catch {
    return 1;
  }
}

function ignoreStreamError() {}

function write(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, "utf8", (error) => (error ? reject(error) : resolve()));
  });
}

function readBoundedInput(stream) {
  return new Promise((resolve, reject) => {
    // One extra byte proves overflow; do not decode or collect an unbounded list
    // of chunks. Transport buffers belong to Node and are not retained here.
    const bytes = new Uint8Array(INPUT_CAP + 1);
    let length = 0;
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      stream.off("readable", read);
      stream.off("end", end);
      stream.off("close", close);
      if (error) reject(error);
      else resolve(bytes.subarray(0, length));
    }

    function read() {
      try {
        while (stream.readableLength > 0 && length < bytes.length) {
          const chunk = stream.read(Math.min(stream.readableLength, bytes.length - length));
          if (chunk === null) break;
          bytes.set(chunk, length);
          length += chunk.length;
        }
        if (length === bytes.length) {
          finish();
          // An oversized producer need not send EOF. Close the input so the
          // process can finish even if the producer keeps its pipe open.
          stream.destroy();
        }
      } catch (error) {
        finish(error);
      }
    }

    function end() {
      finish();
    }

    function close() {
      if (!stream.readableEnded) finish(new Error("Input closed before EOF."));
    }

    stream.on("error", finish);
    stream.on("readable", read);
    stream.once("end", end);
    stream.once("close", close);
    if (stream.readableEnded) end();
    else if (stream.destroyed) close();
    else read();
  });
}

function reportExitCode(report) {
  // Match only the governed header from the trusted core, never a search for
  // verdict words inside user-controlled targets, columns, or refusal previews.
  if (typeof report !== "string" || !report.endsWith("\n")) {
    throw new Error("Invalid report.");
  }
  if (/^PG IMPORT CHECK\nprofile: [^\n]+\nREFUSED: [a-z][a-z0-9_]*\n/.test(report)) return 2;
  if (
    /^PG IMPORT CHECK\nprofile: [^\n]+\nas of: [^\n]+\ntarget: [^\n]+\nTEXT-ONLY VERDICT: (?:outside_envelope_observed|more_evidence_required|no_structural_conflict_observed)\n/.test(
      report,
    )
  ) {
    return 0;
  }
  throw new Error("Invalid report header.");
}
