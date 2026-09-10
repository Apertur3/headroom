import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventText } from "../src/notify-format.js";
import { defaultPolicy } from "../src/policy.js";
import { formatMeters } from "../src/status-view.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function weekly(used: number, fetchedAt: string, resetsAt: string, metadata?: Observation["metadata"]): Observation {
  return window(10_080, used, fetchedAt, resetsAt, metadata);
}

function window(minutes: number, used: number, fetchedAt: string, resetsAt: string | null, metadata?: Observation["metadata"]): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", metadata,
  };
}

async function open(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-vendor-window-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

describe("vendor window consistency hold (issue #29)", () => {
  it("holds the reported 25% → 88% → 25% flip-flop, records no reset, and notifies once", async () => {
    const store = await open();
    try {
      store.insert(weekly(25, "2026-09-09T16:00:00Z", "2026-09-15T12:00:00Z"));
      store.insert(weekly(88, "2026-09-09T16:45:00Z", "2026-09-10T12:00:00Z"));
      const held = store.latestPerWindow("codex-main:main")[0]!;
      expect(held).toMatchObject({ quantity: { used: 25 }, resets_at: "2026-09-15T12:00:00Z", metadata: { vendor_window_held: true } });
      expect(formatMeters([held], defaultPolicy)[0]).toContain("new window unconfirmed, holding");
      expect(formatMeters([held], defaultPolicy)[0]).not.toContain("vendor readings inconsistent");

      store.insert(weekly(25, "2026-09-09T17:45:00Z", "2026-09-15T12:00:00Z"));
      expect(formatMeters(store.latestPerWindow("codex-main:main"), defaultPolicy)[0]).toContain("vendor readings inconsistent, holding");
      const events = store.events("2026-09-09T00:00:00Z");
      expect(events.filter((event) => event.kind === "reset_seen" || event.kind === "free_reset_granted" || event.kind === "free_reset_used")).toHaveLength(0);
      const inconsistent = events.filter((event) => event.kind === "vendor_inconsistent");
      expect(inconsistent).toHaveLength(1);
      expect(eventText(inconsistent[0], store.eventObservations(inconsistent).get(inconsistent[0].id))).toBe("⚠️ Codex main weekly readings flip-flopped between two windows; holding the earlier one");
      expect(store.history("codex-main:main", "2026-09-09T00:00:00Z").slice(-2).every((row) => row.metadata?.vendor_inconsistent)).toBe(true);
    } finally { store.close(); }
  });

  it("accepts a genuine reset on the second matching poll and timestamps it at the first", async () => {
    const store = await open();
    try {
      store.insert(weekly(25, "2026-09-09T16:00:00Z", "2026-09-10T12:00:00Z"));
      store.insert(weekly(0, "2026-09-09T16:45:00Z", "2026-09-15T12:00:00Z"));
      store.close();
      const restarted = await HeadroomStore.open(temporary.at(-1)! + "/.headroom");
      try {
        restarted.insert(weekly(1, "2026-09-09T17:45:00Z", "2026-09-15T12:00:00Z"));
        expect(restarted.events("2026-09-09T00:00:00Z").filter((event) => event.kind === "reset_seen")).toEqual([
          expect.objectContaining({ created_at: "2026-09-09T16:45:00Z" }),
        ]);
      } finally { restarted.close(); }
    } finally { /* first connection was intentionally closed before restart */ }
  });

  it.each([
    ["5h", 300, "2026-09-10T12:00:00Z", "2026-09-10T17:00:00Z"],
    ["weekly", 10_080, "2026-09-15T12:00:00Z", "2026-09-22T12:00:00Z"],
  ])("accepts a scheduled %s rollover immediately", async (_name, minutes, resetAt, nextResetAt) => {
    const store = await open();
    try {
      const before = new Date(Date.parse(resetAt) - 60 * 60_000).toISOString();
      const after = new Date(Date.parse(resetAt) + 3 * 60_000).toISOString();
      store.insert(window(minutes, 60, before, resetAt));
      store.insert(window(minutes, 2, after, nextResetAt));

      const current = store.latestPerWindow("codex-main:main")[0]!;
      expect(current).toMatchObject({ quantity: { used: 2 }, resets_at: nextResetAt });
      expect(current.metadata?.vendor_window_held).toBeUndefined();
      expect(current.metadata?.vendor_inconsistent).toBeUndefined();
      expect(store.events("2026-09-01T00:00:00Z").filter((event) => event.kind === "reset_seen")).toEqual([
        expect.objectContaining({ created_at: resetAt, metadata: { window_minutes: minutes } }),
      ]);
      expect(store.events("2026-09-01T00:00:00Z").filter((event) => event.kind === "vendor_inconsistent")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("accepts a new identity immediately when the previous reset was unknown", async () => {
    const store = await open();
    try {
      store.insert(window(300, 60, "2026-09-10T11:00:00Z", null));
      store.insert(window(300, 2, "2026-09-10T11:03:00Z", "2026-09-10T16:00:00Z"));
      const current = store.latestPerWindow("codex-main:main")[0]!;
      expect(current).toMatchObject({ quantity: { used: 2 }, resets_at: "2026-09-10T16:00:00Z" });
      expect(current.metadata?.vendor_window_held).toBeUndefined();
      expect(store.events("2026-09-01T00:00:00Z").filter((event) => event.kind === "vendor_inconsistent")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("excludes flagged raw rows from burn-rate samples", async () => {
    const store = await open();
    try {
      store.insert(weekly(10, "2026-09-09T11:00:00Z", "2026-09-15T12:00:00Z"));
      store.insert(weekly(11, "2026-09-09T11:30:00Z", "2026-09-15T12:00:00Z"));
      store.insert(weekly(70, "2026-09-09T12:00:00Z", "2026-09-15T12:00:00Z", { vendor_inconsistent: true }));
      const current = store.latest("codex-main:main")!;
      const burn = store.burnRateFor([current], new Date("2026-09-09T12:00:00Z"), 120).get("codex-main:main:10080");
      expect(burn?.burn_percent_per_hour).toBeCloseTo(2, 6);
    } finally { store.close(); }
  });
});
