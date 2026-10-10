// Point-forecast baselines the forecaster must beat. Each projects the
// percent at reset; its P(hit) is 1 when the projection reaches the
// threshold and 0 otherwise.

import { HOUR_MS, MINUTE_MS, type MeterReading } from "./types.js";

export interface PointForecast {
  method: string;
  /** Unclamped projection of percent at reset. */
  projectedAtReset: number;
  /** Projected remaining consumption, clamped to 0..(100 - used). */
  remaining: number;
  pHit: 0 | 1;
}

function point(method: string, latest: MeterReading, ratePerHour: number, threshold: number): PointForecast {
  const hoursLeft = Math.max(0, ((latest.resetsAt as number) - latest.at) / HOUR_MS);
  const rate = Math.max(0, ratePerHour);
  const projected = latest.used + rate * hoursLeft;
  return {
    method,
    projectedAtReset: projected,
    remaining: Math.min(Math.max(0, 100 - latest.used), rate * hoursLeft),
    pHit: projected >= threshold ? 1 : 0,
  };
}

/** Straight-line burn: the average rate since the window started, extrapolated to the reset. */
export function straightLineBurn(latest: MeterReading, windowMinutes: number, threshold = 100): PointForecast | null {
  if (latest.resetsAt === null) return null;
  const windowStart = latest.resetsAt - windowMinutes * MINUTE_MS;
  const elapsedHours = (latest.at - windowStart) / HOUR_MS;
  const rate = elapsedHours > 0 ? latest.used / elapsedHours : 0;
  return point("straight-line", latest, rate, threshold);
}

/**
 * Trailing rate: the change over the last `lookbackMinutes` inside the current
 * window, extrapolated to the reset. `history` holds the window's readings up
 * to and including `latest`. When no reading is old enough, the window start
 * at 0 percent is the anchor.
 */
export function trailingRate(history: readonly MeterReading[], latest: MeterReading, windowMinutes: number, lookbackMinutes: number, threshold = 100): PointForecast | null {
  if (latest.resetsAt === null) return null;
  const cutoff = latest.at - lookbackMinutes * MINUTE_MS;
  let anchor: { at: number; used: number } = { at: latest.resetsAt - windowMinutes * MINUTE_MS, used: 0 };
  for (const reading of history) {
    if (reading.at <= cutoff && reading.at >= anchor.at) anchor = reading;
  }
  const hours = (latest.at - anchor.at) / HOUR_MS;
  const rate = hours > 0 ? (latest.used - anchor.used) / hours : 0;
  return point(`trailing-${lookbackMinutes}m`, latest, rate, threshold);
}
