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

/**
 * Adds `events.metadata_json`, mirroring `observations.metadata_json` --
 * non-secret, structured facts about an event that are not part of its
 * evidence. First user: `reset_seen`'s `unscheduled` marker (issue #20).
 * `addColumnIfMissing` makes this a no-op for a database that somehow
 * already has the column (there is no such database yet, but the same
 * guard the baseline uses for every other ad hoc column costs nothing).
 */
const ADD_EVENT_METADATA: Migration = {
  version: 2,
  description: "events.metadata_json for non-secret event facts (reset_seen's unscheduled marker)",
  up(db) {
    addColumnIfMissing(db, "ALTER TABLE events ADD COLUMN metadata_json TEXT");
  },
};

/**
 * `known_models` tracks, per principal, every model id a vendor's own local
 * catalog (or model-listing endpoint) has ever reported -- the "model
 * available" feature's seed set. `retired_at` is set (never a row delete)
 * when a later catalog read no longer lists an id, so a vendor that
 * temporarily omits a model from one read and restores it the next does not
 * lose its original `first_seen_at`. `model_id` is the vendor's own slug,
 * already an opaque non-secret string -- never a credential or prompt
 * fragment.
 */
const ADD_KNOWN_MODELS: Migration = {
  version: 3,
  description: "known_models table for the model_available/model_retired events",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS known_models (
        principal_id TEXT NOT NULL, vendor TEXT NOT NULL, model_id TEXT NOT NULL, model_name TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, retired_at TEXT,
        PRIMARY KEY (principal_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS known_models_principal ON known_models(principal_id);
    `);
  },
};

/**
 * `heartbeats` and `timers` back the orchestrator heartbeat / named wake-up
 * feature: a crashed orchestrator session takes every in-session timer and
 * watcher down with it, and that can go unnoticed for as long as nobody
 * happens to look. Both live in the daemon-owned store, the one process
 * that survives a session crash.
 *
 * `heartbeats` is one row per owner (an orchestrator identity, the same
 * namespace as a lease owner or an inbox session): `interval_ms` is what the
 * owner promised to beat at, `last_beat_at` the most recent beat,
 * `resume_sentence` an optional human-readable note of what a fresh session
 * should do to pick the work back up, and `lapsed_since` non-null exactly
 * while the daemon currently considers this heartbeat overdue (more than 2x
 * its own interval) -- set once when a poll first detects the lapse, cleared
 * the moment a later beat arrives, which is what lets the daemon tell "still
 * the same open lapse" from "a fresh one" and know when to emit
 * `heartbeat_restored`.
 *
 * `timers` is one named wake-up per (owner, name): `at` is when it is due,
 * `action` the text Headroom only ever delivers, never executes, and
 * `if_missed` ("notify" or "drop") controls whether a due timer whose
 * owner's heartbeat is currently lapsed also raises a `timer_missed` event
 * (in addition to the inbox entry every due timer always gets). `fired_at`
 * is set once delivered so a later poll never delivers it twice;
 * `cleared_at` is set by `headroom timer clear` and, like `fired_at`, only
 * ever hides a row from the "pending" views -- neither is a delete, so the
 * history stays inspectable.
 */
const ADD_HEARTBEATS_AND_TIMERS: Migration = {
  version: 4,
  description: "heartbeats and timers tables for orchestrator heartbeat leases and named wake-ups",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        owner TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL, resume_sentence TEXT,
        started_at TEXT NOT NULL, last_beat_at TEXT NOT NULL, lapsed_since TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timers (
        owner TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL,
        if_missed TEXT NOT NULL DEFAULT 'notify', created_at TEXT NOT NULL, fired_at TEXT, cleared_at TEXT,
        PRIMARY KEY (owner, name)
      );
      CREATE INDEX IF NOT EXISTS timers_due ON timers(at, fired_at, cleared_at);
    `);
  },
};

/**
 * `timers.attempts`/`timers.failed_at`: bounded retry for a timer whose
 * inbox delivery keeps failing (an owner whose session directory can no
 * longer be created, a filesystem error, ...). Before this, `fireDueTimers`
 * always released a failed claim back to pending (`unclaimTimer`), so a
 * permanently-undeliverable timer was retried on every single maintenance
 * pass forever. `attempts` counts delivery tries (bumped in
 * `unclaimTimer`); once it reaches `MAX_TIMER_DELIVERY_ATTEMPTS`,
 * `failed_at` is set instead of releasing the claim, and every timer query
 * (`dueTimers`, `timers`, `nextMaintenanceDeadline`) excludes a row with
 * `failed_at` set, the same way they already exclude `cleared_at`. Never a
 * delete, same reasoning as `fired_at`/`cleared_at`: the row (and its
 * now-known reason) stays inspectable.
 */
const ADD_TIMER_DELIVERY_ATTEMPTS: Migration = {
  version: 5,
  description: "timers.attempts and timers.failed_at for bounded delivery retry",
  up(db) {
    addColumnIfMissing(db, "ALTER TABLE timers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "ALTER TABLE timers ADD COLUMN failed_at TEXT");
  },
};

/**
 * `timers.claimed_at`/`timers.claim_token`: a recoverable claim. Before this,
 * `claimTimer` wrote the terminal `fired_at` the instant a firing pass
 * picked a timer up, *before* the async inbox write that actually delivers
 * it -- a crash (or the daemon's own `stop()` closing the SQLite handle)
 * between those two steps left the row permanently excluded from
 * `dueTimers()` with no message ever sent and no failure ever recorded.
 * `claimed_at`/`claim_token` mark a delivery attempt in progress without
 * being terminal: `dueTimers()` still offers a row back once its claim is
 * older than `TIMER_CLAIM_STALE_MS`, and a fresh daemon process reclaims
 * every outstanding claim unconditionally on `start()` (any claim found
 * there is guaranteed to be from a now-dead prior process, since a daemon
 * refuses to start against a socket another instance already holds).
 * `fired_at` is now set only via `confirmTimerDelivered`, after the inbox
 * message is confirmed durable -- and that confirmation is itself idempotent
 * by timer identity (`src/inbox.ts`'s `sendInboxMessageAt`), so a delivery
 * that actually succeeded just before a crash, then gets retried after
 * reclaim, still produces exactly one inbox entry.
 */
const ADD_TIMER_CLAIM_RECOVERY: Migration = {
  version: 6,
  description: "timers.claimed_at and timers.claim_token for a recoverable (crash-safe) delivery claim",
  up(db) {
    addColumnIfMissing(db, "ALTER TABLE timers ADD COLUMN claimed_at TEXT");
    addColumnIfMissing(db, "ALTER TABLE timers ADD COLUMN claim_token TEXT");
  },
};

/**
 * `timers.delivery_id`: a unique identity for one timer's inbox delivery,
 * generated once by `setTimer` (and regenerated whenever the same owner+name
 * is re-set -- see setTimer's own doc comment) and carried through to the
 * inbox message itself (its filename and its own `delivery_id` field --
 * `src/inbox.ts`'s `sendInboxMessageAt`). Before this, the filename alone
 * was derived from a hash of the timer's own `name` and `at`: with only
 * ~1000 distinct values per owner per second, and sharing its filename
 * space with ordinary hand-off messages sent via `headroom inbox send`, two
 * unrelated messages could land on the exact same path -- and
 * `sendInboxMessageAt`'s own idempotency check, trusting "a file already
 * exists here" alone, would then treat the SECOND timer's delivery as
 * already done (returning `delivered: false`) without ever actually
 * writing its content, while the daemon still marked it fired. A random,
 * per-registration `delivery_id` removes the collision risk, and
 * `sendInboxMessageAt` now verifies the existing file's own `delivery_id`
 * field before ever treating it as a match.
 */
const ADD_TIMER_DELIVERY_ID: Migration = {
  version: 7,
  description: "timers.delivery_id, a unique per-registration inbox delivery identity",
  up(db) {
    addColumnIfMissing(db, "ALTER TABLE timers ADD COLUMN delivery_id INTEGER");
  },
};

/** Every migration, in ascending version order. Append here; never insert or
 * edit in place. */
export const MIGRATIONS: Migration[] = [BASELINE, ADD_EVENT_METADATA, ADD_KNOWN_MODELS, ADD_HEARTBEATS_AND_TIMERS, ADD_TIMER_DELIVERY_ATTEMPTS, ADD_TIMER_CLAIM_RECOVERY, ADD_TIMER_DELIVERY_ID];

/** The highest schema version this binary knows how to open and migrate to. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** The schema version at or above which the `heartbeats`/`timers` tables
 * exist (ADD_HEARTBEATS_AND_TIMERS, above). `HeadroomStore.open()` always
 * migrates up to CURRENT_SCHEMA_VERSION before returning, so this only
 * matters for `openReadOnly()`'s non-migrating connection (the cached-status
 * path in mcp.ts/cli.ts): a database written by a pre-0.2.0 daemon and never
 * since opened for a write is still on an older `PRAGMA user_version`, and
 * querying either table on that connection would fail with "no such table"
 * rather than the empty-list-shaped "no heartbeats/timers registered" a
 * caller expects from a plain compatibility gap. */
export const HEARTBEATS_SCHEMA_VERSION = ADD_HEARTBEATS_AND_TIMERS.version;

/** The schema version at or above which `timers` also has its `attempts`/
 * `failed_at` columns (ADD_TIMER_DELIVERY_ATTEMPTS, above). Store.ts's
 * `timers()` -- the one timer read reachable through `openReadOnly()`'s
 * non-migrating connection, via the cached-status path -- gates on this
 * rather than HEARTBEATS_SCHEMA_VERSION: a database on exactly schema 4 (the
 * `timers` table exists, but not yet these two columns) would otherwise
 * fail that query with "no such column: failed_at", the same class of bug
 * HEARTBEATS_SCHEMA_VERSION exists to prevent, just one migration later. */
export const TIMER_DELIVERY_SCHEMA_VERSION = ADD_TIMER_DELIVERY_ATTEMPTS.version;

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
