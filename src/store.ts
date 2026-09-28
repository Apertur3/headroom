import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { assertSafeAncestry, headroomHome, migrateLegacyHome } from "./paths.js";
import { decodeResetSeen, encodeResetSeen } from "./resets.js";
import type { EventKind, Heartbeat, KnownModel, LastKnownReading, Lease, NotifyDelivery, Observation, SpendRow, StoredObservation, Timer, HeadroomEvent } from "./types.js";
import { IDLE_WINDOW_REASON, idleContradictionReason, isInferredFailureReason, normalizeObservations } from "./engine/observation.js";
import { appendDaemonLog } from "./logs.js";
import { defaultPolicy, paceDecision } from "./policy.js";
import type { BurnInfo } from "./pace.js";
import { leastSquaresBurnPerHour, emptyInSeconds } from "./pace.js";
import { attributeSpend, summarizeLearnedCost, type LearnedCost } from "./cost.js";
import { CURRENT_SCHEMA_VERSION, HEARTBEATS_SCHEMA_VERSION, NewerSchemaError, runMigrations, schemaVersion, TIMER_DELIVERY_SCHEMA_VERSION } from "./migrations.js";
import { isReservedSessionId, redact, serializeInboxEnvelope, SAFE_READ_MAX_BYTES, SESSION_ID_PATTERN, TIMER_DELIVERY_FROM, TIMER_DELIVERY_KIND } from "./security.js";
import { creditSource, creditsLapsed, isCreditsObservation, usableCredits, type BankedCreditSource } from "./credits.js";

/** Applies redact() to every string leaf of a value, so a metadata object
 * carrying a leaked secret in one of its string fields is scrubbed the same
 * way a plain error string would be. */
/** How long an attributed spend row is kept before it is pruned on the next
 * write. Long enough to cover a weekly window several times over, short
 * enough that the table stays a working set rather than an archive. */
export const SPEND_LEDGER_RETENTION_DAYS = 30;

/** How long an unscheduled reset (issue #20) stays called out: the status
 * row's "(unscheduled)" note, the grouped view's own line, and gate/plan/
 * fill's `notices` all share this one window, so a human and an
 * orchestrator agree on how long "recent" means. */
export const UNSCHEDULED_RESET_HOURS = 24;

/** How many delivery attempts a timer gets (src/heartbeat.ts's fireDueTimers,
 * via store.ts's claimTimer/unclaimTimer) before it is marked permanently
 * failed instead of retried on every future maintenance pass forever. An
 * undeliverable timer is almost always a static defect (an owner whose
 * inbox directory can never be created, a filesystem permission problem) --
 * a handful of tries make sure a merely transient failure still gets
 * delivered, without turning a permanent one into an unbounded retry loop. */
export const MAX_TIMER_DELIVERY_ATTEMPTS = 5;

/** How long a timer's delivery claim (`claimTimer`'s `claimed_at`) is
 * honored before `dueTimers()`/`claimTimer()` treat it as abandoned and
 * offer the row up for another attempt. Covers a delivery that hangs
 * without crashing the process outright (a stuck filesystem call); a crash
 * or restart is instead recovered immediately and unconditionally by
 * `reclaimStaleTimerClaims()` on daemon start, which does not wait out this
 * window at all. Generous relative to a local filesystem write (which
 * normally resolves in well under a second) while still being short enough
 * that a genuine hang self-heals within one polling cycle. */
export const TIMER_CLAIM_STALE_MS = 2 * 60_000;

/** Bounds for `setTimer`'s random per-registration `delivery_id`: always
 * exactly 15 decimal digits (the max `inbox.ts`'s own filename pattern
 * allows -- the range width is `node:crypto`'s own `randomInt` ceiling,
 * 2^48 - 1, so it cannot span the full 15-digit space, but every value
 * drawn still falls between 1.0e14 and 3.8e14 and is always 15 digits long),
 * so two things stay true regardless of the actual value drawn -- it can
 * never numerically collide with a millisecond-based ordinary hand-off
 * filename by construction narrowing (deliberately not relied on alone;
 * `sendInboxMessageAt` still verifies identity by content, see its own doc
 * comment), and its string length is fixed, which is what makes
 * `setTimer`'s pre-write size check byte-exact against the real envelope
 * `src/heartbeat.ts`'s fireDueTimers will eventually serialize. */
const TIMER_DELIVERY_ID_MIN = 100_000_000_000_000;
const TIMER_DELIVERY_ID_MAX = TIMER_DELIVERY_ID_MIN + 281_474_976_710_655; // node:crypto randomInt's own max range width (2^48 - 1)

function generateTimerDeliveryId(): number {
  return randomInt(TIMER_DELIVERY_ID_MIN, TIMER_DELIVERY_ID_MAX);
}

/** What `claimTimer()` hands back: a `Timer` plus the one-time token proving
 * this exact claim (required by `confirmTimerDelivered`/`releaseTimerClaim`)
 * and the row's own `delivery_id` (required by `sendInboxMessageAt` to
 * deliver it). Deliberately not part of the public `Timer` shape (never
 * returned by `timers()`/`dueTimers()`'s own JSON-facing reads) -- these are
 * internal delivery-in-progress/identity details, not something a `timer
 * list` consumer needs. */
export interface ClaimedTimer extends Timer { claim_token: string; delivery_id: number }

/** True when `newUsed` is far enough below `oldUsed` to be a reset rather
 * than ordinary noise: a drop to zero, or a fall past half of what it was.
 * classifyUsageDrop uses this to recognize a reset from raw usage alone
 * (before it even looks at resets_at); burnRateFor reuses the exact same
 * rule so a burn-rate sample window and the event log this produces never
 * disagree on where a reset falls. */
function isUsageReset(oldUsed: number, newUsed: number): boolean {
  return oldUsed > 0 && (newUsed === 0 || newUsed < oldUsed * 0.5);
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item)]));
  return value;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}
type DatabaseConstructor = new (path: string, options?: { readOnly?: boolean }) => Database;
// Node 26 ships SQLite. createRequire keeps Vitest/Vite from trying to resolve
// this built-in as a browser module while preserving a dependency-free runtime.
const DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: DatabaseConstructor }).DatabaseSync;

type Row = Record<string, unknown>;

const NOTIFY_DISCOVERY_READY = "notify_discovery_ready";
const UNDISCOVERED_EVENT = "COALESCE(json_extract(metadata_json, '$._notify_seen'), 0) = 0";

/** A vendor window change is not trusted until the next poll agrees. The
 * marker deliberately lives in daemon_state rather than memory: a daemon
 * restart in the ordinary poll interval must not turn the second reading back
 * into a first reading. */
interface VendorWindowSuspect {
  baseline_id: number;
  suspect_id: number;
  baseline_resets_at: string | null;
  suspect_resets_at: string | null;
}

type VendorWindowTransition =
  | { kind: "normal" }
  | { kind: "idle" }
  | { kind: "repeat" }
  | { kind: "idle-confirmed"; suspect: VendorWindowSuspect }
  | { kind: "activation" }
  | { kind: "rollover"; baseline: StoredObservation }
  | { kind: "suspect"; baseline: StoredObservation }
  | { kind: "accepted"; suspect: VendorWindowSuspect }
  | { kind: "flip"; suspect: VendorWindowSuspect };

function number(value: unknown): number | null { return typeof value === "number" ? value : value === null ? null : Number(value); }
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }

export async function safeHeadroomDirectory(home = headroomHome()): Promise<string> {
  if (home === headroomHome()) await migrateLegacyHome();
  const requested = resolve(home);
  await assertSafeAncestry(dirname(requested));
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing unsafe ~/.headroom directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing ~/.headroom owned by another user");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Refusing ~/.headroom with group or world permissions; run: chmod 700 ~/.headroom");
  // lstat above proves the Headroom-owned leaf is not a link. realpath still
  // canonicalizes system aliases such as /var → /private/var on macOS.
  return realpath(requested);
}

async function safeDatabasePath(home?: string): Promise<string> {
  const directory = await safeHeadroomDirectory(home);
  const path = join(directory, "headroom.db");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Refusing unsafe Headroom database file");
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing Headroom database owned by another user");
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Refusing Headroom database with group or world permissions");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

/** Return an owned legacy database only; never follow a file planted beside the
 * current store. The caller removes it only after a successful merge. */
async function legacyDatabasePath(directory: string): Promise<string | undefined> {
  const path = join(directory, ["ta", "lly.db"].join(""));
  try {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Refusing unsafe legacy database file");
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing legacy database owned by another user");
        if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Refusing legacy database with group or world permissions");
      } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await lstat(path);
    return path;
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function json(value: unknown): string | null { return value === undefined ? null : JSON.stringify(value); }
function parseJson<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } }

export function canonicalWindow(window: Observation["window"] | undefined | null): Observation["window"] | null {
  if (!window) return null;
  return {
    kind: window.kind,
    minutes: window.minutes ?? null,
    enforcement: window.enforcement,
  };
}

export function canonicalWindowJson(window: Observation["window"] | undefined | null): string | null {
  const canonical = canonicalWindow(window);
  return canonical ? JSON.stringify(canonical) : null;
}

export function sameSemanticWindow(
  a: Observation["window"] | undefined | null,
  b: Observation["window"] | undefined | null
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && (a.minutes ?? null) === (b.minutes ?? null) && a.enforcement === b.enforcement;
}

/** The durable facts notification hysteresis needs for one source outage.
 * `last_seen_at` advances only when the collector persisted another failed
 * observation for this exact store event. */
export interface SourceHealthOutage {
  event_id: string;
  meter_id: string;
  window: Observation["window"];
  created_at: string;
  last_seen_at: string;
}

export function windowSqlMatch(
  window: Observation["window"] | undefined | null,
  column = "window_json"
): { sql: string; params: unknown[] } {
  if (!window) {
    return {
      sql: `(${column} IS NULL OR ${column} = 'null')`,
      params: [],
    };
  }
  return {
    sql: `(${column} IS NOT NULL AND ${column} <> 'null' AND json_extract(${column}, '$.kind') = ? AND CAST(json_extract(${column}, '$.minutes') AS INTEGER) IS ? AND json_extract(${column}, '$.enforcement') = ?)`,
    params: [window.kind, window.minutes ?? null, window.enforcement],
  };
}

function observationFromRow(row: Row): StoredObservation {
  const quantity = row.quantity_json ? parseJson<Observation["quantity"]>(row.quantity_json, null) : null;
  const rawWindow = row.window_json ? parseJson<Observation["window"]>(row.window_json, null) : null;
  const window = canonicalWindow(rawWindow);
  return {
    id: Number(row.id), principal_id: String(row.principal_id), meter_id: String(row.meter_id), window, quantity,
    resets_at: string(row.resets_at), observed_at: String(row.observed_at), fetched_at: String(row.fetched_at),
    source: String(row.source), truth: row.truth as Observation["truth"], freshness: row.freshness as Observation["freshness"],
    confidence: Number(row.confidence), adapter_version: String(row.adapter_version), upstream_schema_version: String(row.upstream_schema_version),
    reason: string(row.reason), metadata: parseJson<Observation["metadata"]>(row.metadata_json, undefined),
  };
}

function eventFromRow(row: Row): HeadroomEvent {
  const metadata = row.metadata_json ? parseJson<(HeadroomEvent["metadata"] & { _notify_seen?: number }) | undefined>(row.metadata_json, undefined) : undefined;
  if (metadata) delete metadata._notify_seen;
  return { id: String(row.id), kind: row.kind as EventKind, origin: row.origin as HeadroomEvent["origin"], confidence: Number(row.confidence), evidence_observation_ids: parseJson<number[]>(row.evidence_observation_ids, []), created_at: String(row.created_at), corrected_by: string(row.corrected_by), meter_id: string(row.meter_id), principal_id: string(row.principal_id), reason: string(row.reason), last_seen_at: string(row.last_seen_at), metadata: metadata && Object.keys(metadata).length ? metadata : undefined };
}

function knownModelFromRow(row: Row): KnownModel {
  return { principal_id: String(row.principal_id), vendor: String(row.vendor), model_id: String(row.model_id), model_name: string(row.model_name), first_seen_at: String(row.first_seen_at), last_seen_at: String(row.last_seen_at), retired_at: string(row.retired_at) };
}

function notifyFromRow(row: Row): NotifyDelivery {
  return { id: Number(row.id), event_id: String(row.event_id), channel: String(row.channel), status: row.status as NotifyDelivery["status"], attempts: Number(row.attempts), text: String(row.text), detail: string(row.detail), created_at: String(row.created_at), updated_at: String(row.updated_at) };
}

export interface PlanDowngrade {
  principal: string;
  from: string;
  to: string;
  since: string;
  acknowledged: boolean;
}

/** The compact, deliberately vendor-neutral shape used by `headroom credits`.
 * The raw observation is still available from history/status for audit detail. */
export interface CreditBalance {
  principal: string;
  meter: string;
  available: number;
  expires_at: string | null;
  source: BankedCreditSource;
  lapsed: boolean;
}

function leaseFromRow(row: Row): Lease {
  return { id: String(row.id), owner: String(row.owner), meter_id: String(row.meter_id), expected_percent: number(row.expected_percent), note: displayLeaseNote(string(row.note)), action_class: string(row.action_class), started_at: String(row.started_at), expires_at: String(row.expires_at), ended_at: string(row.ended_at), ended_reason: string(row.ended_reason), spent_percent: Number(row.spent_percent ?? 0) };
}

function heartbeatFromRow(row: Row): Heartbeat {
  return { owner: String(row.owner), interval_ms: Number(row.interval_ms), resume_sentence: string(row.resume_sentence), started_at: String(row.started_at), last_beat_at: String(row.last_beat_at), lapsed_since: string(row.lapsed_since), updated_at: String(row.updated_at) };
}

function timerFromRow(row: Row): Timer {
  return { owner: String(row.owner), name: String(row.name), at: String(row.at), action: String(row.action), if_missed: row.if_missed === "drop" ? "drop" : "notify", created_at: String(row.created_at), fired_at: string(row.fired_at), cleared_at: string(row.cleared_at), attempts: typeof row.attempts === "number" ? row.attempts : 0, failed_at: string(row.failed_at) };
}

const ATOMIC_LEASE_GROUP_PREFIX = "headroom:atomic:";

/** An atomic multi-meter admission remains compatible with the original
 * single `leased_id`: every member stores the same opaque marker in note, so
 * ending the primary id ends its siblings too. The marker stays internal to
 * the SQLite row; normal CLI/MCP Lease objects expose only the caller note. */
function atomicLeaseGroupNote(groupId: string, note: string | null): string {
  return `${ATOMIC_LEASE_GROUP_PREFIX}${groupId}|${note ?? ""}`;
}

function atomicLeaseGroup(note: string | null): string | undefined {
  if (!note?.startsWith(ATOMIC_LEASE_GROUP_PREFIX)) return undefined;
  const separator = note.indexOf("|", ATOMIC_LEASE_GROUP_PREFIX.length);
  const id = separator < 0 ? "" : note.slice(ATOMIC_LEASE_GROUP_PREFIX.length, separator);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

function displayLeaseNote(note: string | null): string | null {
  return atomicLeaseGroup(note) ? (note?.slice(note.indexOf("|") + 1) || null) : note;
}

export class HeadroomStore {
  private constructor(private readonly db: Database, private readonly dbPath: string) {}

  /**
   * Every read/write method below goes through this instead of calling
   * `this.db.prepare(sql)` directly, keyed by the exact SQL text: SQLite's
   * own prepare step (parsing + query planning) is real, measurable CPU
   * cost, and a single `insert()` call prepares roughly a dozen statements
   * -- all of them the same handful of SQL strings, over and over, since
   * this is one JS thread on one DatabaseSync connection and every caller
   * already re-binds its own parameters on each call. Re-preparing them
   * fresh on every observation was the dominant cost behind a poll's own
   * synchronous writes running long enough to occasionally block a
   * concurrent `health` reply past its 2s budget (measured ~3.4x the wall
   * time of an equivalent poll over 1000 observations; see this repo's
   * cached-reads work). A handful of call sites build genuinely dynamic SQL
   * text (a `WHERE id IN (?,?,...)` list sized to its caller's argument
   * count) -- those still cache correctly, just with one entry per distinct
   * list length, which stays small and bounded by this project's own scale
   * (meters, leases, or ids per batch -- never an unbounded stream), so the
   * cache is never cleared or capped.
   */
  private readonly statements = new Map<string, ReturnType<Database["prepare"]>>();
  private prepared(sql: string): ReturnType<Database["prepare"]> {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  static async open(home?: string): Promise<HeadroomStore> {
    const path = await safeDatabasePath(home);
    // DatabaseSync creates a missing file with the process umask. Pre-create it
    // with an explicit mode so concurrent direct readers cannot observe a 0644
    // database between creation and the chmod below.
    const descriptor = await open(path, "a", 0o600);
    await descriptor.close();
    const db = new DatabaseSync(path);
    // Checked before anything else touches the connection: a database a
    // newer Headroom wrote is refused outright, with no PRAGMA, no journal
    // mode change, no migration -- nothing here ever writes to a shape this
    // binary does not understand.
    const version = schemaVersion(db);
    if (version > CURRENT_SCHEMA_VERSION) {
      db.close();
      throw new NewerSchemaError(version, CURRENT_SCHEMA_VERSION);
    }
    const store = new HeadroomStore(db, path);
    // Direct CLI reads may briefly overlap the daemon. WAL permits readers with
    // its writer; the busy timeout turns a short writer handoff into a wait,
    // rather than an immediate "database is locked" failure.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    await store.migrate(resolve(path, ".."));
    const legacy = await legacyDatabasePath(resolve(path, ".."));
    if (legacy) await store.mergePriorDatabase(legacy, resolve(path, ".."));
    store.normalizeExhaustedReportExpiry();
    if (process.platform !== "win32") for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try { await chmod(candidate, 0o600); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return store;
  }

  /**
   * Read-only, non-migrating open for compatibility lookups only (currently
   * status-normalization.ts's older-daemon path). `open()` always runs schema
   * migrations and data repairs (migrate(), mergePriorDatabase(),
   * normalizeExhaustedReportExpiry(), even the WAL journal-mode PRAGMA) --
   * fine for the daemon or a CLI that owns the database, but a newer CLI
   * reading alongside an OLDER daemon that is still running against this
   * file must never upgrade its schema out from under it. This connection
   * skips every one of those steps and SQLite itself refuses any write
   * against it. It never creates a missing file either: same as any other
   * read-only failure, a caller here must fail closed rather than fall back
   * to a writable open.
   */
  static async openReadOnly(home?: string): Promise<HeadroomStore> {
    const path = await safeDatabasePath(home);
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return new HeadroomStore(db, path);
  }

  close(): void { this.db.close(); }

  /** Upgrade old `{ until: null }` exhausted markers in place. The original
   * report implementation treated those as permanent, so do this at open
   * time as well as for newly created reports: status immediately shows the
   * expiry, even before any caller happens to run a dispatch check. */
  private normalizeExhaustedReportExpiry(now = new Date()): void {
    const rows = this.prepared("SELECT key, value FROM daemon_state WHERE key LIKE 'exhausted:%'").all();
    for (const row of rows) {
      const meterId = String(row.key).slice("exhausted:".length);
      let state: { active?: boolean; until?: string | null; note?: string | null; report_id?: string; binding_window_minutes?: number };
      try { state = JSON.parse(String(row.value)) as typeof state; } catch { continue; }
      if (state.active === false || (state.until && Number.isFinite(Date.parse(state.until)))) continue;
      const binding = this.latestPerWindow(meterId)
        .filter((item) => item.window?.minutes && item.quantity?.unit === "percent")
        .sort((left, right) => left.window!.minutes! - right.window!.minutes!)[0];
      const expiresAt = binding?.resets_at && Number.isFinite(Date.parse(binding.resets_at))
        ? new Date(binding.resets_at).toISOString()
        : new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
      this.prepared("UPDATE observations SET resets_at = ? WHERE meter_id = ? AND json_extract(metadata_json, '$.exhausted') = 1 AND COALESCE(json_extract(metadata_json, '$.exhausted_ignored'), 0) = 0")
        .run(expiresAt, meterId);
      this.setDaemonState(`exhausted:${meterId}`, JSON.stringify({ ...state, active: true, until: expiresAt, binding_window_minutes: state.binding_window_minutes ?? binding?.window?.minutes }));
    }
  }

  /** The schema version this open connection is on, read live from
   * `PRAGMA user_version` -- see migrations.ts. `headroom doctor` shows this
   * next to the binary's own CURRENT_SCHEMA_VERSION. */
  schemaVersion(): number { return schemaVersion(this.db); }

  /** A byte-for-byte copy of the database file, taken once before each
   * migration numbered above the baseline (never for the baseline itself --
   * see migrations.ts's runMigrations), named after the version being
   * upgraded FROM. If that file already exists -- a previous attempt backed
   * up and then failed partway through the migration itself -- it is left
   * alone rather than overwritten with a since-modified copy: the backup is
   * kept once, from the last known-good version. WAL is checkpointed first
   * so the single file this copies actually holds everything; without it, a
   * recent write could still be sitting in `-wal` only. */
  private async backupBeforeMigration(fromVersion: number): Promise<void> {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    try {
      await copyFile(this.dbPath, `${this.dbPath}.bak-${fromVersion}`, fsConstants.COPYFILE_EXCL);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  /** Preserve observation history from the transient post-rename legacy store,
   * then remove that duplicate only after the INSERT and audit succeed. */
  private async mergePriorDatabase(legacy: string, home: string): Promise<void> {
    const quoted = legacy.replaceAll("'", "''");
    this.db.exec(`ATTACH DATABASE '${quoted}' AS legacy`);
    let legacyCount = 0;
    let currentCount = 0;
    try {
      const table = this.prepared("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'observations'").get();
      currentCount = Number(this.prepared("SELECT COUNT(*) AS count FROM observations").get()?.count ?? 0);
      if (table) {
        legacyCount = Number(this.prepared("SELECT COUNT(*) AS count FROM legacy.observations").get()?.count ?? 0);
        if (legacyCount) this.db.exec(`INSERT INTO observations
          (principal_id,meter_id,window_json,quantity_json,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata_json)
          SELECT principal_id,meter_id,window_json,quantity_json,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata_json FROM legacy.observations`);
      }
      this.audit("migration", ["merge_legacy_", "ta", "lly_db"].join(""), null, `headroom.db observations=${currentCount}; ${["ta", "lly.db"].join("")} observations=${legacyCount}; merged=${legacyCount}`);
    } finally { this.db.exec("DETACH DATABASE legacy"); }
    for (const candidate of [legacy, `${legacy}-wal`, `${legacy}-shm`]) {
      try { await unlink(candidate); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await appendDaemonLog(`migration: merged ${["ta", "lly.db"].join("")} observations=${legacyCount} into headroom.db observations=${currentCount}; removed legacy database`, home);
  }

  private async migrate(home: string): Promise<void> {
    // Numbered, versioned schema migrations (table/column shape) -- see
    // migrations.ts. This is separate from the string-keyed data repairs
    // below, which predate schema versioning and stay exactly as they were.
    await runMigrations(this.db, (fromVersion) => this.backupBeforeMigration(fromVersion));
    this.removeFalseResetSeenEvents();
    await this.backfillResetEvents(home);
    await this.collapseDuplicateSourceFailedEvents(home);
  }

  /**
   * A principal that stays down produced one new source_failed event per poll
   * (16 in 24h for two failing principals, observed live). detectEvents now
   * updates last_seen_at on the open event instead of inserting a new one
   * while a failure continues; this one-time pass repairs history written
   * before that fix by collapsing consecutive source_failed events for the
   * same meter (not separated by a source_recovered) into the first one,
   * carrying its last_seen_at forward to the last duplicate's timestamp.
   */
  private async collapseDuplicateSourceFailedEvents(home: string): Promise<void> {
    const migration = "2026-09-05-collapse-source-failed-duplicates";
    if (this.prepared("SELECT id FROM schema_migrations WHERE id = ?").get(migration)) return;
    const rows = this.prepared("SELECT * FROM events WHERE kind IN ('source_failed', 'source_recovered') ORDER BY meter_id ASC, created_at ASC, id ASC").all();
    const openByMeter = new Map<string, Row>();
    let collapsed = 0;
    for (const row of rows) {
      const meterId = String(row.meter_id);
      if (row.kind === "source_recovered") { openByMeter.delete(meterId); continue; }
      const open = openByMeter.get(meterId);
      if (open) {
        this.prepared("UPDATE events SET last_seen_at = ? WHERE id = ?").run(String(row.created_at), String(open.id));
        this.prepared("DELETE FROM events WHERE id = ?").run(String(row.id));
        collapsed += 1;
      } else {
        openByMeter.set(meterId, row);
      }
    }
    const summary = `collapsed ${collapsed} duplicate source_failed events across ${rows.length} candidates`;
    this.audit("migration", "collapse_source_failed_duplicates", null, summary);
    this.prepared("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?,?)").run(migration, new Date().toISOString());
    await appendDaemonLog(summary, home);
  }

  /** Remove the transient reset labels caused by rolling zero-use windows whose
   * provider-derived reset timestamp advances on every poll. This deliberately
   * inspects its event evidence rather than trusting the old event confidence. */
  private removeFalseResetSeenEvents(): void {
    const migration = "2026-09-03-reset-seen-usage-drop";
    if (this.prepared("SELECT id FROM schema_migrations WHERE id = ?").get(migration)) return;
    const since = "2026-09-03T21:00:00.000Z";
    const candidates = this.prepared("SELECT * FROM events WHERE kind = 'reset_seen' AND origin = 'inferred' AND created_at >= ?").all(since);
    let removed = 0;
    for (const row of candidates) {
      const event = eventFromRow(row);
      const evidence = event.evidence_observation_ids.map((id) => this.prepared("SELECT * FROM observations WHERE id = ?").get(id)).filter((item): item is Row => Boolean(item)).map(observationFromRow);
      const previous = evidence[0];
      const current = evidence[1];
      const usageDropped = previous?.freshness === "fresh" && current?.freshness === "fresh"
        && previous.quantity?.used !== undefined && current.quantity?.used !== undefined
        && previous.quantity.used > 0 && (current.quantity.used === 0 || current.quantity.used < previous.quantity.used * 0.5);
      if (usageDropped) continue;
      this.prepared("DELETE FROM events WHERE id = ?").run(event.id);
      this.audit("migration", "remove_false_reset_seen", event.meter_id, `${event.id}: no usage drop`);
      removed += 1;
    }
    this.audit("migration", "remove_false_reset_seen_summary", null, `removed ${removed} inferred reset_seen events since ${since}`);
    this.prepared("INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)").run(migration, new Date().toISOString());
  }

  /** Re-evaluate the last 7 days of observations per meter and window with the
   * current baseline and classification rules, so a principal that failed
   * across a real reset or a free reset still gets its event, even though the
   * original poll-time comparison only ever looked at the immediately prior
   * row. Also deletes reset evidence wrongly attributed to local pools, which
   * have no vendor reset schedule and must never carry reset events. Runs once. */
  private async backfillResetEvents(home: string): Promise<void> {
    const migration = "2026-09-04-reset-detection-backfill";
    if (this.prepared("SELECT id FROM schema_migrations WHERE id = ?").get(migration)) return;
    const localEvents = this.prepared(`SELECT DISTINCT e.id AS id FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.kind IN ('reset_seen', 'free_reset_used') AND json_extract(o.window_json, '$.kind') = 'state'`).all();
    for (const row of localEvents) this.prepared("DELETE FROM events WHERE id = ?").run(String(row.id));

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = this.prepared("SELECT * FROM observations WHERE freshness = 'fresh' AND fetched_at >= ? ORDER BY fetched_at ASC, id ASC").all(since);
    const beforeCount = Number(this.prepared("SELECT COUNT(*) AS count FROM events WHERE kind IN ('reset_seen', 'free_reset_used')").get()?.count ?? 0);
    for (const row of rows) {
      const current = observationFromRow(row);
      const baseline = this.freshBaseline(current);
      if (baseline) this.classifyUsageDrop(baseline, current);
    }
    const afterCount = Number(this.prepared("SELECT COUNT(*) AS count FROM events WHERE kind IN ('reset_seen', 'free_reset_used')").get()?.count ?? 0);
    const summary = `reset detection backfill: reprocessed ${rows.length} fresh observations since ${since}; removed ${localEvents.length} local-pool reset events; inserted ${afterCount - beforeCount} reset events`;
    this.audit("migration", "backfill_reset_events", null, summary);
    // Record completion before the only await in this method: two stores can
    // open the same database concurrently, and nothing may yield between the
    // "not yet run" check above and marking it run, or both would redo it and
    // the second commit would collide on the schema_migrations primary key.
    this.prepared("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?,?)").run(migration, new Date().toISOString());
    await appendDaemonLog(summary, home);
  }

  insert(observation: Observation): StoredObservation {
    // A log-derived fallback (Codex's session-log rate-limit reader, tagged
    // with a source ending in ":session-log") re-reads the same historical
    // event on every poll until a new one is logged. Once the store already
    // holds a reading at least as recent as that fixed, unchanging event for
    // this exact window, appending it again teaches nothing new and would
    // otherwise grow the table without bound -- worse, it plants a stale row
    // whose old fetched_at a plain "most recent" reader could still trip on
    // if a later poll's own fresh reading were ever missing.
    if (observation.window?.minutes && observation.source.endsWith(":session-log")) {
      const match = windowSqlMatch(observation.window);
      const existingRow = this.prepared(
        `SELECT * FROM observations WHERE meter_id = ? AND ${match.sql} ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      ).get(observation.meter_id, ...match.params);
      if (existingRow) {
        const existing = observationFromRow(existingRow);
        if (Date.parse(existing.fetched_at) >= Date.parse(observation.fetched_at)) return existing;
      }
    }
    const resolved = this.resolveIdleContradiction(observation);
    const newBucket = this.newBucketName(resolved);
    const previous = this.previous(resolved);
    let transition = this.vendorWindowTransition(resolved);
    // A current panel paste is an explicit human observation of the vendor's
    // own UI. If it reports at least as much consumption as the accepted
    // baseline, accepting it cannot create capacity, and holding it behind a
    // stale lower probe result hides the urgent condition it was pasted to
    // communicate. A lower paste with a different reset remains suspect and
    // therefore cannot reopen capacity on one unconfirmed reading.
    const pastedHighUsage = resolved.source === "paste" && resolved.freshness === "fresh"
      && resolved.quantity?.unit === "percent" && resolved.quantity.used !== undefined
      && (() => {
        const baseline = this.acceptedWindowBaseline(resolved);
        return baseline?.quantity?.unit === "percent" && baseline.quantity.used !== undefined
          && resolved.quantity.used >= baseline.quantity.used;
      })();
    if (pastedHighUsage) transition = { kind: "normal" };
    // Reasons and metadata come from vendor responses (or their diagnostics)
    // and are persisted; redact them the same way any other vendor-adjacent
    // output is redacted, so a token or cookie that leaked into a failure
    // reason or a metadata string never lands in the database either.
    const reason = resolved.reason ? redact(resolved.reason) : resolved.reason ?? null;
    const metadata = redactDeep(transition.kind === "suspect" || transition.kind === "repeat"
      ? { ...resolved.metadata, vendor_window_held: true }
      : transition.kind === "flip"
        ? { ...resolved.metadata, vendor_inconsistent: true }
        : resolved.metadata) as Observation["metadata"] | undefined;
    const result = this.prepared(`INSERT INTO observations
      (principal_id,meter_id,window_json,quantity_json,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      resolved.principal_id, resolved.meter_id, canonicalWindowJson(resolved.window), json(resolved.quantity), resolved.resets_at ?? null,
      resolved.observed_at ?? null, resolved.fetched_at ?? null, resolved.source, resolved.truth, resolved.freshness, resolved.confidence,
      resolved.adapter_version, resolved.upstream_schema_version, reason, json(metadata));
    const stored: StoredObservation = { ...resolved, window: canonicalWindow(resolved.window), reason, metadata, id: Number(result.lastInsertRowid) };
    if (pastedHighUsage) {
      // Drop a prior unresolved identity hold so the paste becomes the new
      // baseline. A subsequent old-identity poll will be held against this
      // higher reading instead of immediately restoring stale capacity.
      this.clearVendorWindowSuspect(stored);
    } else if (transition.kind === "suspect") {
      this.setVendorWindowSuspect(stored, transition.baseline);
    } else if (transition.kind === "flip") {
      this.markVendorInconsistent(transition.suspect.suspect_id);
      this.clearVendorWindowSuspect(stored);
      if (!this.recentVendorInconsistent(stored.meter_id, stored.fetched_at)) {
        this.addEvent("vendor_inconsistent", "vendor_reported", 1, [transition.suspect.suspect_id, stored.id], stored,
          "vendor readings flip-flopped between two windows; holding the earlier one");
      }
    } else if (transition.kind === "accepted" || transition.kind === "idle-confirmed") {
      this.clearVendorWindowSuspect(stored);
      this.clearVendorInconsistent(transition.suspect.suspect_id);
      const baseline = this.observationById(transition.suspect.baseline_id);
      const suspect = this.observationById(transition.suspect.suspect_id);
      if (baseline && suspect) this.classifyUsageDrop(baseline, suspect, suspect.fetched_at);
    } else if (transition.kind === "rollover" || transition.kind === "idle" || transition.kind === "activation") {
      this.clearVendorWindowSuspect(stored);
    }
    // This must run on the raw vendor observation before any read-side gate
    // can see it. A fresh, sub-100 binding-window reading with a new reset is
    // proof that the previous exhausted report belongs to an old window.
    this.clearExhaustedFromVendor(stored);
    if (newBucket) this.addEvent("model_new", "vendor_reported", 1, [stored.id], stored, newBucket);
    // A held reading is deliberately inert: reset/free-reset inference,
    // credit movement, spend and pace must all wait until the vendor has
    // supplied the same new window on the next ordinary poll.
    const held = transition.kind === "suspect" || transition.kind === "repeat" || transition.kind === "flip" || transition.kind === "accepted" || transition.kind === "idle-confirmed";
    const scheduledRolloverAt = transition.kind === "rollover" ? transition.baseline.resets_at ?? undefined : undefined;
    if (!held && previous) this.detectEvents(previous, stored, scheduledRolloverAt);
    else if (held && previous?.freshness === "failed" && stored.freshness === "fresh") {
      const inferred = isInferredFailureReason(previous.reason);
      this.addEvent("source_recovered", inferred ? "inferred" : "vendor_reported", inferred ? 0.8 : 1, [previous.id, stored.id], stored);
    }
    else if (stored.freshness === "failed") this.recordFailure([stored.id], stored);
    // The first reading ever stored under this exact meter id has no immediate
    // previous row, even though the legacy doubled-principal form of the same
    // meter does; the baseline lookup below checks that form on its own.
    else if (!held && stored.freshness === "fresh") { const baseline = this.freshBaseline(stored); if (baseline) this.classifyUsageDrop(baseline, stored, undefined, scheduledRolloverAt); }
    // Independent of the window-scoped previous()/detectEvents() path above:
    // a windowless failure is only ever closed by this separate check.
    if (stored.freshness === "fresh") this.recoverWindowlessFailure(stored);
    if (!held && previous) this.attributeLeaseSpend(previous, stored);
    if (!held && stored.freshness === "fresh") this.recordSpendLedger(stored);
    if (!held && stored.freshness === "fresh") this.detectPaceProjection(stored);
    return stored;
  }

  insertAll(observations: Observation[]): StoredObservation[] { return normalizeObservations(observations).map((observation) => this.insert(observation)); }

  /** Record a banked reset a human can see in a vendor UI but the adapter
   * cannot read (Claude currently exposes no corresponding usage field).
   * This is an ordinary synthetic observation rather than mutable state: a
   * later vendor fact wins naturally and every correction remains auditable. */
  recordManualCredits(principal: string, available: number, expiresAt: string | null, cleared = false, now = new Date()): StoredObservation {
    const at = now.toISOString();
    const observation: Observation = {
      principal_id: principal, meter_id: `${principal}:credits`,
      window: { kind: "count", minutes: null, enforcement: "hard" },
      quantity: { used: 0, limit: null, remaining: available, unit: "credits" }, resets_at: expiresAt,
      // A clear is a current, genuinely fresh fact -- "the operator's balance
      // is now zero" -- not a stale reading; `stale` means "this used to be
      // current but has aged past the threshold", which a just-recorded clear
      // never is. `metadata.manual_cleared` alone marks it for ranking
      // (a later manual entry supersedes it, but a later failed vendor read
      // does not hide it) and for excluding it from banked capacity; it keeps
      // the same observation shape a fresh entry has (see docs/json-contract.md).
      observed_at: at, fetched_at: at, source: "manual", truth: "estimated", freshness: "fresh", confidence: 0.9,
      adapter_version: "manual", upstream_schema_version: "manual",
      metadata: { free_resets_available: available, manual: true, ...(cleared ? { manual_cleared: true } : {}) },
    };
    // insert() normally compares against this exact count window and emits
    // the change event. The first manual fact has no predecessor, but it is
    // still a useful operator action to audit, so seed that one event here.
    const previous = this.previous(observation);
    const stored = this.insert(observation);
    if (!previous) this.addEvent("credits_changed", "inferred", 0.9, [stored.id], stored, cleared ? "manual credits cleared" : "manual credits entry");
    return stored;
  }

  /** Clearing is a zero-valued observation, not deletion. Preserve the
   * prior expiry where one exists so history still says which banked reset
   * the operator closed, even though its current usable count is zero. */
  clearManualCredits(principal: string, now = new Date()): StoredObservation {
    const existing = this.latestPerWindow(`${principal}:credits`).find(isCreditsObservation);
    return this.recordManualCredits(principal, 0, existing?.resets_at ?? null, true, now);
  }

  credits(now = new Date()): CreditBalance[] {
    return this.latestPerWindow().filter(isCreditsObservation).map((row) => ({
      principal: row.principal_id, meter: row.meter_id, available: usableCredits(row, now), expires_at: row.resets_at,
      source: creditSource(row), lapsed: creditsLapsed(row, now),
    })).sort((a, b) => a.meter.localeCompare(b.meter));
  }

  /** Record a complete vendor poll and retire windows omitted by that poll.
   * A later vendor response for the same duration supersedes the retirement.
   * A `not_enforced` row counts as present, not omitted: it is the adapter
   * explicitly reporting on that window this poll (a confirmed absent cap,
   * issue #55's "vendor sent no bucket for it", or Codex Spark's "vendor
   * sent no data for this meter in this response"), so it must not trigger
   * the same "vendor no longer reports this window" retirement a genuinely
   * omitted window would -- latestPerWindow's own ranking already lets that
   * not_enforced reading supersede an older fresh one for the same window. */
  insertPoll(observations: Observation[]): StoredObservation[] {
    // insert() runs several separate write statements per observation (the
    // row itself, plus whatever events/markers its transition produces), and
    // in SQLite's default autocommit mode each one is its own committed
    // transaction. With WAL's default synchronous=FULL that is one fsync per
    // statement -- fine individually, but a poll across several meters can
    // add up to dozens of them, and each is a blocking syscall on the
    // daemon's single event-loop thread. Under host disk pressure that was
    // measured stalling a concurrent `health` reply well past its 2s budget
    // (see docs/reports for the before/after). One transaction for the whole
    // poll turns that into a single commit, so the event loop is blocked for
    // one fsync's worth of time instead of one per write statement.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.insertAll(observations);
      const byMeter = new Map<string, StoredObservation[]>();
      for (const row of stored) if ((row.freshness === "fresh" || row.freshness === "not_enforced") && row.window?.minutes) byMeter.set(row.meter_id, [...(byMeter.get(row.meter_id) ?? []), row]);
      for (const [meter, rows] of byMeter) {
        // An incomplete vendor picture must not retire a sibling window while
        // this meter is already being held for inconsistent reset identities.
        if (rows.some((row) => this.vendorWindowSuspect(row))) continue;
        const present = new Set(rows.map((row) => row.window!.minutes));
        for (const old of this.latestPerWindow(meter)) {
          const minutes = old.window?.minutes;
          if (!minutes || present.has(minutes) || old.metadata?.retired) continue;
          const at = rows.reduce((latest, row) => Date.parse(row.fetched_at) > Date.parse(latest.fetched_at) ? row : latest);
          const { id: _id, ...oldObservation } = old;
          const retired = this.insert({ ...oldObservation, observed_at: at.observed_at, fetched_at: at.fetched_at, freshness: "stale", confidence: 1, reason: "vendor no longer reports this window", metadata: { ...old.metadata, retired: true } });
          this.addEvent("window_retired", "inferred", 0.9, [old.id, retired.id], retired, "vendor no longer reports this window");
        }
      }
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  reportExhausted(meterId: string, until: string | null, note: string | null, now = new Date()): void {
    const rows = this.latestPerWindow(meterId).filter((row) => row.window?.minutes && row.quantity?.unit === "percent");
    if (!rows.length) throw new Error(`no reported percent window for ${meterId}`);
    const requestedReset = until && Number.isFinite(Date.parse(until)) ? new Date(until).toISOString() : null;
    // A report is bound to the vendor window which owns its reset. When the
    // vendor message did not include one, bind to the shortest real window:
    // that is the first allowance a dispatch can actually exhaust.
    const ordered = [...rows].sort((a, b) => a.window!.minutes! - b.window!.minutes!);
    const binding = requestedReset
      ? ordered.find((row) => row.resets_at && new Date(row.resets_at).toISOString() === requestedReset) ?? ordered[0]!
      : ordered[0]!;
    const bindingReset = binding.resets_at && Number.isFinite(Date.parse(binding.resets_at)) ? new Date(binding.resets_at).toISOString() : null;
    // A missing reset must not turn a mistaken report into a permanent
    // refusal. Preserve the vendor's binding reset when we have it; otherwise
    // make the report explicitly expire in 24 hours.
    const expiresAt = requestedReset ?? bindingReset ?? new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const reportId = randomUUID();
    for (const row of rows) {
      const { id: _id, ...observation } = row;
      const current = this.insert({ ...observation, quantity: { ...row.quantity!, used: 100, remaining: 0 }, resets_at: expiresAt, observed_at: now.toISOString(), fetched_at: now.toISOString(), freshness: "fresh", confidence: 0.9, reason: "vendor reports the limit reached", metadata: { ...row.metadata, exhausted: true, exhausted_report_id: reportId } });
      this.addEvent("exhausted_reported", "inferred", 0.9, [current.id], current, note ?? "vendor reports the limit reached", null, undefined, { resets_at: current.resets_at ?? undefined });
    }
    this.setDaemonState(`exhausted:${meterId}`, JSON.stringify({ active: true, until: expiresAt, note, report_id: reportId, binding_window_minutes: binding.window!.minutes }));
  }

  /** Explicitly clear an exhausted report. Its synthetic observations remain
   * auditable, but are excluded from all current reads so a manual recovery
   * genuinely reopens dispatch rather than leaving a false 100% window. */
  recoverExhausted(meterId: string, note: string | null, now = new Date()): boolean {
    const state = this.exhaustedState(meterId);
    if (!state || state.active === false) return false;
    const current = this.latestPerWindow(meterId).find((row) => row.metadata?.exhausted && !row.metadata.exhausted_ignored);
    this.ignoreExhaustedRows(meterId, state.report_id);
    this.setDaemonState(`exhausted:${meterId}`, JSON.stringify({ ...state, active: false, cleared_at: now.toISOString(), cleared_note: note }));
    if (current) this.addEvent("exhausted_cleared", "inferred", 1, [current.id], current, note ?? "exhausted report cleared by operator", null, now.toISOString());
    return true;
  }

  private exhaustedState(meterId: string): { active?: boolean; until?: string | null; note?: string | null; report_id?: string; binding_window_minutes?: number } | undefined {
    const raw = this.daemonState(`exhausted:${meterId}`);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as { active?: boolean; until?: string | null; note?: string | null; report_id?: string; binding_window_minutes?: number }; }
    catch { return undefined; }
  }

  private ignoreExhaustedRows(meterId: string, reportId?: string): void {
    const rows = this.prepared("SELECT id, metadata_json FROM observations WHERE meter_id = ? AND json_extract(metadata_json, '$.exhausted') = 1").all(meterId);
    for (const row of rows) {
      const metadata = parseJson<Observation["metadata"]>(row.metadata_json, undefined);
      // Legacy reports had no id. They are safe to clear as a group because a
      // meter can only have one active exhausted marker at a time.
      if (reportId && metadata?.exhausted_report_id && metadata.exhausted_report_id !== reportId) continue;
      this.prepared("UPDATE observations SET metadata_json = ? WHERE id = ?").run(JSON.stringify({ ...metadata, exhausted_ignored: true }), row.id);
    }
  }

  private clearExhaustedFromVendor(current: StoredObservation): void {
    const state = this.exhaustedState(current.meter_id);
    if (!state || state.active === false || current.freshness !== "fresh" || current.quantity?.unit !== "percent" || !(current.quantity.used < 100)) return;
    if (state.binding_window_minutes !== current.window?.minutes || !state.until || !current.resets_at) return;
    const reportedReset = Date.parse(state.until);
    const vendorReset = Date.parse(current.resets_at);
    if (!Number.isFinite(reportedReset) || !Number.isFinite(vendorReset) || reportedReset === vendorReset) return;
    this.ignoreExhaustedRows(current.meter_id, state.report_id);
    this.setDaemonState(`exhausted:${current.meter_id}`, JSON.stringify({ ...state, active: false, cleared_at: current.fetched_at, cleared_by: "vendor" }));
    this.addEvent("exhausted_cleared", "vendor_reported", 1, [current.id], current, "fresh vendor reading superseded exhausted report", null, current.fetched_at);
  }

  dispatchBlockForMeter(meterId: string, now = new Date()): string | undefined {
    const state = this.exhaustedState(meterId);
    if (!state) return this.daemonState(`exhausted:${meterId}`) ? "vendor reports the limit reached" : undefined;
    if (state.active === false) return undefined;
    const until = state.until ? Date.parse(state.until) : Number.NaN;
    if (Number.isFinite(until) && until <= now.getTime()) {
      this.ignoreExhaustedRows(meterId, state.report_id);
      this.setDaemonState(`exhausted:${meterId}`, JSON.stringify({ ...state, active: false, expired_at: now.toISOString() }));
      return undefined;
    }
    return `vendor reports the limit reached${state.until ? `; resets ${state.until}` : ""}`;
  }

  /**
   * Same verdict as `dispatchBlockForMeter`, without its self-heal writes
   * (`ignoreExhaustedRows`/`setDaemonState` once an exhausted report's own
   * `until` has passed) -- for a read-only connection. An expired-but-not-
   * yet-cleared report still reads as unblocked here, exactly like
   * `dispatchBlockForMeter` would return; only clearing the marker itself is
   * deferred to the next writable open.
   */
  dispatchBlockForMeterReadOnly(meterId: string, now = new Date()): string | undefined {
    const state = this.exhaustedState(meterId);
    if (!state) return this.daemonState(`exhausted:${meterId}`) ? "vendor reports the limit reached" : undefined;
    if (state.active === false) return undefined;
    const until = state.until ? Date.parse(state.until) : Number.NaN;
    if (Number.isFinite(until) && until <= now.getTime()) return undefined;
    return `vendor reports the limit reached${state.until ? `; resets ${state.until}` : ""}`;
  }

  dispatchBlockForPrincipal(principal: string): string | undefined {
    const downgrade = this.planDowngrade(principal);
    if (!downgrade) return undefined;
    return downgrade.acknowledged ? undefined : `plan downgraded to ${downgrade.to}; dispatches are refused until you run: headroom ack plan ${principal}`;
  }

  acknowledgePlan(principal: string): void {
    const raw = this.daemonState(`plan_drop:${principal}`);
    if (!raw) return;
    try {
      const state = JSON.parse(raw) as Record<string, unknown>;
      this.setDaemonState(`plan_drop:${principal}`, JSON.stringify({ ...state, acknowledged: true }));
    } catch { /* A malformed legacy marker remains safely blocking. */ }
  }

  planDowngrade(principal: string): PlanDowngrade | undefined {
    const state = this.planDropState(principal);
    if (!state || state.active === false || typeof state.from !== "string" || typeof state.to !== "string" || typeof state.at !== "string") return undefined;
    return { principal, from: state.from, to: state.to, since: state.at, acknowledged: state.acknowledged === true };
  }

  private planDropState(principal: string): { from?: string; to?: string; at?: string; acknowledged?: boolean; active?: boolean; restored_at?: string } | undefined {
    const raw = this.daemonState(`plan_drop:${principal}`);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as { from?: string; to?: string; at?: string; acknowledged?: boolean; active?: boolean; restored_at?: string }; }
    catch { return undefined; }
  }

  planDowngrades(principals?: Iterable<string>): PlanDowngrade[] {
    const allowed = principals ? new Set(principals) : undefined;
    return this.prepared("SELECT key FROM daemon_state WHERE key LIKE 'plan_drop:%'").all().flatMap((row) => {
      const principal = String(row.key).slice("plan_drop:".length);
      const downgrade = this.planDowngrade(principal);
      return downgrade && (!allowed || allowed.has(principal)) ? [downgrade] : [];
    }).sort((a, b) => a.principal.localeCompare(b.principal));
  }

  private previous(observation: Observation): StoredObservation | undefined {
    const match = windowSqlMatch(observation.window);
    const row = this.prepared(`SELECT * FROM observations WHERE meter_id = ? AND ${match.sql} ORDER BY id DESC LIMIT 1`)
      .get(observation.meter_id, ...match.params);
    return row ? observationFromRow(row) : undefined;
  }

  private vendorWindowStateKey(meterId: string, minutes: number): string {
    return `vendor_window_suspect:${meterId}:${minutes}`;
  }

  private vendorWindowSuspect(observation: Observation): VendorWindowSuspect | undefined {
    const minutes = observation.window?.minutes;
    if (!minutes) return undefined;
    const raw = this.daemonState(this.vendorWindowStateKey(observation.meter_id, minutes));
    if (!raw) return undefined;
    try {
      const state = JSON.parse(raw) as Partial<VendorWindowSuspect>;
      return typeof state.baseline_id === "number" && typeof state.suspect_id === "number"
        ? { baseline_id: state.baseline_id, suspect_id: state.suspect_id,
          baseline_resets_at: typeof state.baseline_resets_at === "string" ? state.baseline_resets_at : null,
          suspect_resets_at: typeof state.suspect_resets_at === "string" ? state.suspect_resets_at : null }
        : undefined;
    } catch { return undefined; }
  }

  private sameReset(left: string | null, right: string | null): boolean {
    if (left === right) return true;
    const leftTime = left ? Date.parse(left) : Number.NaN;
    const rightTime = right ? Date.parse(right) : Number.NaN;
    // Some vendors serialize the same scheduled instant with a little clock
    // jitter. Identity is the scheduled window, not sub-minute formatting.
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 60_000;
  }

  /** The latest trustworthy identity, scoped by the visible meter duration
   * rather than the complete window JSON. A 5h fixed and 5h rolling reading
   * are still one vendor allowance for this decision. */
  private acceptedWindowBaseline(observation: Observation): StoredObservation | undefined {
    const minutes = observation.window?.minutes;
    if (!minutes) return undefined;
    const row = this.prepared(`SELECT * FROM observations WHERE meter_id = ?
      AND freshness = 'fresh' AND CAST(json_extract(window_json, '$.minutes') AS INTEGER) IS ?
      AND COALESCE(json_extract(metadata_json, '$.vendor_inconsistent'), 0) = 0
      AND COALESCE(json_extract(metadata_json, '$.vendor_window_held'), 0) = 0
      ORDER BY fetched_at DESC, id DESC LIMIT 1`).get(observation.meter_id, minutes);
    return row ? observationFromRow(row) : undefined;
  }

  /** Codex's live endpoint makes an idle zero-use window's reset equal its
   * fetch time plus the window duration. It advances on every poll, so it is
   * not a second, contradictory fixed-window identity. The adapter alone
   * supplies this provider-specific marker; similar shapes from other sources
   * retain the normal two-poll vendor-window guard. */
  private isCodexIdleWindow(observation: Observation): boolean {
    const fetchedAt = Date.parse(observation.fetched_at);
    const resetsAt = observation.resets_at ? Date.parse(observation.resets_at) : Number.NaN;
    const minutes = observation.window?.minutes;
    return observation.source === "native:codex" && observation.metadata?.codex_idle_window === true
      && observation.freshness === "fresh" && observation.quantity?.unit === "percent" && observation.quantity.used === 0
      && typeof minutes === "number" && Number.isFinite(minutes)
      && Number.isFinite(fetchedAt) && Number.isFinite(resetsAt)
      && Math.abs(resetsAt - (fetchedAt + minutes * 60_000)) <= 90_000;
  }

  private isCodexIdleActivation(observation: Observation, baseline: StoredObservation | undefined): boolean {
    if (!baseline || !this.isCodexIdleWindow(baseline) || observation.source !== "native:codex" || observation.freshness !== "fresh" || observation.quantity?.unit !== "percent" || !(observation.quantity.used > 0)) return false;
    const minutes = observation.window?.minutes;
    const start = observation.resets_at ? Date.parse(observation.resets_at) - (minutes ?? 0) * 60_000 : Number.NaN;
    const before = Date.parse(baseline.fetched_at);
    const now = Date.parse(observation.fetched_at);
    // A real use window starts when use first appears; accept only an anchor
    // between the prior idle poll and this one (with endpoint second rounding).
    return typeof minutes === "number" && Number.isFinite(start) && Number.isFinite(before) && Number.isFinite(now)
      && start >= before - 1_000 && start <= now + 1_000;
  }

  /** Only fixed timestamps can be a durable vendor window identity. Rolling
   * windows conventionally move their reset timestamp forward on every poll,
   * so treating that ordinary movement as a flip would hold them forever. */
  private vendorWindowTransition(observation: Observation): VendorWindowTransition {
    if (observation.freshness !== "fresh" || observation.window?.kind !== "fixed" || !observation.window.minutes) return { kind: "normal" };
    const state = this.vendorWindowSuspect(observation);
    const baseline = state
      ? this.observationById(state.baseline_id) ?? this.acceptedWindowBaseline(observation)
      : this.acceptedWindowBaseline(observation);
    if (this.isCodexIdleActivation(observation, baseline)) return { kind: "activation" };
    if (this.isCodexIdleWindow(observation)) {
      // The first idle reading after a real scheduled boundary is still the
      // rollover evidence and must retain that scheduled-reset event. Later
      // moving idle timestamps are ordinary updates, not candidates for a
      // new vendor identity or duplicate reset event.
      if (baseline && !this.sameReset(observation.resets_at, baseline.resets_at) && this.windowHasEnded(baseline, observation)) return { kind: "rollover", baseline };
      // A zero use reading before a nonzero baseline's reset is still an
      // unexpected capacity increase. Keep the normal two-poll guard for it;
      // only an already accepted idle reading may make a moving idle reset
      // routine before that boundary.
      if (baseline && baseline.quantity?.used !== 0 && !this.isCodexIdleWindow(baseline)) {
        // A second independently moving idle response confirms an unexpected
        // reset. Its first timestamp is the reset evidence; equality would be
        // impossible because idle timestamps intentionally drift with fetch.
        const firstIdle = state ? this.observationById(state.suspect_id) : undefined;
        if (state && firstIdle && this.isCodexIdleWindow(firstIdle)) {
          // Confirmation means a later poll, never a retry of the same row or
          // an old observation replayed out of order. Do not fall through to
          // sameReset's generic accepted path: duplicate idle timestamps are
          // equal precisely because they are not independent evidence.
          const currentAt = Date.parse(observation.fetched_at);
          const firstAt = Date.parse(firstIdle.fetched_at);
          if (currentAt > firstAt) return { kind: "idle-confirmed", suspect: state };
          // A duplicate has the same poll timestamp but a new append-only id;
          // keep it as the selected held row. Older replays must not move the
          // state backward, because the newest held row would then surface.
          if (currentAt === firstAt) return baseline ? { kind: "suspect", baseline } : { kind: "repeat" };
          return { kind: "repeat" };
        }
        // Fall through into the standard fixed-window consistency path.
      } else {
        // An earlier non-idle suspect must not survive an idle window; its
        // moving timestamp cannot confirm either identity on a later poll.
        return { kind: "idle" };
      }
    }
    // A fixed window gets a new identity at its scheduled boundary. Permit a
    // small early clock skew so its first new-period poll stays immediately
    // usable rather than looking like issue #29's pre-boundary flip-flop.
    // A missing previous reset cannot prove the old window still had time.
    if (baseline && !this.sameReset(observation.resets_at, baseline.resets_at) && this.windowHasEnded(baseline, observation)) return { kind: "rollover", baseline };
    if (state) {
      if (this.sameReset(observation.resets_at, state.suspect_resets_at)) return { kind: "accepted", suspect: state };
      if (this.sameReset(observation.resets_at, state.baseline_resets_at)) return { kind: "flip", suspect: state };
      return baseline ? { kind: "suspect", baseline } : { kind: "normal" };
    }
    if (!baseline || this.sameReset(observation.resets_at, baseline.resets_at)) return { kind: "normal" };
    return { kind: "suspect", baseline };
  }

  private windowHasEnded(baseline: StoredObservation, observation: Observation): boolean {
    if (!baseline.resets_at) return true;
    const resetAt = Date.parse(baseline.resets_at);
    const fetchedAt = Date.parse(observation.fetched_at);
    return Number.isFinite(resetAt) && Number.isFinite(fetchedAt) && fetchedAt >= resetAt - 2 * 60_000;
  }

  private setVendorWindowSuspect(suspect: StoredObservation, baseline: StoredObservation): void {
    const minutes = suspect.window?.minutes;
    if (!minutes) return;
    this.setDaemonState(this.vendorWindowStateKey(suspect.meter_id, minutes), JSON.stringify({
      baseline_id: baseline.id, suspect_id: suspect.id,
      baseline_resets_at: baseline.resets_at, suspect_resets_at: suspect.resets_at,
    } satisfies VendorWindowSuspect));
  }

  private clearVendorWindowSuspect(observation: Observation): void {
    const minutes = observation.window?.minutes;
    if (!minutes) return;
    this.setDaemonState(this.vendorWindowStateKey(observation.meter_id, minutes), "");
  }

  private observationById(id: number): StoredObservation | undefined {
    const row = this.prepared("SELECT * FROM observations WHERE id = ?").get(id);
    return row ? observationFromRow(row) : undefined;
  }

  private markVendorInconsistent(id: number): void {
    this.prepared("UPDATE observations SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.vendor_inconsistent', json('true')) WHERE id = ?").run(id);
  }

  private clearVendorInconsistent(id: number): void {
    this.prepared("UPDATE observations SET metadata_json = json_remove(COALESCE(metadata_json, '{}'), '$.vendor_inconsistent') WHERE id = ?").run(id);
  }

  private recentVendorInconsistent(meterId: string, fetchedAt: string): boolean {
    const since = new Date(Date.parse(fetchedAt) - 6 * 3_600_000).toISOString();
    return this.prepared("SELECT 1 FROM events WHERE kind = 'vendor_inconsistent' AND meter_id = ? AND julianday(created_at) >= julianday(?) LIMIT 1").get(meterId, since) !== undefined;
  }

  /** The most recent FRESH reading for this exact meter and window, fetched
   * within the last 2 hours of this new observation's own fetch time --
   * the contradiction evidence resolveIdleContradiction() checks a
   * detectPlaceholder-flagged idle reading against. */
  private recentFreshReading(observation: Observation): StoredObservation | undefined {
    const match = windowSqlMatch(observation.window);
    const since = new Date(Date.parse(observation.fetched_at) - 2 * 3_600_000).toISOString();
    const row = this.prepared(`SELECT * FROM observations WHERE meter_id = ? AND ${match.sql}
      AND freshness = 'fresh' AND fetched_at >= ? ORDER BY fetched_at DESC, id DESC LIMIT 1`)
      .get(observation.meter_id, ...match.params, since);
    return row ? observationFromRow(row) : undefined;
  }

  /**
   * observation.ts's normalizeObservations() flags a vendor-reported idle
   * window (IDLE_WINDOW_REASON) rather than failing it, since the owner's
   * decision is to show the vendor's own numbers and annotate doubt instead
   * of guessing. The one case that doubt becomes an outright failure: this
   * store's own history, within the last 2 hours, already showed real usage
   * on this exact meter and window whose reset has not happened yet -- a
   * vendor cannot legitimately go from spending to idle without a reset in
   * between, so a reading that claims otherwise contradicts evidence Headroom
   * already trusted, not just a heuristic shape.
   */
  private resolveIdleContradiction(observation: Observation): Observation {
    if (observation.freshness !== "fresh" || observation.reason !== IDLE_WINDOW_REASON) return observation;
    const evidence = this.recentFreshReading(observation);
    if (!evidence || evidence.quantity?.unit !== "percent" || !(evidence.quantity.used > 0)) return observation;
    const resetDue = evidence.resets_at ? Date.parse(evidence.resets_at) : Number.NaN;
    const now = Date.parse(observation.fetched_at);
    if (!Number.isFinite(resetDue) || !Number.isFinite(now) || resetDue <= now) return observation;
    return { ...observation, freshness: "failed", confidence: 0, reason: idleContradictionReason(evidence.quantity.used) };
  }

  private addEvent(kind: EventKind, origin: HeadroomEvent["origin"], confidence: number, evidence: number[], current: StoredObservation, reason: string | null = null, lastSeenAt: string | null = null, createdAt?: string, metadata?: HeadroomEvent["metadata"]): void {
    const created = createdAt ?? current.fetched_at;
    const id = `${kind}:${current.id}`;
    // OR IGNORE keeps the reset-detection backfill idempotent: replaying it
    // over already-classified observations must not error on a repeat id.
    this.prepared("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, kind, origin, confidence, JSON.stringify(evidence), created, null, current.meter_id, current.principal_id, reason, lastSeenAt, metadata ? JSON.stringify(metadata) : null);
  }

  private addSourceFailedEvent(evidence: number[], current: StoredObservation): void {
    const inferred = isInferredFailureReason(current.reason);
    this.addEvent("source_failed", inferred ? "inferred" : "vendor_reported", inferred ? 0.8 : 1, evidence, current, inferred ? current.reason : null, current.fetched_at);
  }

  /** The still-open source_failed event for this meter and window, or
   * undefined if the last event for that (meter, window) pair was a recovery
   * (or there has never been a failure). Scoped by the evidence observations'
   * own window rather than the events table (which has no window column) so
   * a failed 5h window and a failed weekly window never collapse into, or
   * silently close, each other's event. */
  private openFailureForWindow(meterId: string, window: Observation["window"]): Row | undefined {
    const match = windowSqlMatch(window, "o.window_json");
    const row = this.prepared(`SELECT e.* FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.meter_id = ? AND e.kind IN ('source_failed', 'source_recovered')
        AND ${match.sql}
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1`).get(meterId, ...match.params);
    return row && row.kind === "source_failed" ? row : undefined;
  }

  /** The still-open windowless source_failed event for this meter (a
   * transport/auth failure with no vendor window, representing the whole
   * meter), independent of window equality: it is open exactly when no
   * source_recovered event of ANY window has fired since it, since a
   * windowless failure is only ever closed by whatever reading recovers
   * next, which may carry a real window (a real window's own recordFailure /
   * recovery bookkeeping is otherwise scoped to matching windows only). */
  private openWindowlessFailure(meterId: string): Row | undefined {
    const lastFailure = this.prepared(`SELECT e.* FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.meter_id = ? AND e.kind = 'source_failed' AND (o.window_json IS NULL OR o.window_json = 'null')
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1`).get(meterId);
    if (!lastFailure) return undefined;
    const closed = this.prepared("SELECT 1 FROM events WHERE meter_id = ? AND kind = 'source_recovered' AND created_at > ? LIMIT 1")
      .get(meterId, String(lastFailure.created_at));
    return closed ? undefined : lastFailure;
  }

  /** Emit source_failed only on the transition into failure (or when nothing
   * is open yet, scoped to this observation's own window); while a principal
   * stays failed, advance last_seen_at on the still-open event instead of
   * inserting a new one every poll. */
  private recordFailure(evidence: number[], current: StoredObservation): void {
    const open = current.window ? this.openFailureForWindow(current.meter_id, current.window) : this.openWindowlessFailure(current.meter_id);
    if (open) {
      this.prepared("UPDATE events SET last_seen_at = ? WHERE id = ?").run(current.fetched_at, String(open.id));
    } else {
      this.addSourceFailedEvent(evidence, current);
    }
    this.recordGrantLapsed(evidence, current);
  }

  /**
   * A Claude Keychain ACL lapse (claude.ts's claudeKeychainLapseReason, see
   * issue #9) carries a distinct reason wording from a plain "grant needed"
   * denial, and only ever appears on the one poll that first detects it:
   * once collector.ts marks the grant gate, every later failed observation
   * for this principal reuses the shorter, generic "Keychain grant needed;"
   * wording instead (claudeGrantNeededReason), never this prefix again until
   * the next lapse. That makes the reason text itself the transition signal
   * -- this fires once per lapse with no extra open/close bookkeeping, on
   * just the account-wide `:all` meter so one lapse produces one
   * notification rather than one per meter (all/fable/routines all carry
   * the identical reason on the same poll).
   */
  private recordGrantLapsed(evidence: number[], current: StoredObservation): void {
    if (!current.meter_id.endsWith(":all") || !current.reason?.startsWith("Keychain grant lapsed;")) return;
    this.addEvent("grant_lapsed", "vendor_reported", 1, evidence, current, current.reason);
  }

  /** A windowless (whole-meter transport/auth) failure is not directly
   * comparable to a subsequent windowed reading via previous()'s exact
   * window match, so it would otherwise never be recovered: a real-window
   * fresh reading after it must still close it, or a second outage separated
   * by that recovery would silently extend the first failure's event instead
   * of opening a new one. Called for every fresh observation regardless of
   * its own window. */
  private recoverWindowlessFailure(current: StoredObservation): void {
    if (current.freshness !== "fresh") return;
    if (!this.openWindowlessFailure(current.meter_id)) return;
    this.addEvent("source_recovered", "vendor_reported", 1, [current.id], current);
  }

  /** The comparison baseline for a fresh observation is the most recent FRESH
   * observation of the same meter and window within 7 days, skipping any
   * failed or not_enforced rows in between (a principal parked mid-outage
   * must still be compared against its last real reading once it recovers).
   * Also accepts the legacy `<principal>:<principal>:<meter>` meter id an
   * earlier engine emitted, so older history still counts as a baseline. */
  private freshBaseline(current: StoredObservation): StoredObservation | undefined {
    const match = windowSqlMatch(current.window);
    const since = new Date(Date.parse(current.fetched_at) - 7 * 86_400_000).toISOString();
    const lookup = (meterId: string): Row | undefined => this.prepared(`SELECT * FROM observations
      WHERE meter_id = ? AND ${match.sql}
        AND freshness = 'fresh' AND id < ? AND fetched_at >= ?
      ORDER BY fetched_at DESC, id DESC LIMIT 1`).get(meterId, ...match.params, current.id, since);
    const row = lookup(current.meter_id) ?? lookup(`${current.principal_id}:${current.meter_id}`);
    return row ? observationFromRow(row) : undefined;
  }

  /**
   * The bucket name of a meter this principal has never reported before, or
   * undefined. A vendor names its model-scoped allowances itself (Claude's
   * `limits[]` display names become `claude-main:<slug>` meters), so a meter
   * id appearing for the first time on an account Headroom has already been
   * reading is a new named allowance: a model release, or a bucket the
   * vendor just split out. The principal must already have history, so a
   * first-ever poll of a new account reports every one of its meters as
   * normal readings instead of a burst of model_new. Count and local-pool
   * state windows are excluded: those are credits and pool health, not
   * named allowances.
   */
  private newBucketName(observation: Observation): string | undefined {
    const kind = observation.window?.kind;
    if (!kind || kind === "count" || kind === "state") return undefined;
    if (this.prepared("SELECT 1 FROM observations WHERE meter_id = ? LIMIT 1").get(observation.meter_id)) return undefined;
    if (!this.prepared("SELECT 1 FROM observations WHERE principal_id = ? LIMIT 1").get(observation.principal_id)) return undefined;
    const prefix = `${observation.principal_id}:`;
    return observation.meter_id.startsWith(prefix) ? observation.meter_id.slice(prefix.length) : observation.meter_id;
  }

  /** Whether at least one failed reading for this exact meter and window sits
   * strictly between baseline and current -- a "gap of failed readings" (the
   * UNKNOWN rows of issue #10) hiding whether the vendor's scheduled reset
   * actually fell inside it. A plain two-in-a-row fresh comparison (no gap)
   * keeps using the direct resets_at-delta read below; a gapped one cannot
   * trust that delta, since a jump far bigger than the elapsed time is
   * expected the moment a gap is long enough to span a scheduled reset,
   * whether or not the reset happened inside THIS gap specifically. */
  private failedGapBetween(meterId: string, window: Observation["window"], afterId: number, beforeId: number): boolean {
    const match = windowSqlMatch(window);
    const row = this.prepared(`SELECT 1 FROM observations WHERE meter_id = ? AND ${match.sql}
      AND freshness = 'failed' AND id > ? AND id < ? LIMIT 1`).get(meterId, ...match.params, afterId, beforeId);
    return row !== undefined;
  }

  /** Whether a reset_seen event already exists for this meter and window at
   * exactly this scheduled moment -- the dedupe a gap-classified reset needs
   * that addEvent's own id (keyed off the observation that happened to close
   * the gap) does not provide, since two different closing observations can
   * in principle name the same scheduled reset. */
  private resetSeenAtScheduledTime(meterId: string, window: Observation["window"], scheduledAt: string): boolean {
    const match = windowSqlMatch(window, "o.window_json");
    const row = this.prepared(`SELECT 1 FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.kind = 'reset_seen' AND e.meter_id = ?
        AND ${match.sql}
        AND e.created_at = ? LIMIT 1`).get(meterId, ...match.params, scheduledAt);
    return row !== undefined;
  }

  /** Classify a usage drop of more than 50%, or non-zero to zero, against its
   * fresh baseline. Local pools (window kind `state`) and credit counts (kind
   * `count`, handled by the vendor-reported credits path below) never carry
   * reset evidence. A window's reset timestamp normally moves forward by
   * about as much real time as passed between the two readings (a rolling
   * window recomputes it as fetch time plus duration on every poll); a jump
   * bigger than that elapsed time is a real reset, while a timestamp that
   * held still even though usage already fell is a free reset fired ahead of
   * the scheduled one. A baseline older than 24h lowers confidence, since the
   * gap could hide more than one reset.
   *
   * When the baseline and current are separated by a gap of failed readings
   * (failedGapBetween), the resets_at-delta jump above is not trustworthy
   * evidence of WHEN a reset happened -- only of whether one plausibly could
   * have. Issue #10: a day of failed `claude-main:fable` readings around an
   * already-recorded account-wide weekly reset produced a second reset_seen
   * for fable stamped at the moment the gap happened to close (23:45), hours
   * after the reset itself (14:16). Across a gap, a reset is recorded only
   * when the baseline's own scheduled reset time falls inside the gap, and
   * at that scheduled moment, not the observation that ended the gap;
   * confidence is fixed at 0.8 -- an inferred instant, not two readings taken
   * close together, so below a same-poll detection's 0.9 but above a stale
   * one's 0.6. No scheduled reset inside the gap means this rule stays
   * silent and defers entirely to the ordinary beforeScheduledReset check
   * below (a vendor correction or a free reset fired ahead of schedule). */
  private classifyUsageDrop(baseline: StoredObservation, current: StoredObservation, createdAt?: string, scheduledRolloverAt?: string): void {
    if (current.window?.kind === "state" || current.window?.kind === "count") return;
    if (baseline.quantity?.unit !== "percent" || current.quantity?.unit !== "percent") return;
    const oldUsed = baseline.quantity.used;
    const newUsed = current.quantity.used;
    if (!isUsageReset(oldUsed, newUsed)) return;
    const previousReset = baseline.resets_at ? Date.parse(baseline.resets_at) : Number.NaN;
    const currentReset = current.resets_at ? Date.parse(current.resets_at) : Number.NaN;
    if (!Number.isFinite(previousReset) || !Number.isFinite(currentReset)) return;
    const evidence = [baseline.id, current.id];
    const elapsedMs = Date.parse(current.fetched_at) - Date.parse(baseline.fetched_at);
    const resetDeltaMs = currentReset - previousReset;
    const toleranceMs = 60_000;
    const resetsUnchanged = Math.abs(resetDeltaMs) <= toleranceMs;
    const beforeScheduledReset = resetsUnchanged && Date.parse(current.fetched_at) < previousReset;
    const stale = elapsedMs > 24 * 3_600_000;
    const staleHours = Math.floor(elapsedMs / 3_600_000);
    const suffix = (base: string | null): string | null => stale ? `${base ? `${base}; ` : ""}baseline ${staleHours}h old` : base;
    const freeReset = (): void => this.addEvent("free_reset_used", "inferred", stale ? 0.5 : 0.8, evidence, current, suffix(`usage dropped from ${Math.round(oldUsed)}% to ${Math.round(newUsed)}% before the scheduled reset`), null, createdAt);
    const windowMinutes = current.window?.minutes ?? null;
    if (this.failedGapBetween(current.meter_id, current.window, baseline.id, current.id)) {
      if (previousReset > Date.parse(baseline.fetched_at) && previousReset <= Date.parse(current.fetched_at)) {
        const scheduledAt = new Date(previousReset).toISOString();
        if (!this.resetSeenAtScheduledTime(current.meter_id, current.window, scheduledAt)) this.addEvent("reset_seen", "inferred", 0.8, evidence, current, suffix(null), null, scheduledAt, { window_minutes: windowMinutes });
        return;
      }
      if (beforeScheduledReset) freeReset();
      return;
    }
    const resetsAdvanced = resetDeltaMs > elapsedMs + toleranceMs;
    if (!resetsAdvanced && !beforeScheduledReset) return;
    if (resetsAdvanced) {
      // Issue #20: a reset whose observation lands before the baseline's own
      // scheduled instant fired ahead of schedule -- capacity appeared that
      // the vendor's own timeline did not promise yet (the live Codex case:
      // a weekly meter dropping 88% to 0% five days early). One at or after
      // that instant is the ordinary scheduled reset, even though resets_at
      // itself has already moved forward onto the next cycle by the time
      // this poll saw it. No reset credit is consumed either way -- that
      // mechanism is the vendor-reported `count`-window path below, entirely
      // separate from this percent-window classification. window_minutes is
      // carried on both branches (not just the unscheduled one) so the
      // notifier can name the window on an ordinary scheduled reset too, and
      // hold back a scheduled short-window one by default without a second
      // lookup.
      const unscheduled = Date.parse(current.fetched_at) < previousReset;
      const eventAt = unscheduled ? createdAt : scheduledRolloverAt;
      this.addEvent("reset_seen", "inferred", stale ? 0.6 : 0.9, evidence, current, suffix(null), null, eventAt, {
        window_minutes: windowMinutes,
        ...(unscheduled ? { unscheduled: true, used_percent: Math.round(newUsed), previous_used_percent: Math.round(oldUsed) } : {}),
      });
    } else freeReset();
  }

  /** The most recent reset_seen event for this meter+window within
   * [since, now], if any -- the vendor-confirmed sign a reset actually
   * happened, used by burnRateFor to cut a sample window off at the reset
   * instead of letting it span the drop. Mirrors eventEvidenceFor's own
   * julianday() comparison for the same reason: an event's created_at is an
   * observation's fetched_at verbatim, not guaranteed to carry milliseconds. */
  private lastResetEventAt(meterId: string, minutes: number, sinceIso: string, nowIso: string): number | null {
    const row = this.prepared(`SELECT e.created_at FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.kind = 'reset_seen' AND e.meter_id = ?
        AND CAST(json_extract(o.window_json, '$.minutes') AS INTEGER) = ?
        AND julianday(e.created_at) >= julianday(?) AND julianday(e.created_at) <= julianday(?)
      ORDER BY e.created_at DESC LIMIT 1`).get(meterId, minutes, sinceIso, nowIso);
    const at = row?.created_at && typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Least-squares burn rate (percent per hour) and projected time to 100%
   * used, per meter+window, from that window's fresh percent samples fetched
   * within the last `lookbackMinutes` (60 by default -- `rate`'s own
   * shorter or longer window reuses this with a different value). At least
   * two samples are required; fewer returns nulls for that window. Keyed by
   * `${meter_id}:${minutes}`, matching pace.ts's withPaceInfo().
   *
   * A window's samples are cut off at its most recent reset within the
   * lookback -- otherwise a poll straddling a reset (weekly or free) pairs a
   * near-100% pre-reset sample with a near-0% post-reset one and reports a
   * wildly negative "burn", which is really just the reset itself. The
   * boundary is whichever is more recent of the store's own confirmed
   * reset_seen event, or -- for a reset that never made it into the event
   * log (e.g. resets_at was unparseable at the time) -- the same raw
   * usage-drop rule classifyUsageDrop uses to recognize one directly from
   * the samples. Fewer than two samples after that cut leaves burn null,
   * same as fewer than two samples overall. A straight-line fit should
   * never come out negative once reset-spanning samples are excluded --
   * used only climbs within one window -- so a small negative slope left
   * over (rounding noise on a whole-percent meter) is clamped to 0 rather
   * than reported as falling usage.
   */
  burnRateFor(observations: Array<Pick<Observation, "meter_id" | "window">>, now = new Date(), lookbackMinutes = 60): Map<string, BurnInfo> {
    const output = new Map<string, BurnInfo>();
    const seen = new Set<string>();
    const nowIso = now.toISOString();
    const since = new Date(now.getTime() - lookbackMinutes * 60_000).toISOString();
    for (const observation of observations) {
      const minutes = observation.window?.minutes;
      const kind = observation.window?.kind;
      if (!minutes || kind === "state" || kind === "count") continue;
      const key = `${observation.meter_id}:${minutes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // julianday(), not a plain string range: fetched_at is not guaranteed to
      // carry milliseconds (see eventEvidenceFor's identical comment above),
      // and ISO timestamps only sort lexicographically when every value
      // shares the same precision.
      const rows = this.prepared("SELECT * FROM observations WHERE meter_id = ? AND freshness = 'fresh' AND julianday(fetched_at) >= julianday(?) AND julianday(fetched_at) <= julianday(?) ORDER BY fetched_at ASC, id ASC")
        .all(observation.meter_id, since, nowIso)
        .map(observationFromRow)
        .filter((row) => row.window?.minutes === minutes && row.quantity?.unit === "percent" && !row.metadata?.vendor_inconsistent && !row.metadata?.vendor_window_held);
      let samples = rows.map((row) => ({ at: Date.parse(row.fetched_at), used: (row.quantity as { used: number }).used })).filter((sample) => Number.isFinite(sample.at));

      const eventBoundary = this.lastResetEventAt(observation.meter_id, minutes, since, nowIso);
      let sampleBoundary: number | null = null;
      for (let i = 1; i < samples.length; i++) {
        if (isUsageReset(samples[i - 1].used, samples[i].used)) sampleBoundary = samples[i].at;
      }
      const boundary = Math.max(eventBoundary ?? -Infinity, sampleBoundary ?? -Infinity);
      if (Number.isFinite(boundary)) samples = samples.filter((sample) => sample.at >= boundary);

      let burn = leastSquaresBurnPerHour(samples);
      if (burn !== null && burn < 0) burn = 0;
      const currentUsed = samples.length ? samples[samples.length - 1].used : null;
      output.set(key, { burn_percent_per_hour: burn, empty_in_seconds: burn !== null && currentUsed !== null ? emptyInSeconds(currentUsed, burn) : null });
    }
    return output;
  }

  /** The still-open pace_projection_conserve event for this meter+window
   * within the last hour, so a window that stays in the same projected-stall
   * CONSERVE across several polls gets one event per hour, not one per poll. */
  private recentPaceProjectionEvent(meterId: string, minutes: number, before: string): boolean {
    const since = new Date(Date.parse(before) - 3_600_000).toISOString();
    const row = this.prepared(`SELECT e.id FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.kind = 'pace_projection_conserve' AND e.meter_id = ?
        AND CAST(json_extract(o.window_json, '$.minutes') AS INTEGER) = ?
        AND e.created_at >= ? AND e.created_at < ?
      LIMIT 1`).get(meterId, minutes, since, before);
    return Boolean(row);
  }

  /** Fires pace_projection_conserve the moment a fresh observation's own
   * burn rate projects it running dry before its window resets -- the same
   * rule paceDecision() uses to flip the window's live pace state, applied
   * here with the default policy so this event fires independent of whatever
   * custom policy.toml the caller has (still a fair signal: it says the
   * straight-line rule alone would not yet have caught this). */
  private detectPaceProjection(current: StoredObservation): void {
    if (current.quantity?.unit !== "percent") return;
    const minutes = current.window?.minutes;
    const kind = current.window?.kind;
    if (!minutes || kind === "state" || kind === "count") return;
    const burn = this.burnRateFor([current], new Date(current.fetched_at)).get(`${current.meter_id}:${minutes}`);
    if (!burn || burn.burn_percent_per_hour === null || burn.empty_in_seconds === null) return;
    const enriched: StoredObservation = { ...current, burn_percent_per_hour: burn.burn_percent_per_hour, empty_in_seconds: burn.empty_in_seconds };
    const decision = paceDecision(enriched, defaultPolicy, new Date(current.fetched_at));
    if (decision.state !== "CONSERVE" || !decision.reason.startsWith("burning ")) return;
    if (this.recentPaceProjectionEvent(current.meter_id, minutes, current.fetched_at)) return;
    this.addEvent("pace_projection_conserve", "inferred", 0.7, [current.id], current, decision.reason, null, undefined, {
      window_minutes: minutes, resets_at: current.resets_at ?? undefined,
      burn_percent_per_hour: burn.burn_percent_per_hour, empty_in_seconds: burn.empty_in_seconds,
    });
  }

  /**
   * Median, interquartile range and sample count of the per-lease total
   * spent percent, grouped by the lease's action_class (set by `lease start
   * --class` or `can --lease`). Only a lease that has actually ENDED --
   * finished normally or expired -- counts as a sample: an in-progress
   * lease has no observed spend yet, so counting it would let a batch of
   * just-started jobs drag the median toward zero and inflate the sample
   * count before any of them are actually done. A completed lease with
   * genuinely zero spend still counts as one real (zero-cost) sample --
   * only an unfinished lease is excluded, not a finished free one.
   * Restricted to one class when given, otherwise every class that has at
   * least one sample.
   */
  learnedCost(actionClass?: string, now = new Date()): LearnedCost[] {
    this.expireLeases(now);
    const filter = actionClass ? "WHERE l.action_class = ? AND l.ended_at IS NOT NULL" : "WHERE l.action_class IS NOT NULL AND l.ended_at IS NOT NULL";
    const rows = this.prepared(`SELECT l.action_class AS action_class, COALESCE(SUM(s.amount_percent), 0) AS spent
      FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id ${filter} GROUP BY l.id`).all(...(actionClass ? [actionClass] : []));
    const byClass = new Map<string, number[]>();
    for (const row of rows) {
      const key = String(row.action_class);
      const list = byClass.get(key) ?? [];
      list.push(Number(row.spent));
      byClass.set(key, list);
    }
    return [...byClass.entries()].map(([key, spent]) => summarizeLearnedCost(key, spent)).filter((item): item is LearnedCost => item !== undefined).sort((a, b) => a.action_class.localeCompare(b.action_class));
  }

  /** The same median/IQR/count learned-cost summary, but grouped by meter
   * instead of action_class: `fill`'s fallback lane cost when --lane-cost is
   * omitted, from whatever leases (of any class) have run against that
   * meter before. Only ended/expired leases count, for the same reason
   * learnedCost excludes an in-progress one. */
  learnedCostForMeter(meterId: string, now = new Date()): LearnedCost | undefined {
    this.expireLeases(now);
    const rows = this.prepared(`SELECT l.id AS id, COALESCE(SUM(s.amount_percent), 0) AS spent
      FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.meter_id = ? AND l.ended_at IS NOT NULL GROUP BY l.id`).all(meterId);
    return summarizeLearnedCost(meterId, rows.map((row) => Number(row.spent)));
  }

  private detectEvents(previous: StoredObservation, current: StoredObservation, scheduledRolloverAt?: string): void {
    const evidence = [previous.id, current.id];
    if (current.freshness === "failed") {
      this.recordFailure(evidence, current);
      return;
    }
    if (previous.freshness === "failed") {
      if (current.freshness !== "fresh") return; // recovered into an unenforced/stale read, not a real recovery
      const inferred = isInferredFailureReason(previous.reason);
      this.addEvent("source_recovered", inferred ? "inferred" : "vendor_reported", inferred ? 0.8 : 1, evidence, current);
      const baseline = this.freshBaseline(current);
      if (baseline) this.classifyUsageDrop(baseline, current, undefined, scheduledRolloverAt);
      return;
    }
    if (current.freshness === "fresh") {
      const baseline = this.freshBaseline(current);
      if (baseline) this.classifyUsageDrop(baseline, current, undefined, scheduledRolloverAt);
    }
    const previousCredits = previous.quantity?.unit === "credits" ? previous.quantity.remaining : null;
    const currentCredits = current.quantity?.unit === "credits" ? current.quantity.remaining : null;
    if (previous.window?.kind === "count" && current.window?.kind === "count" && previousCredits !== null && currentCredits !== null) {
      const manual = current.source === "manual";
      const origin = manual ? "inferred" : "vendor_reported";
      const confidence = manual ? 0.9 : 1;
      const reason = manual ? current.metadata?.manual_cleared ? "manual credits cleared" : "manual credits entry" : null;
      if (currentCredits > previousCredits) this.addEvent("free_reset_granted", origin, confidence, evidence, current, reason);
      if (currentCredits < previousCredits) this.addEvent("free_reset_used", origin, confidence, evidence, current, reason, null, undefined, current.metadata?.plan === "free" ? { credit_spent_on_free_plan: true } : undefined);
      if (currentCredits !== previousCredits) this.addEvent("credits_changed", origin, confidence, evidence, current, reason);
    }
    if (previous.metadata?.plan && current.metadata?.plan && previous.metadata.plan !== current.metadata.plan) this.recordPlanChange(previous, current, evidence);
  }

  private recordPlanChange(previous: StoredObservation, current: StoredObservation, evidence: number[]): void {
    const from = previous.metadata!.plan!;
    const to = current.metadata!.plan!;
    const downgrade = to === "free" && from !== "free";
    const main = current.meter_id.endsWith(":main") ? current : this.latestPerWindow(`${current.principal_id}:main`)[0] ?? current;
    const state = this.planDropState(current.principal_id);
    const prior = this.planDowngrade(current.principal_id);
    if (downgrade) {
      if (prior?.to === to) return;
      this.addEvent("plan_changed", "vendor_reported", 1, evidence.includes(main.id) ? evidence : [...evidence, main.id], main, null, null, undefined, { from_plan: from, to_plan: to, downgrade: true });
      this.setDaemonState(`plan_drop:${current.principal_id}`, JSON.stringify({ from, to, acknowledged: false, at: current.fetched_at, active: true }));
      return;
    }
    if (prior) {
      this.addEvent("plan_changed", "vendor_reported", 1, evidence.includes(main.id) ? evidence : [...evidence, main.id], main, null, null, undefined, { from_plan: prior.to, to_plan: to, restored: true });
      this.setDaemonState(`plan_drop:${current.principal_id}`, JSON.stringify({ from: prior.from, to: prior.to, acknowledged: prior.acknowledged, at: prior.since, active: false, restored_at: current.fetched_at }));
      return;
    }
    if (state?.active === false && state.restored_at === current.fetched_at) return;
    this.addEvent("plan_changed", "vendor_reported", 1, evidence.includes(main.id) ? evidence : [...evidence, main.id], main, null, null, undefined, { from_plan: from, to_plan: to, downgrade: false });
  }

  /** Fetch a notification batch's original facts in one query. */
  eventObservations(events: HeadroomEvent[]): Map<string, StoredObservation[]> {
    const ids = [...new Set(events.flatMap((event) => event.evidence_observation_ids))];
    const observations = this.prepared("SELECT * FROM observations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY fetched_at ASC, id ASC")
      .all(JSON.stringify(ids)).map(observationFromRow);
    const byId = new Map(observations.map((observation) => [observation.id, observation]));
    return new Map(events.map((event) => [event.id, event.evidence_observation_ids.flatMap((id) => {
      const observation = byId.get(id);
      return observation ? [observation] : [];
    }).sort((a, b) => a.fetched_at.localeCompare(b.fetched_at) || a.id - b.id)]));
  }

  history(meterId: string, since: string): StoredObservation[] {
    return this.prepared("SELECT * FROM observations WHERE meter_id = ? AND fetched_at >= ? ORDER BY fetched_at ASC, id ASC").all(meterId, since).map(observationFromRow);
  }

  /**
   * The observations table is an append-only history. Current status must have
   * one row per meter and duration, chosen by the vendor fetch timestamp (not
   * insertion order), preferring a fresh (or not_enforced -- see below) reading
   * over anything else at any fetched_at. A stale/failed source that keeps
   * re-reporting the exact same old event on every poll (Codex's session-log
   * rate-limit fallback re-reading an unchanged log file, for one) must never
   * eclipse a later fresh reading just because it happens to get re-inserted
   * after it -- and a fresh reading is only ever missing in favor of a
   * non-fresh one when no fresh reading exists for that window at all. A
   * duration is the user-visible window identity: a 5h rolling and a 5h fixed
   * window are still the same current 5h allowance.
   *
   * `not_enforced` shares fresh's top rank (tie-broken by fetched_at like any
   * other pair in that tier): it is a vendor-confirmed CURRENT statement about
   * this window -- "no bucket for it in this response" (issue #55's rolling
   * 5h case), "no cap on it at all" (claude-main:routines), or "no
   * bucket/entry for it in this response" (Codex Spark going idle) -- not a
   * gap to be filled by an older reading. A genuinely idle rolling window
   * that used to carry real usage must have that old percentage replaced by
   * the new not_enforced reading, the same poll it goes idle, rather than
   * freezing in place until it ages into a misleading "stale Nm": that
   * freeze (and the synthesized-100% workaround it once justified for issue
   * #55) was the underlying bug in both cases. A later real, fresh percent
   * reading for the same window still displaces a not_enforced one exactly
   * like it displaces another fresh one, since the tie-break is fetched_at
   * DESC either way.
   */
  latestPerWindow(meterId?: string): StoredObservation[] {
    const filter = meterId === undefined
      ? "WHERE COALESCE(json_extract(metadata_json, '$.exhausted_ignored'), 0) = 0"
      : "WHERE meter_id = ? AND COALESCE(json_extract(metadata_json, '$.exhausted_ignored'), 0) = 0";
    return this.prepared(`WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY meter_id, COALESCE(CAST(json_extract(window_json, '$.minutes') AS TEXT), 'none')
        -- A later manual entry supersedes an earlier one, including a clear.
        -- A cleared/expired manual fact does not hide a newer failed poll:
        -- rank it beside that failure so the newer row can explain the live
        -- state rather than leaving this meter blank after filtering.
        ORDER BY (CASE WHEN (freshness = 'fresh' OR freshness = 'not_enforced')
                         AND NOT (source = 'manual' AND (
                           EXISTS (
                             SELECT 1 FROM observations AS newer_manual
                             WHERE newer_manual.meter_id = observations.meter_id
                               AND COALESCE(CAST(json_extract(newer_manual.window_json, '$.minutes') AS TEXT), 'none') = COALESCE(CAST(json_extract(observations.window_json, '$.minutes') AS TEXT), 'none')
                               AND newer_manual.source = 'manual'
                               AND (newer_manual.fetched_at > observations.fetched_at OR (newer_manual.fetched_at = observations.fetched_at AND newer_manual.id > observations.id))
                           )
                           OR ((COALESCE(json_extract(metadata_json, '$.manual_cleared'), 0) = 1 OR (resets_at IS NOT NULL AND julianday(resets_at) <= julianday('now')))
                             AND EXISTS (
                               SELECT 1 FROM observations AS newer_failed
                               WHERE newer_failed.meter_id = observations.meter_id
                                 AND COALESCE(CAST(json_extract(newer_failed.window_json, '$.minutes') AS TEXT), 'none') = COALESCE(CAST(json_extract(observations.window_json, '$.minutes') AS TEXT), 'none')
                                 AND newer_failed.freshness = 'failed'
                                 AND (newer_failed.fetched_at > observations.fetched_at OR (newer_failed.fetched_at = observations.fetched_at AND newer_failed.id > observations.id))
                             ))
                         ))
                      THEN 0 ELSE 1 END), fetched_at DESC, id DESC
      ) AS row_number
      FROM observations ${filter}
    ) SELECT current.* FROM ranked AS current
      WHERE current.row_number = 1
        AND NOT EXISTS (
          SELECT 1 FROM observations AS retired
          WHERE retired.meter_id = current.meter_id
            AND COALESCE(CAST(json_extract(retired.window_json, '$.minutes') AS TEXT), 'none') = COALESCE(CAST(json_extract(current.window_json, '$.minutes') AS TEXT), 'none')
            AND json_extract(retired.metadata_json, '$.retired') = 1
            AND (retired.fetched_at > current.fetched_at OR (retired.fetched_at = current.fetched_at AND retired.id >= current.id))
        )
        -- A transport/auth failure has no vendor window. It replaces an older
        -- successful read for the whole meter; an older failure must not add a
        -- spurious '-' window beside a newer vendor response. This supersession
        -- is scoped to the SAME window as the failure (a failed 5h window must
        -- not be hidden by a fresh weekly one, and vice versa) unless the
        -- failure itself is windowless, in which case it represents the whole
        -- meter and is superseded by any newer reading regardless of window.
        AND NOT EXISTS (
          SELECT 1 FROM observations AS peer
          WHERE peer.meter_id = current.meter_id
            AND (
              (current.freshness = 'failed' AND peer.freshness <> 'failed')
              OR (current.freshness <> 'failed' AND peer.freshness = 'failed')
            )
            AND (
              current.window_json IS NULL OR current.window_json = 'null' OR peer.window_json IS NULL OR peer.window_json = 'null'
              OR COALESCE(CAST(json_extract(peer.window_json, '$.minutes') AS TEXT), 'none') = COALESCE(CAST(json_extract(current.window_json, '$.minutes') AS TEXT), 'none')
            )
            AND (peer.fetched_at > current.fetched_at OR (peer.fetched_at = current.fetched_at AND peer.id > current.id))
            -- A pasted reading stays authoritative for an hour. A live manual
            -- banked-reset entry stays authoritative until it is cleared,
            -- superseded, or expires: a later failed vendor poll must never
            -- erase the one operator fact it cannot read itself.
            AND NOT (peer.freshness = 'failed' AND (
              (current.source = 'paste' AND current.fetched_at > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-60 minutes'))
              OR (current.source = 'manual'
                AND COALESCE(json_extract(current.metadata_json, '$.manual_cleared'), 0) = 0
                AND (current.resets_at IS NULL OR julianday(current.resets_at) > julianday('now')))
            ))
        )
      ORDER BY current.meter_id ASC, current.fetched_at DESC, current.id DESC`)
      .all(...(meterId === undefined ? [] : [meterId]))
      .map(observationFromRow)
      .map((current) => {
        // The raw suspect remains auditable in history, but every status and
        // routing reader gets the last vendor identity that survived a poll.
        const state = this.vendorWindowSuspect(current);
        if (!state || state.suspect_id !== current.id) return current;
        const earlier = this.observationById(state.baseline_id);
        return earlier ? { ...earlier, metadata: { ...earlier.metadata, vendor_window_held: true } } : current;
      });
  }

  /** Compatibility helper for callers that explicitly need one newest row. */
  latest(meterId: string): StoredObservation | undefined {
    const row = this.prepared("SELECT * FROM observations WHERE meter_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1").get(meterId);
    return row ? observationFromRow(row) : undefined;
  }

  events(since: string): HeadroomEvent[] { return this.prepared("SELECT * FROM events WHERE created_at >= ? ORDER BY created_at ASC").all(since).map(eventFromRow); }

  /** One stored event by its durable ID. Notification compatibility uses this
   * to reconstruct the deterministic delivery ID older builds used. */
  eventById(eventId: string): HeadroomEvent | undefined {
    const row = this.prepared("SELECT * FROM events WHERE id = ?").get(eventId);
    return row ? eventFromRow(row) : undefined;
  }

  /** The catalog never reports a model-to-meter mapping, so this remains a
   * deliberately conservative hint: only a current, fresh, official meter
   * can establish a dedicated bucket. A current generic meter supports the
   * usual shared-pool explanation; no current evidence remains unknown. */
  private modelMeterScope(principalId: string, modelId: string): "dedicated" | "shared" | "unknown" {
    const generic = new Set(["main", "spark", "credits", "capacity", "all", "gemini", "claude-gpt", "state"]);
    const buckets = this.latestPerWindow()
      .filter((observation) => observation.principal_id === principalId && observation.freshness === "fresh" && observation.truth === "official" && !observation.metadata?.vendor_window_held && !observation.metadata?.vendor_inconsistent)
      .map((observation) => observation.meter_id.split(":").slice(1).join(":").toLowerCase());
    const slug = modelId.toLowerCase();
    if (buckets.some((bucket) => bucket.length > 2 && !generic.has(bucket) && (slug.includes(bucket) || bucket.includes(slug)))) return "dedicated";
    if (buckets.some((bucket) => generic.has(bucket))) return "shared";
    return "unknown";
  }

  /** Writes one `model_available`/`model_retired` event directly (not
   * through `addEvent`, which requires a `StoredObservation` for its
   * `meter_id`/`fetched_at` -- a model-catalog fact has neither). The
   * deterministic id (`kind:principal:modelId`) makes this idempotent under
   * `INSERT OR IGNORE`, the same guarantee `addEvent` gives its own
   * observation-keyed ids. */
  private addModelEvent(kind: "model_available" | "model_retired", principalId: string, modelId: string, modelName: string | null, at: string): void {
    const metadata: NonNullable<HeadroomEvent["metadata"]> = { model_id: modelId, model_name: modelName };
    if (kind === "model_available") {
      const scope = this.modelMeterScope(principalId, modelId);
      if (scope === "dedicated") metadata.shares_pool = false;
      else if (scope === "shared") metadata.shares_pool = true;
    }
    this.prepared("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`${kind}:${principalId}:${modelId}`, kind, "vendor_reported", 1, "[]", at, null, null, principalId, modelId, null, JSON.stringify(metadata));
  }

  /**
   * Folds one vendor model-catalog read into `known_models` and emits
   * `model_available`/`model_retired` events for what changed. The first
   * ever call for a principal (tracked by a durable marker, not row count)
   * seeds every id silently -- no events -- so turning this feature on never
   * produces a burst of "new model" notifications for models the operator
   * has already been using for months. Every later call diffs against that
   * seed: an id with no row yet is genuinely new (`first_seen_at` = now, one
   * `model_available` event); an id previously marked `retired_at` reappears
   * without a fresh event (the vendor listing it again is not, by itself, as
   * newsworthy as the very first sighting, and it keeps its original
   * `first_seen_at`); an id no longer present is marked `retired_at` = now
   * with one `model_retired` event (excluded from every default notify
   * preset -- see notify.ts's `PRESET_EVENTS`).
   */
  recordModelCatalog(principalId: string, vendor: string, models: readonly { id: string; name?: string | null }[], now = new Date()): { seeded: boolean; added: string[]; retired: string[] } {
    const at = now.toISOString();
    const initializedKey = `model_catalog_initialized:${principalId}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRows = this.prepared("SELECT * FROM known_models WHERE principal_id = ?").all(principalId).map(knownModelFromRow);
      const seeded = this.daemonState(initializedKey) === undefined;
      const existingById = new Map(existingRows.map((row) => [row.model_id, row]));
      const seenIds = new Set(models.map((model) => model.id));
      const added: string[] = [];
      for (const model of models) {
        const existing = existingById.get(model.id);
        if (!existing) {
          this.prepared("INSERT INTO known_models (principal_id, vendor, model_id, model_name, first_seen_at, last_seen_at, retired_at) VALUES (?,?,?,?,?,?,NULL)")
            .run(principalId, vendor, model.id, model.name ?? null, at, at);
          if (!seeded) {
            added.push(model.id);
            this.addModelEvent("model_available", principalId, model.id, model.name ?? null, at);
          }
          continue;
        }
        this.prepared("UPDATE known_models SET last_seen_at = ?, retired_at = NULL, model_name = COALESCE(?, model_name), vendor = ? WHERE principal_id = ? AND model_id = ?")
          .run(at, model.name ?? null, vendor, principalId, model.id);
      }
      const retired: string[] = [];
      if (!seeded) for (const row of existingRows) {
        if (seenIds.has(row.model_id) || row.retired_at) continue;
        this.prepared("UPDATE known_models SET retired_at = ? WHERE principal_id = ? AND model_id = ?").run(at, principalId, row.model_id);
        retired.push(row.model_id);
        this.addModelEvent("model_retired", principalId, row.model_id, row.model_name, at);
      }
      // This must share the transaction with rows and events. In particular,
      // an authoritative initial empty catalog is still an initialized check.
      this.setDaemonState(initializedKey, at);
      this.db.exec("COMMIT");
      return { seeded, added, retired };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  /** Every model id Headroom has ever seen in a vendor's own catalog, newest
   * first_seen last. A retired id is kept (never deleted), so `headroom
   * models` can still show when a model disappeared. */
  knownModels(principalId?: string): KnownModel[] {
    const rows = principalId
      ? this.prepared("SELECT * FROM known_models WHERE principal_id = ? ORDER BY first_seen_at ASC, model_id ASC").all(principalId)
      : this.prepared("SELECT * FROM known_models ORDER BY principal_id ASC, first_seen_at ASC, model_id ASC").all();
    return rows.map(knownModelFromRow);
  }

  /** Bootstrap before the daemon's first poll, without credentials or network.
   * Existing events are history; new events from that first poll are eligible.
   * Repeated initialization must not consume undiscovered events. */
  initializeNotificationEvents(): void {
    if (this.daemonState(NOTIFY_DISCOVERY_READY) !== undefined) return;
    this.enqueueNotificationEvents(() => 0, true);
  }

  /** Discover inserted facts independently of vendor clocks. A private marker
   * survives deletion and VACUUM (events has no INTEGER PRIMARY KEY, so rowid
   * is not durable). Marking and ledger enqueue share one transaction. This
   * scans event metadata, like the prior timestamp-in-metadata query did.
   * The callback is synchronous; transport runs only after commit. Undefined
   * means first use, when historical backlog is intentionally skipped. */
  enqueueNotificationEvents(enqueue: (events: HeadroomEvent[] | undefined) => number, initializeOnly = false): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const initialized = this.daemonState(NOTIFY_DISCOVERY_READY) !== undefined;
      if (initializeOnly && initialized) { this.db.exec("COMMIT"); return 0; }
      const events = initialized ? this.prepared(`SELECT * FROM events WHERE ${UNDISCOVERED_EVENT} ORDER BY rowid`).all().map(eventFromRow) : undefined;
      const queued = enqueue(events);
      if (!Number.isFinite(queued)) throw new Error("notification enqueue callback must return a synchronous count");
      this.prepared(`UPDATE events SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$._notify_seen', 1) WHERE ${UNDISCOVERED_EVENT}`).run();
      this.setDaemonState(NOTIFY_DISCOVERY_READY, "true");
      this.db.exec("COMMIT");
      return queued;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  /** Free-form daemon-owned key/value state, backed by the same daemon_state
   * table the Claude probe hashes and the MCP backoff already use. The
   * notifier keeps its initialization state here. */
  daemonState(key: string): string | undefined {
    const row = this.prepared("SELECT value FROM daemon_state WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  }

  setDaemonState(key: string, value: string): void {
    this.prepared("INSERT INTO daemon_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Every persisted `source_health:` marker (notify.ts's source-health
   * hysteresis, keyed by outage event and its semantic window), for the notifier's per-poll sweep. Mirrors
   * planDowngrades()'s own daemon_state prefix scan. This is notify-layer-only
   * state: the events table remains the complete, undamped truth record of
   * every source_failed/source_recovered transition regardless of what the
   * notifier has decided to hold back so far. */
  sourceHealthPending(): Array<{ key: string; value: string }> {
    return this.prepared("SELECT key, value FROM daemon_state WHERE key LIKE 'source_health:%'").all()
      .map((row) => ({ key: String(row.key), value: String(row.value) }))
      .filter((row) => row.value !== "");
  }

  /** The failed observation that opened one source outage. A source_failed
   * event has one opening observation; later failed polls extend only its
   * `last_seen_at`, keeping this a stable outage identity. */
  sourceHealthOutage(eventId: string): SourceHealthOutage | undefined {
    const row = this.prepared(`SELECT e.id AS event_id, e.meter_id, e.created_at, e.last_seen_at, o.window_json
      FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.id = ? AND e.kind = 'source_failed'
      ORDER BY o.id ASC LIMIT 1`).get(eventId);
    if (!row || typeof row.event_id !== "string" || typeof row.meter_id !== "string" || typeof row.created_at !== "string") return undefined;
    return {
      event_id: row.event_id,
      meter_id: row.meter_id,
      window: row.window_json ? parseJson<Observation["window"]>(row.window_json, null) : null,
      created_at: row.created_at,
      last_seen_at: typeof row.last_seen_at === "string" ? row.last_seen_at : row.created_at,
    };
  }

  private sourceHealthOutageClosedBefore(outage: SourceHealthOutage, before?: string): boolean {
    const ending = before ? "AND e.created_at < ?" : "";
    if (!outage.window) {
      // This mirrors recoverWindowlessFailure(): a whole-meter outage closes
      // on the next genuine source-recovered transition, regardless of the
      // window that finally answered.
      const row = this.prepared(`SELECT 1 FROM events e WHERE e.meter_id = ? AND e.kind = 'source_recovered'
        AND e.created_at > ? ${ending} LIMIT 1`).get(outage.meter_id, outage.created_at, ...(before ? [before] : []));
      return Boolean(row);
    }
    const match = windowSqlMatch(outage.window, "o.window_json");
    const row = this.prepared(`SELECT 1 FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.meter_id = ? AND e.kind = 'source_recovered' AND e.created_at > ? ${ending}
        AND o.freshness = 'fresh' AND ${match.sql}
      LIMIT 1`).get(outage.meter_id, outage.created_at, ...(before ? [before] : []), ...match.params);
    return Boolean(row);
  }

  /** The matching source outage only while it remains open. This is scoped by
   * the failure's own semantic window: a newer fresh weekly row cannot hide
   * an open failed 5h row, and vice versa. */
  sourceHealthOpenOutage(eventId: string): SourceHealthOutage | undefined {
    const outage = this.sourceHealthOutage(eventId);
    return outage && !this.sourceHealthOutageClosedBefore(outage) ? outage : undefined;
  }

  /** Every source failure that the supplied recovery closes. This also finds
   * failures delivered before source-health state existed, so an upgraded
   * daemon can still deliver their legitimate recovery per channel. */
  sourceHealthOutagesRecoveredBy(recoveryEventId: string): SourceHealthOutage[] {
    const recovery = this.prepared(`SELECT e.meter_id, e.created_at, o.window_json
      FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.id = ? AND e.kind = 'source_recovered' AND o.freshness = 'fresh'
      ORDER BY o.id DESC LIMIT 1`).get(recoveryEventId);
    if (!recovery || typeof recovery.meter_id !== "string" || typeof recovery.created_at !== "string") return [];
    const recoveryMeter = recovery.meter_id;
    const recoveryCreated = recovery.created_at;
    const window = recovery.window_json ? parseJson<Observation["window"]>(recovery.window_json, null) : null;
    const candidates = this.prepared("SELECT id FROM events WHERE meter_id = ? AND kind = 'source_failed' AND created_at < ? ORDER BY created_at ASC, id ASC")
      .all(recoveryMeter, recoveryCreated)
      .flatMap((row) => typeof row.id === "string" ? [row.id] : [])
      .map((id) => this.sourceHealthOutage(id))
      .filter((outage): outage is SourceHealthOutage => Boolean(outage))
      .filter((outage) => !outage.window || sameSemanticWindow(outage.window, window));
    return candidates.filter((outage) => !this.sourceHealthOutageClosedBefore(outage, recoveryCreated));
  }

  /** Atomically reserves an interval before a caller starts asynchronous
   * work. Keeping the reservation after a failed read prevents overlapping
   * polls (or separate CLI processes) from repeatedly retrying a bad source.
   * A backwards wall-clock step (an NTP correction, a manual clock change)
   * makes `now - previousAt` negative rather than merely small -- treated as
   * an already-expired interval (the stored timestamp can no longer be
   * trusted as recent), not as "not due until the clock catches back up to
   * the old future-dated claim", which would otherwise suppress the next
   * poll or maintenance pass for as long as the clock had jumped back. */
  claimDaemonInterval(key: string, now: Date, intervalMs: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.daemonState(key);
      const previousAt = previous ? Date.parse(previous) : Number.NaN;
      const elapsedMs = now.getTime() - previousAt;
      if (Number.isFinite(previousAt) && elapsedMs >= 0 && elapsedMs < intervalMs) {
        this.db.exec("COMMIT");
        return false;
      }
      this.setDaemonState(key, now.toISOString());
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  /**
   * A vendor reset instant is presentation data, not a reliable identity:
   * some endpoints calculate it relative to each read. Keep one canonical,
   * minute-granular instant for the active meter/window in durable daemon
   * state. A nearby report is the same window; a report more than five
   * minutes away starts the next one.
   */
  windowKey(meterId: string, windowMinutes: number | null | undefined, resetsAt: string | null | undefined): string {
    const minutes = windowMinutes ?? 0;
    if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return `${meterId}:${minutes}:unknown`;
    const stateKey = `window_key:${meterId}:${minutes}`;
    const reported = Math.floor(Date.parse(resetsAt) / 60_000) * 60_000;
    const prior = this.daemonState(stateKey);
    const priorAt = prior ? Date.parse(prior) : Number.NaN;
    const canonical = Number.isFinite(priorAt) && Math.abs(reported - priorAt) <= 5 * 60_000
      ? priorAt : reported;
    const iso = new Date(canonical).toISOString();
    if (iso !== prior) this.setDaemonState(stateKey, iso);
    return `${meterId}:${minutes}:${iso}`;
  }

  /**
   * Notification delivery ledger (src/notify.ts). One row per event per
   * channel, so an event that was already delivered is never delivered twice
   * however often the daemon re-reads it: the (event_id, channel) uniqueness
   * constraint, not the caller, is what makes that true.
   */
  notifyEnqueue(eventId: string, channel: string, text: string, at: string): void {
    this.prepared("INSERT OR IGNORE INTO notify_ledger (event_id,channel,status,attempts,text,detail,created_at,updated_at) VALUES (?,?,'pending',0,?,NULL,?,?)")
      .run(eventId, channel, text, at, at);
  }

  /** A visible audit row for a notification that the delivery safety net
   * deliberately held back. */
  notifySuppress(eventId: string, channel: string, text: string, detail: string, at: string): void {
    this.prepared("INSERT OR IGNORE INTO notify_ledger (event_id,channel,status,attempts,text,detail,created_at,updated_at) VALUES (?,?,'suppressed',0,?,?,?,?)")
      .run(eventId, channel, text, detail, at, at);
  }

  /** The payload contains the stable semantic delivery identity. Keeping this
   * lookup in the store makes the six-hour guard independent of event IDs. */
  notifySentSince(channel: string, deliveryIdentity: string, since: string): boolean {
    const rows = this.prepared("SELECT text FROM notify_ledger WHERE channel = ? AND status = 'sent' AND updated_at >= ?").all(channel, since);
    return rows.some((row) => {
      try { return (JSON.parse(String(row.text)) as { delivery_identity?: unknown }).delivery_identity === deliveryIdentity; }
      catch { return false; }
    });
  }

  /** The latest delivered rendered message for exactly one meter/window.
   * Payload fields are intentionally inspected here instead of adding another
   * schema column, so older ledgers stay readable during upgrades. */
  notifyLastSentForWindow(channel: string, meter: string, windowKey: string): NotifyDelivery | undefined {
    const rows = this.prepared("SELECT * FROM notify_ledger WHERE channel = ? AND status = 'sent' ORDER BY updated_at DESC, id DESC").all(channel);
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row.text)) as { meter?: unknown; window_key?: unknown };
        if (payload.meter === meter && payload.window_key === windowKey) return notifyFromRow(row);
      } catch { /* Legacy plain-text rows have no window scope. */ }
    }
    return undefined;
  }

  /** Lookup for a deterministic notification identity. Projection delivery
   * uses this ledger state to allow one plain alert and one escalation. */
  notifyDelivery(eventId: string, channel: string): NotifyDelivery | undefined {
    const row = this.prepared("SELECT * FROM notify_ledger WHERE event_id = ? AND channel = ?").get(eventId, channel);
    return row ? notifyFromRow(row) : undefined;
  }

  /** Queued rows for one channel, oldest first: a single new event, or every
   * event a quiet-hours window held back, which the caller sends as one
   * batched message. */
  notifyPending(channel: string, maxAttempts = 3, limit = 100): NotifyDelivery[] {
    return this.prepared("SELECT * FROM notify_ledger WHERE channel = ? AND status = 'pending' AND attempts < ? ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(channel, maxAttempts, limit).map(notifyFromRow);
  }

  notifyDelivered(ids: number[], at: string): void {
    if (!ids.length) return;
    this.prepared(`UPDATE notify_ledger SET status = 'sent', detail = NULL, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(at, ...ids);
  }

  /** One failed attempt for each row: the attempt counter carries the retry
   * budget, and a row that exhausts it stops being pending so the next poll
   * does not pick it up again. */
  notifyAttemptFailed(ids: number[], detail: string, at: string, maxAttempts = 3): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    this.prepared(`UPDATE notify_ledger SET attempts = attempts + 1, detail = ?, updated_at = ?,
      status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END WHERE id IN (${placeholders})`).run(detail, at, maxAttempts, ...ids);
  }

  notifyLedger(limit = 20): NotifyDelivery[] {
    return this.prepared("SELECT * FROM notify_ledger ORDER BY updated_at DESC, id DESC LIMIT ?").all(limit).map(notifyFromRow);
  }

  private expireLeases(now = new Date()): void {
    const at = now.toISOString();
    const expired = this.prepared("SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.ended_at IS NULL AND l.expires_at <= ? GROUP BY l.id").all(at).map(leaseFromRow);
    for (const lease of expired) {
      this.prepared("UPDATE leases SET ended_at = ?, ended_reason = 'expired' WHERE id = ? AND ended_at IS NULL").run(at, lease.id);
      this.addLeaseEvent("lease_ended", { ...lease, ended_at: at, ended_reason: "expired" });
    }
  }

  private addLeaseEvent(kind: Extract<EventKind, "lease_started" | "lease_ended">, lease: Lease): void {
    const at = lease.ended_at ?? lease.started_at;
    this.prepared("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`${kind}:${lease.id}:${at}`, kind, "vendor_reported", 1, "[]", at, null, lease.meter_id, null, lease.ended_reason ?? displayLeaseNote(lease.note));
  }

  /** actionClass is appended last (not inserted before `now`) so every
   * existing positional caller -- direct or through a test's fixed clock --
   * keeps working unchanged and simply gets a null action_class. */
  startLease(owner: string, meterId: string, expectedPercent: number | null, ttlMs: number, note: string | null, now = new Date(), actionClass: string | null = null): Lease {
    if (!owner.trim() || !meterId.trim()) throw new Error("owner and meter are required");
    if (expectedPercent !== null && (!Number.isFinite(expectedPercent) || expectedPercent < 0 || expectedPercent > 100)) throw new Error("expected percent must be 0 through 100");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttl must be positive");
    this.expireLeases(now);
    const lease: Lease = { id: randomUUID(), owner: owner.trim(), meter_id: meterId.trim(), expected_percent: expectedPercent, note, action_class: actionClass && actionClass.trim() ? actionClass.trim() : null, started_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMs).toISOString(), ended_at: null, ended_reason: null, spent_percent: 0 };
    this.prepared("INSERT INTO leases (id,owner,meter_id,expected_percent,note,action_class,started_at,expires_at,ended_at,ended_reason) VALUES (?,?,?,?,?,?,?,?,?,?)").run(lease.id, lease.owner, lease.meter_id, lease.expected_percent, lease.note, lease.action_class, lease.started_at, lease.expires_at, null, null);
    this.addLeaseEvent("lease_started", lease);
    return lease;
  }

  /**
   * Re-evaluate an admission decision and create every resulting meter lease
   * under one SQLite write lock. `can`/`gate` are useful advice by themselves,
   * but a separate check followed by `startLease` lets two processes both see
   * the same capacity and both reserve it. Callers must keep `evaluate`
   * synchronous and read only this store, so the whole decision observes one
   * lease set while BEGIN IMMEDIATE excludes a competing admission.
   *
   * A denied decision rolls back rather than committing incidental expiry
   * cleanup. Expired rows are still ignored by every read through their
   * expires_at predicate, and the next successful write records their normal
   * lease-ended event.
   */
  admitAndStartLeases<T extends { allowed: boolean }>(
    evaluate: () => T,
    owner: string,
    meterIds: string[] | ((decision: T) => string[]),
    expectedPercent: number | null,
    ttlMs: number,
    note: string | null,
    now = new Date(),
    actionClass: string | null = null,
  ): { decision: T; leases: Lease[] } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const decision = evaluate();
      if (decision.allowed !== true) {
        this.db.exec("ROLLBACK");
        return { decision, leases: [] };
      }
      const selectedMeters = typeof meterIds === "function" ? meterIds(decision) : meterIds;
      const uniqueMeters = [...new Set(selectedMeters.map((meter) => meter.trim()).filter(Boolean))];
      if (!uniqueMeters.length) throw new Error("at least one meter is required");
      const groupedNote = atomicLeaseGroupNote(randomUUID(), note);
      const leases = uniqueMeters.map((meterId) => this.startLease(owner, meterId, expectedPercent, ttlMs, groupedNote, now, actionClass));
      this.db.exec("COMMIT");
      return { decision, leases: leases.map((lease) => ({ ...lease, note: displayLeaseNote(lease.note) })) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* The failed BEGIN/COMMIT already closed it. */ }
      throw error;
    }
  }

  endLease(id: string, owner: string, force = false, now = new Date()): Lease {
    if (!owner.trim()) throw new Error("owner is required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.expireLeases(now);
      const row = this.prepared("SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.id = ? GROUP BY l.id").get(id);
      if (!row) throw new Error("lease not found");
      const lease = leaseFromRow(row);
      if (lease.ended_at) {
        this.db.exec("COMMIT");
        return { ...lease, already_ended: true };
      }
      if (owner !== lease.owner && !force) throw new Error("refusing another owner's lease; pass --force");
      const rawNote = string(row.note);
      const group = atomicLeaseGroup(rawNote);
      const members = group
        ? this.prepared("SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.note = ? AND l.owner = ? AND l.ended_at IS NULL GROUP BY l.id").all(rawNote, lease.owner).map(leaseFromRow)
        : [lease];
      const at = now.toISOString();
      let returned: Lease | undefined;
      for (const member of members) {
        const ended = { ...member, ended_at: at, ended_reason: "ended" };
        this.prepared("UPDATE leases SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL").run(ended.ended_at, ended.ended_reason, member.id);
        this.addLeaseEvent("lease_ended", ended);
        if (member.id === id) returned = ended;
      }
      this.db.exec("COMMIT");
      return returned ?? { ...lease, ended_at: at, ended_reason: "ended" };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  leases(meterId?: string, activeOnly = false, now = new Date()): Lease[] {
    this.expireLeases(now);
    return this.selectLeases(meterId, activeOnly, now);
  }

  /**
   * The same lease view as `leases()`, without its `expireLeases()` write.
   * For a read-only connection (the cached-fallback path in cli.ts/mcp.ts,
   * opened with `openReadOnly()`) that must never write: a lease past its
   * expiry but not yet marked ended is simply excluded by the same
   * `activeOnly` filter `leases()` applies right after expiring it, so the
   * two agree on which leases are usable for a decision -- only the
   * `ended_at`/`lease_ended` bookkeeping itself is deferred to the next
   * writable open, exactly like any other write a read-only caller defers.
   */
  leasesReadOnly(meterId?: string, activeOnly = false, now = new Date()): Lease[] {
    return this.selectLeases(meterId, activeOnly, now);
  }

  private selectLeases(meterId: string | undefined, activeOnly: boolean, now: Date): Lease[] {
    const filter = [meterId ? "l.meter_id = ?" : "", activeOnly ? "l.ended_at IS NULL AND l.expires_at > ?" : ""].filter(Boolean).join(" AND ");
    const params = [...(meterId ? [meterId] : []), ...(activeOnly ? [now.toISOString()] : [])];
    return this.prepared(`SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id ${filter ? `WHERE ${filter}` : ""} GROUP BY l.id ORDER BY l.started_at DESC`).all(...params).map(leaseFromRow);
  }

  /* -----------------------------------------------------------------------
   * Orchestrator heartbeats and named wake-ups (timers). See migrations.ts's
   * ADD_HEARTBEATS_AND_TIMERS for the schema and the reasoning: the daemon is
   * the one process that survives a crashed orchestrator session, so it
   * holds both.
   * -------------------------------------------------------------------- */

  /** True once this connection's own schema includes the heartbeats/timers
   * tables. `open()` always migrates up first, so this is only ever false on
   * a read-only, non-migrating connection (`openReadOnly()`) against a
   * database a pre-0.2.0 daemon wrote and nothing has migrated since --
   * queried by `heartbeats()`/`timers()` below so the cached-status path
   * (mcp.ts's `cacheStatus`, cli.ts's `observe()`) reads that compatibility
   * gap as "none registered" instead of throwing "no such table". */
  private hasHeartbeatSchema(): boolean {
    return this.schemaVersion() >= HEARTBEATS_SCHEMA_VERSION;
  }

  private addHeartbeatEvent(kind: Extract<EventKind, "heartbeat_lapsed" | "heartbeat_restored">, heartbeat: Heartbeat, at: string): void {
    const metadata: NonNullable<HeadroomEvent["metadata"]> = { owner: heartbeat.owner, interval_ms: heartbeat.interval_ms, last_beat_at: heartbeat.last_beat_at, ...(kind === "heartbeat_lapsed" ? { resume_sentence: heartbeat.resume_sentence } : {}) };
    // Deterministic on (kind, owner, the beat instant the lapse/restore is
    // about): a lapse and the restore that later closes it always get
    // different last_beat_at values (a beat updates last_beat_at before the
    // lapse marker is ever read again), so this stays idempotent under
    // INSERT OR IGNORE the same way addModelEvent's ids do, without ever
    // colliding a lapse with the restore that follows it.
    this.db.prepare("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`${kind}:${heartbeat.owner}:${heartbeat.last_beat_at}`, kind, "vendor_reported", 1, "[]", at, null, null, null, heartbeat.owner, null, JSON.stringify(metadata));
  }

  private heartbeatRow(owner: string): Heartbeat | undefined {
    const row = this.db.prepare("SELECT * FROM heartbeats WHERE owner = ?").get(owner);
    return row ? heartbeatFromRow(row) : undefined;
  }

  /**
   * Records or refreshes one owner's heartbeat lease. `resumeSentence`
   * `undefined` keeps whatever was registered before (a plain re-beat need
   * not repeat it); `null` clears it explicitly. A beat that finds this
   * heartbeat currently lapsed closes the lapse immediately -- rather than
   * waiting for the next poll's checkHeartbeatLapses to notice -- and emits
   * exactly one `heartbeat_restored` event for it.
   */
  heartbeatBeat(owner: string, intervalMs: number, resumeSentence: string | null | undefined, now = new Date()): Heartbeat {
    const trimmed = owner.trim();
    if (!trimmed) throw new Error("owner is required");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("interval must be positive");
    const at = now.toISOString();
    const existing = this.heartbeatRow(trimmed);
    if (existing?.lapsed_since) this.addHeartbeatEvent("heartbeat_restored", existing, at);
    const resume = resumeSentence === undefined ? existing?.resume_sentence ?? null : resumeSentence;
    this.db.prepare(`INSERT INTO heartbeats (owner,interval_ms,resume_sentence,started_at,last_beat_at,lapsed_since,updated_at) VALUES (?,?,?,?,?,NULL,?)
      ON CONFLICT(owner) DO UPDATE SET interval_ms = excluded.interval_ms, resume_sentence = excluded.resume_sentence, last_beat_at = excluded.last_beat_at, lapsed_since = NULL, updated_at = excluded.updated_at`)
      .run(trimmed, Math.round(intervalMs), resume, existing?.started_at ?? at, at, at);
    return this.heartbeatRow(trimmed)!;
  }

  /** Deregisters a heartbeat lease. Returns false when there was none --
   * an idempotent stop is not an error. Does not itself emit
   * `heartbeat_restored`: a deliberate stop is not a recovery worth a
   * notification, and a lapsed heartbeat that is simply stopped should stay
   * silent rather than announce a restore that never happened. */
  heartbeatStop(owner: string): boolean {
    const trimmed = owner.trim();
    if (!trimmed) throw new Error("owner is required");
    if (!this.heartbeatRow(trimmed)) return false;
    this.db.prepare("DELETE FROM heartbeats WHERE owner = ?").run(trimmed);
    return true;
  }

  /** Every registered heartbeat, most recently updated first. Reads as empty
   * on a pre-migration-4 schema (see hasHeartbeatSchema()) rather than
   * throwing "no such table". */
  heartbeats(): Heartbeat[] {
    if (!this.hasHeartbeatSchema()) return [];
    return this.db.prepare("SELECT * FROM heartbeats ORDER BY updated_at DESC").all().map(heartbeatFromRow);
  }

  /**
   * The daemon's per-poll pass: every heartbeat not already marked lapsed
   * whose last beat is now overdue by more than 2x its own interval gets
   * `lapsed_since` set to `now` and exactly one `heartbeat_lapsed` event --
   * INSERT OR IGNORE on addHeartbeatEvent's deterministic id means a poll
   * that somehow runs twice for the same lapse still produces only one.
   * Never called from a beat/stop path, only from the daemon's own poll
   * loop, so a heartbeat never lapses because a caller happened to invoke
   * this at an unusual moment.
   */
  checkHeartbeatLapses(now = new Date()): void {
    const at = now.toISOString();
    for (const row of this.db.prepare("SELECT * FROM heartbeats WHERE lapsed_since IS NULL").all()) {
      const heartbeat = heartbeatFromRow(row);
      const elapsedMs = now.getTime() - Date.parse(heartbeat.last_beat_at);
      if (!Number.isFinite(elapsedMs) || elapsedMs <= heartbeat.interval_ms * 2) continue;
      this.db.prepare("UPDATE heartbeats SET lapsed_since = ?, updated_at = ? WHERE owner = ? AND lapsed_since IS NULL").run(at, at, heartbeat.owner);
      this.addHeartbeatEvent("heartbeat_lapsed", heartbeat, at);
    }
  }

  /** True while `owner` has a registered heartbeat currently considered
   * lapsed. An owner with no heartbeat at all is never "lapsed" -- that is
   * simply an orchestrator that never opted in, not a missed one. */
  heartbeatLapsed(owner: string): boolean {
    return this.heartbeatRow(owner.trim())?.lapsed_since != null;
  }

  private addTimerMissedEvent(timer: Timer, at: string): void {
    const metadata: NonNullable<HeadroomEvent["metadata"]> = { owner: timer.owner, timer_name: timer.name, action: timer.action };
    // meter_id and principal_id are both null, same as addHeartbeatEvent
    // above: the owner is an orchestrator identity, not a vendor account or
    // meter, so it belongs only in `reason`/metadata, never in the column a
    // reader would otherwise read as "this event is about that principal".
    this.db.prepare("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`timer_missed:${timer.owner}:${timer.name}:${timer.at}`, "timer_missed", "vendor_reported", 1, "[]", at, null, null, null, timer.owner, null, JSON.stringify(metadata));
  }

  /** Registers (or replaces, by the same owner+name) one named wake-up. A
   * timer already fired or cleared under this owner+name is simply replaced
   * by the new one, same as re-registering any other schedule -- attempts
   * and failed_at reset too, so a re-set timer always gets a fresh delivery
   * budget, and so do claimed_at/claim_token/delivery_id: an in-flight
   * delivery of the OLD registration must never be able to confirm the NEW
   * one as fired (its claim_token no longer matches any live row), and a
   * fresh delivery_id means its inbox identity can never collide with
   * whatever the old registration's own (possibly still in-flight) delivery
   * already wrote.
   *
   * `owner` must be a valid inbox session id (the same SESSION_ID_PATTERN
   * rule inbox.ts's own assertSessionId enforces) since a timer is always
   * delivered there -- refused up front rather than stored and left to fail
   * every delivery attempt forever. Likewise, the exact file
   * `src/inbox.ts`'s `sendInboxMessageAt` will write for delivery --
   * envelope wrapper, pretty-print whitespace, and all, not just the inner
   * `{ timer, at, action }` body -- must already fit under the inbox's own
   * per-message byte cap, checked here (via the same `serializeInboxEnvelope`
   * inbox.ts itself writes with) before the row is ever stored, rather than
   * discovered only once delivery starts failing and readInbox() silently
   * refuses the oversized file it already wrote. */
  setTimer(owner: string, name: string, at: string, action: string, ifMissed: "notify" | "drop", now = new Date()): Timer {
    const trimmedOwner = owner.trim();
    const trimmedName = name.trim();
    if (!trimmedOwner || !trimmedName) throw new Error("owner and name are required");
    if (!SESSION_ID_PATTERN.test(trimmedOwner) || isReservedSessionId(trimmedOwner)) throw new Error("owner must be a valid inbox session id: 1 to 64 characters of A-Z a-z 0-9 . _ - (not a bare . or ..), since a timer is delivered there");
    if (!action.trim()) throw new Error("action is required");
    if (!Number.isFinite(Date.parse(at))) throw new Error("at must be a valid ISO instant");
    const isoAt = new Date(at).toISOString();
    const deliveryId = generateTimerDeliveryId();
    // The real send (src/heartbeat.ts's fireDueTimers) uses `now.toISOString()`
    // at delivery time, not this one -- but every ISO instant serializes to
    // the same 24-character length, so this estimate's byte count is exact
    // regardless of the gap between "set" and "delivered".
    const fileText = serializeInboxEnvelope({ kind: TIMER_DELIVERY_KIND, to: trimmedOwner, from: TIMER_DELIVERY_FROM, at: now.toISOString(), deliveryId, body: { timer: trimmedName, at: isoAt, action } });
    const fileBytes = Buffer.byteLength(fileText, "utf8");
    if (fileBytes > SAFE_READ_MAX_BYTES) throw new Error(`timer action is too large to ever be delivered: the serialized inbox file would be ${fileBytes} bytes, over the ${SAFE_READ_MAX_BYTES} byte cap`);
    const createdAt = now.toISOString();
    this.db.prepare(`INSERT INTO timers (owner,name,at,action,if_missed,created_at,fired_at,cleared_at,attempts,failed_at,claimed_at,claim_token,delivery_id) VALUES (?,?,?,?,?,?,NULL,NULL,0,NULL,NULL,NULL,?)
      ON CONFLICT(owner,name) DO UPDATE SET at = excluded.at, action = excluded.action, if_missed = excluded.if_missed, created_at = excluded.created_at, fired_at = NULL, cleared_at = NULL, attempts = 0, failed_at = NULL, claimed_at = NULL, claim_token = NULL, delivery_id = excluded.delivery_id`)
      .run(trimmedOwner, trimmedName, isoAt, action, ifMissed, createdAt, deliveryId);
    return timerFromRow(this.db.prepare("SELECT * FROM timers WHERE owner = ? AND name = ?").get(trimmedOwner, trimmedName)!);
  }

  /** Pending timers (never fired, never cleared, never given up on) for one
   * owner, or every owner's when omitted, soonest due first. Below
   * HEARTBEATS_SCHEMA_VERSION (the `timers` table does not exist at all)
   * this reads as empty rather than throwing "no such table". Between that
   * and TIMER_DELIVERY_SCHEMA_VERSION (the table exists but not yet its
   * `failed_at` column) the `failed_at IS NULL` term is dropped from the
   * query instead of throwing "no such column": every pending row on that
   * older shape is genuinely pending, since a database that old can never
   * have given up on one in the first place. `timerFromRow` already
   * synthesizes `attempts: 0, failed_at: null` for a row missing those
   * columns. This never needs to reason about a delivery claim
   * (`claimed_at`/`claim_token`, see claimTimer()'s own doc comment): a
   * timer currently mid-delivery still belongs in this list exactly like
   * any other not-yet-fired one. */
  timers(owner?: string): Timer[] {
    const version = this.schemaVersion();
    if (version < HEARTBEATS_SCHEMA_VERSION) return [];
    const excludeFailed = version >= TIMER_DELIVERY_SCHEMA_VERSION ? " AND failed_at IS NULL" : "";
    const filter = owner ? `WHERE owner = ? AND fired_at IS NULL AND cleared_at IS NULL${excludeFailed}` : `WHERE fired_at IS NULL AND cleared_at IS NULL${excludeFailed}`;
    return this.db.prepare(`SELECT * FROM timers ${filter} ORDER BY at ASC`).all(...(owner ? [owner] : [])).map(timerFromRow);
  }

  /** Pending timers at or past `now`, oldest due first -- the daemon's own
   * per-poll/per-maintenance-pass firing query. Excludes a timer
   * `releaseTimerClaim` has already given up on (`failed_at` set,
   * MAX_TIMER_DELIVERY_ATTEMPTS reached), same as an already-fired or
   * already-cleared one. A timer whose claim (`claimed_at`) is still fresh
   * -- another pass is presumably delivering it right now -- is also
   * excluded; one whose claim has gone stale (older than `claimStaleMs`,
   * covering a hang that never crashed the process outright) is offered up
   * again. Only ever reachable through the daemon's own fully-migrated
   * store (never `openReadOnly()`), so no schema-compat concern here the
   * way `timers()` above has. */
  dueTimers(now = new Date(), claimStaleMs = TIMER_CLAIM_STALE_MS): Timer[] {
    const staleThreshold = new Date(now.getTime() - claimStaleMs).toISOString();
    return this.db.prepare("SELECT * FROM timers WHERE fired_at IS NULL AND cleared_at IS NULL AND failed_at IS NULL AND at <= ? AND (claimed_at IS NULL OR claimed_at <= ?) ORDER BY at ASC")
      .all(now.toISOString(), staleThreshold).map(timerFromRow);
  }

  /**
   * Claims one due timer for delivery, before src/heartbeat.ts's
   * fireDueTimers ever attempts the actual inbox write (filesystem I/O this
   * synchronous store cannot do itself). This is a *recoverable* claim: it
   * records `claimed_at`/a fresh `claim_token`, never the terminal
   * `fired_at` -- that is set later, only by `confirmTimerDelivered`, once
   * the inbox message is actually known durable. A claim a delivery attempt
   * never resolves (process crash, or the daemon's own `stop()` racing this
   * call) is therefore never mistaken for "delivered": it simply goes stale
   * and `dueTimers()` offers the row again once `claimStaleMs` has passed,
   * or immediately once this process restarts (`reclaimStaleTimerClaims()`,
   * called unconditionally on daemon start).
   *
   * The same atomic `UPDATE ... WHERE claimed_at IS NULL OR claimed_at <=
   * ?` guard that makes a stale claim reclaimable is also what makes two
   * overlapping firing passes safe: whichever `UPDATE` lands first wins
   * (`changes` becomes 0 for the loser, which gets `undefined` back), never
   * a duplicate claim. Also raises one `timer_missed` event when
   * `if_missed` is `notify` and this owner's heartbeat is currently lapsed
   * -- `addTimerMissedEvent`'s own deterministic id keeps this idempotent
   * even across a reclaimed retry of the same timer.
   *
   * Returns the claimed row plus its fresh `claim_token` (the caller's
   * proof of this exact claim, required by both `confirmTimerDelivered` and
   * `releaseTimerClaim`), or `undefined` when nothing matched -- already
   * claimed by a concurrent pass, already terminal, or gone.
   */
  claimTimer(owner: string, name: string, now = new Date(), claimStaleMs = TIMER_CLAIM_STALE_MS): ClaimedTimer | undefined {
    const nowIso = now.toISOString();
    const staleThreshold = new Date(now.getTime() - claimStaleMs).toISOString();
    const row = this.db.prepare("SELECT * FROM timers WHERE owner = ? AND name = ? AND fired_at IS NULL AND cleared_at IS NULL AND failed_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)").get(owner, name, staleThreshold);
    if (!row) return undefined;
    const claimToken = randomUUID();
    // A row set before ADD_TIMER_DELIVERY_ID migrated in (delivery_id
    // NULL, the column added with no backfill) gets one assigned right
    // here, atomically with the claim itself -- simpler and safer than
    // ever claiming a row with no delivery identity to hand fireDueTimers.
    const existingDeliveryId = (row as Row).delivery_id;
    const deliveryId = typeof existingDeliveryId === "number" ? existingDeliveryId : generateTimerDeliveryId();
    const claimed = this.db.prepare("UPDATE timers SET claimed_at = ?, claim_token = ?, delivery_id = ? WHERE owner = ? AND name = ? AND fired_at IS NULL AND cleared_at IS NULL AND failed_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)")
      .run(nowIso, claimToken, deliveryId, owner, name, staleThreshold);
    if (Number(claimed.changes) === 0) return undefined; // lost the race to a concurrent claim
    const timer: ClaimedTimer = { ...timerFromRow(row), claim_token: claimToken, delivery_id: deliveryId };
    if (timer.if_missed === "notify" && this.heartbeatLapsed(owner)) this.addTimerMissedEvent(timer, nowIso);
    return timer;
  }

  /** Marks a claimed timer's delivery as durable -- the one and only place
   * `fired_at` is ever set. Called by src/heartbeat.ts's fireDueTimers only
   * after `src/inbox.ts`'s `sendInboxMessageAt` confirms the inbox message
   * itself is on disk (freshly written, or already there from an earlier
   * attempt this same call recognizes and treats as already-delivered --
   * see that function's own doc comment for why that makes the whole
   * claim-deliver-confirm sequence idempotent by timer identity even across
   * a crash-and-retry). Only acts when `claimToken` still matches the live
   * claim: a confirm racing a reclaim that already gave this timer to a
   * different pass is simply a no-op (`false`), never a stale write. */
  confirmTimerDelivered(owner: string, name: string, claimToken: string, now = new Date()): boolean {
    const result = this.db.prepare("UPDATE timers SET fired_at = ?, claimed_at = NULL, claim_token = NULL WHERE owner = ? AND name = ? AND claim_token = ? AND fired_at IS NULL AND cleared_at IS NULL")
      .run(now.toISOString(), owner, name, claimToken);
    return Number(result.changes) > 0;
  }

  /** Releases a claim a delivery attempt is known to have failed (the inbox
   * write itself threw), so a later firing pass sees this timer as pending
   * again immediately, without waiting out `dueTimers()`'s own staleness
   * window -- bounded: this also bumps `attempts`, and once it reaches
   * `maxAttempts` the claim is released into `failed_at` instead of back to
   * pending. `failed_at` permanently excludes the row from
   * `dueTimers`/`nextMaintenanceDeadline` (never a delete -- same reasoning
   * as `fired_at`/`cleared_at`, the row and its now-known reason stay
   * inspectable). Only ever acts on the exact claim it was given
   * (`claimToken` must still match): a timer independently cleared, or
   * reclaimed/confirmed by a different pass in between, is never clobbered
   * by a stale release. Returns `undefined` when that guard did not match
   * (nothing to update), otherwise the attempt count just recorded and
   * whether this call is what gave up on it for good. */
  releaseTimerClaim(owner: string, name: string, claimToken: string, now = new Date(), maxAttempts = MAX_TIMER_DELIVERY_ATTEMPTS): { attempts: number; permanentlyFailed: boolean } | undefined {
    const row = this.db.prepare("SELECT attempts FROM timers WHERE owner = ? AND name = ? AND claim_token = ? AND fired_at IS NULL AND cleared_at IS NULL").get(owner, name, claimToken) as { attempts: number } | undefined;
    if (!row) return undefined;
    const attempts = row.attempts + 1;
    if (attempts >= maxAttempts) {
      this.db.prepare("UPDATE timers SET attempts = ?, failed_at = ?, claimed_at = NULL, claim_token = NULL WHERE owner = ? AND name = ? AND claim_token = ?").run(attempts, now.toISOString(), owner, name, claimToken);
      return { attempts, permanentlyFailed: true };
    }
    this.db.prepare("UPDATE timers SET attempts = ?, claimed_at = NULL, claim_token = NULL WHERE owner = ? AND name = ? AND claim_token = ?").run(attempts, owner, name, claimToken);
    return { attempts, permanentlyFailed: false };
  }

  /** Resets every outstanding delivery claim unconditionally. Called once,
   * by daemon.ts's `start()`, before the maintenance scheduler's first
   * pass -- never during ordinary operation, where `dueTimers()`'s own
   * staleness window (`claimStaleMs`) is what recovers a hung claim instead.
   * A fresh daemon process starting up is proof that any claim found here
   * is orphaned: this daemon refuses to start while another instance
   * already holds its socket (see daemon.ts's `prepareSocket`), so no other
   * process can still be mid-delivery against this store right now.
   * Deliberately does not touch `attempts`/`failed_at`: a reclaimed timer
   * keeps whatever delivery budget it already spent. Returns the number of
   * rows reclaimed, for the caller's own log line. */
  reclaimStaleTimerClaims(): number {
    const result = this.db.prepare("UPDATE timers SET claimed_at = NULL, claim_token = NULL WHERE claimed_at IS NOT NULL AND fired_at IS NULL AND cleared_at IS NULL").run();
    return Number(result.changes);
  }

  /** Idempotent: clearing an already-cleared or already-fired timer is not
   * an error, it simply has nothing left to do. Returns false when no row
   * matched owner+name at all. */
  clearTimer(owner: string, name: string, now = new Date()): boolean {
    const row = this.db.prepare("SELECT * FROM timers WHERE owner = ? AND name = ?").get(owner, name);
    if (!row) return false;
    this.db.prepare("UPDATE timers SET cleared_at = ? WHERE owner = ? AND name = ? AND cleared_at IS NULL").run(now.toISOString(), owner, name);
    return true;
  }

  /**
   * The earliest instant the daemon's own maintenance scheduler (daemon.ts's
   * `scheduleMaintenance`) needs to wake up for: whichever comes first of the
   * soonest pending timer's `at`, or the soonest still-live heartbeat's own
   * lapse deadline (`last_beat_at + interval_ms * 2`, the same threshold
   * `checkHeartbeatLapses` uses). `undefined` when neither a pending timer
   * nor a non-lapsed heartbeat exists -- the scheduler falls back to its own
   * capped default poll in that case rather than sleeping forever, since a
   * `timer_set` or `heartbeat_beat` racing in right after this read must
   * still be picked up promptly.
   */
  nextMaintenanceDeadline(now = new Date()): Date | undefined {
    const soonestTimer = this.db.prepare("SELECT at FROM timers WHERE fired_at IS NULL AND cleared_at IS NULL AND failed_at IS NULL ORDER BY at ASC LIMIT 1").get() as { at: string } | undefined;
    let earliest = soonestTimer ? Date.parse(soonestTimer.at) : undefined;
    for (const row of this.db.prepare("SELECT interval_ms, last_beat_at FROM heartbeats WHERE lapsed_since IS NULL").all() as { interval_ms: number; last_beat_at: string }[]) {
      const deadline = Date.parse(row.last_beat_at) + row.interval_ms * 2;
      if (!Number.isFinite(deadline)) continue;
      if (earliest === undefined || deadline < earliest) earliest = deadline;
    }
    return earliest === undefined ? undefined : new Date(earliest);
  }

  private attributeLeaseSpend(previous: StoredObservation, current: StoredObservation): void {
    if (previous.freshness !== "fresh" || current.freshness !== "fresh" || previous.quantity?.unit !== "percent" || current.quantity?.unit !== "percent") return;
    const delta = current.quantity.used - previous.quantity.used;
    if (!Number.isFinite(delta) || delta <= 0) return;
    const leases = this.leases(current.meter_id, true, new Date(current.fetched_at)).filter((lease) => lease.started_at <= current.fetched_at && lease.expires_at > previous.fetched_at);
    if (!leases.length) return;
    const weights = leases.map((lease) => lease.expected_percent ?? 1);
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return;
    for (let index = 0; index < leases.length; index += 1) this.prepared("INSERT INTO lease_spend (lease_id,meter_id,observation_id,amount_percent,estimated,at) VALUES (?,?,?,?,?,?)").run(leases[index].id, current.meter_id, current.id, delta * weights[index] / total, 1, current.fetched_at);
  }

  /**
   * Books one poll's movement on a hard percent window into `spend_ledger`,
   * attributed to whoever held a lease on that meter while it happened.
   *
   * The delta is measured against the previous FRESH reading of the same
   * meter and window (freshBaseline), not the immediately previous row, so a
   * failed or stale poll in between does not silently drop a window's real
   * movement. A drop is never negative spend: a window whose used percent
   * falls has reset (or had a free reset applied), and the movement across
   * that boundary is not attributable to anyone, so nothing is written at
   * all until the next pair of readings both sit on the same side of it.
   *
   * Unlike lease_spend -- which exists to learn what an action class costs,
   * and so only ever records against a lease -- this ledger is a complete
   * account of the meter itself: a delta nobody had leased still lands, under
   * the `unattributed` owner, so the per-owner shares and the meter's own
   * total can be compared instead of quietly disagreeing.
   */
  private recordSpendLedger(current: StoredObservation): void {
    const window = current.window;
    if (!window || !window.minutes || window.enforcement !== "hard" || window.kind === "state" || window.kind === "count") return;
    if (current.quantity?.unit !== "percent") return;
    const baseline = this.freshBaseline(current);
    if (!baseline || baseline.quantity?.unit !== "percent") return;
    const delta = current.quantity.used - baseline.quantity.used;
    if (!Number.isFinite(delta) || delta <= 0) return;
    const at = new Date(current.fetched_at);
    const owners = this.leases(current.meter_id, true, at)
      .filter((lease) => lease.started_at <= current.fetched_at && lease.expires_at > baseline.fetched_at)
      .map((lease) => ({ owner: lease.owner, expect: lease.expected_percent }));
    for (const share of attributeSpend(delta, owners)) {
      this.prepared("INSERT INTO spend_ledger (meter_id,window_minutes,from_at,to_at,delta_percent,owner,share_percent,confidence) VALUES (?,?,?,?,?,?,?,?)")
        .run(current.meter_id, window.minutes, baseline.fetched_at, current.fetched_at, delta, share.owner, share.share_percent, share.confidence);
    }
    this.pruneSpendLedger(at);
  }

  /** Bounded history: the ledger answers "who spent what recently", never
   * "who spent what ever", so a row older than the retention is dropped on
   * every write rather than accumulating for the life of the database.
   * julianday() rather than a string range, since fetched_at is not
   * guaranteed to carry milliseconds (see eventEvidenceFor). */
  private pruneSpendLedger(now: Date): void {
    const cutoff = new Date(now.getTime() - SPEND_LEDGER_RETENTION_DAYS * 86_400_000).toISOString();
    this.prepared("DELETE FROM spend_ledger WHERE julianday(to_at) < julianday(?)").run(cutoff);
  }

  /**
   * Per-owner attributed spend, grouped by meter and window, newest activity
   * first. `confidence` is the share-weighted mean of the underlying rows'
   * own confidence, so a total dominated by well-attributed deltas is not
   * dragged down by one tiny ambiguous one.
   */
  spendByOwner(options: { meter?: string; owner?: string; since?: string } = {}): SpendRow[] {
    const filters = ["1 = 1"];
    const params: unknown[] = [];
    if (options.meter) { filters.push("meter_id = ?"); params.push(options.meter); }
    if (options.owner) { filters.push("owner = ?"); params.push(options.owner); }
    if (options.since) { filters.push("julianday(to_at) >= julianday(?)"); params.push(options.since); }
    const rows = this.prepared(`SELECT meter_id, window_minutes, owner,
      SUM(share_percent) AS attributed_percent, SUM(share_percent * confidence) AS weighted_confidence,
      COUNT(*) AS samples, MIN(from_at) AS from_at, MAX(to_at) AS to_at
      FROM spend_ledger WHERE ${filters.join(" AND ")}
      GROUP BY meter_id, window_minutes, owner
      ORDER BY MAX(to_at) DESC, meter_id ASC, window_minutes ASC, SUM(share_percent) DESC`).all(...params);
    return rows.map((row) => {
      const attributed = Number(row.attributed_percent ?? 0);
      return {
        meter_id: String(row.meter_id), window_minutes: number(row.window_minutes), owner: String(row.owner),
        attributed_percent: attributed,
        confidence: attributed > 0 ? Number(row.weighted_confidence ?? 0) / attributed : 0,
        samples: Number(row.samples ?? 0), from_at: String(row.from_at), to_at: String(row.to_at),
      };
    });
  }

  /**
   * Latest reset evidence for each current meter/window. An ordinary
   * scheduled reset stays limited to about one window's own duration, same
   * as always; an unscheduled one (issue #20 -- metadata.unscheduled, see
   * classifyUsageDrop) is visible for a flat UNSCHEDULED_RESET_HOURS
   * regardless of the window's own duration, since the whole point of an
   * unscheduled reset is that it broke the "roughly one window" assumption
   * a short window's own bound would otherwise hide it behind within hours.
   * The returned value is a plain ISO string for a scheduled reset, or that
   * string plus resets.ts's marker for an unscheduled one -- see
   * resets.ts's encodeResetSeen/decodeResetSeen for why the flag rides
   * inside the string instead of widening this method's own Map<string,
   * string> return type.
   */
  resetSeenFor(observations: Array<Pick<Observation, "meter_id" | "window" | "resets_at">>, now = new Date()): Map<string, string> {
    const output = new Map<string, string>();
    for (const observation of observations) {
      const minutes = observation.window?.minutes;
      if (!minutes) continue;
      const found = this.latestApplicableResetSeen(observation.meter_id, minutes, observation.resets_at, now);
      if (found) output.set(`${observation.meter_id}:${minutes}`, encodeResetSeen(found.at, found.unscheduled));
    }
    return output;
  }

  /** The newest reset_seen event for this meter+window that is still within
   * ITS OWN applicable visibility window: a flat UNSCHEDULED_RESET_HOURS for
   * one flagged metadata.unscheduled, or the ordinary bound (about one
   * window's own duration back from resets_at) for a plain scheduled one.
   * Walks newest first so a scheduled event too old for its own short bound
   * does not hide an older-but-still-visible unscheduled one underneath it
   * -- the two rules have different lookback lengths, so "the single newest
   * row" and "the newest row that is actually still visible" are not always
   * the same row. */
  private latestApplicableResetSeen(meterId: string, minutes: number, resetsAt: string | null | undefined, now: Date): { at: string; unscheduled: boolean } | undefined {
    const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    const boundedStart = Number.isFinite(reset) ? reset - minutes * 60_000 : now.getTime() - minutes * 60_000;
    const flatStart = now.getTime() - UNSCHEDULED_RESET_HOURS * 3_600_000;
    const since = new Date(Math.min(boundedStart, flatStart)).toISOString();
    const rows = this.prepared(`SELECT e.created_at AS created_at, e.metadata_json AS metadata_json FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.kind = 'reset_seen' AND e.meter_id = ?
        AND CAST(json_extract(o.window_json, '$.minutes') AS INTEGER) = ?
        AND julianday(e.created_at) >= julianday(?) AND julianday(e.created_at) <= julianday(?)
      ORDER BY e.created_at DESC LIMIT 50`).all(meterId, minutes, since, now.toISOString());
    for (const row of rows) {
      const at = String(row.created_at);
      const unscheduled = parseJson<{ unscheduled?: boolean }>(row.metadata_json, {}).unscheduled === true;
      const cutoff = unscheduled ? flatStart : boundedStart;
      if (Date.parse(at) >= cutoff) return { at, unscheduled };
    }
    return undefined;
  }

  /** Latest free-reset evidence for each current meter/window, limited to
   * that window -- unaffected by issue #20's unscheduled marker, which only
   * ever applies to reset_seen (see classifyUsageDrop's own doc comment). */
  freeResetUsedFor(observations: Array<Pick<Observation, "meter_id" | "window" | "resets_at">>, now = new Date()): Map<string, string> {
    return this.eventEvidenceFor("free_reset_used", observations, now);
  }

  private eventEvidenceFor(kind: "reset_seen" | "free_reset_used", observations: Array<Pick<Observation, "meter_id" | "window" | "resets_at">>, now: Date): Map<string, string> {
    const output = new Map<string, string>();
    for (const observation of observations) {
      const minutes = observation.window?.minutes;
      if (!minutes) continue;
      const reset = observation.resets_at ? Date.parse(observation.resets_at) : Number.NaN;
      const start = Number.isFinite(reset) ? reset - minutes * 60_000 : now.getTime() - minutes * 60_000;
      // julianday() rather than a plain string range: an event's created_at is
      // an observation's fetched_at verbatim, which is not guaranteed to carry
      // milliseconds, and ISO timestamps only sort lexicographically when every
      // value shares the same precision.
      const row = this.prepared(`SELECT e.created_at FROM events e
        JOIN json_each(e.evidence_observation_ids) evidence
        JOIN observations o ON o.id = evidence.value
        WHERE e.kind = ? AND e.meter_id = ?
          AND CAST(json_extract(o.window_json, '$.minutes') AS INTEGER) = ?
          AND julianday(e.created_at) >= julianday(?) AND julianday(e.created_at) <= julianday(?)
        ORDER BY e.created_at DESC LIMIT 1`).get(kind, observation.meter_id, minutes, new Date(start).toISOString(), now.toISOString());
      if (row?.created_at && typeof row.created_at === "string") output.set(`${observation.meter_id}:${minutes}`, row.created_at);
    }
    return output;
  }

  /**
   * The most recent unscheduled reset_seen event (metadata.unscheduled,
   * issue #20) for each of the given meters, within the last
   * UNSCHEDULED_RESET_HOURS -- what orchestrator-reads.ts's gate/plan/fill
   * build their own `notices` from. One row per meter, not per meter+window:
   * an orchestrator's own budgeting is per meter, and a meter with more than
   * one unscheduled reset in range only needs the newest one named.
   */
  recentUnscheduledResets(meterIds: string[], now = new Date()): Array<{ meter_id: string; created_at: string }> {
    if (!meterIds.length) return [];
    const since = new Date(now.getTime() - UNSCHEDULED_RESET_HOURS * 3_600_000).toISOString();
    const placeholders = meterIds.map(() => "?").join(",");
    const rows = this.prepared(`SELECT meter_id, MAX(created_at) AS created_at FROM events
      WHERE kind = 'reset_seen' AND meter_id IN (${placeholders})
        AND julianday(created_at) >= julianday(?)
        AND json_extract(metadata_json, '$.unscheduled') = 1
      GROUP BY meter_id ORDER BY meter_id ASC`).all(...meterIds, since);
    return rows.map((row) => ({ meter_id: String(row.meter_id), created_at: String(row.created_at) }));
  }

  audit(caller: string, action: string, meterOrPrincipal: string | null, outcome: string): void {
    this.prepared("INSERT INTO audit (caller,action,meter_or_principal,outcome,at) VALUES (?,?,?,?,?)").run(caller, action, meterOrPrincipal, outcome, new Date().toISOString());
  }

  /**
   * A Claude principal whose Keychain probe was denied or timed out (or whose
   * probe binary was rebuilt, see setProbeBinaryHash) is marked here so the
   * daemon stops attempting that principal's probe -- which would otherwise
   * pop a fresh macOS Keychain dialog on every poll -- until the operator
   * explicitly runs `headroom keychain grant`, which clears the marker.
   */
  keychainGrantNeeded(principalId: string): boolean {
    return this.prepared("SELECT 1 FROM keychain_grants WHERE principal_id = ?").get(principalId) !== undefined;
  }

  keychainGrantReason(principalId: string): string | undefined {
    const row = this.prepared("SELECT reason FROM keychain_grants WHERE principal_id = ?").get(principalId);
    return row ? String(row.reason) : undefined;
  }

  setKeychainGrantNeeded(principalId: string, reason: string, now = new Date()): void {
    this.prepared("INSERT INTO keychain_grants (principal_id, reason, set_at) VALUES (?,?,?) ON CONFLICT(principal_id) DO UPDATE SET reason = excluded.reason, set_at = excluded.set_at")
      .run(principalId, reason, now.toISOString());
  }

  clearKeychainGrantNeeded(principalId: string): void {
    this.prepared("DELETE FROM keychain_grants WHERE principal_id = ?").run(principalId);
  }

  keychainGrantsNeeded(): Array<{ principal_id: string; reason: string; set_at: string }> {
    return this.prepared("SELECT * FROM keychain_grants ORDER BY principal_id ASC").all()
      .map((row) => ({ principal_id: String(row.principal_id), reason: String(row.reason), set_at: String(row.set_at) }));
  }

  /** The Claude Keychain probe binary's last-known sha256, used to detect a
   * rebuild (a new binary) so every Claude principal is marked as needing a
   * fresh grant instead of the daemon silently re-probing with the new
   * binary and popping one dialog per principal per poll. */
  probeBinaryHash(): string | undefined {
    const row = this.prepared("SELECT value FROM daemon_state WHERE key = 'claude_probe_binary_sha256'").get();
    return row ? String(row.value) : undefined;
  }

  setProbeBinaryHash(hash: string): void {
    this.prepared("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_binary_sha256', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  }

  /** The most recent probe binary hash that actually proved itself: recorded
   * after a successful `headroom keychain grant` or a poll that got a real
   * vendor response through it. See syncClaudeGrantState for how this
   * exempts a first-ever sync (no probeBinaryHash yet) from being treated as
   * grant-needed when it is really the same already-trusted binary. */
  probeGrantedHash(): string | undefined {
    const row = this.prepared("SELECT value FROM daemon_state WHERE key = 'claude_probe_granted_sha256'").get();
    return row ? String(row.value) : undefined;
  }

  setProbeGrantedHash(hash: string): void {
    this.prepared("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_granted_sha256', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  }

  /** The probe's designated requirement at the last sync, which is what
   * macOS keys the Keychain ACL on -- see claude.ts's probeSigningIdentity
   * and syncClaudeGrantState. Empty (stored as "") means the probe was
   * ad-hoc signed and has no stable identity to compare against, which is
   * deliberately distinct from "never recorded". */
  probeSigningIdentity(): string | undefined {
    const row = this.prepared("SELECT value FROM daemon_state WHERE key = 'claude_probe_signing_identity'").get();
    if (!row) return undefined;
    const value = String(row.value);
    return value ? value : undefined;
  }

  setProbeSigningIdentity(identity: string): void {
    this.prepared("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_signing_identity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(identity);
  }

  /** The exact probe binary path this Headroom home has ever been granted
   * under, set once by the first successful `headroom keychain grant` (or the
   * first poll that got a real vendor response) and never changed after
   * that on its own. A machine that has both a packaged install and a repo
   * checkout (or two different global installs) can have more than one
   * `headroom-claude-probe` candidate on disk at once; without this pin, the
   * adapter's own resolution order (see claude.ts's keychainHelper) could
   * silently start using a different one than the operator actually granted,
   * which would look identical to a plain probe failure. Once pinned, every
   * probe call uses exactly this path -- see claude.ts's claudeProbe -- and
   * a resolvable-but-different candidate is reported (by doctor) rather than
   * silently substituted. */
  probePath(): string | undefined {
    const row = this.prepared("SELECT value FROM daemon_state WHERE key = 'claude_probe_path'").get();
    return row ? String(row.value) : undefined;
  }

  setProbePath(path: string): void {
    this.prepared("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_path', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(path);
  }

  /**
   * Shared backoff state for a poll path that has no daemon scheduler to
   * enforce it in memory (MCP's direct, no-daemon fallback: see mcp.ts's
   * directStatus). Backed by the same on-disk daemon_state table every other
   * caller of the same database already sees, so repeated MCP tool calls
   * within a poll interval -- or across separate MCP client processes
   * sharing one HEADROOM_HOME -- share one throttle instead of each hammering
   * the vendor independently.
   */
  directPollBackoff(): { lastPollAt: number; until: number; failures: number } {
    const row = this.prepared("SELECT value FROM daemon_state WHERE key = 'mcp_direct_poll_backoff'").get();
    if (!row) return { lastPollAt: 0, until: 0, failures: 0 };
    try {
      const parsed = JSON.parse(String(row.value)) as { lastPollAt?: number; until?: number; failures?: number };
      return { lastPollAt: Number(parsed.lastPollAt) || 0, until: Number(parsed.until) || 0, failures: Number(parsed.failures) || 0 };
    } catch { return { lastPollAt: 0, until: 0, failures: 0 }; }
  }

  setDirectPollBackoff(state: { lastPollAt: number; until: number; failures: number }): void {
    this.prepared("INSERT INTO daemon_state (key, value) VALUES ('mcp_direct_poll_backoff', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(state));
  }

  /**
   * Raw spend_ledger rows for `headroom export`'s spend kind: one row per
   * booked movement, not grouped by owner the way spendByOwner() is, so
   * export can hand back every movement's own from_at/to_at/delta_percent
   * instead of a pre-aggregated total. since/until are compared against
   * to_at (the timestamp each row's movement completed at), matching
   * spendByOwner's own convention; spend_ledger has no principal_id column,
   * so export applies no principal filter here.
   */
  spendLedgerRows(options: { since?: string; until?: string; meter?: string } = {}): Array<{ id: number; meter_id: string; window_minutes: number | null; from_at: string; to_at: string; delta_percent: number; owner: string; share_percent: number; confidence: number }> {
    const filters = ["1 = 1"];
    const params: unknown[] = [];
    if (options.meter) { filters.push("meter_id = ?"); params.push(options.meter); }
    if (options.since) { filters.push("julianday(to_at) >= julianday(?)"); params.push(options.since); }
    if (options.until) { filters.push("julianday(to_at) <= julianday(?)"); params.push(options.until); }
    return this.prepared(`SELECT id, meter_id, window_minutes, from_at, to_at, delta_percent, owner, share_percent, confidence
      FROM spend_ledger WHERE ${filters.join(" AND ")} ORDER BY to_at ASC, id ASC`).all(...params)
      .map((row) => ({
        id: Number(row.id), meter_id: String(row.meter_id), window_minutes: number(row.window_minutes),
        from_at: String(row.from_at), to_at: String(row.to_at), delta_percent: Number(row.delta_percent),
        owner: String(row.owner), share_percent: Number(row.share_percent), confidence: Number(row.confidence),
      }));
  }

  /**
   * The newest FRESH reading of each given meter and window from the last 7
   * days, keyed by `${meter_id}:${minutes}` (matching burnRateFor()'s own
   * key scheme) -- so a caller whose live read of that same window just came
   * back failed or stale can still show its last real number and how old it
   * is. `pace.ts`'s withLastKnown() is the pure step that attaches this to
   * an observation; this method is only the read.
   *
   * A windowless observation (`window: null`, what a Keychain grant or
   * transport failure produces -- the failure speaks for the whole meter,
   * not one window of it) is keyed `${meter_id}:none` instead, and its
   * reading is looked up across every window of that meter rather than one:
   * the tightest window (smallest minutes, i.e. the nearest reset) that
   * still has a fresh reading in range wins, and the reading carries
   * `window_minutes` so a caller knows which window it describes.
   *
   * Local pools (window kind `state`) and credit counts (kind `count`) are
   * skipped throughout: neither carries a used percent, so there is nothing
   * here for either to show. A meter and window with nothing fresh in range
   * is simply absent from the returned map -- the caller's null.
   */
  lastKnownFor(observations: Array<Pick<Observation, "meter_id" | "window">>, now = new Date()): Map<string, LastKnownReading> {
    const output = new Map<string, LastKnownReading>();
    const seen = new Set<string>();
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const readingFrom = (row: Row | undefined): { reading: Omit<LastKnownReading, "window_minutes">; windowMinutes: number | null } | undefined => {
      if (!row) return undefined;
      const stored = observationFromRow(row);
      if (stored.quantity?.unit !== "percent") return undefined;
      const observedMs = Date.parse(stored.observed_at);
      if (!Number.isFinite(observedMs)) return undefined;
      return {
        reading: {
          used_percent: stored.quantity.used, resets_at: stored.resets_at, observed_at: stored.observed_at,
          age_seconds: Math.max(0, Math.round((now.getTime() - observedMs) / 1000)),
        },
        windowMinutes: stored.window?.minutes ?? null,
      };
    };
    for (const observation of observations) {
      const window = observation.window;
      if (window === null) {
        const key = `${observation.meter_id}:none`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = this.prepared(`SELECT * FROM observations WHERE meter_id = ?
          AND window_json IS NOT NULL AND window_json <> 'null'
          AND json_extract(window_json, '$.kind') NOT IN ('state', 'count')
          AND freshness = 'fresh' AND fetched_at >= ?
          ORDER BY CAST(json_extract(window_json, '$.minutes') AS INTEGER) ASC, fetched_at DESC, id DESC LIMIT 1`)
          .get(observation.meter_id, since);
        const found = readingFrom(row);
        if (!found) continue;
        output.set(key, { ...found.reading, window_minutes: found.windowMinutes });
        continue;
      }
      const minutes = window.minutes;
      const kind = window.kind;
      if (!minutes || kind === "state" || kind === "count") continue;
      const key = `${observation.meter_id}:${minutes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const match = windowSqlMatch(window);
      const row = this.prepared(`SELECT * FROM observations WHERE meter_id = ? AND ${match.sql}
        AND freshness = 'fresh' AND fetched_at >= ? ORDER BY fetched_at DESC, id DESC LIMIT 1`)
        .get(observation.meter_id, ...match.params, since);
      const found = readingFrom(row);
      if (!found) continue;
      output.set(key, found.reading);
    }
    return output;
  }
}
