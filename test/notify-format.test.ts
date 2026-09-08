import { describe, expect, it } from "vitest";
import { eventText, thresholdText } from "../src/notify-format.js";
import type { EventKind, HeadroomEvent, Observation } from "../src/types.js";

const at = new Date(2026, 8, 8, 3, 24).toISOString();
const event = (kind: EventKind, extra: Partial<HeadroomEvent> = {}): HeadroomEvent => ({
  id: "fixture", kind, principal_id: "claude-main", meter_id: "claude-main:all", created_at: at,
  origin: "vendor_reported", confidence: 1, evidence_observation_ids: [], corrected_by: null,
  reason: null, last_seen_at: null, ...extra,
});
const observation: Observation = {
  principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
  quantity: { used: 0.2, remaining: 99.8, limit: 100, unit: "percent" },
  fetched_at: at, observed_at: at, resets_at: new Date(2026, 9, 4, 14, 0).toISOString(), source: "fixture",
  truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  metadata: { free_resets_available: 2, plan: "Max" },
};

describe("phone notification text", () => {
  it("formats every stored event kind from fixed facts", () => {
    const evidence = [{ ...observation, metadata: { plan: "Pro" } }, observation];
    const texts = {
      reset_seen: eventText(event("reset_seen", { metadata: { unscheduled: true, window_minutes: 10_080, used_percent: 0.2, previous_used_percent: 88.4 } }), evidence),
      free_reset_granted: eventText(event("free_reset_granted"), evidence),
      free_reset_used: eventText(event("free_reset_used"), evidence),
      credits_changed: eventText(event("credits_changed"), evidence),
      plan_changed: eventText(event("plan_changed"), evidence),
      source_failed: eventText(event("source_failed", { principal_id: "antigravity", meter_id: "antigravity:main", reason: "HTTP 403", last_seen_at: new Date(Date.parse(at) + 25 * 60_000).toISOString() }), evidence),
      source_recovered: eventText(event("source_recovered", { principal_id: "antigravity", meter_id: "antigravity:main" })),
      pace_projection_conserve: eventText(event("pace_projection_conserve", { reason: "burning 24%/h, empty in 48m, reset in 3h 12m" }), [{ ...observation, window: { kind: "rolling", minutes: 300, enforcement: "hard" } }]),
      model_new: eventText(event("model_new", { reason: "Opus 5" })),
      grant_lapsed: eventText(event("grant_lapsed")),
      lease_started: eventText(event("lease_started")),
      lease_ended: eventText(event("lease_ended")),
    } satisfies Record<EventKind, string>;
    expect(texts).toMatchInlineSnapshot(`
      {
        "credits_changed": "🪙 Credits changed
      Claude main now has 2 reset credits.
      Check the balance before using another credit.",
        "free_reset_granted": "🎁 Free reset credit granted
      Claude main now has 2 (expire Oct 4).
      Use a credit when you need more capacity.",
        "free_reset_used": "🎟️ Free reset used
      Claude main now has 2 reset credits left.
      Check the refreshed allowance before planning more work.",
        "grant_lapsed": "🔑 Keychain grant lapsed
      Claude main.
      Run: headroom keychain grant --principal claude-main",
        "lease_ended": "🏁 Lease ended
      Claude main's work reservation ended.
      Unused reserved capacity is available again.",
        "lease_started": "▶️ Lease started
      Claude main has a new work reservation.
      Its reserved capacity is accounted for while the lease runs.",
        "model_new": "🆕 New model bucket seen
      Claude main now reports \"Opus 5\" as its own meter.
      Check its allowance before routing work to it.",
        "pace_projection_conserve": "🐢 Projected stall
      Claude main 5h burns 24%/h and would hit 100% in 48m, reset in 3h 12m.
      Slow down to make this window last.",
        "plan_changed": "📋 Plan changed
      Claude main is now on Max (was Pro).
      Check your new limits before planning work.",
        "reset_seen": "🔄 Unscheduled reset
      Claude main weekly is back to 0% (was 88%) at 03:24.
      Plan again: a full week of capacity appeared.",
        "source_failed": "⚠️ Source failed
      Antigravity has not answered for 25 minutes (403).
      Rows read UNKNOWN until it recovers.",
        "source_recovered": "✅ Source recovered
      Antigravity is reading again.
      Fresh readings are available for planning.",
      }
    `);
    for (const text of Object.values(texts)) {
      expect(text.split("\n").length).toBeLessThanOrEqual(4);
      expect(text).not.toContain("claude-main:all");
      expect(text).not.toContain("NaN");
    }
  });

  it("names scheduled windows, rounds percentages and includes the local reset date and countdown", () => {
    expect(eventText(event("reset_seen", { metadata: { window_minutes: 10_080 } }), [observation])).toBe("🗓️ Weekly reset\nClaude main weekly is at 0% again (reset 03:24).\nCapacity is available again in this window.");
    expect(eventText(event("reset_seen", { metadata: { window_minutes: 300 } }), [observation])).toBe("🗓️ Scheduled reset\nClaude main 5h is at 0% again (reset 03:24).\nCapacity is available again in this window.");
    expect(thresholdText({ ...observation, principal_id: "codex", meter_id: "codex:main", fetched_at: new Date(2026, 8, 8, 10, 8).toISOString(), resets_at: new Date(2026, 8, 10, 15, 8).toISOString(), quantity: { used: 90.3, remaining: 9.7, limit: 100, unit: "percent" } }, 90)).toBe("🔥 Threshold\nCodex weekly crossed 90% (now 90%); resets Sep 10 15:08, in 2d 5h.\nCONSERVE until then.");
  });

  it("does not invent a percentage for old events without evidence or leak multiline markup", () => {
    expect(eventText(event("reset_seen"))).not.toContain("0%");
    expect(eventText(event("source_failed", { reason: "403\nAuthorization: Bearer synthetic-secret" }))).toBe("⚠️ Source failed\nClaude main has not answered (403).\nRows read UNKNOWN until it recovers.");
    expect(thresholdText({ ...observation, resets_at: "invalid" }, 90)).toContain("reset time unknown");
  });
});
