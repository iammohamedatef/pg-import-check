import { PROFILE, type AnalyzedResult, type ReasonId } from "./public-profile.js";

/** The finite profile rule list owns ordering; discovery order never selects output. */
export function orderedReasons(reasons: ReadonlySet<ReasonId>): ReasonId[] {
  return PROFILE.rules.filter((rule) => reasons.has(rule.id)).map((rule) => rule.id);
}

export function selectResult(reasons: ReadonlySet<ReasonId>): AnalyzedResult {
  const outcomes = new Set(
    PROFILE.rules.filter((rule) => reasons.has(rule.id)).map((rule) => rule.outcome),
  );
  for (const result of PROFILE.results.precedence) {
    if (result === "refused") continue;
    if (result === "no_structural_conflict_observed" || outcomes.has(result)) return result;
  }
  throw new Error("Public result precedence invariant violated.");
}

export class PolicyFindings {
  readonly reasons = new Set<ReasonId>();
  readonly columns: Set<ReasonId>[];

  constructor(columnCount: number) {
    this.columns = Array.from({ length: columnCount }, () => new Set<ReasonId>());
  }

  forColumn(ordinal: number): Set<ReasonId> {
    const column = this.columns[ordinal];
    if (column === undefined) throw new Error("Finding column association invariant violated.");
    return column;
  }

  add(reason: ReasonId, columnOrdinal?: number): void {
    this.reasons.add(reason);
    if (columnOrdinal !== undefined) {
      this.forColumn(columnOrdinal).add(reason);
    }
  }
}
