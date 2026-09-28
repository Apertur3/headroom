import { readPolicy } from "./config.js";
import { withStatusInfo } from "./pace.js";
import { readAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { HeadroomStore, safeHeadroomDirectory } from "./store.js";
import type { PlanDowngrade } from "./store.js";
import { isAccountEnabled, isLocalAccount, type Account, type HeadroomEvent, type Lease, type Observation } from "./types.js";
import { defaultPolicy, type Policy } from "./policy.js";
import { headroomVersion } from "./version.js";

export interface DashboardSnapshot {
  observations: Observation[];
  events: HeadroomEvent[];
  leases: Lease[];
  resetSeen: Record<string, string>;
  burns: Record<string, Array<number | null>>;
  notices: string[];
  planDowngraded: PlanDowngrade[];
}

export interface DashboardModel extends DashboardSnapshot {
  now: Date;
  version: string;
  direct: boolean;
  policy: Policy;
  vendors: Map<string, string>;
}

/** Health is cheap; leave the interactive budget for the snapshot itself. */
export const DASHBOARD_HEALTH_TIMEOUT_MS = 50;
export const DASHBOARD_REQUEST_TIMEOUT_MS = 500;

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
export function readDashboardStore(store: HeadroomStore, now = new Date(), rows = store.latestPerWindow(), policy: Policy = defaultPolicy): DashboardSnapshot {
  const observations = withStatusInfo(rows, store.burnRateFor(rows, now), store.lastKnownFor(rows, now), policy.staleness_minutes, now);
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
    planDowngraded: store.planDowngrades(new Set(rows.map((row) => row.principal_id))),
  };
}

export interface DashboardReader {
  request: () => Promise<unknown>;
  fallback: () => Promise<DashboardSnapshot>;
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DashboardSnapshot>;
  return Array.isArray(snapshot.observations) && Array.isArray(snapshot.events) && Array.isArray(snapshot.leases)
    && Boolean(snapshot.burns) && Boolean(snapshot.resetSeen) && Array.isArray(snapshot.notices);
}

/** Old daemons reject the new method and use the same fallback as an absent socket. */
export async function dashboardSnapshot(reader: DashboardReader): Promise<{ snapshot: DashboardSnapshot; direct: boolean }> {
  const reply = await reader.request().catch(() => undefined) as { status?: string; result?: DashboardSnapshot | { result?: DashboardSnapshot; error?: unknown } } | undefined;
  const result = reply?.result;
  const snapshot = reply?.status === "available" && !(result && typeof result === "object" && "error" in result)
    ? isDashboardSnapshot(result) ? result : isDashboardSnapshot(result?.result) ? result.result : undefined
    : undefined;
  if (snapshot) return { snapshot: { ...snapshot, planDowngraded: Array.isArray(snapshot.planDowngraded) ? snapshot.planDowngraded : [] }, direct: false };
  return { snapshot: await reader.fallback(), direct: true };
}

/** A notice names the meter it concerns ("unscheduled reset on <meter>;
 * ..."); one about a principal that is not shown is hidden with it. */
export function noticeShown(notice: string, principals: ReadonlySet<string>): boolean {
  const meter = /^unscheduled reset on ([^;\s]+);/.exec(notice)?.[1];
  return meter === undefined || principals.has(meter.split(":", 1)[0]!);
}

export interface DashboardRequestTimeouts {
  healthTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export async function gatherDashboard(home?: string, timeouts: DashboardRequestTimeouts = {}): Promise<DashboardModel> {
  const { daemonRequest, socketPath } = await import("./daemon.js");
  const directory = await safeHeadroomDirectory(home);
  const policyPromise = readPolicy();
  const [{ snapshot, direct }, policy, registry, version] = await Promise.all([
    dashboardSnapshot({
      request: () => daemonRequest(socketPath(directory), "dashboard", {}, timeouts.healthTimeoutMs ?? DASHBOARD_HEALTH_TIMEOUT_MS, timeouts.requestTimeoutMs ?? DASHBOARD_REQUEST_TIMEOUT_MS),
      fallback: async () => {
        const store = await HeadroomStore.open(directory);
        try {
          const policy = await policyPromise;
          const now = new Date();
          const rows = store.latestPerWindow();
          return readDashboardStore(store, now, rows, policy);
        } finally { store.close(); }
      },
    }),
    // A missing accounts.toml means no registry yet; an existing one, even
    // empty, is a registry; any other read failure hides every principal,
    // since which ones are disabled cannot be known.
    policyPromise, readAccounts().then(
      (accounts): { accounts: Account[]; present: boolean; error?: string } => ({ accounts, present: true }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? { accounts: [], present: false } : { accounts: [], present: true, error: safeError(error) },
    ), headroomVersion(),
  ]);
  const accounts = registry.accounts;
  const disabled = accounts.filter((account) => !isAccountEnabled(account)).map((account) => account.name);
  const enabled = new Set(accounts.filter(isAccountEnabled).map((account) => account.name));
  // Filtered whenever accounts.toml exists, even with every account disabled
  // or none listed; the store is shown as is only when there is no file.
  const filtered = registry.present ? {
    ...snapshot,
    observations: snapshot.observations.filter((row) => enabled.has(row.principal_id)),
    events: snapshot.events.filter((event) => !event.principal_id || enabled.has(event.principal_id)),
    leases: snapshot.leases.filter((lease) => enabled.has(lease.meter_id.split(":", 1)[0])),
    planDowngraded: (snapshot.planDowngraded ?? []).filter((downgrade) => enabled.has(downgrade.principal)),
    // An unreadable registry cannot attribute any notice, so none is kept.
    notices: registry.error ? [] : snapshot.notices.filter((notice) => noticeShown(notice, enabled)),
  } : snapshot;
  const notices = [
    ...filtered.notices,
    ...(registry.error ? [`accounts.toml could not be read (${registry.error}); no principal is shown until it is fixed`] : []),
    ...(disabled.length ? [`disabled principals: ${disabled.join(", ")} (enabled = false in accounts.toml)`] : []),
  ];
  return { ...filtered, notices, direct, policy, version, now: new Date(), vendors: new Map(accounts.map((account) => [account.name, isLocalAccount(account) ? "local" : account.vendor])) };
}
