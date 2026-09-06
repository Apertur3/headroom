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
