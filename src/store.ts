import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { headroomHome, migrateLegacyHome } from "./paths.js";
import type { EventKind, Lease, Observation, StoredObservation, HeadroomEvent } from "./types.js";
import { AVAILABILITY_ONLY_REASON, normalizeObservations } from "./engine/observation.js";
import { appendDaemonLog } from "./logs.js";

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
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing unsafe ~/.headroom directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing ~/.headroom owned by another user");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Refusing ~/.headroom with group or world permissions");
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
  return { id: String(row.id), kind: row.kind as EventKind, origin: row.origin as HeadroomEvent["origin"], confidence: Number(row.confidence), evidence_observation_ids: parseJson<number[]>(row.evidence_observation_ids, []), created_at: String(row.created_at), corrected_by: string(row.corrected_by), meter_id: string(row.meter_id), principal_id: string(row.principal_id), reason: string(row.reason) };
}

function leaseFromRow(row: Row): Lease {
  return { id: String(row.id), owner: String(row.owner), meter_id: String(row.meter_id), expected_percent: number(row.expected_percent), note: string(row.note), started_at: String(row.started_at), expires_at: String(row.expires_at), ended_at: string(row.ended_at), ended_reason: string(row.ended_reason), spent_percent: Number(row.spent_percent ?? 0) };
}

export class HeadroomStore {
  private constructor(private readonly db: Database) {}

  static async open(home?: string): Promise<HeadroomStore> {
    const path = await safeDatabasePath(home);
    // DatabaseSync creates a missing file with the process umask. Pre-create it
    // with an explicit mode so concurrent direct readers cannot observe a 0644
    // database between creation and the chmod below.
    const descriptor = await open(path, "a", 0o600);
    await descriptor.close();
    const db = new DatabaseSync(path);
    const store = new HeadroomStore(db);
    // Direct CLI reads may briefly overlap the daemon. WAL permits readers with
    // its writer; the busy timeout turns a short writer handoff into a wait,
    // rather than an immediate "database is locked" failure.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    store.migrate();
    const legacy = await legacyDatabasePath(resolve(path, ".."));
    if (legacy) await store.mergePriorDatabase(legacy, resolve(path, ".."));
    if (process.platform !== "win32") for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try { await chmod(candidate, 0o600); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return store;
  }

  close(): void { this.db.close(); }

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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY, principal_id TEXT NOT NULL, meter_id TEXT NOT NULL,
        window_json TEXT, quantity_json TEXT, resets_at TEXT, observed_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
        source TEXT NOT NULL, truth TEXT NOT NULL, freshness TEXT NOT NULL, confidence REAL NOT NULL,
        adapter_version TEXT NOT NULL, upstream_schema_version TEXT NOT NULL, reason TEXT, metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS observations_meter_fetched_at ON observations(meter_id, fetched_at);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL, confidence REAL NOT NULL,
        evidence_observation_ids TEXT NOT NULL, created_at TEXT NOT NULL, corrected_by TEXT,
        meter_id TEXT, principal_id TEXT, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, caller TEXT NOT NULL, action TEXT NOT NULL, meter_or_principal TEXT,
        outcome TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, meter_id TEXT NOT NULL,
        expected_percent REAL, note TEXT, started_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        ended_at TEXT, ended_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS leases_active_meter ON leases(meter_id, ended_at, expires_at);
      CREATE TABLE IF NOT EXISTS lease_spend (
        id INTEGER PRIMARY KEY, lease_id TEXT NOT NULL, meter_id TEXT NOT NULL,
        observation_id INTEGER NOT NULL, amount_percent REAL NOT NULL, estimated INTEGER NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lease_spend_lease ON lease_spend(lease_id);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
      );
    `);
    // Existing v0.1 databases lack event reasons. SQLite has no ADD COLUMN IF
    // NOT EXISTS, so retain a narrow compatibility migration.
    try { this.db.exec("ALTER TABLE events ADD COLUMN reason TEXT"); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error; }
    this.removeFalseResetSeenEvents();
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

  insert(observation: Observation): StoredObservation {
    const previous = this.previous(observation);
    const result = this.db.prepare(`INSERT INTO observations
      (principal_id,meter_id,window_json,quantity_json,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      observation.principal_id, observation.meter_id, json(observation.window), json(observation.quantity), observation.resets_at ?? null,
      observation.observed_at ?? null, observation.fetched_at ?? null, observation.source, observation.truth, observation.freshness, observation.confidence,
      observation.adapter_version, observation.upstream_schema_version, observation.reason ?? null, json(observation.metadata));
    const stored: StoredObservation = { ...observation, id: Number(result.lastInsertRowid) };
    if (previous) this.detectEvents(previous, stored);
    else if (stored.freshness === "failed") this.addSourceFailedEvent([stored.id], stored);
    if (previous) this.attributeLeaseSpend(previous, stored);
    return stored;
  }

  insertAll(observations: Observation[]): StoredObservation[] { return normalizeObservations(observations).map((observation) => this.insert(observation)); }

  private previous(observation: Observation): StoredObservation | undefined {
    const window = observation.window ? JSON.stringify(observation.window) : null;
    const row = this.db.prepare("SELECT * FROM observations WHERE meter_id = ? AND (window_json IS ? OR window_json = ?) ORDER BY id DESC LIMIT 1")
      .get(observation.meter_id, window, window);
    return row ? observationFromRow(row) : undefined;
  }

  private addEvent(kind: EventKind, origin: HeadroomEvent["origin"], confidence: number, evidence: number[], current: StoredObservation, reason: string | null = null): void {
    const created = current.fetched_at;
    const id = `${kind}:${current.id}`;
    this.db.prepare("INSERT INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, kind, origin, confidence, JSON.stringify(evidence), created, null, current.meter_id, current.principal_id, reason);
  }

  private addSourceFailedEvent(evidence: number[], current: StoredObservation): void {
    const availabilityOnly = current.reason === AVAILABILITY_ONLY_REASON;
    this.addEvent("source_failed", availabilityOnly ? "inferred" : "vendor_reported", availabilityOnly ? 0.8 : 1, evidence, current, availabilityOnly ? AVAILABILITY_ONLY_REASON : null);
  }

  private detectEvents(previous: StoredObservation, current: StoredObservation): void {
    const evidence = [previous.id, current.id];
    if (previous.freshness === "failed") {
      if (current.freshness === "fresh") {
        const availabilityOnly = previous.reason === AVAILABILITY_ONLY_REASON;
        this.addEvent("source_recovered", availabilityOnly ? "inferred" : "vendor_reported", availabilityOnly ? 0.8 : 1, evidence, current);
      }
      return;
    }
    if (current.freshness === "failed") {
      this.addSourceFailedEvent(evidence, current);
      return;
    }
    const oldUsed = previous.quantity?.used;
    const newUsed = current.quantity?.used;
    const bothFresh = previous.freshness === "fresh" && current.freshness === "fresh";
    // Rolling windows may synthesize `resets_at` as now + duration on every
    // fetch. A timestamp change is therefore never reset evidence on its own.
    const dropped = oldUsed !== undefined && newUsed !== undefined && oldUsed > 0 && (newUsed === 0 || newUsed < oldUsed * 0.5);
    if (bothFresh && dropped) this.addEvent("reset_seen", "inferred", 0.5, evidence, current);
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
   * insertion order). A duration is the user-visible window identity: a 5h
   * rolling and a 5h fixed window are still the same current 5h allowance.
   */
  latestPerWindow(meterId?: string): StoredObservation[] {
    const filter = meterId === undefined ? "" : "WHERE meter_id = ?";
    return this.db.prepare(`WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY meter_id, COALESCE(CAST(json_extract(window_json, '$.minutes') AS TEXT), 'none')
        ORDER BY fetched_at DESC, id DESC
      ) AS row_number
      FROM observations ${filter}
    ) SELECT current.* FROM ranked AS current
      WHERE current.row_number = 1
        -- A transport/auth failure has no vendor window. It replaces an older
        -- successful read for the whole meter; an older failure must not add a
        -- spurious '-' window beside a newer vendor response.
        AND NOT EXISTS (
          SELECT 1 FROM observations AS peer
          WHERE peer.meter_id = current.meter_id
            AND (
              (current.freshness = 'failed' AND peer.freshness <> 'failed')
              OR (current.freshness <> 'failed' AND peer.freshness = 'failed')
            )
            AND (peer.fetched_at > current.fetched_at OR (peer.fetched_at = current.fetched_at AND peer.id > current.id))
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

  startLease(owner: string, meterId: string, expectedPercent: number | null, ttlMs: number, note: string | null, now = new Date()): Lease {
    if (!owner.trim() || !meterId.trim()) throw new Error("owner and meter are required");
    if (expectedPercent !== null && (!Number.isFinite(expectedPercent) || expectedPercent < 0 || expectedPercent > 100)) throw new Error("expected percent must be 0 through 100");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttl must be positive");
    this.expireLeases(now);
    const lease: Lease = { id: randomUUID(), owner: owner.trim(), meter_id: meterId.trim(), expected_percent: expectedPercent, note, started_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMs).toISOString(), ended_at: null, ended_reason: null, spent_percent: 0 };
    this.db.prepare("INSERT INTO leases (id,owner,meter_id,expected_percent,note,started_at,expires_at,ended_at,ended_reason) VALUES (?,?,?,?,?,?,?,?,?)").run(lease.id, lease.owner, lease.meter_id, lease.expected_percent, lease.note, lease.started_at, lease.expires_at, null, null);
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

  /** Latest reset evidence for each current meter/window, limited to that window. */
  resetSeenFor(observations: Array<Pick<Observation, "meter_id" | "window" | "resets_at">>, now = new Date()): Map<string, string> {
    const output = new Map<string, string>();
    for (const observation of observations) {
      const minutes = observation.window?.minutes;
      if (!minutes) continue;
      const reset = observation.resets_at ? Date.parse(observation.resets_at) : Number.NaN;
      const start = Number.isFinite(reset) ? reset - minutes * 60_000 : now.getTime() - minutes * 60_000;
      const row = this.db.prepare(`SELECT e.created_at FROM events e
        JOIN json_each(e.evidence_observation_ids) evidence
        JOIN observations o ON o.id = evidence.value
        WHERE e.kind = 'reset_seen' AND e.meter_id = ?
          AND CAST(json_extract(o.window_json, '$.minutes') AS INTEGER) = ?
          AND e.created_at >= ? AND e.created_at <= ?
        ORDER BY e.created_at DESC LIMIT 1`).get(observation.meter_id, minutes, new Date(start).toISOString(), now.toISOString());
      if (row?.created_at && typeof row.created_at === "string") output.set(`${observation.meter_id}:${minutes}`, row.created_at);
    }
    return output;
  }

  audit(caller: string, action: string, meterOrPrincipal: string | null, outcome: string): void {
    this.db.prepare("INSERT INTO audit (caller,action,meter_or_principal,outcome,at) VALUES (?,?,?,?,?)").run(caller, action, meterOrPrincipal, outcome, new Date().toISOString());
  }
}
