import { describe, expect, it } from "vitest";
import { paceCore } from "../packages/policy/src/core.js";
import { defaultPolicy, paceDecision } from "../src/policy.js";
import { defaultPolicyOptions } from "../packages/policy/src/index.js";
import type { Observation } from "../src/types.js";

const now = new Date("2026-10-18T12:00:00Z");
const at = (minutes: number): string => new Date(now.getTime() + minutes * 60_000).toISOString();
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: "service", meter_id: "service:quota", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 50, limit: 100, remaining: 50, unit: "percent" }, resets_at: at(150),
    observed_at: at(0), fetched_at: at(0), source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}
const quantity = (used: number, limit = 100): Observation["quantity"] => ({ used, limit, remaining: limit - used, unit: "percent" });

const cases: Array<[string, Partial<Observation>, string, string]> = [
  ["invalid fetch before freeze", { fetched_at: "bad", quantity: quantity(99) }, "UNKNOWN", "invalid fetch time"],
  ["stale before freeze", { fetched_at: at(-16), quantity: quantity(99) }, "UNKNOWN", "stale 16m; next poll time unknown"],
  ["exact staleness threshold", { fetched_at: at(-15) }, "NORMAL", "on pace"],
  ["just beyond staleness threshold", { fetched_at: new Date(now.getTime() - 900001).toISOString() }, "UNKNOWN", "stale 15m; next poll time unknown"],
  ["future fetch", { fetched_at: at(1) }, "NORMAL", "on pace"],
  ["freeze line", { quantity: quantity(90) }, "FREEZE", "reserve reached"],
  ["just under freeze", { quantity: quantity(89.999) }, "CONSERVE", "behind pace"],
  ["freeze before reset validation", { quantity: quantity(90), resets_at: null }, "FREEZE", "reserve reached"],
  ["missing reset", { resets_at: null }, "UNKNOWN", "reset unknown"],
  ["invalid reset", { resets_at: "bad" }, "UNKNOWN", "reset unknown"],
  ["grace", { resets_at: at(271) }, "NORMAL", "grace period"],
  ["grace edge", { resets_at: at(270) }, "CONSERVE", "behind pace"],
  ["grace stall exception edge", { resets_at: at(271), empty_in_seconds: 1800, burn_percent_per_hour: 100 }, "NORMAL", "grace period"],
  ["grace urgent stall", { resets_at: at(271), empty_in_seconds: 1799, burn_percent_per_hour: 100 }, "CONSERVE", "burning 100%/h, empty in 29m, reset in 4h 31m"],
  ["stall beats harvest", { quantity: quantity(20), empty_in_seconds: 3600, burn_percent_per_hour: 80 }, "CONSERVE", "burning 80%/h, empty in 1h, reset in 2h 30m"],
  ["stall equality", { empty_in_seconds: 9000 }, "NORMAL", "on pace"],
  ["stall just before reset", { empty_in_seconds: 8999 }, "CONSERVE", "burning 0%/h, empty in 2h 29m, reset in 2h 30m"],
  ["positive surplus edge", { quantity: quantity(40) }, "NORMAL", "on pace"],
  ["harvest", { quantity: quantity(39.999) }, "HARVEST", "ahead of pace"],
  ["negative surplus edge", { quantity: quantity(60) }, "NORMAL", "on pace"],
  ["conserve", { quantity: quantity(60.001) }, "CONSERVE", "behind pace"],
  ["normal", {}, "NORMAL", "on pace"],
  ["past reset", { resets_at: at(-1) }, "HARVEST", "ahead of pace"],
  ["non-percent limit", { quantity: quantity(20, 40) }, "NORMAL", "on pace"],
  ["fixed window", { window: { kind: "fixed", minutes: 300, enforcement: "hard" } }, "NORMAL", "on pace"],
];

describe("shared pace core equivalence", () => {
  it.each(cases)("%s", (_name, overrides, state, reason) => {
    const row = observation(overrides);
    const expected = { state, reason };
    expect(paceDecision(row, defaultPolicy, now)).toEqual(expected);
    expect(paceCore({
      used: row.quantity!.used, limit: row.quantity!.limit!, windowMinutes: row.window!.minutes!,
      resetsAt: row.resets_at, fetchedAtMs: Date.parse(row.fetched_at),
      emptyInSeconds: row.empty_in_seconds, burnPercentPerHour: row.burn_percent_per_hour,
      stalenessMinutes: defaultPolicy.staleness_minutes, freezeReservePct: defaultPolicy.freeze_reserve_pct,
      graceFraction: defaultPolicy.pace_grace_fraction,
    }, now, (age) => `stale ${age}m; next poll time unknown`)).toEqual(expected);
  });

  it("keeps the public defaults equal to headroomd", () => {
    expect(defaultPolicyOptions.stalenessMinutes).toBe(defaultPolicy.staleness_minutes);
    expect(defaultPolicyOptions.freezeReservePercent).toBe(defaultPolicy.freeze_reserve_pct);
    expect(defaultPolicyOptions.paceGraceFraction).toBe(defaultPolicy.pace_grace_fraction);
  });

  it("preserves the next poll hint for a custom interval", () => {
    const row = observation({ fetched_at: at(-16) });
    const policy = { ...defaultPolicy, principal_intervals: { service: 30 } };
    const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at(14)));
    expect(paceDecision(row, policy, now)).toEqual({ state: "UNKNOWN", reason: `stale 16m; next poll ~${clock}` });
  });
});

describe("headroomd pace prechecks", () => {
  const held = "held window past reset, unconfirmed (0m since the last accepted reading); the vendor has not confirmed the new window yet -- wait for the next poll, or re-run headroom status once it reports one";
  const prechecks: Array<[string, Observation | undefined, string, string]> = [
    ["missing", undefined, "UNKNOWN", "no observation"],
    ["state up", observation({ window: { kind: "state", minutes: null, enforcement: "hard" }, metadata: { state: "UP" } }), "UP", "local pool up"],
    ["state busy", observation({ window: { kind: "state", minutes: null, enforcement: "hard" }, metadata: { state: "BUSY", waiting: 2 } }), "BUSY", "local pool busy; waiting 2"],
    ["state down", observation({ window: { kind: "state", minutes: null, enforcement: "hard" } }), "DOWN", "local pool down"],
    ["count", observation({ window: { kind: "count", minutes: null, enforcement: "soft" } }), "NORMAL", "availability count"],
    ["held before not enforced", observation({ freshness: "not_enforced", metadata: { vendor_window_held: true } }), "UNKNOWN", held],
    ["inconsistent", observation({ metadata: { vendor_inconsistent: true } }), "UNKNOWN", held],
    ["blocked", observation({ freshness: "failed", metadata: { lane_state: "blocked_by_weekly" } }), "UNKNOWN", "blocked: weekly exhausted"],
    ["not enforced", observation({ freshness: "not_enforced" }), "NOT_ENFORCED", "not enforced"],
    ["stored stale", observation({ freshness: "stale", reason: "old", fetched_at: at(-16) }), "UNKNOWN", "old; next poll time unknown"],
    ["failed", observation({ freshness: "failed", reason: "unavailable" }), "UNKNOWN", "unavailable"],
    ["missing quantity", observation({ quantity: null }), "UNKNOWN", "missing window or quantity"],
    ["missing window", observation({ window: null }), "UNKNOWN", "missing window or quantity"],
    ["missing limit", observation({ quantity: { used: 5, limit: null, remaining: null, unit: "percent" } }), "UNKNOWN", "missing window or quantity"],
  ];
  it.each(prechecks)("%s", (_name, row, state, reason) => {
    expect(paceDecision(row, defaultPolicy, now)).toEqual({ state, reason });
  });
});
