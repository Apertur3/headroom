import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { headroomHome } from "../paths.js";
import { assertSafeReadableDirectory, exceedsJsonDepth, readBoundedRegularFile, safeError } from "../security.js";
import type { Observation, ProviderAccount } from "../types.js";

export const STATUSLINE_SOURCE = "native:claude-statusline";

/** policy.toml's statusline_snapshot_dirs, or the one default directory
 * `headroom statusline` itself writes into when that list is empty. */
export function statuslineSnapshotDirs(configuredDirs: string[], home = headroomHome()): string[] {
  return configuredDirs.length ? configuredDirs : [join(home, "statusline")];
}

/** A snapshot older than this is not used as a zero-auth source; the
 * collector falls back to the probe (subject to its own grant gate) instead. */
export const STATUSLINE_FRESH_MINUTES = 10;

/** How far into the future an `observed_at` may sit before it is rejected
 * outright rather than trusted -- ordinary clock skew between the machine
 * that wrote a snapshot and this one, never a legitimate reading of "later
 * than now". A snapshot older than this passes validation fine; freshness
 * (STATUSLINE_FRESH_MINUTES above) is a separate, much stricter question of
 * whether a *valid* snapshot is still current enough to trust unconditionally. */
const CLOCK_SKEW_TOLERANCE_MINUTES = 5;

/** JavaScript's own Date range: +/-100,000,000 days from the epoch, in
 * seconds (this repo's own epoch unit throughout, matching Claude Code's
 * `resets_at`). A finite number outside this range is not a date at all --
 * `1e20` is the review's own example -- and must never reach `new Date()`,
 * whose `toISOString()`/formatting throws "Invalid time value" for it. */
const MAX_EPOCH_SECONDS = 8_640_000_000_000;

/** Files scanned per configured snapshot directory, per poll: a bound, not a
 * tuning knob -- a directory legitimately never holds more than one file per
 * configured Claude principal. */
const MAX_SNAPSHOT_FILES_PER_DIR = 64;

/** JSON object/array nesting accepted from a snapshot file. Every field this
 * module actually reads is at most two levels deep (`root.rate_limits.five_hour`,
 * `root.extra.<key>`); this only needs to be generous enough not to reject a
 * legitimate file while still refusing a pathologically nested one. */
const MAX_SNAPSHOT_JSON_DEPTH = 16;

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A finite number that also falls inside the range `new Date()` can
 * represent -- necessary but not sufficient for "safe to format"; callers
 * that also care about future-dated clock skew use validObservedAt below. */
function validEpochSeconds(seconds: number): boolean {
  return Number.isFinite(seconds) && Math.abs(seconds) <= MAX_EPOCH_SECONDS;
}

/** An `observed_at` this module will trust: a valid epoch that is not more
 * than a few minutes ahead of `now`. Rejecting a future timestamp here --
 * rather than merely flagging it -- is what stops it from permanently
 * winning `latestStatuslineSnapshot`'s newest-wins comparison and suppressing
 * a real reading forever. */
function validObservedAt(seconds: number, now: Date): boolean {
  if (!validEpochSeconds(seconds)) return false;
  return seconds <= now.getTime() / 1000 + CLOCK_SKEW_TOLERANCE_MINUTES * 60;
}

/**
 * profile = basename(CLAUDE_CONFIG_DIR), or "default" for the default
 * `~/.claude` profile -- mirroring claude.ts's claudeServiceName() default
 * split, so `headroom statusline` (which writes one file per profile) and
 * this adapter (which reads one file per configured principal) always agree
 * on exactly one filename per profile without either side hardcoding the
 * other's account name.
 */
export function statuslineProfile(configDir: string, home = homedir()): string {
  const directory = resolve(configDir);
  return directory === resolve(home, ".claude") ? "default" : basename(directory);
}

export function statuslineSnapshotPath(dir: string, configDir: string, home = homedir()): string {
  return join(dir, `${statuslineProfile(configDir, home)}.json`);
}

/** One vendor-reported bucket: a percent used and when it resets. `is_active`
 * is only ever present on a model-scoped bucket (see claude.ts's `scoped()`);
 * a plain five_hour/seven_day bucket never carries it. */
export interface StatuslineBucket {
  used_percent: number;
  resets_at: number | null; // epoch seconds, Claude Code's own unit
  is_active?: boolean;
}

export interface StatuslineSnapshot {
  /** "default" or a CLAUDE_CONFIG_DIR basename, present only on headroom's
   * own written files (see `headroom statusline`). */
  profile?: string;
  /** the external collector's own principal name for this profile, present only on
   * that shape. */
  alias?: string;
  observed_at: number; // epoch seconds
  five_hour: StatuslineBucket | null;
  seven_day: StatuslineBucket | null;
  /** Any other rate_limits key Claude Code exposed beyond five_hour/seven_day
   * (a model-scoped bucket, keyed by its own name), captured verbatim by
   * `headroom statusline` so this adapter can map it the same way claude.ts's
   * live probe maps a scoped `limits[]` entry. Always empty for the
   * external collector shape, which does not carry these. */
  extra: Record<string, StatuslineBucket>;
}

function readBucket(value: unknown): StatuslineBucket | undefined {
  if (!isObject(value)) return undefined;
  // Three field-name dialects accepted on purpose: Claude Code's own
  // statusLine payload uses `used_percentage`; a snapshot this adapter reads
  // back that `headroom statusline` wrote uses `used_percent`; the external collector's
  // existing on-disk shape uses `used_pct`. Never guess a fourth.
  const used = finiteNumber(value.used_percent) ?? finiteNumber(value.used_percentage) ?? finiteNumber(value.used_pct) ?? finiteNumber(value.percent);
  if (used === undefined) return undefined;
  // A malformed reset (the review's own `1e20` example) never invalidates the
  // whole bucket -- the used-percent reading is still real and useful -- but
  // it must not reach epochToIso/formatBucketTime as if it were a real date,
  // so it is validated before acceptance and dropped to "no reset known"
  // (the same documented fallback a bucket with no resets_at at all gets)
  // rather than accepted verbatim.
  const rawResets = finiteNumber(value.resets_at);
  const resets = rawResets !== undefined && validEpochSeconds(rawResets) ? rawResets : null;
  const active = typeof value.is_active === "boolean" ? value.is_active : undefined;
  return { used_percent: Math.min(100, Math.max(0, used)), resets_at: resets, ...(active === undefined ? {} : { is_active: active }) };
}

/** Parses either shape this adapter accepts: headroom's own `<profile>.json`
 * (a `profile` key, optional `extra`) or an external collector's `state/<alias>.json`
 * (a top-level `alias` key, epoch `observed_at`, no `extra`). Returns
 * undefined for anything unparseable or missing every bucket. */
export function parseStatuslineSnapshot(raw: string, now: Date = new Date()): StatuslineSnapshot | undefined {
  let root: unknown;
  try { root = JSON.parse(raw); } catch { return undefined; }
  if (!isObject(root)) return undefined;
  // Rejected before any field is even read: a document nested deeper than
  // any real payload this module produces or consumes needs is treated the
  // same as unparseable JSON, not walked.
  if (exceedsJsonDepth(root, MAX_SNAPSHOT_JSON_DEPTH)) return undefined;
  const observedAt = finiteNumber(root.observed_at);
  // A future-dated or out-of-Date-range observed_at is rejected here, at the
  // earliest possible point, rather than merely marked stale: a future
  // timestamp would otherwise always win latestStatuslineSnapshot's
  // newest-wins comparison and suppress a real reading indefinitely, and an
  // out-of-range one would crash formatting far downstream instead.
  if (observedAt === undefined || !validObservedAt(observedAt, now)) return undefined;
  const fiveHour = readBucket(root.five_hour) ?? null;
  const sevenDay = readBucket(root.seven_day) ?? null;
  const extra: Record<string, StatuslineBucket> = {};
  if (isObject(root.extra)) for (const [key, value] of Object.entries(root.extra)) {
    const bucket = readBucket(value);
    if (bucket) extra[key] = bucket;
  }
  if (!fiveHour && !sevenDay && !Object.keys(extra).length) return undefined;
  const profile = typeof root.profile === "string" ? root.profile : undefined;
  const alias = typeof root.alias === "string" ? root.alias : undefined;
  return { ...(profile ? { profile } : {}), ...(alias ? { alias } : {}), observed_at: observedAt, five_hour: fiveHour, seven_day: sevenDay, extra };
}

/**
 * Builds the snapshot `headroom statusline` writes to disk, from the raw
 * JSON object Claude Code hands its statusLine command on stdin. Reads
 * `rate_limits.five_hour` and `rate_limits.seven_day`, and captures every
 * other `rate_limits` key verbatim into `extra` -- Claude Code may expose
 * additional model-scoped buckets there (see claude.ts's own `scoped()` for
 * the equivalent live-probe mapping), and this is the only place that ever
 * sees the raw payload, so a key this adapter does not yet know the name of
 * is still preserved rather than silently dropped. Returns undefined when
 * the payload carries no `rate_limits` object at all, or none of its buckets
 * parse -- `headroom statusline` prints its bar regardless (from whatever it
 * could read directly off the payload) but does not write a useless file.
 */
export function snapshotFromStatuslinePayload(payload: unknown, profile: string, observedAt: Date): StatuslineSnapshot | undefined {
  if (!isObject(payload) || !isObject(payload.rate_limits)) return undefined;
  const fiveHour = readBucket(payload.rate_limits.five_hour) ?? null;
  const sevenDay = readBucket(payload.rate_limits.seven_day) ?? null;
  const extra: Record<string, StatuslineBucket> = {};
  for (const [key, value] of Object.entries(payload.rate_limits)) {
    if (key === "five_hour" || key === "seven_day") continue;
    const bucket = readBucket(value);
    if (bucket) extra[key] = bucket;
  }
  if (!fiveHour && !sevenDay && !Object.keys(extra).length) return undefined;
  return { profile, observed_at: Math.floor(observedAt.getTime() / 1000), five_hour: fiveHour, seven_day: sevenDay, extra };
}

/**
 * Every readable, trusted snapshot file directly under `dir` (non-recursive),
 * best effort: a missing directory is silently skipped (this is a
 * convenience source, not the source of truth, and most configured
 * principals don't use it), but a directory that exists and fails the trust
 * checks below is skipped with exactly one audit line to stderr instead of
 * being read at all -- it is never opened, symlinks and all. Every file
 * within a trusted directory is still read defensively (lstat'd, size-bound,
 * JSON-depth-bound): the directory being safe says nothing about a single
 * file dropped or replaced inside it after the fact.
 */
async function readSnapshotDirectory(dir: string, now: Date): Promise<Array<{ file: string; snapshot: StatuslineSnapshot }>> {
  try { await assertSafeReadableDirectory(dir); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // not configured, nothing to say
    console.error(`headroom: skipping unsafe statusline directory ${dir}: ${safeError(error)}`);
    return [];
  }
  let entries: string[];
  try { entries = (await readdir(dir)).filter((name) => name.endsWith(".json")).slice(0, MAX_SNAPSHOT_FILES_PER_DIR); }
  catch { return []; }
  const results: Array<{ file: string; snapshot: StatuslineSnapshot }> = [];
  for (const name of entries) {
    try {
      const snapshot = parseStatuslineSnapshot(await readBoundedRegularFile(join(dir, name)), now);
      if (snapshot) results.push({ file: name, snapshot });
    } catch { /* unsafe or unparseable file: skip it, not fatal */ }
  }
  return results;
}

/**
 * Matches one snapshot to a configured Claude principal. Headroom's own
 * shape matches by filename identity (statuslineProfile(account.location)),
 * always exact since headroom wrote the file itself. The external collector shape
 * matches by its `alias` field: first against accounts.toml's own `alias`
 * (explicit, always wins), then against the convention the external collector itself
 * uses today -- alias "main" for the default `~/.claude` profile, any other
 * alias against the same profile-basename rule headroom's own shape uses.
 */
function matchAccount(snapshot: StatuslineSnapshot, accounts: ProviderAccount[]): ProviderAccount | undefined {
  if (snapshot.profile !== undefined) return accounts.find((account) => statuslineProfile(account.location) === snapshot.profile);
  if (snapshot.alias === undefined) return undefined;
  const explicit = accounts.find((account) => account.alias === snapshot.alias);
  if (explicit) return explicit;
  if (snapshot.alias === "main") return accounts.find((account) => statuslineProfile(account.location) === "default");
  return accounts.find((account) => statuslineProfile(account.location) === snapshot.alias);
}

/** Never throws: readBucket above already refuses an out-of-range resets_at
 * before it reaches a bucket, but this stays defensive in its own right so a
 * conversion failure here contains itself instead of aborting the caller. */
function epochToIso(seconds: number | null): string | null {
  if (seconds === null || !validEpochSeconds(seconds)) return null;
  try { return new Date(seconds * 1000).toISOString(); } catch { return null; }
}

/** Same containment as epochToIso, for an observed_at that (by construction,
 * via validObservedAt above) should always already be valid by the time it
 * gets here -- kept defensive rather than trusting that invariant blindly. */
function safeObservedAtIso(seconds: number, fallback: Date): string {
  if (!validEpochSeconds(seconds)) return fallback.toISOString();
  try { return new Date(seconds * 1000).toISOString(); } catch { return fallback.toISOString(); }
}

/**
 * Headroom's own meter name for one `rate_limits` key beyond the two
 * account-wide buckets: the vendor's named model-scoped caps keep their
 * short, stable names (`fable`, `routines`) whatever wording the payload
 * spells them with, and anything else is slugged. Shared by the observation
 * mapping below and by the rendered status line, so a scoped bucket is
 * called the same thing wherever it appears. Returns "" for a key with no
 * usable characters at all; the caller skips those.
 */
export function statuslineMeterName(key: string): string {
  const lower = key.toLowerCase();
  if (lower.includes("fable")) return "fable";
  if (lower.includes("routine") || lower.includes("cowork")) return "routines";
  return lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function bucketObservation(principal: string, meter: string, bucket: StatuslineBucket, minutes: number, observedAtIso: string, fetchedAtIso: string, freshness: "fresh" | "stale"): Observation {
  const active = bucket.is_active !== false;
  return {
    principal_id: principal, meter_id: `${principal}:${meter}`,
    window: { kind: bucket.resets_at ? "fixed" : "rolling", minutes, enforcement: active ? "hard" : "soft" },
    quantity: { used: bucket.used_percent, limit: 100, remaining: Math.max(0, 100 - bucket.used_percent), unit: "percent" },
    resets_at: epochToIso(bucket.resets_at), observed_at: observedAtIso, fetched_at: fetchedAtIso,
    source: STATUSLINE_SOURCE, truth: "official", freshness, confidence: freshness === "fresh" ? 1 : 0.5,
    adapter_version: "native-ts", upstream_schema_version: "v0.56.4",
    ...(active ? {} : { reason: "vendor flags this limit inactive; shown because it carries a cap", metadata: { vendor_active: false } }),
  };
}

/** All-meter (five_hour/seven_day) plus any extra scoped-bucket observations
 * from one snapshot, dated by the snapshot's own observed_at (never by "now")
 * so a caller can see how old the underlying reading really is. `fetchedAt`
 * is when Headroom itself read the file, separate from when Claude Code
 * rendered the statusline that produced it. */
export function observationsFromStatuslineSnapshot(snapshot: StatuslineSnapshot, principal: string, fetchedAt: Date, freshMinutes = STATUSLINE_FRESH_MINUTES): Observation[] {
  const observedAtIso = safeObservedAtIso(snapshot.observed_at, fetchedAt);
  const ageMinutes = (fetchedAt.getTime() - snapshot.observed_at * 1000) / 60_000;
  const freshness: "fresh" | "stale" = ageMinutes <= freshMinutes ? "fresh" : "stale";
  const fetchedAtIso = fetchedAt.toISOString();
  const output: Observation[] = [];
  if (snapshot.five_hour) output.push(bucketObservation(principal, "all", snapshot.five_hour, 300, observedAtIso, fetchedAtIso, freshness));
  if (snapshot.seven_day) output.push(bucketObservation(principal, "all", snapshot.seven_day, 10_080, observedAtIso, fetchedAtIso, freshness));
  for (const [key, bucket] of Object.entries(snapshot.extra)) {
    const meter = statuslineMeterName(key);
    if (!meter) continue;
    output.push(bucketObservation(principal, meter, bucket, 10_080, observedAtIso, fetchedAtIso, freshness));
  }
  return output;
}

/**
 * The freshest usable snapshot for one Claude principal across every
 * configured directory (headroom's own `<profile>.json`, plus any
 * collector-shaped file matched by alias). Returns undefined when no
 * directory has a matching, parseable file at all -- the caller (collector.ts)
 * then falls through to the probe unconditionally. A snapshot older than
 * `freshMinutes` is still returned (so a caller can report a specific age
 * instead of a bare "no reading"), just flagged `freshness: "stale"` by
 * observationsFromStatuslineSnapshot above. `now` (defaulting to the real
 * current time) is also the clock-skew reference for rejecting a future-dated
 * `observed_at` -- see parseStatuslineSnapshot -- so a future timestamp can
 * never win this comparison and permanently shadow a real reading.
 */
export async function latestStatuslineSnapshot(dirs: string[], account: ProviderAccount, accounts: ProviderAccount[], now: Date = new Date()): Promise<StatuslineSnapshot | undefined> {
  let best: StatuslineSnapshot | undefined;
  for (const dir of dirs) {
    for (const { snapshot } of await readSnapshotDirectory(dir, now)) {
      if (matchAccount(snapshot, accounts)?.name !== account.name) continue;
      if (!best || snapshot.observed_at > best.observed_at) best = snapshot;
    }
  }
  return best;
}

/** The collector's own entry point: a snapshot for this principal that is
 * actually fresh right now, or undefined -- covering "no snapshot at all"
 * and "a snapshot exists but is stale" alike, since the collector treats
 * both the same way (fall through to the probe). */
export async function freshStatuslineSnapshot(dirs: string[], account: ProviderAccount, accounts: ProviderAccount[], now: Date, freshMinutes = STATUSLINE_FRESH_MINUTES): Promise<StatuslineSnapshot | undefined> {
  const snapshot = await latestStatuslineSnapshot(dirs, account, accounts, now);
  if (!snapshot) return undefined;
  const ageMinutes = (now.getTime() - snapshot.observed_at * 1000) / 60_000;
  return ageMinutes <= freshMinutes ? snapshot : undefined;
}

/** HH:MM for a reset today, "<weekday> HH:MM" otherwise -- local time,
 * matching cli.ts's own same-day-vs-not split for reset timestamps. The
 * documented fallback ("?") for an unknown reset also covers a malformed one
 * (the review's own `1e20` example): readBucket already refuses such a
 * resets_at before it reaches a bucket, but this stays defensive in its own
 * right, since this is also the one place that must never throw on the way
 * to `headroom statusline`'s printed line -- an uncaught "Invalid time
 * value" here would blank the user's prompt bar entirely. */
function formatBucketTime(resetsAtSeconds: number | null, now: Date): string {
  if (resetsAtSeconds === null || !validEpochSeconds(resetsAtSeconds)) return "?";
  try {
    const date = new Date(resetsAtSeconds * 1000);
    const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    if (date.toDateString() === now.toDateString()) return time;
    return `${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)} ${time}`;
  } catch { return "?"; }
}

/**
 * The one-line bar `headroom statusline` prints for Claude Code's status bar
 * itself, e.g. `5h 37% ↻13:19 | wk 17% ↻Sat 14:00`. Never throws and never
 * prints nothing -- a statusLine command that fails to print breaks the
 * user's prompt, so an unreadable payload still gets one honest line.
 */
export function formatStatuslineBar(snapshot: StatuslineSnapshot | undefined, now = new Date()): string {
  const parts: string[] = [];
  if (snapshot?.five_hour) parts.push(`5h ${Math.round(snapshot.five_hour.used_percent)}% ↻${formatBucketTime(snapshot.five_hour.resets_at, now)}`);
  if (snapshot?.seven_day) parts.push(`wk ${Math.round(snapshot.seven_day.used_percent)}% ↻${formatBucketTime(snapshot.seven_day.resets_at, now)}`);
  return parts.length ? parts.join(" | ") : "headroom: no rate limit data on this statusline payload";
}
