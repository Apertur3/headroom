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
import { computeFill, computePlan, evaluateBurst, evaluateFillAllowance, evaluateProRataLine, fillClassFits, windowNeedLabel, windowNeedMinutes, type FillClassFit, type FillResult, type GateNeed, type GateResult, type PlanResult } from "./pacing.js";
import { maxMoreBeforeReset } from "./cost.js";
import {
  canConsume, defaultPolicy, freshnessGate, formatReserveCeiling, reserveAttributionBracket, reserveCeilingSteps, reserveEntryFor, reserveFor,
  withOtherOwnerReservations, type CanDecision, type Policy, type ReserveEntry,
} from "./policy.js";
import { withPaceInfo } from "./pace.js";
import { creditSource, creditsLapsed, isCurrentBankedResetObservation, usableCredits, type BankedCreditSource } from "./credits.js";
import type { HeadroomStore } from "./store.js";
import { disabledPrincipalReason, isAccountEnabled, isLocalAccount, type Account, type Observation, type PaceState, type StoredObservation } from "./types.js";

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

/** True when `meterId`'s reserve (its own, or `"*"`'s, `[reserve]` entry) is
 * currently suspended: it sets `unless = "banked_reset_available"` and the
 * meter's principal currently carries a usable banked reset -- a manual
 * `headroom credits set` entry, or a fresh, unheld vendor-confirmed one (see
 * credits.ts's isCurrentBankedResetObservation). This is deliberately
 * call-time (needs the live store), unlike expiry, which parsePolicy already
 * resolves into Policy.reserve itself. */
export function reserveSuspendedFor(store: HeadroomStore, reserveMeta: Record<string, ReserveEntry>, meterId: string, staleMinutes: number, now: Date): boolean {
  const meta = reserveEntryFor(reserveMeta, meterId);
  if (meta?.unless !== "banked_reset_available") return false;
  const principal = meterId.slice(0, meterId.indexOf(":") >= 0 ? meterId.indexOf(":") : meterId.length);
  // isCurrentBankedResetObservation alone only says this row is ELIGIBLE to
  // be treated as a banked-reset reading (a manual entry, or a fresh, unheld
  // vendor one) -- a lapsed manual entry still qualifies there (planFor's own
  // `banked.lapsed` flag layers on top of the same row for display). Actual
  // suspension needs a reset that is still spendable right now.
  return store.latestPerWindow(`${principal}:credits`).some((row) => isCurrentBankedResetObservation(row, staleMinutes, now) && usableCredits(row, now) > 0);
}

/** Applies reserveSuspendedFor to every meter listed, returning a fresh
 * reserves record -- cloned only once at least one meter is actually
 * suspended -- with a suspended meter's own floor set to 0 for this one
 * call. gate/fill/plan/can/route never lose real capacity to a reserve
 * whose own `unless` clause the caller's current banked reset already
 * satisfies. */
export function withSuspendedReserves(store: HeadroomStore, reserves: Record<string, number>, reserveMeta: Record<string, ReserveEntry>, meterIds: string[], staleMinutes: number, now: Date): Record<string, number> {
  let resolved = reserves;
  for (const meter of meterIds) {
    if (!reserveSuspendedFor(store, reserveMeta, meter, staleMinutes, now)) continue;
    if (resolved === reserves) resolved = { ...reserves };
    resolved[meter] = 0;
  }
  return resolved;
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
  /** Set only when `rate` was asked for one owner: how much of this window's
   * movement over the same lookback the spend ledger attributes to them, and
   * how much that attribution can be trusted. Absent otherwise, so a plain
   * `rate` read is unchanged. */
  attributed_owner?: string;
  attributed_percent?: number;
  attributed_confidence?: number;
}

/** One rate line per window: with a meter given, every enforced window of
 * that meter; without one, every known meter's shortest (primary) window,
 * so a broad read stays one line per account instead of flooding the
 * terminal with every weekly window too. With `owner` given, each line also
 * carries that owner's ledger-attributed share of the same lookback, so
 * "the meter is burning 22%/h" and "9%/h of that is mine" are read together
 * rather than from two separate commands. */
export function rateLines(store: HeadroomStore, meter: string | undefined, lookbackMinutes: number, now = new Date(), owner?: string, needWindow?: string, options: { enabledPrincipalIds?: ReadonlySet<string> } = {}): RateLine[] {
  const meterIds = meter
    ? [meter]
    : [...new Set(store.latestPerWindow()
      .filter((row) => !options.enabledPrincipalIds || options.enabledPrincipalIds.has(row.principal_id))
      .map((row) => row.meter_id))];
  const sinceIso = new Date(now.getTime() - lookbackMinutes * 60_000).toISOString();
  const lines: RateLine[] = [];
  for (const id of meterIds) {
    const rows = enforcedPercentWindows(store, id);
    const requestedMinutes = needWindow ? windowNeedMinutes(needWindow) : undefined;
    const targets = (meter ? rows : rows.slice(0, 1)).filter((row) => requestedMinutes === undefined || row.window?.minutes === requestedMinutes);
    if (meter && !targets.length) {
      const reason = meterUnknownReason(store, id, "");
      if (reason) lines.push({ meter: id, window_minutes: null, used_percent: null, burn_percent_per_hour: null, empty_in_seconds: null, resets_at: null, reason });
      continue;
    }
    for (const row of targets) {
      const burn = store.burnRateFor([row], now, lookbackMinutes).get(`${row.meter_id}:${row.window!.minutes}`) ?? { burn_percent_per_hour: null, empty_in_seconds: null };
      const line: RateLine = { meter: id, window_minutes: row.window!.minutes, used_percent: row.quantity!.used, burn_percent_per_hour: burn.burn_percent_per_hour, empty_in_seconds: burn.empty_in_seconds, resets_at: row.resets_at };
      if (owner) {
        const attributed = store.spendByOwner({ meter: id, owner, since: sinceIso }).find((item) => item.window_minutes === row.window!.minutes);
        line.attributed_owner = owner;
        line.attributed_percent = attributed?.attributed_percent ?? 0;
        line.attributed_confidence = attributed?.confidence ?? 0;
      }
      lines.push(line);
    }
  }
  return lines;
}

export interface BankedPlan {
  available: number;
  expires_at: string | null;
  source: BankedCreditSource | null;
  lapsed: boolean;
  worth_percent: number;
}

export interface PlanTarget {
  points: number;
  fits_now: boolean;
  fits_with_banked: boolean;
  /** null means every banked reset is fully reserved, so no finite count fits. */
  resets_needed: number | null;
}

export interface PlanAdvice {
  use_now: boolean;
  reason: string;
  use_before: string | null;
}

export type PlanSuccess = { meter: string } & PlanResult & {
  banked: BankedPlan; target?: PlanTarget; advice: PlanAdvice;
  /** Every reserve capping this meter, tightest first, as one line --
   * empty string when none applies. See policy.ts's formatReserveCeiling. */
  reserve_ceiling: string;
};
type PlanCore = PlanSuccess | { meter: string; error: string };

/** Adds gate/plan/fill's shared `notices` (issue #20): for
 * UNSCHEDULED_RESET_HOURS after an unscheduled reset on any of the given
 * meters, one line saying capacity appeared and to re-plan. Every caller of
 * `gateFor`/`planFor`/`fillFor` -- the CLI's direct-read fallback, the
 * daemon's own RPC handlers, and MCP's direct fallback -- goes through
 * these three functions, so this is the single place the notice needs to be
 * attached for it to reach every surface. */
function unscheduledResetNotices(store: HeadroomStore, meterIds: string[], now: Date): string[] {
  return store.recentUnscheduledResets(meterIds, now).map((item) => `unscheduled reset on ${item.meter_id} at ${item.created_at}; capacity appeared, re-plan`);
}

export type PlanOutcome = PlanCore & { notices: string[] };

/** `reserves` is policy.toml's `[reserve]` table: the plan line is drawn
 * above the larger of the caller's own reserve percent and this meter's
 * protected floor, so `plan` never budgets points `gate` would then refuse. */
function planForCore(store: HeadroomStore, meter: string, reservePercent: number, now: Date, staleMinutes: number, reserves: Record<string, number>, needWindow?: string, targetPoints?: number, reserveMeta: Record<string, ReserveEntry> = {}, policyMtime: string | null = null): PlanCore {
  const { short, long } = meterWindows(store, meter);
  const target = needWindow ? knownPercentWindows(store, meter).find((row) => row.window?.minutes === windowNeedMinutes(needWindow)) : long;
  if (!target || !target.resets_at) return { meter, error: meterUnknownReason(store, meter, `no ${needWindow ?? "weekly"} window for ${meter}`) };
  // Fail closed on a stale, failed, or long-unpolled weekly reading exactly
  // like gateFor/fillFor do: the plan line is computed straight from
  // long.quantity.used, so an unusable reading there must never turn into a
  // confident-looking plan.
  const freshness = freshnessGate(target, staleMinutes, now);
  if (!freshness.ok) return { meter, error: freshness.reason };
  const hoursPerWindow = short?.window?.minutes ? short.window.minutes / 60 : 5;
  const meterSuspended = reserveSuspendedFor(store, reserveMeta, meter, staleMinutes, now);
  const resolvedReserves = meterSuspended ? { ...reserves, [meter]: 0 } : reserves;
  const plan = computePlan(target.quantity!.used, target.resets_at, hoursPerWindow, Math.max(reservePercent, reserveFor(resolvedReserves, meter)), now);
  const credits = store.latestPerWindow(`${target.principal_id}:credits`)
    .find((row) => isCurrentBankedResetObservation(row, staleMinutes, now));
  const lapsed = credits ? creditsLapsed(credits, now) : false;
  const banked: BankedPlan = {
    available: usableCredits(credits, now), expires_at: credits?.resets_at ?? null,
    source: credits ? creditSource(credits) : null, lapsed, worth_percent: 100 - plan.reserve_percent,
  };
  // `need` can select a shorter vendor window for the old pacing feature,
  // but banked-reset advice always compares expiry with the weekly reset when
  // one is available: that is the allowance a reset actually restores.
  const scheduledReset = long?.resets_at ?? target.resets_at;
  const hoursUntilReset = Math.max(0, (Date.parse(scheduledReset) - now.getTime()) / 3_600_000);
  const targetResult = targetPoints === undefined ? undefined : (() => {
    const fitsNow = targetPoints <= plan.usable_now_percent;
    const fitsWithBanked = targetPoints <= plan.usable_now_percent + banked.available * banked.worth_percent;
    const resetsNeeded = fitsNow ? 0
      : banked.worth_percent > 0 ? Math.ceil((targetPoints - plan.usable_now_percent) / banked.worth_percent)
        // A 100% reserve leaves no usable capacity per reset, so no finite
        // number can fit. Null is valid JSON and says that directly.
        : null;
    return { points: targetPoints, fits_now: fitsNow, fits_with_banked: fitsWithBanked, resets_needed: resetsNeeded };
  })();
  const expiryBeforeReset = banked.expires_at && Number.isFinite(Date.parse(banked.expires_at))
    && Number.isFinite(Date.parse(scheduledReset)) && Date.parse(banked.expires_at) < Date.parse(scheduledReset);
  const resetHours = Math.ceil(hoursUntilReset);
  const advice: PlanAdvice = banked.available <= 0
    ? { use_now: false, reason: banked.lapsed ? "the banked reset has lapsed" : "no banked reset available", use_before: null }
    : banked.worth_percent <= 0
      ? { use_now: false, reason: "the reserve leaves no usable capacity per banked reset", use_before: null }
    : expiryBeforeReset
      ? { use_now: true, reason: `expires ${banked.expires_at} before the scheduled reset ${scheduledReset}; it is lost otherwise`, use_before: banked.expires_at }
      : targetResult && !targetResult.fits_now && hoursUntilReset > 24
        ? { use_now: true, reason: `the target does not fit in what is left and the reset is ${resetHours} h away`, use_before: null }
        : targetResult?.fits_now
          ? { use_now: false, reason: "the queued work fits without it", use_before: null }
          : hoursUntilReset <= 24
            ? { use_now: false, reason: `reset in ${resetHours} h; wait for it`, use_before: null }
            : { use_now: false, reason: "no target given; nothing is blocked", use_before: null };
  const reserveCeiling = formatReserveCeiling(reserveCeilingSteps({ reserve: reserves, reserve_meta: reserveMeta, freeze_reserve_pct: reservePercent }, meter, meterSuspended), policyMtime, banked.available > 0 && !banked.lapsed);
  return { meter, ...plan, banked, ...(targetResult ? { target: targetResult } : {}), advice, reserve_ceiling: reserveCeiling };
}

export function planFor(store: HeadroomStore, meter: string, reservePercent: number, now = new Date(), staleMinutes = defaultPolicy.staleness_minutes, reserves: Record<string, number> = {}, needWindow?: string, targetPoints?: number, reserveMeta: Record<string, ReserveEntry> = {}, policyMtime: string | null = null): PlanOutcome {
  const result = planForCore(store, meter, reservePercent, now, staleMinutes, reserves, needWindow, targetPoints, reserveMeta, policyMtime);
  return { ...result, notices: unscheduledResetNotices(store, [meter], now) };
}

export interface GateOptions {
  owner?: string;
  /** A new reservation must account for work the same owner already has in
   * flight. Ordinary advisory checks retain the historical owner-self
   * exception, but admission paths set this so one owner cannot over-admit
   * several concurrent jobs against the same meter. */
  includeOwnerReservations?: boolean;
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
  /** The even-pacing allowance basis. `fill` is opt-in: it projects the
   * current window to the lane's end instead of rationing a plan share. */
  allowance?: "pro_rata" | "fill";
  /** A caller may tighten, never raise, the reserve-derived gate ceiling. */
  capPercent?: number;
  /** Projection horizon supplied explicitly, or resolved from an action
   * class's routing cost by the CLI/daemon/MCP boundary. */
  durationMinutes?: number;
  /** policy.toml's staleness_minutes: a window older than this (or one
   * whose freshness itself is stale/failed) is treated as an unusable
   * reading, the same rule paceDecision applies before scoring a pace
   * state. Defaults to defaultPolicy's own value; a caller with the real
   * policy loaded should pass its staleness_minutes here explicitly. */
  staleness_minutes?: number;
  /** policy.toml's `[reserve]` table: the protected floor per meter that
   * this gate must never dip into. The larger of that floor and the
   * caller's own reserve percent applies. */
  reserves?: Record<string, number>;
  /** policy.toml's reserve_meta (the dated/reasoned `[reserve."<meter>"]`
   * entries, plus `"freeze_reserve_pct"`'s own `[freeze_reserve]`): resolves
   * `unless: "banked_reset_available"` suspension (needs the live store, so
   * it cannot be pre-baked into `reserves` the way expiry already is) and
   * names the reason/set_at a reserve refusal attributes itself to. */
  reserveMeta?: Record<string, ReserveEntry>;
  /** policy.toml's own mtime -- the fallback attribution for a reserve
   * refusal that names no reason/set_at of its own. */
  policyMtime?: string | null;
  /** When no meter is named, current dispatch capacity is restricted to
   * these enabled registry principals. Explicit targets keep their own
   * disabled-principal refusal at the serving boundary. */
  enabledPrincipalIds?: ReadonlySet<string>;
}

interface GateOutcomeCore extends GateResult {
  meters_checked: string[];
  /** Present only with actionClass and a learned cost for it: how many more
   * of that class fit in the deciding meter's remaining 5h percent. */
  lanes_remaining_for_class?: number | null;
}

export interface GateOutcome extends GateOutcomeCore {
  /** unscheduledResetNotices() over every meter this call actually checked
   * (`meters_checked`, present on every return path below including an
   * early refusal) -- see PlanOutcome's own doc comment above. */
  notices: string[];
}

/** Fail closed over every meter checked: with no --meter, every account meter
 * that has both a short and a long window must pass, and the first one that
 * does not stops the check (mirrors policy.ts's canConsume: one bad meter
 * blocks the whole gate). `meter` also accepts an explicit list (a --class
 * resolved through routing.toml to several meters), checked the same way. */
function gateForCore(store: HeadroomStore, needs: GateNeed[], meter: string | string[] | undefined, reservePercent: number, usePlan: boolean, now: Date, options: GateOptions): GateOutcomeCore {
  // No --meter/--class means the caller wants "every account's dispatch
  // capacity", inferred by scanning every meter this store has ever seen --
  // a count/credits meter picked up that way (an account that simply also
  // carries a manual banked-reset balance) is never dispatch capacity, but
  // it is not what the caller asked to check either, so it is skipped below
  // rather than failing the whole global gate. An explicit target (a single
  // --meter, or a --class resolved through routing.toml to a specific list)
  // IS what the caller asked to check, so a count/credits meter named there
  // still refuses, same as before.
  const explicitTarget = meter !== undefined;
  const candidates = meter === undefined
    ? [...new Set(store.latestPerWindow()
      .filter((row) => !options.enabledPrincipalIds || options.enabledPrincipalIds.has(row.principal_id))
      .map((row) => row.meter_id))]
    : Array.isArray(meter) ? meter : [meter];
  const checked: string[] = [];
  const pacing = options.pacing ?? "even";
  const allowance = options.allowance ?? "pro_rata";
  const staleMinutes = options.staleness_minutes ?? defaultPolicy.staleness_minutes;
  const reserveMeta = options.reserveMeta ?? {};
  const policyMtime = options.policyMtime ?? null;
  let lastShort: StoredObservation | undefined;
  let lastReservedPercent = 0;
  let lastResult: GateResult | undefined;
  for (const id of candidates) {
    const blocked = store.dispatchBlockForMeter(id, now) ?? store.dispatchBlockForPrincipal(id.split(":")[0]);
    if (blocked) return { allowed: false, reason: blocked, meters_checked: checked };
    const rawRows = store.latestPerWindow(id);
    if (id.endsWith(":credits") || rawRows.some((row) => row.window?.kind === "count")) {
      if (!explicitTarget) continue;
      return { allowed: false, reason: `count meter ${id} cannot be used for dispatch`, meters_checked: checked };
    }
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
      const localOnly = rawRows.length > 0 && rawRows.every((row) => row.window?.kind === "state");
      if (localOnly) continue;
      return { allowed: false, reason: meterUnknownReason(store, id, `no windowed reading for ${id}`), meters_checked: checked, unknown: true };
    }
    checked.push(id);
    lastShort = short ?? lastShort;
    const suspended = reserveSuspendedFor(store, reserveMeta, id, staleMinutes, now);
    // A lease reserves capacity on the meter, rather than on one particular
    // vendor window. Apply it to every enforced percent window that the gate
    // evaluates: the same action consumes both a 5h and a weekly allowance.
    // This mirrors canRouteWithLeases, whose adjusted observations already
    // make another owner's reservation visible to `can`.
    const reservedPercent = store.leases(id, true, now)
      .filter((lease) => (options.includeOwnerReservations || lease.owner !== options.owner) && lease.expected_percent !== null && lease.expected_percent > 0)
      .reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0);
    lastReservedPercent = reservedPercent;
    const reservedSuffix = reservedPercent > 0 ? ` after ${reservedPercent.toFixed(1)}% already leased` : "";

    // Fail closed on any window this gate actually consumes (a requested 5h
    // or wk need, or the weekly reading usePlan folds into a 5h check) that
    // is stale, failed, or older than the policy staleness threshold --
    // the same rule paceDecision applies before computing a pace state. A
    // vendor-confirmed not_enforced window is never rejected here;
    // evaluateGate below already skips its need instead of failing it.
    const reported = knownPercentWindows(store, id);
    const notEnforced: string[] = [];
    // The exact 300-minute row matched for a 5h need below -- never the
    // meter's merely-shortest window (meterWindows' `short`), which on a
    // meter that also enforces something narrower than 5h (a 90m window,
    // say) would silently substitute that window's usage, reset and burn
    // into the even-pacing/fill math for what is actually a 5h request.
    let fiveHourRow: StoredObservation | undefined;
    for (const need of needs) {
      const minutes = windowNeedMinutes(need.window);
      const label = minutes === undefined ? need.window : windowNeedLabel(minutes);
      const row = reported.find((item) => item.window?.minutes === minutes);
      if (!row) {
        const available = reported.map((item) => windowNeedLabel(item.window!.minutes!)).join(", ") || "none";
        return { allowed: false, reason: (need.window === "5h" || need.window === "wk") ? `${label} usage unknown` : `${label} usage unknown; vendor reports: ${available}`, meters_checked: checked, unknown: true };
      }
      if (row.freshness === "not_enforced") { notEnforced.push(label); continue; }
      const freshness = freshnessGate(row, staleMinutes, now);
      if (!freshness.ok) return { allowed: false, reason: `${label} ${freshness.reason} for ${id}`, meters_checked: checked, unknown: true };
      if (minutes === 300) fiveHourRow = row;
      const observedUsed = row.quantity?.used;
      const used = observedUsed === undefined ? undefined : Math.min(100, observedUsed + reservedPercent);
      if (used === undefined) return { allowed: false, reason: `${label} usage unknown`, meters_checked: checked, unknown: true };
      const meterReserve = suspended ? 0 : reserveFor(options.reserves ?? {}, id);
      const reserve = Math.max(reservePercent, meterReserve);
      // The tighter of the reserve-derived ceiling and a caller-supplied
      // capPercent (see GateOptions.capPercent) always wins: a fill caller's
      // cap must never let a request past the policy reserve floor, and the
      // reserve floor must never silently override a caller's own, tighter
      // cap either.
      const reserveCeiling = 100 - reserve;
      const ceiling = Math.min(reserveCeiling, options.capPercent ?? 100);
      if (used + need.points > ceiling) {
        const left = Math.max(0, ceiling - used);
        const reserveReason = ceiling < reserveCeiling
          ? `${label} needs ${need.points} more but only ${left.toFixed(1)} left${reservedSuffix} before the ${ceiling}% cap`
          : meterReserve >= reservePercent && meterReserve > 0
            ? `${label} needs ${need.points} more but only ${left.toFixed(1)} left${reservedSuffix}: that would use the ${meterReserve}% reserve on ${id} ${reserveAttributionBracket(id, reserveEntryFor(reserveMeta, id), policyMtime)}`
            : `${label} needs ${need.points} more but only ${left.toFixed(1)} left${reservedSuffix} before the ${reserve}% reserve ${reserveAttributionBracket("freeze_reserve_pct", reserveMeta["freeze_reserve_pct"], policyMtime)}`;
        return { allowed: false, reason: reserveReason, meters_checked: checked };
      }
      if (usePlan && minutes === 300 && long?.resets_at && long.quantity?.used !== undefined) {
        const plan = computePlan(Math.min(100, long.quantity.used + reservedPercent), long.resets_at, row.window!.minutes! / 60, reserve, now);
        if (used + need.points > plan.points_per_5h_window) return { allowed: false, reason: `5h needs ${need.points} more but the plan line allows only ${plan.points_per_5h_window.toFixed(1)} points this window`, meters_checked: checked };
      }
    }
    // The meter's own protected reserve (policy.toml [reserve]) is checked
    // before the plain ceiling so the refusal can name it: a caller reading
    // "would use the 10% reserve on claude-main:fable" knows to stop
    // dispatching that model rather than to retry with fewer points. The
    // larger of the two reserves then applies to everything else the gate
    // checks, including the plan line.
    const meterReserve = suspended ? 0 : reserveFor(options.reserves ?? {}, id);
    lastResult = { allowed: true, reason: "fits", ...(notEnforced.length ? { not_enforced: notEnforced } : {}) };

    const fiveHourNeed = needs.find((need) => windowNeedMinutes(need.window) === 300);
    if (pacing === "even" && fiveHourNeed && fiveHourRow) {
      if (allowance === "fill") {
        // The explicit fill allowance is opt-in and must apply whenever it is
        // requested: never silently skipped because no --owner was given (a
        // caller checking dispatch capacity generically, not on behalf of one
        // owner, still needs this projection to run) and never silently
        // skipped once the window is close to reset (that is exactly when a
        // burst against the cap matters most). A window with no finite,
        // future reset -- or with no recent burn history to project from --
        // fails closed as UNKNOWN rather than falling through to "fits".
        const finiteReset = fiveHourRow.resets_at && Number.isFinite(Date.parse(fiveHourRow.resets_at)) && Date.parse(fiveHourRow.resets_at) > now.getTime();
        if (!finiteReset) return { allowed: false, reason: `5h fill needs a finite future reset for ${id}`, meters_checked: checked, unknown: true };
        const meterReserve = suspended ? 0 : reserveFor(options.reserves ?? {}, id);
        // The tighter of the reserve-derived ceiling and a caller-supplied
        // capPercent always wins -- same rule as the plain (non-fill) need
        // check above.
        const reserveCeiling = 100 - Math.max(reservePercent, meterReserve);
        const cap = Math.min(reserveCeiling, options.capPercent ?? 100);
        const minutesToReset = Math.max(0, (Date.parse(fiveHourRow.resets_at!) - now.getTime()) / 60_000);
        const durationMinutes = Math.min(minutesToReset, Math.max(0, options.durationMinutes ?? minutesToReset));
        const burn = store.burnRateFor([fiveHourRow], now, 60).get(`${id}:${fiveHourRow.window!.minutes}`);
        const fill = evaluateFillAllowance({
          usedPercent: fiveHourRow.quantity!.used,
          reservedByOthersPercent: reservedPercent,
          burnPercentPerHour: burn?.burn_percent_per_hour ?? null,
          laneHours: durationMinutes / 60,
          capPercent: cap,
          requestPercent: fiveHourNeed.points,
        });
        const fillFields = { allowance_basis: "fill" as const, projected_percent: fill.projected_percent, cap_percent: fill.cap_percent };
        if (!fill.allowed) {
          // Name the reserve's own reason/set_at the same way the plain
          // ceiling check above does, but only when the reserve (not a
          // caller-supplied, tighter capPercent, and not an UNKNOWN burn/
          // reset) is actually what's binding -- a caller's own cap or an
          // unknown projection has no reserve to attribute to.
          const attribution = !fill.unknown && cap === reserveCeiling && reserveCeiling < 100
            ? ` ${meterReserve >= reservePercent && meterReserve > 0
                ? reserveAttributionBracket(id, reserveEntryFor(reserveMeta, id), policyMtime)
                : reserveAttributionBracket("freeze_reserve_pct", reserveMeta["freeze_reserve_pct"], policyMtime)}`
            : "";
          return { allowed: false, reason: `${fill.reason}${attribution}`, meters_checked: checked, ...fillFields, ...(fill.unknown ? { unknown: true as const } : {}) };
        }
        lastResult = { allowed: true, reason: fill.reason, ...(notEnforced.length ? { not_enforced: notEnforced } : {}), ...fillFields };
      } else if (fiveHourRow.resets_at && fiveHourRow.window?.minutes && options.owner) {
        const windowStart = new Date(Date.parse(fiveHourRow.resets_at) - fiveHourRow.window.minutes * 60_000);
        const windowHours = fiveHourRow.window.minutes / 60;
        const ownerLeases = store.leases(id, true, now).filter((lease) => lease.owner === options.owner);
        const plannedShare = options.planSharePercent ?? (ownerLeases.reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0) + fiveHourNeed.points);
        const usedSoFar = ownerLeases.reduce((sum, lease) => sum + lease.spent_percent, 0);
        const proRata = evaluateProRataLine({ usedSoFarByOwnerPercent: usedSoFar, requestPercent: fiveHourNeed.points, plannedSharePercent: plannedShare, windowStart, windowDurationHours: windowHours, now });
        if (!proRata.allowed) return { allowed: false, reason: proRata.reason, meters_checked: checked };
        const burst10m = store.burnRateFor([fiveHourRow], now, 10).get(`${id}:${fiveHourRow.window.minutes}`);
        const burst = evaluateBurst({ burnPercentPerHour10m: burst10m?.burn_percent_per_hour ?? null, plannedSharePercent: plannedShare, windowDurationHours: windowHours, usedPercent: Math.min(100, fiveHourRow.quantity!.used + reservedPercent), windowStart });
        if (!burst.allowed) return { allowed: false, reason: burst.reason, meters_checked: checked };
      }
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
    const remaining = Math.max(0, (lastShort!.quantity!.remaining ?? (100 - lastShort!.quantity!.used)) - lastReservedPercent);
    return learned ? maxMoreBeforeReset(remaining, learned.median_percent) : null;
  })() : undefined;
  const notEnforcedNote = lastResult?.not_enforced?.length ? ` (${lastResult.not_enforced.join(", ")} not enforced on ${checked[checked.length - 1]})` : "";
  return { allowed: true, reason: lastResult?.reason === "fits" ? `fits${notEnforcedNote}` : lastResult?.reason ?? `fits${notEnforcedNote}`, meters_checked: checked, ...(lastResult?.allowance_basis ? { allowance_basis: lastResult.allowance_basis, projected_percent: lastResult.projected_percent, cap_percent: lastResult.cap_percent } : {}), ...(lanesRemaining !== undefined ? { lanes_remaining_for_class: lanesRemaining } : {}) };
}

export function gateFor(store: HeadroomStore, needs: GateNeed[], meter: string | string[] | undefined, reservePercent: number, usePlan: boolean, now = new Date(), options: GateOptions = {}): GateOutcome {
  const result = gateForCore(store, needs, meter, reservePercent, usePlan, now, options);
  return { ...result, notices: unscheduledResetNotices(store, result.meters_checked, now) };
}

/**
 * `can` chooses a limiting pace state, which is not necessarily the meter
 * with the least residual space for a newly learned cost. Admission therefore
 * checks the requested cost against every consumed percent window, including
 * active reservations and both the global freeze floor and a meter-specific
 * reserve. Call this inside HeadroomStore.admitAndStartLeases.
 */
export function admitCanCost(store: HeadroomStore, decision: CanDecision, meters: string[], policy: Policy, expectedPercent: number | null, now = new Date()): CanDecision {
  if (!decision.allowed || expectedPercent === null) return decision;
  for (const meter of meters) {
    const reserved = store.leases(meter, true, now).reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0);
    const suspended = reserveSuspendedFor(store, policy.reserve_meta, meter, policy.staleness_minutes, now);
    const meterReserve = suspended ? 0 : reserveFor(policy.reserve, meter);
    const reserve = Math.max(policy.freeze_reserve_pct, meterReserve);
    for (const row of enforcedPercentWindows(store, meter)) {
      if (row.freshness === "not_enforced") continue;
      const remaining = Math.max(0, (row.quantity!.remaining ?? (100 - row.quantity!.used)) - reserved);
      const usable = Math.max(0, remaining - reserve);
      if (expectedPercent > usable) {
        const attributeTo = meterReserve >= policy.freeze_reserve_pct && meterReserve > 0 ? meter : "freeze_reserve_pct";
        return {
          ...decision,
          allowed: false,
          meter,
          reason: `${expectedPercent.toFixed(1)}% expected would use the ${reserve}% reserve on ${meter} (${usable.toFixed(1)}% usable of ${remaining.toFixed(1)}% remaining) ${reserveAttributionBracket(attributeTo, (attributeTo === "freeze_reserve_pct" ? policy.reserve_meta.freeze_reserve_pct : reserveEntryFor(policy.reserve_meta, attributeTo)), policy.policy_mtime)}`,
        };
      }
    }
  }
  return decision;
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
   * pacing, with no --owner given, or inside the last 45 minutes before
   * reset (nothing left to smooth by then) -- this fallback only ever
   * applies to the "pro_rata" basis. "fill" projects actual use and burn to
   * a lane's end instead, and is never silently replaced by "full": it
   * applies with no owner and inside the final stretch too (see
   * fillForCore), failing closed to an `error` result rather than falling
   * back when the projection itself cannot be computed. */
  allowance_basis: "full" | "pro_rata" | "fill";
  /** The tightest enforced window the lane math actually used -- "5h" on a
   * normal meter; "wk" (or another label) when the 5h window is not
   * enforced and the tightest enforced window found was the weekly one
   * instead (Codex's main pool, for one). */
  window_used: string;
  /** Same as PlanSuccess.reserve_ceiling: every reserve capping this meter,
   * tightest first, one line -- empty string when none applies. */
  reserve_ceiling: string;
}

export interface FillOptions {
  owner?: string;
  /** See GateOptions.includeOwnerReservations. Set by admission-oriented
   * callers that need a new lane offer to include the caller's own open work. */
  includeOwnerReservations?: boolean;
  planSharePercent?: number;
  pacing?: "even" | "none";
  allowance?: "pro_rata" | "fill";
  /** An explicit lane horizon, or an action class's routing duration as
   * resolved by the boundary caller. It cannot extend past the reset. */
  durationMinutes?: number;
  actionClass?: string;
  /** Same as GateOptions.staleness_minutes: defaults to defaultPolicy's own
   * value; a caller with the real policy loaded should pass its
   * staleness_minutes here explicitly. */
  staleness_minutes?: number;
  /** policy.toml's `[reserve]` table: lanes are only counted above this
   * meter's protected floor. The larger of that floor and the caller's own
   * weekly reserve applies. */
  reserves?: Record<string, number>;
  /** Select the vendor-reported window fill works against. */
  needWindow?: string;
  /** See GateOptions.reserveMeta. */
  reserveMeta?: Record<string, ReserveEntry>;
  /** See GateOptions.policyMtime. */
  policyMtime?: string | null;
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
 * past which nothing is left to smooth. Earlier than that, it defaults to
 * the owner's pro-rata allowance; an explicit fill basis instead projects
 * current use, other leases and recent burn to the lane's end.
 */
type FillCore = FillOutcome | { meter: string; error: string; no_enforced_window?: true };

async function fillForCore(store: HeadroomStore, meter: string, laneCostOverride: number | undefined, weeklyReservePercent: number, now: Date, options: FillOptions): Promise<FillCore> {
  // Deliberately the strict enforced-only list (not meterWindows' not_enforced-
  // aware one): a not_enforced window has no percent to spend against, so it
  // can never be "the tightest enforced window" fill counts lanes against.
  const enforced = enforcedPercentWindows(store, meter);
  if (!enforced.length) return { meter, error: meterUnknownReason(store, meter, `no enforced window for ${meter}`), no_enforced_window: true };
  const requested = options.needWindow ? windowNeedMinutes(options.needWindow) : undefined;
  const tight = requested === undefined ? enforced[0] : enforced.find((row) => row.window?.minutes === requested);
  if (!tight) return { meter, error: `${options.needWindow} usage unknown` };
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
  const reservedPercent = store.leases(meter, true, now)
    .filter((lease) => (options.includeOwnerReservations || lease.owner !== options.owner) && lease.expected_percent !== null && lease.expected_percent > 0)
    .reduce((sum, lease) => sum + (lease.expected_percent ?? 0), 0);
  const used5h = Math.min(100, tight.quantity!.used + reservedPercent);
  // With no distinct weekly window, the tight window IS the weekly boundary
  // too when it isn't the 5h one (Codex's main pool with 5h not enforced):
  // its own usage stands in directly rather than defaulting to an unspent 0
  // that would let the (nonexistent) separate weekly cap never bind. A
  // genuinely 5h-only meter (weekly just not read yet) keeps the old
  // "unknown, don't block on it" default of 0.
  const usedWeekly = wider ? Math.min(100, wider.quantity!.used + reservedPercent) : (isFiveHour ? 0 : used5h);
  const windowUsed = windowShortLabel(tight.window?.minutes);
  const secondsLeft = tight.resets_at ? Math.max(0, (Date.parse(tight.resets_at) - now.getTime()) / 1000) : null;
  const learned = laneCostOverride === undefined ? store.learnedCostForMeter(meter) : undefined;
  const laneCost = laneCostOverride ?? learned?.median_percent;
  const source: FillOutcome["lane_cost_source"] = laneCostOverride !== undefined ? "given" : learned ? "learned" : "unknown";

  const pacing = options.pacing ?? "even";
  const allowance = options.allowance ?? "pro_rata";
  const inFinalStretch = secondsLeft !== null && secondsLeft <= EVEN_PACING_FULL_BURST_MINUTES * 60;
  // Pro-rata smoothing (and, below, the explicit fill projection) only makes
  // sense for a genuine 5h window: it rations a short window's own budget
  // across the hours until IT resets. Once the tight window IS the weekly
  // one (5h not enforced), there is no shorter window left to smooth -- the
  // weekly reserve check in computeFill below is already the whole
  // mechanism, and a from-scratch pro-rata line computed over a 7-day span
  // (with no owner plan share on file yet) would otherwise collapse the
  // allowance to near zero for no real reason.
  const evenPacingApplies = pacing === "even" && isFiveHour && tight.window?.minutes;
  let used5hForLanes = used5h;
  let allowanceBasis: FillOutcome["allowance_basis"] = "full";
  if (evenPacingApplies && allowance === "fill") {
    // Unlike pro-rata smoothing, the explicit fill allowance must apply
    // whenever it is requested: never silently skipped for lack of --owner
    // (a caller checking generic dispatch capacity, not one owner's lane,
    // still needs the projection to run), and never silently skipped once
    // the window is in its final stretch before reset -- that is exactly
    // when a burst against the cap matters most. A window with no finite,
    // future reset, or with no recent burn history to project from, fails
    // closed to an error rather than falling through to "full" capacity.
    const finiteReset = tight.resets_at && Number.isFinite(Date.parse(tight.resets_at)) && Date.parse(tight.resets_at) > now.getTime();
    if (!finiteReset) return { meter, error: `fill needs a finite future reset for ${meter}` };
    const minutesToReset = Math.max(0, secondsLeft ?? 0) / 60;
    const durationMinutes = Math.min(minutesToReset, Math.max(0, options.durationMinutes ?? minutesToReset));
    const burn = store.burnRateFor([tight], now, 60).get(`${meter}:${tight.window!.minutes}`);
    const fillEval = evaluateFillAllowance({
      usedPercent: tight.quantity!.used,
      reservedByOthersPercent: reservedPercent,
      burnPercentPerHour: burn?.burn_percent_per_hour ?? null,
      laneHours: durationMinutes / 60,
      capPercent: 100,
      requestPercent: 0,
    });
    if (fillEval.unknown) return { meter, error: fillEval.reason };
    used5hForLanes = fillEval.projected_percent;
    allowanceBasis = "fill";
  } else if (evenPacingApplies && !inFinalStretch && tight.resets_at && options.owner) {
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
  // The meter's protected reserve (policy.toml [reserve]) is withheld from
  // both windows before any lane is counted: lanes only fit above it, and
  // the per-class list below reads the same reduced remainder. A reserve
  // whose `unless: "banked_reset_available"` is currently satisfied (the
  // meter's principal carries a usable banked reset) is suspended: it
  // withholds nothing this call.
  const suspended = reserveSuspendedFor(store, options.reserveMeta ?? {}, meter, staleMinutes, now);
  const meterReserve = suspended ? 0 : reserveFor(options.reserves ?? {}, meter);
  if (meterReserve > 0) used5hForLanes = Math.min(100, used5hForLanes + meterReserve);
  const lanes = laneCost === undefined ? null : computeFill(used5hForLanes, usedWeekly, laneCost, Math.max(weeklyReservePercent, meterReserve), weeklyCostPerLaneOverride, 5, windowUsed);
  const lanesError = laneCost === undefined ? `no learned cost for ${meter}; pass --lane-cost` : null;

  const routing = await readRouting();
  const costs = Object.fromEntries(Object.entries(routing.costs).map(([actionClass, cost]) => {
    const classLearned = store.learnedCost(actionClass)[0];
    return [actionClass, { percent: classLearned ? classLearned.median_percent : cost.percent, duration_minutes: cost.duration_minutes }];
  }));
  const remainingPercent = Math.max(0, 100 - used5hForLanes) - 5; // same 5-point safety margin as the lane count
  const remainingMinutes = secondsLeft === null ? 0 : secondsLeft / 60;
  const classes = fillClassFits(Math.max(0, remainingPercent), remainingMinutes, costs);
  const principal = meter.slice(0, meter.indexOf(":") >= 0 ? meter.indexOf(":") : meter.length);
  const bankedAvailable = store.latestPerWindow(`${principal}:credits`).some((row) => isCurrentBankedResetObservation(row, staleMinutes, now));
  const reserveCeiling = formatReserveCeiling(
    reserveCeilingSteps({ reserve: options.reserves ?? {}, reserve_meta: options.reserveMeta ?? {}, freeze_reserve_pct: weeklyReservePercent }, meter, suspended),
    options.policyMtime ?? null, bankedAvailable,
  );

  return { meter, lanes, lanes_error: lanesError, classes, used_5h_percent: used5h, used_weekly_percent: usedWeekly, resets_in_seconds: secondsLeft, lane_cost_percent: laneCost ?? null, lane_cost_source: source, allowance_basis: allowanceBasis, window_used: windowUsed, reserve_ceiling: reserveCeiling };
}

export async function fillFor(store: HeadroomStore, meter: string, laneCostOverride: number | undefined, weeklyReservePercent: number, now = new Date(), options: FillOptions = {}): Promise<FillCore & { notices: string[] }> {
  const result = await fillForCore(store, meter, laneCostOverride, weeklyReservePercent, now, options);
  return { ...result, notices: unscheduledResetNotices(store, [meter], now) };
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
  /** The protected reserve already removed from remaining_percent, 0 when
   * this meter has none. */
  reserve_percent: number;
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
  // Not part of RouteCandidate's own (JSON-contract) shape: kept only to
  // attribute the winner's own reserve note below to the actual meter it
  // came from, rather than guessing from `meters` again.
  const decidingMeterByPrincipal = new Map<string, string | undefined>();
  const candidates: RouteCandidate[] = principals.map((principal) => {
    const account = accounts.find((item) => item.name === principal);
    // `--allow-unknown` is a diagnostic escape hatch for a read failure, not
    // permission to spend an account the operator deliberately parked.
    if (account && !isAccountEnabled(account)) return { principal, state: "UNKNOWN", reason: disabledPrincipalReason(principal), remaining_percent: null, reserve_percent: 0, window_minutes: null };
    const principalMeters = meters.filter((meter) => meter.startsWith(`${principal}:`));
    const observationMap = new Map(principalMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
    const rows = [...observationMap.values()].flat();
    const burn = store.burnRateFor(rows, now);
    const enriched = new Map([...observationMap].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
    const reserved = withOtherOwnerReservations(enriched, leases, owner);
    const block = principalMeters.map((meter) => store.dispatchBlockForMeter(meter, now)).find(Boolean) ?? store.dispatchBlockForPrincipal(principal);
    const decision = block ? { state: "FREEZE" as const, reason: block } : canConsume(principalMeters, reserved, policy, allowUnknown, now);
    const reservedRows = [...reserved.values()].flat() as Observation[];
    const deciding = pickDecidingObservation(reservedRows.length ? reservedRows : rows);
    const remaining = deciding?.quantity?.unit === "percent" ? deciding.quantity.remaining ?? Math.max(0, 100 - deciding.quantity.used) : null;
    // The deciding meter's protected reserve (policy.toml [reserve]) is
    // removed before ranking, so a principal is compared on the capacity it
    // may actually spend. The pace state is deliberately left alone: the
    // reserve is a decision floor, not a pace rule. A reserve currently
    // suspended by its own `unless: "banked_reset_available"` (see
    // reserveSuspendedFor) withholds nothing here either.
    const suspended = deciding ? reserveSuspendedFor(store, policy.reserve_meta, deciding.meter_id, policy.staleness_minutes, now) : false;
    const reserve = deciding && !suspended ? reserveFor(policy.reserve, deciding.meter_id) : 0;
    const usable = remaining === null ? null : Math.max(0, remaining - reserve);
    decidingMeterByPrincipal.set(principal, deciding?.meter_id);
    return { principal, state: decision.state, reason: decision.reason, remaining_percent: usable, reserve_percent: reserve, window_minutes: deciding?.window?.minutes ?? null };
  });
  // A meter whose whole remainder is inside its reserve has nothing to
  // route to, whatever its pace state says.
  const eligible = candidates.filter((item) => routeFits(item.state, allowUnknown) && item.remaining_percent !== null && (item.reserve_percent <= 0 || item.remaining_percent > 0));
  eligible.sort((a, b) => (b.remaining_percent as number) - (a.remaining_percent as number));
  const winner = eligible[0];
  if (!winner) return { principal: null, environment: {}, reason: candidates.length ? "no candidate fits" : "no principals for this class", candidates };
  const account = accounts.find((item) => item.name === winner.principal);
  const winningMeter = decidingMeterByPrincipal.get(winner.principal) ?? winner.principal;
  const reserveNote = winner.reserve_percent > 0
    ? ` after the ${winner.reserve_percent}% reserve ${reserveAttributionBracket(winningMeter, reserveEntryFor(policy.reserve_meta, winningMeter), policy.policy_mtime)}`
    : "";
  return {
    principal: winner.principal, environment: account ? launchEnvironment(account) : {},
    reason: `${windowShortLabel(winner.window_minutes)} ${winner.remaining_percent!.toFixed(1)}% remaining${reserveNote}`, candidates,
  };
}
