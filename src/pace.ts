/**
 * Burn rate and sustainable pace: pure math over a meter window's recent
 * fresh samples. No I/O here -- src/store.ts collects the samples from
 * history, and this module turns them into a rate, a time-to-empty, and a
 * sustainable-pace figure that the CLI, the daemon and the MCP server all
 * attach to the same observation objects the same way.
 */
import { formatResetsIn, withResetsIn, type ResetsIn } from "./resets.js";
import type { LastKnownReading, Observation } from "./types.js";

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

export interface EffectiveFreshness {
  freshness: Observation["freshness"];
  reason?: string | null;
}

/**
 * The freshness a reader is served, evaluated at response time rather than
 * copied from the moment a row entered SQLite. History deliberately retains
 * its original vendor result; this only keeps a long-unpolled `fresh` row
 * from being presented as current. The comparison and strict boundary match
 * policy.ts's freshnessGate/paceDecision exactly.
 */
export function effectiveFreshness(observation: Observation, stalenessMinutes: number, now = new Date()): EffectiveFreshness {
  if (observation.freshness !== "fresh") return { freshness: observation.freshness, reason: observation.reason };
  const fetched = Date.parse(observation.fetched_at);
  if (!Number.isFinite(fetched) || now.getTime() - fetched <= stalenessMinutes * 60_000) {
    return { freshness: observation.freshness, reason: observation.reason };
  }
  const ageSeconds = Math.max(0, (now.getTime() - fetched) / 1000);
  const age = ageSeconds < 60 ? "<1m" : formatResetsIn(ageSeconds);
  const staleReason = `last accepted reading ${age} ago`;
  return { freshness: "stale", reason: observation.reason ? `${staleReason}; ${observation.reason}` : staleReason };
}

/** Applies effectiveFreshness without mutating stored-shaped inputs. Kept
 * separate from withStatusInfo so renderers that receive an already-enriched
 * daemon payload can still protect a direct caller without recomputing its
 * store-backed burn and last-known data. */
export function withEffectiveFreshness(observations: Observation[], stalenessMinutes: number, now = new Date()): Observation[] {
  return observations.map((item) => ({ ...item, ...effectiveFreshness(item, stalenessMinutes, now) }));
}

/**
 * Attaches `last_known` (see types.ts) to every observation whose own
 * served `freshness` is `failed` or `stale` -- the two values that always
 * render as UNKNOWN (see policy.ts's paceDecision) -- from a map
 * store.ts's lastKnownFor() already collected, keyed the same way as `burn`
 * above. A fresh observation, or an UNKNOWN one with nothing fresh in the
 * lookback, gets `last_known: null`: this is purely informational, so it is
 * always present on the shape rather than sometimes-absent.
 *
 * A windowless failure (`window: null`, e.g. a Keychain grant or transport
 * failure -- the failure speaks for the whole meter) looks up
 * `${meter_id}:none` instead of `${meter_id}:${minutes}`: lastKnownFor()
 * fills that key with the tightest window of the same meter that still has
 * a fresh reading, carrying its own `window_minutes` along.
 */
export function withLastKnown<T extends Observation>(observations: T[], lastKnown: Map<string, LastKnownReading>): Array<T & { last_known: LastKnownReading | null }> {
  return observations.map((item) => {
    if (item.freshness !== "failed" && item.freshness !== "stale") return { ...item, last_known: null };
    const key = item.window === null ? `${item.meter_id}:none` : item.window.minutes ? `${item.meter_id}:${item.window.minutes}` : undefined;
    const known = key ? lastKnown.get(key) : undefined;
    return { ...item, last_known: known ?? null };
  });
}

/**
 * The one response-time status shape: served freshness, pace, last-known and
 * reset countdowns all come from the same clock. Store rows stay verbatim;
 * only callers returning observations to people or agents use this helper.
 */
export function withStatusInfo(
  observations: Observation[],
  burn: Map<string, BurnInfo>,
  lastKnown: Map<string, LastKnownReading>,
  stalenessMinutes: number,
  now = new Date(),
): Array<Observation & BurnInfo & { sustainable_percent_per_hour: number | null; last_known: LastKnownReading | null } & ResetsIn> {
  const served = withEffectiveFreshness(observations, stalenessMinutes, now);
  return withResetsIn(withLastKnown(withPaceInfo(served, burn, now), lastKnown), now);
}
