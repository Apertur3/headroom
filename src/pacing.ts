/**
 * Orchestrator pacing math for `rate`, `plan`, `gate` and `fill`: pure
 * functions over already-fetched usage numbers. The CLI, the daemon and the
 * MCP server fetch the observations (from the store, or through the daemon);
 * this module has no I/O of its own so every rule here is a plain unit test.
 */
import { fiveHourPercentToWeeklyPercent } from "./calibration.js";

export interface PlanResult {
  weekly_remaining_percent: number;
  reserve_percent: number;
  hours_per_window: number;
  /** Whole 5h windows left before the weekly reset, rounded up so a partial
   * window still gets its own share instead of inflating the last one. */
  remaining_5h_windows: number;
  points_per_5h_window: number;
  /** Weekly percent per hour that would spend exactly the remaining budget
   * (after the reserve) by the reset. The "plan line" to hold. */
  plan_line_percent_per_hour: number;
}

export function computePlan(weeklyUsedPercent: number, weeklyResetsAt: string, hoursPer5hWindow: number, reservePercent: number, now = new Date()): PlanResult {
  const hoursUntilReset = Math.max(0, (Date.parse(weeklyResetsAt) - now.getTime()) / 3_600_000);
  const weeklyRemaining = Math.max(0, 100 - weeklyUsedPercent);
  const budget = Math.max(0, weeklyRemaining - reservePercent);
  const remainingWindows = Math.max(1, Math.ceil(hoursUntilReset / hoursPer5hWindow));
  return {
    weekly_remaining_percent: weeklyRemaining, reserve_percent: reservePercent, hours_per_window: hoursPer5hWindow,
    remaining_5h_windows: remainingWindows, points_per_5h_window: budget / remainingWindows,
    plan_line_percent_per_hour: hoursUntilReset > 0 ? budget / hoursUntilReset : 0,
  };
}

export interface GateNeed { window: "5h" | "wk"; points: number; }

/** Parses one `--need` value like `5h:15` or `wk:3` into a GateNeed. Throws
 * with the offending text on anything else, so a typo fails the dispatch
 * loudly instead of silently gating on nothing. */
export function parseGateNeed(value: string): GateNeed {
  const match = /^(5h|wk):([0-9]+(?:\.[0-9]+)?)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid --need value: ${value} (use 5h:N or wk:N)`);
  const points = Number(match[2]);
  if (!Number.isFinite(points) || points < 0) throw new Error(`Invalid --need value: ${value} (use 5h:N or wk:N)`);
  return { window: match[1] as "5h" | "wk", points };
}
export interface GateUsage {
  used5h: number | null;
  usedWk: number | null;
  weeklyResetsAt: string | null;
  hoursPer5hWindow: number;
}
export interface GateResult { allowed: boolean; reason: string; }

/** Fail closed over every --need: the first one that does not fit stops the
 * check and names the reason. With usePlan, a 5h need must also fit under
 * the current plan line (its even share of the remaining weekly budget), a
 * stricter bar than just staying under the freeze reserve. */
export function evaluateGate(needs: GateNeed[], usage: GateUsage, reservePercent: number, usePlan: boolean, now = new Date()): GateResult {
  if (!needs.length) return { allowed: false, reason: "no --need given" };
  for (const need of needs) {
    const used = need.window === "5h" ? usage.used5h : usage.usedWk;
    if (used === null) return { allowed: false, reason: `${need.window} usage unknown` };
    const prospective = used + need.points;
    const ceiling = 100 - reservePercent;
    if (prospective > ceiling) {
      const left = Math.max(0, ceiling - used);
      return { allowed: false, reason: `${need.window} needs ${need.points} more but only ${left.toFixed(1)} left before the ${reservePercent}% reserve` };
    }
    if (usePlan && need.window === "5h" && usage.weeklyResetsAt && usage.usedWk !== null) {
      const plan = computePlan(usage.usedWk, usage.weeklyResetsAt, usage.hoursPer5hWindow, reservePercent, now);
      if (prospective > plan.points_per_5h_window) {
        return { allowed: false, reason: `5h needs ${need.points} more but the plan line allows only ${plan.points_per_5h_window.toFixed(1)} points this window` };
      }
    }
  }
  return { allowed: true, reason: "fits" };
}

export interface FillResult {
  lanes: number;
  points_used: number;
  reason: string;
}

/** How many more lanes of a fixed 5h-window cost fit before the window's
 * unspent points are lost at reset, capped so the weekly allowance stays
 * above its own reserve. weeklyCostPerLanePercent is normally the learned
 * per-lane weekly cost; fall back to the calibration ratio
 * (fiveHourPercentToWeeklyPercent) when nothing has been learned yet. */
export function computeFill(used5hPercent: number, usedWeeklyPercent: number, laneCost5hPercent: number, weeklyReservePercent: number, weeklyCostPerLanePercent = fiveHourPercentToWeeklyPercent(laneCost5hPercent), safetyMarginPercent = 5): FillResult {
  const remaining5h = Math.max(0, 100 - used5hPercent) - safetyMarginPercent;
  const lanesBy5h = laneCost5hPercent > 0 ? Math.floor(remaining5h / laneCost5hPercent) : 0;
  const weeklyBudget = Math.max(0, 100 - usedWeeklyPercent - weeklyReservePercent);
  const lanesByWeekly = weeklyCostPerLanePercent > 0 ? Math.floor(weeklyBudget / weeklyCostPerLanePercent) : 0;
  const lanes = Math.max(0, Math.min(lanesBy5h, lanesByWeekly));
  const boundByWeekly = lanesByWeekly < lanesBy5h;
  const reason = lanes > 0
    ? `${lanes} lane${lanes === 1 ? "" : "s"} fit`
    : boundByWeekly
      ? `weekly reserve would be breached: ${weeklyBudget.toFixed(1)}% weekly budget left, ${weeklyCostPerLanePercent.toFixed(2)}% weekly per lane`
      : `5h window has only ${Math.max(0, remaining5h).toFixed(1)}% left above the ${safetyMarginPercent}% safety margin`;
  return { lanes, points_used: lanes * laneCost5hPercent, reason };
}

export interface RoutingCost { percent: number; duration_minutes: number; }
export interface FillClassFit { action_class: string; percent: number; duration_minutes: number; fits: number; }

/**
 * Even-pacing (policy.toml `pacing = "even"`, the default) guards a window
 * against exactly the incident that motivated it: a burst of lanes launched
 * in one tick that spends most of a window's budget in minutes, long before
 * its reset. Two independent checks, both scoped to one owner's 5h request:
 *
 * - The pro-rata line: the owner's planned share of this window, scaled by
 *   how much of the window has actually elapsed. Spending ahead of that line
 *   by more than a small tolerance is refused even though it would pass the
 *   plain "under the reserve" check.
 * - Burst: the meter's own very recent (10-minute) burn rate, independent of
 *   any one owner's plan, catching a spike before the pro-rata line even
 *   has enough history to reflect it.
 */
export interface ProRataInput {
  usedSoFarByOwnerPercent: number;
  requestPercent: number;
  plannedSharePercent: number;
  windowStart: Date;
  windowDurationHours: number;
  tolerancePercent?: number;
  now?: Date;
}
export interface ProRataResult { allowed: boolean; reason: string; line_percent: number; }

export function evaluateProRataLine(input: ProRataInput): ProRataResult {
  const tolerance = input.tolerancePercent ?? 5;
  const now = input.now ?? new Date();
  const elapsedHours = Math.max(0, (now.getTime() - input.windowStart.getTime()) / 3_600_000);
  const elapsedFraction = input.windowDurationHours > 0 ? Math.min(1, elapsedHours / input.windowDurationHours) : 1;
  const line = input.plannedSharePercent * elapsedFraction;
  const prospective = input.usedSoFarByOwnerPercent + input.requestPercent;
  const over = prospective - line - tolerance;
  if (over > 0) {
    return { allowed: false, line_percent: line, reason: `pro-rata: ${prospective.toFixed(1)} pts used+requested exceeds the ${line.toFixed(1)} pt line (+${tolerance} tolerance) by ${over.toFixed(1)}` };
  }
  return { allowed: true, line_percent: line, reason: "fits the pro-rata line" };
}

export interface BurstInput {
  /** The meter's own burn over the last 10 minutes, independent of owner. */
  burnPercentPerHour10m: number | null;
  plannedSharePercent: number;
  windowDurationHours: number;
  usedPercent: number;
  windowStart: Date;
}
export interface BurstResult { allowed: boolean; reason: string; }

/** HH:MM in UTC, matching this repo's other coarse reset-time formatting. */
function hhmm(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function evaluateBurst(input: BurstInput): BurstResult {
  const planRate = input.windowDurationHours > 0 ? input.plannedSharePercent / input.windowDurationHours : 0;
  if (input.burnPercentPerHour10m === null || planRate <= 0 || input.burnPercentPerHour10m <= 2 * planRate) return { allowed: true, reason: "no burst" };
  // The pro-rata line grows at planRate from windowStart; "hold until" is the
  // moment that line, growing at planRate, would reach the usage already on
  // the books -- i.e. when spending could resume without re-tripping this
  // same check.
  const hoursNeeded = input.usedPercent / planRate;
  const holdUntil = new Date(input.windowStart.getTime() + hoursNeeded * 3_600_000);
  return { allowed: false, reason: `burst: ${Math.round(input.burnPercentPerHour10m)} pts/h over the last 10 min, plan ${Math.round(planRate)} pts/h; hold until ${hhmm(holdUntil)}` };
}

export type WaitOutcome = "reset" | "timeout" | "unknown";

/**
 * Blocks until a meter's window resets, detected as its stored resets_at
 * value changing from what was first seen (the vendor-confirmed sign a
 * window rolled over) or wall-clock time reaching that first-seen value (a
 * fallback for a daemon that has not re-polled yet). `getResetsAt` and
 * `sleep` are injected so this has no timers or I/O of its own to fake in a
 * test; the CLI wires real ones.
 */
export async function waitForReset(getResetsAt: () => Promise<string | null>, maxMs: number | null, options: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<WaitOutcome> {
  const pollMs = options.pollMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  const initial = await getResetsAt();
  if (initial === null) return "unknown";
  for (;;) {
    const current = await getResetsAt();
    if (current === null) return "unknown";
    if (current !== initial || Date.parse(current) <= clock()) return "reset";
    if (maxMs !== null && clock() - started >= maxMs) return "timeout";
    await sleep(pollMs);
  }
}

/**
 * How many runs of each routing action class fit in the window's remaining
 * points and remaining minutes before reset. Only classes that fit at least
 * once are returned, in the order given. `cost` for a class comes from
 * routing.toml's [cost.<class>] table; a caller substitutes the learned
 * median there first when samples exist, since that always overrides the
 * static config number.
 */
export function fillClassFits(remainingPercent: number, remainingMinutes: number, costs: Record<string, RoutingCost>): FillClassFit[] {
  const fits: FillClassFit[] = [];
  for (const [actionClass, cost] of Object.entries(costs)) {
    if (cost.percent <= 0 || cost.duration_minutes <= 0) continue;
    const byPoints = Math.floor(remainingPercent / cost.percent);
    const byTime = Math.floor(remainingMinutes / cost.duration_minutes);
    const count = Math.max(0, Math.min(byPoints, byTime));
    if (count > 0) fits.push({ action_class: actionClass, percent: cost.percent, duration_minutes: cost.duration_minutes, fits: count });
  }
  return fits;
}
