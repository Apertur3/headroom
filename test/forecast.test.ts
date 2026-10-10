import { describe, expect, it } from "vitest";
import { straightLineBurn, trailingRate } from "../src/forecast/baselines.js";
import { forecast, type ForecastInput } from "../src/forecast/forecaster.js";
import { brierScore, decisionStats, intervalStats, reliabilityTable, skill } from "../src/forecast/metrics.js";
import {
  activeLoad,
  buildSamples,
  classCosts,
  hourOfWeekBucket,
  hoursToResetBucket,
  isIdleReading,
  loadBucket,
  QuantileTable,
  quantile,
  segmentCycles,
  windowIntensity,
} from "../src/forecast/table.js";
import { DEFAULT_FORECAST_CONFIG, HOUR_MS, MINUTE_MS, type Cycle, type DrawSample, type ForecastConfig, type LeaseRecord, type MeterReading } from "../src/forecast/types.js";

// All data here is synthetic and deterministic.
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday, 00:00 UTC
const WINDOW = 300;
const WINDOW_MS = WINDOW * MINUTE_MS;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One synthetic 5-hour window starting at `start`: a reading every 10 minutes, burning `total` percent evenly. */
function syntheticWindow(start: number, total: number, startUsed = 0): MeterReading[] {
  const resetsAt = start + WINDOW_MS;
  const readings: MeterReading[] = [];
  for (let m = 0; m < WINDOW; m += 10) {
    readings.push({ at: start + m * MINUTE_MS, used: Math.min(100, startUsed + (total * m) / (WINDOW - 10)), resetsAt, kind: "fixed" });
  }
  return readings;
}

/** Back-to-back windows with per-window totals. */
function syntheticHistory(totals: number[], start = T0): { readings: MeterReading[]; cycles: Cycle[] } {
  const readings = totals.flatMap((total, i) => syntheticWindow(start + i * WINDOW_MS, total));
  return { readings, cycles: segmentCycles(readings, WINDOW) };
}

function tableFrom(cycles: Cycle[], config: ForecastConfig = DEFAULT_FORECAST_CONFIG, loadAt: (at: number) => number = () => 0): QuantileTable {
  return new QuantileTable(buildSamples(cycles, { asOf: Number.MAX_SAFE_INTEGER, loadAt }, config), config);
}

function sample(partial: Partial<DrawSample>): DrawSample {
  return { cycleId: 1, at: 0, used: 0, draw: 0, htrBucket: 0, howBucket: 0, loadBucket: 0, intensityBucket: 0, load: 0, ...partial };
}

describe("quantile (inverse empirical CDF)", () => {
  it("returns actual sample values, never interpolations", () => {
    const xs = [1, 2, 3, 4];
    expect(quantile(xs, 0.25)).toBe(1);
    expect(quantile(xs, 0.5)).toBe(2);
    expect(quantile(xs, 0.75)).toBe(3);
    expect(quantile(xs, 0.95)).toBe(4);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
  });

  it("is not thrown off by floating point at exact ranks", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    // 0.95 * 20 is 19.000000000000004 in floating point; the 19th value is right.
    expect(quantile(xs, 0.95)).toBe(19);
  });

  it("refuses an empty sample", () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError);
  });
});

describe("cycles", () => {
  it("treats a zero reading whose reset floats one window ahead as idle", () => {
    expect(isIdleReading({ at: T0, used: 0, resetsAt: T0 + WINDOW_MS }, WINDOW)).toBe(true);
    expect(isIdleReading({ at: T0, used: 0, resetsAt: null }, WINDOW)).toBe(true);
    expect(isIdleReading({ at: T0, used: 0, resetsAt: T0 + WINDOW_MS - 30 * MINUTE_MS }, WINDOW)).toBe(false);
    expect(isIdleReading({ at: T0, used: 3, resetsAt: T0 + WINDOW_MS }, WINDOW)).toBe(false);
  });

  it("groups by reset time, tolerates a minute of vendor jitter and drops idle or past-reset readings", () => {
    const reset1 = T0 + 4 * HOUR_MS;
    const reset2 = T0 + 9 * HOUR_MS;
    const readings: MeterReading[] = [
      { at: T0 - 10 * MINUTE_MS, used: 0, resetsAt: T0 - 10 * MINUTE_MS + WINDOW_MS }, // idle, floating
      { at: T0, used: 5, resetsAt: reset1 },
      { at: T0 + HOUR_MS, used: 9, resetsAt: reset1 + MINUTE_MS }, // jitter
      { at: reset1 + MINUTE_MS, used: 9, resetsAt: reset1 }, // past its reset
      { at: T0 + 5 * HOUR_MS, used: 2, resetsAt: reset2 },
      { at: T0 + 6 * HOUR_MS, used: 0, resetsAt: null },
    ];
    const cycles = segmentCycles(readings, WINDOW);
    expect(cycles).toHaveLength(2);
    expect(cycles[0].readings.map((r) => r.used)).toEqual([5, 9]);
    expect(cycles[0].resetsAt).toBe(reset1 + MINUTE_MS);
    expect(cycles[1].readings.map((r) => r.used)).toEqual([2]);
  });
});

describe("draw samples", () => {
  it("records the rise to the window's peak from each sample, ignoring dips", () => {
    const resetsAt = T0 + WINDOW_MS;
    const readings: MeterReading[] = [10, 30, 25, 40, 40].map((used, i) => ({ at: T0 + i * 20 * MINUTE_MS, used, resetsAt }));
    const samples = buildSamples(segmentCycles(readings, WINDOW), { asOf: resetsAt, loadAt: () => 0 });
    expect(samples.map((s) => s.draw)).toEqual([30, 10, 15, 0, 0]);
  });

  it("only trains on windows that had reset by asOf (no look-ahead)", () => {
    const { cycles } = syntheticHistory([10, 20, 30]);
    const asOf = T0 + 2 * WINDOW_MS; // the third window is still running
    const samples = buildSamples(cycles, { asOf, loadAt: () => 0 });
    expect(new Set(samples.map((s) => s.cycleId)).size).toBe(2);
    expect(samples.every((s) => s.cycleId <= asOf)).toBe(true);
  });

  it("thins samples inside a window to the configured step", () => {
    const { cycles } = syntheticHistory([10]);
    const config = { ...DEFAULT_FORECAST_CONFIG, sampleStepMs: 30 * MINUTE_MS };
    const samples = buildSamples(cycles, { asOf: Number.MAX_SAFE_INTEGER, loadAt: () => 0 }, config);
    expect(samples).toHaveLength(10); // 30 readings 10 min apart, every third kept
  });
});

describe("buckets", () => {
  it("slices hours-to-reset into equal parts of the window", () => {
    expect(hoursToResetBucket(WINDOW_MS, WINDOW, 10)).toBe(9);
    expect(hoursToResetBucket(WINDOW_MS / 2, WINDOW, 10)).toBe(5);
    expect(hoursToResetBucket(1, WINDOW, 10)).toBe(0);
    expect(hoursToResetBucket(-1, WINDOW, 10)).toBe(0);
  });

  it("separates weekday and weekend blocks in local time", () => {
    expect(hourOfWeekBucket(T0, 6, 0)).toBe(0); // Monday 00:00
    expect(hourOfWeekBucket(T0 + 13 * HOUR_MS, 6, 0)).toBe(2); // Monday 13:00
    expect(hourOfWeekBucket(T0 + 5 * 24 * HOUR_MS + 19 * HOUR_MS, 6, 0)).toBe(7); // Saturday 19:00
    expect(hourOfWeekBucket(T0 - HOUR_MS, 6, 120)).toBe(0); // Sunday 23:00 UTC is Monday 01:00 at +2
  });

  it("puts zero load in its own bucket", () => {
    expect(loadBucket(0, [0, 2, 5])).toBe(0);
    expect(loadBucket(0.5, [0, 2, 5])).toBe(1);
    expect(loadBucket(5, [0, 2, 5])).toBe(2);
    expect(loadBucket(9, [0, 2, 5])).toBe(3);
  });
});

describe("lease load", () => {
  const leases: LeaseRecord[] = [
    { actionClass: "build", startedAt: T0, endedAt: T0 + HOUR_MS, spentPercent: 4 },
    { actionClass: "build", startedAt: T0, endedAt: T0 + 2 * HOUR_MS, spentPercent: 8 },
    { actionClass: "review", startedAt: T0, endedAt: T0 + HOUR_MS, spentPercent: 0 },
    { actionClass: "build", startedAt: T0, endedAt: T0 + 10 * HOUR_MS, spentPercent: 90 }, // ends later
  ];

  it("uses only leases that ended by asOf", () => {
    const costs = classCosts(leases, T0 + 3 * HOUR_MS);
    expect(costs.byClass.get("build")).toBe(6);
    expect(costs.byClass.get("review")).toBe(0);
    expect(classCosts(leases, T0 + 11 * HOUR_MS).byClass.get("build")).toBe(8);
  });

  it("supports the mean as an alternative statistic", () => {
    expect(classCosts(leases, T0 + 11 * HOUR_MS, "mean").byClass.get("build")).toBeCloseTo(34, 6);
  });

  it("sums class costs of the leases running at a moment; an unseen class gets the overall statistic", () => {
    const costs = classCosts(leases, T0 + 3 * HOUR_MS);
    const running: LeaseRecord[] = [
      { actionClass: "build", startedAt: T0 + 4 * HOUR_MS, endedAt: null, spentPercent: null },
      { actionClass: "design", startedAt: T0 + 4 * HOUR_MS, endedAt: T0 + 6 * HOUR_MS, spentPercent: 1 },
      { actionClass: "build", startedAt: T0 + 5 * HOUR_MS, endedAt: null, spentPercent: null }, // not started yet
      { actionClass: "build", startedAt: T0, endedAt: T0 + 4 * HOUR_MS, spentPercent: 2 }, // ended exactly then
    ];
    expect(activeLoad(running, T0 + 4 * HOUR_MS, costs)).toBe(6 + costs.overall);
  });
});

describe("quantile table back-off", () => {
  it("answers from the full key when that cell is dense enough", () => {
    const samples = Array.from({ length: 40 }, (_, i) => sample({ cycleId: i % 8, htrBucket: 3, howBucket: 1, draw: i }));
    const match = new QuantileTable(samples).lookup({ htrBucket: 3, howBucket: 1, loadBucket: 0 });
    expect(match?.level).toBe("htr+how+load");
    expect(match?.keyedOnLoad).toBe(true);
  });

  it("backs off past a sparse hour-of-week cell", () => {
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => sample({ cycleId: i, htrBucket: 3, howBucket: 1, loadBucket: 1 })),
      ...Array.from({ length: 30 }, (_, i) => sample({ cycleId: i, htrBucket: 3, howBucket: 2, loadBucket: 0 })),
    ];
    const table = new QuantileTable(samples);
    expect(table.lookup({ htrBucket: 3, howBucket: 1, loadBucket: 1 })?.level).toBe("htr");
    expect(table.lookup({ htrBucket: 3, howBucket: 2, loadBucket: 1 })?.level).toBe("htr+how");
  });

  it("widens to neighbouring hours-to-reset buckets before giving up", () => {
    const samples = [2, 4].flatMap((htr) => Array.from({ length: 20 }, (_, i) => sample({ cycleId: i, htrBucket: htr })));
    expect(new QuantileTable(samples).lookup({ htrBucket: 3, howBucket: 0, loadBucket: 0 })?.level).toBe("htr+-1");
  });

  it("refuses many samples from too few windows", () => {
    const samples = Array.from({ length: 200 }, (_, i) => sample({ cycleId: i % 4 }));
    expect(new QuantileTable(samples).lookup({ htrBucket: 0, howBucket: 0, loadBucket: 0 })).toBeNull();
  });
});

describe("forecast", () => {
  // One sample per window per hours-to-reset bucket, so a deterministic history gives identical draws.
  const exact: ForecastConfig = { ...DEFAULT_FORECAST_CONFIG, sampleStepMs: 30 * MINUTE_MS, minSamples: 10 };
  const { cycles } = syntheticHistory(Array.from({ length: 12 }, () => 40));
  const table = tableFrom(cycles, exact);
  const now = T0 + 20 * WINDOW_MS + HOUR_MS; // one hour into a later window
  const resetsAt = T0 + 21 * WINDOW_MS;
  const input = (overrides: Partial<ForecastInput> = {}): ForecastInput => ({
    now,
    window: { kind: "fixed", minutes: WINDOW },
    latest: { at: now - 5 * MINUTE_MS, used: 30, resetsAt },
    table,
    activeLoad: 0,
    ...overrides,
    config: { ...exact, ...overrides.config },
  });

  it("says UNKNOWN, never a number, without data, on stale data, on an idle meter and past the reset", () => {
    expect(forecast(input({ latest: null }))).toMatchObject({ status: "unknown", reason: "no_data" });
    expect(forecast(input({ latest: { at: now - 21 * MINUTE_MS, used: 30, resetsAt } }))).toMatchObject({ status: "unknown", reason: "stale" });
    expect(forecast(input({ latest: { at: now, used: 0, resetsAt: now + WINDOW_MS } }))).toMatchObject({ status: "unknown", reason: "no_active_window" });
    expect(forecast(input({ latest: { at: now, used: 0, resetsAt: null } }))).toMatchObject({ status: "unknown", reason: "no_active_window" });
    expect(forecast(input({ latest: { at: now - MINUTE_MS, used: 30, resetsAt: now - 1 } }))).toMatchObject({ status: "unknown", reason: "past_reset" });
  });

  it("says UNKNOWN for a rolling window with no history", () => {
    expect(forecast(input({ window: { kind: "rolling", minutes: WINDOW }, table: null }))).toMatchObject({ status: "unknown", reason: "rolling_no_history" });
    expect(forecast(input({ window: { kind: "rolling", minutes: WINDOW } })).status).toBe("ok");
  });

  it("says UNKNOWN when the history is too sparse", () => {
    const sparse = tableFrom(syntheticHistory([40, 40, 40]).cycles, exact);
    expect(forecast(input({ table: sparse }))).toMatchObject({ status: "unknown", reason: "too_sparse" });
    expect(forecast(input({ table: null }))).toMatchObject({ status: "unknown", reason: "too_sparse" });
  });

  it("matches a deterministic history exactly", () => {
    // Every past window burns 40 points evenly; the matched sample sits 40 minutes in (the 0-minute reading is idle), so the draw is 40 * 250/290.
    const result = forecast(input());
    if (result.status !== "ok") throw new Error(result.detail);
    expect(result.pHit).toBe(0);
    expect(result.remaining.p05).toBe(result.remaining.p95);
    expect(result.remaining.p50).toBeCloseTo((40 * 250) / 290, 2);
    expect(result.interval90[0]).toBeCloseTo(30 + result.remaining.p05, 6);
    expect(result.cycles).toBe(12);
    const near = forecast(input({ latest: { at: now - 5 * MINUTE_MS, used: 80, resetsAt } }));
    expect(near.status === "ok" && near.pHit).toBe(1);
    expect(near.status === "ok" && near.interval90[1]).toBe(100); // clamped at the limit
  });

  it("gives a probability that never falls as usage rises, and a higher one for a stricter event", () => {
    const random = mulberry32(7);
    const noisy = tableFrom(syntheticHistory(Array.from({ length: 30 }, () => Math.round(random() * 90))).cycles, exact);
    let previous = -1;
    for (let used = 0; used <= 99; used += 3) {
      const r = forecast(input({ table: noisy, latest: { at: now, used, resetsAt } }));
      if (r.status !== "ok") throw new Error(r.detail);
      expect(r.pHit).toBeGreaterThanOrEqual(previous);
      previous = r.pHit;
      const strict = forecast(input({ table: noisy, latest: { at: now, used, resetsAt }, config: { threshold: 80 } }));
      expect(strict.status === "ok" && strict.pHit).toBeGreaterThanOrEqual(r.pHit);
    }
  });

  it("adds active-lease cost as a shift only when the matched level ignores load", () => {
    const base = forecast(input());
    const shifted = forecast(input({ activeLoad: 3 }));
    if (base.status !== "ok" || shifted.status !== "ok") throw new Error("expected answers");
    // Training load is 0 everywhere, so a load of 3 misses the load-keyed cells and falls back.
    expect(shifted.level).toBe("htr");
    expect(shifted.shift).toBe(3);
    expect(shifted.remaining.p50).toBeCloseTo(base.remaining.p50 + 3, 6);
    const never = forecast(input({ activeLoad: 3, config: { shiftMode: "never" } }));
    expect(never.status === "ok" && never.shift).toBe(0);
    const keyed = forecast(input({ activeLoad: 0 }));
    expect(keyed.status === "ok" && keyed.level).toBe("htr+load");
    expect(keyed.status === "ok" && keyed.shift).toBe(0);
  });

  it("separates busy and quiet windows with the optional intensity key", () => {
    const totals = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 10 : 80));
    const config: ForecastConfig = { ...exact, intensity: "sinceStart" };
    const keyedTable = tableFrom(syntheticHistory(totals).cycles, config);
    const windowStart = resetsAt - WINDOW_MS;
    const busy = syntheticWindow(windowStart, 80).filter((r) => r.at <= now);
    const quiet = syntheticWindow(windowStart, 10).filter((r) => r.at <= now);
    const busyResult = forecast(input({ table: keyedTable, latest: busy[busy.length - 1], windowHistory: busy, config: { intensity: "sinceStart", threshold: 50 } }));
    const quietResult = forecast(input({ table: keyedTable, latest: quiet[quiet.length - 1], windowHistory: quiet, config: { intensity: "sinceStart", threshold: 50 } }));
    if (busyResult.status !== "ok" || quietResult.status !== "ok") throw new Error("expected answers");
    expect(busyResult.pHit).toBe(1);
    expect(quietResult.pHit).toBe(0);
    expect(windowIntensity(busy, busy[busy.length - 1], WINDOW, "sinceStart")).toBeGreaterThan(windowIntensity(quiet, quiet[quiet.length - 1], WINDOW, "sinceStart"));
  });
});

describe("baselines", () => {
  const resetsAt = T0 + WINDOW_MS;

  it("straight-line burn extrapolates the average since the window started", () => {
    const b = straightLineBurn({ at: T0 + 2 * HOUR_MS, used: 20, resetsAt }, WINDOW);
    expect(b?.projectedAtReset).toBeCloseTo(50, 6);
    expect(b?.remaining).toBeCloseTo(30, 6);
    expect(b?.pHit).toBe(0);
    expect(straightLineBurn({ at: T0 + HOUR_MS, used: 30, resetsAt }, WINDOW)?.pHit).toBe(1);
    expect(straightLineBurn({ at: T0, used: 0, resetsAt: null }, WINDOW)).toBeNull();
  });

  it("trailing rate uses the last reading at least the lookback old, else the window start", () => {
    const history: MeterReading[] = [
      { at: T0 + 60 * MINUTE_MS, used: 10, resetsAt },
      { at: T0 + 100 * MINUTE_MS, used: 12, resetsAt },
      { at: T0 + 120 * MINUTE_MS, used: 20, resetsAt },
    ];
    const latest = history[2];
    const t15 = trailingRate(history, latest, WINDOW, 15);
    expect(t15?.projectedAtReset).toBeCloseTo(20 + 24 * 3, 6); // 8 points in 20 min
    expect(t15?.remaining).toBeCloseTo(72, 6);
    const t60 = trailingRate(history, latest, WINDOW, 60);
    expect(t60?.projectedAtReset).toBeCloseTo(20 + 10 * 3, 6); // 10 points in 60 min
    const early = trailingRate([history[0]], history[0], WINDOW, 90);
    expect(early?.projectedAtReset).toBeCloseTo(10 + 10 * 4, 6); // anchored at the window start
  });
});

describe("metrics", () => {
  it("scores Brier, skill and reliability", () => {
    const items = [
      { p: 0.9, y: 1 as const },
      { p: 0.1, y: 0 as const },
      { p: 0.6, y: 0 as const },
      { p: 0, y: 0 as const },
    ];
    expect(brierScore(items)).toBeCloseTo((0.01 + 0.01 + 0.36 + 0) / 4, 9);
    expect(brierScore([])).toBeNull();
    expect(skill(0.09, 0.1)).toBeCloseTo(0.1, 9);
    expect(skill(0, 0)).toBeNull();
    const bins = reliabilityTable(items, [0, 0.5, 1]);
    expect(bins.map((b) => b.n)).toEqual([2, 2]);
    expect(bins[1].observed).toBe(0.5);
  });

  it("counts interval coverage inclusively and decision errors at a threshold", () => {
    const stats = intervalStats([
      { lo: 0, hi: 0, actual: 0 },
      { lo: 1, hi: 5, actual: 5 },
      { lo: 1, hi: 5, actual: 6 },
    ]);
    expect(stats.coverage).toBeCloseTo(2 / 3, 9);
    expect(stats.meanWidth).toBeCloseTo(8 / 3, 9);
    const d = decisionStats([
      { p: 0.2, y: 1 },
      { p: 0.7, y: 1 },
      { p: 0.5, y: 0 },
      { p: 0.1, y: 0 },
    ]);
    expect(d).toMatchObject({ events: 2, falseGo: 1, blockedUseful: 1, falseGoRate: 0.5, blockedUsefulRate: 0.5 });
  });
});
