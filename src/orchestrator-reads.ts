/**
 * Shared read-side logic for `rate`, `plan`, `gate` and `fill`: takes an
 * already-open HeadroomStore and turns its stored observations into the
 * inputs pacing.ts's pure functions need. The daemon's JSON-RPC handlers and
 * the CLI/MCP no-daemon fallbacks both call these, so the two paths can never
 * drift into computing a different answer for the same stored data.
 */
import { readRouting } from "./config.js";
import { computeFill, computePlan, evaluateBurst, evaluateGate, evaluateProRataLine, fillClassFits, type FillClassFit, type FillResult, type GateNeed, type GateResult, type PlanResult } from "./pacing.js";
import { maxMoreBeforeReset } from "./cost.js";
import type { HeadroomStore } from "./store.js";
import type { Observation, StoredObservation } from "./types.js";

/** The enforced, fresh, percent-quantity window with the highest used% for a
 * meter -- an approximation of "the window that decided this", good enough
 * for the advisory remaining-percent figure `can`'s cost report prints. Used
 * identically by the CLI and the MCP server's direct (no-daemon) path. */
export function pickDecidingObservation(rows: Observation[]): Observation | undefined {
  const candidates = rows.filter((row) => row.freshness === "fresh" && row.quantity?.unit === "percent" && row.window?.kind !== "count");
  if (!candidates.length) return undefined;
  return candidates.reduce((worst, row) => ((row.quantity as { used: number }).used > (worst.quantity as { used: number }).used ? row : worst));
}

/** The enforced percent windows for one meter, ordered short to long. Local
 * pools (window kind `state`) and availability counts (`count`) are never
 * included: neither carries a percent used against a reset. */
function enforcedPercentWindows(store: HeadroomStore, meterId: string): StoredObservation[] {
  return store.latestPerWindow(meterId)
    .filter((row) => row.quantity?.unit === "percent" && row.window?.kind !== "state" && row.window?.kind !== "count" && row.window?.minutes)
    .sort((a, b) => (a.window!.minutes as number) - (b.window!.minutes as number));
}

export interface MeterWindows { short?: StoredObservation; long?: StoredObservation; }

/** The shortest window (typically the 5h one) and the longest (typically the
 * weekly one) currently known for a meter. Either may be absent; with only
 * one window known, `long` stays absent rather than aliasing the same row
 * `short` already names -- callers that only care about a genuine second
 * (weekly) window must be able to tell "no weekly window yet" apart from
 * "the only window IS the weekly one". */
export function meterWindows(store: HeadroomStore, meterId: string): MeterWindows {
  const rows = enforcedPercentWindows(store, meterId);
  return { short: rows[0], long: rows.length > 1 ? rows[rows.length - 1] : undefined };
}

export interface RateLine {
  meter: string;
  window_minutes: number | null;
  used_percent: number | null;
  burn_percent_per_hour: number | null;
  empty_in_seconds: number | null;
  resets_at: string | null;
}

/** One rate line per window: with a meter given, every enforced window of
 * that meter; without one, every known meter's shortest (primary) window,
 * so a broad read stays one line per account instead of flooding the
 * terminal with every weekly window too. */
export function rateLines(store: HeadroomStore, meter: string | undefined, lookbackMinutes: number, now = new Date()): RateLine[] {
  const meterIds = meter ? [meter] : [...new Set(store.latestPerWindow().map((row) => row.meter_id))];
  const lines: RateLine[] = [];
  for (const id of meterIds) {
    const rows = enforcedPercentWindows(store, id);
    const targets = meter ? rows : rows.slice(0, 1);
    for (const row of targets) {
      const burn = store.burnRateFor([row], now, lookbackMinutes).get(`${row.meter_id}:${row.window!.minutes}`) ?? { burn_percent_per_hour: null, empty_in_seconds: null };
      lines.push({ meter: id, window_minutes: row.window!.minutes, used_percent: row.quantity!.used, burn_percent_per_hour: burn.burn_percent_per_hour, empty_in_seconds: burn.empty_in_seconds, resets_at: row.resets_at });
    }
  }
  return lines;
}

export type PlanOutcome = ({ meter: string } & PlanResult) | { meter: string; error: string };

export function planFor(store: HeadroomStore, meter: string, reservePercent: number, now = new Date()): PlanOutcome {
  const { short, long } = meterWindows(store, meter);
  if (!long || !long.resets_at) return { meter, error: `no weekly window for ${meter}` };
  const hoursPerWindow = short?.window?.minutes ? short.window.minutes / 60 : 5;
  return { meter, ...computePlan(long.quantity!.used, long.resets_at, hoursPerWindow, reservePercent, now) };
}

export interface GateOptions {
  owner?: string;
  /** Overrides the owner's planned share of the 5h window (see
   * evaluateProRataLine); when absent, the owner's active leases' expected
   * percent on the meter plus the 5h request itself stands in for it. */
  planSharePercent?: number;
  /** The caller's cost class, for the "remaining lane count" report -- purely
   * informational, no gating effect of its own. */
  actionClass?: string;
  /** policy.toml's pacing: "even" (default) enforces the pro-rata line and
   * the burst check for a 5h need; "none" skips both. */
  pacing?: "even" | "none";
}

export interface GateOutcome extends GateResult {
  meters_checked: string[];
  /** Present only with actionClass and a learned cost for it: how many more
   * of that class fit in the deciding meter's remaining 5h percent. */
  lanes_remaining_for_class?: number | null;
}

/** Fail closed over every meter checked: with no --meter, every account meter
 * that has both a short and a long window must pass, and the first one that
 * does not stops the check (mirrors policy.ts's canConsume: one bad meter
 * blocks the whole gate). */
export function gateFor(store: HeadroomStore, needs: GateNeed[], meter: string | undefined, reservePercent: number, usePlan: boolean, now = new Date(), options: GateOptions = {}): GateOutcome {
  const candidates = meter ? [meter] : [...new Set(store.latestPerWindow().map((row) => row.meter_id))];
  const checked: string[] = [];
  const pacing = options.pacing ?? "even";
  let lastShort: StoredObservation | undefined;
  for (const id of candidates) {
    const { short, long } = meterWindows(store, id);
    if (!short && !long) continue; // a local pool or availability-only meter: nothing to gate
    checked.push(id);
    lastShort = short ?? lastShort;
    const usage = {
      used5h: short?.quantity?.used ?? null,
      usedWk: long?.quantity?.used ?? null,
      weeklyResetsAt: long?.resets_at ?? null,
      hoursPer5hWindow: short?.window?.minutes ? short.window.minutes / 60 : 5,
    };
    const result = evaluateGate(needs, usage, reservePercent, usePlan, now);
    if (!result.allowed) return { ...result, meters_checked: checked };

    const fiveHourNeed = needs.find((need) => need.window === "5h");
    if (pacing === "even" && fiveHourNeed && short?.resets_at && short.window?.minutes && options.owner) {
      const windowStart = new Date(Date.parse(short.resets_at) - short.window.minutes * 60_000);
      const windowHours = short.window.minutes / 60;
      const ownerLeases = store.leases(id, true, now).filter((lease) => lease.owner === options.owner);
      const plannedShare = options.planSharePercent ?? (ownerLeases.reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0) + fiveHourNeed.points);
      const usedSoFar = ownerLeases.reduce((sum, lease) => sum + lease.spent_percent, 0);
      const proRata = evaluateProRataLine({ usedSoFarByOwnerPercent: usedSoFar, requestPercent: fiveHourNeed.points, plannedSharePercent: plannedShare, windowStart, windowDurationHours: windowHours, now });
      if (!proRata.allowed) return { allowed: false, reason: proRata.reason, meters_checked: checked };
      const burst10m = store.burnRateFor([short], now, 10).get(`${id}:${short.window.minutes}`);
      const burst = evaluateBurst({ burnPercentPerHour10m: burst10m?.burn_percent_per_hour ?? null, plannedSharePercent: plannedShare, windowDurationHours: windowHours, usedPercent: short.quantity!.used, windowStart });
      if (!burst.allowed) return { allowed: false, reason: burst.reason, meters_checked: checked };
    }
  }
  if (!checked.length) return { allowed: false, reason: meter ? `no windowed reading for ${meter}` : "no meters configured", meters_checked: checked };
  const lanesRemaining = options.actionClass && lastShort?.quantity?.unit === "percent" ? (() => {
    const learned = store.learnedCost(options.actionClass)[0];
    const remaining = lastShort!.quantity!.remaining ?? (100 - lastShort!.quantity!.used);
    return learned ? maxMoreBeforeReset(remaining, learned.median_percent) : null;
  })() : undefined;
  return { allowed: true, reason: "fits", meters_checked: checked, ...(lanesRemaining !== undefined ? { lanes_remaining_for_class: lanesRemaining } : {}) };
}

export interface FillOutcome {
  meter: string;
  /** Null with no --lane-cost and no learned cost for this meter yet: the
   * per-class list below still stands on its own in that case. */
  lanes: FillResult | null;
  lanes_error: string | null;
  classes: FillClassFit[];
  used_5h_percent: number | null;
  used_weekly_percent: number | null;
  resets_in_seconds: number | null;
  lane_cost_percent: number | null;
  lane_cost_source: "given" | "learned" | "unknown";
  /** "full": the window's whole remaining points, offered outside even
   * pacing or inside the last 45 minutes before reset (nothing left to
   * smooth by then). "pro_rata": even pacing restricted the offer to the
   * owner's pro-rata line, this far from reset. */
  allowance_basis: "full" | "pro_rata";
}

export interface FillOptions {
  owner?: string;
  planSharePercent?: number;
  pacing?: "even" | "none";
}

const EVEN_PACING_FULL_BURST_MINUTES = 45;

/**
 * How many more lanes of a fixed cost fit in the current 5h window before
 * reset (capped by the weekly reserve), and separately, which routing.toml
 * action classes fit at least once in the window's remaining points and
 * remaining minutes -- learned per-class costs override the static
 * routing.toml numbers wherever samples exist. The two halves are
 * independent: a meter with no learned or given lane cost still gets its
 * class breakdown, just with lanes left null.
 *
 * Under even pacing (the default), the lane count only spends the window's
 * full remaining points in the last 45 minutes before reset -- the point
 * past which nothing is left to smooth. Earlier than that, it offers only
 * the owner's pro-rata allowance (planned share times elapsed fraction,
 * minus what that owner has already spent), the same line `gate` enforces.
 */
export async function fillFor(store: HeadroomStore, meter: string, laneCostOverride: number | undefined, weeklyReservePercent: number, now = new Date(), options: FillOptions = {}): Promise<FillOutcome | { meter: string; error: string }> {
  const { short, long } = meterWindows(store, meter);
  if (!short) return { meter, error: `no 5h window for ${meter}` };
  const used5h = short.quantity!.used;
  const usedWeekly = long?.quantity?.used ?? 0;
  const secondsLeft = short.resets_at ? Math.max(0, (Date.parse(short.resets_at) - now.getTime()) / 1000) : null;
  const learned = laneCostOverride === undefined ? store.learnedCostForMeter(meter) : undefined;
  const laneCost = laneCostOverride ?? learned?.median_percent;
  const source: FillOutcome["lane_cost_source"] = laneCostOverride !== undefined ? "given" : learned ? "learned" : "unknown";

  const pacing = options.pacing ?? "even";
  const inFinalStretch = secondsLeft !== null && secondsLeft <= EVEN_PACING_FULL_BURST_MINUTES * 60;
  const restrictedByPacing = pacing === "even" && !inFinalStretch && short.window?.minutes && short.resets_at && options.owner;
  let used5hForLanes = used5h;
  let allowanceBasis: FillOutcome["allowance_basis"] = "full";
  if (restrictedByPacing) {
    const windowStart = new Date(Date.parse(short.resets_at!) - (short.window!.minutes as number) * 60_000);
    const windowHours = (short.window!.minutes as number) / 60;
    const ownerLeases = store.leases(meter, true, now).filter((lease) => lease.owner === options.owner);
    const plannedShare = options.planSharePercent ?? ownerLeases.reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0);
    const usedSoFar = ownerLeases.reduce((sum, lease) => sum + lease.spent_percent, 0);
    const line = evaluateProRataLine({ usedSoFarByOwnerPercent: usedSoFar, requestPercent: 0, plannedSharePercent: plannedShare, windowStart, windowDurationHours: windowHours, now }).line_percent;
    const proRataRemaining = Math.max(0, line - usedSoFar);
    used5hForLanes = Math.max(used5h, 100 - proRataRemaining);
    allowanceBasis = "pro_rata";
  }
  const lanes = laneCost === undefined ? null : computeFill(used5hForLanes, usedWeekly, laneCost, weeklyReservePercent);
  const lanesError = laneCost === undefined ? `no learned cost for ${meter}; pass --lane-cost` : null;

  const routing = await readRouting();
  const costs = Object.fromEntries(Object.entries(routing.costs).map(([actionClass, cost]) => {
    const classLearned = store.learnedCost(actionClass)[0];
    return [actionClass, { percent: classLearned ? classLearned.median_percent : cost.percent, duration_minutes: cost.duration_minutes }];
  }));
  const remainingPercent = Math.max(0, 100 - used5hForLanes) - 5; // same 5-point safety margin as the lane count
  const remainingMinutes = secondsLeft === null ? 0 : secondsLeft / 60;
  const classes = fillClassFits(Math.max(0, remainingPercent), remainingMinutes, costs);

  return { meter, lanes, lanes_error: lanesError, classes, used_5h_percent: used5h, used_weekly_percent: usedWeekly, resets_in_seconds: secondsLeft, lane_cost_percent: laneCost ?? null, lane_cost_source: source, allowance_basis: allowanceBasis };
}
