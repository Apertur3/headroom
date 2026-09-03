import type { Observation, PaceState } from "./types.js";

export interface Policy {
  freeze_reserve_pct: number;
  staleness_minutes: number;
}

export const defaultPolicy: Policy = { freeze_reserve_pct: 10, staleness_minutes: 15 };

/** Minimal TOML scalar reader for Tally's deliberately small policy surface. */
export function parsePolicy(text: string): Policy {
  const values: Record<string, number> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^(freeze_reserve_pct|staleness_minutes)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (match) values[match[1]] = Number(match[2]);
  }
  const freeze = values.freeze_reserve_pct ?? defaultPolicy.freeze_reserve_pct;
  const stale = values.staleness_minutes ?? defaultPolicy.staleness_minutes;
  if (!Number.isFinite(freeze) || freeze < 0 || freeze > 100 || !Number.isFinite(stale) || stale <= 0) throw new Error("Invalid Tally policy");
  return { freeze_reserve_pct: freeze, staleness_minutes: stale };
}

export function paceState(observation: Observation, policy = defaultPolicy, now = new Date()): PaceState {
  if (observation.freshness !== "fresh" || !observation.quantity || !observation.window?.minutes) return "UNKNOWN";
  const fetched = new Date(observation.fetched_at).getTime();
  if (!Number.isFinite(fetched) || now.getTime() - fetched > policy.staleness_minutes * 60_000) return "UNKNOWN";
  const used = observation.quantity.used;
  if (used >= 100 - policy.freeze_reserve_pct) return "FREEZE";
  const reset = observation.resets_at ? new Date(observation.resets_at).getTime() : Number.NaN;
  if (!Number.isFinite(reset)) return "UNKNOWN";
  const duration = observation.window.minutes * 60_000;
  // For fixed windows this is exactly resets_at - duration; rolling windows use
  // the same inferred start, which is the only vendor-independent anchor we have.
  const start = reset - duration;
  const elapsedFraction = Math.min(1, Math.max(0, (now.getTime() - start) / duration));
  const surplus = (1 - used / observation.quantity.limit) - (1 - elapsedFraction);
  if (surplus > 0.10) return "HARVEST";
  if (surplus < -0.10) return "CONSERVE";
  return "NORMAL";
}

const severity: Record<PaceState, number> = { HARVEST: 0, NORMAL: 1, CONSERVE: 2, FREEZE: 3, UNKNOWN: 4 };

/** Fail closed over every meter consumed by an action. */
export function canConsume(meters: string[], observations: Map<string, Observation | undefined>, policy = defaultPolicy, allowUnknown = false, now = new Date()): { allowed: boolean; meter: string; state: PaceState } {
  if (!meters.length) throw new Error("An action must consume at least one meter");
  const states = meters.map((meter) => ({ meter, state: observations.get(meter) ? paceState(observations.get(meter)!, policy, now) : "UNKNOWN" as PaceState }));
  const limiting = states.reduce((worst, current) => severity[current.state] > severity[worst.state] ? current : worst);
  return { allowed: !states.some((item) => item.state === "FREEZE" || (item.state === "UNKNOWN" && !allowUnknown)), ...limiting };
}
