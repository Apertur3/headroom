import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  applyCodexUsageSnapshot,
  applyCodexUsageSnapshots,
  createCodexUsageAccumulator,
  normalizePercent,
  parseCodexUsageLine,
  type CodexLineOutcome,
  type CodexUsageSnapshot,
  type UsageLineInput,
} from "../src/codex-usage-events.js";

// SYNTHETIC FIXTURE: every id, session, response and rate-limit value below is
// hand-written and never a real Codex account/session. Shapes follow the
// sanitized field inventory in /tmp/headroom-codex-design-20260921-report.md.
const PRINCIPAL = "principal-a";
const SOURCE = "source-a";
const TS = "2026-09-05T10:00:00.000Z";

function tokenUsageRecordLine(overrides: Record<string, unknown> = {}, principal = PRINCIPAL, source = SOURCE, sequence = 0): UsageLineInput {
  const { timestamp, type = "token_usage_record", payload, ...payloadFields } = overrides;
  const defaultPayload = {
    response_id: "resp_01synthetic",
    usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 },
    turn_token_usage: { input_tokens: 400, output_tokens: 200, cached_input_tokens: 40, reasoning_output_tokens: 20, cache_write_input_tokens: 0, total_tokens: 600 },
    thread_token_usage: { input_tokens: 4000, output_tokens: 2000, cached_input_tokens: 400, reasoning_output_tokens: 200, cache_write_input_tokens: 0, total_tokens: 6000 },
    ...payloadFields,
  };
  const chosenPayload = Object.prototype.hasOwnProperty.call(overrides, "payload") ? payload : defaultPayload;
  const body = {
    type,
    timestamp: Object.prototype.hasOwnProperty.call(overrides, "timestamp") ? timestamp : TS,
    payload: chosenPayload,
  };
  return { line: JSON.stringify(body), source: { principalKey: principal, sourceKey: source }, sequence };
}

function tokenCountLine(overrides: Record<string, unknown> = {}): UsageLineInput {
  const body = {
    type: "event_msg",
    timestamp: TS,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 4000, output_tokens: 2000, cached_input_tokens: 400, reasoning_output_tokens: 200, cache_write_input_tokens: 0, total_tokens: 6000 },
        last_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 },
        model_context_window: 200000,
      },
      rate_limits: {
        primary: { used_percent: 42, window_minutes: 10080, resets_at: 1893456000 },
        secondary: null,
        limit_id: "raw-limit-id-999",
        plan_type: "pro",
        credits: 1234,
        individual_limit: 5000,
        limit_name: "weekly",
        rate_limit_reached_type: "none",
        spend_control_reached: false,
      },
      ...overrides,
    },
  };
  return { line: JSON.stringify(body), source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 };
}

function accept(input: UsageLineInput): CodexUsageSnapshot {
  const outcome = parseCodexUsageLine(input);
  if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}:${JSON.stringify(outcome)}`);
  return outcome.snapshot;
}

describe("parseCodexUsageLine — token_usage_record", () => {
  it("1. accepts a well-formed token_usage_record, using only the per-response usage block", () => {
    const outcome = parseCodexUsageLine(tokenUsageRecordLine());
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.snapshot.usage).toEqual({
      input_tokens: { value: 100, diagnosis: null },
      output_tokens: { value: 50, diagnosis: null },
      cached_input_tokens: { value: 10, diagnosis: null },
      reasoning_output_tokens: { value: 5, diagnosis: null },
      cache_write_input_tokens: { value: 0, diagnosis: null },
      total_tokens: { value: 150, diagnosis: null },
    });
    expect(outcome.snapshot.consistency).toEqual([]);
    expect(outcome.snapshot.model).toBeNull();
    expect(outcome.snapshot.modelAttribution).toBe("unavailable_in_record");
    expect(outcome.snapshot.vendor).toBe("codex");
    expect(outcome.snapshot.evidence).toBe("usage_record_visible");
    // turn_/thread_ blocks must never leak into the snapshot at all.
    expect(JSON.stringify(outcome.snapshot)).not.toContain("turn_token_usage");
    expect(JSON.stringify(outcome.snapshot)).not.toContain("thread_token_usage");
  });

  it("2. never populates model from a preceding turn_context (there is none to read here at all)", () => {
    const snapshot = accept(tokenUsageRecordLine());
    expect(snapshot.model).toBeNull();
  });

  it("3. identity is opaque, never the raw response/session/thread id", () => {
    const snapshot = accept(tokenUsageRecordLine());
    expect(snapshot.identityKey).toMatch(/^[0-9a-f]{32}$/);
    expect(snapshot.identityKey).not.toContain("resp_01synthetic");
    expect(JSON.stringify(snapshot)).not.toContain("sess_01synthetic");
    expect(JSON.stringify(snapshot)).not.toContain("thread_01synthetic");
  });

  it("4. a Codex response_id string equal to a would-be Claude message id still hashes distinctly (vendor discriminator)", () => {
    const codex = accept(tokenUsageRecordLine({ response_id: "msg_shared_id" }));
    // Recompute what Claude's identityKeyFor would produce for the same tuple
    // without the vendor discriminator, using the same hash primitive.
    const claudeShapedKey = createHash("sha256").update(JSON.stringify([PRINCIPAL, SOURCE, "msg_shared_id"])).digest("hex").slice(0, 32);
    expect(codex.identityKey).not.toBe(claudeShapedKey);
  });

  it("5. distinct principal/source pairs never merge under the same response_id", () => {
    const a = accept(tokenUsageRecordLine({}, "principal-a", "source-a"));
    const b = accept(tokenUsageRecordLine({}, "principal-b", "source-a"));
    const c = accept(tokenUsageRecordLine({}, "principal-a", "source-b"));
    expect(a.identityKey).not.toBe(b.identityKey);
    expect(a.identityKey).not.toBe(c.identityKey);
    expect(b.identityKey).not.toBe(c.identityKey);
  });

  it("6. missing/invalid counters are null with no diagnosis, never a fabricated zero; explicit 0 is preserved", () => {
    const snapshot = accept(tokenUsageRecordLine({ usage: { input_tokens: 100, output_tokens: 50, cache_write_input_tokens: 0 } }));
    expect(snapshot.usage.cached_input_tokens).toEqual({ value: null, diagnosis: null });
    expect(snapshot.usage.reasoning_output_tokens).toEqual({ value: null, diagnosis: null });
    expect(snapshot.usage.total_tokens).toEqual({ value: null, diagnosis: null });
    expect(snapshot.usage.cache_write_input_tokens).toEqual({ value: 0, diagnosis: null });
    expect(snapshot.consistency).toContain("incomplete");
  });

  it("7. flags cached_exceeds_input while preserving the reported counters", () => {
    const snapshot = accept(tokenUsageRecordLine({ usage: { input_tokens: 10, output_tokens: 10, cached_input_tokens: 999, reasoning_output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 20 } }));
    expect(snapshot.consistency).toContain("cached_exceeds_input");
    expect(snapshot.usage.cached_input_tokens.value).toBe(999);
  });

  it("8. flags reasoning_exceeds_output while preserving the reported counters", () => {
    const snapshot = accept(tokenUsageRecordLine({ usage: { input_tokens: 10, output_tokens: 10, cached_input_tokens: 0, reasoning_output_tokens: 999, cache_write_input_tokens: 0, total_tokens: 20 } }));
    expect(snapshot.consistency).toContain("reasoning_exceeds_output");
    expect(snapshot.usage.reasoning_output_tokens.value).toBe(999);
  });

  it("9. flags total_mismatch and never recomputes total_tokens", () => {
    const snapshot = accept(tokenUsageRecordLine({ usage: { input_tokens: 10, output_tokens: 10, cached_input_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 999 } }));
    expect(snapshot.consistency).toContain("total_mismatch");
    expect(snapshot.usage.total_tokens.value).toBe(999);
  });

  it("10. reports every applicable flag simultaneously, not just the first one", () => {
    const snapshot = accept(tokenUsageRecordLine({ usage: { input_tokens: 10, output_tokens: 10, cached_input_tokens: 999, reasoning_output_tokens: 999, cache_write_input_tokens: 0, total_tokens: 999 } }));
    expect(snapshot.consistency).toEqual(expect.arrayContaining(["cached_exceeds_input", "reasoning_exceeds_output", "total_mismatch"]));
    expect(snapshot.consistency.length).toBe(3);
  });

  it("11. thread_token_usage decreasing across lines has no effect on any snapshot (never differenced, never inspected for order)", () => {
    const first = tokenUsageRecordLine({ response_id: "resp_a", thread_token_usage: { input_tokens: 4000, output_tokens: 2000, cached_input_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 6000 } });
    const second = tokenUsageRecordLine({ response_id: "resp_b", thread_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 150 } });
    const a = accept(first);
    const b = accept(second);
    expect(a.usage.input_tokens.value).toBe(100);
    expect(b.usage.input_tokens.value).toBe(100);
  });

  it("12. rejects a token_usage_record missing an identity or usage block", () => {
    expect(parseCodexUsageLine(tokenUsageRecordLine({ payload: { response_id: undefined, usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 } } }))).toEqual({ kind: "rejected", reason: "missing_identity" });
    expect(parseCodexUsageLine(tokenUsageRecordLine({ payload: { response_id: "resp_01synthetic", usage: undefined } }))).toEqual({ kind: "rejected", reason: "missing_usage" });
  });

  it("13. rejects missing/invalid timestamps", () => {
    expect(parseCodexUsageLine(tokenUsageRecordLine({ timestamp: undefined }))).toEqual({ kind: "rejected", reason: "missing_timestamp" });
    expect(parseCodexUsageLine(tokenUsageRecordLine({ timestamp: "not-a-date" }))).toEqual({ kind: "rejected", reason: "invalid_timestamp" });
    expect(parseCodexUsageLine(tokenUsageRecordLine({ timestamp: "2026-09-05" }))).toEqual({ kind: "rejected", reason: "invalid_timestamp" });
  });

  it("14. rejects an oversized line before ever calling JSON.parse", () => {
    const huge = { line: "x".repeat(300 * 1024), source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 };
    expect(parseCodexUsageLine(huge)).toEqual({ kind: "rejected", reason: "line_too_large" });
  });

  it("15. distinguishes truncated JSON from other malformed JSON, and rejects non-object top-level values", () => {
    expect(parseCodexUsageLine({ line: '{"type":"token_usage_record","response_id":', source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 })).toEqual({ kind: "rejected", reason: "truncated_json" });
    expect(parseCodexUsageLine({ line: "not even json {{{", source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 })).toEqual({ kind: "rejected", reason: "malformed_json" });
    expect(parseCodexUsageLine({ line: "42", source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 })).toEqual({ kind: "rejected", reason: "not_an_object" });
    expect(parseCodexUsageLine({ line: JSON.stringify({ notType: true }), source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 })).toEqual({ kind: "rejected", reason: "unsupported_shape" });
  });

  it("16. skips an unrecognized (but structurally fine) record type, e.g. turn_context/session_meta", () => {
    for (const type of ["turn_context", "session_meta", "response_item", "world_state", "inter_agent_communication_metadata"]) {
      const outcome = parseCodexUsageLine({ line: JSON.stringify({ type, model: "gpt-6-astra", effort: "high" }), source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 });
      expect(outcome).toEqual({ kind: "skipped", reason: "unrecognized_record_type", observations: [] });
    }
  });

  it("17. a pre-0.154 file with only token_count events (no token_usage_record) yields zero snapshots", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ rate_limits: undefined }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("cumulative_without_identity");
      expect(outcome.observations).toEqual([]);
    }
  });
});

describe("parseCodexUsageLine — event_msg / token_count", () => {
  it("18. total_token_usage is skipped as cumulative_without_identity, never summed into a snapshot", () => {
    const outcome = parseCodexUsageLine(tokenCountLine());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("cumulative_without_identity");
  });

  it("19. last_token_usage alone (no total) is skipped as no_identity", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ info: { last_token_usage: { input_tokens: 100, output_tokens: 50 }, model_context_window: 200000 } }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("no_identity");
  });

  it("20. two byte-identical token_count events yield zero snapshots each time (proven duplicates, nothing to dedup on)", () => {
    const first = parseCodexUsageLine(tokenCountLine());
    const second = parseCodexUsageLine(tokenCountLine());
    expect(first.kind).toBe("skipped");
    expect(second.kind).toBe("skipped");
  });

  it("21. one outcome carries both a skipped-usage reason and rate-limit observations at once", () => {
    const outcome = parseCodexUsageLine(tokenCountLine());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") return;
    expect(outcome.reason).toBe("cumulative_without_identity");
    expect(outcome.observations).toHaveLength(1);
    expect(outcome.observations[0].slot).toBe("primary");
  });

  it("22. primary-only rate_limits yields one observation; primary+secondary yields two; secondary:null yields one", () => {
    const primaryOnly = parseCodexUsageLine(tokenCountLine());
    expect(primaryOnly.kind === "skipped" && primaryOnly.observations.length).toBe(1);

    const both = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 53, window_minutes: 300, resets_at: 1893456000 }, secondary: { used_percent: 8, window_minutes: 10080, resets_at: 1893999999 } } }));
    expect(both.kind === "skipped" && both.observations.length).toBe(2);

    const secondaryNull = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1893456000 }, secondary: null } }));
    expect(secondaryNull.kind === "skipped" && secondaryNull.observations.length).toBe(1);
  });

  it("23. a token_count event with only rate_limits (no info at all) is skipped as rate_limit_only, observations still present", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ info: undefined }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") return;
    expect(outcome.reason).toBe("rate_limit_only");
    expect(outcome.observations).toHaveLength(1);
  });

  it("24. plan_type/limit_id/credits/individual_limit/limit_name/rate_limit_reached_type/spend_control_reached never appear in any output field", () => {
    const outcome = parseCodexUsageLine(tokenCountLine());
    const serialized = JSON.stringify(outcome);
    for (const forbidden of ["raw-limit-id-999", "plan_type", "\"pro\"", "1234", "individual_limit", "limit_name", "weekly", "rate_limit_reached_type", "spend_control_reached"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    ["42.0", 42.0, 42.0, null],
    ["0", 0, 0, null],
    ["100", 100, 100, null],
    ["100.5", 100.5, null, "exceeds_100"],
    ["string \"42\"", "42", null, "not_a_number"],
    ["null", null, null, null],
  ] as const)("25. normalizePercent(%s) matches the expected value/diagnosis", (_label, input, expectedValue, expectedDiagnosis) => {
    expect(normalizePercent(input)).toEqual({ value: expectedValue, diagnosis: expectedDiagnosis });
  });

  it("25b. normalizePercent treats a missing field as null/null, distinct from an invalid one", () => {
    expect(normalizePercent(undefined)).toEqual({ value: null, diagnosis: null });
  });

  it("26. malformed window_minutes/resets_at report a structured diagnosis instead of silently becoming 0", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 10, window_minutes: "not-a-number", resets_at: -5 } } }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") return;
    expect(outcome.observations[0].windowMinutes).toEqual({ value: null, diagnosis: "not_a_number" });
    expect(outcome.observations[0].resetsAtMs).toEqual({ value: null, diagnosis: "negative" });
  });

  it("27. window_minutes/resets_at absent entirely are null with no diagnosis", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 10 } } }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") return;
    expect(outcome.observations[0].windowMinutes).toEqual({ value: null, diagnosis: null });
    expect(outcome.observations[0].resetsAtMs).toEqual({ value: null, diagnosis: null });
  });

  it("28. resets_at unix seconds are converted to ms", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1893456000 } } }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") return;
    expect(outcome.observations[0].resetsAtMs).toEqual({ value: 1893456000 * 1000, diagnosis: null });
  });

  it("29. rate-limit observation identityKey is opaque and distinct per principal/source/time", () => {
    const a = parseCodexUsageLine(tokenCountLine());
    const b = parseCodexUsageLine({ ...tokenCountLine(), source: { principalKey: "principal-b", sourceKey: SOURCE } } as UsageLineInput);
    if (a.kind !== "skipped" || b.kind !== "skipped") throw new Error("expected skipped");
    expect(a.observations[0].identityKey).toMatch(/^[0-9a-f]{32}$/);
    expect(a.observations[0].identityKey).not.toBe(b.observations[0].identityKey);
  });

  it("29b. same time different usage/reset yields different identity", () => {
    const a = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1893456000 } } }));
    const b = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 43, window_minutes: 10080, resets_at: 1893456000 } } }));
    if (a.kind !== "skipped" || b.kind !== "skipped") throw new Error("expected skipped");
    expect(a.observations[0].identityKey).not.toBe(b.observations[0].identityKey);
  });

  it("29c. same semantic evidence different slot yields same identity", () => {
    const a = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1893456000 }, secondary: null } }));
    const b = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: null, secondary: { used_percent: 42, window_minutes: 10080, resets_at: 1893456000 } } }));
    if (a.kind !== "skipped" || b.kind !== "skipped") throw new Error("expected skipped");
    expect(a.observations[0].identityKey).toBe(b.observations[0].identityKey);
  });

  it("30. a payload.type other than token_count is skipped as unrecognized_record_type with no observations", () => {
    const outcome = parseCodexUsageLine({ line: JSON.stringify({ type: "event_msg", timestamp: TS, payload: { type: "agent_message", text: "hi" } }), source: { principalKey: PRINCIPAL, sourceKey: SOURCE }, sequence: 0 });
    expect(outcome).toEqual({ kind: "skipped", reason: "unrecognized_record_type", observations: [] });
  });
});

describe("codex usage accumulator", () => {
  it("31. is idempotent across repeated identical snapshots", () => {
    const snapshot = accept(tokenUsageRecordLine());
    const once = applyCodexUsageSnapshot(createCodexUsageAccumulator(), snapshot);
    const twice = applyCodexUsageSnapshot(once, snapshot);
    expect(twice.entries.size).toBe(1);
    expect(twice.entries.get(snapshot.identityKey)?.usage).toEqual(once.entries.get(snapshot.identityKey)?.usage);
  });

  it("32. two distinct response_ids under the same source are two separate entries (revision-like duplicate case, Claude-style)", () => {
    const a = accept(tokenUsageRecordLine({ response_id: "resp_a" }));
    const b = accept(tokenUsageRecordLine({ response_id: "resp_b" }));
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [a, b]);
    expect(state.entries.size).toBe(2);
  });

  it("33. a strictly later revision of the same response_id replaces the prior one, including a legitimate decrease", () => {
    const first = accept(tokenUsageRecordLine({ response_id: "resp_rev", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 150 } }));
    const corrected: CodexUsageSnapshot = { ...first, observedAtMs: first.observedAtMs + 1000, usage: { ...first.usage, input_tokens: { value: 40, diagnosis: null } } };
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [first, corrected]);
    expect(state.entries.get(first.identityKey)?.usage.input_tokens.value).toBe(40);
  });

  it("34. an out-of-order older observation never overwrites a newer one", () => {
    const newer = accept(tokenUsageRecordLine({ response_id: "resp_order" }));
    const older: CodexUsageSnapshot = { ...newer, observedAtMs: newer.observedAtMs - 5000, usage: { ...newer.usage, input_tokens: { value: 999, diagnosis: null } } };
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [newer, older]);
    expect(state.entries.get(newer.identityKey)?.usage.input_tokens.value).toBe(newer.usage.input_tokens.value);
  });

  it("35. quarantines a same-timestamp tie with conflicting content instead of merging it, and it stays quarantined", () => {
    const a = accept(tokenUsageRecordLine({ response_id: "resp_tie" }));
    const b: CodexUsageSnapshot = { ...a, usage: { ...a.usage, input_tokens: { value: 20, diagnosis: null } } };
    const c: CodexUsageSnapshot = { ...a };
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [a, b, c]);
    expect(state.entries.has(a.identityKey)).toBe(false);
    expect(state.quarantined.get(a.identityKey)).toEqual({ identityKey: a.identityKey, reason: "conflicting_same_version" });
  });

  it("36. cumulative duplicate token_count events never contribute any token accounting to the accumulator", () => {
    const outcome1 = parseCodexUsageLine(tokenCountLine());
    const outcome2 = parseCodexUsageLine(tokenCountLine());
    let state = createCodexUsageAccumulator();
    for (const outcome of [outcome1, outcome2] as CodexLineOutcome[]) {
      if (outcome.kind === "accepted") state = applyCodexUsageSnapshot(state, outcome.snapshot);
    }
    expect(state.entries.size).toBe(0);
  });

  it("37. rejects/quarantines a forged cross-source collision attempt rather than merging: identical response_id under a different principal never shares an identity to merge into", () => {
    const a = accept(tokenUsageRecordLine({ payload: { response_id: "resp_forged", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 } } }, "victim-principal", "victim-source"));
    const b = accept(tokenUsageRecordLine({ payload: { response_id: "resp_forged", usage: { input_tokens: 999999, output_tokens: 999999, cached_input_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 1999998 } } }, "attacker-principal", "attacker-source"));
    expect(a.identityKey).not.toBe(b.identityKey);
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [a, b]);
    expect(state.entries.size).toBe(2);
    expect(state.entries.get(a.identityKey)?.usage.input_tokens.value).toBe(100);
    expect(state.entries.get(b.identityKey)?.usage.input_tokens.value).toBe(999999);
  });

  it("37b. quarantines identity conflict when source/principal changes for same identityKey (forged snapshot)", () => {
    const a = accept(tokenUsageRecordLine({ payload: { response_id: "resp_conflict", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 } } }, "principal-a", "source-a"));
    // Forge a snapshot with same identityKey but different sourceKey/principalKey
    const forged: CodexUsageSnapshot = { ...a, sourceKey: "source-b", principalKey: "principal-b" };
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [a, forged]);
    expect(state.entries.has(a.identityKey)).toBe(false);
    expect(state.quarantined.get(a.identityKey)).toEqual({ identityKey: a.identityKey, reason: "identity_conflict" });
  });

  it("37c. quarantines identity conflict when model changes for same identityKey (forged snapshot)", () => {
    const a = accept(tokenUsageRecordLine({ payload: { response_id: "resp_model_conflict", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 } } }, "principal-a", "source-a"));
    // Forge a snapshot with same identityKey but different model (though model is always null in valid snapshots, this tests the check)
    const forged: CodexUsageSnapshot = { ...a, model: "gpt-4" as any };
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [a, forged]);
    expect(state.entries.has(a.identityKey)).toBe(false);
    expect(state.quarantined.get(a.identityKey)).toEqual({ identityKey: a.identityKey, reason: "identity_conflict" });
  });

  it("37d. quarantines identity conflict for older-timestamp forged source case", () => {
    const a = accept(tokenUsageRecordLine({ payload: { response_id: "resp_older_forged", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 0, total_tokens: 150 } } }, "principal-a", "source-a"));
    // Forge a snapshot with same identityKey but different sourceKey/principalKey and older timestamp
    const forged: CodexUsageSnapshot = { ...a, sourceKey: "source-b", principalKey: "principal-b", observedAtMs: a.observedAtMs - 1000 };
    const state = applyCodexUsageSnapshots(createCodexUsageAccumulator(), [a, forged]);
    expect(state.entries.has(a.identityKey)).toBe(false);
    expect(state.quarantined.get(a.identityKey)).toEqual({ identityKey: a.identityKey, reason: "identity_conflict" });
  });
});

describe("privacy allowlist", () => {
  it("38. no output field of any outcome ever contains raw ids, cwd, or free-form model/metadata text", () => {
    const canaryIds = ["sess_CANARY", "thread_CANARY", "turn_CANARY", "resp_CANARY", "/Users/test/CANARY_PROJECT", "codex-auto-review"];
    const line = tokenUsageRecordLine({
      session_id: "sess_CANARY",
      thread_id: "thread_CANARY",
      turn_id: "turn_CANARY",
      root_turn_id: "turn_CANARY",
      response_id: "resp_CANARY",
      cwd: "/Users/test/CANARY_PROJECT",
    });
    const outcome = parseCodexUsageLine(line);
    const serialized = JSON.stringify(outcome);
    for (const canary of canaryIds) {
      if (canary === "resp_CANARY") continue; // response_id legitimately feeds the hash input, not the output; checked separately below
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("resp_CANARY");
  });

  it("39. rate-limit observations never leak plan/credit/limit identifiers even when nested oddly", () => {
    const outcome = parseCodexUsageLine(tokenCountLine({ rate_limits: { primary: { used_percent: 1, window_minutes: 10, resets_at: 1 }, limit_id: "CANARY-LIMIT-ID", plan_type: "CANARY-PLAN" } }));
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("CANARY-LIMIT-ID");
    expect(serialized).not.toContain("CANARY-PLAN");
  });
});
