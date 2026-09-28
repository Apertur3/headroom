import { expandHome } from "./paths.js";
import { formatClockTime, formatResetsIn, formatResetsInCoarse, resetSecondsRemaining } from "./resets.js";
import type { Lease, Observation, PaceState } from "./types.js";

/** One `[reserve."<meter>"]` (or the top-level `freeze_reserve_pct`'s own
 * `[freeze_reserve]`, under the synthetic key `"freeze_reserve_pct"`) entry:
 * a reserve percent plus the metadata that answers "who set this, why, and
 * until when" -- the exact context missing from the plain numeric form that
 * made two silently contradicting reserves take an hour to notice. `until` is an expiry instant: once
 * passed, the entry's contribution to `Policy.reserve` resolves to 0 (see
 * parsePolicy) though this record is kept so `policy show`/a refusal can
 * still say it existed and lapsed. `unless: "banked_reset_available"` -- per
 * meter only, not on freeze_reserve_pct -- suspends the reserve (also
 * resolved to 0) while its principal's `:credits` meter currently carries a
 * usable banked reset (see credits.ts's isCurrentBankedResetObservation);
 * this is call-time and store-dependent, so it is NOT resolved into
 * `Policy.reserve` at parse time -- see orchestrator-reads.ts's
 * reserveSuspendedFor/withSuspendedReserves. */
export interface ReserveEntry {
  percent: number;
  reason?: string;
  set_at?: string;
  until?: string;
  unless?: "banked_reset_available";
}

export interface Policy {
  freeze_reserve_pct: number;
  pace_grace_fraction: number;
  staleness_minutes: number;
  poll_interval_minutes: number;
  principal_intervals: Record<string, number>;
  /** From the `[reserve]` table: a protected floor per meter, in percent of
   * every window of that meter, that `gate`, `fill`, `route` and `can` never
   * dip into. Keys are meter ids (`"claude-main:fable"`); the key `"*"` is
   * the default for every meter without its own entry. Distinct from
   * freeze_reserve_pct, which is the FREEZE pace threshold -- see
   * docs/concepts.md. Already resolved for expiry (an entry whose `until`
   * has passed reads as 0 here) -- every existing reader of this field is
   * automatically expiry-correct with no changes of its own. NOT resolved
   * for `unless` suspension, which needs live store data; see ReserveEntry. */
  reserve: Record<string, number>;
  /** Metadata for every `reserve` key that carries more than a bare number:
   * entries set through `[reserve."<meter>"]` (reason/set_at/until/unless),
   * plus a plain `[reserve]` bare entry too (as a `{ percent }`-only record,
   * so every reserve key resolves uniformly through reserveEntryFor), plus
   * `"freeze_reserve_pct"` when a `[freeze_reserve]` table is present. Unlike
   * `reserve`, an expired entry's ORIGINAL percent is kept here (not zeroed)
   * so `policy show` and a refusal's attribution can still name what lapsed. */
  reserve_meta: Record<string, ReserveEntry>;
  /** Keep one daemon-owned `agy` PTY alive for warm local Antigravity reads. */
  antigravity_keepalive: boolean;
  /** "even" (default): `gate` enforces the pro-rata line and burst check for
   * a 5h need, and `fill` only offers the window's full remaining points in
   * its last 45 minutes (otherwise it offers the pro-rata allowance).
   * "none": neither restriction applies -- gate falls back to the plain
   * reserve/plan-line checks, and fill always offers the full remainder. */
  pacing: "even" | "none";
  proxy?: string;
  /** Directories the statusline snapshot adapter scans for `<profile>.json`
   * files (headroom's own `headroom statusline` output) and third-party
   * shapes like a collector's `state/<alias>.json`. Empty means the
   * caller's own default (`<HEADROOM_HOME>/statusline`) applies -- kept
   * empty here rather than resolved, since HEADROOM_HOME can change per call
   * (HEADROOM_HOME env var, tests) and this module has no path helpers of
   * its own. */
  statusline_snapshot_dirs: string[];
  /** Whether `status` and `doctor` check the npm registry (at most once every
   * 24 hours) for a newer `headroomd` and print a one-line notice. `false`
   * disables the check outright -- no network call at all -- as well as the
   * notice line. Never affects `headroom update` itself, which is always an
   * explicit, human-initiated check. */
  update_check: boolean;
  /** policy.toml's own mtime, ISO, as read by config.ts's readPolicy() --
   * null when the file does not exist (defaults in force) or this Policy
   * came straight from parsePolicy() with no file behind it (most unit
   * tests). The fallback attribution for a reserve refusal that names no
   * reason/set_at of its own (see reserveAttributionSuffix). */
  policy_mtime: string | null;
}

/** Keep the local Antigravity reader warm by default wherever `script` is available. */
export function defaultAntigravityKeepalive(platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export const defaultPolicy: Policy = {
  freeze_reserve_pct: 10, pace_grace_fraction: 0.10, staleness_minutes: 15, poll_interval_minutes: 5, principal_intervals: {}, reserve: {}, reserve_meta: {},
  antigravity_keepalive: defaultAntigravityKeepalive(), pacing: "even", statusline_snapshot_dirs: [], update_check: true, policy_mtime: null,
};

/** True once `entry.until` (an ISO instant) is at or before `now`. Entries
 * with no `until` never expire. */
export function reserveEntryExpired(entry: ReserveEntry | undefined, now: Date): boolean {
  return Boolean(entry?.until && now.getTime() >= Date.parse(entry.until));
}

/** The metadata record for a meter's own key, falling back to `"*"` --
 * mirrors reserveFor's own per-meter-then-default lookup, so a meter with no
 * entry of its own still inherits `"*"`'s reason/until/unless. */
/** Drops a trailing `# comment` but never a `#` inside a double-quoted
 * string (a reason such as "stop #123 builds"), honouring backslash escapes. */
export function stripTomlComment(raw: string): string {
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quoted && char === "\\") { i += 1; continue; }
    if (char === '"') quoted = !quoted;
    else if (char === "#" && !quoted) return raw.slice(0, i);
  }
  return raw;
}

export function reserveEntryFor(meta: Record<string, ReserveEntry>, meterId: string): ReserveEntry | undefined {
  return meta[meterId] ?? meta["*"];
}

/** The extra detail a reserve refusal or `policy show` appends after naming
 * the key and its value: the entry's own reason and set_at date when
 * present, otherwise the policy file's own mtime date -- so every reserve
 * refusal traces back to *something*, never a bare unexplained number. */
export function reserveAttributionSuffix(entry: Pick<ReserveEntry, "reason" | "set_at"> | undefined, policyMtimeIso: string | null | undefined): string | undefined {
  const bits: string[] = [];
  if (entry?.reason) bits.push(entry.reason);
  if (entry?.set_at) bits.push(`set ${entry.set_at.slice(0, 10)}`);
  if (bits.length) return bits.join(", ");
  return policyMtimeIso ? `policy.toml updated ${policyMtimeIso.slice(0, 10)}` : undefined;
}

/** `[key: reason, set date]`, or plain `[key]` when neither the entry nor
 * the policy file's mtime has anything to add. Appended after an existing
 * reserve refusal's own "...reserve on X"/"...the N% reserve" wording. */
export function reserveAttributionBracket(key: string, entry: Pick<ReserveEntry, "reason" | "set_at"> | undefined, policyMtimeIso: string | null | undefined): string {
  const suffix = reserveAttributionSuffix(entry, policyMtimeIso);
  return suffix ? `[${key}: ${suffix}]` : `[${key}]`;
}

/** Minimal TOML scalar reader for Headroom's deliberately small policy surface.
 * `now` resolves an expiring `[reserve."<meter>"]` entry's `until` against the
 * moment of the read -- readPolicy() calls this immediately after loading the
 * file, so "now" here and "now" at the point a caller acts on the result are
 * effectively the same instant. */
export function parsePolicy(text: string, now: Date = new Date()): Policy {
  const values: Record<string, number> = {};
  const principalIntervals: Record<string, number> = {};
  const reserves: Record<string, number> = {};
  const reserveMeta: Record<string, ReserveEntry> = {};
  let principal: string | undefined;
  let inReserve = false;
  let reserveEntryKey: string | undefined;
  let inFreezeReserve = false;
  let freezeReserveMeta: { reason?: string; set_at?: string; until?: string } | undefined;
  let proxy: string | undefined;
  let antigravityKeepalive: boolean | undefined;
  let updateCheck: boolean | undefined;
  let pacing: Policy["pacing"] | undefined;
  let statuslineSnapshotDirs: string[] | undefined;
  for (const raw of text.split("\n")) {
    const line = stripTomlComment(raw).trim();
    const section = /^\[principal\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (section) { principal = section[1]; inReserve = false; reserveEntryKey = undefined; inFreezeReserve = false; continue; }
    if (/^\[reserve\]$/.test(line)) { principal = undefined; inReserve = true; reserveEntryKey = undefined; inFreezeReserve = false; continue; }
    // A dated/reasoned reserve entry: `[reserve."codex-main:main"]` or
    // `[reserve.*]` (an unquoted bare word is also accepted, like the plain
    // form's own key). A sibling section of `[reserve]`, not nested inside
    // it -- mirrors how `[principal.X]` already sits beside no `[principal]`
    // table of its own.
    const reserveEntry = /^\[reserve\.(?:"([^"\\]+)"|([A-Za-z0-9_.*-]+))\]$/.exec(line);
    if (reserveEntry) { reserveEntryKey = (reserveEntry[1] ?? reserveEntry[2]) as string; principal = undefined; inReserve = false; inFreezeReserve = false; continue; }
    if (/^\[freeze_reserve\]$/.test(line)) { principal = undefined; inReserve = false; reserveEntryKey = undefined; inFreezeReserve = true; continue; }
    if (/^\[.*\]$/.test(line)) { principal = undefined; inReserve = false; reserveEntryKey = undefined; inFreezeReserve = false; continue; }
    if (inReserve && line) {
      // Meter ids carry a colon and the default key is a bare `*`, so both
      // have to be quoted in TOML; a plain word key is accepted too. Any
      // other line inside [reserve] is a typo the doctor must report rather
      // than silently drop a protected floor the caller believes is set.
      const entry = /^(?:"([^"\\]+)"|([A-Za-z0-9_.*-]+))\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
      if (!entry) throw new Error("Invalid Headroom policy");
      reserveMeta[(entry[1] ?? entry[2]) as string] = { percent: Number(entry[3]) };
      continue;
    }
    if (reserveEntryKey && line) {
      const current = reserveMeta[reserveEntryKey] ?? { percent: Number.NaN };
      const percentMatch = /^percent\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
      const reasonMatch = /^reason\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
      const setAtMatch = /^set_at\s*=\s*"([^"\\]+)"\s*$/.exec(line);
      const untilMatch = /^until\s*=\s*"([^"\\]+)"\s*$/.exec(line);
      const unlessMatch = /^unless\s*=\s*"([^"\\]*)"\s*$/.exec(line);
      if (percentMatch) current.percent = Number(percentMatch[1]);
      else if (reasonMatch) current.reason = JSON.parse(`"${reasonMatch[1]}"`);
      else if (setAtMatch) { if (!Number.isFinite(Date.parse(setAtMatch[1]))) throw new Error("Invalid Headroom policy"); current.set_at = new Date(setAtMatch[1]).toISOString(); }
      else if (untilMatch) { if (!Number.isFinite(Date.parse(untilMatch[1]))) throw new Error("Invalid Headroom policy"); current.until = new Date(untilMatch[1]).toISOString(); }
      else if (unlessMatch) { if (unlessMatch[1] !== "banked_reset_available") throw new Error("Invalid Headroom policy"); current.unless = "banked_reset_available"; }
      else throw new Error("Invalid Headroom policy");
      reserveMeta[reserveEntryKey] = current;
      continue;
    }
    if (inFreezeReserve && line) {
      const reasonMatch = /^reason\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
      const setAtMatch = /^set_at\s*=\s*"([^"\\]+)"\s*$/.exec(line);
      const untilMatch = /^until\s*=\s*"([^"\\]+)"\s*$/.exec(line);
      if (reasonMatch) { freezeReserveMeta = { ...freezeReserveMeta, reason: JSON.parse(`"${reasonMatch[1]}"`) }; continue; }
      if (setAtMatch) { if (!Number.isFinite(Date.parse(setAtMatch[1]))) throw new Error("Invalid Headroom policy"); freezeReserveMeta = { ...freezeReserveMeta, set_at: new Date(setAtMatch[1]).toISOString() }; continue; }
      if (untilMatch) { if (!Number.isFinite(Date.parse(untilMatch[1]))) throw new Error("Invalid Headroom policy"); freezeReserveMeta = { ...freezeReserveMeta, until: new Date(untilMatch[1]).toISOString() }; continue; }
      throw new Error("Invalid Headroom policy");
    }
    const interval = /^interval_minutes\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (principal && interval) { principalIntervals[principal] = Number(interval[1]); continue; }
    const proxyMatch = /^proxy\s*=\s*"([^"\\]+)"\s*$/.exec(line);
    if (proxyMatch) { try { const url = new URL(proxyMatch[1]); if (!/^https?:$/.test(url.protocol)) throw new Error("invalid"); proxy = url.toString(); continue; } catch { throw new Error("Invalid Headroom proxy"); } }
    const keepalive = /^antigravity_keepalive\s*=\s*(true|false)\s*$/.exec(line);
    if (keepalive) { antigravityKeepalive = keepalive[1] === "true"; continue; }
    const updateCheckMatch = /^update_check\s*=\s*(true|false)\s*$/.exec(line);
    if (updateCheckMatch) { updateCheck = updateCheckMatch[1] === "true"; continue; }
    const pacingMatch = /^pacing\s*=\s*"(even|none)"\s*$/.exec(line);
    if (pacingMatch) { pacing = pacingMatch[1] as Policy["pacing"]; continue; }
    const dirsMatch = /^statusline_snapshot_dirs\s*=\s*\[(.*)\]\s*$/.exec(line);
    if (dirsMatch) {
      statuslineSnapshotDirs = [...dirsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => expandHome(JSON.parse(`"${item[1]}"`) as string));
      continue;
    }
    const match = /^(freeze_reserve_pct|pace_grace_fraction|staleness_minutes|poll_interval_minutes)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (match) values[match[1]] = Number(match[2]);
  }
  const freeze = values.freeze_reserve_pct ?? defaultPolicy.freeze_reserve_pct;
  const grace = values.pace_grace_fraction ?? defaultPolicy.pace_grace_fraction;
  const stale = values.staleness_minutes ?? defaultPolicy.staleness_minutes;
  const interval = values.poll_interval_minutes ?? defaultPolicy.poll_interval_minutes;
  // Fail closed on an unparseable percent (an entry whose `percent = ` line
  // was omitted entirely resolves to NaN here, same as a plain [reserve]
  // entry with a non-numeric value already did) -- never silently drop a
  // protected floor the operator believes is set. Checked against the
  // ORIGINAL configured percent, not the expiry-resolved one below, so an
  // out-of-range entry is still caught once it lapses.
  if (Object.entries(reserveMeta).some(([key, entry]) => key !== "freeze_reserve_pct" && (!Number.isFinite(entry.percent) || entry.percent < 0 || entry.percent > 90))) throw new Error("Invalid Headroom policy");
  // Resolve every reserve_meta entry (both the plain bare form and the
  // dated/reasoned one -- both now live in reserveMeta uniformly) into the
  // plain numeric `reserve` record every existing caller already reads. An
  // entry whose `until` has passed no longer applies (fail-open toward "no
  // floor", not fail-closed -- see the spec: "no longer applies"); its
  // metadata is kept as-is so `policy show`/a refusal can still name it.
  for (const [key, entry] of Object.entries(reserveMeta)) {
    if (key === "freeze_reserve_pct") continue;
    reserves[key] = reserveEntryExpired(entry, now) ? 0 : entry.percent;
  }
  if (freezeReserveMeta) reserveMeta.freeze_reserve_pct = { percent: freeze, ...freezeReserveMeta };
  if (!Number.isFinite(freeze) || freeze < 0 || freeze > 100 || !Number.isFinite(grace) || grace < 0 || grace > 1 || !Number.isFinite(stale) || stale <= 0 || !Number.isFinite(interval) || interval <= 0 || Object.values(principalIntervals).some((value) => !Number.isFinite(value) || value <= 0) || Object.values(reserves).some((value) => !Number.isFinite(value) || value < 0 || value > 90)) throw new Error("Invalid Headroom policy");
  return { freeze_reserve_pct: freeze, pace_grace_fraction: grace, staleness_minutes: stale, poll_interval_minutes: interval, principal_intervals: principalIntervals, reserve: reserves, reserve_meta: reserveMeta, antigravity_keepalive: antigravityKeepalive ?? defaultAntigravityKeepalive(), pacing: pacing ?? defaultPolicy.pacing, statusline_snapshot_dirs: statuslineSnapshotDirs ?? defaultPolicy.statusline_snapshot_dirs, update_check: updateCheck ?? defaultPolicy.update_check, policy_mtime: null, ...(proxy ? { proxy } : {}) };
}

/** "; next poll ~HH:MM" appended to a stale reading's reason, estimated from
 * when it was last fetched plus the daemon's own poll interval -- an
 * estimate (the daemon jitters each cycle by up to 20%, and there may be no
 * daemon running at all), but a useful one: an operator staring at a stale
 * row wants to know roughly when to look again, not just that it's stale.
 * Empty string when fetched is unparseable, so a genuinely invalid
 * timestamp never prints a bogus clock time. */
function nextPollHint(observation: Observation, fetchedAtMs: number, policy: Policy, now: Date): string {
  if (!Number.isFinite(fetchedAtMs)) return "";
  const interval = policy.principal_intervals[observation.principal_id] ?? policy.poll_interval_minutes;
  const expectedAt = fetchedAtMs + interval * 60_000;
  if (expectedAt <= now.getTime()) return "; next poll time unknown";
  return `; next poll ~${formatClockTime(new Date(expectedAt))}`;
}

/** True for a held reading: store.ts's vendor-window consistency guard (see
 * issue #55) freezes it at its last confirmed baseline while a new vendor
 * identity awaits a second matching poll, or while two vendor readings have
 * flip-flopped between windows. Exported so pace.ts's effectiveFreshness can
 * apply the same "never capacity" rule to the served freshness label,
 * central to paceDecision and freshnessGate below. */
export function isHeldReading(observation: Observation): boolean {
  return Boolean(observation.metadata?.vendor_window_held || observation.metadata?.vendor_inconsistent);
}

/** Whole minutes since `fetchedAt`, clamped at 0; 0 when it cannot be
 * parsed at all, which only ever feeds held-window reason text below. */
export function ageMinutesSince(fetchedAt: string, now: Date): number {
  const fetched = new Date(fetchedAt).getTime();
  return Number.isFinite(fetched) ? Math.max(0, Math.floor((now.getTime() - fetched) / 60_000)) : 0;
}

/** A held reading (store.ts's vendor-window consistency guard: see issue
 * #55) is deliberately frozen at its last confirmed baseline while a new
 * vendor identity awaits a second matching poll -- its growing age is
 * evidence of that wait, not of a dead poller or exhausted capacity. Label it
 * as held rather than generically "stale Nm": that phrasing reads as "the
 * source stopped answering" or "this may be spent," neither of which is true
 * here, and it gives no recovery path. A held reading is UNKNOWN immediately,
 * at any age -- see isHeldReading's callers in paceDecision and
 * freshnessGate below, which use this text as their own reason; pace.ts's
 * effectiveFreshness also fails a held reading closed immediately (served
 * `freshness: "stale"`) but leaves its own `reason` field untouched while
 * still within stalenessMinutes, since several renderers (browser-report,
 * dashboard, status-view) already build their own held-specific note
 * straight from the metadata flags rather than reading this text off the
 * observation. Either way the pace state and the served freshness both fail
 * closed from the first poll that holds it, exactly like any other
 * unconfirmed reading. */
export function heldWindowReason(observation: Observation, ageMinutes: number): string | undefined {
  if (!isHeldReading(observation)) return undefined;
  return `held window past reset, unconfirmed (${ageMinutes}m since the last accepted reading); the vendor has not confirmed the new window yet -- wait for the next poll, or re-run headroom status once it reports one`;
}

/** The reason text a stale-by-age fresh reading gets: heldWindowReason's
 * distinguishable explanation when this row is a held vendor-window
 * baseline, otherwise the plain "stale Nm" every other aged-out reading has
 * always used. */
function staleOrHeldReason(observation: Observation, ageMinutes: number): string {
  return heldWindowReason(observation, ageMinutes) ?? `stale ${ageMinutes}m`;
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
  // A held reading is UNKNOWN immediately, at any age -- see isHeldReading.
  // This is checked ahead of every other classification (including
  // not_enforced) so a frozen, unconfirmed baseline can never be treated as
  // capacity while it waits out its hold.
  if (isHeldReading(observation)) return { state: "UNKNOWN", reason: heldWindowReason(observation, ageMinutesSince(observation.fetched_at, now))! };
  if (observation.freshness === "not_enforced") return { state: "NOT_ENFORCED", reason: "not enforced" };
  const parsedFetchedAt = new Date(observation.fetched_at).getTime();
  if (observation.freshness === "stale") return { state: "UNKNOWN", reason: `${observation.reason ?? "stale"}${nextPollHint(observation, parsedFetchedAt, policy, now)}` };
  if (observation.freshness !== "fresh") return { state: "UNKNOWN", reason: observation.reason ?? observation.freshness };
  if (!observation.quantity || observation.quantity.limit === null || !observation.window?.minutes) return { state: "UNKNOWN", reason: observation.reason ?? "missing window or quantity" };
  const fetched = parsedFetchedAt;
  if (!Number.isFinite(fetched)) return { state: "UNKNOWN", reason: "invalid fetch time" };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - fetched) / 60_000));
  if (now.getTime() - fetched > policy.staleness_minutes * 60_000) return { state: "UNKNOWN", reason: `${staleOrHeldReason(observation, ageMinutes)}${nextPollHint(observation, fetched, policy, now)}` };
  const used = observation.quantity.used;
  if (used >= 100 - policy.freeze_reserve_pct) return { state: "FREEZE", reason: "reserve reached" };
  const reset = observation.resets_at ? new Date(observation.resets_at).getTime() : Number.NaN;
  if (!Number.isFinite(reset)) return { state: "UNKNOWN", reason: "reset unknown" };
  const duration = observation.window.minutes * 60_000;
  // For fixed windows this is exactly resets_at - duration; rolling windows use
  // the same inferred start, which is the only vendor-independent anchor we have.
  const start = reset - duration;
  const elapsedFraction = Math.min(1, Math.max(0, (now.getTime() - start) / duration));
  // A window burning fast enough to run dry before its own reset is CONSERVE
  // regardless of the straight-line surplus below: the straight-line rule
  // only looks at usage-to-date against elapsed time, so it can still read
  // NORMAL or even HARVEST one poll before a fast, recent burn empties the
  // window early. Grace still holds off this projection unless the window
  // would stall within 30 minutes -- an opening burst that is about to run
  // out right away is not what grace exists to protect.
  const resetsInSeconds = Math.max(0, (reset - now.getTime()) / 1000);
  const emptyIn = observation.empty_in_seconds ?? null;
  const projectingStall = emptyIn !== null && emptyIn < resetsInSeconds;
  const inGrace = elapsedFraction < policy.pace_grace_fraction;
  if (inGrace && !(projectingStall && emptyIn! < 1800)) return { state: "NORMAL", reason: "grace period" };
  if (projectingStall) {
    const burn = observation.burn_percent_per_hour ?? 0;
    return { state: "CONSERVE", reason: `burning ${Math.round(burn)}%/h, empty in ${formatResetsIn(emptyIn!)}, reset in ${formatResetsIn(resetsInSeconds)}` };
  }
  const surplus = (1 - used / observation.quantity.limit) - (1 - elapsedFraction);
  if (surplus > 0.10) return { state: "HARVEST", reason: "ahead of pace" };
  if (surplus < -0.10) return { state: "CONSERVE", reason: "behind pace" };
  return { state: "NORMAL", reason: "on pace" };
}

export function paceState(observation: Observation, policy = defaultPolicy, now = new Date()): PaceState { return paceDecision(observation, policy, now).state; }

export interface FreshnessOutcome {
  ok: boolean;
  /** Present when ok is false: the same reason paceDecision would use for
   * this observation before it ever computes a pace state (a stale/failed
   * freshness label, a missing window or quantity, an unparseable fetch
   * time, or a fetch older than policy.staleness_minutes). */
  reason: string;
  /** True when the observation is a vendor-confirmed not_enforced window --
   * ok is also true in that case, since a genuinely capless window is a
   * usable reading, not an unknown one. */
  notEnforced?: boolean;
}

/**
 * The same freshness/age gate paceDecision applies before it ever computes a
 * pace state, exposed standalone for orchestrator-reads.ts's rate/plan/gate/
 * fill math: that code works over individual stored windows rather than
 * feeding a whole observation straight into paceDecision, so it previously
 * only checked for a wholly missing quantity and accepted a stale, failed,
 * or long-unpolled reading's percentage as if it were current. staleMinutes
 * is passed explicitly (rather than a full Policy) so a caller that already
 * extracted the one number it needs, the same way it already does for
 * freeze_reserve_pct, does not have to construct a Policy just to call this.
 */
export function freshnessGate(observation: Observation | undefined, staleMinutes: number, now: Date): FreshnessOutcome {
  if (!observation) return { ok: false, reason: "no observation" };
  // A held reading fails closed immediately, at any age -- see isHeldReading
  // and paceDecision's identical ordering above.
  if (isHeldReading(observation)) return { ok: false, reason: heldWindowReason(observation, ageMinutesSince(observation.fetched_at, now))! };
  if (observation.freshness === "not_enforced") return { ok: true, reason: "not enforced", notEnforced: true };
  if (observation.freshness === "stale") return { ok: false, reason: observation.reason ?? "stale" };
  if (observation.freshness !== "fresh") return { ok: false, reason: observation.reason ?? observation.freshness };
  // Count observations have no percentage limit or duration, but callers
  // that use a vendor count as an advisory fact still need the same age gate.
  const isCount = observation.window?.kind === "count";
  if (!observation.quantity || (!isCount && (observation.quantity.limit === null || !observation.window?.minutes))) return { ok: false, reason: observation.reason ?? "missing window or quantity" };
  const fetched = new Date(observation.fetched_at).getTime();
  if (!Number.isFinite(fetched)) return { ok: false, reason: "invalid fetch time" };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - fetched) / 60_000));
  if (now.getTime() - fetched > staleMinutes * 60_000) return { ok: false, reason: staleOrHeldReason(observation, ageMinutes) };
  return { ok: true, reason: "fresh" };
}

/**
 * The protected reserve for one meter, in percent of every window of that
 * meter: its own `[reserve]` entry when it has one, otherwise the `"*"`
 * default, otherwise 0. This is a decision floor -- `gate`, `fill`, `route`
 * and `can` treat `remaining - reserve` (floored at 0) as the capacity they
 * may spend -- and deliberately NOT a pace rule: pace states stay exactly
 * what the raw reading says. `freeze_reserve_pct` remains the separate
 * FREEZE pace threshold; see docs/concepts.md.
 */
export function reserveFor(reserves: Record<string, number>, meterId: string): number {
  const value = reserves[meterId] ?? reserves["*"] ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The status-line annotation appended after a window's numbers when this
 * meter has a reserve, so a reader can see why an otherwise healthy-looking
 * percentage still produced a NO. Empty when no reserve is set. */
export function reserveNote(reservePercent: number): string {
  return reservePercent > 0 ? ` (reserve ${reservePercent}%)` : "";
}

/** One reserve capping a meter, as `plan`/`fill`'s ceiling line lists it:
 * either the meter's own (or `"*"`'s) `[reserve]` entry, or the global
 * `freeze_reserve_pct`. `usable_to` is what a window could still spend if
 * this were the ONLY reserve in force -- plan/fill's actual ceiling always
 * enforces the larger (tightest) percent among every step, same as
 * gate/can/route; this list exists so a caller can see the whole stack, not
 * just the one that happened to bind. */
export interface ReserveCeilingStep { key: string; percent: number; usable_to: number; reason?: string; set_at?: string; suspended?: boolean; }

/** `meterSuspended` -- from reserveSuspendedFor (orchestrator-reads.ts), since
 * that needs live store/credits data this pure function does not have --
 * zeroes the meter's own step (and marks it) rather than dropping it, so a
 * caller can still see that a reserve exists but is currently suspended. */
export function reserveCeilingSteps(policy: Pick<Policy, "reserve" | "reserve_meta" | "freeze_reserve_pct">, meterId: string, meterSuspended: boolean): ReserveCeilingStep[] {
  const meterEntry = reserveEntryFor(policy.reserve_meta, meterId);
  const basePercent = reserveFor(policy.reserve, meterId);
  const meterPercent = meterSuspended ? 0 : basePercent;
  const freezeEntry = policy.reserve_meta.freeze_reserve_pct;
  const steps: ReserveCeilingStep[] = [];
  // Test the configured percent, not the effective one: a suspended reserve
  // stays listed (zeroed and marked) so a caller sees it exists.
  if (basePercent > 0) {
    steps.push({ key: meterId, percent: meterPercent, usable_to: 100 - meterPercent, reason: meterEntry?.reason, set_at: meterEntry?.set_at, suspended: meterSuspended && meterEntry?.unless === "banked_reset_available" });
  }
  if (policy.freeze_reserve_pct > 0) {
    steps.push({ key: "freeze_reserve_pct", percent: policy.freeze_reserve_pct, usable_to: 100 - policy.freeze_reserve_pct, reason: freezeEntry?.reason, set_at: freezeEntry?.set_at });
  }
  // Tightest (lowest usable ceiling, i.e. highest percent) first, matching
  // the spec's own example ordering ("usable to 70%: ...; then to 90%: ...").
  return steps.sort((a, b) => b.percent - a.percent);
}

/** Renders reserveCeilingSteps as `plan`/`fill`'s one-line ceiling summary.
 * Empty string when no reserve applies at all. `bankedAvailable` appends the
 * "the reserves block N points a banked reset would restore" note (spec item
 * 3): a banked reset's own vendor/manual grant is worth up to 100% of a
 * window, but the tightest reserve still standing withholds `N` of those
 * points from ever being spendable, banked or not. */
export function formatReserveCeiling(steps: ReserveCeilingStep[], policyMtimeIso: string | null, bankedAvailable: boolean): string {
  if (!steps.length) return "";
  const rendered = steps.map((step, index) => {
    const suffix = reserveAttributionSuffix(step, policyMtimeIso);
    const label = step.key === "freeze_reserve_pct" ? `freeze_reserve_pct = ${step.percent}` : `[reserve] ${step.key} = ${step.percent}`;
    const lead = index === 0 ? `usable to ${step.usable_to}%` : `then to ${step.usable_to}%`;
    const suspendedNote = step.suspended ? "; suspended while a banked reset is available" : "";
    return `${lead}: ${label}${suffix ? ` (${suffix})` : ""}${suspendedNote}`;
  });
  const blocked = steps[0]?.percent ?? 0;
  const bankedNote = bankedAvailable && blocked > 0 ? `; the reserves block ${blocked} points that a banked reset would restore` : "";
  return `${rendered.join("; ")}${bankedNote}`;
}

/**
 * Turns an allowed `can` decision into a refusal when the expected cost of
 * the action would cross into the deciding meter's reserve. The pace state
 * is left exactly as it was -- the reserve never rewrites a state, it only
 * withholds capacity -- so the printed line still shows the real state
 * alongside a reason that names the reserve.
 */
export function reserveOnCan(decision: CanDecision, reserves: Record<string, number>, remainingPercent: number | null, expectedPercent: number | null, reserveMeta: Record<string, ReserveEntry> = {}, policyMtime: string | null = null): CanDecision {
  const reserve = reserveFor(reserves, decision.meter);
  if (!decision.allowed || reserve <= 0 || remainingPercent === null || expectedPercent === null) return decision;
  const usable = Math.max(0, remainingPercent - reserve);
  if (expectedPercent <= usable) return decision;
  const attribution = reserveAttributionBracket(decision.meter, reserveEntryFor(reserveMeta, decision.meter), policyMtime);
  return { ...decision, allowed: false, reason: `${expectedPercent.toFixed(1)}% expected would use the ${reserve}% reserve on ${decision.meter} (${usable.toFixed(1)}% usable of ${remainingPercent.toFixed(1)}% remaining) ${attribution}` };
}

/** The percent of a meter already reserved by every OTHER owner's active
 * lease -- the same reservation canRouteWithLeases applies before scoring a
 * `can` decision, exposed standalone so `route` can rank and gate its own
 * candidates by the same adjusted capacity instead of a raw, unreserved
 * reading. `owner` undefined (a caller that never learned its own identity)
 * reserves against every active lease, which is the conservative direction. */
export function otherOwnerReservedPercent(leases: Lease[], meterId: string, owner: string | undefined): { percent: number; owners: string[] } {
  const owners: string[] = [];
  let percent = 0;
  for (const lease of leases) {
    if (lease.meter_id !== meterId || lease.owner === owner || lease.expected_percent === null || lease.expected_percent <= 0) continue;
    percent += lease.expected_percent;
    if (!owners.includes(lease.owner)) owners.push(lease.owner);
  }
  return { percent, owners };
}

/** Applies otherOwnerReservedPercent to every percent-quantity row of an
 * observations map, without mutating the input -- the same per-window
 * adjustment canRouteWithLeases makes inline for `can`, exposed so a caller
 * that isn't computing a full CanDecision (route's own candidate ranking)
 * still sees the reserved capacity instead of the raw reading. */
export function withOtherOwnerReservations<T extends Observation>(observations: Map<string, T | T[] | undefined>, leases: Lease[], owner: string | undefined): Map<string, T | T[] | undefined> {
  const adjusted = new Map<string, T | T[] | undefined>();
  for (const [meter, rows] of observations) {
    const { percent } = otherOwnerReservedPercent(leases, meter, owner);
    const apply = (row: T): T => {
      if (percent <= 0 || row.quantity?.unit !== "percent") return row;
      const used = Math.min(100, row.quantity.used + percent);
      return { ...row, quantity: { ...row.quantity, used, remaining: Math.max(0, (row.quantity.limit ?? 100) - used) } };
    };
    adjusted.set(meter, Array.isArray(rows) ? rows.map(apply) : rows ? apply(rows) : rows);
  }
  return adjusted;
}

const severity: Record<PaceState, number> = { NOT_ENFORCED: -1, UP: 0, HARVEST: 0, BUSY: 1, NORMAL: 1, CONSERVE: 2, UNKNOWN: 3, DOWN: 4, FREEZE: 5 };

/** Fail closed over every meter consumed by an action. */
export interface MeterPaceDecision { meter: string; state: PaceState; reason: string; }
export interface CanDecision {
  allowed: boolean; meter: string; state: PaceState; reason: string; meters: MeterPaceDecision[];
  local_preference?: "fallback" | "prefer" | "never";
  local_meter_considered?: boolean;
}

interface MeterDecision extends Omit<MeterPaceDecision, "meter"> { dispatchable: boolean; }

function isCountMeter(meter: string, observations: Observation | Observation[] | undefined): boolean {
  const windows = observations === undefined ? [] : Array.isArray(observations) ? observations : [observations];
  return meter.endsWith(":credits") || windows.some((observation) => observation.window?.kind === "count");
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

function meterDecision(meter: string, observations: Observation | Observation[] | undefined, policy: Policy, now: Date): MeterDecision {
  const windows = observations === undefined ? [] : Array.isArray(observations) ? observations : [observations];
  // Counts are informational facts, never an allowance an action can spend.
  // Check the meter id too so --allow-unknown cannot make an unread credits
  // meter dispatchable before its first observation arrives.
  if (isCountMeter(meter, windows)) {
    return { state: "UNKNOWN", reason: `count meter ${meter} cannot be used for dispatch`, dispatchable: false };
  }
  // No reading at all (a fresh install, a misspelled routing meter, or an
  // absent adapter) is UNKNOWN, never NOT_ENFORCED: NOT_ENFORCED is a
  // vendor-confirmed absent limit, which requires an actual observation to
  // confirm it. An empty set must fail closed like any other unknown state.
  if (!windows.length) return { state: "UNKNOWN", reason: `no readings for ${meter}`, dispatchable: true };
  const enforced = windows
    .filter((observation) => observation.window?.kind !== "count")
    .map((observation) => ({ observation, ...paceDecision(observation, policy, now) }))
    .filter((window) => window.state !== "NOT_ENFORCED");
  if (!enforced.length) return { state: "NOT_ENFORCED", reason: "not enforced", dispatchable: true };
  const deciding = enforced.reduce((worst, current) => severity[current.state] > severity[worst.state] ? current : worst);
  if (deciding.state === "UP" || deciding.state === "BUSY" || deciding.state === "DOWN") {
    const metadata = deciding.observation.metadata;
    const model = metadata?.model_ids?.[0] ?? "unknown";
    return { state: deciding.state, reason: `${deciding.state}, model ${model}, ${metadata?.running ?? deciding.observation.quantity?.used ?? 0} running`, dispatchable: true };
  }
  // A window with no percentage (a failed/stale/missing read) already carries
  // its own explanation from paceDecision; repeating the bare state word after
  // the literal string "UNKNOWN" (`wk UNKNOWN UNKNOWN`) said nothing twice and
  // hid the actual reason. Every other state still gets the original
  // `label value STATE` form, since there the trailing state word is the pace
  // classification of a real percentage, not a duplicate of it.
  if (deciding.state === "UNKNOWN") return { state: deciding.state, reason: `${windowLabel(deciding.observation)} UNKNOWN (${deciding.reason})`, dispatchable: true };
  const seconds = resetSecondsRemaining(deciding.observation.resets_at, now);
  const resetSuffix = seconds === null ? "" : `, resets in ${formatResetsInCoarse(seconds)}`;
  return {
    state: deciding.state,
    reason: `${windowLabel(deciding.observation)} ${windowValue(deciding.observation, deciding.state)} ${deciding.state}${resetSuffix}`,
    dispatchable: true,
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
  return {
    allowed: !states.some((item) => !item.dispatchable || item.state === "FREEZE" || item.state === "DOWN" || item.state === "CONSERVE" || (item.state === "UNKNOWN" && !allowUnknown)),
    meter: limiting.meter, state: limiting.state, reason: limiting.reason,
    meters: states.map(({ meter, state, reason }) => ({ meter, state, reason })),
  };
}

/** Select local capacity as an alternative route without weakening subscription
 * limits. `fallback` only opens local routing once every subscription meter is
 * conserving or frozen. */
export function canRoute(
  subscriptionMeters: string[], localMeters: string[], observations: Map<string, Observation | Observation[] | undefined>,
  localPreference: "fallback" | "prefer" | "never", policy = defaultPolicy, allowUnknown = false, now = new Date(),
): CanDecision {
  const subscriptions = canConsume(subscriptionMeters, observations, policy, allowUnknown, now);
  // A count meter is an invalid consumes target, not a subscription that a
  // local preference may replace. Otherwise `prefer` could silently turn a
  // misconfigured credits action into a dispatch to local capacity.
  if (subscriptionMeters.some((meter) => isCountMeter(meter, observations.get(meter)))) return { ...subscriptions, local_preference: localPreference, local_meter_considered: false };
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
  localPreference: "fallback" | "prefer" | "never", policy: Policy, allowUnknown: boolean, leases: Lease[], owner?: string, now = new Date(), includeOwnerReservations = false,
): CanDecision {
  const reserved = new Map<string, { percent: number; owners: string[]; originals: Map<number | null, number> }>();
  for (const lease of leases) {
    if ((!includeOwnerReservations && lease.owner === owner) || lease.expected_percent === null || lease.expected_percent <= 0) continue;
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
