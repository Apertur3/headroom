/**
 * Pure, filesystem-free normalization and idempotent deduplication of Codex
 * CLI local-telemetry counters found in raw `~/.codex/sessions` JSONL lines.
 *
 * This is the Codex analogue of `usage-events.ts`, kept as a fully separate
 * module rather than a shared generic: Codex's per-response counter shape,
 * identity source (`response_id` instead of `message.id`), and the complete
 * absence of a model field on the counter record are different enough that
 * forcing one abstraction over both would risk changing Claude's already
 * reviewed semantics. This module itself still never reads a file or touches
 * `usage.db` directly -- it stays a pure, filesystem-free normalizer -- but
 * `usage-collector.ts` and `usage-store.ts` do wire it into `headroom usage
 * import --format codex` (and `--format auto`, via `usage-format-detect.ts`)
 * and a real `usage.db` schema; see the "Codex usage" section of
 * docs/usage-prediction.md for the current, wired-in state.
 *
 * Only one Codex payload is accepted as an accountable usage snapshot:
 * `token_usage_record.payload.usage`, the non-cumulative, per-response block. Every
 * other numeric carrier (`turn_token_usage`, `thread_token_usage`, and
 * `event_msg`'s `token_count.info`) is either cumulative, unidentified, or
 * both, and summing or deduplicating it would silently fabricate a delta this
 * slice has no sound way to compute -- so it is classified and reported, but
 * never turned into a snapshot. `event_msg`'s `rate_limits` block is a
 * separate, account-level meter observation with no per-call identity of its
 * own; it is parsed independently and never linked to any token count.
 */
import { createHash } from "node:crypto";
import { MAX_LINE_BYTES, normalizeUsageCounter, type NumericField, type SourceContext, type UsageLineInput } from "./usage-events.js";

export { MAX_LINE_BYTES } from "./usage-events.js";
export type { NumericField, SourceContext, UsageLineInput } from "./usage-events.js";

// ---------------------------------------------------------------------------
// Percent normalization (rate-limit `used_percent` is a float 0-100, so
// `normalizeUsageCounter`'s integer-only rules don't apply to it)
// ---------------------------------------------------------------------------

export type PercentDiagnosis = "not_a_number" | "not_finite" | "negative" | "exceeds_100";

/** Same missing-vs-invalid distinction as `NumericField`: absent input is
 * `{ value: null, diagnosis: null }`; an invalid input is `{ value: null,
 * diagnosis: <reason> }`, never coerced or clamped into range. */
export interface PercentField {
  value: number | null;
  diagnosis: PercentDiagnosis | null;
}

export function normalizePercent(input: unknown): PercentField {
  if (input === undefined || input === null) return { value: null, diagnosis: null };
  if (typeof input !== "number") return { value: null, diagnosis: "not_a_number" };
  if (!Number.isFinite(input)) return { value: null, diagnosis: "not_finite" };
  if (input < 0) return { value: null, diagnosis: "negative" };
  if (input > 100) return { value: null, diagnosis: "exceeds_100" };
  return { value: input, diagnosis: null };
}

/** `resets_at` arrives as unix seconds; normalized as an integer counter and
 * only then converted to ms, so an invalid raw value reports the same
 * structured diagnosis it would have as a counter, never a silently-derived
 * `NaN` or a fabricated `0`. */
function secondsToMsField(input: unknown): NumericField {
  const seconds = normalizeUsageCounter(input);
  if (seconds.value === null) return seconds;
  return normalizeUsageCounter(seconds.value * 1000);
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

export interface CodexUsageFields {
  input_tokens: NumericField;
  output_tokens: NumericField;
  cached_input_tokens: NumericField;
  reasoning_output_tokens: NumericField;
  cache_write_input_tokens: NumericField;
  /** Reported as the vendor sent it, never recomputed from the other five --
   * a mismatch is surfaced as a `consistency` flag instead. */
  total_tokens: NumericField;
}

/**
 * Every applicable flag is reported, not just the first one found -- a
 * record can be both `cached_exceeds_input` and `incomplete` at once. There
 * is deliberately no bound relating `cache_write_input_tokens` to any other
 * field: the source evidence never observed it nonzero, so no invariant is
 * asserted for it beyond "present or not" (covered by `incomplete`).
 */
export type CodexConsistencyFlag = "cached_exceeds_input" | "reasoning_exceeds_output" | "total_mismatch" | "incomplete";

export interface CodexUsageSnapshot {
  /** Opaque local key derived from `(principalKey, sourceKey, "codex", response_id)`.
   * The `"codex"` discriminator is part of the hashed tuple specifically so a
   * Codex `response_id` string that happens to equal a Claude `message.id`
   * never collides with a Claude identity. */
  identityKey: string;
  principalKey: string;
  sourceKey: string;
  vendor: "codex";
  /** Always `null`: Codex's counter records carry no model field at all, and
   * the last-seen `turn_context.model` is deliberately never carried
   * forward onto them -- that would be exactly the "assign history to the
   * last model" failure this module refuses to guess at. */
  model: null;
  modelAttribution: "unavailable_in_record";
  observedAtMs: number;
  sequence: number;
  usage: CodexUsageFields;
  consistency: readonly CodexConsistencyFlag[];
  evidence: "usage_record_visible";
}

/** Account-level meter reading. Deliberately carries only opaque local keys,
 * the window slot, the percent, the semantic window length, and a reset
 * time -- never `limit_id`, `plan_type`, `credits`, `individual_limit`,
 * `limit_name`, `rate_limit_reached_type`, `spend_control_reached`,
 * `session_id`, `thread_id`, `cwd`, or `originator`. No claim links a
 * percent reading here to any token count elsewhere in this module. */
export interface RateLimitObservation {
  /** Opaque, hashed from (principal, source, observedAtMs, windowMinutes, resetsAtMs, usedPercent, and their diagnoses) so a
   * downstream consumer can dedup repeated observations without this module
   * needing its own accumulator for them. Slot is excluded so equivalent
   * semantic evidence in different source slots dedups. */
  identityKey: string;
  principalKey: string;
  sourceKey: string;
  vendor: "codex";
  /** `primary`/`secondary` are which slot the vendor reported the window in,
   * not a window identity of their own -- window duration and reset cycle determine the semantic window; matching
   * slot labels alone do not. */
  slot: "primary" | "secondary";
  observedAtMs: number;
  usedPercent: PercentField;
  windowMinutes: NumericField;
  resetsAtMs: NumericField;
}

export type CodexSkipReason = "unrecognized_record_type" | "no_identity" | "cumulative_without_identity" | "rate_limit_only";

export type CodexRejectReason =
  | "line_too_large"
  | "malformed_json"
  | "truncated_json"
  | "not_an_object"
  | "unsupported_shape"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "missing_identity"
  | "missing_usage";

/**
 * Unlike Claude's `LineOutcome`, a "skipped" Codex outcome can still carry
 * rate-limit observations: a single `token_count` event routinely reports
 * both an unidentified/cumulative counter block (the skip reason) *and* a
 * `rate_limits` block (the observations) in the same line, and reporting
 * only one would silently drop the other's coverage.
 */
export type CodexLineOutcome =
  | { readonly kind: "accepted"; readonly snapshot: CodexUsageSnapshot; readonly observations: readonly RateLimitObservation[] }
  | { readonly kind: "skipped"; readonly reason: CodexSkipReason; readonly observations: readonly RateLimitObservation[] }
  | { readonly kind: "rejected"; readonly reason: CodexRejectReason };

function identityKeyFor(principalKey: string, sourceKey: string, responseId: string): string {
  return createHash("sha256").update(JSON.stringify([principalKey, sourceKey, "codex", responseId])).digest("hex").slice(0, 32);
}

function rateLimitIdentityKeyFor(principalKey: string, sourceKey: string, observedAtMs: number, windowMinutes: number | null, resetsAtMs: number | null, usedPercent: number | null, windowDiagnosis: string | null, resetDiagnosis: string | null, percentDiagnosis: string | null): string {
  return createHash("sha256").update(JSON.stringify([principalKey, sourceKey, "codex", "rate_limit", observedAtMs, windowMinutes, resetsAtMs, usedPercent, windowDiagnosis, resetDiagnosis, percentDiagnosis])).digest("hex").slice(0, 32);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Same heuristic as usage-events.ts's `isTruncatedJson`, duplicated rather
 * than imported: both modules must stay independently reviewable, and this
 * is a small pure function with no shared state to drift out of sync. */
function isTruncatedJson(error: unknown, lineLength: number): boolean {
  if (!(error instanceof SyntaxError)) return false;
  if (/unexpected end of/i.test(error.message)) return true;
  const match = /position (\d+)/.exec(error.message);
  if (!match) return false;
  const position = Number(match[1]);
  return position >= lineLength - 1;
}

type TimestampOutcome = { kind: "ok"; observedAtMs: number } | { kind: "rejected"; reason: "missing_timestamp" | "invalid_timestamp" };

function parseTimestamp(raw: unknown): TimestampOutcome {
  if (typeof raw !== "string" || raw.length === 0) return { kind: "rejected", reason: "missing_timestamp" };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return { kind: "rejected", reason: "invalid_timestamp" };
  }
  const observedAtMs = Date.parse(raw);
  if (!Number.isFinite(observedAtMs)) return { kind: "rejected", reason: "invalid_timestamp" };
  return { kind: "ok", observedAtMs };
}

function consistencyFlagsFor(usage: CodexUsageFields): readonly CodexConsistencyFlag[] {
  const flags: CodexConsistencyFlag[] = [];
  const { input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, cache_write_input_tokens, total_tokens } = usage;

  if (cached_input_tokens.value !== null && input_tokens.value !== null && cached_input_tokens.value > input_tokens.value) {
    flags.push("cached_exceeds_input");
  }
  if (reasoning_output_tokens.value !== null && output_tokens.value !== null && reasoning_output_tokens.value > output_tokens.value) {
    flags.push("reasoning_exceeds_output");
  }
  if (
    total_tokens.value !== null &&
    input_tokens.value !== null &&
    output_tokens.value !== null &&
    total_tokens.value !== input_tokens.value + output_tokens.value
  ) {
    flags.push("total_mismatch");
  }
  const anyMissing = [input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, cache_write_input_tokens, total_tokens].some(
    (field) => field.value === null,
  );
  if (anyMissing) flags.push("incomplete");
  return flags;
}

function buildRateLimitObservation(slot: "primary" | "secondary", block: Record<string, unknown>, source: SourceContext, observedAtMs: number): RateLimitObservation {
  const usedPercent = normalizePercent(block.used_percent);
  const windowMinutes = normalizeUsageCounter(block.window_minutes);
  const resetsAtMs = secondsToMsField(block.resets_at);
  return {
    identityKey: rateLimitIdentityKeyFor(source.principalKey, source.sourceKey, observedAtMs, windowMinutes.value, resetsAtMs.value, usedPercent.value, windowMinutes.diagnosis, resetsAtMs.diagnosis, usedPercent.diagnosis),
    principalKey: source.principalKey,
    sourceKey: source.sourceKey,
    vendor: "codex",
    slot,
    observedAtMs,
    usedPercent,
    windowMinutes,
    resetsAtMs,
  };
}

function rateLimitObservationsOf(rateLimits: unknown, source: SourceContext, observedAtMs: number): RateLimitObservation[] {
  const block = record(rateLimits);
  if (!block) return [];
  const observations: RateLimitObservation[] = [];
  const primary = record(block.primary);
  if (primary) observations.push(buildRateLimitObservation("primary", primary, source, observedAtMs));
  const secondary = record(block.secondary);
  if (secondary) observations.push(buildRateLimitObservation("secondary", secondary, source, observedAtMs));
  return observations;
}

function parseTokenUsageRecord(entry: Record<string, unknown>, source: SourceContext, sequence: number): CodexLineOutcome {
  const timestamp = parseTimestamp(entry.timestamp);
  if (timestamp.kind === "rejected") return { kind: "rejected", reason: timestamp.reason };

  const payload = record(entry.payload);
  if (!payload) return { kind: "rejected", reason: "unsupported_shape" };

  const responseId = payload.response_id;
  if (typeof responseId !== "string" || responseId.length === 0) {
    return { kind: "rejected", reason: "missing_identity" };
  }

  // `turn_token_usage` and `thread_token_usage` are read from the payload only
  // to be ignored: they are cumulative-to-date blocks, and summing or
  // otherwise folding them in would double-count against `usage`.
  const usage = record(payload.usage);
  if (!usage) return { kind: "rejected", reason: "missing_usage" };

  const fields: CodexUsageFields = {
    input_tokens: normalizeUsageCounter(usage.input_tokens),
    output_tokens: normalizeUsageCounter(usage.output_tokens),
    cached_input_tokens: normalizeUsageCounter(usage.cached_input_tokens),
    reasoning_output_tokens: normalizeUsageCounter(usage.reasoning_output_tokens),
    cache_write_input_tokens: normalizeUsageCounter(usage.cache_write_input_tokens),
    total_tokens: normalizeUsageCounter(usage.total_tokens),
  };

  const snapshot: CodexUsageSnapshot = {
    identityKey: identityKeyFor(source.principalKey, source.sourceKey, responseId),
    principalKey: source.principalKey,
    sourceKey: source.sourceKey,
    vendor: "codex",
    model: null,
    modelAttribution: "unavailable_in_record",
    observedAtMs: timestamp.observedAtMs,
    sequence,
    usage: fields,
    consistency: consistencyFlagsFor(fields),
    evidence: "usage_record_visible",
  };
  return { kind: "accepted", snapshot, observations: [] };
}

function parseEventMsg(entry: Record<string, unknown>, source: SourceContext): CodexLineOutcome {
  const timestamp = parseTimestamp(entry.timestamp);
  if (timestamp.kind === "rejected") return { kind: "rejected", reason: timestamp.reason };

  const payload = record(entry.payload);
  if (!payload || payload.type !== "token_count") {
    return { kind: "skipped", reason: "unrecognized_record_type", observations: [] };
  }

  const observations = rateLimitObservationsOf(payload.rate_limits, source, timestamp.observedAtMs);
  const info = record(payload.info);

  // `total_token_usage` is cumulative *and* unidentified -- the worse of the
  // two problems -- so it is classified ahead of `last_token_usage`, which
  // is merely unidentified (and proven, by repeated identical events, to be
  // an unreliable dedup key even if it weren't).
  if (info && info.total_token_usage !== undefined && info.total_token_usage !== null) {
    return { kind: "skipped", reason: "cumulative_without_identity", observations };
  }
  if (info && info.last_token_usage !== undefined && info.last_token_usage !== null) {
    return { kind: "skipped", reason: "no_identity", observations };
  }
  if (observations.length > 0) {
    return { kind: "skipped", reason: "rate_limit_only", observations };
  }
  return { kind: "skipped", reason: "no_identity", observations: [] };
}

/**
 * Parses one raw Codex session-file line. Never throws, never echoes raw
 * line content, a session/thread/turn/response id, `cwd`, model, or any
 * rate-limit account/plan identifier in its result.
 */
export function parseCodexUsageLine(input: UsageLineInput): CodexLineOutcome {
  if (Buffer.byteLength(input.line, "utf8") > MAX_LINE_BYTES) {
    return { kind: "rejected", reason: "line_too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.line);
  } catch (error) {
    return { kind: "rejected", reason: isTruncatedJson(error, input.line.length) ? "truncated_json" : "malformed_json" };
  }

  const entry = record(parsed);
  if (!entry) return { kind: "rejected", reason: "not_an_object" };
  if (typeof entry.type !== "string") return { kind: "rejected", reason: "unsupported_shape" };

  if (entry.type === "token_usage_record") return parseTokenUsageRecord(entry, input.source, input.sequence);
  if (entry.type === "event_msg") return parseEventMsg(entry, input.source);
  return { kind: "skipped", reason: "unrecognized_record_type", observations: [] };
}

// ---------------------------------------------------------------------------
// Idempotent accumulation (per-response counters only; rate-limit
// observations are a plain stream with no revision semantics of their own)
// ---------------------------------------------------------------------------

export interface AccumulatedCodexUsageEntry {
  identityKey: string;
  principalKey: string;
  sourceKey: string;
  vendor: "codex";
  model: null;
  modelAttribution: "unavailable_in_record";
  observedAtMs: number;
  sequence: number;
  usage: CodexUsageFields;
  consistency: readonly CodexConsistencyFlag[];
  evidence: "usage_record_visible";
}

export type CodexQuarantineReason = "conflicting_same_version" | "identity_conflict";

export interface QuarantinedCodexUsageEntry {
  identityKey: string;
  reason: CodexQuarantineReason;
}

export interface CodexUsageAccumulatorState {
  readonly entries: ReadonlyMap<string, AccumulatedCodexUsageEntry>;
  readonly quarantined: ReadonlyMap<string, QuarantinedCodexUsageEntry>;
}

export function createCodexUsageAccumulator(): CodexUsageAccumulatorState {
  return { entries: new Map(), quarantined: new Map() };
}

function codexUsageFieldsEqual(a: CodexUsageFields, b: CodexUsageFields): boolean {
  const fields = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens", "cache_write_input_tokens", "total_tokens"] as const;
  for (const field of fields) {
    if (a[field].value !== b[field].value || a[field].diagnosis !== b[field].diagnosis) return false;
  }
  return true;
}

/** Only the caller-provided timestamp is authoritative; `sequence` is never
 * used for ordering -- same rule as Claude's accumulator. */
function compareCodexOrder(a: { observedAtMs: number }, b: { observedAtMs: number }): -1 | 0 | 1 {
  if (a.observedAtMs !== b.observedAtMs) return a.observedAtMs < b.observedAtMs ? -1 : 1;
  return 0;
}

function quarantineCodex(state: CodexUsageAccumulatorState, identityKey: string, reason: CodexQuarantineReason): CodexUsageAccumulatorState {
  const entries = new Map(state.entries);
  entries.delete(identityKey);
  const quarantined = new Map(state.quarantined);
  quarantined.set(identityKey, { identityKey, reason });
  return { entries, quarantined };
}

/**
 * Same revision rules as `applyUsageSnapshot`: a newer identity replaces the
 * prior one (including a legitimate decrease), an older one is dropped, an
 * exact tie is a no-op, and a same-timestamp tie with different content is
 * quarantined rather than merged. Parser-created snapshots always have a
 * null model. The exported accumulator also checks identity scope before
 * timestamp ordering, so a forged key with a different principal, source,
 * vendor, model or attribution is quarantined rather than merged.
 */
export function applyCodexUsageSnapshot(state: CodexUsageAccumulatorState, snapshot: CodexUsageSnapshot): CodexUsageAccumulatorState {
  if (state.quarantined.has(snapshot.identityKey)) return state;

  const existing = state.entries.get(snapshot.identityKey);
  if (!existing) {
    const entries = new Map(state.entries);
    entries.set(snapshot.identityKey, { ...snapshot });
    return { entries, quarantined: state.quarantined };
  }

  // Quarantine source/principal/vendor/modelAttribution conflicts BEFORE timestamp ordering
  // even for older revisions, with explicit identity_conflict reason.
  if (
    existing.principalKey !== snapshot.principalKey ||
    existing.sourceKey !== snapshot.sourceKey ||
    existing.vendor !== snapshot.vendor ||
    existing.modelAttribution !== snapshot.modelAttribution ||
    existing.model !== snapshot.model
  ) {
    return quarantineCodex(state, snapshot.identityKey, "identity_conflict");
  }

  const order = compareCodexOrder(snapshot, existing);
  if (order < 0) return state;
  if (order === 0) {
    if (codexUsageFieldsEqual(existing.usage, snapshot.usage)) return state;
    return quarantineCodex(state, snapshot.identityKey, "conflicting_same_version");
  }

  const entries = new Map(state.entries);
  entries.set(snapshot.identityKey, { ...snapshot });
  return { entries, quarantined: state.quarantined };
}

export function applyCodexUsageSnapshots(state: CodexUsageAccumulatorState, snapshots: readonly CodexUsageSnapshot[]): CodexUsageAccumulatorState {
  return snapshots.reduce(applyCodexUsageSnapshot, state);
}
