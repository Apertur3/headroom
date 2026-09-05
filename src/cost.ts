/**
 * Learned cost per action class: pure statistics over a set of per-lease
 * spent-percent totals, plus the confidence and "how many more fit" figures
 * `can` and `fill` print alongside them. src/store.ts collects the samples
 * (lease_spend joined to leases, grouped by the lease's action_class); this
 * module turns them into a summary with no database access of its own.
 */
export interface LearnedCost {
  action_class: string;
  sample_count: number;
  median_percent: number;
  iqr_low: number;
  iqr_high: number;
}

/** Linear-interpolation percentile (the common "R-7" method), on an already
 * sorted array. 0 for an empty array. */
export function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Median and interquartile range of a set of per-lease spent-percent totals
 * for one action class. Returns undefined for an empty sample set. */
export function summarizeLearnedCost(actionClass: string, spentPercents: number[]): LearnedCost | undefined {
  if (!spentPercents.length) return undefined;
  const sorted = [...spentPercents].sort((a, b) => a - b);
  return {
    action_class: actionClass,
    sample_count: sorted.length,
    median_percent: percentile(sorted, 0.5),
    iqr_low: percentile(sorted, 0.25),
    iqr_high: percentile(sorted, 0.75),
  };
}

/** Sample-count-only confidence band. A tight or wide IQR is printed
 * alongside the number so a caller can judge spread for itself; this band is
 * deliberately just "how many times have we seen this class run" -- a small
 * n is a guess no matter how tight its IQR happens to look. */
export function costConfidence(sampleCount: number): "none" | "low" | "medium" | "high" {
  if (sampleCount <= 0) return "none";
  if (sampleCount < 3) return "low";
  if (sampleCount < 10) return "medium";
  return "high";
}

export interface CostEstimate {
  action_class: string;
  /** The percent used for "max more before reset": the caller's --expect
   * when given, otherwise the learned median. Null when neither exists. */
  expected_percent: number | null;
  source: "given" | "learned" | "unknown";
  confidence: "none" | "low" | "medium" | "high";
  sample_count: number;
  median_percent: number | null;
  iqr_low: number | null;
  iqr_high: number | null;
  /** floor(remaining_percent / expected_percent) on the deciding meter's
   * current window. Null when either figure is unknown. */
  max_more_before_reset: number | null;
}

export function maxMoreBeforeReset(remainingPercent: number, expectedCostPercent: number): number | null {
  if (!Number.isFinite(expectedCostPercent) || expectedCostPercent <= 0) return null;
  return Math.max(0, Math.floor(remainingPercent / expectedCostPercent));
}

export function buildCostEstimate(actionClass: string, expectOverride: number | null, learned: LearnedCost | undefined, remainingPercent: number | null): CostEstimate {
  const source: CostEstimate["source"] = expectOverride !== null ? "given" : learned ? "learned" : "unknown";
  const expected = expectOverride !== null ? expectOverride : learned ? learned.median_percent : null;
  const confidence = expectOverride !== null ? "high" : costConfidence(learned?.sample_count ?? 0);
  const maxMore = expected !== null && remainingPercent !== null ? maxMoreBeforeReset(remainingPercent, expected) : null;
  return {
    action_class: actionClass, expected_percent: expected, source, confidence,
    sample_count: learned?.sample_count ?? 0, median_percent: learned?.median_percent ?? null,
    iqr_low: learned?.iqr_low ?? null, iqr_high: learned?.iqr_high ?? null, max_more_before_reset: maxMore,
  };
}
