import type { Observation, Reading } from "../types.js";

export const AVAILABILITY_ONLY_REASON = "availability-only payload; quota summary not served";

/**
 * An availability response from a quota server looks deceptively like a valid
 * zero-use quota: its reset is manufactured from the fetch time and advertised
 * window duration. A real quota summary does not share that timestamp pattern.
 *
 * This deliberately works on a complete principal snapshot, rather than an
 * individual row: a genuine unused window is normal, while two or more such
 * windows with synthetic resets is not useful quota information.
 */
export function detectPlaceholder(observations: Observation[]): boolean {
  const windows = observations.filter((observation) => observation.window?.kind !== "state" && observation.freshness !== "not_enforced");
  return windows.length >= 2 && windows.every((observation) => {
    const used = observation.quantity?.used;
    const minutes = observation.window?.minutes;
    const fetched = new Date(observation.fetched_at).getTime();
    const reset = observation.resets_at ? new Date(observation.resets_at).getTime() : Number.NaN;
    return (used === 0 || used === null || used === undefined)
      && typeof minutes === "number" && Number.isFinite(minutes)
      && Number.isFinite(fetched) && Number.isFinite(reset)
      && Math.abs(reset - (fetched + minutes * 60_000)) <= 90_000;
  });
}

/** Classify availability-only snapshots before they reach the append-only store. */
export function normalizeObservations(observations: Observation[]): Observation[] {
  const byPrincipal = new Map<string, Observation[]>();
  for (const observation of observations) byPrincipal.set(observation.principal_id, [...(byPrincipal.get(observation.principal_id) ?? []), observation]);
  const placeholders = new Set([...byPrincipal.entries()]
    .filter(([, principalObservations]) => detectPlaceholder(principalObservations))
    .map(([principal]) => principal));
  return observations.map((observation) => placeholders.has(observation.principal_id)
    && observation.window?.kind !== "state" && observation.freshness !== "not_enforced"
    ? { ...observation, freshness: "failed", truth: "estimated", reason: AVAILABILITY_ONLY_REASON }
    : observation);
}

/** The upstream CLI adapter's v0.2 projection. It intentionally has the same meter IDs as native. */
export function observationsFromReading(reading: Reading): Observation[] {
  const windows = Object.values(reading.windows).flatMap((window) => window ? [window] : []);
  const observations: Observation[] = windows.map((window) => ({
    principal_id: reading.account,
    meter_id: `${reading.account}:${reading.pool}`,
    window: { kind: window.resets_at ? "fixed" : "rolling", minutes: window.window_minutes, enforcement: "hard" },
    quantity: { used: window.used_percent, limit: 100, remaining: Math.max(0, 100 - window.used_percent), unit: "percent" },
    resets_at: window.resets_at,
    observed_at: reading.sampled_at,
    fetched_at: reading.sampled_at,
    source: reading.source,
    truth: reading.truth,
    freshness: "fresh",
    confidence: reading.truth === "official" ? 1 : 0.7,
    adapter_version: "fallback",
    upstream_schema_version: "v0.56.4",
    metadata: { plan: reading.plan, free_resets_available: reading.extras.free_resets_available },
  }));
  if (reading.pool === "main" && !reading.windows.five_hour) {
    observations.push({
      principal_id: reading.account, meter_id: `${reading.account}:${reading.pool}`,
      window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: null, resets_at: null,
      observed_at: reading.sampled_at, fetched_at: reading.sampled_at, source: reading.source, truth: reading.truth,
      freshness: "not_enforced", confidence: 1, adapter_version: "fallback", upstream_schema_version: "v0.56.4",
      reason: "vendor returned no 5-hour window", metadata: { plan: reading.plan, free_resets_available: reading.extras.free_resets_available },
    });
  }
  return normalizeObservations(observations);
}
