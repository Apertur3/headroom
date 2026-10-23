import { describe, expect, it } from "vitest";
import { buildCases, formatReport, inferResolution, runBacktest, type ExportFile, type ExportObservation } from "../src/overrun/backtest.js";
import { MINUTE_MS } from "../src/overrun/types.js";

// A synthetic export: one account, one meter polled every 5 minutes for two
// days. Day 1 holds the training leases, day 2 the test leases.
const SINCE = Date.UTC(2026, 0, 5, 0, 0, 0);
const DAY = 24 * 60 * MINUTE_MS;
const METER = "synthetic-meter";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildExport(): ExportFile {
  // Usage climbs inside the listed bursts; flat otherwise. Resets every 5 hours.
  const bursts: { from: number; to: number; perPoll: number }[] = [
    { from: SINCE + 2 * 60 * MINUTE_MS, to: SINCE + 2 * 60 * MINUTE_MS + 30 * MINUTE_MS, perPoll: 2 }, // train big job
    { from: SINCE + DAY + 2 * 60 * MINUTE_MS, to: SINCE + DAY + 2 * 60 * MINUTE_MS + 30 * MINUTE_MS, perPoll: 2 }, // test big job
    { from: SINCE + DAY + 6 * 60 * MINUTE_MS, to: SINCE + DAY + 6 * 60 * MINUTE_MS + 10 * MINUTE_MS, perPoll: 1 }, // overlapping pair
  ];
  const observations: ExportObservation[] = [];
  let used = 0;
  let resetsAt = SINCE + 5 * 60 * MINUTE_MS;
  for (let at = SINCE; at < SINCE + 2 * DAY; at += 5 * MINUTE_MS) {
    if (at >= resetsAt) { used = 0; resetsAt += 5 * 60 * MINUTE_MS; }
    if (bursts.some((b) => at > b.from && at <= b.to)) used += bursts.find((b) => at > b.from && at <= b.to)!.perPoll;
    observations.push({ meter_id: METER, principal_id: "synthetic-principal", window: { kind: "fixed", minutes: 300 }, quantity: { used, unit: "percent" }, resets_at: iso(resetsAt), observed_at: iso(at), freshness: "fresh" });
  }
  const lease = (from: number, minutes: number, expected: number | null) => ({ meter_id: METER, action_class: "synthetic", started_at: iso(from + 30_000), ended_at: iso(from + minutes * MINUTE_MS), expected_percent: expected, spent_percent: 0 });
  return {
    range: { since: iso(SINCE), until: iso(SINCE + 2 * DAY) },
    observations,
    leases: [
      lease(bursts[0].from, 30, 1),
      lease(bursts[1].from, 30, 1),
      lease(bursts[2].from, 10, 1),
      lease(bursts[2].from + 2 * MINUTE_MS, 8, 1),
      lease(SINCE + 10 * 60 * MINUTE_MS, 10, 1), // quiet job
    ],
  };
}

describe("overrun backtest", () => {
  it("rebuilds spend and flags overlapping leases as unattributable", () => {
    const cases = buildCases(buildExport(), SINCE + DAY);
    expect(cases).toHaveLength(5);
    const [trainBig, quiet, testBig, pairA, pairB] = cases;
    expect(trainBig).toMatchObject({ isolated: true, final: 12, window: "fixed:300", resolution: 1 });
    expect(quiet).toMatchObject({ isolated: true, final: 0 });
    expect(testBig).toMatchObject({ isolated: true, final: 12 });
    expect(pairA.isolated).toBe(false);
    expect(pairB.isolated).toBe(false);
  });

  it("scores only isolated leases and splits by time", () => {
    const report = runBacktest(buildExport(), 1);
    expect(report.design.train).toMatchObject({ leases: 2, isolated: 2, reach5: 1, unattributable: 0 });
    expect(report.design.test).toMatchObject({ leases: 3, isolated: 1, reach5: 1, unattributable: 2 });
    // 2 points per 5-minute poll: the spend rule fires at 4 points (lower bound 3 > 2), after passing 3.
    const rules = report.design.test.byMethod.rules;
    expect(rules.bigWarned).toBe(1);
    expect(rules.bigWarnedInTime).toBe(0);
    expect(rules.precision5).toBe(1);
    // The naive baseline (spend above the reservation of 1) warns at 2 points, in time.
    expect(report.design.test.byMethod.naive.bigWarnedInTime).toBe(1);
  });

  it("prints no meter or principal ids", () => {
    const text = formatReport(runBacktest(buildExport(), 1));
    expect(text).not.toContain("synthetic-meter");
    expect(text).not.toContain("synthetic-principal");
    expect(text).toContain("account A");
  });

  it("infers the resolution from training readings only", () => {
    const r = (at: number, used: number) => ({ at, used, fresh: true });
    expect(inferResolution([r(0, 1), r(1, 2)], 10)).toBe(1);
    expect(inferResolution([r(0, 1), r(1, 1.25), r(20, 1.26)], 10)).toBeCloseTo(0.25);
  });
});
