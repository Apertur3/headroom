import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observationsFromCodexUsage } from "../src/adapters/codex.js";
import { paceDecision } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation, ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const account: ProviderAccount = { name: "codex-main", vendor: "codex", adapter: "native-ts", location: "/synthetic/codex" };

function weekly(used: number, fetchedAt: string, resetsAt: string): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "native:codex", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "synthetic", upstream_schema_version: "synthetic",
  };
}

function idleWeekly(at: string): Observation {
  const reset = new Date(Date.parse(at) + 10_080 * 60_000);
  const rows = observationsFromCodexUsage({ rate_limit: {
    primary: { used_percent: 0, window_minutes: 300, resets_at: Math.floor((Date.parse(at) + 300 * 60_000) / 1000) },
    secondary: { used_percent: 0, window_minutes: 10_080, resets_at: Math.floor(reset.getTime() / 1000) },
  } }, {}, account, new Date(at));
  return rows.find((row) => row.meter_id === "codex-main:main" && row.window?.minutes === 10_080)!;
}

describe("Codex moving idle windows (issue #50)", () => {
  it("keeps moving idle resets usable after one scheduled rollover and confirms later real usage normally", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      // Synthetic reproduction of the weekly boundary followed by endpoint-idle polls.
      store.insert(weekly(100, "2026-09-19T08:09:00Z", "2026-09-19T08:09:52Z"));
      const firstIdle = idleWeekly("2026-09-19T08:14:35.881Z");
      expect(firstIdle.metadata).toMatchObject({ codex_idle_window: true });
      store.insert(firstIdle);
      store.insert(idleWeekly("2026-09-19T08:20:00.000Z"));
      store.insert(idleWeekly("2026-09-19T08:30:00.000Z"));

      const idle = store.latestPerWindow("codex-main:main").find((row) => row.window?.minutes === 10_080)!;
      expect(idle).toMatchObject({ quantity: { used: 0 }, metadata: { codex_idle_window: true } });
      expect(idle.metadata?.vendor_window_held).toBeUndefined();
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen")).toEqual([
        expect.objectContaining({ created_at: "2026-09-19T08:09:52Z" }),
      ]);

      // Once actual use returns, its reset anchor is checked against idle time.
      const stableReset = "2026-09-26T09:05:02Z";
      store.insert(weekly(12, "2026-09-19T09:05:02Z", stableReset));
      // The reset anchor is the real-use start, bounded between the last idle
      // poll and this one, so it can replace the moving idle identity at once.
      expect(store.latestPerWindow("codex-main:main")[0]).toMatchObject({ quantity: { used: 12 }, resets_at: stableReset });
      store.insert(weekly(15, "2026-09-19T09:14:00Z", stableReset));
      expect(store.latestPerWindow("codex-main:main")[0]).toMatchObject({ quantity: { used: 15 }, resets_at: stableReset });
      expect(store.latestPerWindow("codex-main:main")[0]?.metadata?.vendor_window_held).toBeUndefined();
    } finally { store.close(); }
  });

  it("clears a persisted suspect when a marked idle window arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-suspect-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(weekly(40, "2026-09-19T08:00:00Z", "2026-09-19T08:01:00Z"));
      store.insert(idleWeekly("2026-09-19T08:05:00Z"));
      store.insert(weekly(12, "2026-09-19T08:10:00Z", "2026-09-26T09:05:02Z"));
      store.insert(idleWeekly("2026-09-19T08:15:00Z"));
      // The earlier real-use suspect cannot survive a return to the already
      // accepted idle shape and turn a later poll into a false flip-flop.
      store.insert(idleWeekly("2026-09-19T08:20:00Z"));
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "vendor_inconsistent")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("holds a one-off idle-shaped zero before a nonzero window is due", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-premature-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(weekly(70, "2026-09-19T08:00:00Z", "2026-09-19T12:00:00Z"));
      store.insert(idleWeekly("2026-09-19T08:05:00Z"));
      const held = store.latestPerWindow("codex-main:main")[0]!;
      // Read-side selection keeps the accepted 70% baseline; the raw zero is
      // recorded as the held candidate and cannot create capacity by itself.
      expect(held.quantity?.used).toBe(70);
      expect(store.history("codex-main:main", "2026-09-19T00:00:00Z").at(-1)).toMatchObject({ quantity: { used: 0 }, metadata: { vendor_window_held: true, codex_idle_window: true } });
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("confirms a surprise reset from two moving idle polls and timestamps it at the first", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-unscheduled-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(weekly(70, "2026-09-19T08:00:00Z", "2026-09-19T12:00:00Z"));
      store.insert(idleWeekly("2026-09-19T08:05:00Z"));
      // The old identity returning after one idle poll is still the existing
      // flip path; a second moving idle poll is the required confirmation.
      store.insert(weekly(70, "2026-09-19T08:06:00Z", "2026-09-19T12:00:00Z"));
      store.insert(idleWeekly("2026-09-19T08:07:00Z"));
      store.insert(idleWeekly("2026-09-19T08:12:00Z"));
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen")).toEqual([
        expect.objectContaining({ created_at: "2026-09-19T08:07:00.000Z", metadata: expect.objectContaining({ unscheduled: true }) }),
      ]);
      expect(store.latestPerWindow("codex-main:main")[0]?.quantity?.used).toBe(0);
    } finally { store.close(); }
  });

  it("does not treat duplicate or out-of-order idle rows as confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-order-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(weekly(90, "2026-09-19T08:00:00Z", "2026-09-19T12:00:00Z"));
      const first = idleWeekly("2026-09-19T08:05:00Z");
      store.insert(first);
      store.insert(first);
      store.insert({ ...idleWeekly("2026-09-19T08:04:00Z"), fetched_at: "2026-09-19T08:04:00Z", observed_at: "2026-09-19T08:04:00Z" });
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen")).toHaveLength(0);
      expect(store.latestPerWindow("codex-main:main")[0]?.quantity?.used).toBe(90);
      store.insert(idleWeekly("2026-09-19T08:10:00Z"));
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen")).toHaveLength(1);
      expect(store.latestPerWindow("codex-main:main")[0]?.quantity?.used).toBe(0);
    } finally { store.close(); }
  });

  it("rejects stale, wrong-source, and malformed idle markers at the store boundary", async () => {
    for (const variant of [
      { source: "fixture" },
      { freshness: "stale" as const },
      { quantity: { used: -1, limit: 100, remaining: 101, unit: "percent" as const } },
    ]) {
      const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-boundary-")); temporary.push(root);
      const store = await HeadroomStore.open(join(root, ".headroom"));
      try {
        store.insert(weekly(80, "2026-09-19T08:00:00Z", "2026-09-19T12:00:00Z"));
        store.insert({ ...idleWeekly("2026-09-19T08:05:00Z"), ...variant });
        expect(store.latestPerWindow("codex-main:main")[0]?.quantity?.used).toBe(80);
      } finally { store.close(); }
    }
  });

  it("accepts a delayed native idle response within 90 seconds, but not beyond it", () => {
    const at = "2026-09-19T08:00:00.000Z";
    const usage = (offsetSeconds: number) => ({ rate_limit: {
      primary: { used_percent: 0, window_minutes: 300, resets_at: Math.floor((Date.parse(at) + 300 * 60_000 + offsetSeconds * 1_000) / 1000) },
      secondary: { used_percent: 0, window_minutes: 10_080, resets_at: Math.floor((Date.parse(at) + 10_080 * 60_000 + offsetSeconds * 1_000) / 1000) },
    } });
    const marked = observationsFromCodexUsage(usage(60), {}, account, new Date(at));
    const beyond = observationsFromCodexUsage(usage(91), {}, account, new Date(at));
    expect(marked.every((row) => row.metadata?.codex_idle_window)).toBe(true);
    expect(beyond.some((row) => row.metadata?.codex_idle_window)).toBe(false);
  });

  it("recovers old untagged native idle history when a tagged idle poll arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-upgrade-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(weekly(100, "2026-09-19T08:00:00Z", "2026-09-19T08:01:00Z"));
      store.insert(weekly(0, "2026-09-19T08:05:00Z", "2026-09-26T08:05:00Z"));
      store.insert(weekly(0, "2026-09-19T08:10:00Z", "2026-09-26T08:10:00Z"));
      const before = store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen");
      store.insert(idleWeekly("2026-09-19T08:15:00Z"));
      const current = store.latestPerWindow("codex-main:main")[0]!;
      expect(current).toMatchObject({ quantity: { used: 0 }, metadata: { codex_idle_window: true } });
      expect(current.metadata?.vendor_window_held).toBeUndefined();
      expect(store.events("2026-09-19T00:00:00Z").filter((event) => event.kind === "reset_seen")).toHaveLength(before.length);
      expect(store.history("codex-main:main", "2026-09-19T00:00:00Z").slice(0, 3).every((row) => !row.metadata?.codex_idle_window)).toBe(true);
    } finally { store.close(); }
  });

  it("does not make an omitted stale Spark window available from fresh main idle data", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-idle-spark-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const staleSpark = { ...weekly(20, "2026-09-17T08:00:00Z", "2026-09-24T08:00:00Z"), meter_id: "codex-main:spark", freshness: "stale" as const, reason: "synthetic stale Spark endpoint evidence" };
      store.insert(staleSpark);
      const at = "2026-09-19T08:20:00Z";
      const mainRows = observationsFromCodexUsage({ rate_limit: {
        primary: { used_percent: 0, window_minutes: 300, resets_at: Math.floor((Date.parse(at) + 300 * 60_000) / 1000) },
        secondary: { used_percent: 0, window_minutes: 10_080, resets_at: Math.floor((Date.parse(at) + 10_080 * 60_000) / 1000) },
      } }, {}, account, new Date(at));
      store.insertPoll(mainRows);
      const spark = store.latestPerWindow("codex-main:spark")[0]!;
      expect(spark.freshness).toBe("stale");
      expect(paceDecision(spark, undefined, new Date(at))).toMatchObject({ state: "UNKNOWN" });
    } finally { store.close(); }
  });
});
