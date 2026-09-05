/**
 * Burn rate and sustainable pace: pure math over a meter window's recent
 * fresh samples. No I/O here -- src/store.ts collects the samples from
 * history, and this module turns them into a rate, a time-to-empty, and a
 * sustainable-pace figure that the CLI, the daemon and the MCP server all
 * attach to the same observation objects the same way.
 */
import type { Observation } from "./types.js";

export interface BurnInfo {
  /** Least-squares slope of used-percent against time, in percent per hour.
   * Null with fewer than two fresh samples in the lookback window. */
  burn_percent_per_hour: number | null;
  /** Seconds until usage would reach 100% at that burn. Null when burn is
   * unknown, zero, or negative (steady or falling usage never empties). */
  empty_in_seconds: number | null;
}

export interface BurnSample {
  /** Milliseconds since epoch. */
  at: number;
  used: number;
}

/** Least-squares slope of `used` against `at`, converted from percent-per-ms
 * to percent-per-hour. Null with fewer than two samples, or when every
 * sample shares the same timestamp (a zero time spread has no defined
 * slope). */
export function leastSquaresBurnPerHour(samples: BurnSample[]): number | null {
  if (samples.length < 2) return null;
  const n = samples.length;
  const meanAt = samples.reduce((sum, sample) => sum + sample.at, 0) / n;
  const meanUsed = samples.reduce((sum, sample) => sum + sample.used, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const dx = sample.at - meanAt;
    numerator += dx * (sample.used - meanUsed);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;
  const slopePerMs = numerator / denominator;
  return slopePerMs * 3_600_000;
}

/** Seconds until usage reaches 100% at a constant burn. Null when burn is
 * unknown or not positive. */
export function emptyInSeconds(usedPercent: number, burnPercentPerHour: number | null): number | null {
  if (burnPercentPerHour === null || burnPercentPerHour <= 0) return null;
  const remaining = Math.max(0, 100 - usedPercent);
  return (remaining / burnPercentPerHour) * 3600;
}

/** The straight-line percent-per-hour pace that would spend exactly the
 * remaining allowance by the reset time -- neither leaving room unused nor
 * running out early. Null when there is no reset to aim for, or the reset
 * has already passed. */
export function sustainablePercentPerHour(remainingPercent: number, resetsAt: string | null, now = new Date()): number | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const hours = (target - now.getTime()) / 3_600_000;
  if (hours <= 0) return null;
  return remainingPercent / hours;
}

/**
 * Attaches burn_percent_per_hour, empty_in_seconds and
 * sustainable_percent_per_hour to every observation, without mutating the
 * input. `burn` is keyed by `${meter_id}:${window_minutes}`, matching the
 * key scheme store.ts's burnRateFor() and resets.ts's resetSeenFor() both use.
 */
export function withPaceInfo<T extends Observation>(observations: T[], burn: Map<string, BurnInfo>, now = new Date()): Array<T & BurnInfo & { sustainable_percent_per_hour: number | null }> {
  return observations.map((item) => {
    const minutes = item.window?.minutes;
    const info = minutes ? burn.get(`${item.meter_id}:${minutes}`) : undefined;
    const remaining = item.quantity?.unit === "percent" ? item.quantity.remaining ?? (item.quantity.limit !== null ? item.quantity.limit - item.quantity.used : null) : null;
    const sustainable = remaining === null ? null : sustainablePercentPerHour(remaining, item.resets_at, now);
    return { ...item, burn_percent_per_hour: info?.burn_percent_per_hour ?? null, empty_in_seconds: info?.empty_in_seconds ?? null, sustainable_percent_per_hour: sustainable };
  });
}
