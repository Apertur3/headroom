// P(hit the limit before the reset) from conditional empirical quantiles.

import { hourOfWeekBucket, hoursToResetBucket, intensityBucket, isIdleReading, loadBucket, quantile, type QuantileTable } from "./table.js";
import { DEFAULT_FORECAST_CONFIG, HOUR_MS, type Forecast, type ForecastConfig, type MeterReading } from "./types.js";

export interface ForecastInput {
  now: number;
  window: { kind: string; minutes: number };
  /** Latest fresh reading of the meter, or null when there is none. */
  latest: MeterReading | null;
  /** The current window's readings up to `latest` (only used by the optional intensity key). */
  windowHistory?: readonly MeterReading[];
  /** Table built only from windows that reset at or before `now`; null when there is no history. */
  table: QuantileTable | null;
  /** Sum of class p50 costs of the leases active now (percent points). */
  activeLoad: number;
  config?: Partial<ForecastConfig>;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export function forecast(input: ForecastInput): Forecast {
  const config: ForecastConfig = { ...DEFAULT_FORECAST_CONFIG, ...input.config };
  const { latest, now, window, table } = input;

  if (latest === null) return { status: "unknown", reason: "no_data", detail: "no fresh reading for this meter" };
  const age = now - latest.at;
  if (age > config.staleAfterMs) {
    return { status: "unknown", reason: "stale", detail: `latest reading is ${Math.round(age / 60_000)} min old` };
  }
  if (window.kind === "rolling" && (table === null || table.size === 0)) {
    return { status: "unknown", reason: "rolling_no_history", detail: "rolling window with no completed history" };
  }
  if (isIdleReading(latest, window.minutes, config.idleToleranceMs)) {
    return { status: "unknown", reason: "no_active_window", detail: "meter is idle; no window is running" };
  }
  const resetsAt = latest.resetsAt as number;
  if (resetsAt <= now) return { status: "unknown", reason: "past_reset", detail: "the reported reset has passed; waiting for a new reading" };
  if (table === null || table.size === 0) return { status: "unknown", reason: "too_sparse", detail: "no completed windows yet" };

  const match = table.lookup({
    htrBucket: hoursToResetBucket(resetsAt - now, window.minutes, config.htrBuckets),
    howBucket: hourOfWeekBucket(now, config.blockHours, config.utcOffsetMinutes),
    loadBucket: loadBucket(input.activeLoad, config.loadEdges),
    intensityBucket: intensityBucket(input.windowHistory ?? [latest], latest, window.minutes, config),
  });
  if (match === null) {
    return {
      status: "unknown",
      reason: "too_sparse",
      detail: `fewer than ${config.minSamples} samples from ${config.minCycles} windows at every level (${table.size} samples, ${table.cycles} windows)`,
    };
  }

  const shift = config.shiftMode === "always" || (config.shiftMode === "unkeyed" && !match.keyedOnLoad) ? Math.max(0, input.activeLoad) : 0;
  const headroom = Math.max(0, 100 - latest.used);
  const draws = match.samples.map((s) => Math.min(headroom, Math.max(0, s.draw + shift))).sort((a, b) => a - b);
  const hits = draws.filter((d) => latest.used + d >= config.threshold).length;
  const mean = draws.reduce((sum, d) => sum + d, 0) / draws.length;
  const q = (p: number): number => quantile(draws, p);
  const at = (d: number): number => round(Math.min(100, latest.used + d));

  return {
    status: "ok",
    threshold: config.threshold,
    pHit: hits / draws.length,
    used: latest.used,
    hoursToReset: round((resetsAt - now) / HOUR_MS),
    expectedAtReset: at(mean),
    interval50: [at(q(0.25)), at(q(0.75))],
    interval90: [at(q(0.05)), at(q(0.95))],
    remaining: { p05: round(q(0.05)), p25: round(q(0.25)), p50: round(q(0.5)), p75: round(q(0.75)), p95: round(q(0.95)), mean: round(mean) },
    samples: draws.length,
    cycles: match.cycles,
    level: match.level,
    shift: round(shift),
  };
}
