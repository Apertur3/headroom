import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { assertSafeAncestry, headroomHome, migrateLegacyHome } from "./paths.js";
import type { EventKind, Lease, NotifyDelivery, Observation, SpendRow, StoredObservation, HeadroomEvent } from "./types.js";
import { IDLE_WINDOW_REASON, idleContradictionReason, isInferredFailureReason, normalizeObservations } from "./engine/observation.js";
import { appendDaemonLog } from "./logs.js";
import { defaultPolicy, paceDecision } from "./policy.js";
import type { BurnInfo } from "./pace.js";
import { leastSquaresBurnPerHour, emptyInSeconds } from "./pace.js";
import { attributeSpend, summarizeLearnedCost, type LearnedCost } from "./cost.js";
import { CURRENT_SCHEMA_VERSION, NewerSchemaError, runMigrations, schemaVersion } from "./migrations.js";
import { redact } from "./security.js";

/** Applies redact() to every string leaf of a value, so a metadata object
 * carrying a leaked secret in one of its string fields is scrubbed the same
 * way a plain error string would be. */
/** How long an attributed spend row is kept before it is pruned on the next
 * write. Long enough to cover a weekly window several times over, short
 * enough that the table stays a working set rather than an archive. */
export const SPEND_LEDGER_RETENTION_DAYS = 30;

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
  prepare(sql: string): { run(...params: unknown[]): { lastInsertRowid: number | bigint }; get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}
type DatabaseConstructor = new (path: string) => Database;
// Node 26 ships SQLite. createRequire keeps Vitest/Vite from trying to resolve
// this built-in as a browser module while preserving a dependency-free runtime.
const DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: DatabaseConstructor }).DatabaseSync;

type Row = Record<string, unknown>;

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

function observationFromRow(row: Row): StoredObservation {
  const quantity = row.quantity_json ? parseJson<Observation["quantity"]>(row.quantity_json, null) : null;
  const window = row.window_json ? parseJson<Observation["window"]>(row.window_json, null) : null;
  return {
    id: Number(row.id), principal_id: String(row.principal_id), meter_id: String(row.meter_id), window, quantity,
    resets_at: string(row.resets_at), observed_at: String(row.observed_at), fetched_at: String(row.fetched_at),
    source: String(row.source), truth: row.truth as Observation["truth"], freshness: row.freshness as Observation["freshness"],
    confidence: Number(row.confidence), adapter_version: String(row.adapter_version), upstream_schema_version: String(row.upstream_schema_version),
    reason: string(row.reason), metadata: parseJson<Observation["metadata"]>(row.metadata_json, undefined),
  };
}

function eventFromRow(row: Row): HeadroomEvent {
  return { id: String(row.id), kind: row.kind as EventKind, origin: row.origin as HeadroomEvent["origin"], confidence: Number(row.confidence), evidence_observation_ids: parseJson<number[]>(row.evidence_observation_ids, []), created_at: String(row.created_at), corrected_by: string(row.corrected_by), meter_id: string(row.meter_id), principal_id: string(row.principal_id), reason: string(row.reason), last_seen_at: string(row.last_seen_at) };
}

function notifyFromRow(row: Row): NotifyDelivery {
  return { id: Number(row.id), event_id: String(row.event_id), channel: String(row.channel), status: row.status as NotifyDelivery["status"], attempts: Number(row.attempts), text: String(row.text), detail: string(row.detail), created_at: String(row.created_at), updated_at: String(row.updated_at) };
}

function leaseFromRow(row: Row): Lease {
  return { id: String(row.id), owner: String(row.owner), meter_id: String(row.meter_id), expected_percent: number(row.expected_percent), note: string(row.note), action_class: string(row.action_class), started_at: String(row.started_at), expires_at: String(row.expires_at), ended_at: string(row.ended_at), ended_reason: string(row.ended_reason), spent_percent: Number(row.spent_percent ?? 0) };
}

export class HeadroomStore {
  private constructor(private readonly db: Database, private readonly dbPath: string) {}

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
    if (process.platform !== "win32") for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try { await chmod(candidate, 0o600); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return store;
  }

  close(): void { this.db.close(); }

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
      const table = this.db.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'observations'").get();
      currentCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM observations").get()?.count ?? 0);
      if (table) {
        legacyCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM legacy.observations").get()?.count ?? 0);
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
    if (this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migration)) return;
    const rows = this.db.prepare("SELECT * FROM events WHERE kind IN ('source_failed', 'source_recovered') ORDER BY meter_id ASC, created_at ASC, id ASC").all();
    const openByMeter = new Map<string, Row>();
    let collapsed = 0;
    for (const row of rows) {
      const meterId = String(row.meter_id);
      if (row.kind === "source_recovered") { openByMeter.delete(meterId); continue; }
      const open = openByMeter.get(meterId);
      if (open) {
        this.db.prepare("UPDATE events SET last_seen_at = ? WHERE id = ?").run(String(row.created_at), String(open.id));
        this.db.prepare("DELETE FROM events WHERE id = ?").run(String(row.id));
        collapsed += 1;
      } else {
        openByMeter.set(meterId, row);
      }
    }
    const summary = `collapsed ${collapsed} duplicate source_failed events across ${rows.length} candidates`;
    this.audit("migration", "collapse_source_failed_duplicates", null, summary);
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?,?)").run(migration, new Date().toISOString());
    await appendDaemonLog(summary, home);
  }

  /** Remove the transient reset labels caused by rolling zero-use windows whose
   * provider-derived reset timestamp advances on every poll. This deliberately
   * inspects its event evidence rather than trusting the old event confidence. */
  private removeFalseResetSeenEvents(): void {
    const migration = "2026-09-03-reset-seen-usage-drop";
    if (this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migration)) return;
    const since = "2026-09-03T21:00:00.000Z";
    const candidates = this.db.prepare("SELECT * FROM events WHERE kind = 'reset_seen' AND origin = 'inferred' AND created_at >= ?").all(since);
    let removed = 0;
    for (const row of candidates) {
      const event = eventFromRow(row);
      const evidence = event.evidence_observation_ids.map((id) => this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id)).filter((item): item is Row => Boolean(item)).map(observationFromRow);
      const previous = evidence[0];
      const current = evidence[1];
      const usageDropped = previous?.freshness === "fresh" && current?.freshness === "fresh"
        && previous.quantity?.used !== undefined && current.quantity?.used !== undefined
        && previous.quantity.used > 0 && (current.quantity.used === 0 || current.quantity.used < previous.quantity.used * 0.5);
      if (usageDropped) continue;
      this.db.prepare("DELETE FROM events WHERE id = ?").run(event.id);
      this.audit("migration", "remove_false_reset_seen", event.meter_id, `${event.id}: no usage drop`);
      removed += 1;
    }
    this.audit("migration", "remove_false_reset_seen_summary", null, `removed ${removed} inferred reset_seen events since ${since}`);
    this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)").run(migration, new Date().toISOString());
  }

  /** Re-evaluate the last 7 days of observations per meter and window with the
   * current baseline and classification rules, so a principal that failed
   * across a real reset or a free reset still gets its event, even though the
   * original poll-time comparison only ever looked at the immediately prior
   * row. Also deletes reset evidence wrongly attributed to local pools, which
   * have no vendor reset schedule and must never carry reset events. Runs once. */
  private async backfillResetEvents(home: string): Promise<void> {
    const migration = "2026-09-04-reset-detection-backfill";
    if (this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migration)) return;
    const localEvents = this.db.prepare(`SELECT DISTINCT e.id AS id FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.kind IN ('reset_seen', 'free_reset_used') AND json_extract(o.window_json, '$.kind') = 'state'`).all();
    for (const row of localEvents) this.db.prepare("DELETE FROM events WHERE id = ?").run(String(row.id));

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = this.db.prepare("SELECT * FROM observations WHERE freshness = 'fresh' AND fetched_at >= ? ORDER BY fetched_at ASC, id ASC").all(since);
    const beforeCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind IN ('reset_seen', 'free_reset_used')").get()?.count ?? 0);
    for (const row of rows) {
      const current = observationFromRow(row);
      const baseline = this.freshBaseline(current);
      if (baseline) this.classifyUsageDrop(baseline, current);
    }
    const afterCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind IN ('reset_seen', 'free_reset_used')").get()?.count ?? 0);
    const summary = `reset detection backfill: reprocessed ${rows.length} fresh observations since ${since}; removed ${localEvents.length} local-pool reset events; inserted ${afterCount - beforeCount} reset events`;
    this.audit("migration", "backfill_reset_events", null, summary);
    // Record completion before the only await in this method: two stores can
    // open the same database concurrently, and nothing may yield between the
    // "not yet run" check above and marking it run, or both would redo it and
    // the second commit would collide on the schema_migrations primary key.
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?,?)").run(migration, new Date().toISOString());
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
      const existingRow = this.db.prepare(
        "SELECT * FROM observations WHERE meter_id = ? AND json_extract(window_json, '$.minutes') = ? ORDER BY fetched_at DESC, id DESC LIMIT 1",
      ).get(observation.meter_id, observation.window.minutes);
      if (existingRow) {
        const existing = observationFromRow(existingRow);
        if (Date.parse(existing.fetched_at) >= Date.parse(observation.fetched_at)) return existing;
      }
    }
    const newBucket = this.newBucketName(observation);
    const previous = this.previous(observation);
    const resolved = this.resolveIdleContradiction(observation);
    // Reasons and metadata come from vendor responses (or their diagnostics)
    // and are persisted; redact them the same way any other vendor-adjacent
    // output is redacted, so a token or cookie that leaked into a failure
    // reason or a metadata string never lands in the database either.
    const reason = resolved.reason ? redact(resolved.reason) : resolved.reason ?? null;
    const metadata = resolved.metadata ? redactDeep(resolved.metadata) as Observation["metadata"] : resolved.metadata;
    const result = this.db.prepare(`INSERT INTO observations
      (principal_id,meter_id,window_json,quantity_json,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      resolved.principal_id, resolved.meter_id, json(resolved.window), json(resolved.quantity), resolved.resets_at ?? null,
      resolved.observed_at ?? null, resolved.fetched_at ?? null, resolved.source, resolved.truth, resolved.freshness, resolved.confidence,
      resolved.adapter_version, resolved.upstream_schema_version, reason, json(metadata));
    const stored: StoredObservation = { ...resolved, reason, metadata, id: Number(result.lastInsertRowid) };
    if (newBucket) this.addEvent("model_new", "vendor_reported", 1, [stored.id], stored, newBucket);
    if (previous) this.detectEvents(previous, stored);
    else if (stored.freshness === "failed") this.recordFailure([stored.id], stored);
    // The first reading ever stored under this exact meter id has no immediate
    // previous row, even though the legacy doubled-principal form of the same
    // meter does; the baseline lookup below checks that form on its own.
    else if (stored.freshness === "fresh") { const baseline = this.freshBaseline(stored); if (baseline) this.classifyUsageDrop(baseline, stored); }
    // Independent of the window-scoped previous()/detectEvents() path above:
    // a windowless failure is only ever closed by this separate check.
    if (stored.freshness === "fresh") this.recoverWindowlessFailure(stored);
    if (previous) this.attributeLeaseSpend(previous, stored);
    if (stored.freshness === "fresh") this.recordSpendLedger(stored);
    if (stored.freshness === "fresh") this.detectPaceProjection(stored);
    return stored;
  }

  insertAll(observations: Observation[]): StoredObservation[] { return normalizeObservations(observations).map((observation) => this.insert(observation)); }

  private previous(observation: Observation): StoredObservation | undefined {
    const window = observation.window ? JSON.stringify(observation.window) : null;
    const row = this.db.prepare("SELECT * FROM observations WHERE meter_id = ? AND (window_json IS ? OR window_json = ?) ORDER BY id DESC LIMIT 1")
      .get(observation.meter_id, window, window);
    return row ? observationFromRow(row) : undefined;
  }

  /** The most recent FRESH reading for this exact meter and window, fetched
   * within the last 2 hours of this new observation's own fetch time --
   * the contradiction evidence resolveIdleContradiction() checks a
   * detectPlaceholder-flagged idle reading against. */
  private recentFreshReading(observation: Observation): StoredObservation | undefined {
    const window = observation.window ? JSON.stringify(observation.window) : null;
    const since = new Date(Date.parse(observation.fetched_at) - 2 * 3_600_000).toISOString();
    const row = this.db.prepare(`SELECT * FROM observations WHERE meter_id = ? AND (window_json IS ? OR window_json = ?)
      AND freshness = 'fresh' AND fetched_at >= ? ORDER BY fetched_at DESC, id DESC LIMIT 1`)
      .get(observation.meter_id, window, window, since);
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

  private addEvent(kind: EventKind, origin: HeadroomEvent["origin"], confidence: number, evidence: number[], current: StoredObservation, reason: string | null = null, lastSeenAt: string | null = null): void {
    const created = current.fetched_at;
    const id = `${kind}:${current.id}`;
    // OR IGNORE keeps the reset-detection backfill idempotent: replaying it
    // over already-classified observations must not error on a repeat id.
    this.db.prepare("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, kind, origin, confidence, JSON.stringify(evidence), created, null, current.meter_id, current.principal_id, reason, lastSeenAt);
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
    const minutes = window?.minutes ?? null;
    // IS (not =) with an INTEGER cast on the JSON side only, matching
    // eventEvidenceFor's pattern below: node:sqlite binds a JS number
    // parameter as SQLite REAL, so CAST(?, AS TEXT) on that parameter would
    // produce '10080.0' against json_extract's '10080' and never match. IS
    // also makes a windowless (null-minutes) comparison exact rather than
    // SQL NULL's usual never-equal-anything behavior.
    const row = this.db.prepare(`SELECT e.* FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.meter_id = ? AND e.kind IN ('source_failed', 'source_recovered')
        AND o.window_json IS NOT NULL AND o.window_json <> 'null'
        AND CAST(json_extract(o.window_json, '$.minutes') AS INTEGER) IS ?
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1`).get(meterId, minutes);
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
    const lastFailure = this.db.prepare(`SELECT e.* FROM events e
      JOIN json_each(e.evidence_observation_ids) evidence
      JOIN observations o ON o.id = evidence.value
      WHERE e.meter_id = ? AND e.kind = 'source_failed' AND (o.window_json IS NULL OR o.window_json = 'null')
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1`).get(meterId);
    if (!lastFailure) return undefined;
    const closed = this.db.prepare("SELECT 1 FROM events WHERE meter_id = ? AND kind = 'source_recovered' AND created_at > ? LIMIT 1")
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
      this.db.prepare("UPDATE events SET last_seen_at = ? WHERE id = ?").run(current.fetched_at, String(open.id));
      return;
    }
    this.addSourceFailedEvent(evidence, current);
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
    const window = current.window ? JSON.stringify(current.window) : null;
    const since = new Date(Date.parse(current.fetched_at) - 7 * 86_400_000).toISOString();
    const lookup = (meterId: string): Row | undefined => this.db.prepare(`SELECT * FROM observations
      WHERE meter_id = ? AND (window_json IS ? OR window_json = ?)
        AND freshness = 'fresh' AND id < ? AND fetched_at >= ?
      ORDER BY fetched_at DESC, id DESC LIMIT 1`).get(meterId, window, window, current.id, since);
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
    if (this.db.prepare("SELECT 1 FROM observations WHERE meter_id = ? LIMIT 1").get(observation.meter_id)) return undefined;
    if (!this.db.prepare("SELECT 1 FROM observations WHERE principal_id = ? LIMIT 1").get(observation.principal_id)) return undefined;
    const prefix = `${observation.principal_id}:`;
    return observation.meter_id.startsWith(prefix) ? observation.meter_id.slice(prefix.length) : observation.meter_id;
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
   * gap could hide more than one reset. */
  private classifyUsageDrop(baseline: StoredObservation, current: StoredObservation): void {
    if (current.window?.kind === "state" || current.window?.kind === "count") return;
    if (baseline.quantity?.unit !== "percent" || current.quantity?.unit !== "percent") return;
    const oldUsed = baseline.quantity.used;
    const newUsed = current.quantity.used;
    if (!isUsageReset(oldUsed, newUsed)) return;
    const previousReset = baseline.resets_at ? Date.parse(baseline.resets_at) : Number.NaN;
    const currentReset = current.resets_at ? Date.parse(current.resets_at) : Number.NaN;
    if (!Number.isFinite(previousReset) || !Number.isFinite(currentReset)) return;
    const elapsedMs = Date.parse(current.fetched_at) - Date.parse(baseline.fetched_at);
    const resetDeltaMs = currentReset - previousReset;
    const toleranceMs = 60_000;
    const resetsAdvanced = resetDeltaMs > elapsedMs + toleranceMs;
    const resetsUnchanged = Math.abs(resetDeltaMs) <= toleranceMs;
    const beforeScheduledReset = resetsUnchanged && Date.parse(current.fetched_at) < previousReset;
    if (!resetsAdvanced && !beforeScheduledReset) return;
    const evidence = [baseline.id, current.id];
    const stale = elapsedMs > 24 * 3_600_000;
    const staleHours = Math.floor(elapsedMs / 3_600_000);
    const suffix = (base: string | null): string | null => stale ? `${base ? `${base}; ` : ""}baseline ${staleHours}h old` : base;
    if (resetsAdvanced) this.addEvent("reset_seen", "inferred", stale ? 0.6 : 0.9, evidence, current, suffix(null));
    else this.addEvent("free_reset_used", "inferred", stale ? 0.5 : 0.8, evidence, current, suffix(`usage dropped from ${Math.round(oldUsed)}% to ${Math.round(newUsed)}% before the scheduled reset`));
  }

  /** The most recent reset_seen event for this meter+window within
   * [since, now], if any -- the vendor-confirmed sign a reset actually
   * happened, used by burnRateFor to cut a sample window off at the reset
   * instead of letting it span the drop. Mirrors eventEvidenceFor's own
   * julianday() comparison for the same reason: an event's created_at is an
   * observation's fetched_at verbatim, not guaranteed to carry milliseconds. */
  private lastResetEventAt(meterId: string, minutes: number, sinceIso: string, nowIso: string): number | null {
    const row = this.db.prepare(`SELECT e.created_at FROM events e
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
      const rows = this.db.prepare("SELECT * FROM observations WHERE meter_id = ? AND freshness = 'fresh' AND julianday(fetched_at) >= julianday(?) AND julianday(fetched_at) <= julianday(?) ORDER BY fetched_at ASC, id ASC")
        .all(observation.meter_id, since, nowIso)
        .map(observationFromRow)
        .filter((row) => row.window?.minutes === minutes && row.quantity?.unit === "percent");
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
    const row = this.db.prepare(`SELECT e.id FROM events e
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
    this.addEvent("pace_projection_conserve", "inferred", 0.7, [current.id], current, decision.reason);
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
    const rows = this.db.prepare(`SELECT l.action_class AS action_class, COALESCE(SUM(s.amount_percent), 0) AS spent
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
    const rows = this.db.prepare(`SELECT l.id AS id, COALESCE(SUM(s.amount_percent), 0) AS spent
      FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.meter_id = ? AND l.ended_at IS NOT NULL GROUP BY l.id`).all(meterId);
    return summarizeLearnedCost(meterId, rows.map((row) => Number(row.spent)));
  }

  private detectEvents(previous: StoredObservation, current: StoredObservation): void {
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
      if (baseline) this.classifyUsageDrop(baseline, current);
      return;
    }
    if (current.freshness === "fresh") {
      const baseline = this.freshBaseline(current);
      if (baseline) this.classifyUsageDrop(baseline, current);
    }
    const previousCredits = previous.quantity?.unit === "credits" ? previous.quantity.remaining : null;
    const currentCredits = current.quantity?.unit === "credits" ? current.quantity.remaining : null;
    if (previous.window?.kind === "count" && current.window?.kind === "count" && previousCredits !== null && currentCredits !== null) {
      if (currentCredits > previousCredits) this.addEvent("free_reset_granted", "vendor_reported", 1, evidence, current);
      if (currentCredits < previousCredits) this.addEvent("free_reset_used", "vendor_reported", 1, evidence, current);
      if (currentCredits !== previousCredits) this.addEvent("credits_changed", "vendor_reported", 1, evidence, current);
    }
    if (previous.metadata?.plan && current.metadata?.plan && previous.metadata.plan !== current.metadata.plan) this.addEvent("plan_changed", "vendor_reported", 1, evidence, current);
  }

  history(meterId: string, since: string): StoredObservation[] {
    return this.db.prepare("SELECT * FROM observations WHERE meter_id = ? AND fetched_at >= ? ORDER BY fetched_at ASC, id ASC").all(meterId, since).map(observationFromRow);
  }

  /**
   * The observations table is an append-only history. Current status must have
   * one row per meter and duration, chosen by the vendor fetch timestamp (not
   * insertion order), preferring a fresh reading over anything else at any
   * fetched_at. A stale/failed/not_enforced source that keeps re-reporting
   * the exact same old event on every poll (Codex's session-log rate-limit
   * fallback re-reading an unchanged log file, for one) must never eclipse a
   * later fresh reading just because it happens to get re-inserted after
   * it -- and a fresh reading is only ever missing in favor of a non-fresh
   * one when no fresh reading exists for that window at all. A duration is
   * the user-visible window identity: a 5h rolling and a 5h fixed window are
   * still the same current 5h allowance.
   */
  latestPerWindow(meterId?: string): StoredObservation[] {
    const filter = meterId === undefined ? "" : "WHERE meter_id = ?";
    return this.db.prepare(`WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY meter_id, COALESCE(CAST(json_extract(window_json, '$.minutes') AS TEXT), 'none')
        ORDER BY (CASE WHEN freshness = 'fresh' THEN 0 ELSE 1 END), fetched_at DESC, id DESC
      ) AS row_number
      FROM observations ${filter}
    ) SELECT current.* FROM ranked AS current
      WHERE current.row_number = 1
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
            -- A reading the operator pasted from the vendor's own panel stays
            -- authoritative for an hour: a failed poll in that hour (a denied
            -- probe, a transport error) must not hide it, or the paste would be
            -- pointless on exactly the machine where the probe cannot read.
            AND NOT (current.source = 'paste' AND peer.freshness = 'failed'
                     AND current.fetched_at > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-60 minutes'))
        )
      ORDER BY current.meter_id ASC, current.fetched_at DESC, current.id DESC`)
      .all(...(meterId === undefined ? [] : [meterId]))
      .map(observationFromRow);
  }

  /** Compatibility helper for callers that explicitly need one newest row. */
  latest(meterId: string): StoredObservation | undefined {
    const row = this.db.prepare("SELECT * FROM observations WHERE meter_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1").get(meterId);
    return row ? observationFromRow(row) : undefined;
  }

  events(since: string): HeadroomEvent[] { return this.db.prepare("SELECT * FROM events WHERE created_at >= ? ORDER BY created_at ASC").all(since).map(eventFromRow); }

  /** Free-form daemon-owned key/value state, backed by the same daemon_state
   * table the Claude probe hashes and the MCP backoff already use. The
   * notifier keeps its delivery watermark here. */
  daemonState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  }

  setDaemonState(key: string, value: string): void {
    this.db.prepare("INSERT INTO daemon_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * Notification delivery ledger (src/notify.ts). One row per event per
   * channel, so an event that was already delivered is never delivered twice
   * however often the daemon re-reads it: the (event_id, channel) uniqueness
   * constraint, not the caller, is what makes that true.
   */
  notifyEnqueue(eventId: string, channel: string, text: string, at: string): void {
    this.db.prepare("INSERT OR IGNORE INTO notify_ledger (event_id,channel,status,attempts,text,detail,created_at,updated_at) VALUES (?,?,'pending',0,?,NULL,?,?)")
      .run(eventId, channel, text, at, at);
  }

  /** Queued rows for one channel, oldest first: a single new event, or every
   * event a quiet-hours window held back, which the caller sends as one
   * batched message. */
  notifyPending(channel: string, maxAttempts = 3, limit = 100): NotifyDelivery[] {
    return this.db.prepare("SELECT * FROM notify_ledger WHERE channel = ? AND status = 'pending' AND attempts < ? ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(channel, maxAttempts, limit).map(notifyFromRow);
  }

  notifyDelivered(ids: number[], at: string): void {
    if (!ids.length) return;
    this.db.prepare(`UPDATE notify_ledger SET status = 'sent', detail = NULL, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(at, ...ids);
  }

  /** One failed attempt for each row: the attempt counter carries the retry
   * budget, and a row that exhausts it stops being pending so the next poll
   * does not pick it up again. */
  notifyAttemptFailed(ids: number[], detail: string, at: string, maxAttempts = 3): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE notify_ledger SET attempts = attempts + 1, detail = ?, updated_at = ?,
      status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END WHERE id IN (${placeholders})`).run(detail, at, maxAttempts, ...ids);
  }

  notifyLedger(limit = 20): NotifyDelivery[] {
    return this.db.prepare("SELECT * FROM notify_ledger ORDER BY updated_at DESC, id DESC LIMIT ?").all(limit).map(notifyFromRow);
  }

  private expireLeases(now = new Date()): void {
    const at = now.toISOString();
    const expired = this.db.prepare("SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.ended_at IS NULL AND l.expires_at <= ? GROUP BY l.id").all(at).map(leaseFromRow);
    for (const lease of expired) {
      this.db.prepare("UPDATE leases SET ended_at = ?, ended_reason = 'expired' WHERE id = ? AND ended_at IS NULL").run(at, lease.id);
      this.addLeaseEvent("lease_ended", { ...lease, ended_at: at, ended_reason: "expired" });
    }
  }

  private addLeaseEvent(kind: Extract<EventKind, "lease_started" | "lease_ended">, lease: Lease): void {
    const at = lease.ended_at ?? lease.started_at;
    this.db.prepare("INSERT OR IGNORE INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`${kind}:${lease.id}:${at}`, kind, "vendor_reported", 1, "[]", at, null, lease.meter_id, null, lease.ended_reason ?? lease.note);
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
    this.db.prepare("INSERT INTO leases (id,owner,meter_id,expected_percent,note,action_class,started_at,expires_at,ended_at,ended_reason) VALUES (?,?,?,?,?,?,?,?,?,?)").run(lease.id, lease.owner, lease.meter_id, lease.expected_percent, lease.note, lease.action_class, lease.started_at, lease.expires_at, null, null);
    this.addLeaseEvent("lease_started", lease);
    return lease;
  }

  endLease(id: string, owner: string, force = false, now = new Date()): Lease {
    if (!owner.trim()) throw new Error("owner is required");
    this.expireLeases(now);
    const row = this.db.prepare("SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id WHERE l.id = ? GROUP BY l.id").get(id);
    if (!row) throw new Error("lease not found");
    const lease = leaseFromRow(row);
    if (lease.ended_at) return { ...lease, already_ended: true };
    if (owner !== lease.owner && !force) throw new Error("refusing another owner's lease; pass --force");
    const ended = { ...lease, ended_at: now.toISOString(), ended_reason: "ended" };
    this.db.prepare("UPDATE leases SET ended_at = ?, ended_reason = ? WHERE id = ?").run(ended.ended_at, ended.ended_reason, id);
    this.addLeaseEvent("lease_ended", ended);
    return ended;
  }

  leases(meterId?: string, activeOnly = false, now = new Date()): Lease[] {
    this.expireLeases(now);
    const filter = [meterId ? "l.meter_id = ?" : "", activeOnly ? "l.ended_at IS NULL AND l.expires_at > ?" : ""].filter(Boolean).join(" AND ");
    const params = [...(meterId ? [meterId] : []), ...(activeOnly ? [now.toISOString()] : [])];
    return this.db.prepare(`SELECT l.*, COALESCE(SUM(s.amount_percent), 0) AS spent_percent FROM leases l LEFT JOIN lease_spend s ON s.lease_id = l.id ${filter ? `WHERE ${filter}` : ""} GROUP BY l.id ORDER BY l.started_at DESC`).all(...params).map(leaseFromRow);
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
    for (let index = 0; index < leases.length; index += 1) this.db.prepare("INSERT INTO lease_spend (lease_id,meter_id,observation_id,amount_percent,estimated,at) VALUES (?,?,?,?,?,?)").run(leases[index].id, current.meter_id, current.id, delta * weights[index] / total, 1, current.fetched_at);
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
      this.db.prepare("INSERT INTO spend_ledger (meter_id,window_minutes,from_at,to_at,delta_percent,owner,share_percent,confidence) VALUES (?,?,?,?,?,?,?,?)")
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
    this.db.prepare("DELETE FROM spend_ledger WHERE julianday(to_at) < julianday(?)").run(cutoff);
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
    const rows = this.db.prepare(`SELECT meter_id, window_minutes, owner,
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

  /** Latest reset evidence for each current meter/window, limited to that window. */
  resetSeenFor(observations: Array<Pick<Observation, "meter_id" | "window" | "resets_at">>, now = new Date()): Map<string, string> {
    return this.eventEvidenceFor("reset_seen", observations, now);
  }

  /** Latest free-reset evidence for each current meter/window, limited to that window. */
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
      const row = this.db.prepare(`SELECT e.created_at FROM events e
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

  audit(caller: string, action: string, meterOrPrincipal: string | null, outcome: string): void {
    this.db.prepare("INSERT INTO audit (caller,action,meter_or_principal,outcome,at) VALUES (?,?,?,?,?)").run(caller, action, meterOrPrincipal, outcome, new Date().toISOString());
  }

  /**
   * A Claude principal whose Keychain probe was denied or timed out (or whose
   * probe binary was rebuilt, see setProbeBinaryHash) is marked here so the
   * daemon stops attempting that principal's probe -- which would otherwise
   * pop a fresh macOS Keychain dialog on every poll -- until the operator
   * explicitly runs `headroom keychain grant`, which clears the marker.
   */
  keychainGrantNeeded(principalId: string): boolean {
    return this.db.prepare("SELECT 1 FROM keychain_grants WHERE principal_id = ?").get(principalId) !== undefined;
  }

  keychainGrantReason(principalId: string): string | undefined {
    const row = this.db.prepare("SELECT reason FROM keychain_grants WHERE principal_id = ?").get(principalId);
    return row ? String(row.reason) : undefined;
  }

  setKeychainGrantNeeded(principalId: string, reason: string, now = new Date()): void {
    this.db.prepare("INSERT INTO keychain_grants (principal_id, reason, set_at) VALUES (?,?,?) ON CONFLICT(principal_id) DO UPDATE SET reason = excluded.reason, set_at = excluded.set_at")
      .run(principalId, reason, now.toISOString());
  }

  clearKeychainGrantNeeded(principalId: string): void {
    this.db.prepare("DELETE FROM keychain_grants WHERE principal_id = ?").run(principalId);
  }

  keychainGrantsNeeded(): Array<{ principal_id: string; reason: string; set_at: string }> {
    return this.db.prepare("SELECT * FROM keychain_grants ORDER BY principal_id ASC").all()
      .map((row) => ({ principal_id: String(row.principal_id), reason: String(row.reason), set_at: String(row.set_at) }));
  }

  /** The Claude Keychain probe binary's last-known sha256, used to detect a
   * rebuild (a new binary) so every Claude principal is marked as needing a
   * fresh grant instead of the daemon silently re-probing with the new
   * binary and popping one dialog per principal per poll. */
  probeBinaryHash(): string | undefined {
    const row = this.db.prepare("SELECT value FROM daemon_state WHERE key = 'claude_probe_binary_sha256'").get();
    return row ? String(row.value) : undefined;
  }

  setProbeBinaryHash(hash: string): void {
    this.db.prepare("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_binary_sha256', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  }

  /** The most recent probe binary hash that actually proved itself: recorded
   * after a successful `headroom keychain grant` or a poll that got a real
   * vendor response through it. See syncClaudeGrantState for how this
   * exempts a first-ever sync (no probeBinaryHash yet) from being treated as
   * grant-needed when it is really the same already-trusted binary. */
  probeGrantedHash(): string | undefined {
    const row = this.db.prepare("SELECT value FROM daemon_state WHERE key = 'claude_probe_granted_sha256'").get();
    return row ? String(row.value) : undefined;
  }

  setProbeGrantedHash(hash: string): void {
    this.db.prepare("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_granted_sha256', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
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
    const row = this.db.prepare("SELECT value FROM daemon_state WHERE key = 'claude_probe_path'").get();
    return row ? String(row.value) : undefined;
  }

  setProbePath(path: string): void {
    this.db.prepare("INSERT INTO daemon_state (key, value) VALUES ('claude_probe_path', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(path);
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
    const row = this.db.prepare("SELECT value FROM daemon_state WHERE key = 'mcp_direct_poll_backoff'").get();
    if (!row) return { lastPollAt: 0, until: 0, failures: 0 };
    try {
      const parsed = JSON.parse(String(row.value)) as { lastPollAt?: number; until?: number; failures?: number };
      return { lastPollAt: Number(parsed.lastPollAt) || 0, until: Number(parsed.until) || 0, failures: Number(parsed.failures) || 0 };
    } catch { return { lastPollAt: 0, until: 0, failures: 0 }; }
  }

  setDirectPollBackoff(state: { lastPollAt: number; until: number; failures: number }): void {
    this.db.prepare("INSERT INTO daemon_state (key, value) VALUES ('mcp_direct_poll_backoff', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(state));
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
    return this.db.prepare(`SELECT id, meter_id, window_minutes, from_at, to_at, delta_percent, owner, share_percent, confidence
      FROM spend_ledger WHERE ${filters.join(" AND ")} ORDER BY to_at ASC, id ASC`).all(...params)
      .map((row) => ({
        id: Number(row.id), meter_id: String(row.meter_id), window_minutes: number(row.window_minutes),
        from_at: String(row.from_at), to_at: String(row.to_at), delta_percent: Number(row.delta_percent),
        owner: String(row.owner), share_percent: Number(row.share_percent), confidence: Number(row.confidence),
      }));
  }
}
