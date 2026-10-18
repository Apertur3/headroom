import { paceCore } from "./core.js";

export type PaceState = "HARVEST" | "NORMAL" | "CONSERVE" | "FREEZE" | "UNKNOWN";
export interface MeterReading {
  meter: string;
  windowMinutes: number;
  usedPercent: number | null;
  resetsAt: string | null;
  fetchedAt: string;
  status?: "allowed" | "allowed_warning" | "rejected";
  burnPercentPerHour?: number | null;
}
export interface PolicyOptions {
  stalenessMinutes?: number;
  freezeReservePercent?: number;
  paceGraceFraction?: number;
  conserveHoldMinutes?: number;
  unknownRecheckMinutes?: number;
}
export interface Need {
  class: string;
  neverHold?: boolean;
  percent?: number;
  windowMinutes?: number;
}
export const defaultPolicyOptions: Readonly<Required<PolicyOptions>> = Object.freeze({
  stalenessMinutes: 15,
  freezeReservePercent: 10,
  paceGraceFraction: 0.10,
  conserveHoldMinutes: 60,
  unknownRecheckMinutes: 5,
});

type Decision = { state: PaceState; reason: string; binding?: string };
type RunDecision = Decision & { ok: boolean; waitUntil?: string };
type BoundDecision = Decision & { reading?: MeterReading };
type Evaluated = BoundDecision & { ok: boolean };
const severity: Record<PaceState, number> = { HARVEST: 0, NORMAL: 1, CONSERVE: 2, UNKNOWN: 3, FREEZE: 4 };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): number => typeof value === "string" ? Date.parse(value) : Number.NaN;
const instant = (value: Date): number => value instanceof Date ? value.getTime() : Number.NaN;
function iso(value: number): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function optionsWithDefaults(options?: PolicyOptions): Required<PolicyOptions> {
  const result = { ...defaultPolicyOptions };
  for (const key of Object.keys(result) as Array<keyof PolicyOptions>) {
    const value = options?.[key];
    if (finite(value) && value >= 0) result[key] = value;
  }
  return result;
}

export function paceState(reading: MeterReading, options: PolicyOptions | undefined, now: Date): { state: PaceState; reason: string } {
  if (reading?.status === "rejected") return { state: "FREEZE", reason: "rate limit rejected" };
  if (!finite(reading?.usedPercent) || reading.usedPercent < 0) return { state: "UNKNOWN", reason: "no usage reading" };
  if (!Number.isFinite(instant(now))) return { state: "UNKNOWN", reason: "invalid current time" };
  if (!finite(reading.windowMinutes) || reading.windowMinutes <= 0) return { state: "UNKNOWN", reason: "missing window" };
  const policy = optionsWithDefaults(options);
  const burn = reading.burnPercentPerHour;
  return paceCore({
    used: reading.usedPercent,
    limit: 100,
    windowMinutes: reading.windowMinutes,
    resetsAt: typeof reading.resetsAt === "string" ? reading.resetsAt : null,
    fetchedAtMs: timestamp(reading.fetchedAt),
    emptyInSeconds: typeof burn === "number" && burn > 0 ? (100 - reading.usedPercent) / burn * 3600 : null,
    burnPercentPerHour: typeof burn === "number" ? burn : null,
    stalenessMinutes: policy.stalenessMinutes,
    freezeReservePct: policy.freezeReservePercent,
    graceFraction: policy.paceGraceFraction,
  }, now);
}

function selectPace(readings: MeterReading[], now: Date, options?: PolicyOptions): BoundDecision {
  let result: BoundDecision | undefined;
  for (const reading of Array.isArray(readings) ? readings : []) {
    const decision = paceState(reading, options, now);
    if (!result || severity[decision.state] > severity[result.state]) result = { ...decision, binding: reading?.meter, reading };
  }
  return result ?? { state: "UNKNOWN", reason: "no readings" };
}

export function pace(readings: MeterReading[], now: Date, options?: PolicyOptions): Decision {
  const { reading: _reading, ...decision } = selectPace(readings, now, options);
  return decision;
}

function evaluate(needs: Need | Need[], readings: MeterReading[], now: Date, options: Required<PolicyOptions>): Evaluated {
  const list = Array.isArray(needs) ? needs : [needs];
  if (!list.length) return { ...selectPace(readings, now, options), ok: true };
  let result: Evaluated | undefined;
  for (const need of list) {
    const relevant = (Array.isArray(readings) ? readings : []).filter((reading) => need?.windowMinutes === undefined || reading?.windowMinutes === need.windowMinutes);
    const decision = selectPace(relevant, now, options);
    let ok = decision.state === "NORMAL" || decision.state === "HARVEST" || decision.state === "CONSERVE";
    if (decision.state === "CONSERVE" && !need?.neverHold && finite(need?.percent)) {
      for (const reading of relevant) {
        if (!finite(reading?.usedPercent)) continue;
        const afterSpend = reading.usedPercent + need.percent;
        const reset = timestamp(reading.resetsAt);
        const burn = reading.burnPercentPerHour;
        const crossesReserve = afterSpend >= 100 - options.freezeReservePercent;
        const stalls = typeof burn === "number" && burn > 0 && (100 - afterSpend) / burn * 3600 < (reset - instant(now)) / 1000;
        if (crossesReserve || stalls) {
          ok = false;
          decision.reason = crossesReserve ? "spend reaches reserve" : "spend projects stall before reset";
          decision.binding = reading.meter;
          decision.reading = reading;
          break;
        }
      }
    }
    if (need?.neverHold) ok = true;
    const candidate = { ...decision, ok };
    if (!result || (result.ok && !candidate.ok) || (result.ok === candidate.ok && severity[candidate.state] > severity[result.state])) result = candidate;
  }
  return result!;
}

function deadline(decision: Evaluated, now: Date, options: Required<PolicyOptions>): string | null {
  if (decision.ok) return null;
  const nowMs = instant(now);
  const reset = timestamp(decision.reading?.resetsAt);
  // A reset further out than one window is bad data (e.g. epoch milliseconds): recheck instead of holding for years.
  const windowMs = (decision.reading?.windowMinutes ?? 0) * 60_000;
  if (decision.state === "FREEZE" && reset > nowMs && reset - nowMs <= windowMs) return iso(reset);
  if (decision.state === "CONSERVE") {
    const hold = nowMs + options.conserveHoldMinutes * 60_000;
    return iso(reset > nowMs ? Math.min(hold, reset) : hold);
  }
  return iso(nowMs + options.unknownRecheckMinutes * 60_000);
}

/**
 * Evaluate each need against its matching window, or all readings when no window is set.
 * neverHold always allows the need. FREEZE and UNKNOWN refuse; NORMAL and HARVEST allow.
 * CONSERVE allows unless percent is finite and ANY relevant reading with usable
 * usedPercent satisfies either: used + percent >= 100 - freezeReservePercent;
 * or burnPercentPerHour > 0 and (100 - used - percent) / burn * 3600 is less
 * than the seconds until that reading's resetsAt. Without percent, CONSERVE allows.
 * Among refused needs the tightest state wins; otherwise the tightest allowed state wins.
 */
export function canRun(need: Need | Need[], readings: MeterReading[], now: Date, options?: PolicyOptions): RunDecision {
  const policy = optionsWithDefaults(options);
  const decision = evaluate(need, readings, now, policy);
  const waitUntil = deadline(decision, now, policy);
  const { reading: _reading, ...result } = decision;
  return waitUntil === null ? result : { ...result, waitUntil };
}

export function holdUntil(need: Need | Need[], readings: MeterReading[], now: Date, options?: PolicyOptions): string | null {
  const policy = optionsWithDefaults(options);
  return deadline(evaluate(need, readings, now, policy), now, policy);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function epochIso(value: unknown): string | null {
  return finite(value) ? iso(value * 1000) : null;
}

export function fromClaudeRateLimitEvent(evt: unknown, receivedAt: Date): MeterReading[] {
  try {
    if (!record(evt) || !record(evt.rate_limit_info)) return [];
    const info = evt.rate_limit_info;
    const fetchedAt = iso(instant(receivedAt));
    if (fetchedAt === null) return [];
    const windows = { five_hour: 300, seven_day: 10080 };
    const unified = record(info.unifiedWindows);
    const result: MeterReading[] = [];
    for (const [meter, windowMinutes] of Object.entries(windows)) {
      const value = unified ? (info.unifiedWindows as Record<string, unknown>)[meter] : info.rateLimitType === meter ? info : undefined;
      if (!record(value) || !finite(value.utilization)) continue;
      const resetsAt = epochIso(value.resetsAt);
      if (!unified && resetsAt === null) continue;
      const reading: MeterReading = {
        meter, windowMinutes,
        usedPercent: Math.round(Math.min(1, Math.max(0, value.utilization)) * 1_000_000) / 10_000,
        resetsAt, fetchedAt,
      };
      if (info.rateLimitType === meter && (info.status === "allowed" || info.status === "allowed_warning" || info.status === "rejected")) reading.status = info.status;
      result.push(reading);
    }
    return result;
  } catch {
    return [];
  }
}
