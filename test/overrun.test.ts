import { describe, expect, it } from "vitest";
import { evaluateOverrun, initialOverrunState } from "../src/overrun/monitor.js";
import { recentRate, spendPath } from "../src/overrun/spend.js";
import { DEFAULT_OVERRUN_CONFIG, MINUTE_MS, type OverrunLease, type OverrunReading, type OverrunState } from "../src/overrun/types.js";

// All series here are synthetic and deterministic.
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const RESET = T0 + 4 * 60 * MINUTE_MS;
const cfg = DEFAULT_OVERRUN_CONFIG;

/** Readings every `step` minutes starting at T0, one value per poll. */
function series(values: (number | null)[], step = 5, resetsAt = RESET): OverrunReading[] {
  return values.map((used, i) => ({ at: T0 + i * step * MINUTE_MS, used, fresh: used !== null, resetsAt }));
}

function lease(overrides: Partial<OverrunLease> = {}): OverrunLease {
  return { leaseId: "L1", startedAt: T0 + MINUTE_MS, reservationPercent: 1, ...overrides };
}

/** Feeds the monitor one poll at a time, like the daemon would, and collects every warning. */
function replay(l: OverrunLease, readings: OverrunReading[], config = cfg) {
  let state: OverrunState | null = null;
  const warnings = [];
  const results = [];
  for (const r of readings) {
    if (r.at <= l.startedAt) continue;
    const result = evaluateOverrun(l, readings, r.at, state, config);
    state = result.state;
    results.push(result);
    warnings.push(...result.newWarnings);
  }
  return { warnings, results, state };
}

describe("spendPath", () => {
  it("measures movement from the last fresh reading before the lease", () => {
    const path = spendPath(series([40, 41, 43, 46]), T0 + MINUTE_MS, T0 + 15 * MINUTE_MS, cfg);
    expect(path.ok).toBe(true);
    if (path.ok) expect(path.points.map((p) => p.spent)).toEqual([0, 1, 3, 6]);
  });

  it("is UNKNOWN without a fresh baseline close enough before the lease", () => {
    const readings = series([40, null, null, null, null, 41]);
    const late = spendPath(readings, T0 + 20 * MINUTE_MS, T0 + 25 * MINUTE_MS, cfg);
    expect(late).toEqual({ ok: false, reason: "no fresh reading within 15 min before the lease started" });
    const none = spendPath(readings.slice(1), T0 + MINUTE_MS, T0 + 10 * MINUTE_MS, cfg);
    expect(none.ok).toBe(false);
  });

  it("is UNKNOWN when the newest reading is failed or old", () => {
    const readings = series([40, 41, null]);
    expect(spendPath(readings, T0 + MINUTE_MS, T0 + 10 * MINUTE_MS, cfg)).toEqual({ ok: false, reason: "latest reading is stale or failed" });
    expect(spendPath(series([40, 41]), T0 + MINUTE_MS, T0 + 30 * MINUTE_MS, cfg)).toEqual({ ok: false, reason: "latest reading is 25 min old" });
    expect(spendPath([], T0, T0, cfg)).toEqual({ ok: false, reason: "no reading yet" });
  });

  it("skips a failed poll in the middle and keeps counting", () => {
    const path = spendPath(series([40, null, 43]), T0 + MINUTE_MS, T0 + 10 * MINUTE_MS, cfg);
    expect(path.ok && path.points.map((p) => p.spent)).toEqual([0, 3]);
  });

  it("carries spend across a window reset and ignores a dip without one", () => {
    const readings: OverrunReading[] = [
      { at: T0, used: 95, fresh: true, resetsAt: RESET },
      { at: T0 + 5 * MINUTE_MS, used: 98, fresh: true, resetsAt: RESET },
      { at: T0 + 10 * MINUTE_MS, used: 2, fresh: true, resetsAt: RESET + 5 * 60 * MINUTE_MS },
      { at: T0 + 15 * MINUTE_MS, used: 1, fresh: true, resetsAt: RESET + 5 * 60 * MINUTE_MS },
      { at: T0 + 20 * MINUTE_MS, used: 4, fresh: true, resetsAt: RESET + 5 * 60 * MINUTE_MS },
    ];
    const path = spendPath(readings, T0 + MINUTE_MS, T0 + 20 * MINUTE_MS, cfg);
    expect(path.ok && path.points.map((p) => p.spent)).toEqual([0, 3, 5, 5, 7]);
  });

  it("does not treat a drop with the same reset time as a reset", () => {
    const path = spendPath(series([40, 44, 42, 45]), T0 + MINUTE_MS, T0 + 15 * MINUTE_MS, cfg);
    expect(path.ok && path.points.map((p) => p.spent)).toEqual([0, 4, 4, 5]);
  });
});

describe("recentRate", () => {
  it("uses the newest point at least 5 minutes back", () => {
    const points = [0, 1, 2, 4].map((spent, i) => ({ at: T0 + i * 3 * MINUTE_MS, spent, used: 0 }));
    // newest at 9 min; newest point at or before 4 min is the one at 3 min (spent 1).
    expect(recentRate(points, cfg)).toBeCloseTo(3 / 6);
  });

  it("is null when the span is too short or too long", () => {
    expect(recentRate([{ at: T0, spent: 0, used: 0 }, { at: T0 + MINUTE_MS, spent: 1, used: 1 }], cfg)).toBeNull();
    expect(recentRate([{ at: T0, spent: 0, used: 0 }, { at: T0 + 20 * MINUTE_MS, spent: 1, used: 1 }], cfg)).toBeNull();
    expect(recentRate([{ at: T0, spent: 0, used: 0 }], cfg)).toBeNull();
  });
});

describe("evaluateOverrun: spend rule", () => {
  it("uses spend minus the resolution as the lower bound", () => {
    // reservation 1: threshold max(2, 2) = 2. Reading 3 has lower bound 2: not above.
    const three = replay(lease(), series([10, 13]));
    expect(three.warnings).toEqual([]);
    const four = replay(lease(), series([10, 14]));
    expect(four.warnings.map((w) => w.rule)).toEqual(["spend"]);
    expect(four.warnings[0].evidence).toMatchObject({ spent: 4, spentLower: 3, threshold: 2 });
    expect(four.warnings[0].message).toContain("at least 3 points");
    expect(four.warnings[0].message).toContain("reservation 1");
  });

  it("scales with the reservation and falls back to the floor without one", () => {
    // reservation 3: threshold 6. Reading 17 has lower bound 6: not above.
    expect(replay(lease({ reservationPercent: 3 }), series([10, 17])).warnings).toEqual([]);
    expect(replay(lease({ reservationPercent: 3 }), series([10, 18])).warnings.map((w) => w.rule)).toEqual(["spend"]);
    const none = replay(lease({ reservationPercent: null }), series([10, 14]));
    expect(none.warnings[0].message).toContain("no reservation");
  });

  it("honours a finer resolution", () => {
    const fine = { ...cfg, resolution: 0.1 };
    expect(replay(lease(), series([10, 12.2]), fine).warnings.map((w) => w.rule)).toEqual(["spend"]);
  });
});

describe("evaluateOverrun: continued-rate rule", () => {
  it("needs two consecutive polls over the line", () => {
    // 1 point per minute: spend 5 then 10. Poll 1: 5 + 5 = 10 > 5 (streak 1). Poll 2: streak 2, fires.
    const l = lease({ reservationPercent: 100 });
    const { warnings } = replay(l, series([0, 5, 10]));
    expect(warnings.map((w) => w.rule)).toEqual(["rate"]);
    expect(warnings[0].message).toMatch(/^Continued-rate warning \(not a forecast of the final size\)/);
    expect(warnings[0].at).toBe(T0 + 10 * MINUTE_MS);
  });

  it("does not count the same poll twice", () => {
    const l = lease({ reservationPercent: 100 });
    const readings = series([0, 5]);
    const first = evaluateOverrun(l, readings, T0 + 5 * MINUTE_MS, null);
    const again = evaluateOverrun(l, readings, T0 + 6 * MINUTE_MS, first.state);
    expect(first.state.rateStreak).toBe(1);
    expect(again.state.rateStreak).toBe(1);
    expect(again.newWarnings).toEqual([]);
  });

  it("resets the streak on a quiet poll or a gap", () => {
    const l = lease({ reservationPercent: 100 });
    expect(replay(l, series([0, 5, 5, 10])).warnings).toEqual([]);
    expect(replay(l, series([0, 5, null, 10])).warnings).toEqual([]);
  });

  it("fires on one poll when configured so", () => {
    const l = lease({ reservationPercent: 100 });
    expect(replay(l, series([0, 3]), { ...cfg, consecutivePolls: 1, ratePoints: 3 }).warnings.map((w) => w.rule)).toEqual(["rate"]);
  });
});

describe("evaluateOverrun: class rule", () => {
  const near = series([90, 93]);
  it("fires above 2 x class p75 when under 3 x spend is left", () => {
    const l = lease({ reservationPercent: 100, classP75: 0.5, classSamples: 10 });
    const { warnings } = replay(l, near);
    expect(warnings.map((w) => w.rule)).toEqual(["class"]);
    expect(warnings[0].message).toContain("class p75 of 0.5 (from 10 leases)");
  });

  it("stays quiet with few samples, with room left, or when disabled", () => {
    expect(replay(lease({ reservationPercent: 100, classP75: 0.5, classSamples: 2 }), near).warnings).toEqual([]);
    expect(replay(lease({ reservationPercent: 100, classP75: 0.5, classSamples: 10 }), series([10, 13])).warnings).toEqual([]);
    expect(replay(lease({ reservationPercent: 100, classP75: 0.5, classSamples: 10 }), near, { ...cfg, classRule: false }).warnings).toEqual([]);
  });
});

describe("evaluateOverrun: once, idempotent, fail closed", () => {
  it("warns once per rule per lease", () => {
    const { warnings, results } = replay(lease(), series([10, 14, 20, 30, 40]));
    expect(warnings.map((w) => w.rule).sort()).toEqual(["rate", "spend"]);
    expect(results[results.length - 1].status).toBe("warned");
  });

  it("returns nothing new on a repeat call with the same readings", () => {
    const readings = series([10, 14]);
    const first = evaluateOverrun(lease(), readings, T0 + 5 * MINUTE_MS, null);
    const second = evaluateOverrun(lease(), readings, T0 + 5 * MINUTE_MS, first.state);
    expect(first.newWarnings).toHaveLength(1);
    expect(second.newWarnings).toEqual([]);
    expect(second.state).toEqual(first.state);
  });

  it("says UNKNOWN and never warns on stale or missing readings", () => {
    const stale = evaluateOverrun(lease(), series([10, 40]), T0 + 40 * MINUTE_MS, null);
    expect(stale).toMatchObject({ status: "unknown", spent: null, spentLower: null, ratePerMinute: null, newWarnings: [] });
    expect(stale.reason).toMatch(/^UNKNOWN: latest reading is 35 min old/);
    const failed = evaluateOverrun(lease(), series([10, 40, null]), T0 + 10 * MINUTE_MS, null);
    expect(failed).toMatchObject({ status: "unknown", newWarnings: [] });
    const noBaseline = evaluateOverrun(lease({ startedAt: T0 - 30 * MINUTE_MS }), series([10, 40]), T0 + 5 * MINUTE_MS, null);
    expect(noBaseline.reason).toContain("before the lease started");
    expect(noBaseline.newWarnings).toEqual([]);
  });

  it("keeps fired rules through an UNKNOWN poll", () => {
    const readings = series([10, 14, null]);
    const first = evaluateOverrun(lease(), readings, T0 + 5 * MINUTE_MS, null);
    const unknown = evaluateOverrun(lease(), readings, T0 + 10 * MINUTE_MS, first.state);
    expect(unknown.state.fired).toEqual(["spend"]);
  });

  it("ignores state that belongs to another lease", () => {
    const foreign: OverrunState = { ...initialOverrunState("other"), fired: ["spend"] };
    expect(evaluateOverrun(lease(), series([10, 14]), T0 + 5 * MINUTE_MS, foreign).newWarnings.map((w) => w.rule)).toEqual(["spend"]);
  });

  it("reports ok with the numbers when nothing is wrong", () => {
    const result = evaluateOverrun(lease(), series([10, 11]), T0 + 5 * MINUTE_MS, null);
    expect(result).toMatchObject({ status: "ok", reason: null, spent: 1, spentLower: 0, used: 11 });
  });
});
