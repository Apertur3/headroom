/**
 * Numbered schema migrations for the Headroom SQLite store, tracked with
 * `PRAGMA user_version`. This is a different mechanism from the store's own
 * `schema_migrations` table, which only ever guards one-off *data* repairs
 * keyed by an arbitrary string id (see store.ts's removeFalseResetSeenEvents,
 * backfillResetEvents, collapseDuplicateSourceFailedEvents) and is untouched
 * by anything here. A migration in this file changes the table SHAPE: a new
 * table, a new column, a new index.
 *
 * The rule for every future schema change: append a new migration with the
 * next version number. Never edit an existing migration's `up`, even to fix
 * a typo -- a database that already ran it has exactly that shape on disk,
 * and a silently changed body would stop describing what such a database
 * actually has. Fix a mistake with a follow-up migration instead. See
 * docs/concepts.md's "Database and upgrades" section.
 */

export interface MigrationDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
}

export interface Migration {
  version: number;
  description: string;
  up(db: MigrationDatabase): void;
}

/** Runs `sql`, swallowing only the "column already exists" error SQLite
 * raises for `ALTER TABLE ... ADD COLUMN` when a database already has it --
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so this is what makes an ad hoc
 * column addition idempotent against a database that already carries it. */
function addColumnIfMissing(db: MigrationDatabase, sql: string): void {
  try { db.exec(sql); }
  catch (error) { if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error; }
}

/**
 * Migration 1 is the baseline: every `CREATE TABLE IF NOT EXISTS` and ad hoc
 * `ALTER TABLE ... ADD COLUMN` the store used to run unconditionally on
 * every `open()`, before schema versions existed, frozen here exactly as
 * they were. A pre-versioning database (schema version 0, since
 * `PRAGMA user_version` defaults to 0 and nothing ever set it) already has
 * this shape from those same statements having already run against it many
 * times over, so applying this migration to one is a no-op: `IF NOT EXISTS`
 * skips every table that already exists, and `addColumnIfMissing` catches
 * its own "duplicate column name" error. A brand-new, empty database gets
 * the full shape from nothing, the same way it always did.
 */
const BASELINE: Migration = {
  version: 1,
  description: "baseline schema: observations, events, audit, leases, lease_spend, spend_ledger, schema_migrations, keychain_grants, daemon_state, notify_ledger",
  up(db) {
    db.exec(`
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
      CREATE TABLE IF NOT EXISTS spend_ledger (
        id INTEGER PRIMARY KEY, meter_id TEXT NOT NULL, window_minutes INTEGER,
        from_at TEXT NOT NULL, to_at TEXT NOT NULL, delta_percent REAL NOT NULL,
        owner TEXT NOT NULL, share_percent REAL NOT NULL, confidence REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spend_ledger_meter_to_at ON spend_ledger(meter_id, to_at);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS keychain_grants (
        principal_id TEXT PRIMARY KEY, reason TEXT NOT NULL, set_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notify_ledger (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL, text TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (event_id, channel)
      );
      CREATE INDEX IF NOT EXISTS notify_ledger_channel_status ON notify_ledger(channel, status);
    `);
    addColumnIfMissing(db, "ALTER TABLE events ADD COLUMN reason TEXT");
    addColumnIfMissing(db, "ALTER TABLE events ADD COLUMN last_seen_at TEXT");
    addColumnIfMissing(db, "ALTER TABLE leases ADD COLUMN action_class TEXT");
  },
};

/** Every migration, in ascending version order. Append here; never insert or
 * edit in place. */
export const MIGRATIONS: Migration[] = [BASELINE];

/** The highest schema version this binary knows how to open and migrate to. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Thrown by runMigrations when a database's own `PRAGMA user_version` is
 * higher than this binary understands -- almost always a database a newer
 * Headroom wrote, opened by an older one after a downgrade. Refusing here,
 * before any statement runs, means the older binary never writes to a shape
 * it does not fully understand. */
export class NewerSchemaError extends Error {
  constructor(public readonly databaseVersion: number, public readonly binaryVersion: number) {
    super(`This Headroom database is schema version ${databaseVersion}, but this Headroom binary only understands up to version ${binaryVersion}. Refusing to open it to avoid misreading or corrupting a shape it does not know. Install the Headroom version that last wrote it, or run: headroom update`);
    this.name = "NewerSchemaError";
  }
}

/** The schema version recorded on `db`, or 0 for a database that predates
 * schema versioning (SQLite's own default for a `PRAGMA user_version` that
 * was never set). */
export function schemaVersion(db: MigrationDatabase): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  return typeof value === "number" ? value : 0;
}

/**
 * Applies every migration `db` has not yet run, in version order, each
 * inside its own transaction: a migration's own statements and the
 * `PRAGMA user_version` bump that records it having run land together, so a
 * crash mid-migration leaves the database on its old, complete version
 * rather than a half-applied new one. A database newer than this binary
 * knows is refused up front, before any statement runs or is even queued.
 *
 * `backupBeforeMigration` is awaited once per migration numbered above the
 * baseline -- never for the baseline itself, since a pre-versioning
 * database migrating to it is not changing shape, only recording the shape
 * it already has -- and is passed the version the database is upgrading
 * FROM, so the caller can name a backup file after it.
 *
 * `migrations` defaults to the real, exported list; tests pass their own to
 * exercise multi-step migration and backup behavior without depending on
 * however many real migrations happen to exist yet.
 */
export async function runMigrations(db: MigrationDatabase, backupBeforeMigration: (fromVersion: number) => Promise<void>, migrations: Migration[] = MIGRATIONS): Promise<void> {
  const current = schemaVersion(db);
  const highest = migrations.length ? migrations[migrations.length - 1]!.version : 0;
  if (current > highest) throw new NewerSchemaError(current, highest);
  const baseline = migrations.length ? migrations[0]!.version : 0;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    if (migration.version > baseline) await backupBeforeMigration(schemaVersion(db));
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
