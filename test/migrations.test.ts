import { createRequire } from "node:module";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomStore } from "../src/store.js";
import { CURRENT_SCHEMA_VERSION, NewerSchemaError, runMigrations, schemaVersion, type Migration, type MigrationDatabase } from "../src/migrations.js";

const { DatabaseSync: RawDatabase } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[] };
    close(): void;
  };
};

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tempHome(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/** The exact CREATE TABLE statements the beta.1 store ran (git show
 * v0.1.0-beta.1:src/store.ts), minus spend_ledger and notify_ledger -- the
 * only tables current HEAD's baseline adds on top of that shape. A database
 * built from exactly this, with `PRAGMA user_version` left untouched (SQLite
 * defaults it to 0), is precisely what a pre-versioning Headroom install has
 * on disk today. */
const BETA1_SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS keychain_grants (
    principal_id TEXT PRIMARY KEY, reason TEXT NOT NULL, set_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daemon_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
`;

/** Builds a version-0 (beta.1-shaped) database file at <home>/headroom.db,
 * with a handful of rows in it, then closes the connection so
 * HeadroomStore.open() can take it over. */
async function seedBeta1Database(home: string): Promise<void> {
  const path = join(home, "headroom.db");
  const db = new RawDatabase(path);
  // safeDatabasePath() (store.ts) refuses a group/world-readable database;
  // node:sqlite creates a new file with the process umask, not 0600.
  await chmod(path, 0o600);
  db.exec(BETA1_SCHEMA);
  // beta.1's own migrate() ran these same ALTERs unconditionally after the
  // CREATE block above -- an already-migrated beta.1 database has them.
  db.exec("ALTER TABLE events ADD COLUMN last_seen_at TEXT");
  db.exec("ALTER TABLE leases ADD COLUMN action_class TEXT");
  db.prepare(`INSERT INTO observations
    (principal_id,meter_id,window_json,quantity_json,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "codex-main", "codex-main:main", JSON.stringify({ kind: "fixed", minutes: 100, enforcement: "hard" }), JSON.stringify({ used: 20, limit: 100, remaining: 80, unit: "percent" }),
    "2026-09-03T13:00:00Z", "2026-09-03T12:00:00Z", "2026-09-03T12:00:00Z", "fixture", "official", "fresh", 1, "fixture", "fixture", null, null);
  db.prepare("INSERT INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("model_new:1", "model_new", "vendor_reported", 1, "[1]", "2026-09-03T12:00:00Z", null, "codex-main:main", "codex-main", null, null);
  db.prepare("INSERT INTO leases (id,owner,meter_id,expected_percent,note,action_class,started_at,expires_at,ended_at,ended_reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("lease-1", "orchestrator-a", "codex-main:main", 10, "note", "build", "2026-09-03T11:00:00Z", "2026-09-03T13:00:00Z", null, null);
  db.close();
}

describe("schema migrations", () => {
  it("migrates a version-0 (beta.1) database to the current schema with its rows intact", async () => {
    const home = await tempHome("headroom-migrate-beta1-");
    await seedBeta1Database(home);
    const store = await HeadroomStore.open(home);
    try {
      expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
      expect(store.history("codex-main:main", "2026-09-01T00:00:00Z")).toHaveLength(1);
      expect(store.events("2026-09-01T00:00:00Z")).toHaveLength(1);
      expect(store.leases("codex-main:main")).toHaveLength(1);
      // Tables the beta.1 fixture never had must now exist and be usable.
      expect(store.spendByOwner()).toEqual([]);
      expect(store.notifyLedger()).toEqual([]);
      // The baseline migration (version 0 -> 1) is not a shape change for an
      // already-current-shaped beta.1 database; it must never back anything up.
      expect(await readdir(home)).not.toContain("headroom.db.bak-0");
    } finally { store.close(); }
  });

  it("refuses a database newer than this binary understands, without writing to it", async () => {
    const home = await tempHome("headroom-migrate-newer-");
    const bootstrap = await HeadroomStore.open(home);
    bootstrap.close();
    const raw = new RawDatabase(join(home, "headroom.db"));
    const newerVersion = CURRENT_SCHEMA_VERSION + 1;
    raw.exec(`PRAGMA user_version = ${newerVersion}`);
    raw.close();

    await expect(HeadroomStore.open(home)).rejects.toThrow(NewerSchemaError);
    await expect(HeadroomStore.open(home)).rejects.toThrow(new RegExp(`${newerVersion}.*${CURRENT_SCHEMA_VERSION}.*headroom update`, "s"));

    const after = new RawDatabase(join(home, "headroom.db"));
    const version = after.prepare("PRAGMA user_version").get()?.user_version;
    after.close();
    expect(version).toBe(newerVersion);
    expect(await readdir(home)).not.toEqual(expect.arrayContaining([expect.stringContaining(".bak-")]));
  });

  it("is idempotent: opening an already-current database twice is a no-op", async () => {
    const home = await tempHome("headroom-migrate-idempotent-");
    await seedBeta1Database(home);
    const first = await HeadroomStore.open(home);
    const versionAfterFirst = first.schemaVersion();
    first.close();

    const second = await HeadroomStore.open(home);
    try {
      expect(second.schemaVersion()).toBe(versionAfterFirst);
      // Rows from the first open are still exactly one each, not duplicated.
      expect(second.history("codex-main:main", "2026-09-01T00:00:00Z")).toHaveLength(1);
      expect(second.events("2026-09-01T00:00:00Z")).toHaveLength(1);
    } finally { second.close(); }
  });

  it("runMigrations itself is a no-op the second time it is run against the same database", () => {
    const raw = new RawDatabase(":memory:");
    const migration: Migration = { version: 1, description: "test baseline", up: (db) => db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)") };
    const db = raw as unknown as MigrationDatabase;
    const noBackup = async () => { throw new Error("must not back up the baseline"); };
    return (async () => {
      await runMigrations(db, noBackup, [migration]);
      expect(schemaVersion(db)).toBe(1);
      await runMigrations(db, noBackup, [migration]); // second run: nothing pending, backup callback never called
      expect(schemaVersion(db)).toBe(1);
      raw.close();
    })();
  });

  it("backs up once per migration above the baseline, named after the version upgraded from, and never overwrites an existing backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-migrations-backup-"));
    temporary.push(root);
    const dbPath = join(root, "test.db");
    const raw = new RawDatabase(dbPath);
    const migrations: Migration[] = [
      { version: 1, description: "baseline", up: (db) => db.exec("CREATE TABLE base (id INTEGER)") },
      { version: 2, description: "add a column", up: (db) => db.exec("ALTER TABLE base ADD COLUMN extra TEXT") },
      { version: 3, description: "add another column", up: (db) => db.exec("ALTER TABLE base ADD COLUMN more TEXT") },
    ];
    const db = raw as unknown as MigrationDatabase;
    const backedUpFrom: number[] = [];
    const backup = async (fromVersion: number) => {
      backedUpFrom.push(fromVersion);
      const { copyFile } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      try { await copyFile(dbPath, `${dbPath}.bak-${fromVersion}`, constants.COPYFILE_EXCL); }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    };

    await runMigrations(db, backup, migrations);
    expect(backedUpFrom).toEqual([1, 2]); // never for the baseline (version 1) itself
    expect((await lstat(`${dbPath}.bak-1`)).isFile()).toBe(true);
    expect((await lstat(`${dbPath}.bak-2`)).isFile()).toBe(true);
    await expect(lstat(`${dbPath}.bak-0`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${dbPath}.bak-3`)).rejects.toMatchObject({ code: "ENOENT" });

    // Idempotent: nothing pending, so the backup callback is not called again.
    await runMigrations(db, backup, migrations);
    expect(backedUpFrom).toEqual([1, 2]);
    raw.close();
  });
});
