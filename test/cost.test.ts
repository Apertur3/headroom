import { describe, expect, it } from "vitest";
import { buildCostEstimate, costConfidence, maxMoreBeforeReset, percentile, summarizeLearnedCost } from "../src/cost.js";

describe("percentile", () => {
  it("is 0 for an empty array", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("returns the single value for a one-element array at any fraction", () => {
    expect(percentile([7], 0.25)).toBe(7);
    expect(percentile([7], 0.75)).toBe(7);
  });

  it("interpolates linearly between the two nearest ranks", () => {
    const sorted = [1, 2, 3, 4];
    expect(percentile(sorted, 0.5)).toBeCloseTo(2.5, 6); // R-7 median of 4 points
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 1)).toBe(4);
  });
});

describe("summarizeLearnedCost", () => {
  it("is undefined for an empty sample set", () => {
    expect(summarizeLearnedCost("review", [])).toBeUndefined();
  });

  it("computes median, IQR bounds and sample count from per-lease spend", () => {
    // Sorted: 2, 4, 4, 5, 9 -- median (R-7, n=5) is the middle value, 4.
    const summary = summarizeLearnedCost("review", [9, 2, 4, 5, 4]);
    expect(summary).toMatchObject({ action_class: "review", sample_count: 5, median_percent: 4 });
    expect(summary!.iqr_low).toBeLessThanOrEqual(summary!.median_percent);
    expect(summary!.iqr_high).toBeGreaterThanOrEqual(summary!.median_percent);
  });

  it("does not mutate the input array's order", () => {
    const input = [9, 2, 4];
    summarizeLearnedCost("x", input);
    expect(input).toEqual([9, 2, 4]);
  });
});

describe("costConfidence", () => {
  it("bands by sample count only", () => {
    expect(costConfidence(0)).toBe("none");
    expect(costConfidence(1)).toBe("low");
    expect(costConfidence(2)).toBe("low");
    expect(costConfidence(3)).toBe("medium");
    expect(costConfidence(9)).toBe("medium");
    expect(costConfidence(10)).toBe("high");
    expect(costConfidence(100)).toBe("high");
  });
});

describe("maxMoreBeforeReset", () => {
  it("floors remaining percent divided by the per-call cost", () => {
    expect(maxMoreBeforeReset(45, 4)).toBe(11);
    expect(maxMoreBeforeReset(3, 4)).toBe(0);
  });

  it("is null for a zero or negative expected cost", () => {
    expect(maxMoreBeforeReset(45, 0)).toBeNull();
    expect(maxMoreBeforeReset(45, -1)).toBeNull();
  });
});

describe("buildCostEstimate", () => {
  it("prefers an explicit --expect over the learned median, with high confidence", () => {
    const learned = summarizeLearnedCost("review", [3, 4, 5]);
    const estimate = buildCostEstimate("review", 10, learned, 40);
    expect(estimate).toMatchObject({ source: "given", expected_percent: 10, confidence: "high" });
    expect(estimate.max_more_before_reset).toBe(4); // floor(40/10)
  });

  it("falls back to the learned median with sample-count confidence when no --expect is given", () => {
    const learned = summarizeLearnedCost("review", [4, 4, 4]);
    const estimate = buildCostEstimate("review", null, learned, 40);
    expect(estimate).toMatchObject({ source: "learned", expected_percent: 4, confidence: "medium", sample_count: 3 });
    expect(estimate.max_more_before_reset).toBe(10);
  });

  it("is unknown with no expect and no learned data, and never computes max-more", () => {
    const estimate = buildCostEstimate("brand-new-class", null, undefined, 40);
    expect(estimate).toMatchObject({ source: "unknown", expected_percent: null, confidence: "none", max_more_before_reset: null });
  });

  it("leaves max-more null when the deciding meter's remaining percent is unknown", () => {
    const learned = summarizeLearnedCost("review", [4]);
    const estimate = buildCostEstimate("review", null, learned, null);
    expect(estimate.max_more_before_reset).toBeNull();
  });
});
