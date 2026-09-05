import { describe, expect, it } from "vitest";
import { backoffReason, withBackoffReasons } from "../src/collector.js";
import type { Observation } from "../src/types.js";

function failed(reason: string, principal = "codex-main"): Observation {
  return {
    principal_id: principal, meter_id: `${principal}:main`, window: null, quantity: null, resets_at: null,
    observed_at: "2026-09-05T12:00:00Z", fetched_at: "2026-09-05T12:00:00Z", source: "fixture", truth: "estimated",
    freshness: "failed", confidence: 0, adapter_version: "fixture", upstream_schema_version: "fixture", reason,
  };
}

describe("backoffReason", () => {
  it("names the real deadline, not the original vendor error", () => {
    const until = new Date("2026-09-05T14:32:00Z").getTime();
    expect(backoffReason(until)).toMatch(/^rate limited by the vendor \(429\); backing off until \d\d:\d\d$/);
  });
});

describe("withBackoffReasons", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");

  it("rewrites a 429 failure's reason to the backoff deadline when currently backed off", () => {
    const rows = withBackoffReasons([failed("Codex usage request failed (429)")], () => now + 5 * 60_000, now);
    expect(rows[0].reason).toMatch(/^rate limited by the vendor \(429\); backing off until \d\d:\d\d$/);
  });

  it("leaves a 401/403 failure's reason untouched -- only a genuine 429 gets the backoff wording", () => {
    const rows = withBackoffReasons([failed("Codex rejected the token (401); run: codex login")], () => now + 5 * 60_000, now);
    expect(rows[0].reason).toBe("Codex rejected the token (401); run: codex login");
  });

  it("leaves the reason untouched once the backoff has actually lifted, or when there is none for this principal", () => {
    const past = withBackoffReasons([failed("Codex usage request failed (429)")], () => now - 1000, now);
    expect(past[0].reason).toBe("Codex usage request failed (429)");
    const none = withBackoffReasons([failed("Codex usage request failed (429)")], () => undefined, now);
    expect(none[0].reason).toBe("Codex usage request failed (429)");
  });

  it("leaves a fresh (non-failed) observation untouched even if it somehow carries a 429-shaped reason", () => {
    const fresh: Observation = { ...failed("(429)"), freshness: "fresh", quantity: { used: 1, limit: 100, remaining: 99, unit: "percent" } };
    const rows = withBackoffReasons([fresh], () => now + 60_000, now);
    expect(rows[0].reason).toBe("(429)");
  });

  it("preserves extra fields on the input type (e.g. a StoredObservation's id)", () => {
    const stored = { ...failed("Codex usage request failed (429)"), id: 42 };
    const rows = withBackoffReasons([stored], () => now + 60_000, now);
    expect(rows[0].id).toBe(42);
  });
});
