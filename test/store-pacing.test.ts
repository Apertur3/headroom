import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function open(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-pacing-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

function rolling(used: number, fetchedAt: string, resetsAt: string, overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}

describe("store.burnRateFor", () => {
  it("is null for a window with fewer than two fresh samples in the lookback", async () => {
    const store = await open();
    try {
      store.insert(rolling(10, "2026-09-03T12:00:00Z", "2026-09-03T17:00:00Z"));
      const current = store.latest("claude-main:all")!;
      const burn = store.burnRateFor([current], new Date("2026-09-03T12:00:00Z"));
      expect(burn.get("claude-main:all:300")).toEqual({ burn_percent_per_hour: null, empty_in_seconds: null });
    } finally { store.close(); }
  });

  it("computes the exact two-point slope and the projected time to empty", async () => {
    const store = await open();
    try {
      store.insert(rolling(10, "2026-09-03T11:00:00Z", "2026-09-03T17:00:00Z"));
      store.insert(rolling(70, "2026-09-03T12:00:00Z", "2026-09-03T17:00:00Z"));
      const current = store.latest("claude-main:all")!;
      const now = new Date("2026-09-03T12:00:00Z");
      const burn = store.burnRateFor([current], now).get("claude-main:all:300");
      expect(burn!.burn_percent_per_hour).toBeCloseTo(60, 6);
      expect(burn!.empty_in_seconds).toBeCloseTo((30 / 60) * 3600, 3);
    } finally { store.close(); }
  });

  it("excludes samples older than the lookback window", async () => {
    const store = await open();
    try {
      // 90 minutes before "now", outside a 60-minute lookback.
      store.insert(rolling(10, "2026-09-03T10:30:00Z", "2026-09-03T17:00:00Z"));
      store.insert(rolling(70, "2026-09-03T12:00:00Z", "2026-09-03T17:00:00Z"));
      const current = store.latest("claude-main:all")!;
      const now = new Date("2026-09-03T12:00:00Z");
      const burn = store.burnRateFor([current], now, 60).get("claude-main:all:300");
      expect(burn).toEqual({ burn_percent_per_hour: null, empty_in_seconds: null });
    } finally { store.close(); }
  });

  it("never treats a local pool or a credit count as a burn-rate window", async () => {
    const store = await open();
    try {
      const local: Observation = { principal_id: "workstation", meter_id: "workstation:capacity", window: { kind: "state", minutes: null, enforcement: "soft" }, quantity: { used: 1, limit: null, remaining: null, unit: "requests" }, resets_at: null, observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" };
      store.insert(local);
      const burn = store.burnRateFor([local], new Date("2026-09-03T12:00:00Z"));
      expect(burn.size).toBe(0);
    } finally { store.close(); }
  });

  // Issue #7: a lookback that spans a reset paired a near-full pre-reset
  // sample with a near-empty post-reset one and reported a wildly negative
  // burn ("-113%/h"). Samples must be cut off at the reset instead.
  it("cuts a burn-rate window off at its reset, reporting only the post-reset slope", async () => {
    const store = await open();
    try {
      // 90% used, then a weekly reset lands (resets_at jumps forward far more
      // than the 1h between polls), then usage climbs again post-reset.
      store.insert(rolling(90, "2026-09-03T11:00:00Z", "2026-09-03T17:00:00Z"));
      store.insert(rolling(10, "2026-09-03T12:00:00Z", "2026-09-04T19:00:00Z"));
      store.insert(rolling(30, "2026-09-03T12:30:00Z", "2026-09-04T19:00:00Z"));
      const current = store.latest("claude-main:all")!;
      const now = new Date("2026-09-03T12:30:00Z");
      const burn = store.burnRateFor([current], now, 120).get("claude-main:all:300");
      // Only the two post-reset samples (10% at 12:00, 30% at 12:30) count:
      // (30 - 10) / 0.5h = 40%/h, not a negative slope back to the 90% peak.
      expect(burn!.burn_percent_per_hour).toBeCloseTo(40, 6);
    } finally { store.close(); }
  });

  it("is null, not negative, with only one fresh sample since the reset", async () => {
    const store = await open();
    try {
      store.insert(rolling(90, "2026-09-03T11:00:00Z", "2026-09-03T17:00:00Z"));
      store.insert(rolling(10, "2026-09-03T12:00:00Z", "2026-09-04T19:00:00Z"));
      const current = store.latest("claude-main:all")!;
      const now = new Date("2026-09-03T12:00:00Z");
      const burn = store.burnRateFor([current], now, 120).get("claude-main:all:300");
      expect(burn).toEqual({ burn_percent_per_hour: null, empty_in_seconds: null });
    } finally { store.close(); }
  });

  it("clamps a small negative slope from rounding noise to 0, not a negative rate", async () => {
    const store = await open();
    try {
      // A whole-percent meter jittering down by 1 point between polls with no
      // reset anywhere near it (the drop is nowhere near the >50% threshold).
      store.insert(rolling(42, "2026-09-03T11:00:00Z", "2026-09-03T17:00:00Z"));
      store.insert(rolling(41, "2026-09-03T11:30:00Z", "2026-09-03T17:00:00Z"));
      const current = store.latest("claude-main:all")!;
      const now = new Date("2026-09-03T11:30:00Z");
      const burn = store.burnRateFor([current], now, 120).get("claude-main:all:300");
      expect(burn!.burn_percent_per_hour).toBe(0);
      expect(burn!.empty_in_seconds).toBeNull();
    } finally { store.close(); }
  });
});

describe("pace_projection_conserve event", () => {
  it("fires once an observation's own burn projects it emptying before its reset, throttled to once per window per hour", async () => {
    const store = await open();
    try {
      const resetsAt = "2026-09-03T14:00:00Z";
      // 60%/h burn: at that rate the window would be empty in 30 minutes,
      // well inside the 2 hours left until its real reset.
      store.insert(rolling(10, "2026-09-03T11:00:00Z", resetsAt));
      store.insert(rolling(70, "2026-09-03T12:00:00Z", resetsAt)); // <- first projection event
      // 5 minutes later, still burning fast: throttled, no second event.
      store.insert(rolling(75, "2026-09-03T12:05:00Z", resetsAt));

      const afterFirstHour = store.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "pace_projection_conserve");
      expect(afterFirstHour).toHaveLength(1);
      expect(afterFirstHour[0]).toMatchObject({ origin: "inferred", meter_id: "claude-main:all" });
      expect(afterFirstHour[0].reason).toMatch(/^burning \d+%\/h, empty in .+, reset in .+$/);

      // More than an hour after the first event: a fresh projection fires again.
      store.insert(rolling(89, "2026-09-03T13:01:00Z", resetsAt));
      const afterSecondHour = store.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "pace_projection_conserve");
      expect(afterSecondHour).toHaveLength(2);
    } finally { store.close(); }
  });

  it("does not fire for a straight-line CONSERVE that is not also a burn-rate projection", async () => {
    const store = await open();
    try {
      // Halfway through the window, usage behind the straight-line pace
      // enough to classify CONSERVE on its own (surplus < -0.10, and well
      // under the freeze reserve), but the burn (2%/h) is far too slow to
      // empty the window before its 2.5h-away reset -- this is the ordinary
      // "behind pace" rule, not a burn projection.
      store.insert(rolling(63, "2026-09-03T11:00:00Z", "2026-09-03T14:30:00Z"));
      store.insert(rolling(65, "2026-09-03T12:00:00Z", "2026-09-03T14:30:00Z"));
      expect(store.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "pace_projection_conserve")).toHaveLength(0);
    } finally { store.close(); }
  });
});

describe("action_class on leases", () => {
  it("is null by default and set when startLease is given one", async () => {
    const store = await open();
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      const plain = store.startLease("cadence", "codex-main:main", null, 60_000, null, now);
      const classed = store.startLease("cadence", "codex-main:main", null, 60_000, null, now, "review");
      expect(plain.action_class).toBeNull();
      expect(classed.action_class).toBe("review");
      const listed = store.leases(undefined, false, now);
      expect(listed.find((item) => item.id === plain.id)?.action_class).toBeNull();
      expect(listed.find((item) => item.id === classed.id)?.action_class).toBe("review");
    } finally { store.close(); }
  });
});

describe("store.learnedCost", () => {
  it("groups per-lease spent percent by action_class, reporting median, IQR and sample count", async () => {
    const store = await open();
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      // Three "review" leases on three different meters, each the sole
      // active lease on its own meter across one usage delta, so each
      // lease's attributed spend is exactly that delta with no splitting.
      const spend = (meterId: string, percentDelta: number, actionClass: string, at: Date) => {
        store.startLease("cadence", meterId, null, 3_600_000, null, at, actionClass);
        store.insert({ principal_id: "codex-main", meter_id: meterId, window: { kind: "fixed", minutes: 100, enforcement: "hard" }, quantity: { used: 0, limit: 100, remaining: 100, unit: "percent" }, resets_at: "2026-09-03T20:00:00Z", observed_at: at.toISOString(), fetched_at: at.toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" });
        store.insert({ principal_id: "codex-main", meter_id: meterId, window: { kind: "fixed", minutes: 100, enforcement: "hard" }, quantity: { used: percentDelta, limit: 100, remaining: 100 - percentDelta, unit: "percent" }, resets_at: "2026-09-03T20:00:00Z", observed_at: new Date(at.getTime() + 1000).toISOString(), fetched_at: new Date(at.getTime() + 1000).toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" });
      };
      spend("codex-main:one", 2, "review", now);
      spend("codex-main:two", 4, "review", new Date(now.getTime() + 2000));
      spend("codex-main:three", 4, "review", new Date(now.getTime() + 4000));
      // Past every lease's 1h ttl, so learnedCost's own expiry sweep has
      // ended all three before counting them -- see "keeps an in-progress
      // lease out of the statistics" below for the still-active case.
      const wellAfterExpiry = new Date(now.getTime() + 2 * 3_600_000);

      const learned = store.learnedCost("review", wellAfterExpiry);
      expect(learned).toHaveLength(1);
      expect(learned[0]).toMatchObject({ action_class: "review", sample_count: 3, median_percent: 4 });

      // A class with no leases at all is simply absent, not a zero-sample row.
      expect(store.learnedCost("nonexistent", wellAfterExpiry)).toEqual([]);
      // With no filter, every class with a sample is returned.
      expect(store.learnedCost(undefined, wellAfterExpiry).map((item) => item.action_class)).toEqual(["review"]);
    } finally { store.close(); }
  });

  it("counts an ended lease with no spend as a real zero-cost sample, not a missing one", async () => {
    const store = await open();
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      const lease = store.startLease("cadence", "codex-main:main", null, 60_000, null, now, "idle-check");
      store.endLease(lease.id, "cadence", false, new Date(now.getTime() + 1000));
      const learned = store.learnedCost("idle-check", new Date(now.getTime() + 2000));
      expect(learned).toEqual([expect.objectContaining({ action_class: "idle-check", sample_count: 1, median_percent: 0 })]);
    } finally { store.close(); }
  });

  it("keeps an in-progress lease out of the statistics until it ends or expires", async () => {
    const store = await open();
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      // Still well inside its 60s ttl: no spend has been observed yet, so
      // this must not look like a completed, genuinely free job.
      store.startLease("cadence", "codex-main:main", null, 60_000, null, now, "idle-check");
      expect(store.learnedCost("idle-check", new Date(now.getTime() + 1000))).toEqual([]);
      // Past the ttl, the same lease has expired (with no observed spend)
      // and now counts as one real zero-cost sample.
      expect(store.learnedCost("idle-check", new Date(now.getTime() + 61_000))).toEqual([expect.objectContaining({ action_class: "idle-check", sample_count: 1, median_percent: 0 })]);
    } finally { store.close(); }
  });
});

describe("store.learnedCostForMeter", () => {
  it("aggregates every ended lease on a meter regardless of action_class, but not an in-progress one", async () => {
    const store = await open();
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      store.startLease("cadence", "claude-main:all", null, 60_000, null, now, "review");
      store.startLease("cadence", "claude-main:all", null, 60_000, null, new Date(now.getTime() + 1000), "design-pass");
      const stillActive = new Date(now.getTime() + 2000);
      expect(store.learnedCostForMeter("claude-main:all", stillActive)?.sample_count).toBeUndefined();
      const pastExpiry = new Date(now.getTime() + 61_000);
      expect(store.learnedCostForMeter("claude-main:all", pastExpiry)?.sample_count).toBe(2);
      expect(store.learnedCostForMeter("no-such-meter", pastExpiry)).toBeUndefined();
    } finally { store.close(); }
  });
});
