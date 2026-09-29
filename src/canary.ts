/**
 * The stale-lane canary. A meter lane (one meter, one window length) that has
 * had neither a fresh reading nor an explicit not_enforced reading for longer
 * than `[canary] stale_after_hours` (default 6) is a lane nobody is watching,
 * and a fail-closed orchestrator sees it only as UNKNOWN. This raises one
 * `lane_stale` alert per lane, at most once per 24 hours while it stays
 * stale, and one `lane_recovered` when it has come back for good.
 *
 * Unlike source_failed, which is hysteresis-gated and switchable, this ignores
 * the notify event switches (`events`, `events_on`, `events_off`) and the
 * channel configuration entirely. Every alert is written to the Headroom
 * inbox first; channels are an addition, and `headroom doctor` reports the
 * same lanes on demand from the store, so no configuration can hide one.
 */
import { readdir } from "node:fs/promises";
import { formatResetsIn } from "./resets.js";
import { inboxRoot, sendInboxMessage, SESSION_ID_PATTERN } from "./inbox.js";
import { isAccountEnabled, isLocalAccount, type Account } from "./types.js";
import type { HeadroomStore } from "./store.js";

export const CANARY_INBOX_SESSION = "headroom-canary";
/** Minimum spacing between two alerts for one lane, across recoveries too. */
export const CANARY_REALERT_MS = 24 * 3_600_000;
/** A returned lane must stay fresh this long before `lane_recovered` fires. */
export const CANARY_RECOVERY_HOLD_MS = 30 * 60_000;
/** Recovery needs a reading at most this fraction of the threshold old, so a
 * lane hovering around the threshold cannot flap between the two states. */
const RECOVERY_AGE_FRACTION = 0.25;
const MAX_INBOX_TARGETS = 50;

export interface StaleLane {
  principal: string;
  meter: string;
  window_minutes: number;
  /** "5h", "weekly", "90m" ... */
  label: string;
  last_accepted_at: string;
  age_seconds: number;
  last_error: string | null;
}

export interface CanaryItem {
  id: string;
  kind: "lane_stale" | "lane_recovered";
  meter: string;
  principal: string;
  at: string;
  text: string;
}

export function laneLabel(minutes: number): string {
  if (minutes === 10_080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function laneAgeText(seconds: number): string { return formatResetsIn(Math.max(60, seconds)); }

function expectedPrincipals(accounts: Account[]): Set<string> {
  return new Set(accounts.filter((account) => isAccountEnabled(account) && !isLocalAccount(account)).map((account) => account.name));
}

/** Pure read: every expected lane past the threshold right now. */
export function findStaleLanes(store: HeadroomStore, accounts: Account[], staleAfterHours: number, now: Date): StaleLane[] {
  const principals = expectedPrincipals(accounts);
  const limitMs = staleAfterHours * 3_600_000;
  const stale: StaleLane[] = [];
  for (const lane of store.laneLastAccepted()) {
    if (!principals.has(lane.principal_id)) continue;
    const ageMs = now.getTime() - Date.parse(lane.last_accepted_at);
    if (!Number.isFinite(ageMs) || ageMs <= limitMs) continue;
    stale.push({
      principal: lane.principal_id, meter: lane.meter_id, window_minutes: lane.window_minutes, label: laneLabel(lane.window_minutes),
      last_accepted_at: lane.last_accepted_at, age_seconds: Math.floor(ageMs / 1000),
      last_error: store.laneLastFailureReason(lane.meter_id, lane.last_accepted_at) ?? null,
    });
  }
  return stale.sort((a, b) => b.age_seconds - a.age_seconds || a.meter.localeCompare(b.meter));
}

export function staleLaneText(lane: StaleLane): string {
  return `STALE LANE ${lane.meter} ${lane.label}: no fresh reading for ${laneAgeText(lane.age_seconds)} (last ${lane.last_accepted_at}). Last error: ${lane.last_error ?? "none recorded"}. Run: headroom doctor`;
}

interface LaneState {
  state: "ok" | "stale";
  stale_since?: string;
  last_alert_at?: string;
  /** An alert went out for the current outage and is owed a recovery. */
  alerted?: boolean;
  recovering_since?: string;
}

function readState(store: HeadroomStore, key: string): LaneState {
  try {
    const parsed = JSON.parse(store.daemonState(key) ?? "null") as LaneState | null;
    if (parsed && (parsed.state === "ok" || parsed.state === "stale")) return parsed;
  } catch { /* replace malformed state */ }
  return { state: "ok" };
}

async function inboxTargets(home: string): Promise<string[]> {
  const targets = new Set([CANARY_INBOX_SESSION]);
  try {
    for (const entry of await readdir(inboxRoot(home), { withFileTypes: true })) {
      if (targets.size >= MAX_INBOX_TARGETS) break;
      if (entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name) && entry.name !== "." && entry.name !== "..") targets.add(entry.name);
    }
  } catch { /* no inbox root yet */ }
  return [...targets];
}

/** Writes the alert to the canary session (must succeed) and to every session
 * that already has an inbox (best effort), so whichever session an
 * orchestrator reads with `headroom inbox` / `quota_inbox` carries it. */
async function writeInbox(home: string, item: CanaryItem, lane: { window_minutes: number; label: string }, now: Date, extra: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ event: item.kind, meter: item.meter, principal: item.principal, window_minutes: lane.window_minutes, lane: lane.label, message: item.text, ...extra });
  for (const session of await inboxTargets(home)) {
    try { await sendInboxMessage({ to: session, kind: "note", text: body, from: CANARY_INBOX_SESSION, home, now }); }
    catch (error: unknown) { if (session === CANARY_INBOX_SESSION) throw error; }
  }
}

export interface CanaryOptions {
  home: string;
  now: Date;
  accounts: Account[];
  staleAfterHours: number;
  /** Minimum spacing between evaluations; the daemon calls this every pass. */
  minIntervalMs?: number;
}

/**
 * One evaluation. Returns the alerts and recoveries raised by this call (the
 * caller fans them out to channels). Inbox writes happen here, before the
 * lane's alert state advances, so a failed write is retried on the next pass
 * rather than lost.
 */
export async function runLaneCanary(store: HeadroomStore, options: CanaryOptions): Promise<CanaryItem[]> {
  const { home, now, staleAfterHours } = options;
  const evaluatedKey = "canary:last_evaluated";
  const minInterval = options.minIntervalMs ?? 60_000;
  const previous = Date.parse(store.daemonState(evaluatedKey) ?? "");
  if (Number.isFinite(previous) && now.getTime() >= previous && now.getTime() - previous < minInterval) return [];
  store.setDaemonState(evaluatedKey, now.toISOString());

  const principals = expectedPrincipals(options.accounts);
  const stale = new Map(findStaleLanes(store, options.accounts, staleAfterHours, now).map((lane) => [`${lane.meter}|${lane.window_minutes}`, lane]));
  const known = store.laneLastAccepted().filter((lane) => principals.has(lane.principal_id));
  const items: CanaryItem[] = [];
  const iso = now.toISOString();

  for (const lane of known) {
    const key = `${lane.meter_id}|${lane.window_minutes}`;
    const stateKey = `canary:lane:${key}`;
    const state = readState(store, stateKey);
    const staleLane = stale.get(key);
    const label = laneLabel(lane.window_minutes);
    if (staleLane) {
      const due = !state.last_alert_at || now.getTime() - Date.parse(state.last_alert_at) >= CANARY_REALERT_MS;
      const next: LaneState = { ...state, state: "stale", stale_since: state.state === "stale" ? state.stale_since : iso, recovering_since: undefined };
      if (due) {
        const item: CanaryItem = { id: `lane_stale:${key}:${iso}`, kind: "lane_stale", meter: lane.meter_id, principal: lane.principal_id, at: iso, text: staleLaneText(staleLane) };
        try {
          await writeInbox(home, item, { window_minutes: lane.window_minutes, label }, now, { age_seconds: staleLane.age_seconds, last_accepted_at: staleLane.last_accepted_at, last_error: staleLane.last_error });
          next.last_alert_at = iso; next.alerted = true;
          items.push(item);
        } catch { /* state still advances; the alert is retried on the next pass */ }
      }
      store.setDaemonState(stateKey, JSON.stringify(next));
      continue;
    }
    if (state.state !== "stale") continue;
    const ageMs = now.getTime() - Date.parse(lane.last_accepted_at);
    if (ageMs > staleAfterHours * 3_600_000 * RECOVERY_AGE_FRACTION) { store.setDaemonState(stateKey, JSON.stringify({ ...state, recovering_since: undefined })); continue; }
    if (!state.recovering_since) { store.setDaemonState(stateKey, JSON.stringify({ ...state, recovering_since: iso })); continue; }
    if (now.getTime() - Date.parse(state.recovering_since) < CANARY_RECOVERY_HOLD_MS) continue;
    if (state.alerted) {
      const item: CanaryItem = { id: `lane_recovered:${key}:${iso}`, kind: "lane_recovered", meter: lane.meter_id, principal: lane.principal_id, at: iso, text: `LANE RECOVERED ${lane.meter_id} ${label}: fresh readings again (stale since ${state.stale_since ?? "unknown"}).` };
      try { await writeInbox(home, item, { window_minutes: lane.window_minutes, label }, now, { stale_since: state.stale_since ?? null }); }
      catch { continue; }
      items.push(item);
    }
    store.setDaemonState(stateKey, JSON.stringify({ state: "ok", last_alert_at: state.last_alert_at }));
  }
  return items;
}
