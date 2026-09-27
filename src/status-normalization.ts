import { withStatusInfo } from "./pace.js";
import { HeadroomStore } from "./store.js";
import type { Observation } from "./types.js";

/**
 * A daemon from before response-time status enrichment has no marker or
 * last_known value. Recompute only those rows locally so a newer CLI or MCP
 * server never serializes an expired stored-fresh result as current.
 */
export async function normalizeUnmarkedDaemonStatus(observations: Observation[], stalenessMinutes: number): Promise<Observation[]> {
  if (observations.every((item) => item.status_enriched_at)) return observations;
  const store = await HeadroomStore.open();
  try {
    const now = new Date();
    const enriched = withStatusInfo(observations, store.burnRateFor(observations, now), store.lastKnownFor(observations, now), stalenessMinutes, now);
    return observations.map((item, index) => item.status_enriched_at ? item : enriched[index]);
  } finally { store.close(); }
}
