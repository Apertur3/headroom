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
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
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
      expect(held).toMatchObject({ quantity: { used: 25 }, resets_at: "2026-09-15T12:00:00Z", metadata: { vendor_inconsistent: true } });
      expect(formatMeters([held], defaultPolicy)[0]).toContain("vendor readings inconsistent, holding");

      store.insert(weekly(25, "2026-09-09T17:45:00Z", "2026-09-15T12:00:00Z"));
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
