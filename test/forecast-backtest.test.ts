import { describe, expect, it } from "vitest";
import { runBacktest, seriesFromExport, type ExportFile, type ExportObservation } from "../src/forecast/backtest.js";

// A synthetic export: one account, a 5-hour meter read every 10 minutes for
// 14 days. Week 1 is quiet (windows burn 10 points); week 2 is heavy (every
// window reaches 100). Nothing here is real usage data.
const DAY = 24 * 3_600_000;
const MIN = 60_000;
const SINCE = Date.UTC(2026, 0, 5);

function observation(at: number, used: number | null, resetsAt: number | null, meter = "synthetic-account:all"): ExportObservation {
  return {
    meter_id: meter,
    principal_id: "principal-1",
    window: used === null ? null : { kind: "fixed", minutes: 300 },
    quantity: used === null ? null : { used, unit: "percent" },
    resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    observed_at: new Date(at).toISOString(),
    freshness: used === null ? "failed" : "fresh",
  };
}

function syntheticExport(options: { gapAt?: number } = {}): ExportFile {
  const observations: ExportObservation[] = [];
  for (let start = SINCE; start + 300 * MIN <= SINCE + 14 * DAY; start += 300 * MIN) {
    const heavy = start >= SINCE + 7 * DAY;
    for (let m = 0; m < 300; m += 10) {
      const at = start + m * MIN;
      if (options.gapAt !== undefined && at >= options.gapAt && at < options.gapAt + 60 * MIN) {
        observations.push(observation(at, null, null)); // failed reads: no fresh data for an hour
        continue;
      }
      const used = heavy ? Math.min(100, (m / 240) * 100) : (m / 290) * 10;
      observations.push(observation(at, used, start + 300 * MIN));
    }
  }
  return {
    range: { since: new Date(SINCE).toISOString(), until: new Date(SINCE + 14 * DAY).toISOString() },
    observations,
    leases: [],
  };
}

describe("backtest harness", () => {
  it("labels series by account letter, never by meter id", () => {
    const series = seriesFromExport(syntheticExport());
    expect(series).toHaveLength(1);
    expect(series[0].label).toBe("account A 5h");
    expect(series[0].label).not.toContain("synthetic-account");
  });

  it("uses only history available at each step (no look-ahead)", () => {
    const report = runBacktest(syntheticExport(), { initDays: 7, stepMinutes: 30, thresholds: [100], evalDays: 7.6 });
    const s = report.series[0];
    // The first heavy window (07:00 to 12:00 on day 7) is scored against a table built only
    // from quiet week 1; the next one ends after the evaluation and is censored. So the
    // forecaster cannot know that week 2 windows all hit 100.
    expect(s.forecasterAnswered).toBeGreaterThan(0);
    const t = s.thresholds[0];
    expect(t.events).toBeGreaterThan(0);
    expect(t.decisions.forecaster.falseGo).toBe(t.events);
  });

  it("learns heavy windows once they have completed, and runs every metric", () => {
    const report = runBacktest(syntheticExport(), { initDays: 7, stepMinutes: 30, thresholds: [100, 80] });
    const s = report.series[0];
    expect(s.cyclesInEval).toBeGreaterThan(30);
    const t = s.thresholds[0];
    expect(t.brier.forecaster).not.toBeNull();
    expect(t.brier.straightLine).not.toBeNull();
    expect(t.reliability.reduce((n, b) => n + b.n, 0)).toBe(t.n);
    expect(s.remaining.coverage90).not.toBeNull();
    // As heavy windows complete during week 2 they enter the table, so later forecasts rise.
    expect(t.reliability.filter((b) => b.lo >= 0.2).reduce((n, b) => n + b.n, 0)).toBeGreaterThan(0);
  });

  it("never returns a number on stale data", () => {
    const gapAt = SINCE + 9 * DAY + 2 * 3_600_000;
    const report = runBacktest(syntheticExport({ gapAt }), { initDays: 7, stepMinutes: 10, thresholds: [100] });
    const s = report.series[0];
    expect(s.stale).toBeGreaterThan(0);
    expect(s.staleApprovals).toBe(0);
    expect(s.unknown.stale).toBe(s.stale);
  });
});
