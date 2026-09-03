import type { Observation, Reading } from "../types.js";

/** The upstream CLI adapter's v0.2 projection. It intentionally has the same meter IDs as native. */
export function observationsFromReading(reading: Reading): Observation[] {
  const windows = Object.values(reading.windows).flatMap((window) => window ? [window] : []);
  return windows.map((window) => ({
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
  }));
}
