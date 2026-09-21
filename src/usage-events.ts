/**
 * Pure, filesystem-free normalization and idempotent deduplication of Claude
 * assistant usage counters found in raw Claude Code transcript JSONL lines.
 *
 * This is an ingestion *foundation*, not a collector or a predictor: it does
 * not read any file, call any vendor, know about accounts or windows, or
 * convert tokens to a percent of anything. It turns raw lines plus
 * caller-supplied, already-safe source context into deduplicated snapshots
 * a future collector can fold into calibration data -- nothing here proves
 * that vendor-side quota has settled, and a "message visible in a transcript"
 * is the only finalization evidence this slice understands.
 */
import { createHash } from "node:crypto";

/** Lines above this size are rejected before `JSON.parse` ever runs. */
export const MAX_LINE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Numeric normalization
// ---------------------------------------------------------------------------

export type NumericDiagnosis = "not_a_number" | "not_finite" | "not_integer" | "negative" | "unsafe_integer";

/** A single counter: absent input is `{ value: null, diagnosis: null }`
 * (missing, never fabricated as zero); an invalid input is
 * `{ value: null, diagnosis: <reason> }` (never silently coerced). */
export interface NumericField {
  value: number | null;
  diagnosis: NumericDiagnosis | null;
}

/**
 * Normalizes one raw counter value. Exported directly (not only reachable
 * through `parseUsageLine`) because `NaN`/`Infinity` cannot round-trip
 * through `JSON.stringify`/`JSON.parse` -- exercising those diagnoses needs
 * a direct call with an in-memory value, not a JSON fixture.
 */
export function normalizeUsageCounter(input: unknown): NumericField {
  if (input === undefined || input === null) return { value: null, diagnosis: null };
  if (typeof input !== "number") return { value: null, diagnosis: "not_a_number" };
  if (!Number.isFinite(input)) return { value: null, diagnosis: "not_finite" };
  if (!Number.isInteger(input)) return { value: null, diagnosis: "not_integer" };
  if (input < 0) return { value: null, diagnosis: "negative" };
  if (!Number.isSafeInteger(input)) return { value: null, diagnosis: "unsafe_integer" };
  return { value: input, diagnosis: null };
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/** Trusted, caller-supplied scope for a batch of lines. Headroom never
 * infers this from transcript content; the caller (a future collector) owns
 * mapping a real config dir to an already-safe, opaque principal id. */
export interface SourceContext {
  principalKey: string;
  sourceKey: string;
}

export interface UsageLineInput {
  /** One complete raw JSONL line, unparsed. */
  line: string;
  source: SourceContext;
  /** Diagnostic import position ONLY. Never used as ordering evidence. */
  sequence: number;
}

export interface CacheCreationBreakdown {
  ephemeral_5m_input_tokens: NumericField;
  ephemeral_1h_input_tokens: NumericField;
}

export interface ClaudeUsageFields {
  input_tokens: NumericField;
  output_tokens: NumericField;
  cache_read_input_tokens: NumericField;
  cache_creation_input_tokens: NumericField;
  /** Never added into `cache_creation_input_tokens`: informational TTL
   * split only, present when the vendor payload includes it. */
  cache_creation_breakdown: CacheCreationBreakdown | null;
}

export interface ClaudeUsageSnapshot {
  /** Opaque local key derived from `(principalKey, sourceKey, message id)`. Never a raw
   * vendor message/request id, and distinct principals or sources never collide. */
  identityKey: string;
  principalKey: string;
  sourceKey: string;
  model: string;
  observedAtMs: number;
  sequence: number;
  usage: ClaudeUsageFields;
}

export type SkipReason = "unrecognized_record_type";

export type RejectReason =
  | "line_too_large"
  | "malformed_json"
  | "truncated_json"
  | "not_an_object"
  | "unsupported_shape"
  | "missing_identity"
  | "missing_model"
  | "missing_usage"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "invalid_cache_creation";

export type LineOutcome =
  | { readonly kind: "accepted"; readonly snapshot: ClaudeUsageSnapshot }
  | { readonly kind: "skipped"; readonly reason: SkipReason }
  | { readonly kind: "rejected"; readonly reason: RejectReason };

/** Derives a stable opaque local key from the JSON tuple of origin and message id.
 * A copied export must retain the same origin key to be deduplicated; different
 * origins (principal or source) are distinct. */
function identityKeyFor(principalKey: string, sourceKey: string, messageId: string): string {
  return createHash("sha256").update(JSON.stringify([principalKey, sourceKey, messageId])).digest("hex").slice(0, 32);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cacheBreakdownOf(usage: Record<string, unknown>): CacheCreationBreakdown | null {
  const nested = record(usage.cache_creation);
  if (!nested) return null;
  return {
    ephemeral_5m_input_tokens: normalizeUsageCounter(nested.ephemeral_5m_input_tokens),
    ephemeral_1h_input_tokens: normalizeUsageCounter(nested.ephemeral_1h_input_tokens),
  };
}

/** A `SyntaxError` from `JSON.parse` on input cut off mid-token reports its
 * failure position at (or one before) the end of the string; anything else
 * failed on a token found earlier in otherwise-complete-looking input. This
 * reads only the numeric position out of the engine's message, never the
 * message text itself, so no line content ever surfaces through it. */
function isTruncatedJson(error: unknown, lineLength: number): boolean {
  if (!(error instanceof SyntaxError)) return false;
  if (/unexpected end of/i.test(error.message)) return true;
  const match = /position (\d+)/.exec(error.message);
  if (!match) return false;
  const position = Number(match[1]);
  return position >= lineLength - 1;
}

/**
 * Parses one raw transcript line into a normalized snapshot, a recognized
 * but irrelevant skip, or a safely-diagnosed rejection. Never throws, never
 * echoes line content, message text, tool input/output, or the raw JSON
 * (successfully parsed or not) in its result.
 */
export function parseUsageLine(input: UsageLineInput): LineOutcome {
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
  if (entry.type !== "assistant") return { kind: "skipped", reason: "unrecognized_record_type" };

  if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0) {
    return { kind: "rejected", reason: "missing_timestamp" };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(entry.timestamp)) {
    return { kind: "rejected", reason: "invalid_timestamp" };
  }
  const observedAtMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(observedAtMs)) return { kind: "rejected", reason: "invalid_timestamp" };

  const message = record(entry.message);
  if (!message) return { kind: "rejected", reason: "unsupported_shape" };

  const messageId = message.id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return { kind: "rejected", reason: "missing_identity" };
  }

  const model = message.model;
  if (typeof model !== "string" || model.length === 0) {
    return { kind: "rejected", reason: "missing_model" };
  }

  const usage = record(message.usage);
  if (!usage) return { kind: "rejected", reason: "missing_usage" };

  if (usage.cache_creation !== undefined && usage.cache_creation !== null && record(usage.cache_creation) === null) {
    return { kind: "rejected", reason: "invalid_cache_creation" };
  }

  const snapshot: ClaudeUsageSnapshot = {
    identityKey: identityKeyFor(input.source.principalKey, input.source.sourceKey, messageId),
    principalKey: input.source.principalKey,
    sourceKey: input.source.sourceKey,
    model,
    observedAtMs,
    sequence: input.sequence,
    usage: {
      input_tokens: normalizeUsageCounter(usage.input_tokens),
      output_tokens: normalizeUsageCounter(usage.output_tokens),
      cache_read_input_tokens: normalizeUsageCounter(usage.cache_read_input_tokens),
      cache_creation_input_tokens: normalizeUsageCounter(usage.cache_creation_input_tokens),
      cache_creation_breakdown: cacheBreakdownOf(usage),
    },
  };
  return { kind: "accepted", snapshot };
}

// ---------------------------------------------------------------------------
// Idempotent accumulation
// ---------------------------------------------------------------------------

/** The only finalization evidence this slice recognizes: the assistant
 * message was visible in a transcript line. This is not proof the vendor's
 * own billing/quota accounting has settled for it. */
export type UsageEvidence = "message_visible";

export interface AccumulatedUsageEntry {
  identityKey: string;
  principalKey: string;
  sourceKey: string;
  model: string;
  observedAtMs: number;
  sequence: number;
  usage: ClaudeUsageFields;
  evidence: UsageEvidence;
}

export type QuarantineReason = "identity_model_conflict" | "conflicting_same_version";

export interface QuarantinedUsageEntry {
  identityKey: string;
  reason: QuarantineReason;
}

export interface UsageAccumulatorState {
  readonly entries: ReadonlyMap<string, AccumulatedUsageEntry>;
  readonly quarantined: ReadonlyMap<string, QuarantinedUsageEntry>;
}

export function createUsageAccumulator(): UsageAccumulatorState {
  return { entries: new Map(), quarantined: new Map() };
}

function usageFieldsEqual(a: ClaudeUsageFields, b: ClaudeUsageFields): boolean {
  const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  for (const f of fields) {
    if (a[f].value !== b[f].value || a[f].diagnosis !== b[f].diagnosis) return false;
  }
  const ab = a.cache_creation_breakdown;
  const bb = b.cache_creation_breakdown;
  if (ab === null || bb === null) return ab === bb;
  const breakdownFields = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] as const;
  for (const f of breakdownFields) {
    if (ab[f].value !== bb[f].value || ab[f].diagnosis !== bb[f].diagnosis) return false;
  }
  return true;
}

/** -1 if `a` is strictly older than `b`, 1 if strictly newer, 0 for a tie.
 * Only the caller-provided timestamp is authoritative. `sequence` is never
 * used for ordering. */
function compareOrder(a: { observedAtMs: number }, b: { observedAtMs: number }): -1 | 0 | 1 {
  if (a.observedAtMs !== b.observedAtMs) return a.observedAtMs < b.observedAtMs ? -1 : 1;
  return 0;
}

/**
 * Folds one normalized snapshot into an accumulator: newer revisions of the
 * same identity replace the prior one (a correction may legitimately lower a
 * count -- this never takes a running max), an older revision is dropped
 * without disturbing the newer state on record, an exact tie with identical
 * content is a no-op (idempotent redelivery / duplicated streaming block),
 * and a same-version tie with different content or a model change under the
 * same identity is quarantined rather than guessed at. A quarantined
 * identity stays quarantined: once its history is ambiguous, this slice does
 * not try to arbitrate it back into the trusted set.
 */
export function applyUsageSnapshot(state: UsageAccumulatorState, snapshot: ClaudeUsageSnapshot): UsageAccumulatorState {
  if (state.quarantined.has(snapshot.identityKey)) return state;

  const existing = state.entries.get(snapshot.identityKey);
  if (!existing) {
    const entries = new Map(state.entries);
    entries.set(snapshot.identityKey, { ...snapshot, evidence: "message_visible" });
    return { entries, quarantined: state.quarantined };
  }

  if (existing.model !== snapshot.model) {
    return quarantine(state, snapshot.identityKey, "identity_model_conflict");
  }

  const order = compareOrder(snapshot, existing);
  if (order < 0) return state;
  if (order === 0) {
    if (usageFieldsEqual(existing.usage, snapshot.usage)) {
      return state;
    }
    return quarantine(state, snapshot.identityKey, "conflicting_same_version");
  }

  const entries = new Map(state.entries);
  entries.set(snapshot.identityKey, { ...snapshot, evidence: "message_visible" });
  return { entries, quarantined: state.quarantined };
}

function quarantine(state: UsageAccumulatorState, identityKey: string, reason: QuarantineReason): UsageAccumulatorState {
  const entries = new Map(state.entries);
  entries.delete(identityKey);
  const quarantined = new Map(state.quarantined);
  quarantined.set(identityKey, { identityKey, reason });
  return { entries, quarantined };
}

/** Applies a batch in order; a pure array merge, safe to re-run on
 * previously-seen input. */
export function applyUsageSnapshots(state: UsageAccumulatorState, snapshots: readonly ClaudeUsageSnapshot[]): UsageAccumulatorState {
  return snapshots.reduce(applyUsageSnapshot, state);
}

/** Convenience entry point for a batch of raw lines: parses each, folds
 * accepted snapshots into `state`, and returns every per-line outcome so a
 * caller can log/skip/reject without re-deriving parse results. */
export function ingestUsageLines(state: UsageAccumulatorState, inputs: readonly UsageLineInput[]): { state: UsageAccumulatorState; outcomes: LineOutcome[] } {
  const outcomes = inputs.map(parseUsageLine);
  const accepted = outcomes.filter((outcome): outcome is { kind: "accepted"; snapshot: ClaudeUsageSnapshot } => outcome.kind === "accepted");
  return { state: applyUsageSnapshots(state, accepted.map((outcome) => outcome.snapshot)), outcomes };
}
