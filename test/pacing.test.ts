import { describe, expect, it, vi } from "vitest";
import { computeFill, computePlan, evaluateBurst, evaluateGate, evaluateProRataLine, fillClassFits, parseGateNeed, waitForReset } from "../src/pacing.js";

describe("evaluateProRataLine", () => {
  it("allows spend that stays under the elapsed-fraction line plus tolerance", () => {
    const windowStart = new Date("2026-09-03T12:00:00Z");
    const now = new Date("2026-09-03T13:00:00Z"); // 1h into a 5h window
    // Plan share 20 over 5h -> line at 1h = 4. Used 0 so far, requesting 2.
    const result = evaluateProRataLine({ usedSoFarByOwnerPercent: 0, requestPercent: 2, plannedSharePercent: 20, windowStart, windowDurationHours: 5, now });
    expect(result).toMatchObject({ allowed: true, line_percent: 4 });
  });

  it("refuses once used-so-far plus the request exceeds the line by more than the tolerance", () => {
    const windowStart = new Date("2026-09-03T12:00:00Z");
    const now = new Date("2026-09-03T13:00:00Z"); // line = 4
    // 15 used-so-far + 5 more = 20, 16 over the line+tolerance(4+5=9).
    const result = evaluateProRataLine({ usedSoFarByOwnerPercent: 15, requestPercent: 5, plannedSharePercent: 20, windowStart, windowDurationHours: 5, now });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("pro-rata:");
  });

  it("the tolerance is a fixed cushion, not a percentage of the line", () => {
    const windowStart = new Date("2026-09-03T12:00:00Z");
    const now = windowStart; // line = 0 right at window start
    expect(evaluateProRataLine({ usedSoFarByOwnerPercent: 0, requestPercent: 5, plannedSharePercent: 20, windowStart, windowDurationHours: 5, now }).allowed).toBe(true);
    expect(evaluateProRataLine({ usedSoFarByOwnerPercent: 0, requestPercent: 5.1, plannedSharePercent: 20, windowStart, windowDurationHours: 5, now }).allowed).toBe(false);
  });
});

describe("evaluateBurst", () => {
  const windowStart = new Date("2026-09-03T12:00:00Z");

  it("passes when the recent burn is unknown or at/under twice the plan rate", () => {
    expect(evaluateBurst({ burnPercentPerHour10m: null, plannedSharePercent: 20, windowDurationHours: 5, usedPercent: 10, windowStart }).allowed).toBe(true);
    // plan rate = 20/5 = 4 pts/h; exactly 2x (8) still passes (strictly greater trips it).
    expect(evaluateBurst({ burnPercentPerHour10m: 8, plannedSharePercent: 20, windowDurationHours: 5, usedPercent: 10, windowStart }).allowed).toBe(true);
  });

  it("refuses once the 10-minute burn exceeds twice the plan rate, naming both rates and a hold-until time", () => {
    const result = evaluateBurst({ burnPercentPerHour10m: 48, plannedSharePercent: 20, windowDurationHours: 5, usedPercent: 23, windowStart });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("burst: 48 pts/h over the last 10 min, plan 4 pts/h; hold until 17:45");
  });
});

describe("computePlan", () => {
  it("splits the remaining weekly budget (after reserve) evenly across the remaining 5h windows", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    // 60% remaining, 10% reserve -> 50 points of budget. 25 hours to reset at
    // 5h/window -> ceil(25/5) = 5 windows -> 10 points/window.
    const plan = computePlan(40, "2026-09-04T13:00:00Z", 5, 10, now);
    expect(plan.weekly_remaining_percent).toBe(60);
    expect(plan.remaining_5h_windows).toBe(5);
    expect(plan.points_per_5h_window).toBeCloseTo(10, 6);
    expect(plan.plan_line_percent_per_hour).toBeCloseTo(50 / 25, 6);
  });

  it("never lets the budget or the weekly remaining go negative", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const plan = computePlan(97, "2026-09-03T13:00:00Z", 5, 10, now);
    expect(plan.weekly_remaining_percent).toBe(3);
    expect(plan.points_per_5h_window).toBe(0); // 3 - 10 reserve, floored at 0
  });

  it("rounds a partial window up to a whole one instead of inflating the last window's share", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    // 6 hours left, 5h windows -> 2 remaining windows (ceil(6/5)), not 1.
    const plan = computePlan(0, "2026-09-03T18:00:00Z", 5, 0, now);
    expect(plan.remaining_5h_windows).toBe(2);
  });
});

describe("parseGateNeed", () => {
  it("parses 5h:N and wk:N", () => {
    expect(parseGateNeed("5h:15")).toEqual({ window: "5h", points: 15 });
    expect(parseGateNeed("wk:3")).toEqual({ window: "wk", points: 3 });
    expect(parseGateNeed(" wk:3.5 ")).toEqual({ window: "wk", points: 3.5 });
  });

  it("throws on anything else", () => {
    expect(() => parseGateNeed("5d:15")).toThrow("Invalid --need value");
    expect(() => parseGateNeed("5h:-1")).toThrow("Invalid --need value");
    expect(() => parseGateNeed("5h")).toThrow("Invalid --need value");
  });
});

describe("evaluateGate", () => {
  const usage = { used5h: 80, usedWk: 50, weeklyResetsAt: "2026-09-10T12:00:00Z", hoursPer5hWindow: 5 };
  const now = new Date("2026-09-03T12:00:00Z");

  it("fails closed with no needs given", () => {
    expect(evaluateGate([], usage, 10, false, now)).toMatchObject({ allowed: false });
  });

  it("allows a need that stays under the freeze reserve", () => {
    expect(evaluateGate([{ window: "5h", points: 5 }], usage, 10, false, now)).toMatchObject({ allowed: true });
  });

  it("refuses a need that would cross the freeze reserve, naming the window and the shortfall", () => {
    const result = evaluateGate([{ window: "5h", points: 15 }], usage, 10, false, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("5h needs 15 more");
    expect(result.reason).toContain("10% reserve");
  });

  it("refuses when the deciding window's usage is unknown", () => {
    expect(evaluateGate([{ window: "wk", points: 5 }], { ...usage, usedWk: null }, 10, false, now)).toMatchObject({ allowed: false, reason: "wk usage unknown" });
  });

  it("checks every need in order, failing on the first that does not fit", () => {
    const result = evaluateGate([{ window: "5h", points: 1 }, { window: "wk", points: 60 }], usage, 10, false, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("wk needs 60 more");
  });

  it("skips a need on a not_enforced window instead of failing with 'usage unknown'", () => {
    const notEnforced = { ...usage, used5h: null, freshness5h: "not_enforced" as const };
    const result = evaluateGate([{ window: "5h", points: 50 }], notEnforced, 10, false, now);
    expect(result).toMatchObject({ allowed: true, not_enforced: ["5h"] });
  });

  it("evaluates the remaining need normally when only one of two windows is not enforced", () => {
    const notEnforced = { ...usage, used5h: null, freshness5h: "not_enforced" as const };
    // used5h is null (would refuse as "5h usage unknown" without the skip
    // above), but the wk need still gets checked against real usage.
    const passes = evaluateGate([{ window: "5h", points: 50 }, { window: "wk", points: 5 }], notEnforced, 10, false, now);
    expect(passes).toMatchObject({ allowed: true, not_enforced: ["5h"] });
    const refuses = evaluateGate([{ window: "5h", points: 50 }, { window: "wk", points: 60 }], notEnforced, 10, false, now);
    expect(refuses).toMatchObject({ allowed: false, reason: expect.stringContaining("wk needs 60 more") });
  });

  it("with --plan, a 5h need must also fit under the plan line, a stricter bar than the reserve alone", () => {
    // Plan line: 50% weekly remaining - 10 reserve = 40 budget over
    // ceil(168h/5h)=34 windows -> ~1.18 points/window. A 5h need of 5 fits
    // the raw reserve (leaves headroom to 90%) but blows the plan line.
    const weekly = evaluateGate([{ window: "5h", points: 5 }], usage, 10, false, now);
    expect(weekly.allowed).toBe(true);
    const planned = evaluateGate([{ window: "5h", points: 5 }], usage, 10, true, now);
    expect(planned.allowed).toBe(false);
    expect(planned.reason).toContain("plan line allows only");
  });
});

describe("computeFill", () => {
  it("returns a positive lane count when both the window and the weekly budget have slack", () => {
    // 85% used, 15% remaining, minus 5-point margin = 10 usable; lane cost 2%.
    const result = computeFill(85, 10, 2, 10);
    expect(result.lanes).toBe(5);
    expect(result.points_used).toBeCloseTo(10, 6);
    expect(result.reason).toContain("lanes fit");
  });

  it("returns 0 with a weekly reason once the weekly usage sits at the reserve", () => {
    // Weekly used 90%, reserve 10% -> 0 weekly budget left, regardless of how
    // much 5h room remains.
    const result = computeFill(20, 90, 2, 10);
    expect(result.lanes).toBe(0);
    expect(result.reason).toContain("weekly reserve would be breached");
  });

  it("returns 0 with a 5h-window reason when the weekly budget is not the binding constraint", () => {
    // 96% used in the 5h window leaves only 4 - 5 margin = negative; weekly is wide open.
    const result = computeFill(96, 5, 2, 10);
    expect(result.lanes).toBe(0);
    expect(result.reason).toContain("safety margin");
  });

  it("falls back to the calibration ratio (22 weekly points per full 5h window) for the weekly cost per lane", () => {
    // lane cost 10% of a 5h window -> weekly cost per lane = 10 * 22/100 = 2.2.
    const result = computeFill(0, 0, 10, 10);
    // weekly budget = 90; lanes by weekly = floor(90/2.2) = 40; by 5h = floor((100-5)/10) = 9.
    expect(result.lanes).toBe(9);
  });
});

describe("fillClassFits", () => {
  it("only lists classes that fit in both the remaining points and the remaining minutes, at least once", () => {
    const costs = { review: { percent: 4, duration_minutes: 5 }, "design-pass": { percent: 8, duration_minutes: 10 }, "fable-build-round": { percent: 15, duration_minutes: 20 } };
    // A window with 6 usable points and 12 minutes left: only review's 4pt/5min
    // fits either constraint; design-pass and fable-build-round need more
    // points than remain.
    const fits = fillClassFits(6, 12, costs);
    expect(fits).toEqual([{ action_class: "review", percent: 4, duration_minutes: 5, fits: 1 }]);
  });

  it("fits multiple runs when both constraints allow it, capped by the tighter of the two", () => {
    const costs = { review: { percent: 4, duration_minutes: 5 } };
    // 20 points / 4 = 5 by points; 12 minutes / 5 = 2 by time -> capped at 2.
    expect(fillClassFits(20, 12, costs)).toEqual([{ action_class: "review", percent: 4, duration_minutes: 5, fits: 2 }]);
  });

  it("skips a class with a non-positive declared cost or duration", () => {
    const costs = { broken: { percent: 0, duration_minutes: 5 } };
    expect(fillClassFits(50, 50, costs)).toEqual([]);
  });
});

describe("waitForReset", () => {
  it("resolves 'unknown' when the meter has no resets_at at all", async () => {
    const outcome = await waitForReset(async () => null, null);
    expect(outcome).toBe("unknown");
  });

  it("resolves 'reset' the moment the stored resets_at value changes", async () => {
    let calls = 0;
    const getResetsAt = async () => { calls += 1; return calls < 3 ? "2026-09-03T17:00:00Z" : "2026-09-03T22:00:00Z"; };
    const sleep = vi.fn(async () => undefined);
    const outcome = await waitForReset(getResetsAt, null, { sleep, now: () => 0 });
    expect(outcome).toBe("reset");
    expect(sleep).toHaveBeenCalled();
  });

  it("resolves 'reset' once wall-clock time reaches the first-seen resets_at, even if it has not changed yet", async () => {
    const getResetsAt = async () => "2026-09-03T12:00:00Z";
    const target = Date.parse("2026-09-03T12:00:00Z");
    const outcome = await waitForReset(getResetsAt, null, { now: () => target + 1 });
    expect(outcome).toBe("reset");
  });

  it("resolves 'timeout' once --max elapses with no reset seen", async () => {
    const getResetsAt = async () => "2026-09-03T22:00:00Z"; // far in the future, never changes
    let clock = 0;
    const sleep = vi.fn(async () => { clock += 1000; });
    const outcome = await waitForReset(getResetsAt, 2500, { sleep, now: () => clock });
    expect(outcome).toBe("timeout");
  });
});
