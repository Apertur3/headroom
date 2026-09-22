/**
 * Pure, per-line vendor-format detection for `headroom usage import --format
 * auto`. Distinguishes a Claude Code assistant-transcript line from a Codex
 * CLI session-log line by structural shape -- never by trusting a `--format`
 * flag the caller might have gotten wrong, and never by guessing from the
 * file's name, extension or location (both vendors write plain `.jsonl`
 * files, and a caller can point `--path` at a copy under any name).
 *
 * Claude Code transcript lines carry their payload directly on the line
 * (`message: { id, model, usage }`, a sibling of `type`/`timestamp`). Codex
 * CLI session lines always wrap theirs in a `payload` object instead
 * (`payload.response_id`/`payload.usage`, or `payload.type === "token_count"`
 * with `payload.rate_limits`) -- see usage-events.ts's `parseUsageLine` and
 * codex-usage-events.ts's `parseCodexUsageLine` for the two shapes this
 * mirrors, without depending on either (this module never re-derives a
 * snapshot, only a format label; the two real parsers remain the only place
 * that validates or persists anything).
 *
 * Detection runs per line, never buffering or pre-scanning a whole file:
 * the collector's own reads are already bounded and incremental (one batch
 * of bytes at a time, resumable across runs), and a single Claude or Codex
 * transcript is realistically homogeneous line-to-line anyway, so per-line
 * detection costs nothing extra while staying correct even for a batch that
 * starts mid-file with no surrounding context.
 */

export type UsageLineFormat = "claude" | "codex" | "unknown";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The two `type` values codex-usage-events.ts's parser treats as
 * potentially usage-bearing. Every other Codex session-line type (e.g.
 * `session_meta`, `turn_context`) is itself skipped by that parser too --
 * see codex-usage-events.ts's `parseCodexUsageLine` -- so misrouting one of
 * those here (to the Claude parser, which will just as harmlessly skip or
 * reject it) costs nothing. */
const CODEX_USAGE_TYPES = new Set(["token_usage_record", "event_msg"]);

/**
 * Never throws: an unparseable or ambiguous line comes back `"unknown"`
 * rather than an error or a guess. The caller (usage-collector.ts) decides
 * what "unknown" means for its own routing; this module only classifies.
 */
export function detectUsageLineFormat(line: string): UsageLineFormat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "unknown";
  }
  const entry = record(parsed);
  if (!entry) return "unknown";

  const hasMessage = record(entry.message) !== null;
  const hasPayload = record(entry.payload) !== null;
  // The unambiguous, common case: exactly one of the two vendor-defining
  // wrapper fields is present.
  if (hasMessage && !hasPayload) return "claude";
  if (hasPayload && !hasMessage) return "codex";

  // Ambiguous (both wrapper fields present, or neither): fall back to the
  // exact, fixed `type` vocabulary each downstream parser itself keys off,
  // resolving only the values unique to one vendor. Any other `type` (or no
  // `type` at all) stays "unknown" -- guessing further would risk routing a
  // line neither parser was built for into the wrong one's identity space.
  if (typeof entry.type === "string") {
    if (entry.type === "assistant") return "claude";
    if (CODEX_USAGE_TYPES.has(entry.type)) return "codex";
  }
  return "unknown";
}
