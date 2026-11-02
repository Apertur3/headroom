import { laneLabel } from "./canary.js";
import type { NotifyItem } from "./notify.js";
import type { HeadroomStore } from "./store.js";

export const BLOCKED_PERCENT = 99;
export const BLOCKED_REPEAT_MS = 2 * 3_600_000;

/**
 * A principal that sits at 99% or more of a window while a free or banked
 * reset is available is blocked by a choice only the owner can make, so one
 * message is easy to miss. Alert once, then again every two hours while it
 * stays blocked; each repeat says how long it has been blocked. A reading
 * below 99% or no reset left ends the episode.
 */
export function blockedWithResetItems(store: HeadroomStore, now: Date): NotifyItem[] {
  const credits = new Map(store.credits(now).filter((row) => row.available > 0).map((row) => [row.principal, row]));
  const worst = new Map<string, { used: number; minutes: number }>();
  for (const row of store.latestPerWindow()) {
    const used = row.quantity?.unit === "percent" ? row.quantity.used : undefined;
    if (row.freshness !== "fresh" || used === undefined || used < BLOCKED_PERCENT || row.window?.enforcement !== "hard" || !row.window.minutes || !credits.has(row.principal_id)) continue;
    const prior = worst.get(row.principal_id);
    if (!prior || used > prior.used || (used === prior.used && row.window.minutes > prior.minutes)) worst.set(row.principal_id, { used, minutes: row.window.minutes });
  }
  const items: NotifyItem[] = [];
  // One state key for all principals: a principal missing from `worst` drops
  // out of it, which ends its episode.
  let saved: Record<string, { since: string; sent: string; count: number }> = {};
  try { saved = JSON.parse(store.daemonState("blocked_reset") ?? "{}") as typeof saved; } catch { /* replace malformed state */ }
  const next: typeof saved = {};
  for (const [principal, { used, minutes }] of worst) {
    const state = saved[principal];
    const since = state?.since ?? now.toISOString();
    if (state && now.getTime() - Date.parse(state.sent) < BLOCKED_REPEAT_MS) { next[principal] = state; continue; }
    const count = (state?.count ?? 0) + 1;
    next[principal] = { since, sent: now.toISOString(), count };
    const credit = credits.get(principal)!;
    const hours = Math.floor((now.getTime() - Date.parse(since)) / 3_600_000);
    const expiry = credit.expires_at ? ` (expires ${new Date(credit.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})` : "";
    const resets = `${credit.available} ${credit.available === 1 ? "reset" : "resets"} available${expiry}`;
    const reading = hours > 0 ? `has been at ${Math.round(used)}% of its ${laneLabel(minutes)} window for ${hours} h` : `is at ${Math.round(used)}% of its ${laneLabel(minutes)} window`;
    items.push({
      id: `blocked_reset:${principal}:${since}:${count}`, kind: "blocked_with_reset", meter: credit.meter, principal, at: now.toISOString(),
      delivery_identity: `blocked_reset:${principal}:${since}:${count}`,
      text: `🚨 ${principal} ${reading}; ${resets}. Redeem one to unblock it.`,
    });
  }
  store.setDaemonState("blocked_reset", JSON.stringify(next));
  return items;
}
