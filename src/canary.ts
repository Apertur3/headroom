/**
 * The stale-lane canary. A meter lane (one meter, one window length) that has
 * had neither a fresh reading nor an explicit not_enforced reading for longer
 * than `[canary] stale_after_hours` (default 6) is a lane nobody is watching,
 * and a fail-closed orchestrator sees it only as UNKNOWN. This raises one
 * `lane_stale` alert per lane, at most once per 24 hours while it stays
 * stale, and one `lane_recovered` when it has come back for good.
 *
 * Both go to the Headroom inbox and the daemon log only, never to an external
 * channel, and `headroom doctor` reports the same lanes on demand from the
 * store. The one human-facing message is `usage_unreadable`: a plain-language
 * note, once per stale episode and grouped per principal, for a principal that
 * has had a stale lane for more than 24 hours. It travels through the normal
 * notify channels and respects quiet hours.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isAcceptedLaneReading } from "./policy.js";
import { formatResetsIn } from "./resets.js";
import { inboxRoot, sendInboxMessage, SESSION_ID_PATTERN } from "./inbox.js";
import { isAccountEnabled, isLocalAccount, type Account } from "./types.js";
import type { HeadroomStore, LaneRecord } from "./store.js";

export const CANARY_INBOX_SESSION = "headroom-canary";
/** Minimum spacing between two alerts for one lane, across recoveries too. */
export const CANARY_REALERT_MS = 24 * 3_600_000;
/** A returned lane must stay fresh this long before `lane_recovered` fires. */
export const CANARY_RECOVERY_HOLD_MS = 30 * 60_000;
/** Recovery needs a reading at most this fraction of the threshold old, so a
 * lane hovering around the threshold cannot flap between the two states. */
const RECOVERY_AGE_FRACTION = 0.25;
/** Fan-out past this many sessions is logged, never truncated. */
const INBOX_TARGET_LOG_THRESHOLD = 50;
/** A session directory with a message newer than this still counts as active. */
const INBOX_ACTIVE_MS = 24 * 3_600_000;
const PRINCIPAL_SEEN_PREFIX = "canary:principal_seen:";

export interface StaleLane {
  principal: string;
  meter: string;
  window_minutes: number;
  /** "5h", "weekly", "90m" ... */
  label: string;
  /** Null when the lane has never had an accepted reading. */
  last_accepted_at: string | null;
  /** What the age counts from: the last accepted reading, else the first recorded attempt, else when the principal was first seen. */
  since: string;
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
  if (minutes <= 0) return "any window";
  if (minutes === 10_080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function laneAgeText(seconds: number): string { return formatResetsIn(Math.max(60, seconds)); }

function expectedPrincipals(accounts: Account[]): Set<string> {
  return new Set(accounts.filter((account) => isAccountEnabled(account) && !isLocalAccount(account)).map((account) => account.name));
}

/**
 * The lanes a healthy daemon owes readings for: every lane the store has an
 * attempt for (accepted or not) on an enabled principal, plus a placeholder
 * lane for an enabled principal the canary has seen but that has no recorded
 * attempt at all. Pure read.
 */
export function expectedLanes(store: HeadroomStore, accounts: Account[]): LaneRecord[] {
  const principals = expectedPrincipals(accounts);
  const lanes = store.laneLastAccepted().filter((lane) => principals.has(lane.principal_id));
  const withLanes = new Set(lanes.map((lane) => lane.principal_id));
  for (const principal of principals) {
    if (withLanes.has(principal)) continue;
    const seen = store.daemonState(`${PRINCIPAL_SEEN_PREFIX}${principal}`);
    if (seen && Number.isFinite(Date.parse(seen))) lanes.push({ principal_id: principal, meter_id: principal, window_minutes: 0, last_accepted_at: null, first_attempt_at: seen, meter_ids: [principal] });
  }
  return lanes;
}

function staleFrom(store: HeadroomStore, lanes: LaneRecord[], staleAfterHours: number, now: Date): StaleLane[] {
  const limitMs = staleAfterHours * 3_600_000;
  const stale: StaleLane[] = [];
  for (const lane of lanes) {
    const since = lane.last_accepted_at ?? lane.first_attempt_at;
    const ageMs = now.getTime() - Date.parse(since);
    if (!Number.isFinite(ageMs) || ageMs <= limitMs) continue;
    stale.push({
      principal: lane.principal_id, meter: lane.meter_id, window_minutes: lane.window_minutes, label: laneLabel(lane.window_minutes),
      last_accepted_at: lane.last_accepted_at, since, age_seconds: Math.floor(ageMs / 1000),
      last_error: store.laneLastFailureReason(lane.meter_ids, since) ?? null,
    });
  }
  return stale.sort((a, b) => b.age_seconds - a.age_seconds || a.meter.localeCompare(b.meter));
}

/** Pure read: every expected lane past the threshold right now. */
export function findStaleLanes(store: HeadroomStore, accounts: Account[], staleAfterHours: number, now: Date): StaleLane[] {
  return staleFrom(store, expectedLanes(store, accounts), staleAfterHours, now);
}

export function staleLaneText(lane: StaleLane): string {
  const last = lane.last_accepted_at ? `last ${lane.last_accepted_at}` : `never accepted, first seen ${lane.since}`;
  return `STALE LANE ${lane.meter} ${lane.label}: no fresh reading for ${laneAgeText(lane.age_seconds)} (${last}). Last error: ${lane.last_error ?? "none recorded"}. Run: headroom doctor`;
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

/** Whether a session inbox directory holds a message newer than the active
 * window. Message names are `<epoch>-<kind>.json[.read]`, so this follows the
 * injected clock rather than file mtimes. */
async function inboxRecentlyActive(directory: string, now: Date): Promise<boolean> {
  try {
    for (const file of await readdir(directory)) {
      const epoch = Number(/^(\d+)-/.exec(file)?.[1]);
      if (Number.isFinite(epoch) && now.getTime() - epoch <= INBOX_ACTIVE_MS) return true;
    }
  } catch { /* unreadable directory: not active */ }
  return false;
}

/** Always the canary session, plus every session that is actually in use: a
 * live (not lapsed) heartbeat, or inbox traffic in the last 24 hours. The set
 * is never truncated; a large set or skipped idle inboxes are logged. */
async function inboxTargets(home: string, store: HeadroomStore, now: Date, log?: (message: string) => Promise<void>): Promise<string[]> {
  const targets = new Set([CANARY_INBOX_SESSION]);
  for (const heartbeat of store.heartbeats()) if (!heartbeat.lapsed_since && SESSION_ID_PATTERN.test(heartbeat.owner)) targets.add(heartbeat.owner);
  let skipped = 0;
  try {
    for (const entry of await readdir(inboxRoot(home), { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name) || entry.name === "." || entry.name === ".." || targets.has(entry.name)) continue;
      if (await inboxRecentlyActive(join(inboxRoot(home), entry.name), now)) targets.add(entry.name); else skipped += 1;
    }
  } catch { /* no inbox root yet */ }
  if (log && (targets.size > INBOX_TARGET_LOG_THRESHOLD || skipped > 0)) {
    await log(`stale-lane canary: inbox fan-out to ${targets.size} session(s)${targets.size > INBOX_TARGET_LOG_THRESHOLD ? ` (over ${INBOX_TARGET_LOG_THRESHOLD}; none dropped)` : ""}, ${skipped} idle inbox(es) skipped`).catch(() => undefined);
  }
  return [...targets];
}

/** Writes the alert to the canary session (must succeed) and to every active
 * session (best effort), so whichever session an orchestrator reads with
 * `headroom inbox` / `quota_inbox` carries it. */
async function writeInbox(store: HeadroomStore, home: string, item: CanaryItem, lane: { window_minutes: number; label: string }, now: Date, extra: Record<string, unknown>, log?: (message: string) => Promise<void>): Promise<void> {
  const body = JSON.stringify({ event: item.kind, meter: item.meter, principal: item.principal, window_minutes: lane.window_minutes, lane: lane.label, message: item.text, ...extra });
  for (const session of await inboxTargets(home, store, now, log)) {
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
  log?: (message: string) => Promise<void>;
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

  // First sight of a principal anchors the age of a lane that has no attempt
  // at all yet, so a freshly added principal gets the full threshold first.
  for (const principal of expectedPrincipals(options.accounts)) {
    const seenKey = `${PRINCIPAL_SEEN_PREFIX}${principal}`;
    if (!store.daemonState(seenKey)) store.setDaemonState(seenKey, now.toISOString());
  }
  const known = expectedLanes(store, options.accounts);
  const stale = new Map(staleFrom(store, known, staleAfterHours, now).map((lane) => [`${lane.meter}|${lane.window_minutes}`, lane]));
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
          await writeInbox(store, home, item, { window_minutes: lane.window_minutes, label }, now, { age_seconds: staleLane.age_seconds, last_accepted_at: staleLane.last_accepted_at, since: staleLane.since, last_error: staleLane.last_error }, options.log);
          next.last_alert_at = iso; next.alerted = true;
          items.push(item);
        } catch { /* state still advances; the alert is retried on the next pass */ }
      }
      store.setDaemonState(stateKey, JSON.stringify(next));
      continue;
    }
    if (state.state !== "stale") continue;
    const clear = (recoveringSince?: string): void => store.setDaemonState(stateKey, JSON.stringify({ ...state, recovering_since: recoveringSince }));
    if (!lane.last_accepted_at) { clear(); continue; }
    const ageMs = now.getTime() - Date.parse(lane.last_accepted_at);
    if (ageMs > staleAfterHours * 3_600_000 * RECOVERY_AGE_FRACTION) { clear(); continue; }
    // Recovery is the lane's own readings, judged by the status predicate: the
    // newest one must be accepted and so must every one inside the hold. Any
    // failed or unaccepted reading restarts the hold.
    const readings = store.laneReadingsSince(lane, state.recovering_since ?? lane.last_accepted_at);
    if (!readings.length || !isAcceptedLaneReading(readings[0])) { clear(); continue; }
    if (state.recovering_since && !readings.every(isAcceptedLaneReading)) { clear(iso); continue; }
    if (!state.recovering_since) { clear(iso); continue; }
    if (now.getTime() - Date.parse(state.recovering_since) < CANARY_RECOVERY_HOLD_MS) continue;
    if (state.alerted) {
      const item: CanaryItem = { id: `lane_recovered:${key}:${iso}`, kind: "lane_recovered", meter: lane.meter_id, principal: lane.principal_id, at: iso, text: `LANE RECOVERED ${lane.meter_id} ${label}: fresh readings again (stale since ${state.stale_since ?? "unknown"}).` };
      try { await writeInbox(store, home, item, { window_minutes: lane.window_minutes, label }, now, { stale_since: state.stale_since ?? null }, options.log); }
      catch { continue; }
      items.push(item);
    }
    store.setDaemonState(stateKey, JSON.stringify({ state: "ok", last_alert_at: state.last_alert_at }));
  }
  return items;
}

/** A principal must have a stale lane this long before a human is told. */
export const HUMAN_ALERT_AFTER_MS = 24 * 3_600_000;
const HUMAN_STATE_PREFIX = "canary:human:";
const VENDOR_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude", antigravity: "Antigravity", gemini: "Gemini", grok: "Grok", kimi: "Kimi" };

export interface HumanStaleAlert {
  id: string;
  principal: string;
  /** Start of the stale episode, the key that makes the alert once-only. */
  since: string;
  text: string;
}

function meterName(meter: string, principal: string): string {
  let name = meter;
  while (name.startsWith(`${principal}:`)) name = name.slice(principal.length + 1);
  return name && name !== principal ? name : "usage";
}

/**
 * The owed human messages: one per principal whose oldest stale lane has been
 * stale for more than 24 hours and that has not been told about this episode.
 * Also retires the episode state of principals that are no longer stale, so a
 * later outage is a new episode. Does not record a send; the caller calls
 * `markHumanAlertSent` once the message is actually queued.
 */
export function pendingHumanAlerts(store: HeadroomStore, accounts: Account[], staleAfterHours: number, now: Date): HumanStaleAlert[] {
  const stale = findStaleLanes(store, accounts, staleAfterHours, now);
  const byPrincipal = new Map<string, StaleLane[]>();
  for (const lane of stale) byPrincipal.set(lane.principal, [...(byPrincipal.get(lane.principal) ?? []), lane]);
  for (const account of accounts) {
    const key = `${HUMAN_STATE_PREFIX}${account.name}`;
    if (!byPrincipal.has(account.name) && store.daemonState(key)) store.setDaemonState(key, "");
  }
  const alerts: HumanStaleAlert[] = [];
  for (const [principal, lanes] of byPrincipal) {
    if (store.daemonState(`${HUMAN_STATE_PREFIX}${principal}`)) continue;
    const old = lanes.filter((lane) => lane.age_seconds * 1000 > HUMAN_ALERT_AFTER_MS);
    if (!old.length) continue;
    const since = old.reduce((a, b) => (Date.parse(a.since) <= Date.parse(b.since) ? a : b)).since;
    const account = accounts.find((candidate) => candidate.name === principal);
    const accountVendor = account && !isLocalAccount(account) ? account.vendor : undefined;
    const vendor = accountVendor ? VENDOR_NAMES[accountVendor] ?? accountVendor : principal;
    const who = vendor.toLowerCase() === principal.toLowerCase() || !accountVendor ? vendor : `${vendor} (${principal})`;
    const date = new Date(since).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const names = [...new Set(old.map((lane) => meterName(lane.meter, principal)))].sort();
    alerts.push({ id: `usage_unreadable:${principal}:${since}`, principal, since, text: `Headroom can't read your ${who} usage since ${date}. Treat its ${names.join(", ")} numbers as unknown until this clears.` });
  }
  return alerts;
}

export function markHumanAlertSent(store: HeadroomStore, alert: HumanStaleAlert, now: Date): void {
  store.setDaemonState(`${HUMAN_STATE_PREFIX}${alert.principal}`, JSON.stringify({ since: alert.since, sent_at: now.toISOString() }));
}
