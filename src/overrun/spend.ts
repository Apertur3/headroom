// Rebuilds a lease's spend path from the watched window's readings.
//
// Spend at a reading = how far the window has moved since the last fresh
// reading before the lease started (the baseline). A drop counts as a window
// reset only when resets_at moved forward; then the movement before the reset
// is kept and the new window counts from zero. Any other drop is treated as
// vendor noise and the running maximum is kept. Missing, stale or failed
// readings never produce a number: the result says why instead.

import { MINUTE_MS, type OverrunConfig, type OverrunReading } from "./types.js";

export interface SpendPoint {
  at: number;
  spent: number;
  used: number;
}

export type SpendPath =
  | { ok: true; points: SpendPoint[] }
  | { ok: false; reason: string };

function minutes(ms: number): string {
  return `${Math.round(ms / MINUTE_MS)} min`;
}

function isFresh(r: OverrunReading): r is OverrunReading & { used: number } {
  return r.fresh && typeof r.used === "number" && Number.isFinite(r.used);
}

function isReset(previous: OverrunReading & { used: number }, current: OverrunReading & { used: number }, config: OverrunConfig): boolean {
  if (current.used >= previous.used) return false;
  if (previous.resetsAt == null || current.resetsAt == null) return false;
  return current.resetsAt - previous.resetsAt >= config.resetShiftMinutes * MINUTE_MS;
}

/** The spend path from the baseline up to `now`, or the reason it is UNKNOWN. Points start with the baseline at spend 0. */
export function spendPath(readings: readonly OverrunReading[], startedAt: number, now: number, config: OverrunConfig): SpendPath {
  const sorted = readings.filter((r) => r.at <= now).sort((a, b) => a.at - b.at);
  if (!sorted.length) return { ok: false, reason: "no reading yet" };
  const latest = sorted[sorted.length - 1];
  if (!isFresh(latest)) return { ok: false, reason: "latest reading is stale or failed" };
  if (now - latest.at > config.maxReadingAgeMinutes * MINUTE_MS) return { ok: false, reason: `latest reading is ${minutes(now - latest.at)} old` };

  let baselineIndex = -1;
  for (let i = 0; i < sorted.length && sorted[i].at <= startedAt; i++) if (isFresh(sorted[i])) baselineIndex = i;
  const baseline = baselineIndex >= 0 ? (sorted[baselineIndex] as OverrunReading & { used: number }) : null;
  if (!baseline || startedAt - baseline.at > config.maxBaselineAgeMinutes * MINUTE_MS) {
    return { ok: false, reason: `no fresh reading within ${config.maxBaselineAgeMinutes} min before the lease started` };
  }

  const points: SpendPoint[] = [{ at: baseline.at, spent: 0, used: baseline.used }];
  let closed = 0;
  let segmentBase = baseline.used;
  let segmentMax = baseline.used;
  let previous = baseline;
  for (let i = baselineIndex + 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (!isFresh(r)) continue;
    if (isReset(previous, r, config)) {
      closed += segmentMax - segmentBase;
      segmentBase = 0;
      segmentMax = r.used;
    } else {
      segmentMax = Math.max(segmentMax, r.used);
    }
    points.push({ at: r.at, spent: closed + segmentMax - segmentBase, used: r.used });
    previous = r;
  }
  return { ok: true, points };
}

/**
 * Percent per minute over the last `rateWindowMinutes`: from the newest point
 * back to the newest point at least that far before it (or the baseline when
 * the lease is younger). Null when the two points are closer than
 * minRateSpanMinutes or further apart than maxRateSpanMinutes.
 */
export function recentRate(points: readonly SpendPoint[], config: OverrunConfig): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  let ref: SpendPoint | null = null;
  for (let i = points.length - 2; i >= 0; i--) {
    if (latest.at - points[i].at >= config.rateWindowMinutes * MINUTE_MS) { ref = points[i]; break; }
  }
  if (!ref) ref = points[0];
  const span = latest.at - ref.at;
  if (span < config.minRateSpanMinutes * MINUTE_MS || span > config.maxRateSpanMinutes * MINUTE_MS) return null;
  return (latest.spent - ref.spent) / (span / MINUTE_MS);
}
