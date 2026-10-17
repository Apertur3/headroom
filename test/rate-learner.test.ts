import { describe, expect, it } from "vitest";
import {
  attributeIntervals, buildMeterIntervals, detectDrift, fitModelRate, groupSamplesByModel,
  MIN_FIT_SAMPLES, type AttributedSample, type MeterObservationPoint, type RateFit, type UsageIdentityPoint,
} from "../src/rate-learner.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-20T00:00:00.000Z");

function point(hoursFromT0: number, usedPercent: number | null): MeterObservationPoint {
  return { usedPercent, fetchedAtMs: T0 + hoursFromT0 * HOUR };
}

describe("buildMeterIntervals", () => {
  it("keeps an ordinary non-negative delta between two consecutive fresh readings", () => {
    const intervals = buildMeterIntervals([point(0, 10), point(1, 15)], []);
    expect(intervals).toEqual([{ fromMs: T0, toMs: T0 + HOUR, deltaPercent: 5 }]);
  });

  it("drops an interval whose raw delta is negative (an un-flagged reset)", () => {
    const intervals = buildMeterIntervals([point(0, 90), point(1, 5)], []);
    expect(intervals).toEqual([]);
  });

  it("drops an interval a reset timestamp falls inside, even when the raw delta is positive", () => {
    // A reset at hour 0.5 is immediately followed by enough same-poll usage
    // to push the reading past its pre-reset value -- the raw delta alone
    // (95 -> 97, +2) would look like ordinary growth, but the interval must
    // still be excluded because a reset happened inside it.
    const points = [point(0, 95), point(1, 97)];
    const resetTimestampsMs = [T0 + 0.5 * HOUR];
    expect(buildMeterIntervals(points, resetTimestampsMs)).toEqual([]);
  });

  it("keeps an interval when the reset timestamp falls outside it", () => {
    const points = [point(0, 10), point(1, 15)];
    const resetTimestampsMs = [T0 + 5 * HOUR]; // well after this interval
    expect(buildMeterIntervals(points, resetTimestampsMs)).toHaveLength(1);
  });

  it("drops an interval with a null percent at either end", () => {
    expect(buildMeterIntervals([point(0, null), point(1, 15)], [])).toEqual([]);
    expect(buildMeterIntervals([point(0, 10), point(1, null)], [])).toEqual([]);
  });

  it("sorts unsorted input by fetchedAtMs before differencing", () => {
    const intervals = buildMeterIntervals([point(1, 15), point(0, 10)], []);
    expect(intervals).toEqual([{ fromMs: T0, toMs: T0 + HOUR, deltaPercent: 5 }]);
  });

  it("builds one interval per consecutive pair across a longer series", () => {
    const points = [point(0, 0), point(1, 5), point(2, 9), point(3, 20)];
    const intervals = buildMeterIntervals(points, []);
    expect(intervals.map((i) => i.deltaPercent)).toEqual([5, 4, 11]);
  });
});

function identity(model: string, hoursFromT0: number, tokens: Partial<UsageIdentityPoint["tokens"]> = {}): UsageIdentityPoint {
  return { model, observedAtMs: T0 + hoursFromT0 * HOUR, tokens: { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0, ...tokens } };
}

describe("attributeIntervals", () => {
  const interval = { fromMs: T0, toMs: T0 + HOUR, deltaPercent: 5 };

  it("attributes an interval to the single model that produced tokens inside it", () => {
    const identities = [identity("claude-sonnet-5", 0.5, { output: 1000 })];
    const samples = attributeIntervals([interval], identities);
    expect(samples).toEqual([{ fromMs: interval.fromMs, toMs: interval.toMs, deltaPercent: 5, model: "claude-sonnet-5", tokens: { fresh_input: 0, cache_read: 0, cache_write: 0, output: 1000 } }]);
  });

  it("drops an interval where two different models both produced tokens", () => {
    const identities = [identity("claude-sonnet-5", 0.3, { output: 500 }), identity("claude-opus-5", 0.6, { output: 500 })];
    expect(attributeIntervals([interval], identities)).toEqual([]);
  });

  it("drops an interval with no imported tokens at all", () => {
    expect(attributeIntervals([interval], [])).toEqual([]);
  });

  it("excludes an identity observed exactly at the interval's start (half-open, matching buildMeterIntervals' own convention)", () => {
    const identities = [identity("claude-sonnet-5", 0, { output: 1000 })]; // exactly at fromMs
    expect(attributeIntervals([interval], identities)).toEqual([]);
  });

  it("sums multiple identities from the same model within one interval", () => {
    const identities = [identity("claude-sonnet-5", 0.2, { output: 100 }), identity("claude-sonnet-5", 0.8, { output: 200 })];
    const samples = attributeIntervals([interval], identities);
    expect(samples[0].tokens.output).toBe(300);
  });
});

describe("groupSamplesByModel", () => {
  it("splits mixed-model samples into per-model, chronologically sorted groups", () => {
    const samples: AttributedSample[] = [
      { fromMs: 2, toMs: 3, deltaPercent: 1, model: "a", tokens: { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0 } },
      { fromMs: 0, toMs: 1, deltaPercent: 1, model: "a", tokens: { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0 } },
      { fromMs: 1, toMs: 2, deltaPercent: 1, model: "b", tokens: { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0 } },
    ];
    const grouped = groupSamplesByModel(samples);
    expect([...grouped.keys()].sort()).toEqual(["a", "b"]);
    expect(grouped.get("a")!.map((s) => s.fromMs)).toEqual([0, 2]);
  });
});

function sample(index: number, outputTokens: number, deltaPercent: number): AttributedSample {
  return { fromMs: T0 + index * HOUR, toMs: T0 + (index + 1) * HOUR, deltaPercent, model: "claude-sonnet-5", tokens: { fresh_input: 0, cache_read: 0, cache_write: 0, output: outputTokens } };
}

describe("fitModelRate", () => {
  it("refuses below the minimum sample count", () => {
    const samples = Array.from({ length: MIN_FIT_SAMPLES - 1 }, (_, i) => sample(i, 1000 * (i + 1), 0.1 * (i + 1)));
    const outcome = fitModelRate(samples);
    expect(outcome).toEqual({ status: "insufficient_data", model: "claude-sonnet-5", sampleCount: MIN_FIT_SAMPLES - 1, minSamples: MIN_FIT_SAMPLES });
  });

  it("refuses on an empty sample list without a model to name", () => {
    expect(fitModelRate([])).toEqual({ status: "insufficient_data", model: "", sampleCount: 0, minSamples: MIN_FIT_SAMPLES });
  });

  it("recovers a known output-token rate exactly from noise-free synthetic samples, with full coverage and r-squared", () => {
    // deltaPercent_i = k * output_tokens_i, k chosen so rate_output comes out
    // to a clean 100 points per 1,000,000 tokens.
    const k = 0.0001;
    const samples = Array.from({ length: MIN_FIT_SAMPLES + 2 }, (_, i) => {
      const outputTokens = 1000 * (i + 1);
      return sample(i, outputTokens, k * outputTokens);
    });
    const outcome = fitModelRate(samples);
    expect(outcome.status).toBe("fit");
    if (outcome.status !== "fit") return;
    expect(outcome.fit.model).toBe("claude-sonnet-5");
    expect(outcome.fit.sampleCount).toBe(samples.length);
    expect(outcome.fit.ratePerMillion.output).toBeCloseTo(100, 3);
    expect(outcome.fit.ratePerMillion.fresh_input).toBeCloseTo(0, 6);
    expect(outcome.fit.ratePerMillion.cache_read).toBeCloseTo(0, 6);
    expect(outcome.fit.ratePerMillion.cache_write).toBeCloseTo(0, 6);
    expect(outcome.fit.rateBackgroundPerInterval).toBeCloseTo(0, 6);
    expect(outcome.fit.coverage).toBeCloseTo(1, 3);
    expect(outcome.fit.rSquared).toBeCloseTo(1, 3);
  });

  it("every rate coefficient is non-negative even when raw deltas would favor a negative slope for an unrelated class", () => {
    // cache_write tokens fall while output tokens (the real driver) rises;
    // an ordinary (non-NNLS) regression could assign cache_write a negative
    // coefficient here.
    const k = 0.0002;
    const samples = Array.from({ length: MIN_FIT_SAMPLES + 2 }, (_, i) => {
      const outputTokens = 1000 * (i + 1);
      const s = sample(i, outputTokens, k * outputTokens);
      s.tokens.cache_write = 5000 - 300 * i;
      return s;
    });
    const outcome = fitModelRate(samples);
    expect(outcome.status).toBe("fit");
    if (outcome.status !== "fit") return;
    expect(outcome.fit.ratePerMillion.cache_write).toBeGreaterThanOrEqual(0);
    expect(outcome.fit.coverage).toBeGreaterThanOrEqual(0);
    expect(outcome.fit.coverage).toBeLessThanOrEqual(1);
    expect(outcome.fit.rSquared).toBeGreaterThanOrEqual(0);
    expect(outcome.fit.rSquared).toBeLessThanOrEqual(1);
  });

  it("attributes unexplained movement to the background term and reports partial coverage", () => {
    // Every sample carries a fixed amount of background drift the imported
    // output tokens cannot explain.
    const k = 0.0001;
    const backgroundPerInterval = 0.05;
    const samples = Array.from({ length: MIN_FIT_SAMPLES + 4 }, (_, i) => {
      const outputTokens = 1000 * (i + 1);
      return sample(i, outputTokens, k * outputTokens + backgroundPerInterval);
    });
    const outcome = fitModelRate(samples);
    expect(outcome.status).toBe("fit");
    if (outcome.status !== "fit") return;
    expect(outcome.fit.rateBackgroundPerInterval).toBeCloseTo(backgroundPerInterval, 3);
    expect(outcome.fit.coverage).toBeGreaterThan(0);
    expect(outcome.fit.coverage).toBeLessThan(1);
  });
});

function fitFrom(ratePerMillion: RateFit["ratePerMillion"], rSquared: number): Pick<RateFit, "ratePerMillion" | "rSquared"> {
  return { ratePerMillion, rSquared };
}

describe("detectDrift", () => {
  const base = { fresh_input: 10, cache_read: 5, cache_write: 3, output: 20 };

  it("reports no drift when every class rate is stable", () => {
    expect(detectDrift(fitFrom(base, 0.9), fitFrom({ ...base }, 0.9))).toBeUndefined();
  });

  it("reports the class with the largest relative change once it clears the threshold", () => {
    const next = { ...base, output: 30 }; // 50% relative change, well above the 25% threshold
    const drift = detectDrift(fitFrom(base, 0.9), fitFrom(next, 0.9));
    expect(drift).toEqual({ changedClass: "output", relativeChange: expect.closeTo(1 / 3, 5) });
  });

  it("suppresses a real rate change when either fit's r-squared is below the confidence floor", () => {
    const next = { ...base, output: 40 };
    expect(detectDrift(fitFrom(base, 0.2), fitFrom(next, 0.9))).toBeUndefined();
    expect(detectDrift(fitFrom(base, 0.9), fitFrom(next, 0.49))).toBeUndefined();
  });

  it("does not report a change below the relative threshold", () => {
    const next = { ...base, output: 22 }; // 10% relative change
    expect(detectDrift(fitFrom(base, 0.9), fitFrom(next, 0.9))).toBeUndefined();
  });
});
