import { test } from "node:test";
import assert from "node:assert/strict";
import { fromClaudeRateLimitEvent } from "../dist/index.js";
import { now } from "./helpers.mjs";

const fixture = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1792324800, rateLimitType: "seven_day", utilization: 0.77, overageStatus: "rejected", isUsingOverage: false, surpassedThreshold: 0.75, unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: 1792260000 }, seven_day: { utilization: 0.77, resetsAt: 1792324800 } }, overageEnabled: false }, uuid: "x", session_id: "x" };
const adapt = (info, receivedAt = now) => fromClaudeRateLimitEvent({ rate_limit_info: info }, receivedAt);

test("adapts the unified fixture and scopes status to its named window", () => {
  assert.deepEqual(fromClaudeRateLimitEvent(fixture, now), [
    { meter: "five_hour", windowMinutes: 300, usedPercent: 21, resetsAt: new Date(1792260000 * 1000).toISOString(), fetchedAt: now.toISOString() },
    { meter: "seven_day", windowMinutes: 10080, usedPercent: 77, resetsAt: new Date(1792324800 * 1000).toISOString(), fetchedAt: now.toISOString(), status: "allowed_warning" },
  ]);
  const info = { ...fixture.rate_limit_info, status: "rejected", rateLimitType: "five_hour" };
  assert.equal(adapt(info)[0].status, "rejected");
  assert.equal(adapt(info)[1].status, undefined);
  assert.equal(adapt({ ...info, status: "invalid" })[0].status, undefined);
  assert.equal(adapt({ ...info, status: undefined, overageStatus: "rejected" })[0].status, undefined);
});

test("fallback requires a known window, numeric utilization and a valid reset", () => {
  const info = { rateLimitType: "five_hour", utilization: 0.333333333, resetsAt: 1792260000, status: "allowed" };
  assert.deepEqual(adapt(info), [{ meter: "five_hour", windowMinutes: 300, usedPercent: 33.3333, resetsAt: new Date(1792260000 * 1000).toISOString(), fetchedAt: now.toISOString(), status: "allowed" }]);
  for (const unifiedWindows of [null, [], "bad", 4]) assert.equal(adapt({ ...info, unifiedWindows }).length, 1);
  for (const changes of [{ rateLimitType: "other" }, { utilization: NaN }, { utilization: "0.2" }, { utilization: undefined }, { resetsAt: undefined }, { resetsAt: Infinity }, { resetsAt: 1e300 }]) assert.deepEqual(adapt({ ...info, ...changes }), []);
  assert.deepEqual(adapt({ ...info, unifiedWindows: {} }), []);
});

test("clamps and rounds fractions, ignores unknown windows and invalid entries", () => {
  for (const [utilization, expected] of [[-0.1, 0], [1.4, 100], [0.123456789, 12.3457], [0, 0], [1, 100]]) {
    const result = adapt({ unifiedWindows: { five_hour: { utilization, resetsAt: "bad" }, other: { utilization: 0.5, resetsAt: 1 } } });
    assert.equal(result.length, 1);
    assert.equal(result[0].usedPercent, expected);
    assert.equal(result[0].resetsAt, null);
  }
  for (const value of [null, [], "bad", 2, { utilization: NaN }, { utilization: Infinity }, { utilization: "0.2" }]) assert.deepEqual(adapt({ unifiedWindows: { five_hour: value } }), []);
  for (const resetsAt of [null, undefined, NaN, Infinity, {}, 1e300]) assert.equal(adapt({ unifiedWindows: { five_hour: { utilization: 0.2, resetsAt } } })[0].resetsAt, null);
});

test("garbage and invalid received times never throw", () => {
  for (const value of [null, undefined, "bad", [], 2, NaN, {}, { rate_limit_info: [] }, { rate_limit_info: null }, { rate_limit_info: "bad" }]) assert.deepEqual(fromClaudeRateLimitEvent(value, now), []);
  for (const receivedAt of [null, undefined, "bad", new Date(NaN)]) assert.deepEqual(fromClaudeRateLimitEvent(fixture, receivedAt), []);
  const throwing = { get rate_limit_info() { throw new Error("bad"); } };
  assert.deepEqual(fromClaudeRateLimitEvent(throwing, now), []);
});
