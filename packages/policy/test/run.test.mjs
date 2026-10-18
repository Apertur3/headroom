import { test } from "node:test";
import assert from "node:assert/strict";
import { canRun, holdUntil, pace, paceState } from "../dist/index.js";
import { now, at, reading } from "./helpers.mjs";
const need = { class: "work" };

test("each state, absent spend, neverHold, and empty needs", () => {
  for (const [usedPercent, state, ok] of [[20, "HARVEST", true], [50, "NORMAL", true], [75, "CONSERVE", true], [90, "FREEZE", false], [null, "UNKNOWN", false]]) {
    const readings = [reading({ usedPercent })];
    const decision = canRun(need, readings, now);
    assert.equal(decision.state, state);
    assert.equal(decision.ok, ok);
    assert.equal(holdUntil(need, readings, now), ok ? null : state === "FREEZE" ? at(150) : at(5));
    assert.deepEqual(canRun({ ...need, neverHold: true, percent: 100 }, readings, now), { ...pace(readings, now), ok: true });
    assert.equal(canRun([], readings, now).ok, ok);
    assert.equal(holdUntil([], readings, now), holdUntil(need, readings, now));
  }
});

test("CONSERVE spend crosses reserve at equality", () => {
  const readings = [reading({ usedPercent: 75 })];
  for (const [percent, ok] of [[14.999, true], [15, false], [15.001, false], [NaN, true], [Infinity, true], [-50, true], [undefined, true]]) {
    assert.equal(canRun({ ...need, percent }, readings, now).ok, ok);
    assert.equal(holdUntil({ ...need, percent }, readings, now), ok ? null : at(60));
  }
  assert.equal(canRun({ ...need, percent: 10 }, readings, now, { freezeReservePercent: 15 }).ok, false);
});

test("CONSERVE spend checks stall projection strictly before reset", () => {
  const readings = [reading({ usedPercent: 75, burnPercentPerHour: 5 })];
  for (const [percent, ok] of [[12.499, true], [12.5, true], [12.501, false]]) assert.equal(canRun({ ...need, percent }, readings, now).ok, ok);
  assert.match(canRun({ ...need, percent: 12.501 }, readings, now).reason, /stall/);
  assert.equal(canRun({ ...need, percent: 1 }, [reading({ usedPercent: 75, burnPercentPerHour: 20 })], now).ok, false);
  assert.equal(canRun(need, [reading({ usedPercent: 75, burnPercentPerHour: 20 })], now).ok, true);
});

test("spend checks ANY relevant reading and binds the one that refuses", () => {
  const readings = [reading({ meter: "steady", usedPercent: 75 }), reading({ meter: "fast", usedPercent: 20, burnPercentPerHour: 31 })];
  const decision = canRun({ ...need, percent: 3 }, readings, now);
  assert.equal(decision.ok, false);
  assert.equal(decision.binding, "fast");
  assert.equal(decision.state, "CONSERVE");
  assert.equal(decision.waitUntil, at(60));
});

test("window matching, missing windows, and multiple needs", () => {
  const readings = [reading({ meter: "short", usedPercent: 90 }), reading({ meter: "long", windowMinutes: 10080, usedPercent: 20, resetsAt: at(5040) })];
  assert.equal(canRun({ ...need, windowMinutes: 10080 }, readings, now).ok, true);
  assert.deepEqual(canRun({ ...need, windowMinutes: 60 }, readings, now), { state: "UNKNOWN", reason: "no readings", ok: false, waitUntil: at(5) });
  assert.equal(canRun(need, readings, now).binding, "short");
  const needs = [{ ...need, windowMinutes: 300, neverHold: true }, { ...need, windowMinutes: 60 }];
  assert.equal(canRun(needs, readings, now).state, "UNKNOWN");
  assert.equal(canRun(needs, readings, now).ok, false);
  assert.equal(canRun(needs.map((item) => ({ ...item, neverHold: true })), readings, now).state, "FREEZE");
  const refusals = [{ ...need, windowMinutes: 60 }, { ...need, windowMinutes: 300 }];
  assert.equal(canRun(refusals, readings, now).state, "FREEZE");
  assert.equal(canRun(refusals.reverse(), readings, now).state, "FREEZE");
  assert.equal(canRun(need, [], now).ok, false);
});

test("hold durations, caps, past reset fallback, and rejected resets", () => {
  const spend = { ...need, percent: 15 };
  for (const [changes, options, expected] of [
    [{ usedPercent: 75 }, undefined, at(60)],
    [{ usedPercent: 75, resetsAt: at(20), burnPercentPerHour: 100 }, undefined, at(20)],
    [{ usedPercent: 75, resetsAt: at(120) }, { conserveHoldMinutes: 10 }, at(10)],
    [{ usedPercent: 75, resetsAt: at(-1), burnPercentPerHour: 10 }, undefined, null],
    [{ usedPercent: 90 }, undefined, at(150)],
    [{ usedPercent: 90, resetsAt: at(-1) }, undefined, at(5)],
    [{ usedPercent: 90, resetsAt: now.toISOString() }, undefined, at(5)],
    [{ usedPercent: 90, resetsAt: null }, { unknownRecheckMinutes: 2 }, at(2)],
    [{ usedPercent: null, resetsAt: at(1) }, undefined, at(5)],
    [{ usedPercent: 10, status: "rejected", resetsAt: "bad" }, undefined, at(5)],
  ]) {
    const readings = [reading(changes)];
    assert.equal(holdUntil(spend, readings, now, options), expected);
    assert.equal(canRun(spend, readings, now, options).waitUntil ?? null, expected);
  }
});

test("hold uses the exact binding window even with the same meter name", () => {
  const readings = [reading({ resetsAt: at(10) }), reading({ windowMinutes: 10080, usedPercent: 90, resetsAt: at(500) })];
  assert.equal(holdUntil(need, readings, now), at(500));
  assert.equal(holdUntil({ ...need, windowMinutes: 10080 }, readings, now), at(500));
  const spending = [reading({ resetsAt: at(10) }), reading({ windowMinutes: 10080, usedPercent: 75, resetsAt: at(40), burnPercentPerHour: 100 })];
  assert.equal(holdUntil({ ...need, percent: 15 }, spending, now), at(40));
});

test("ties keep first need and first reading binding", () => {
  const readings = [reading({ meter: "first", usedPercent: 90 }), reading({ meter: "second", windowMinutes: 60, usedPercent: 90 })];
  assert.equal(canRun(need, readings, now).binding, "first");
  assert.equal(canRun([{ ...need, windowMinutes: 60 }, { ...need, windowMinutes: 300 }], readings, now).binding, "second");
});

test("invalid now throws, options clamp, future fetch is clock skew", () => {
  const readings = [reading({ usedPercent: 90 })];
  for (const call of [() => canRun(need, readings, new Date(NaN)), () => holdUntil(need, readings, new Date(NaN)), () => pace(readings, new Date(NaN)), () => paceState(readings[0], undefined, "x")]) assert.throws(call, TypeError);
  const conserve = [reading({ usedPercent: 75 })];
  assert.equal(holdUntil(need, [reading({ usedPercent: null })], now, { unknownRecheckMinutes: 0 }), at(1));
  assert.equal(holdUntil(need, [reading({ usedPercent: null })], now, { unknownRecheckMinutes: 1e15 }), at(1440));
  assert.equal(holdUntil({ ...need, percent: 90 }, conserve, now, { conserveHoldMinutes: 0 }), at(1));
  const skew = pace([reading({ fetchedAt: at(6) })], now);
  assert.deepEqual([skew.state, skew.reason], ["UNKNOWN", "clock skew"]);
  assert.equal(pace([reading({ fetchedAt: at(5) })], now).state, "NORMAL");
});
