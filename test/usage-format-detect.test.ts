/**
 * Pure unit coverage for usage-format-detect.ts's per-line vendor-format
 * detection. Every line here is synthetic -- invented shapes and values
 * that correspond to no real Claude Code or Codex CLI session.
 */
import { describe, it, expect } from "vitest";
import { detectUsageLineFormat } from "../src/usage-format-detect.js";

describe("detectUsageLineFormat", () => {
  it("detects a Claude Code assistant transcript line by its message wrapper", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-21T10:00:00.000Z",
      message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 } },
    });
    expect(detectUsageLineFormat(line)).toBe("claude");
  });

  it("detects a Claude Code line of a non-assistant type by the same message wrapper", () => {
    // A "user" line still carries `message`, never `payload` -- the shape
    // check alone is enough without needing the type to be "assistant".
    const line = JSON.stringify({ type: "user", timestamp: "2026-09-21T10:00:00.000Z", message: { role: "user", content: "hi" } });
    expect(detectUsageLineFormat(line)).toBe("claude");
  });

  it("detects a Codex token_usage_record line by its payload wrapper", () => {
    const line = JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-09-21T10:00:00.000Z",
      payload: { response_id: "resp_1", usage: { input_tokens: 100, output_tokens: 50 } },
    });
    expect(detectUsageLineFormat(line)).toBe("codex");
  });

  it("detects a Codex event_msg rate-limit line by its payload wrapper", () => {
    const line = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-21T10:00:00.000Z",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 42, window_minutes: 300 } } },
    });
    expect(detectUsageLineFormat(line)).toBe("codex");
  });

  it("detects a Codex line of a type the parser itself skips, still by the payload wrapper", () => {
    const line = JSON.stringify({ type: "session_meta", timestamp: "2026-09-21T10:00:00.000Z", payload: { id: "session_1" } });
    expect(detectUsageLineFormat(line)).toBe("codex");
  });

  it("falls back to the type vocabulary when neither wrapper field is present", () => {
    expect(detectUsageLineFormat(JSON.stringify({ type: "assistant", timestamp: "2026-09-21T10:00:00.000Z" }))).toBe("claude");
    expect(detectUsageLineFormat(JSON.stringify({ type: "token_usage_record", timestamp: "2026-09-21T10:00:00.000Z" }))).toBe("codex");
    expect(detectUsageLineFormat(JSON.stringify({ type: "event_msg", timestamp: "2026-09-21T10:00:00.000Z" }))).toBe("codex");
  });

  it("reports unknown for a type neither vocabulary recognizes and neither wrapper field present", () => {
    expect(detectUsageLineFormat(JSON.stringify({ type: "something_else", timestamp: "2026-09-21T10:00:00.000Z" }))).toBe("unknown");
    expect(detectUsageLineFormat(JSON.stringify({ timestamp: "2026-09-21T10:00:00.000Z" }))).toBe("unknown");
  });

  it("reports unknown when both wrapper fields are present, unless the type resolves it", () => {
    // A contrived line carrying both -- ambiguous by shape alone.
    expect(detectUsageLineFormat(JSON.stringify({ type: "weird", message: {}, payload: {} }))).toBe("unknown");
    expect(detectUsageLineFormat(JSON.stringify({ type: "assistant", message: {}, payload: {} }))).toBe("claude");
    expect(detectUsageLineFormat(JSON.stringify({ type: "token_usage_record", message: {}, payload: {} }))).toBe("codex");
  });

  it("reports unknown for malformed JSON or a non-object top level, never throwing", () => {
    expect(detectUsageLineFormat("{not json")).toBe("unknown");
    expect(detectUsageLineFormat("[]")).toBe("unknown");
    expect(detectUsageLineFormat("null")).toBe("unknown");
  });

  it("never treats a non-object or array-valued message/payload as the wrapper object, but still resolves via type when it names a known vendor", () => {
    // Neither wrapper field is structurally valid here, so detection falls
    // through to the `type` vocabulary -- which still correctly resolves
    // these, rather than giving up.
    expect(detectUsageLineFormat(JSON.stringify({ type: "assistant", message: "not an object" }))).toBe("claude");
    expect(detectUsageLineFormat(JSON.stringify({ type: "assistant", message: [1, 2, 3] }))).toBe("claude");
    expect(detectUsageLineFormat(JSON.stringify({ type: "token_usage_record", payload: "not an object" }))).toBe("codex");
    expect(detectUsageLineFormat(JSON.stringify({ type: "token_usage_record", payload: [1, 2, 3] }))).toBe("codex");
    // With no recognizable type either, it is genuinely unknown.
    expect(detectUsageLineFormat(JSON.stringify({ type: "something_else", message: "not an object" }))).toBe("unknown");
  });
});
