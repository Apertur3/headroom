import { describe, expect, it } from "vitest";
import {
  applyUsageSnapshot,
  applyUsageSnapshots,
  createUsageAccumulator,
  ingestUsageLines,
  normalizeUsageCounter,
  parseUsageLine,
  type ClaudeUsageSnapshot,
  type UsageLineInput,
} from "../src/usage-events.js";

// SYNTHETIC FIXTURE: A synthetic, never-real example canary shaped like a vendor key, assembled
// at runtime so no contiguous secret-shaped literal sits in this file's own
// source; used only to prove it never leaks into a diagnostic or error path.
const CANARY_EXAMPLE_TOKEN = ["sk", "ant", "example", "0000000000000000000000000000"].join("-");

function line(overrides: Record<string, unknown> = {}, source = "principal-a", sequence = 0, sourceKey = "source-a"): UsageLineInput {
  const body = {
    type: "assistant",
    timestamp: "2026-09-05T10:00:00.000Z",
    message: {
      id: "msg_01synthetic",
      model: "claude-sonnet-5",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    ...overrides,
  };
  return { line: JSON.stringify(body), source: { principalKey: source, sourceKey }, sequence };
}

function accept(input: UsageLineInput): ClaudeUsageSnapshot {
  const outcome = parseUsageLine(input);
  if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}:${JSON.stringify(outcome)}`);
  return outcome.snapshot;
}

describe("parseUsageLine", () => {
  it("normalizes a well-formed assistant usage line, including cache fields and TTL breakdown", () => {
    const snapshot = accept(line({
      message: {
        id: "msg_01full",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 10, output_tokens: 20,
          cache_read_input_tokens: 5, cache_creation_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
        },
      },
    }));
    expect(snapshot.usage).toEqual({
      input_tokens: { value: 10, diagnosis: null },
      output_tokens: { value: 20, diagnosis: null },
      cache_read_input_tokens: { value: 5, diagnosis: null },
      cache_creation_input_tokens: { value: 7, diagnosis: null },
      cache_creation_breakdown: {
        ephemeral_5m_input_tokens: { value: 3, diagnosis: null },
        ephemeral_1h_input_tokens: { value: 4, diagnosis: null },
      },
    });
    expect(snapshot.model).toBe("claude-sonnet-5");
    expect(snapshot.principalKey).toBe("principal-a");
    // Identity is an opaque local key, never the raw vendor message id.
    expect(snapshot.identityKey).not.toContain("msg_01full");
    expect(snapshot.identityKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("treats missing counters as null with no diagnosis, never a fabricated zero", () => {
    const snapshot = accept(line({ message: { id: "msg_01missing", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20 } } }));
    expect(snapshot.usage.cache_read_input_tokens).toEqual({ value: null, diagnosis: null });
    expect(snapshot.usage.cache_creation_input_tokens).toEqual({ value: null, diagnosis: null });
    expect(snapshot.usage.cache_creation_breakdown).toBeNull();
  });

  // NaN/Infinity cannot round-trip through JSON (JSON.stringify emits
  // `null` for both), so those two cases call the normalizer directly with
  // an in-memory value rather than through a JSON fixture.
  it.each([
    ["NaN via computed division", 0 / 0, "not_finite"],
    ["positive infinity", Number.POSITIVE_INFINITY, "not_finite"],
    ["a float", 1.5, "not_integer"],
    ["a negative integer", -3, "negative"],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 10, "unsafe_integer"],
    ["a string", "100", "not_a_number"],
  ] as const)("diagnoses %s as a safe reason instead of inventing a value", (_label, badValue, reason) => {
    expect(normalizeUsageCounter(badValue)).toEqual({ value: null, diagnosis: reason });
  });

  it("diagnoses the same bad-integer cases when they arrive through a parsed JSON line", () => {
    const snapshot = accept(line({ message: { id: "msg_01bad", model: "claude-sonnet-5", usage: { input_tokens: 1.5, output_tokens: -3 } } }));
    expect(snapshot.usage.input_tokens).toEqual({ value: null, diagnosis: "not_integer" });
    expect(snapshot.usage.output_tokens).toEqual({ value: null, diagnosis: "negative" });
  });

  it("never additively folds the cache-creation TTL breakdown into the aggregate counter", () => {
    const snapshot = accept(line({
      message: {
        id: "msg_01breakdown",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1, output_tokens: 1,
          cache_creation_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
        },
      },
    }));
    // 3 + 4 === 7 here by coincidence of the fixture; the point is the module
    // reports the two numbers independently rather than deriving one from the
    // other or re-summing them into a new total.
    expect(snapshot.usage.cache_creation_input_tokens.value).toBe(7);
    expect(snapshot.usage.cache_creation_breakdown).toEqual({
      ephemeral_5m_input_tokens: { value: 3, diagnosis: null },
      ephemeral_1h_input_tokens: { value: 4, diagnosis: null },
    });
  });

  it("rejects an oversized line before ever calling JSON.parse", () => {
    const huge = { line: "x".repeat(300 * 1024), source: { principalKey: "p", sourceKey: "s" }, sequence: 0 };
    expect(parseUsageLine(huge)).toEqual({ kind: "rejected", reason: "line_too_large" });
  });

  it("distinguishes truncated JSON from other malformed JSON, without ever echoing raw content", () => {
    const truncated = parseUsageLine({ line: '{"type":"assistant","message":{', source: { principalKey: "p", sourceKey: "s" }, sequence: 0 });
    expect(truncated).toEqual({ kind: "rejected", reason: "truncated_json" });
    const malformed = parseUsageLine({ line: "not even json {{{", source: { principalKey: "p", sourceKey: "s" }, sequence: 0 });
    expect(malformed).toEqual({ kind: "rejected", reason: "malformed_json" });
  });

  it("skips a recognized but unrelated record type", () => {
    const outcome = parseUsageLine({ line: JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), source: { principalKey: "p", sourceKey: "s" }, sequence: 0 });
    expect(outcome).toEqual({ kind: "skipped", reason: "unrecognized_record_type" });
  });

  it("rejects a non-object top-level value", () => {
    expect(parseUsageLine({ line: "42", source: { principalKey: "p", sourceKey: "s" }, sequence: 0 })).toEqual({ kind: "rejected", reason: "not_an_object" });
    expect(parseUsageLine({ line: "null", source: { principalKey: "p", sourceKey: "s" }, sequence: 0 })).toEqual({ kind: "rejected", reason: "not_an_object" });
  });

  it("rejects an assistant line missing a stable identity, model, usage, or timestamp instead of fabricating a complete event", () => {
    expect(parseUsageLine(line({ message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }))).toEqual({ kind: "rejected", reason: "missing_identity" });
    expect(parseUsageLine(line({ message: { id: "msg_01x", usage: { input_tokens: 1, output_tokens: 1 } } }))).toEqual({ kind: "rejected", reason: "missing_model" });
    expect(parseUsageLine(line({ message: { id: "msg_01x", model: "claude-sonnet-5" } }))).toEqual({ kind: "rejected", reason: "missing_usage" });
    expect(parseUsageLine(line({ timestamp: undefined }))).toEqual({ kind: "rejected", reason: "missing_timestamp" });
    expect(parseUsageLine(line({ timestamp: "not-a-date" }))).toEqual({ kind: "rejected", reason: "invalid_timestamp" });
  });

  it("rejects an unsupported cumulative-usage shape from another runtime rather than guessing at it", () => {
    // e.g. an OpenAI-style cumulative total_tokens record on an "assistant"-typed line.
    const outcome = parseUsageLine({
      line: JSON.stringify({ type: "assistant", timestamp: "2026-09-05T10:00:00Z", message: { id: "msg_01x", model: "gpt-x", total_tokens: 500 } }),
      source: { principalKey: "p", sourceKey: "s" }, sequence: 0,
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "missing_usage" });
  });

  it("never surfaces a canary secret embedded in content, malformed JSON, or the parse error path", () => {
    const withCanary = line({ message: { id: "msg_01canary", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 }, extra_notes: CANARY_EXAMPLE_TOKEN } });
    const accepted = parseUsageLine(withCanary);
    expect(JSON.stringify(accepted)).not.toContain(CANARY_EXAMPLE_TOKEN);

    const malformedWithCanary = parseUsageLine({ line: `not json ${CANARY_EXAMPLE_TOKEN} {{{`, source: { principalKey: "p", sourceKey: "s" }, sequence: 0 });
    expect(JSON.stringify(malformedWithCanary)).not.toContain(CANARY_EXAMPLE_TOKEN);

    const oversizedWithCanary = parseUsageLine({ line: CANARY_EXAMPLE_TOKEN.repeat(20000), source: { principalKey: "p", sourceKey: "s" }, sequence: 0 });
    expect(JSON.stringify(oversizedWithCanary)).not.toContain(CANARY_EXAMPLE_TOKEN);
  });
});

describe("usage accumulator", () => {
  it("is idempotent: applying the exact same batch twice does not change or duplicate state", () => {
    const snapshot = accept(line());
    const once = applyUsageSnapshot(createUsageAccumulator(), snapshot);
    const twice = applyUsageSnapshot(once, snapshot);
    expect(twice.entries.size).toBe(1);
    expect(twice.entries.get(snapshot.identityKey)?.usage).toEqual(once.entries.get(snapshot.identityKey)?.usage);
  });

  it("deduplicates duplicates within one batch and across two separate batches", () => {
    const a = accept(line({}, "p", 0));
    const b = accept(line({}, "p", 1)); // same message id, same content, later sequence -- e.g. a repeated streaming flush
    const withinBatch = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(withinBatch.entries.size).toBe(1);

    const acrossBatches = applyUsageSnapshots(applyUsageSnapshots(createUsageAccumulator(), [a]), [b]);
    expect(acrossBatches.entries.size).toBe(1);
  });

  it("treats two distinct requests with otherwise-identical content as two separate entries", () => {
    const a = accept(line({ message: { id: "msg_01a", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }));
    const b = accept(line({ message: { id: "msg_01b", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }));
    const state = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state.entries.size).toBe(2);
  });

  it("lets a strictly later snapshot correct a prior one, including decreasing a value", () => {
    const first = accept(line({ message: { id: "msg_01c", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50 } } }, "p", 0));
    const corrected: ClaudeUsageSnapshot = {
      ...first,
      observedAtMs: first.observedAtMs + 1000,
      usage: { ...first.usage, input_tokens: { value: 40, diagnosis: null } },
    };
    const state = applyUsageSnapshots(createUsageAccumulator(), [first, corrected]);
    expect(state.entries.get(first.identityKey)?.usage.input_tokens.value).toBe(40);
  });

  it("never lets an out-of-order older observation overwrite a newer one", () => {
    const newer = accept(line({ message: { id: "msg_01d", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50 } } }, "p", 1));
    const older: ClaudeUsageSnapshot = { ...newer, observedAtMs: newer.observedAtMs - 5000, sequence: 0, usage: { ...newer.usage, input_tokens: { value: 999, diagnosis: null } } };
    const state = applyUsageSnapshots(createUsageAccumulator(), [newer, older]);
    expect(state.entries.get(newer.identityKey)?.usage.input_tokens.value).toBe(100);
  });

  it("quarantines a same-version tie with conflicting content instead of arbitrarily merging it", () => {
    const a = accept(line({ message: { id: "msg_01tie", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 10 } } }, "p", 0));
    const b: ClaudeUsageSnapshot = { ...a, usage: { ...a.usage, input_tokens: { value: 20, diagnosis: null } } }; // same observedAtMs, same sequence
    const state = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state.entries.has(a.identityKey)).toBe(false);
    expect(state.quarantined.get(a.identityKey)).toEqual({ identityKey: a.identityKey, reason: "conflicting_same_version" });
  });

  it("quarantines an identity/model conflict rather than picking a winner, and keeps it quarantined for later snapshots", () => {
    const a = accept(line({ message: { id: "msg_01model", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }, "p", 0));
    const b = accept(line({ message: { id: "msg_01model", model: "claude-fable-5-1", usage: { input_tokens: 1, output_tokens: 1 } } }, "p", 1));
    const c = accept(line({ message: { id: "msg_01model", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }, "p", 2));
    const state = applyUsageSnapshots(createUsageAccumulator(), [a, b, c]);
    expect(state.entries.has(a.identityKey)).toBe(false);
    expect(state.quarantined.get(a.identityKey)?.reason).toBe("identity_model_conflict");
  });

  it("never merges the same message id across two distinct principals/sources", () => {
    const a = accept(line({}, "principal-a", 0));
    const b = accept(line({}, "principal-b", 0));
    expect(a.identityKey).not.toBe(b.identityKey);
    const state = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state.entries.size).toBe(2);
  });

  it("ingestUsageLines folds only accepted lines and still reports every outcome", () => {
    const lines = [line({}, "p", 0), { line: "not json", source: { principalKey: "p", sourceKey: "s" }, sequence: 1 }];
    const { state, outcomes } = ingestUsageLines(createUsageAccumulator(), lines);
    expect(outcomes.map((o) => o.kind)).toEqual(["accepted", "rejected"]);
    expect(state.entries.size).toBe(1);
  });

  it("quarantines same timestamp with different usage regardless of sequence order", () => {
    const a = accept(line({ message: { id: "msg_01seq", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 10 } } }, "p", 0));
    const b = accept(line({ message: { id: "msg_01seq", model: "claude-sonnet-5", usage: { input_tokens: 20, output_tokens: 10 } } }, "p", 1));

    const state1 = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state1.quarantined.has(a.identityKey)).toBe(true);

    const state2 = applyUsageSnapshots(createUsageAccumulator(), [b, a]);
    expect(state2.quarantined.has(a.identityKey)).toBe(true);
  });

  it("rejects arrays in record() at every object boundary", () => {
    const outcome = parseUsageLine(line({ message: { id: "msg_01arr", model: "claude-sonnet-5", usage: [1, 2, 3] } }));
    expect(outcome).toEqual({ kind: "rejected", reason: "missing_usage" });

    const outcome2 = parseUsageLine(line({ message: [1, 2, 3] }));
    expect(outcome2).toEqual({ kind: "rejected", reason: "unsupported_shape" });
  });

  it("rejects malformed cache_creation (present non-null but not object) with safe structured reason", () => {
    const stringOutcome = parseUsageLine(line({ message: { id: "msg_01cache", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation: "not-an-object" } } }));
    expect(stringOutcome).toEqual({ kind: "rejected", reason: "invalid_cache_creation" });

    const arrayOutcome = parseUsageLine(line({ message: { id: "msg_01cache", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation: [1, 2] } } }));
    expect(arrayOutcome).toEqual({ kind: "rejected", reason: "invalid_cache_creation" });

    const numberOutcome = parseUsageLine(line({ message: { id: "msg_01cache", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation: 123 } } }));
    expect(numberOutcome).toEqual({ kind: "rejected", reason: "invalid_cache_creation" });

    const absentOutcome = parseUsageLine(line({ message: { id: "msg_01cache", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect(absentOutcome.kind).toBe("accepted");
    if (absentOutcome.kind === "accepted") {
      expect(absentOutcome.snapshot.usage.cache_creation_breakdown).toBeNull();
    }

    const nullOutcome = parseUsageLine(line({ message: { id: "msg_01cache", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation: null } } }));
    expect(nullOutcome.kind).toBe("accepted");
    if (nullOutcome.kind === "accepted") {
      expect(nullOutcome.snapshot.usage.cache_creation_breakdown).toBeNull();
    }
  });

  it("invalid vs missing same-version records are not order dependent (diagnoses compared)", () => {
    const a = accept(line({ message: { id: "msg_01diag", model: "claude-sonnet-5", usage: { output_tokens: 10 } } }, "p", 0));

    // Explicitly assert that the first parsed snapshot has input_tokens ABSENT, yielding {value:null, diagnosis:null}
    expect(a.usage.input_tokens).toEqual({ value: null, diagnosis: null });

    const b: ClaudeUsageSnapshot = { ...a, usage: { ...a.usage, input_tokens: { value: null, diagnosis: "not_a_number" } } };

    const state1 = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state1.quarantined.has(a.identityKey)).toBe(true);

    const state2 = applyUsageSnapshots(createUsageAccumulator(), [b, a]);
    expect(state2.quarantined.has(a.identityKey)).toBe(true);
  });

  it("same timestamp with different sequence but identical content is a no-op", () => {
    const a = accept(line({ message: { id: "msg_01seq", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 10 } } }, "p", 0));
    const b: ClaudeUsageSnapshot = { ...a, sequence: 1 };
    const state = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state.entries.size).toBe(1);
    expect(state.quarantined.size).toBe(0);
  });

  it("conflicting same-timestamp across separate batches is quarantined", () => {
    const a = accept(line({ message: { id: "msg_01batch", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 10 } } }, "p", 0));
    const b: ClaudeUsageSnapshot = { ...a, usage: { ...a.usage, input_tokens: { value: 20, diagnosis: null } } };
    const state = applyUsageSnapshots(applyUsageSnapshots(createUsageAccumulator(), [a]), [b]);
    expect(state.quarantined.has(a.identityKey)).toBe(true);
  });

  it("same principal different sourceKey does not merge", () => {
    const a = accept(line({}, "principal-a", 0, "source-a"));
    const b = accept(line({}, "principal-a", 0, "source-b"));
    expect(a.identityKey).not.toBe(b.identityKey);
    const state = applyUsageSnapshots(createUsageAccumulator(), [a, b]);
    expect(state.entries.size).toBe(2);
  });

  it("rejects invalid timestamp formats", () => {
    expect(parseUsageLine(line({ timestamp: "0" }))).toEqual({ kind: "rejected", reason: "invalid_timestamp" });
    expect(parseUsageLine(line({ timestamp: "2026-09-05" }))).toEqual({ kind: "rejected", reason: "invalid_timestamp" });
    expect(parseUsageLine(line({ timestamp: "2026-09-05T10:00:00" }))).toEqual({ kind: "rejected", reason: "invalid_timestamp" });
  });
});
