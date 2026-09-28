/**
 * The stable, versioned envelope for every machine-readable Headroom output:
 * a CLI `--json` result and an MCP tool result both carry the same two
 * fields, `contract` and `generated_at`, so a caller can tell which shape it
 * is reading and how fresh the read is without guessing from field presence
 * alone. See docs/json-contract.md for the full field-by-field reference and
 * the compatibility promise this version number stands behind.
 *
 * Only ever applied to an object-shaped payload. A bare JSON array (the
 * top-level shape of `cost`, `rate`, `spend`, and `events` --json output, and
 * of the equivalent MCP tool results when a daemon answers them) has no place
 * to carry named fields without becoming a different shape entirely -- see
 * docs/json-contract.md's "Array-shaped outputs" section for the full list
 * and the reasoning. Those outputs are documented like every other output,
 * just without the envelope.
 */

/** The current contract version. Bump the major component only for a
 * breaking change (a field renamed or removed, or an output shape changed);
 * additive changes (a new field, a new output, a new enum member) keep the
 * same major and do not require a version bump at all -- see the
 * compatibility promise in docs/json-contract.md. */
export const JSON_CONTRACT_VERSION = "1.0";

/** Where the full contract reference lives, relative to the package root.
 * Printed by `headroom contract` rather than resolved on disk, matching how
 * other commands already point at their own docs (e.g. notify.ts's "See
 * docs/notifications.md."). */
export const JSON_CONTRACT_DOC_PATH = "docs/json-contract.md";

/** Normalizes one timer row from a daemon JSON-RPC reply to the current
 * additive shape: `attempts`/`failed_at` default to `0`/`null` when a still-
 * running OLDER daemon's own reply predates those two fields (see
 * docs/json-contract.md's `timer list` entry) -- the same defaulting
 * store.ts's own `timerFromRow` already applies to a row read straight off
 * an older on-disk schema. Used at every protocol boundary a timer can
 * arrive at from a daemon RPC reply rather than a local store read: the CLI's
 * `timer list` command and `observe()`'s `due_timers`, and MCP's
 * `quota_status`. A malformed (non-object) row still gets the same
 * defaulting rather than propagating `undefined` fields into a result a
 * caller expects the documented shape from -- every OTHER Timer field
 * passes through unchanged, this only ever adds or defaults the two
 * additive ones. */
export function normalizeDaemonTimer(row: unknown): TimerLike {
  const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
  return { ...record, attempts: typeof record.attempts === "number" ? record.attempts : 0, failed_at: typeof record.failed_at === "string" ? record.failed_at : null } as TimerLike;
}

/** `normalizeDaemonTimer`, applied across a whole `timer list`/`due_timers`
 * array. A non-array input (an older daemon's reply shape this call site
 * has already reduced to `[]` before ever reaching here, or a defensive
 * cast gone wrong) returns `[]` rather than throwing. */
export function normalizeDaemonTimers(rows: unknown): TimerLike[] {
  return Array.isArray(rows) ? rows.map(normalizeDaemonTimer) : [];
}

/** A structural stand-in for `types.ts`'s `Timer`: `normalizeDaemonTimer`
 * only ever adds/defaults two fields onto whatever object it was given, so
 * it cannot itself prove the daemon reply carried every other required
 * field -- callers already trust that reply enough to cast it, same as
 * before this normalizer existed. */
type TimerLike = Record<string, unknown>;

/** True for a plain JSON object eligible for the contract envelope: not an
 * array, not null. Used at the single points that assemble a CLI `--json`
 * result or an MCP tool result so the same rule decides, uniformly, which
 * outputs get stamped and which stay bare arrays. */
export function isEnvelopable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stamps `contract` and `generated_at` onto an object-shaped payload,
 * placed after the payload's own fields so a stray field of either name in
 * the payload itself can never shadow the real contract version or
 * timestamp. `now` is injectable for tests; every call site uses the real
 * clock. Accepts any of the CLI/MCP result interfaces (none of which declare
 * a string index signature of their own), not just a plain
 * `Record<string, unknown>`. */
export function withContract<T extends object>(payload: T, now: Date = new Date()): T & { contract: string; generated_at: string } {
  return { ...payload, contract: JSON_CONTRACT_VERSION, generated_at: now.toISOString() };
}
