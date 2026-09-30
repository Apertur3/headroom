/**
 * Burn rate and sustainable pace: pure math over a meter window's recent
 * fresh samples. No I/O here -- src/store.ts collects the samples from
 * history, and this module turns them into a rate, a time-to-empty, and a
 * sustainable-pace figure that the CLI, the daemon and the MCP server all
 * attach to the same observation objects the same way.
 */
import { blockedLaneSummary, isHeldReading } from "./policy.js";
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
 * The freshness a reader is served, evaluated against the current serving
 * clock every time this is called -- including on an already-enriched daemon
 * row (one that already carries `status_enriched_at`). A stale render loop
 * (the dashboard, the browser report, a cached CLI payload) must re-run this
 * gate rather than trust a marker from whenever the row was first served:
 * otherwise a row marked fresh minutes or hours ago stays "fresh" forever,
 * no matter how far it has since aged past `stalenessMinutes`. A renderer
 * that re-stales a row this way has no store-backed last_known lookup to
 * refresh alongside it -- see withLastKnown below, which always serves
 * `last_known: null` for a row whose stored freshness was never anything but
 * fresh, exactly the case here. That is the correct fail-closed answer: an
 * UNKNOWN reading with no last-known figure beats a `fresh` one serving
 * capacity nobody re-confirmed. History deliberately retains its original
 * vendor result; this only keeps a long-unpolled `fresh` row from being
 * presented as current. The comparison and strict boundary match
 * policy.ts's freshnessGate/paceDecision exactly.
 */
/** "last accepted reading Nm/Nh/Nd ago[; <observation.reason>]", the wording
 * an aged-out fresh row has always been served with -- shared so the
 * immediate held-reading branch below can reuse the exact same age phrase
 * and reason-combining rule instead of a different, synthetic explanation. */
function agedFreshReason(observation: Observation, now: Date): string {
  const fetched = Date.parse(observation.fetched_at);
  if (!Number.isFinite(fetched)) return "invalid fetch time";
  const ageSeconds = Math.max(0, (now.getTime() - fetched) / 1000);
  const age = ageSeconds < 60 ? "<1m" : formatResetsIn(ageSeconds);
  const staleReason = `last accepted reading ${age} ago`;
  return observation.reason ? `${staleReason}; ${observation.reason}` : staleReason;
}

export function effectiveFreshness(observation: Observation, stalenessMinutes: number, now = new Date()): EffectiveFreshness {
  // Match paceDecision's order: state and count observations have their own
  // policy states and never enter its timestamp age gate.
  if (observation.window?.kind === "state" || observation.window?.kind === "count") {
    return { freshness: observation.freshness, reason: observation.reason };
  }
  if (observation.freshness !== "fresh") return { freshness: observation.freshness, reason: observation.reason };
  // Like paceDecision, a malformed percent-window shape is UNKNOWN for its
  // missing data rather than a synthetic age state.
  if (!observation.quantity || observation.quantity.limit === null || !observation.window?.minutes) {
    return { freshness: observation.freshness, reason: observation.reason };
  }
  const fetched = Date.parse(observation.fetched_at);
  // paceDecision rejects this as UNKNOWN. Serve it as stale too so no
  // renderer can present a timestamp it could not validate as fresh.
  if (!Number.isFinite(fetched)) return { freshness: "stale", reason: "invalid fetch time" };
  if (now.getTime() - fetched <= stalenessMinutes * 60_000) {
    // A held vendor-window baseline (policy.ts's isHeldReading) is served
    // stale immediately, at any age, matching paceDecision/freshnessGate: it
    // must never be presented as fresh capacity while its identity is
    // unconfirmed, not only once it also crosses stalenessMinutes. Its
    // reason is left untouched here -- there is no age story to tell yet,
    // and several renderers (browser-report, dashboard, status-view)
    // already build their own held-specific note straight from the metadata
    // flags. Once a held reading also ages past stalenessMinutes it falls
    // through to the exact same age-phrase-plus-reason wording below that
    // any other aged-out row gets -- heldWindowReason's fuller explanation
    // is reserved for paceDecision/freshnessGate's own reason, which is what
    // status text actually renders.
    if (isHeldReading(observation)) return { freshness: "stale", reason: observation.reason };
    return { freshness: observation.freshness, reason: observation.reason };
  }
  return { freshness: "stale", reason: agedFreshReason(observation, now) };
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
  return withResetsIn(withLastKnown(withPaceInfo(served, burn, now), lastKnown), now)
    .map((item) => ({ ...item, ...staleMark(item, now), ...blockedMark(item), status_enriched_at: now.toISOString() }));
}

/** Additive: a lane blocked by its exhausted weekly carries a one-line
 * summary for readers that render text (MCP quota_status, the dashboard).
 * Absent on every other row, and never a number. */
function blockedMark(item: Observation): { blocked_summary?: string } {
  const summary = blockedLaneSummary(item);
  return summary ? { blocked_summary: summary } : {};
}

/** The explicit "this is not current" marker: any windowed reading served
 * stale or failed carries `stale: true` and, when known, how old its last
 * accepted reading is. Absent on a fresh or not_enforced row. */
function staleMark(item: Observation & { last_known?: LastKnownReading | null }, now: Date): { stale?: true; stale_age_seconds?: number } {
  if (item.freshness !== "stale" && item.freshness !== "failed") return {};
  if (item.window?.kind === "state" || item.window?.kind === "count") return {};
  const own = item.freshness === "stale" ? (now.getTime() - Date.parse(item.fetched_at)) / 1000 : Number.NaN;
  const age = item.last_known?.age_seconds ?? own;
  return { stale: true, ...(Number.isFinite(age) ? { stale_age_seconds: Math.max(0, Math.floor(age)) } : {}) };
}
