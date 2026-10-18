import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPolicyOptions, paceState, pace, holdUntil } from "../dist/index.js";
import { formatResetsIn, paceCore } from "../dist/core.js";
import { now, at, reading } from "./helpers.mjs";

const cases = [
  ["harvest", { usedPercent: 39.999 }, "HARVEST", "ahead of pace"],
  ["positive surplus edge", { usedPercent: 40 }, "NORMAL", "on pace"],
  ["on pace", {}, "NORMAL", "on pace"],
  ["negative surplus edge", { usedPercent: 60 }, "NORMAL", "on pace"],
  ["conserve", { usedPercent: 60.001 }, "CONSERVE", "behind pace"],
  ["below freeze", { usedPercent: 89.999 }, "CONSERVE", "behind pace"],
  ["freeze line", { usedPercent: 90 }, "FREEZE", "reserve reached"],
  ["over freeze", { usedPercent: 100 }, "FREEZE", "reserve reached"],
  ["grace", { usedPercent: 40, resetsAt: at(271) }, "NORMAL", "grace period"],
  ["grace edge", { usedPercent: 40, resetsAt: at(270) }, "CONSERVE", "behind pace"],
  ["grace projection at 30m", { usedPercent: 40, resetsAt: at(271), burnPercentPerHour: 120 }, "NORMAL", "grace period"],
  ["grace projection under 30m", { usedPercent: 40, resetsAt: at(271), burnPercentPerHour: 121 }, "CONSERVE", "burning 121%/h, empty in 29m, reset in 4h 31m"],
  ["stall beats harvest", { usedPercent: 20, burnPercentPerHour: 40 }, "CONSERVE", "burning 40%/h, empty in 2h, reset in 2h 30m"],
  ["stall equality", { burnPercentPerHour: 20 }, "NORMAL", "on pace"],
  ["stall just before reset", { burnPercentPerHour: 20.001 }, "CONSERVE", "burning 20%/h, empty in 2h 30m, reset in 2h 30m"],
  ["zero burn", { burnPercentPerHour: 0 }, "NORMAL", "on pace"],
  ["negative burn", { burnPercentPerHour: -1 }, "NORMAL", "on pace"],
  ["missing usage", { usedPercent: null }, "UNKNOWN", "no usage reading"],
  ["invalid usage", { usedPercent: NaN }, "UNKNOWN", "no usage reading"],
  ["invalid fetch", { fetchedAt: "bad" }, "UNKNOWN", "invalid fetch time"],
  ["invalid reset", { resetsAt: "bad" }, "UNKNOWN", "reset unknown"],
  ["missing reset", { resetsAt: null }, "UNKNOWN", "reset unknown"],
  ["missing window", { windowMinutes: 0 }, "UNKNOWN", "missing window"],
  ["stale", { fetchedAt: at(-16) }, "UNKNOWN", "stale 16m"],
  ["staleness edge", { fetchedAt: at(-15) }, "NORMAL", "on pace"],
  ["one millisecond stale", { fetchedAt: new Date(now.getTime() - 900001).toISOString() }, "UNKNOWN", "stale 15m"],
  ["future fetch", { fetchedAt: at(1) }, "NORMAL", "on pace"],
  ["freeze before reset validation", { usedPercent: 90, resetsAt: null }, "FREEZE", "reserve reached"],
  ["stale before freeze", { usedPercent: 90, fetchedAt: at(-16) }, "UNKNOWN", "stale 16m"],
  ["past reset", { resetsAt: at(-1) }, "HARVEST", "ahead of pace"],
];
for (const [name, changes, state, reason] of cases) {
  test(name, () => assert.deepEqual(paceState(reading(changes), undefined, now), { state, reason }));
}

test("defaults and option overrides", () => {
  assert.deepEqual(defaultPolicyOptions, { stalenessMinutes: 15, freezeReservePercent: 10, paceGraceFraction: 0.1, conserveHoldMinutes: 60, unknownRecheckMinutes: 5 });
  assert.equal(paceState(reading({ usedPercent: 85 }), { freezeReservePercent: 15 }, now).state, "FREEZE");
  assert.equal(paceState(reading({ fetchedAt: at(-16) }), { stalenessMinutes: 20 }, now).state, "NORMAL");
  assert.equal(paceState(reading({ resetsAt: at(270), usedPercent: 40 }), { paceGraceFraction: 0.2 }, now).reason, "grace period");
  assert.equal(paceState(reading(), { freezeReservePercent: NaN, stalenessMinutes: undefined }, now).state, "NORMAL");
});

test("rejected always freezes, including missing or stale usage", () => {
  for (const changes of [{ usedPercent: 0 }, { usedPercent: null }, { fetchedAt: "bad" }, { fetchedAt: at(-99) }]) {
    const result = paceState(reading({ ...changes, status: "rejected" }), undefined, now);
    assert.equal(result.state, "FREEZE");
    assert.match(result.reason, /rejected/);
  }
  for (const status of ["allowed", "allowed_warning"]) assert.equal(paceState(reading({ status }), undefined, now).state, "NORMAL");
});

test("tightest wins in both input orders, with stable ties", () => {
  const ranked = [reading({ usedPercent: 20 }), reading(), reading({ usedPercent: 75 }), reading({ usedPercent: null }), reading({ usedPercent: 90 })];
  for (let i = 0; i < ranked.length; i++) {
    const tighter = { ...ranked[i], meter: "tighter" };
    for (let j = 0; j < i; j++) {
      for (const inputs of [[ranked[j], tighter], [tighter, ranked[j]]]) assert.equal(pace(inputs, now).binding, "tighter");
    }
    assert.equal(pace([{ ...tighter, meter: "first" }, tighter], now).binding, "first");
  }
  assert.deepEqual(pace([], now), { state: "UNKNOWN", reason: "no readings" });
});

test("odd input and invalid current time stay unknown", () => {
  for (const value of [null, undefined, {}, "bad", [], 5]) assert.equal(paceState(value, undefined, now).state, "UNKNOWN");
  assert.equal(pace(null, now).state, "UNKNOWN");
});

test("core supports custom stale reasons and exact duration formatting", () => {
  const input = { used: 50, limit: 100, windowMinutes: 300, resetsAt: at(150), fetchedAtMs: now.getTime() - 960000, emptyInSeconds: null, burnPercentPerHour: null, stalenessMinutes: 15, freezeReservePct: 10, graceFraction: 0.1 };
  assert.deepEqual(paceCore(input, now), { state: "UNKNOWN", reason: "stale 16m" });
  assert.equal(paceCore(input, now, (age) => `age ${age}`).reason, "age 16");
  for (const [seconds, expected] of [[-1, "0m"], [3599, "59m"], [3600, "1h"], [3660, "1h 1m"], [172800, "2d"], [176400, "2d 1h"]]) assert.equal(formatResetsIn(seconds), expected);
});

test("negative usage is UNKNOWN and an out-of-window reset does not hold for years", () => {
  assert.equal(pace([reading({ usedPercent: -50 })], now).state, "UNKNOWN");
  assert.equal(holdUntil({ class: "a" }, [reading({ status: "rejected", resetsAt: "9999-01-01T00:00:00Z" })], now), at(5));
});
