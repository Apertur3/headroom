/**
 * Schema and persistence primitives for the private, opt-in `usage.db`
 * database (see usage-db.ts for the safe file open this builds on). This
 * module owns:
 *
 * - Its own schema version (`PRAGMA user_version` on `usage.db`), entirely
 *   independent of `headroom.db`'s schema versioning in migrations.ts --
 *   bumping one never touches the other.
 * - Per-database alias hashing: `--source`/`--principal`/`--job` CLI
 *   aliases and canonical input paths are never persisted as free text, only
 *   as an HMAC keyed by a random salt generated once per database, inside the
 *   same transaction that creates the schema. The salt makes hashes stable
 *   within one database (so repeat imports and status filters recompute the
 *   same hash) and unlinkable across databases -- it is NOT a defense if this
 *   database itself is exfiltrated: the salt sits right next to the hashes it
 *   keys, so a dictionary attack against a small alias space still works
 *   against an exfiltrated copy.
 * - Cursor rows: one per (source, canonicalized file path) pair, carrying a
 *   monotonic `revision` used as an optimistic compare-and-set token, so a
 *   collector that read the filesystem outside the write lock can prove its
 *   baseline is still current before committing anything.
 * - Path bindings: one row per canonical input path, pinning the source and
 *   principal that path was first imported under, so a second alias cannot
 *   silently re-attribute the same bytes.
 * - Usage identity rows: the durable form of usage-events.ts's
 *   `AccumulatedUsageEntry`/`QuarantinedUsageEntry`, persisted one identity
 *   at a time -- callers fetch a single identity's prior state, fold in one
 *   snapshot with the pure `applyUsageSnapshot`, and write back only that
 *   identity, so a large database is never loaded into memory to import one
 *   line.
 * - Identity/job linkage: an optional, explicitly declared claim, recorded
 *   per identity so the same physical identity arriving from a copy under a
 *   different job is flagged conflicted rather than claimed twice.
 * - Per-cursor outcome counters (accepted/duplicate/rejected/.../
 *   quarantined, one row per (cursor, kind)), the only per-line bookkeeping
 *   this keeps; no raw line content or per-line log is ever stored.
 *
 * Everything crossing the persistence boundary is revalidated here at
 * runtime (shape, enum membership, numeric range), not merely typed: a
 * caller's compile-time types say nothing about what a transcript actually
 * contained.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { AccumulatedUsageEntry, ClaudeUsageSnapshot, NumericField, QuarantineReason, UsageAccumulatorState } from "./usage-events.js";
import { applyUsageSnapshot, createUsageAccumulator } from "./usage-events.js";
import type { AccumulatedCodexUsageEntry, CodexQuarantineReason, CodexUsageAccumulatorState, CodexUsageFields, CodexUsageSnapshot } from "./codex-usage-events.js";
import { applyCodexUsageSnapshot, createCodexUsageAccumulator } from "./codex-usage-events.js";
import { openUsageDatabase, type UsageDatabase } from "./usage-db.js";

export const CURRENT_USAGE_SCHEMA_VERSION = 2;

/** `model` is `NOT NULL` on `usage_identities`, but a Codex counter record
 * carries no model field at all (see codex-usage-events.ts). This fixed
 * sentinel fills the column for every Codex row instead of a fabricated or
 * guessed model id; `model_attribution = 'unavailable_in_record'` on the same
 * row is what tells a reader the sentinel is standing in for "not present",
 * never a real model. */
export const CODEX_UNAVAILABLE_MODEL = "codex:unavailable";

export class NewerUsageSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`usage.db schema v${found} is newer than this build supports (v${supported}); refusing to open it`);
    this.name = "NewerUsageSchemaError";
  }
}

/** A database that passed the version check but is missing state the schema
 * guarantees. Fixed text: never carries a value read out of the database. */
export class UsageStateError extends Error {
  constructor(readonly detail: "missing_alias_salt") {
    super(`usage.db is unusable: ${detail}`);
    this.name = "UsageStateError";
  }
}

export type PersistenceField =
  | "identity_key" | "source_key" | "principal_key" | "job_key" | "path_key"
  | "model" | "observed_at_ms" | "sequence" | "counter_value" | "counter_diagnosis"
  | "counter_kind" | "quarantine_reason" | "cursor_key" | "cursor_number"
  | "cursor_status" | "cursor_hash" | "cursor_device_id"
  | "vendor" | "model_attribution" | "consistency_flags";

/** Refusal at the persistence boundary. The message names only the *field*
 * that failed, never the rejected value -- the whole point of the check is
 * that the value may be attacker-controlled transcript content. */
export class UsagePersistenceError extends Error {
  constructor(readonly field: PersistenceField) {
    super(`refusing to persist invalid usage field: ${field}`);
    this.name = "UsagePersistenceError";
  }
}

type AliasKind = "source" | "principal" | "job" | "path";

export type CursorStatus = "ok" | "interrupted";

/** Why a cursor was left interrupted. Enum only; the operator-facing layer
 * renders it, so no OS error or path text ever reaches it. */
export type InterruptReason = "boundary_changed" | "changed_during_scan" | "concurrent_update";

export interface CursorRow {
  cursorKey: string;
  sourceKey: string;
  principalKey: string;
  jobKey: string | null;
  jobConflict: boolean;
  dev: string | null;
  ino: string | null;
  generation: number;
  /** Optimistic concurrency token: bumped on every committed write, compared
   * under the write lock against the value the caller read before it did its
   * (unlocked, async) filesystem work. */
  revision: number;
  byteOffset: number;
  prefixLen: number;
  prefixHash: string | null;
  boundaryHash: string | null;
  discardPending: boolean;
  discardBytes: number;
  /** Capture state, persisted so status can say what a cursor is waiting on
   * without re-reading the file: a committed offset is not the same thing as
   * "this file is fully imported". */
  atEof: boolean;
  pendingPartial: boolean;
  budgetExhausted: boolean;
  status: CursorStatus;
  interruptReason: InterruptReason | null;
  totalBytesRead: number;
  lastScanAt: string | null;
  createdAt: string;
}

export interface PathBinding {
  pathKey: string;
  sourceKey: string;
  principalKey: string;
  createdAt: string;
}

export type IdentityOutcome = "accepted_new" | "accepted_updated" | "duplicate" | "stale_ignored" | "quarantined_new" | "quarantined_repeat";

/** `bound` recorded a first claim, `unchanged` re-saw the same claim,
 * `conflict` saw a second, different claim for one physical identity: the
 * ambiguous association is removed and the identity is flagged instead of
 * letting either job claim it. */
export type JobBindingOutcome = "bound" | "unchanged" | "conflict" | "already_conflicted";

export interface GroupedTotal {
  vendor: "claude" | "codex";
  principalKey: string;
  sourceKey: string;
  model: string;
  identityCount: number;
  inputTokens: SafeSum;
  outputTokens: SafeSum;
  cacheReadInputTokens: SafeSum;
  cacheCreationInputTokens: SafeSum;
  /** Present only on `vendor: "codex"` groups -- Codex's own counter
   * vocabulary has no Claude analogue for these four. */
  cachedInputTokens?: SafeSum;
  cacheWriteTokens?: SafeSum;
  reasoningTokens?: SafeSum;
  totalTokens?: SafeSum;
}

/** Same shape as `GroupedTotal` with the Codex-only fields made mandatory,
 * for callers that already know they are looking at a Codex group. */
export interface CodexGroupedTotal extends GroupedTotal {
  vendor: "codex";
  cachedInputTokens: SafeSum;
  cacheWriteTokens: SafeSum;
  reasoningTokens: SafeSum;
  totalTokens: SafeSum;
}

/** A sum kept safe-integer-exact when possible. `total` is `null` both when
 * nothing was observed (`known === 0`) and when the exact total would exceed
 * `Number.MAX_SAFE_INTEGER` (`overflow`); the two are told apart by those
 * fields, and neither is ever rendered as a plain `0`. */
export interface SafeSum {
  total: number | null;
  overflow: boolean;
  known: number;
  unknown: number;
}

export interface StatusFilter {
  sourceKeyHash?: string;
  principalKeyHash?: string;
}

const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const COUNTER_KIND_RE = /^[a-z_]+(?::[a-z_]+)?$/;
const DEVICE_ID_RE = /^-?[0-9]{1,20}$/;
const NUMERIC_DIAGNOSES = new Set(["not_a_number", "not_finite", "not_integer", "negative", "unsafe_integer"]);
const QUARANTINE_REASONS = new Set<string>(["identity_model_conflict", "conflicting_same_version"]);
const CODEX_QUARANTINE_REASONS = new Set<string>(["conflicting_same_version", "identity_conflict"]);
const CODEX_CONSISTENCY_FLAGS = new Set<string>(["cached_exceeds_input", "reasoning_exceeds_output", "total_mismatch", "incomplete"]);
/** Upper bound on an accepted observation timestamp (2100-01-01T00:00:00Z):
 * far enough out to never reject real data, close enough to reject a number
 * smuggled through a timestamp field. */
const MAX_OBSERVED_AT_MS = 4102444800000;
const MAX_SEQUENCE = 2 ** 40;

/** Real Claude Code transcript model ids only: the legacy `claude-3(-5|-7)-
 * <family>-<date>` ordering and the newer `claude-<family>-<version>[-
 * <minor>][-<date>]` ordering (including bare, dateless aliases like
 * `claude-sonnet-5`/`claude-opus-5`/`claude-fable-5-1`). A generic
 * alphanumeric pattern would happily admit an opaque secret or a prompt
 * fragment smuggled through the `model` field; this only ever admits a shape
 * Anthropic actually ships. Lives here, at the persistence boundary, so the
 * check cannot be skipped by a caller that writes directly to the store. */
const CLAUDE_MODEL_RE = /^claude-(?:3(?:-5|-7)?-(?:opus|sonnet|haiku)-\d{8}|(?:opus|sonnet|haiku|fable)-\d(?:-\d)?(?:-\d{8})?)$/;
const MAX_MODEL_ID_LENGTH = 48;

export function isKnownClaudeModel(model: string): boolean {
  return model.length <= MAX_MODEL_ID_LENGTH && CLAUDE_MODEL_RE.test(model);
}

function assertHex32(value: unknown, field: PersistenceField): string {
  if (typeof value !== "string" || !HEX32_RE.test(value)) throw new UsagePersistenceError(field);
  return value;
}

function assertOptionalHex32(value: unknown, field: PersistenceField): string | null {
  if (value === null || value === undefined) return null;
  return assertHex32(value, field);
}

function assertRange(value: unknown, field: PersistenceField, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new UsagePersistenceError(field);
  return value;
}

function assertCounterField(field: NumericField): NumericField {
  if (field.value !== null && (!Number.isSafeInteger(field.value) || field.value < 0)) throw new UsagePersistenceError("counter_value");
  if (field.diagnosis !== null && !NUMERIC_DIAGNOSES.has(field.diagnosis)) throw new UsagePersistenceError("counter_diagnosis");
  return field;
}

/** Full runtime validation of everything an entry contributes to a row.
 * Called on the way in for every write, including writes that originate from
 * a re-read of this database's own rows. */
function assertPersistableEntry(entry: AccumulatedUsageEntry): void {
  assertHex32(entry.identityKey, "identity_key");
  assertHex32(entry.sourceKey, "source_key");
  assertHex32(entry.principalKey, "principal_key");
  if (typeof entry.model !== "string" || !isKnownClaudeModel(entry.model)) throw new UsagePersistenceError("model");
  assertRange(entry.observedAtMs, "observed_at_ms", 0, MAX_OBSERVED_AT_MS);
  assertRange(entry.sequence, "sequence", 0, MAX_SEQUENCE);
  const usage = entry.usage;
  assertCounterField(usage.input_tokens);
  assertCounterField(usage.output_tokens);
  assertCounterField(usage.cache_read_input_tokens);
  assertCounterField(usage.cache_creation_input_tokens);
  if (usage.cache_creation_breakdown) {
    assertCounterField(usage.cache_creation_breakdown.ephemeral_5m_input_tokens);
    assertCounterField(usage.cache_creation_breakdown.ephemeral_1h_input_tokens);
  }
}

function assertPersistableSnapshot(snapshot: ClaudeUsageSnapshot): void {
  assertPersistableEntry({ ...snapshot, evidence: "message_visible" });
}

/** Same role as `assertPersistableEntry`, for a Codex identity. `model` is
 * asserted `null` (never coerced) because the persisted row always carries
 * `CODEX_UNAVAILABLE_MODEL` in its `model` column instead -- the type's own
 * `null` is what proves no real model id is being smuggled through here. */
function assertPersistableCodexEntry(entry: AccumulatedCodexUsageEntry): void {
  assertHex32(entry.identityKey, "identity_key");
  assertHex32(entry.sourceKey, "source_key");
  assertHex32(entry.principalKey, "principal_key");
  if (entry.vendor !== "codex") throw new UsagePersistenceError("vendor");
  if (entry.model !== null) throw new UsagePersistenceError("model");
  if (entry.modelAttribution !== "unavailable_in_record") throw new UsagePersistenceError("model_attribution");
  assertRange(entry.observedAtMs, "observed_at_ms", 0, MAX_OBSERVED_AT_MS);
  assertRange(entry.sequence, "sequence", 0, MAX_SEQUENCE);
  const usage = entry.usage;
  assertCounterField(usage.input_tokens);
  assertCounterField(usage.output_tokens);
  assertCounterField(usage.cached_input_tokens);
  assertCounterField(usage.cache_write_input_tokens);
  assertCounterField(usage.reasoning_output_tokens);
  assertCounterField(usage.total_tokens);
  for (const flag of entry.consistency) {
    if (!CODEX_CONSISTENCY_FLAGS.has(flag)) throw new UsagePersistenceError("consistency_flags");
  }
}

function assertPersistableCodexSnapshot(snapshot: CodexUsageSnapshot): void {
  assertPersistableCodexEntry({ ...snapshot, evidence: "usage_record_visible" });
}

function assertPersistableCursor(row: CursorRow): void {
  assertHex32(row.cursorKey, "cursor_key");
  assertHex32(row.sourceKey, "source_key");
  assertHex32(row.principalKey, "principal_key");
  assertOptionalHex32(row.jobKey, "job_key");
  for (const [value, field] of [[row.dev, "cursor_device_id"], [row.ino, "cursor_device_id"]] as const) {
    if (value !== null && (typeof value !== "string" || !DEVICE_ID_RE.test(value))) throw new UsagePersistenceError(field);
  }
  assertRange(row.generation, "cursor_number", 1, Number.MAX_SAFE_INTEGER);
  assertRange(row.revision, "cursor_number", 1, Number.MAX_SAFE_INTEGER);
  assertRange(row.byteOffset, "cursor_number", 0, Number.MAX_SAFE_INTEGER);
  assertRange(row.prefixLen, "cursor_number", 0, Number.MAX_SAFE_INTEGER);
  assertRange(row.discardBytes, "cursor_number", 0, Number.MAX_SAFE_INTEGER);
  assertRange(row.totalBytesRead, "cursor_number", 0, Number.MAX_SAFE_INTEGER);
  for (const hash of [row.prefixHash, row.boundaryHash]) {
    if (hash !== null && (typeof hash !== "string" || !HEX64_RE.test(hash))) throw new UsagePersistenceError("cursor_hash");
  }
  if (row.status !== "ok" && row.status !== "interrupted") throw new UsagePersistenceError("cursor_status");
  if (row.interruptReason !== null && !["boundary_changed", "changed_during_scan", "concurrent_update"].includes(row.interruptReason)) {
    throw new UsagePersistenceError("cursor_status");
  }
}

export class UsageStore {
  private constructor(private readonly db: UsageDatabase, private readonly aliasSalt: Buffer) {}

  /**
   * Opens (and, with `create`, initializes) the usage database.
   *
   * `create: false` never mutates anything: a missing database, and an
   * existing database that has not been initialized yet (or predates this
   * build's schema), both come back as `undefined` rather than being created
   * or migrated -- a plain `import-status` must be able to run without
   * bringing state into existence. A database *newer* than this build is
   * refused before any write-oriented PRAGMA runs against it. Any failure
   * after the underlying handle is open closes that handle before rethrowing.
   */
  static async open(options: { home?: string; create: boolean }): Promise<UsageStore | undefined> {
    const db = await openUsageDatabase(options);
    if (!db) return undefined;
    try {
      // Set first: it costs no write, and it has to be in effect before the
      // bootstrap below tries to take the write lock against a racing
      // initializer.
      db.exec("PRAGMA busy_timeout = 5000;");
      const version = usageSchemaVersion(db);
      if (version > CURRENT_USAGE_SCHEMA_VERSION) throw new NewerUsageSchemaError(version, CURRENT_USAGE_SCHEMA_VERSION);
      if (version < CURRENT_USAGE_SCHEMA_VERSION) {
        if (!options.create) {
          db.close();
          return undefined;
        }
        bootstrapSchema(db);
      }
      const salt = readAliasSalt(db);
      if (!salt) throw new UsageStateError("missing_alias_salt");
      return new UsageStore(db, salt);
    } catch (error) {
      try { db.close(); } catch { /* the original failure is the interesting one */ }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return usageSchemaVersion(this.db);
  }

  // -------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------

  /** BEGIN IMMEDIATE takes the write lock up front (rather than at the first
   * write statement), so a second collector process opening the same
   * database concurrently blocks (up to the busy_timeout above) or fails
   * fast, instead of two collectors interleaving writes and losing one
   * cursor update. `fn` must be synchronous: this database connection is
   * synchronous end to end, and holding the write lock across an `await`
   * would let unrelated work run while it is held. */
  withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* nothing to roll back if BEGIN itself failed */ }
      throw error;
    }
  }

  // -------------------------------------------------------------------
  // Alias hashing
  // -------------------------------------------------------------------

  /** Pure function of the salt read at open time: never creates state, so it
   * is safe to call outside a transaction and on a read-only status path. */
  hashAlias(kind: AliasKind, alias: string): string {
    return createHmac("sha256", this.aliasSalt).update(`${kind} ${alias}`).digest("hex").slice(0, 32);
  }

  /** The canonical filesystem path of an input file, hashed the same way an
   * alias is: the raw path is never persisted. */
  hashPath(canonicalPath: string): string {
    return this.hashAlias("path", canonicalPath);
  }

  // -------------------------------------------------------------------
  // Cursors
  // -------------------------------------------------------------------

  getCursor(cursorKey: string): CursorRow | undefined {
    const row = this.db.prepare("SELECT * FROM usage_cursors WHERE cursor_key = ?").get(cursorKey);
    return row ? cursorFromRow(row) : undefined;
  }

  /** The compare half of compare-and-set: `expected` is the revision the
   * caller saw before it left the write lock (or `null` for "there was no
   * cursor"). A mismatch means another collector committed in between and
   * this run's file reads describe a baseline that no longer exists. */
  cursorRevisionMatches(cursorKey: string, expected: number | null): boolean {
    const row = this.db.prepare("SELECT revision FROM usage_cursors WHERE cursor_key = ?").get(cursorKey);
    const current = row === undefined ? null : Number(row.revision);
    return current === expected;
  }

  putCursor(row: CursorRow): void {
    assertPersistableCursor(row);
    this.db.prepare(`INSERT INTO usage_cursors
      (cursor_key, source_key, principal_key, job_key, job_conflict, dev, ino, generation, revision, byte_offset,
       prefix_len, prefix_hash, boundary_hash, discard_pending, discard_bytes, at_eof, pending_partial, budget_exhausted,
       status, interrupt_reason, total_bytes_read, last_scan_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cursor_key) DO UPDATE SET
        source_key = excluded.source_key, principal_key = excluded.principal_key, job_key = excluded.job_key,
        job_conflict = excluded.job_conflict, dev = excluded.dev, ino = excluded.ino, generation = excluded.generation,
        revision = excluded.revision, byte_offset = excluded.byte_offset, prefix_len = excluded.prefix_len,
        prefix_hash = excluded.prefix_hash, boundary_hash = excluded.boundary_hash,
        discard_pending = excluded.discard_pending, discard_bytes = excluded.discard_bytes,
        at_eof = excluded.at_eof, pending_partial = excluded.pending_partial, budget_exhausted = excluded.budget_exhausted,
        status = excluded.status, interrupt_reason = excluded.interrupt_reason,
        total_bytes_read = excluded.total_bytes_read, last_scan_at = excluded.last_scan_at`).run(
      row.cursorKey, row.sourceKey, row.principalKey, row.jobKey, row.jobConflict ? 1 : 0, row.dev, row.ino, row.generation,
      row.revision, row.byteOffset, row.prefixLen, row.prefixHash, row.boundaryHash, row.discardPending ? 1 : 0, row.discardBytes,
      row.atEof ? 1 : 0, row.pendingPartial ? 1 : 0, row.budgetExhausted ? 1 : 0,
      row.status, row.interruptReason, row.totalBytesRead, row.lastScanAt, row.createdAt);
  }

  allCursors(filter: StatusFilter = {}): CursorRow[] {
    const rows = this.db.prepare("SELECT * FROM usage_cursors ORDER BY cursor_key ASC").all();
    return rows.map(cursorFromRow).filter((row) => matchesFilter(row, filter));
  }

  // -------------------------------------------------------------------
  // Path bindings
  // -------------------------------------------------------------------

  getPathBinding(pathKey: string): PathBinding | undefined {
    const row = this.db.prepare("SELECT * FROM usage_path_bindings WHERE path_key = ?").get(pathKey);
    if (!row) return undefined;
    return {
      pathKey: String(row.path_key),
      sourceKey: String(row.source_key),
      principalKey: String(row.principal_key),
      createdAt: String(row.created_at),
    };
  }

  /** First writer pins the path. Re-binding is not offered at all: a caller
   * that finds a different source or principal on record must refuse the
   * import, because rewriting this row would silently re-attribute every byte
   * already imported from that file. */
  bindPath(binding: PathBinding): void {
    assertHex32(binding.pathKey, "path_key");
    assertHex32(binding.sourceKey, "source_key");
    assertHex32(binding.principalKey, "principal_key");
    this.db.prepare("INSERT OR IGNORE INTO usage_path_bindings (path_key, source_key, principal_key, created_at) VALUES (?,?,?,?)")
      .run(binding.pathKey, binding.sourceKey, binding.principalKey, binding.createdAt);
  }

  // -------------------------------------------------------------------
  // Identity/job linkage
  // -------------------------------------------------------------------

  /** Records an explicitly declared `--job` claim for one identity. A job
   * label is linkage evidence a human typed, not proof of ownership, so a
   * second, different claim for the same physical identity (the same message
   * imported again from a copied transcript) drops the association entirely
   * and marks the identity conflicted rather than picking a winner. Once
   * conflicted, an identity stays conflicted. */
  bindIdentityJob(identityKey: string, jobKey: string): JobBindingOutcome {
    assertHex32(identityKey, "identity_key");
    assertHex32(jobKey, "job_key");
    const row = this.db.prepare("SELECT job_key, conflicted FROM usage_identity_jobs WHERE identity_key = ?").get(identityKey);
    const now = new Date().toISOString();
    if (!row) {
      this.db.prepare("INSERT INTO usage_identity_jobs (identity_key, job_key, conflicted, updated_at) VALUES (?,?,0,?)").run(identityKey, jobKey, now);
      return "bound";
    }
    if (Number(row.conflicted) === 1) return "already_conflicted";
    if (row.job_key !== null && row.job_key !== undefined && String(row.job_key) === jobKey) return "unchanged";
    this.db.prepare("UPDATE usage_identity_jobs SET job_key = NULL, conflicted = 1, updated_at = ? WHERE identity_key = ?").run(now, identityKey);
    return "conflict";
  }

  identityJob(identityKey: string): { jobKey: string | null; conflicted: boolean } | undefined {
    const row = this.db.prepare("SELECT job_key, conflicted FROM usage_identity_jobs WHERE identity_key = ?").get(identityKey);
    if (!row) return undefined;
    return {
      jobKey: row.job_key === null || row.job_key === undefined ? null : String(row.job_key),
      conflicted: Number(row.conflicted) === 1,
    };
  }

  jobConflictCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM usage_identity_jobs WHERE conflicted = 1").get();
    return row ? Number(row.n) : 0;
  }

  // -------------------------------------------------------------------
  // Identities: fetch-one, apply-pure, write-one
  // -------------------------------------------------------------------

  /** At most a singleton entries map and a singleton quarantined map -- the
   * exact shape `applyUsageSnapshot` (usage-events.ts) expects -- built from
   * one identity's stored row, never the whole table. */
  private fetchSingleton(identityKey: string): UsageAccumulatorState {
    const quarantineRow = this.db.prepare("SELECT reason FROM usage_quarantine WHERE identity_key = ?").get(identityKey);
    if (quarantineRow) {
      const reason = String(quarantineRow.reason);
      if (!QUARANTINE_REASONS.has(reason)) throw new UsagePersistenceError("quarantine_reason");
      return { entries: new Map(), quarantined: new Map([[identityKey, { identityKey, reason: reason as QuarantineReason }]]) };
    }
    const entryRow = this.db.prepare("SELECT * FROM usage_identities WHERE identity_key = ? AND vendor = 'claude'").get(identityKey);
    if (!entryRow) return createUsageAccumulator();
    return { entries: new Map([[identityKey, entryFromRow(entryRow)]]), quarantined: new Map() };
  }

  /** Same role as `fetchSingleton`, for a Codex identity. The `vendor = 'codex'`
   * guard on the row read means a Claude and a Codex identity can never be
   * confused even in the (structurally impossible, given the normalizer's own
   * "codex"-prefixed hash) case of a colliding `identity_key`. */
  private fetchSingletonCodex(identityKey: string): CodexUsageAccumulatorState {
    const quarantineRow = this.db.prepare("SELECT reason FROM usage_quarantine WHERE identity_key = ?").get(identityKey);
    if (quarantineRow) {
      const reason = String(quarantineRow.reason);
      if (!CODEX_QUARANTINE_REASONS.has(reason)) throw new UsagePersistenceError("quarantine_reason");
      return { entries: new Map(), quarantined: new Map([[identityKey, { identityKey, reason: reason as CodexQuarantineReason }]]) };
    }
    const entryRow = this.db.prepare("SELECT * FROM usage_identities WHERE identity_key = ? AND vendor = 'codex'").get(identityKey);
    if (!entryRow) return createCodexUsageAccumulator();
    return { entries: new Map([[identityKey, codexEntryFromRow(entryRow)]]), quarantined: new Map() };
  }

  /** Folds one snapshot into its identity's prior state with the pure
   * accumulator function, then persists only the delta: a new or corrected
   * entry is upserted, a newly-quarantined identity replaces its entry row
   * with a quarantine row (keeping the source and principal it was observed
   * under, so a scoped status query can still count it), and every other
   * outcome (duplicate tie, an older/out-of-order snapshot, an
   * already-quarantined repeat) writes nothing at all.
   *
   * The snapshot is fully revalidated first: an unknown model, a non-opaque
   * key, an out-of-range timestamp or a fabricated diagnosis throws
   * `UsagePersistenceError` *before* any statement runs, so nothing invalid
   * -- and no raw transcript string -- ever reaches SQLite. */
  applyAndPersist(snapshot: ClaudeUsageSnapshot): IdentityOutcome {
    assertPersistableSnapshot(snapshot);
    const prior = this.fetchSingleton(snapshot.identityKey);
    const next = applyUsageSnapshot(prior, snapshot);
    const hadEntry = prior.entries.get(snapshot.identityKey);
    const hasEntry = next.entries.get(snapshot.identityKey);
    const hadQuarantine = prior.quarantined.has(snapshot.identityKey);
    const hasQuarantine = next.quarantined.get(snapshot.identityKey);
    const now = new Date().toISOString();

    if (hasQuarantine) {
      if (hadQuarantine) return "quarantined_repeat";
      this.db.prepare("DELETE FROM usage_identities WHERE identity_key = ?").run(snapshot.identityKey);
      this.db.prepare(`INSERT INTO usage_quarantine (identity_key, source_key, principal_key, reason, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(identity_key) DO UPDATE SET source_key = excluded.source_key, principal_key = excluded.principal_key,
          reason = excluded.reason, updated_at = excluded.updated_at`)
        .run(snapshot.identityKey, snapshot.sourceKey, snapshot.principalKey, hasQuarantine.reason, now);
      return "quarantined_new";
    }
    if (hadEntry && hasEntry && hadEntry === hasEntry) {
      // applyUsageSnapshot returns the identical state object for both a
      // no-op idempotent tie and a dropped older/out-of-order revision; the
      // two are told apart here by comparing the incoming timestamp, never
      // by re-deriving field equality.
      return snapshot.observedAtMs === hadEntry.observedAtMs ? "duplicate" : "stale_ignored";
    }
    if (hasEntry) {
      this.writeEntry(hasEntry, now);
      return hadEntry ? "accepted_updated" : "accepted_new";
    }
    // Unreachable given applyUsageSnapshot's own contract (an entry is only
    // ever removed by quarantining, handled above), kept as a safe fallback.
    return "duplicate";
  }

  /** Codex analogue of `applyAndPersist`, folding one Codex snapshot through
   * the pure Codex accumulator (`applyCodexUsageSnapshot`) and persisting
   * only the delta -- same outcome vocabulary, same fetch-one/apply-pure/
   * write-one shape, distinguished only by which columns and which
   * accumulator it reads/writes. */
  applyAndPersistCodex(snapshot: CodexUsageSnapshot): IdentityOutcome {
    assertPersistableCodexSnapshot(snapshot);
    const prior = this.fetchSingletonCodex(snapshot.identityKey);
    const next = applyCodexUsageSnapshot(prior, snapshot);
    const hadEntry = prior.entries.get(snapshot.identityKey);
    const hasEntry = next.entries.get(snapshot.identityKey);
    const hadQuarantine = prior.quarantined.has(snapshot.identityKey);
    const hasQuarantine = next.quarantined.get(snapshot.identityKey);
    const now = new Date().toISOString();

    if (hasQuarantine) {
      if (hadQuarantine) return "quarantined_repeat";
      this.db.prepare("DELETE FROM usage_identities WHERE identity_key = ?").run(snapshot.identityKey);
      this.db.prepare(`INSERT INTO usage_quarantine (identity_key, source_key, principal_key, reason, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(identity_key) DO UPDATE SET source_key = excluded.source_key, principal_key = excluded.principal_key,
          reason = excluded.reason, updated_at = excluded.updated_at`)
        .run(snapshot.identityKey, snapshot.sourceKey, snapshot.principalKey, hasQuarantine.reason, now);
      return "quarantined_new";
    }
    if (hadEntry && hasEntry && hadEntry === hasEntry) {
      return snapshot.observedAtMs === hadEntry.observedAtMs ? "duplicate" : "stale_ignored";
    }
    if (hasEntry) {
      this.writeCodexEntry(hasEntry, now);
      return hadEntry ? "accepted_updated" : "accepted_new";
    }
    return "duplicate";
  }

  private writeEntry(entry: AccumulatedUsageEntry, now: string): void {
    assertPersistableEntry(entry);
    const u = entry.usage;
    const breakdown = u.cache_creation_breakdown;
    this.db.prepare(`INSERT INTO usage_identities
      (identity_key, source_key, principal_key, model, observed_at_ms, sequence,
       input_tokens_value, input_tokens_diagnosis, output_tokens_value, output_tokens_diagnosis,
       cache_read_value, cache_read_diagnosis, cache_creation_value, cache_creation_diagnosis,
       cache_breakdown_present, cache_5m_value, cache_5m_diagnosis, cache_1h_value, cache_1h_diagnosis, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(identity_key) DO UPDATE SET
        source_key = excluded.source_key, principal_key = excluded.principal_key, model = excluded.model,
        observed_at_ms = excluded.observed_at_ms, sequence = excluded.sequence,
        input_tokens_value = excluded.input_tokens_value, input_tokens_diagnosis = excluded.input_tokens_diagnosis,
        output_tokens_value = excluded.output_tokens_value, output_tokens_diagnosis = excluded.output_tokens_diagnosis,
        cache_read_value = excluded.cache_read_value, cache_read_diagnosis = excluded.cache_read_diagnosis,
        cache_creation_value = excluded.cache_creation_value, cache_creation_diagnosis = excluded.cache_creation_diagnosis,
        cache_breakdown_present = excluded.cache_breakdown_present,
        cache_5m_value = excluded.cache_5m_value, cache_5m_diagnosis = excluded.cache_5m_diagnosis,
        cache_1h_value = excluded.cache_1h_value, cache_1h_diagnosis = excluded.cache_1h_diagnosis,
        updated_at = excluded.updated_at`).run(
      entry.identityKey, entry.sourceKey, entry.principalKey, entry.model, entry.observedAtMs, entry.sequence,
      u.input_tokens.value, u.input_tokens.diagnosis, u.output_tokens.value, u.output_tokens.diagnosis,
      u.cache_read_input_tokens.value, u.cache_read_input_tokens.diagnosis,
      u.cache_creation_input_tokens.value, u.cache_creation_input_tokens.diagnosis,
      breakdown ? 1 : 0,
      breakdown ? breakdown.ephemeral_5m_input_tokens.value : null, breakdown ? breakdown.ephemeral_5m_input_tokens.diagnosis : null,
      breakdown ? breakdown.ephemeral_1h_input_tokens.value : null, breakdown ? breakdown.ephemeral_1h_input_tokens.diagnosis : null,
      now);
  }

  /** Codex analogue of `writeEntry`. `model` is always written as
   * `CODEX_UNAVAILABLE_MODEL` (the column is `NOT NULL`); `vendor` and
   * `model_attribution` are what let a reader tell that sentinel apart from
   * a real, unrecognized Claude model id. */
  private writeCodexEntry(entry: AccumulatedCodexUsageEntry, now: string): void {
    assertPersistableCodexEntry(entry);
    const u: CodexUsageFields = entry.usage;
    this.db.prepare(`INSERT INTO usage_identities
      (identity_key, source_key, principal_key, model, vendor, model_attribution, observed_at_ms, sequence,
       input_tokens_value, input_tokens_diagnosis, output_tokens_value, output_tokens_diagnosis,
       cached_input_value, cached_input_diagnosis, cache_write_value, cache_write_diagnosis,
       reasoning_value, reasoning_diagnosis, total_value, total_diagnosis, consistency_flags, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(identity_key) DO UPDATE SET
        source_key = excluded.source_key, principal_key = excluded.principal_key, model = excluded.model,
        vendor = excluded.vendor, model_attribution = excluded.model_attribution,
        observed_at_ms = excluded.observed_at_ms, sequence = excluded.sequence,
        input_tokens_value = excluded.input_tokens_value, input_tokens_diagnosis = excluded.input_tokens_diagnosis,
        output_tokens_value = excluded.output_tokens_value, output_tokens_diagnosis = excluded.output_tokens_diagnosis,
        cached_input_value = excluded.cached_input_value, cached_input_diagnosis = excluded.cached_input_diagnosis,
        cache_write_value = excluded.cache_write_value, cache_write_diagnosis = excluded.cache_write_diagnosis,
        reasoning_value = excluded.reasoning_value, reasoning_diagnosis = excluded.reasoning_diagnosis,
        total_value = excluded.total_value, total_diagnosis = excluded.total_diagnosis,
        consistency_flags = excluded.consistency_flags,
        updated_at = excluded.updated_at`).run(
      entry.identityKey, entry.sourceKey, entry.principalKey, CODEX_UNAVAILABLE_MODEL, entry.vendor, entry.modelAttribution,
      entry.observedAtMs, entry.sequence,
      u.input_tokens.value, u.input_tokens.diagnosis, u.output_tokens.value, u.output_tokens.diagnosis,
      u.cached_input_tokens.value, u.cached_input_tokens.diagnosis, u.cache_write_input_tokens.value, u.cache_write_input_tokens.diagnosis,
      u.reasoning_output_tokens.value, u.reasoning_output_tokens.diagnosis, u.total_tokens.value, u.total_tokens.diagnosis,
      JSON.stringify(entry.consistency), now);
  }

  // -------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------

  /** `kind` is an outcome label from a fixed vocabulary
   * (`accepted_new`, `rejected:malformed_json`, ...), never derived from
   * line content; the shape check here is what guarantees that. */
  incrementCounter(cursorKey: string, kind: string, delta = 1): void {
    assertHex32(cursorKey, "cursor_key");
    if (typeof kind !== "string" || kind.length > 64 || !COUNTER_KIND_RE.test(kind)) throw new UsagePersistenceError("counter_kind");
    assertRange(delta, "counter_value", 1, Number.MAX_SAFE_INTEGER);
    this.db.prepare(`INSERT INTO usage_counters (cursor_key, kind, count) VALUES (?, ?, ?)
      ON CONFLICT(cursor_key, kind) DO UPDATE SET count = count + excluded.count`).run(cursorKey, kind, delta);
  }

  counters(filter: StatusFilter = {}): Array<{ cursorKey: string; kind: string; count: number }> {
    const rows = this.db.prepare(`SELECT c.cursor_key AS cursor_key, c.kind AS kind, c.count AS count,
        u.source_key AS source_key, u.principal_key AS principal_key
      FROM usage_counters c JOIN usage_cursors u ON u.cursor_key = c.cursor_key`).all();
    return rows
      .filter((row) => matchesFilter({ sourceKey: String(row.source_key), principalKey: String(row.principal_key) }, filter))
      .map((row) => ({ cursorKey: String(row.cursor_key), kind: String(row.kind), count: Number(row.count) }));
  }

  // -------------------------------------------------------------------
  // Status aggregation
  // -------------------------------------------------------------------

  /** Quarantine rows carry the source and principal the offending identity
   * was observed under, so a scoped count is a real count -- never a `0`
   * standing in for "this scope cannot be resolved". */
  quarantineCount(filter: StatusFilter = {}): number {
    const rows = this.db.prepare("SELECT source_key, principal_key FROM usage_quarantine").all();
    return rows.filter((row) => matchesFilter({ sourceKey: String(row.source_key), principalKey: String(row.principal_key) }, filter)).length;
  }

  groupedTotals(filter: StatusFilter = {}): GroupedTotal[] {
    const rows = this.db.prepare("SELECT * FROM usage_identities").all()
      .filter((row) => matchesFilter({ sourceKey: String(row.source_key), principalKey: String(row.principal_key) }, filter));
    const groups = new Map<string, { vendor: "claude" | "codex"; principalKey: string; sourceKey: string; model: string; rows: Record<string, unknown>[] }>();
    for (const row of rows) {
      const vendor: "claude" | "codex" = row.vendor === "codex" ? "codex" : "claude";
      const key = `${vendor} ${row.principal_key} ${row.source_key} ${row.model}`;
      const group = groups.get(key) ?? { vendor, principalKey: String(row.principal_key), sourceKey: String(row.source_key), model: String(row.model), rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].map((group): GroupedTotal => ({
      vendor: group.vendor,
      principalKey: group.principalKey,
      sourceKey: group.sourceKey,
      model: group.model,
      identityCount: group.rows.length,
      inputTokens: safeSum(group.rows.map((row) => numberOrNull(row.input_tokens_value))),
      outputTokens: safeSum(group.rows.map((row) => numberOrNull(row.output_tokens_value))),
      cacheReadInputTokens: safeSum(group.rows.map((row) => numberOrNull(row.cache_read_value))),
      cacheCreationInputTokens: safeSum(group.rows.map((row) => numberOrNull(row.cache_creation_value))),
      ...(group.vendor === "codex" ? {
        cachedInputTokens: safeSum(group.rows.map((row) => numberOrNull(row.cached_input_value))),
        cacheWriteTokens: safeSum(group.rows.map((row) => numberOrNull(row.cache_write_value))),
        reasoningTokens: safeSum(group.rows.map((row) => numberOrNull(row.reasoning_value))),
        totalTokens: safeSum(group.rows.map((row) => numberOrNull(row.total_value))),
      } : {}),
    })).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.principalKey.localeCompare(b.principalKey) || a.sourceKey.localeCompare(b.sourceKey) || a.model.localeCompare(b.model));
  }
}

function matchesFilter(row: { sourceKey: string; principalKey: string }, filter: StatusFilter): boolean {
  if (filter.sourceKeyHash && row.sourceKey !== filter.sourceKeyHash) return false;
  if (filter.principalKeyHash && row.principalKey !== filter.principalKeyHash) return false;
  return true;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Sums `values` with a BigInt accumulator so a total that would exceed
 * `Number.MAX_SAFE_INTEGER` is reported as an overflow rather than a
 * silently-imprecise `number` (SQLite's own `SUM()` would happily hand back
 * a lossy floating point value past 2^53). A set with nothing observed at all
 * totals `null`, not `0`: "never seen" is not "seen, and it was zero".
 */
export function safeSum(values: readonly (number | null)[]): SafeSum {
  let total = 0n;
  let known = 0;
  let unknown = 0;
  for (const value of values) {
    if (value === null) { unknown += 1; continue; }
    known += 1;
    total += BigInt(value);
  }
  const overflow = total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER);
  if (known === 0) return { total: null, overflow: false, known, unknown };
  return { total: overflow ? null : Number(total), overflow, known, unknown };
}

function cursorFromRow(row: Record<string, unknown>): CursorRow {
  const interruptReason = row.interrupt_reason === null || row.interrupt_reason === undefined ? null : String(row.interrupt_reason);
  return {
    cursorKey: String(row.cursor_key),
    sourceKey: String(row.source_key),
    principalKey: String(row.principal_key),
    jobKey: row.job_key === null || row.job_key === undefined ? null : String(row.job_key),
    jobConflict: Number(row.job_conflict) === 1,
    dev: row.dev === null || row.dev === undefined ? null : String(row.dev),
    ino: row.ino === null || row.ino === undefined ? null : String(row.ino),
    generation: Number(row.generation),
    revision: Number(row.revision),
    byteOffset: Number(row.byte_offset),
    prefixLen: Number(row.prefix_len),
    prefixHash: row.prefix_hash === null || row.prefix_hash === undefined ? null : String(row.prefix_hash),
    boundaryHash: row.boundary_hash === null || row.boundary_hash === undefined ? null : String(row.boundary_hash),
    discardPending: Number(row.discard_pending) === 1,
    discardBytes: Number(row.discard_bytes),
    atEof: Number(row.at_eof) === 1,
    pendingPartial: Number(row.pending_partial) === 1,
    budgetExhausted: Number(row.budget_exhausted) === 1,
    status: row.status === "interrupted" ? "interrupted" : "ok",
    interruptReason: interruptReason === "boundary_changed" || interruptReason === "changed_during_scan" || interruptReason === "concurrent_update" ? interruptReason : null,
    totalBytesRead: Number(row.total_bytes_read),
    lastScanAt: row.last_scan_at === null || row.last_scan_at === undefined ? null : String(row.last_scan_at),
    createdAt: String(row.created_at),
  };
}

function diagnosisFromRow(value: unknown): NumericField["diagnosis"] {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!NUMERIC_DIAGNOSES.has(text)) throw new UsagePersistenceError("counter_diagnosis");
  return text as NumericField["diagnosis"];
}

function entryFromRow(row: Record<string, unknown>): AccumulatedUsageEntry {
  const hasBreakdown = Number(row.cache_breakdown_present) === 1;
  return {
    identityKey: String(row.identity_key),
    principalKey: String(row.principal_key),
    sourceKey: String(row.source_key),
    model: String(row.model),
    observedAtMs: Number(row.observed_at_ms),
    sequence: Number(row.sequence),
    evidence: "message_visible",
    usage: {
      input_tokens: { value: numberOrNull(row.input_tokens_value), diagnosis: diagnosisFromRow(row.input_tokens_diagnosis) },
      output_tokens: { value: numberOrNull(row.output_tokens_value), diagnosis: diagnosisFromRow(row.output_tokens_diagnosis) },
      cache_read_input_tokens: { value: numberOrNull(row.cache_read_value), diagnosis: diagnosisFromRow(row.cache_read_diagnosis) },
      cache_creation_input_tokens: { value: numberOrNull(row.cache_creation_value), diagnosis: diagnosisFromRow(row.cache_creation_diagnosis) },
      cache_creation_breakdown: hasBreakdown ? {
        ephemeral_5m_input_tokens: { value: numberOrNull(row.cache_5m_value), diagnosis: diagnosisFromRow(row.cache_5m_diagnosis) },
        ephemeral_1h_input_tokens: { value: numberOrNull(row.cache_1h_value), diagnosis: diagnosisFromRow(row.cache_1h_diagnosis) },
      } : null,
    },
  };
}

function consistencyFlagsFromRow(value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new UsagePersistenceError("consistency_flags");
  }
  if (!Array.isArray(parsed)) throw new UsagePersistenceError("consistency_flags");
  for (const flag of parsed) {
    if (typeof flag !== "string" || !CODEX_CONSISTENCY_FLAGS.has(flag)) throw new UsagePersistenceError("consistency_flags");
  }
  return parsed as string[];
}

function codexEntryFromRow(row: Record<string, unknown>): AccumulatedCodexUsageEntry {
  if (row.vendor !== "codex") throw new UsagePersistenceError("vendor");
  return {
    identityKey: String(row.identity_key),
    principalKey: String(row.principal_key),
    sourceKey: String(row.source_key),
    vendor: "codex",
    model: null,
    modelAttribution: "unavailable_in_record",
    observedAtMs: Number(row.observed_at_ms),
    sequence: Number(row.sequence),
    evidence: "usage_record_visible",
    usage: {
      input_tokens: { value: numberOrNull(row.input_tokens_value), diagnosis: diagnosisFromRow(row.input_tokens_diagnosis) },
      output_tokens: { value: numberOrNull(row.output_tokens_value), diagnosis: diagnosisFromRow(row.output_tokens_diagnosis) },
      cached_input_tokens: { value: numberOrNull(row.cached_input_value), diagnosis: diagnosisFromRow(row.cached_input_diagnosis) },
      reasoning_output_tokens: { value: numberOrNull(row.reasoning_value), diagnosis: diagnosisFromRow(row.reasoning_diagnosis) },
      cache_write_input_tokens: { value: numberOrNull(row.cache_write_value), diagnosis: diagnosisFromRow(row.cache_write_diagnosis) },
      total_tokens: { value: numberOrNull(row.total_value), diagnosis: diagnosisFromRow(row.total_diagnosis) },
    },
    consistency: consistencyFlagsFromRow(row.consistency_flags) as AccumulatedCodexUsageEntry["consistency"],
  };
}

function usageSchemaVersion(db: UsageDatabase): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  return typeof value === "number" ? value : Number(value ?? 0);
}

function readAliasSalt(db: UsageDatabase): Buffer | undefined {
  const row = db.prepare("SELECT value FROM usage_meta WHERE key = 'alias_salt'").get();
  if (!row) return undefined;
  const value = String(row.value);
  if (!/^[0-9a-f]{64}$/.test(value)) return undefined;
  return Buffer.from(value, "hex");
}

/** Creates the schema, the alias salt and the version stamp as one unit.
 * `PRAGMA user_version` participates in the surrounding transaction, so a
 * failure part-way leaves an untouched (version 0) database rather than a
 * half-built one claiming to be v1; `INSERT OR IGNORE` makes the salt safe
 * against a second process that got here first. Journal mode is deliberately
 * left at SQLite's default rollback journal -- WAL would add `-wal`/`-shm`
 * sidecars this build would then have to keep permission-checked. */
function bootstrapSchema(db: UsageDatabase): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // The version read before the lock was taken may be stale: another
    // process could have initialized (or upgraded) the database in between.
    // Re-read it here, where the write lock is held, so a newer schema is
    // never stamped back down to this build's version.
    const version = usageSchemaVersion(db);
    if (version > CURRENT_USAGE_SCHEMA_VERSION) throw new NewerUsageSchemaError(version, CURRENT_USAGE_SCHEMA_VERSION);
    if (version === CURRENT_USAGE_SCHEMA_VERSION) {
      db.exec("ROLLBACK");
      return;
    }

    if (version === 1) {
      // v1 -> v2: every table but usage_identities is already at its current
      // shape. Existing rows (all Claude, from before Codex support existed)
      // are left untouched -- ADD COLUMN only ever appends, never rewrites a
      // row -- and each NOT NULL addition carries the DEFAULT SQLite requires
      // for that to be possible at all.
      db.exec(`
        ALTER TABLE usage_identities ADD COLUMN vendor TEXT NOT NULL DEFAULT 'claude';
        ALTER TABLE usage_identities ADD COLUMN model_attribution TEXT;
        ALTER TABLE usage_identities ADD COLUMN cached_input_value INTEGER;
        ALTER TABLE usage_identities ADD COLUMN cached_input_diagnosis TEXT;
        ALTER TABLE usage_identities ADD COLUMN cache_write_value INTEGER;
        ALTER TABLE usage_identities ADD COLUMN cache_write_diagnosis TEXT;
        ALTER TABLE usage_identities ADD COLUMN reasoning_value INTEGER;
        ALTER TABLE usage_identities ADD COLUMN reasoning_diagnosis TEXT;
        ALTER TABLE usage_identities ADD COLUMN total_value INTEGER;
        ALTER TABLE usage_identities ADD COLUMN total_diagnosis TEXT;
        ALTER TABLE usage_identities ADD COLUMN consistency_flags TEXT;
        DROP INDEX IF EXISTS usage_identities_group;
        CREATE INDEX usage_identities_group ON usage_identities(vendor, principal_key, source_key, model);
      `);
      db.exec(`PRAGMA user_version = ${CURRENT_USAGE_SCHEMA_VERSION};`);
      db.exec("COMMIT");
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_cursors (
        cursor_key TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        principal_key TEXT NOT NULL,
        job_key TEXT,
        job_conflict INTEGER NOT NULL DEFAULT 0,
        dev TEXT,
        ino TEXT,
        generation INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        prefix_len INTEGER NOT NULL DEFAULT 0,
        prefix_hash TEXT,
        boundary_hash TEXT,
        discard_pending INTEGER NOT NULL DEFAULT 0,
        discard_bytes INTEGER NOT NULL DEFAULT 0,
        at_eof INTEGER NOT NULL DEFAULT 0,
        pending_partial INTEGER NOT NULL DEFAULT 0,
        budget_exhausted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        interrupt_reason TEXT,
        total_bytes_read INTEGER NOT NULL DEFAULT 0,
        last_scan_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_path_bindings (
        path_key TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        principal_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_identities (
        identity_key TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        principal_key TEXT NOT NULL,
        model TEXT NOT NULL,
        vendor TEXT NOT NULL DEFAULT 'claude',
        model_attribution TEXT,
        observed_at_ms INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        input_tokens_value INTEGER,
        input_tokens_diagnosis TEXT,
        output_tokens_value INTEGER,
        output_tokens_diagnosis TEXT,
        cache_read_value INTEGER,
        cache_read_diagnosis TEXT,
        cache_creation_value INTEGER,
        cache_creation_diagnosis TEXT,
        cache_breakdown_present INTEGER NOT NULL DEFAULT 0,
        cache_5m_value INTEGER,
        cache_5m_diagnosis TEXT,
        cache_1h_value INTEGER,
        cache_1h_diagnosis TEXT,
        cached_input_value INTEGER,
        cached_input_diagnosis TEXT,
        cache_write_value INTEGER,
        cache_write_diagnosis TEXT,
        reasoning_value INTEGER,
        reasoning_diagnosis TEXT,
        total_value INTEGER,
        total_diagnosis TEXT,
        consistency_flags TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_identities_group ON usage_identities(vendor, principal_key, source_key, model);
      CREATE TABLE IF NOT EXISTS usage_identity_jobs (
        identity_key TEXT PRIMARY KEY,
        job_key TEXT,
        conflicted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_quarantine (
        identity_key TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        principal_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_counters (
        cursor_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (cursor_key, kind)
      );
    `);
    db.prepare("INSERT OR IGNORE INTO usage_meta (key, value) VALUES ('alias_salt', ?)").run(randomBytes(32).toString("hex"));
    db.exec(`PRAGMA user_version = ${CURRENT_USAGE_SCHEMA_VERSION};`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back if BEGIN itself failed */ }
    throw error;
  }
}
