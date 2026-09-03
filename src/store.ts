import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tallyHome } from "./paths.js";
import type { EventKind, Observation, StoredObservation, TallyEvent } from "./types.js";

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

export async function safeTallyDirectory(home = tallyHome()): Promise<string> {
  const requested = resolve(home);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing unsafe ~/.tally directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing ~/.tally owned by another user");
  if ((stat.mode & 0o077) !== 0) throw new Error("Refusing ~/.tally with group or world permissions");
  // lstat above proves the Tally-owned leaf is not a link. realpath still
  // canonicalizes system aliases such as /var → /private/var on macOS.
  return realpath(requested);
}

async function safeDatabasePath(home?: string): Promise<string> {
  const directory = await safeTallyDirectory(home);
  const path = join(directory, "tally.db");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Refusing unsafe Tally database file");
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing Tally database owned by another user");
      if ((stat.mode & 0o077) !== 0) throw new Error("Refusing Tally database with group or world permissions");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
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

function eventFromRow(row: Row): TallyEvent {
  return { id: String(row.id), kind: row.kind as EventKind, origin: row.origin as TallyEvent["origin"], confidence: Number(row.confidence), evidence_observation_ids: parseJson<number[]>(row.evidence_observation_ids, []), created_at: String(row.created_at), corrected_by: string(row.corrected_by), meter_id: string(row.meter_id), principal_id: string(row.principal_id) };
}

export class TallyStore {
  private constructor(private readonly db: Database) {}

  static async open(home?: string): Promise<TallyStore> {
    const path = await safeDatabasePath(home);
    const db = new DatabaseSync(path);
    const store = new TallyStore(db);
    // Direct CLI reads may briefly overlap the daemon. WAL permits readers with
    // its writer; the busy timeout turns a short writer handoff into a wait,
    // rather than an immediate "database is locked" failure.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    store.migrate();
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try { await chmod(candidate, 0o600); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return store;
  }

  close(): void { this.db.close(); }

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
        meter_id TEXT, principal_id TEXT
      );
      CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, caller TEXT NOT NULL, action TEXT NOT NULL, meter_or_principal TEXT,
        outcome TEXT NOT NULL, at TEXT NOT NULL
      );
    `);
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
    else if (stored.freshness === "failed") this.addEvent("source_failed", "vendor_reported", 1, [stored.id], stored);
    return stored;
  }

  insertAll(observations: Observation[]): StoredObservation[] { return observations.map((observation) => this.insert(observation)); }

  private previous(observation: Observation): StoredObservation | undefined {
    const window = observation.window ? JSON.stringify(observation.window) : null;
    const row = this.db.prepare("SELECT * FROM observations WHERE meter_id = ? AND (window_json IS ? OR window_json = ?) ORDER BY id DESC LIMIT 1")
      .get(observation.meter_id, window, window);
    return row ? observationFromRow(row) : undefined;
  }

  private addEvent(kind: EventKind, origin: TallyEvent["origin"], confidence: number, evidence: number[], current: StoredObservation): void {
    const created = current.fetched_at;
    const id = `${kind}:${current.id}`;
    this.db.prepare("INSERT INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, kind, origin, confidence, JSON.stringify(evidence), created, null, current.meter_id, current.principal_id);
  }

  private detectEvents(previous: StoredObservation, current: StoredObservation): void {
    const evidence = [previous.id, current.id];
    if (previous.freshness === "failed" && current.freshness !== "failed") this.addEvent("source_recovered", "vendor_reported", 1, evidence, current);
    if (previous.freshness !== "failed" && current.freshness === "failed") this.addEvent("source_failed", "vendor_reported", 1, evidence, current);
    const oldUsed = previous.quantity?.used;
    const newUsed = current.quantity?.used;
    const resetAdvanced = Boolean(previous.resets_at && current.resets_at && new Date(current.resets_at).getTime() > new Date(previous.resets_at).getTime());
    const beforeOldReset = previous.resets_at ? new Date(current.fetched_at).getTime() < new Date(previous.resets_at).getTime() : true;
    const dropped = oldUsed !== undefined && newUsed !== undefined && oldUsed > 0 && (newUsed === 0 || newUsed < oldUsed * 0.5) && beforeOldReset;
    if (resetAdvanced || dropped) this.addEvent("reset_seen", "inferred", previous.freshness === "stale" ? 0.3 : resetAdvanced ? 0.9 : 0.5, evidence, current);
    const previousFree = previous.metadata?.free_resets_available;
    const currentFree = current.metadata?.free_resets_available;
    if (previousFree !== undefined && previousFree !== null && currentFree !== undefined && currentFree !== null) {
      if (currentFree > previousFree) this.addEvent("free_reset_granted", "vendor_reported", 1, evidence, current);
      if (currentFree < previousFree) this.addEvent("free_reset_used", "vendor_reported", 1, evidence, current);
    }
    if (previous.metadata?.plan && current.metadata?.plan && previous.metadata.plan !== current.metadata.plan) this.addEvent("plan_changed", "vendor_reported", 1, evidence, current);
    if (current.meter_id.endsWith(":credits") && oldUsed !== undefined && newUsed !== undefined && oldUsed !== newUsed) this.addEvent("credits_changed", "vendor_reported", 1, evidence, current);
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

  events(since: string): TallyEvent[] { return this.db.prepare("SELECT * FROM events WHERE created_at >= ? ORDER BY created_at ASC").all(since).map(eventFromRow); }

  audit(caller: string, action: string, meterOrPrincipal: string | null, outcome: string): void {
    this.db.prepare("INSERT INTO audit (caller,action,meter_or_principal,outcome,at) VALUES (?,?,?,?,?)").run(caller, action, meterOrPrincipal, outcome, new Date().toISOString());
  }
}
