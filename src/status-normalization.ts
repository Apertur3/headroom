import { withStatusInfo, type BurnInfo } from "./pace.js";
import { HeadroomStore } from "./store.js";
import type { LastKnownReading, Observation } from "./types.js";

/**
 * A daemon from before response-time status enrichment has no marker or
 * last_known value. Recompute only those rows locally so a newer CLI or MCP
 * server never serializes an expired stored-fresh result as current.
 *
 * This opens the store read-only via HeadroomStore.openReadOnly() and never
 * migrates it: an older daemon may still be running against this exact
 * database file, and a newer CLI must never write to it -- schema migration
 * or otherwise -- just by rendering a status view. If that open, or the
 * history lookups it enables, fails for any reason (the file does not exist
 * yet, or an older schema this binary predates lacks something these queries
 * expect), this fails closed instead of throwing: it enriches with no
 * burn-rate or last-known history, which only ever produces a stricter,
 * less informative result (`burn_percent_per_hour: null`, `last_known:
 * null`) than the store-backed one -- never a more permissive one.
 */
export async function normalizeUnmarkedDaemonStatus(observations: Observation[], stalenessMinutes: number): Promise<Observation[]> {
  if (observations.every((item) => item.status_enriched_at)) return observations;
  const now = new Date();
  let burn = new Map<string, BurnInfo>();
  let lastKnown = new Map<string, LastKnownReading>();
  let store: HeadroomStore | undefined;
  try {
    store = await HeadroomStore.openReadOnly();
    burn = store.burnRateFor(observations, now);
    lastKnown = store.lastKnownFor(observations, now);
  } catch {
    // No readable store: fall closed with the empty maps above rather than
    // throwing, and never fall back to a writable/migrating open to get one.
  } finally {
    store?.close();
  }
  const enriched = withStatusInfo(observations, burn, lastKnown, stalenessMinutes, now);
  return observations.map((item, index) => item.status_enriched_at ? item : enriched[index]);
}
