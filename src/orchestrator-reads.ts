/**
 * Shared read-side logic for `rate`, `plan`, `gate` and `fill`: takes an
 * already-open HeadroomStore and turns its stored observations into the
 * inputs pacing.ts's pure functions need. The daemon's JSON-RPC handlers and
 * the CLI/MCP no-daemon fallbacks both call these, so the two paths can never
 * drift into computing a different answer for the same stored data.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readRouting } from "./config.js";
import { computeFill, computePlan, evaluateBurst, evaluateGate, evaluateProRataLine, fillClassFits, type FillClassFit, type FillResult, type GateNeed, type GateResult, type PlanResult } from "./pacing.js";
import { maxMoreBeforeReset } from "./cost.js";
import { canConsume, defaultPolicy, freshnessGate, withOtherOwnerReservations, type Policy } from "./policy.js";
import { withPaceInfo } from "./pace.js";
import type { HeadroomStore } from "./store.js";
import { isLocalAccount, type Account, type Observation, type PaceState, type StoredObservation } from "./types.js";

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
 * included: neither carries a percent used against a reset. A vendor-
 * confirmed not_enforced window (real, just capless) is excluded here too --
 * it has no percent to report -- unlike knownPercentWindows below. */
function enforcedPercentWindows(store: HeadroomStore, meterId: string): StoredObservation[] {
  return store.latestPerWindow(meterId)
    .filter((row) => row.quantity?.unit === "percent" && row.window?.kind !== "state" && row.window?.kind !== "count" && row.window?.minutes)
    .sort((a, b) => (a.window!.minutes as number) - (b.window!.minutes as number));
}

/** Like enforcedPercentWindows, but keeps a vendor-confirmed not_enforced
 * window instead of dropping it: plan/gate need to tell "this window is
 * genuinely capless" (Codex's 5h main window, for one) apart from "this
 * window has never been read yet", which enforcedPercentWindows alone
 * cannot distinguish once the row is filtered out. */
function knownPercentWindows(store: HeadroomStore, meterId: string): StoredObservation[] {
  return store.latestPerWindow(meterId)
    .filter((row) => row.window?.kind !== "state" && row.window?.kind !== "count" && row.window?.minutes && (row.quantity?.unit === "percent" || row.freshness === "not_enforced"))
    .sort((a, b) => (a.window!.minutes as number) - (b.window!.minutes as number));
}

/** When a meter has nothing usable to report against, its own most recent
 * observation (whatever its window or freshness) usually explains why -- a
 * pending Keychain grant, a vendor failure, and so on. Falls back to a
 * generic hint only when the meter genuinely has no reading, or its latest
 * one carries no reason of its own. */
function meterUnknownReason(store: HeadroomStore, meterId: string, fallback: string): string {
  const latest = store.latestPerWindow(meterId)[0];
  return latest?.reason ? latest.reason : fallback;
}

export interface MeterWindows { short?: StoredObservation; long?: StoredObservation; }

/** A window at or above this duration is "long" (the weekly one, currently
 * always exactly 10_080 minutes); anything shorter is "short" (the 5h one,
 * currently always exactly 300 minutes). One day is a wide, deliberately
 * generous boundary between the two -- comfortably above any real 5h-class
 * window and comfortably below any real weekly-class one. */
const LONG_WINDOW_THRESHOLD_MINUTES = 24 * 60;

/** The shortest window (typically the 5h one) and the longest (typically the
 * weekly one) currently known for a meter, including a not_enforced window
 * (see knownPercentWindows) so a meter whose 5h is confirmed capless still
 * resolves its genuine weekly window as `long`. Each slot is picked by its
 * own absolute duration (see LONG_WINDOW_THRESHOLD_MINUTES), never by array
 * position or how many windows are known in total -- a meter whose 5h window
 * has literally never been stored (not even a not_enforced placeholder; the
 * native Swift engine omits it entirely rather than storing one) still has
 * exactly one known window, the weekly one, and it must resolve as `long`,
 * not be aliased to `short` for having arrived alone. Either slot may be
 * absent when no window of that duration class has ever been read. */
export function meterWindows(store: HeadroomStore, meterId: string): MeterWindows {
  const rows = knownPercentWindows(store, meterId);
  return {
    short: rows.find((row) => (row.window!.minutes as number) < LONG_WINDOW_THRESHOLD_MINUTES),
    long: rows.find((row) => (row.window!.minutes as number) >= LONG_WINDOW_THRESHOLD_MINUTES),
  };
}

export interface RateLine {
  meter: string;
  window_minutes: number | null;
  used_percent: number | null;
  burn_percent_per_hour: number | null;
  empty_in_seconds: number | null;
  resets_at: string | null;
  /** Set only on the synthetic line used when a specifically requested meter
   * has no enforced window at all: the meter's own latest reason (e.g. a
   * pending Keychain grant), so a caller sees why instead of a bare "no
   * readings". Absent on every real per-window line. */
  reason?: string | null;
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
    if (meter && !targets.length) {
      const reason = meterUnknownReason(store, id, "");
      if (reason) lines.push({ meter: id, window_minutes: null, used_percent: null, burn_percent_per_hour: null, empty_in_seconds: null, resets_at: null, reason });
      continue;
    }
    for (const row of targets) {
      const burn = store.burnRateFor([row], now, lookbackMinutes).get(`${row.meter_id}:${row.window!.minutes}`) ?? { burn_percent_per_hour: null, empty_in_seconds: null };
      lines.push({ meter: id, window_minutes: row.window!.minutes, used_percent: row.quantity!.used, burn_percent_per_hour: burn.burn_percent_per_hour, empty_in_seconds: burn.empty_in_seconds, resets_at: row.resets_at });
    }
  }
  return lines;
}

export type PlanOutcome = ({ meter: string } & PlanResult) | { meter: string; error: string };

export function planFor(store: HeadroomStore, meter: string, reservePercent: number, now = new Date(), staleMinutes = defaultPolicy.staleness_minutes): PlanOutcome {
  const { short, long } = meterWindows(store, meter);
  if (!long || !long.resets_at) return { meter, error: meterUnknownReason(store, meter, `no weekly window for ${meter}`) };
  // Fail closed on a stale, failed, or long-unpolled weekly reading exactly
  // like gateFor/fillFor do: the plan line is computed straight from
  // long.quantity.used, so an unusable reading there must never turn into a
  // confident-looking plan.
  const freshness = freshnessGate(long, staleMinutes, now);
  if (!freshness.ok) return { meter, error: freshness.reason };
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
  /** policy.toml's staleness_minutes: a window older than this (or one
   * whose freshness itself is stale/failed) is treated as an unusable
   * reading, the same rule paceDecision applies before scoring a pace
   * state. Defaults to defaultPolicy's own value; a caller with the real
   * policy loaded should pass its staleness_minutes here explicitly. */
  staleness_minutes?: number;
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
 * blocks the whole gate). `meter` also accepts an explicit list (a --class
 * resolved through routing.toml to several meters), checked the same way. */
export function gateFor(store: HeadroomStore, needs: GateNeed[], meter: string | string[] | undefined, reservePercent: number, usePlan: boolean, now = new Date(), options: GateOptions = {}): GateOutcome {
  const candidates = meter === undefined ? [...new Set(store.latestPerWindow().map((row) => row.meter_id))] : Array.isArray(meter) ? meter : [meter];
  const checked: string[] = [];
  const pacing = options.pacing ?? "even";
  const staleMinutes = options.staleness_minutes ?? defaultPolicy.staleness_minutes;
  const need5h = needs.some((need) => need.window === "5h");
  const needWk = needs.some((need) => need.window === "wk");
  let lastShort: StoredObservation | undefined;
  let lastResult: GateResult | undefined;
  for (const id of candidates) {
    const { short, long } = meterWindows(store, id);
    if (!short && !long) {
      // A meter with zero readings of ANY kind is treated the same as a
      // local pool or availability-only meter (nothing percent-based to
      // gate): skip it silently. A meter that HAS been observed, just never
      // as a percent window (every reading local/count-only) is the same
      // legitimate skip. But a meter this action class explicitly consumes
      // that has never produced a usable percent reading at all (a failed
      // probe, a pending grant, a typo) is not "nothing to check" -- it must
      // fail the whole gate closed, the same way a single explicit --meter
      // target already does below, instead of silently being skipped while
      // a different, populated meter in the same --class carries the
      // answer.
      const rawRows = store.latestPerWindow(id);
      const localOrCountOnly = rawRows.length > 0 && rawRows.every((row) => row.window?.kind === "state" || row.window?.kind === "count");
      if (localOrCountOnly) continue;
      return { allowed: false, reason: meterUnknownReason(store, id, `no windowed reading for ${id}`), meters_checked: checked, unknown: true };
    }
    checked.push(id);
    lastShort = short ?? lastShort;

    // Fail closed on any window this gate actually consumes (a requested 5h
    // or wk need, or the weekly reading usePlan folds into a 5h check) that
    // is stale, failed, or older than the policy staleness threshold --
    // the same rule paceDecision applies before computing a pace state. A
    // vendor-confirmed not_enforced window is never rejected here;
    // evaluateGate below already skips its need instead of failing it.
    if (need5h && short) {
      const freshness = freshnessGate(short, staleMinutes, now);
      if (!freshness.ok) return { allowed: false, reason: `5h ${freshness.reason} for ${id}`, meters_checked: checked, unknown: true };
    }
    if ((needWk || usePlan) && long) {
      const freshness = freshnessGate(long, staleMinutes, now);
      if (!freshness.ok) return { allowed: false, reason: `wk ${freshness.reason} for ${id}`, meters_checked: checked, unknown: true };
    }

    const usage = {
      used5h: short?.quantity?.used ?? null,
      usedWk: long?.quantity?.used ?? null,
      weeklyResetsAt: long?.resets_at ?? null,
      hoursPer5hWindow: short?.window?.minutes ? short.window.minutes / 60 : 5,
      freshness5h: short?.freshness ?? null,
      freshnessWk: long?.freshness ?? null,
    };
    const result = evaluateGate(needs, usage, reservePercent, usePlan, now);
    if (!result.allowed) return { ...result, meters_checked: checked };
    lastResult = result;

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
  if (!checked.length) {
    const single = typeof meter === "string" ? meter : Array.isArray(meter) && meter.length === 1 ? meter[0] : undefined;
    const label = typeof meter === "string" ? meter : Array.isArray(meter) ? meter.join(", ") : undefined;
    // A named target (--meter or --class) with no windowed reading at all is
    // the meter's usage being unknown (a failed/never-seen read), not a
    // genuine "doesn't fit" refusal; "no meters configured" (no target named
    // and the store is empty) is a distinct configuration state and keeps
    // the plain refusal rendering.
    return { allowed: false, reason: single ? meterUnknownReason(store, single, `no windowed reading for ${single}`) : label ? `no windowed reading for ${label}` : "no meters configured", meters_checked: checked, ...((single || label) ? { unknown: true as const } : {}) };
  }
  const lanesRemaining = options.actionClass && lastShort?.quantity?.unit === "percent" ? (() => {
    const learned = store.learnedCost(options.actionClass)[0];
    const remaining = lastShort!.quantity!.remaining ?? (100 - lastShort!.quantity!.used);
    return learned ? maxMoreBeforeReset(remaining, learned.median_percent) : null;
  })() : undefined;
  const notEnforcedNote = lastResult?.not_enforced?.length ? ` (${lastResult.not_enforced.join(", ")} not enforced on ${checked[checked.length - 1]})` : "";
  return { allowed: true, reason: `fits${notEnforcedNote}`, meters_checked: checked, ...(lanesRemaining !== undefined ? { lanes_remaining_for_class: lanesRemaining } : {}) };
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
  /** The tightest enforced window the lane math actually used -- "5h" on a
   * normal meter; "wk" (or another label) when the 5h window is not
   * enforced and the tightest enforced window found was the weekly one
   * instead (Codex's main pool, for one). */
  window_used: string;
}

export interface FillOptions {
  owner?: string;
  planSharePercent?: number;
  pacing?: "even" | "none";
  /** Same as GateOptions.staleness_minutes: defaults to defaultPolicy's own
   * value; a caller with the real policy loaded should pass its
   * staleness_minutes here explicitly. */
  staleness_minutes?: number;
}

const EVEN_PACING_FULL_BURST_MINUTES = 45;

/** Mirrors cli.ts's/policy.ts's own window labeling: the two durations every
 * current vendor actually uses get their short names, anything else falls
 * back to a generic one. */
function windowShortLabel(minutes: number | null | undefined): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "?";
}

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
export async function fillFor(store: HeadroomStore, meter: string, laneCostOverride: number | undefined, weeklyReservePercent: number, now = new Date(), options: FillOptions = {}): Promise<FillOutcome | { meter: string; error: string; no_enforced_window?: true }> {
  // Deliberately the strict enforced-only list (not meterWindows' not_enforced-
  // aware one): a not_enforced window has no percent to spend against, so it
  // can never be "the tightest enforced window" fill counts lanes against.
  const enforced = enforcedPercentWindows(store, meter);
  if (!enforced.length) return { meter, error: meterUnknownReason(store, meter, `no enforced window for ${meter}`), no_enforced_window: true };
  const tight = enforced[0];
  const staleMinutes = options.staleness_minutes ?? defaultPolicy.staleness_minutes;
  // Fail closed on the tightest window's own freshness/age -- the same rule
  // paceDecision applies before computing a pace state -- before spending
  // any part of the lane math on it: a stale, failed, or long-unpolled
  // reading must never look like real remaining capacity.
  const tightFreshness = freshnessGate(tight, staleMinutes, now);
  if (!tightFreshness.ok) return { meter, error: tightFreshness.reason };
  const isFiveHour = tight.window?.minutes === 300;
  // A genuine second (weekly) window, distinct from the tight one -- only
  // present when both are actually enforced.
  const wider = enforced.length > 1 ? enforced[enforced.length - 1] : undefined;
  if (wider) {
    const widerFreshness = freshnessGate(wider, staleMinutes, now);
    if (!widerFreshness.ok) return { meter, error: widerFreshness.reason };
  }
  const used5h = tight.quantity!.used;
  // With no distinct weekly window, the tight window IS the weekly boundary
  // too when it isn't the 5h one (Codex's main pool with 5h not enforced):
  // its own usage stands in directly rather than defaulting to an unspent 0
  // that would let the (nonexistent) separate weekly cap never bind. A
  // genuinely 5h-only meter (weekly just not read yet) keeps the old
  // "unknown, don't block on it" default of 0.
  const usedWeekly = wider ? wider.quantity!.used : (isFiveHour ? 0 : used5h);
  const windowUsed = windowShortLabel(tight.window?.minutes);
  const secondsLeft = tight.resets_at ? Math.max(0, (Date.parse(tight.resets_at) - now.getTime()) / 1000) : null;
  const learned = laneCostOverride === undefined ? store.learnedCostForMeter(meter) : undefined;
  const laneCost = laneCostOverride ?? learned?.median_percent;
  const source: FillOutcome["lane_cost_source"] = laneCostOverride !== undefined ? "given" : learned ? "learned" : "unknown";

  const pacing = options.pacing ?? "even";
  const inFinalStretch = secondsLeft !== null && secondsLeft <= EVEN_PACING_FULL_BURST_MINUTES * 60;
  // Pro-rata smoothing only makes sense for a genuine 5h window: it rations a
  // short window's own budget across the hours until IT resets. Once the
  // tight window IS the weekly one (5h not enforced), there is no shorter
  // window left to smooth -- the weekly reserve check in computeFill below is
  // already the whole mechanism, and a from-scratch pro-rata line computed
  // over a 7-day span (with no owner plan share on file yet) would otherwise
  // collapse the allowance to near zero for no real reason.
  const restrictedByPacing = pacing === "even" && isFiveHour && !inFinalStretch && tight.window?.minutes && tight.resets_at && options.owner;
  let used5hForLanes = used5h;
  let allowanceBasis: FillOutcome["allowance_basis"] = "full";
  if (restrictedByPacing) {
    const windowStart = new Date(Date.parse(tight.resets_at!) - (tight.window!.minutes as number) * 60_000);
    const windowHours = (tight.window!.minutes as number) / 60;
    const ownerLeases = store.leases(meter, true, now).filter((lease) => lease.owner === options.owner);
    const plannedShare = options.planSharePercent ?? ownerLeases.reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0);
    const usedSoFar = ownerLeases.reduce((sum, lease) => sum + lease.spent_percent, 0);
    const line = evaluateProRataLine({ usedSoFarByOwnerPercent: usedSoFar, requestPercent: 0, plannedSharePercent: plannedShare, windowStart, windowDurationHours: windowHours, now }).line_percent;
    const proRataRemaining = Math.max(0, line - usedSoFar);
    used5hForLanes = Math.max(used5h, 100 - proRataRemaining);
    allowanceBasis = "pro_rata";
  }
  // computeFill's default weekly-cost-per-lane is the 5h-to-weekly
  // calibration ratio, which only makes sense between two distinct windows.
  // With no genuine second window and the tight one standing in for both,
  // the lane cost applies 1:1 instead.
  const weeklyCostPerLaneOverride = !wider && !isFiveHour ? laneCost : undefined;
  const lanes = laneCost === undefined ? null : computeFill(used5hForLanes, usedWeekly, laneCost, weeklyReservePercent, weeklyCostPerLaneOverride, 5, windowUsed);
  const lanesError = laneCost === undefined ? `no learned cost for ${meter}; pass --lane-cost` : null;

  const routing = await readRouting();
  const costs = Object.fromEntries(Object.entries(routing.costs).map(([actionClass, cost]) => {
    const classLearned = store.learnedCost(actionClass)[0];
    return [actionClass, { percent: classLearned ? classLearned.median_percent : cost.percent, duration_minutes: cost.duration_minutes }];
  }));
  const remainingPercent = Math.max(0, 100 - used5hForLanes) - 5; // same 5-point safety margin as the lane count
  const remainingMinutes = secondsLeft === null ? 0 : secondsLeft / 60;
  const classes = fillClassFits(Math.max(0, remainingPercent), remainingMinutes, costs);

  return { meter, lanes, lanes_error: lanesError, classes, used_5h_percent: used5h, used_weekly_percent: usedWeekly, resets_in_seconds: secondsLeft, lane_cost_percent: laneCost ?? null, lane_cost_source: source, allowance_basis: allowanceBasis, window_used: windowUsed };
}

export interface RouteCandidate {
  principal: string;
  state: PaceState;
  reason: string;
  /** The remaining percent on this principal's own deciding (worst, per
   * canConsume) meter within the action class -- null when that meter's
   * usage is not a plain percentage (a local pool, an availability count) or
   * unreadable at all. Only a candidate with a real number here is ever
   * routable; a principal whose own state already fits but has nothing
   * numeric to rank by is reported, never picked. */
  remaining_percent: number | null;
  window_minutes: number | null;
}

export interface RouteResult {
  /** Null when no candidate both fits and has a rankable remaining percent. */
  principal: string | null;
  /** The exact environment variable(s) to launch that principal under, e.g.
   * `{ CLAUDE_CONFIG_DIR: "/Users/you/.claude2" }`. Empty for the default
   * profile of its vendor (nothing to override) or for a vendor `route`
   * does not know a launch environment variable for. */
  environment: Record<string, string>;
  reason: string;
  candidates: RouteCandidate[];
}

/** The one environment variable a caller needs to set to launch a CLI session
 * against this specific principal, or an empty object when this account IS
 * its vendor's default profile (nothing to override) or the vendor has no
 * such variable (Antigravity, a local pool). */
export function launchEnvironment(account: Account): Record<string, string> {
  if (isLocalAccount(account)) return {};
  const directory = resolve(account.location);
  if (account.vendor === "claude") return directory === resolve(homedir(), ".claude") ? {} : { CLAUDE_CONFIG_DIR: account.location };
  if (account.vendor === "codex") return directory === resolve(homedir(), ".codex") ? {} : { CODEX_HOME: account.location };
  return {};
}

const routeFits = (state: PaceState, allowUnknown: boolean): boolean =>
  state !== "FREEZE" && state !== "CONSERVE" && state !== "DOWN" && (state !== "UNKNOWN" || allowUnknown);

/**
 * Among the distinct principals named by `meters` (a routing.toml action
 * class's own meter list, so already scoped to the vendor and principals the
 * operator allowed for it), picks the one with the most remaining percent on
 * its own tightest (deciding, worst-state) window, among principals that
 * currently fit at all (not FREEZE/CONSERVE/DOWN, and not UNKNOWN unless
 * allowUnknown) -- the live equivalent of the dogfooded "claude-main is at
 * 90%, claude-2 is at 10%, launch the next lane under claude-2" call an
 * orchestrator makes by hand today. Every candidate's own state and reason
 * is still reported (not just the winner), so a caller can see why a
 * principal was skipped. `owner` (the caller's own identity, as `can` also
 * requires) reserves every OTHER owner's active lease against these same
 * meters before scoring and ranking each candidate -- without it, route
 * could recommend a principal whose remaining capacity a different
 * orchestrator has already reserved, while `can` correctly refuses the same
 * job for that caller.
 */
export function routeFor(store: HeadroomStore, meters: string[], accounts: Account[], policy: Policy, allowUnknown: boolean, now = new Date(), owner?: string): RouteResult {
  const principals = [...new Set(meters.map((meter) => meter.slice(0, meter.indexOf(":") >= 0 ? meter.indexOf(":") : meter.length)))];
  const leases = store.leases(undefined, true, now);
  const candidates: RouteCandidate[] = principals.map((principal) => {
    const principalMeters = meters.filter((meter) => meter.startsWith(`${principal}:`));
    const observationMap = new Map(principalMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
    const rows = [...observationMap.values()].flat();
    const burn = store.burnRateFor(rows, now);
    const enriched = new Map([...observationMap].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
    const reserved = withOtherOwnerReservations(enriched, leases, owner);
    const decision = canConsume(principalMeters, reserved, policy, allowUnknown, now);
    const reservedRows = [...reserved.values()].flat() as Observation[];
    const deciding = pickDecidingObservation(reservedRows.length ? reservedRows : rows);
    const remaining = deciding?.quantity?.unit === "percent" ? deciding.quantity.remaining ?? Math.max(0, 100 - deciding.quantity.used) : null;
    return { principal, state: decision.state, reason: decision.reason, remaining_percent: remaining, window_minutes: deciding?.window?.minutes ?? null };
  });
  const eligible = candidates.filter((item) => routeFits(item.state, allowUnknown) && item.remaining_percent !== null);
  eligible.sort((a, b) => (b.remaining_percent as number) - (a.remaining_percent as number));
  const winner = eligible[0];
  if (!winner) return { principal: null, environment: {}, reason: candidates.length ? "no candidate fits" : "no principals for this class", candidates };
  const account = accounts.find((item) => item.name === winner.principal);
  return {
    principal: winner.principal, environment: account ? launchEnvironment(account) : {},
    reason: `${windowShortLabel(winner.window_minutes)} ${winner.remaining_percent!.toFixed(1)}% remaining`, candidates,
  };
}
