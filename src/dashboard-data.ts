import { readPolicy } from "./config.js";
import { withLastKnown, withPaceInfo } from "./pace.js";
import { readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type HeadroomEvent, type Lease, type Observation } from "./types.js";
import type { Policy } from "./policy.js";
import { headroomVersion } from "./version.js";

export interface DashboardSnapshot {
  observations: Observation[];
  events: HeadroomEvent[];
  leases: Lease[];
  resetSeen: Record<string, string>;
  burns: Record<string, Array<number | null>>;
  notices: string[];
}

export interface DashboardModel extends DashboardSnapshot {
  now: Date;
  version: string;
  direct: boolean;
  policy: Policy;
  vendors: Map<string, string>;
}

/** Twelve five-minute buckets. Drops and gaps are unknown, never negative burn. */
export function burnBuckets(rows: Observation[], now: Date): Array<number | null> {
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  const start = now.getTime() - 3_600_000;
  const ordered = rows.filter((row) => Date.parse(row.fetched_at) >= start && Date.parse(row.fetched_at) <= now.getTime())
    .sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1], current = ordered[i];
    if (previous.freshness !== "fresh" || current.freshness !== "fresh" || previous.quantity?.unit !== "percent" || current.quantity?.unit !== "percent") continue;
    const elapsed = Date.parse(current.fetched_at) - Date.parse(previous.fetched_at);
    const delta = current.quantity.used - previous.quantity.used;
    if (elapsed <= 0 || elapsed > 900_000 || delta < 0 || previous.resets_at !== current.resets_at) continue;
    const index = Math.min(11, Math.floor((Date.parse(current.fetched_at) - start) / 300_000));
    buckets[index].push(delta * 3_600_000 / elapsed);
  }
  return buckets.map((values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
}

/** Cached reads only. This helper is also used by the daemon's dashboard RPC. */
export function readDashboardStore(store: HeadroomStore, now = new Date(), rows = store.latestPerWindow()): DashboardSnapshot {
  const observations = withLastKnown(withPaceInfo(rows, store.burnRateFor(rows, now), now), store.lastKnownFor(rows, now));
  const meters = [...new Set(rows.map((row) => row.meter_id))];
  const burns: DashboardSnapshot["burns"] = {};
  for (const meter of meters) {
    const history = store.history(meter, new Date(now.getTime() - 3_600_000).toISOString());
    for (const row of rows.filter((item) => item.meter_id === meter && item.quantity?.unit === "percent")) {
      burns[`${meter}:${row.window?.minutes ?? "none"}`] = burnBuckets(history.filter((item) => item.window?.minutes === row.window?.minutes), now);
    }
  }
  return {
    observations, burns, events: store.events("1970-01-01T00:00:00.000Z").slice(-8),
    leases: store.leases(undefined, true, now), resetSeen: Object.fromEntries(store.resetSeenFor(rows, now)),
    notices: store.recentUnscheduledResets(meters, now).map((item) => `unscheduled reset on ${item.meter_id}; capacity appeared, re-plan`),
  };
}

export interface DashboardReader {
  request: () => Promise<unknown>;
  fallback: () => Promise<DashboardSnapshot>;
}

/** Old daemons reject the new method and use the same fallback as an absent socket. */
export async function dashboardSnapshot(reader: DashboardReader): Promise<{ snapshot: DashboardSnapshot; direct: boolean }> {
  const reply = await reader.request().catch(() => undefined) as { status?: string; result?: { result?: DashboardSnapshot; error?: unknown } } | undefined;
  const snapshot = reply?.status === "available" && !reply.result?.error ? reply.result?.result : undefined;
  if (snapshot && Array.isArray(snapshot.observations) && Array.isArray(snapshot.events) && Array.isArray(snapshot.leases) && snapshot.burns && snapshot.resetSeen && Array.isArray(snapshot.notices)) return { snapshot, direct: false };
  return { snapshot: await reader.fallback(), direct: true };
}

export async function gatherDashboard(): Promise<DashboardModel> {
  const { daemonRequest, socketPath } = await import("./daemon.js");
  const [{ snapshot, direct }, policy, accounts, version] = await Promise.all([
    dashboardSnapshot({
      request: () => daemonRequest(socketPath(), "dashboard", {}, 250, 250),
      fallback: async () => {
        const store = await HeadroomStore.open();
        try { return readDashboardStore(store); } finally { store.close(); }
      },
    }),
    readPolicy(), readAccounts().catch(() => []), headroomVersion(),
  ]);
  return { ...snapshot, direct, policy, version, now: new Date(), vendors: new Map(accounts.map((account) => [account.name, isLocalAccount(account) ? "local" : account.vendor])) };
}
