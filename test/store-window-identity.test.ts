import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalWindowJson,
  HeadroomStore,
  sameSemanticWindow,
  windowSqlMatch,
} from "../src/store.js";
import type { Observation } from "../src/types.js";

// All observations, accounts, and workers in this file are synthetic fixtures.
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function open(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-window-identity-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: "claude-main",
    meter_id: "claude-main:all",
    window: { kind: "fixed", minutes: 300, enforcement: "hard" },
    quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" },
    resets_at: "2026-09-06T17:00:00Z",
    observed_at: "2026-09-06T12:00:00Z",
    fetched_at: "2026-09-06T12:00:00Z",
    source: "fixture",
    truth: "official",
    freshness: "fresh",
    confidence: 1,
    adapter_version: "fixture",
    upstream_schema_version: "fixture",
    ...overrides,
  };
}

describe("store window semantic identity (#49)", () => {
  it("attributes spend and ledger deltas correctly when window keys are reordered (issue #49 repro)", async () => {
    const store = await open();
    try {
      // window a and window b have identical semantic meaning but different key orders
      const windowA = { kind: "fixed" as const, minutes: 300, enforcement: "hard" as const };
      const windowB = { enforcement: "hard" as const, minutes: 300, kind: "fixed" as const };

      // 1. Insert 10% at 12:00 with window a
      store.insert(makeObservation({
        window: windowA,
        quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" },
        fetched_at: "2026-09-06T12:00:00Z",
        observed_at: "2026-09-06T12:00:00Z",
      }));

      // 2. Insert 20% at 12:01 with window b
      store.insert(makeObservation({
        window: windowB,
        quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" },
        fetched_at: "2026-09-06T12:01:00Z",
        observed_at: "2026-09-06T12:01:00Z",
      }));

      // 3. Insert 30% at 12:02 with window a
      store.insert(makeObservation({
        window: windowA,
        quantity: { used: 30, limit: 100, remaining: 70, unit: "percent" },
        fetched_at: "2026-09-06T12:02:00Z",
        observed_at: "2026-09-06T12:02:00Z",
      }));

      // 4. Start lease at 12:02:30
      store.startLease("worker-example", "claude-main:all", 20, 3_600_000, null, new Date("2026-09-06T12:02:30Z"));

      // 5. Insert 40% at 12:03 with window b
      store.insert(makeObservation({
        window: windowB,
        quantity: { used: 40, limit: 100, remaining: 60, unit: "percent" },
        fetched_at: "2026-09-06T12:03:00Z",
        observed_at: "2026-09-06T12:03:00Z",
      }));

      // Check lease.spent_percent: must be 10 (40 - 30), NOT 20 (40 - 20)
      const leases = store.leases("claude-main:all", false, new Date("2026-09-06T12:03:00Z"));
      expect(leases).toHaveLength(1);
      expect(leases[0].spent_percent).toBe(10);

      // Check spendLedgerRows: must report delta_percent of 10, NOT 20
      const ledger = store.spendLedgerRows({ meter: "claude-main:all" }).filter((row) => row.owner === "worker-example");
      expect(ledger).toHaveLength(1);
      expect(ledger[0].delta_percent).toBe(10);
      expect(ledger[0].from_at).toBe("2026-09-06T12:02:00Z");
      expect(ledger[0].to_at).toBe("2026-09-06T12:03:00Z");
      expect(ledger[0].owner).toBe("worker-example");
    } finally {
      store.close();
    }
  });

  it("matches pre-existing historical rows with raw arbitrary JSON key orders", async () => {
    const store = await open();
    try {
      // Simulate historical rows that were inserted prior to this fix with different key orders:
      const rawJson1 = JSON.stringify({ enforcement: "hard", minutes: 300, kind: "fixed" });
      const rawJson2 = JSON.stringify({ minutes: 300, kind: "fixed", enforcement: "hard" });

      const insertRaw = (windowJson: string, used: number, fetchedAt: string) => {
        store.db.prepare(`INSERT INTO observations
          (principal_id, meter_id, window_json, quantity_json, resets_at, observed_at, fetched_at, source, truth, freshness, confidence, adapter_version, upstream_schema_version, reason, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "claude-main",
          "claude-main:all",
          windowJson,
          JSON.stringify({ used, limit: 100, remaining: 100 - used, unit: "percent" }),
          "2026-09-06T17:00:00Z",
          fetchedAt,
          fetchedAt,
          "native:claude",
          "official",
          "fresh",
          1,
          "v1",
          "v1",
          null,
          null
        );
      };

      insertRaw(rawJson1, 15, "2026-09-06T11:00:00Z");
      insertRaw(rawJson2, 25, "2026-09-06T11:30:00Z");

      // 1. lastKnownFor: query using standard window object
      const lastKnown = store.lastKnownFor([{
        meter_id: "claude-main:all",
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
      }], new Date("2026-09-06T12:00:00Z"));

      const reading = lastKnown.get("claude-main:all:300");
      expect(reading).toBeDefined();
      expect(reading?.used_percent).toBe(25);
      expect(reading?.observed_at).toBe("2026-09-06T11:30:00Z");

      // 2. New insert should find the latest raw row (25%) as baseline and previous
      store.startLease("worker-1", "claude-main:all", 10, 3_600_000, null, new Date("2026-09-06T11:35:00Z"));
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
        quantity: { used: 35, limit: 100, remaining: 65, unit: "percent" },
        fetched_at: "2026-09-06T11:40:00Z",
        observed_at: "2026-09-06T11:40:00Z",
      }));

      const leases = store.leases("claude-main:all", false, new Date("2026-09-06T11:40:00Z"));
      expect(leases[0].spent_percent).toBe(10); // 35 - 25

      const ledger = store.spendLedgerRows({ meter: "claude-main:all" });
      expect(ledger[0].delta_percent).toBe(10); // 35 - 25
      expect(ledger[0].from_at).toBe("2026-09-06T11:30:00Z");
    } finally {
      store.close();
    }
  });

  it("keeps different durations, enforcements, and kinds strictly separate", async () => {
    const store = await open();
    try {
      // Insert a 300m hard fixed window
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
        quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" },
        fetched_at: "2026-09-06T12:00:00Z",
      }));

      // Insert a 10080m (weekly) hard fixed window
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 10080, enforcement: "hard" },
        quantity: { used: 50, limit: 100, remaining: 50, unit: "percent" },
        fetched_at: "2026-09-06T12:01:00Z",
      }));

      // Insert a 300m soft fixed window
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 300, enforcement: "soft" },
        quantity: { used: 70, limit: 100, remaining: 30, unit: "percent" },
        fetched_at: "2026-09-06T12:02:00Z",
      }));

      // Insert a 300m hard rolling window
      store.insert(makeObservation({
        window: { kind: "rolling", minutes: 300, enforcement: "hard" },
        quantity: { used: 85, limit: 100, remaining: 15, unit: "percent" },
        fetched_at: "2026-09-06T12:03:00Z",
      }));

      // Now insert a second reading for the 300m hard fixed window
      store.startLease("worker-2", "claude-main:all", 10, 3_600_000, null, new Date("2026-09-06T12:04:00Z"));
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
        quantity: { used: 30, limit: 100, remaining: 70, unit: "percent" },
        fetched_at: "2026-09-06T12:05:00Z",
      }));

      // Lease spend and ledger delta should be against the 20% reading (delta = 10),
      // NOT against 50% (weekly), 70% (soft), or 85% (rolling)!
      const leases = store.leases("claude-main:all", false, new Date("2026-09-06T12:05:00Z"));
      expect(leases[0].spent_percent).toBe(10); // 30 - 20

      const ledger = store.spendLedgerRows({ meter: "claude-main:all" });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].delta_percent).toBe(10);
      expect(ledger[0].from_at).toBe("2026-09-06T12:00:00Z");

      // lastKnownFor for rolling 300m should return 85%, not 30% or 70%
      const lastKnownRolling = store.lastKnownFor([{
        meter_id: "claude-main:all",
        window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      }], new Date("2026-09-06T12:10:00Z"));
      expect(lastKnownRolling.get("claude-main:all:300")?.used_percent).toBe(85);
    } finally {
      store.close();
    }
  });

  it("deduplicates reset_seen events across reordered window key orders", async () => {
    const store = await open();
    try {
      const windowA = { kind: "fixed" as const, minutes: 300, enforcement: "hard" as const };
      const windowB = { enforcement: "hard" as const, minutes: 300, kind: "fixed" as const };

      // Reading before reset: high usage (90%)
      store.insert(makeObservation({
        window: windowA,
        quantity: { used: 90, limit: 100, remaining: 10, unit: "percent" },
        resets_at: "2026-09-06T17:00:00Z",
        fetched_at: "2026-09-06T16:55:00Z",
      }));

      // Reading after reset with reordered window: usage dropped to 5%
      store.insert(makeObservation({
        window: windowB,
        quantity: { used: 5, limit: 100, remaining: 95, unit: "percent" },
        resets_at: "2026-09-06T22:00:00Z",
        fetched_at: "2026-09-06T17:05:00Z",
      }));

      const resetEvents = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "reset_seen");
      expect(resetEvents).toHaveLength(1);
      expect(Date.parse(resetEvents[0].created_at)).toBe(Date.parse("2026-09-06T17:00:00Z"));

      // Subsequent reading with window A for same scheduled reset should not duplicate reset_seen
      store.insert(makeObservation({
        window: windowA,
        quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" },
        resets_at: "2026-09-06T22:00:00Z",
        fetched_at: "2026-09-06T17:10:00Z",
      }));

      const resetEventsAfter = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "reset_seen");
      expect(resetEventsAfter).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("detects failed gap between readings with alternating window key order", async () => {
    const store = await open();
    try {
      const windowA = { kind: "fixed" as const, minutes: 300, enforcement: "hard" as const };
      const windowB = { enforcement: "hard" as const, minutes: 300, kind: "fixed" as const };

      // 1. Reading before failure
      store.insert(makeObservation({
        window: windowA,
        quantity: { used: 80, limit: 100, remaining: 20, unit: "percent" },
        resets_at: "2026-09-06T17:00:00Z",
        fetched_at: "2026-09-06T16:50:00Z",
      }));

      // 2. Failed reading with window B
      store.insert(makeObservation({
        window: windowB,
        quantity: null,
        freshness: "failed",
        reason: "upstream timeout",
        resets_at: "2026-09-06T17:00:00Z",
        fetched_at: "2026-09-06T17:05:00Z",
      }));

      // 3. Fresh reading after recovery with window A: reset occurred during gap
      store.insert(makeObservation({
        window: windowA,
        quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" },
        resets_at: "2026-09-06T22:00:00Z",
        fetched_at: "2026-09-06T17:15:00Z",
      }));

      // classifyUsageDrop recognizes the gap and emits reset_seen at the scheduled reset time
      const resetEvents = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "reset_seen");
      expect(resetEvents).toHaveLength(1);
      expect(Date.parse(resetEvents[0].created_at)).toBe(Date.parse("2026-09-06T17:00:00Z"));
    } finally {
      store.close();
    }
  });

  it("preserves windowless failure handling and recovery without mixing with windowed failures", async () => {
    const store = await open();
    try {
      // 1. Windowless failure (transport/keychain failure for the whole meter)
      store.insert(makeObservation({
        window: null,
        quantity: null,
        freshness: "failed",
        reason: "Keychain grant needed; run: headroom keychain grant --principal claude-main",
        fetched_at: "2026-09-06T12:00:00Z",
      }));

      let failedEvents = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "source_failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].last_seen_at).toBe("2026-09-06T12:00:00Z");

      // 2. Repeated windowless failure advances last_seen_at without creating a duplicate event
      store.insert(makeObservation({
        window: null,
        quantity: null,
        freshness: "failed",
        reason: "Keychain grant needed; run: headroom keychain grant --principal claude-main",
        fetched_at: "2026-09-06T12:05:00Z",
      }));

      failedEvents = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "source_failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].last_seen_at).toBe("2026-09-06T12:05:00Z");

      // 3. A fresh windowed reading recovers the windowless failure
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
        quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" },
        freshness: "fresh",
        fetched_at: "2026-09-06T12:10:00Z",
      }));

      const recoveredEvents = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "source_recovered");
      expect(recoveredEvents).toHaveLength(1);

      // 4. A windowed failure opens its own windowed event, separate from windowless
      store.insert(makeObservation({
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
        quantity: null,
        freshness: "failed",
        reason: "API rate limit exceeded",
        fetched_at: "2026-09-06T12:15:00Z",
      }));

      const allFailures = store.events("2026-09-06T00:00:00Z").filter((e) => e.kind === "source_failed");
      expect(allFailures).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("verifies semantic window helpers handle order, normalization, and SQL matching", () => {
    const w1 = { kind: "fixed" as const, minutes: 300, enforcement: "hard" as const };
    const w2 = { enforcement: "hard" as const, minutes: 300, kind: "fixed" as const };
    const w3 = { kind: "rolling" as const, minutes: 300, enforcement: "hard" as const };

    expect(sameSemanticWindow(w1, w2)).toBe(true);
    expect(sameSemanticWindow(w1, w3)).toBe(false);
    expect(sameSemanticWindow(null, null)).toBe(true);
    expect(sameSemanticWindow(w1, null)).toBe(false);

    expect(canonicalWindowJson(w1)).toBe(canonicalWindowJson(w2));
    expect(canonicalWindowJson(null)).toBeNull();

    const sqlMatch = windowSqlMatch(w1);
    expect(sqlMatch.sql).toContain("json_extract(window_json, '$.kind') = ?");
    expect(sqlMatch.params).toEqual(["fixed", 300, "hard"]);

    const nullMatch = windowSqlMatch(null);
    expect(nullMatch.sql).toBe("(window_json IS NULL OR window_json = 'null')");
    expect(nullMatch.params).toEqual([]);
  });
});
