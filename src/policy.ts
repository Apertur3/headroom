import type { Lease, Observation, PaceState } from "./types.js";

export interface Policy {
  freeze_reserve_pct: number;
  pace_grace_fraction: number;
  staleness_minutes: number;
  poll_interval_minutes: number;
  principal_intervals: Record<string, number>;
  /** Keep one daemon-owned `agy` PTY alive for warm local Antigravity reads. */
  antigravity_keepalive: boolean;
  proxy?: string;
}

/** Keep the local Antigravity reader warm by default wherever `script` is available. */
export function defaultAntigravityKeepalive(platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export const defaultPolicy: Policy = {
  freeze_reserve_pct: 10, pace_grace_fraction: 0.10, staleness_minutes: 15, poll_interval_minutes: 5, principal_intervals: {},
  antigravity_keepalive: defaultAntigravityKeepalive(),
};

/** Minimal TOML scalar reader for Headroom's deliberately small policy surface. */
export function parsePolicy(text: string): Policy {
  const values: Record<string, number> = {};
  const principalIntervals: Record<string, number> = {};
  let principal: string | undefined;
  let proxy: string | undefined;
  let antigravityKeepalive: boolean | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const section = /^\[principal\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (section) { principal = section[1]; continue; }
    if (/^\[.*\]$/.test(line)) { principal = undefined; continue; }
    const interval = /^interval_minutes\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (principal && interval) { principalIntervals[principal] = Number(interval[1]); continue; }
    const proxyMatch = /^proxy\s*=\s*"([^"\\]+)"\s*$/.exec(line);
    if (proxyMatch) { try { const url = new URL(proxyMatch[1]); if (!/^https?:$/.test(url.protocol)) throw new Error("invalid"); proxy = url.toString(); continue; } catch { throw new Error("Invalid Headroom proxy"); } }
    const keepalive = /^antigravity_keepalive\s*=\s*(true|false)\s*$/.exec(line);
    if (keepalive) { antigravityKeepalive = keepalive[1] === "true"; continue; }
    const match = /^(freeze_reserve_pct|pace_grace_fraction|staleness_minutes|poll_interval_minutes)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (match) values[match[1]] = Number(match[2]);
  }
  const freeze = values.freeze_reserve_pct ?? defaultPolicy.freeze_reserve_pct;
  const grace = values.pace_grace_fraction ?? defaultPolicy.pace_grace_fraction;
  const stale = values.staleness_minutes ?? defaultPolicy.staleness_minutes;
  const interval = values.poll_interval_minutes ?? defaultPolicy.poll_interval_minutes;
  if (!Number.isFinite(freeze) || freeze < 0 || freeze > 100 || !Number.isFinite(grace) || grace < 0 || grace > 1 || !Number.isFinite(stale) || stale <= 0 || !Number.isFinite(interval) || interval <= 0 || Object.values(principalIntervals).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Invalid Headroom policy");
  return { freeze_reserve_pct: freeze, pace_grace_fraction: grace, staleness_minutes: stale, poll_interval_minutes: interval, principal_intervals: principalIntervals, antigravity_keepalive: antigravityKeepalive ?? defaultAntigravityKeepalive(), ...(proxy ? { proxy } : {}) };
}

export function paceDecision(observation: Observation | undefined, policy = defaultPolicy, now = new Date()): { state: PaceState; reason: string } {
  if (!observation) return { state: "UNKNOWN", reason: "no observation" };
  if (observation.window?.kind === "state") {
    const state = observation.metadata?.state;
    if (state === "UP") return { state, reason: "local pool up" };
    if (state === "BUSY") return { state, reason: `local pool busy${observation.metadata?.waiting ? `; waiting ${observation.metadata.waiting}` : ""}` };
    return { state: "DOWN", reason: observation.reason ?? "local pool down" };
  }
  if (observation.window?.kind === "count") return { state: "NORMAL", reason: "availability count" };
  if (observation.freshness === "not_enforced") return { state: "NOT_ENFORCED", reason: "not enforced" };
  if (observation.freshness !== "fresh") return { state: "UNKNOWN", reason: observation.reason ?? observation.freshness };
  if (!observation.quantity || observation.quantity.limit === null || !observation.window?.minutes) return { state: "UNKNOWN", reason: observation.reason ?? "missing window or quantity" };
  const fetched = new Date(observation.fetched_at).getTime();
  if (!Number.isFinite(fetched)) return { state: "UNKNOWN", reason: "invalid fetch time" };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - fetched) / 60_000));
  if (now.getTime() - fetched > policy.staleness_minutes * 60_000) return { state: "UNKNOWN", reason: `stale ${ageMinutes}m` };
  const used = observation.quantity.used;
  if (used >= 100 - policy.freeze_reserve_pct) return { state: "FREEZE", reason: "reserve reached" };
  const reset = observation.resets_at ? new Date(observation.resets_at).getTime() : Number.NaN;
  if (!Number.isFinite(reset)) return { state: "UNKNOWN", reason: "reset unknown" };
  const duration = observation.window.minutes * 60_000;
  // For fixed windows this is exactly resets_at - duration; rolling windows use
  // the same inferred start, which is the only vendor-independent anchor we have.
  const start = reset - duration;
  const elapsedFraction = Math.min(1, Math.max(0, (now.getTime() - start) / duration));
  if (elapsedFraction < policy.pace_grace_fraction) return { state: "NORMAL", reason: "grace period" };
  const surplus = (1 - used / observation.quantity.limit) - (1 - elapsedFraction);
  if (surplus > 0.10) return { state: "HARVEST", reason: "ahead of pace" };
  if (surplus < -0.10) return { state: "CONSERVE", reason: "behind pace" };
  return { state: "NORMAL", reason: "on pace" };
}

export function paceState(observation: Observation, policy = defaultPolicy, now = new Date()): PaceState { return paceDecision(observation, policy, now).state; }

const severity: Record<PaceState, number> = { NOT_ENFORCED: -1, UP: 0, HARVEST: 0, BUSY: 1, NORMAL: 1, CONSERVE: 2, UNKNOWN: 3, DOWN: 4, FREEZE: 5 };

/** Fail closed over every meter consumed by an action. */
export interface MeterPaceDecision { meter: string; state: PaceState; reason: string; }
export interface CanDecision {
  allowed: boolean; meter: string; state: PaceState; reason: string; meters: MeterPaceDecision[];
  local_preference?: "fallback" | "prefer" | "never";
  local_meter_considered?: boolean;
}

function windowLabel(observation: Observation): string {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

function windowValue(observation: Observation, state: PaceState): string {
  if (state === "UP" || state === "BUSY" || state === "DOWN") return state;
  return state === "NOT_ENFORCED" ? "n/a" : observation.quantity ? `${Math.round(observation.quantity.used)}%` : "UNKNOWN";
}

function meterDecision(meter: string, observations: Observation | Observation[] | undefined, policy: Policy, now: Date): Omit<MeterPaceDecision, "meter"> {
  const windows = observations === undefined ? [] : Array.isArray(observations) ? observations : [observations];
  // No reading at all (a fresh install, a misspelled routing meter, or an
  // absent adapter) is UNKNOWN, never NOT_ENFORCED: NOT_ENFORCED is a
  // vendor-confirmed absent limit, which requires an actual observation to
  // confirm it. An empty set must fail closed like any other unknown state.
  if (!windows.length) return { state: "UNKNOWN", reason: `no readings for ${meter}` };
  const enforced = windows
    .filter((observation) => observation.window?.kind !== "count")
    .map((observation) => ({ observation, ...paceDecision(observation, policy, now) }))
    .filter((window) => window.state !== "NOT_ENFORCED");
  if (!enforced.length) return { state: "NOT_ENFORCED", reason: "not enforced" };
  const deciding = enforced.reduce((worst, current) => severity[current.state] > severity[worst.state] ? current : worst);
  if (deciding.state === "UP" || deciding.state === "BUSY" || deciding.state === "DOWN") {
    const metadata = deciding.observation.metadata;
    const model = metadata?.model_ids?.[0] ?? "unknown";
    return { state: deciding.state, reason: `${deciding.state}, model ${model}, ${metadata?.running ?? deciding.observation.quantity?.used ?? 0} running` };
  }
  // A window with no percentage (a failed/stale/missing read) already carries
  // its own explanation from paceDecision; repeating the bare state word after
  // the literal string "UNKNOWN" (`wk UNKNOWN UNKNOWN`) said nothing twice and
  // hid the actual reason. Every other state still gets the original
  // `label value STATE` form, since there the trailing state word is the pace
  // classification of a real percentage, not a duplicate of it.
  if (deciding.state === "UNKNOWN") return { state: deciding.state, reason: `${windowLabel(deciding.observation)} UNKNOWN (${deciding.reason})` };
  return {
    state: deciding.state,
    reason: `${windowLabel(deciding.observation)} ${windowValue(deciding.observation, deciding.state)} ${deciding.state}`,
  };
}

/** A routing action class that names a meter whose principal is not any
 * currently configured account is a configuration error, not a silent
 * UNKNOWN: a misspelled meter or a stale routing.toml entry must be caught
 * loudly rather than quietly blocking (or, worse, matching nothing and
 * appearing to allow). Returns the offending meters, empty when all are known. */
export function unknownMeterPrincipals(meters: string[], knownPrincipals: Set<string>): string[] {
  return meters.filter((meter) => !knownPrincipals.has(meter.slice(0, meter.indexOf(":") >= 0 ? meter.indexOf(":") : meter.length)));
}

/** Fail closed over every enforced window of every meter consumed by an action. */
export function canConsume(meters: string[], observations: Map<string, Observation | Observation[] | undefined>, policy = defaultPolicy, allowUnknown = false, now = new Date()): CanDecision {
  if (!meters.length) throw new Error("An action must consume at least one meter");
  const states = meters.map((meter) => ({ meter, ...meterDecision(meter, observations.get(meter), policy, now) }));
  const limiting = states.reduce((worst, current) => severity[current.state] > severity[worst.state] ? current : worst);
  return { allowed: !states.some((item) => item.state === "FREEZE" || item.state === "DOWN" || item.state === "CONSERVE" || (item.state === "UNKNOWN" && !allowUnknown)), ...limiting, meters: states };
}

/** Select local capacity as an alternative route without weakening subscription
 * limits. `fallback` only opens local routing once every subscription meter is
 * conserving or frozen. */
export function canRoute(
  subscriptionMeters: string[], localMeters: string[], observations: Map<string, Observation | Observation[] | undefined>,
  localPreference: "fallback" | "prefer" | "never", policy = defaultPolicy, allowUnknown = false, now = new Date(),
): CanDecision {
  const subscriptions = canConsume(subscriptionMeters, observations, policy, allowUnknown, now);
  const localAvailable = localMeters.length > 0;
  const fallbackEligible = subscriptions.meters.length > 0 && subscriptions.meters.every((item) => item.state === "CONSERVE" || item.state === "FREEZE");
  const consider = localAvailable && localPreference !== "never" && (localPreference === "prefer" || fallbackEligible);
  if (!consider) return { ...subscriptions, local_preference: localPreference, local_meter_considered: false };
  const local = canConsume(localMeters, observations, policy, allowUnknown, now);
  // A preferred/fallback local pool only wins if it is actually usable; a down
  // local service never blocks a subscription that can still serve the action.
  const decision = local.allowed ? local : subscriptions;
  return { ...decision, local_preference: localPreference, local_meter_considered: true };
}

/** Reserve active capacity claimed by other callers before evaluating pace. */
export function canRouteWithLeases(
  subscriptionMeters: string[], localMeters: string[], observations: Map<string, Observation | Observation[] | undefined>,
  localPreference: "fallback" | "prefer" | "never", policy: Policy, allowUnknown: boolean, leases: Lease[], owner?: string, now = new Date(),
): CanDecision {
  const reserved = new Map<string, { percent: number; owners: string[]; originals: Map<number | null, number> }>();
  for (const lease of leases) {
    if (lease.owner === owner || lease.expected_percent === null || lease.expected_percent <= 0) continue;
    const current = reserved.get(lease.meter_id) ?? { percent: 0, owners: [] as string[], originals: new Map<number | null, number>() };
    current.percent += lease.expected_percent;
    if (!current.owners.includes(lease.owner)) current.owners.push(lease.owner);
    reserved.set(lease.meter_id, current);
  }
  const adjusted = new Map<string, Observation | Observation[] | undefined>();
  for (const [meter, rows] of observations) {
    const claim = reserved.get(meter);
    const apply = (row: Observation): Observation => {
      if (!claim || row.quantity?.unit !== "percent") return row;
      claim.originals.set(row.window?.minutes ?? null, row.quantity.used);
      const used = Math.min(100, row.quantity.used + claim.percent);
      return { ...row, quantity: { ...row.quantity, used, remaining: Math.max(0, (row.quantity.limit ?? 100) - used) } };
    };
    adjusted.set(meter, Array.isArray(rows) ? rows.map(apply) : rows ? apply(rows) : rows);
  }
  const decision = canRoute(subscriptionMeters, localMeters, adjusted, localPreference, policy, allowUnknown, now);
  const explain = (item: MeterPaceDecision): MeterPaceDecision => {
    const claim = reserved.get(item.meter);
    if (!claim) return item;
    const adjustedRows = adjusted.get(item.meter);
    const rows = adjustedRows === undefined ? [] : Array.isArray(adjustedRows) ? adjustedRows : [adjustedRows];
    const deciding = rows.map((row) => ({ row, state: paceDecision(row, policy, now).state })).sort((a, b) => severity[b.state] - severity[a.state])[0];
    const original = deciding && claim.originals.get(deciding.row.window?.minutes ?? null);
    if (original === undefined || !deciding) return item;
    return { ...item, reason: `${windowLabel(deciding.row)} ${Math.round(original)}% + ${Math.round(claim.percent)}% leased by ${claim.owners.join(", ")} → ${deciding.state}` };
  };
  const meters = decision.meters.map(explain);
  const limiting = meters.find((item) => item.meter === decision.meter) ?? explain({ meter: decision.meter, state: decision.state, reason: decision.reason });
  return { ...decision, ...limiting, meters };
}
