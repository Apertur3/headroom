/** latestPerWindow() reuses its slow unfiltered read until the observations change. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const reading = (used: number, at: string): Observation => ({
  principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
  quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: null, observed_at: at, fetched_at: at,
  source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
});

it("sees a new reading at once and hands out copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "headroom-latest-")); roots.push(root);
  const store = await HeadroomStore.open(join(root, ".headroom"));
  try {
    store.insert(reading(10, "2026-11-11T10:00:00.000Z"));
    expect(store.latestPerWindow()[0].quantity?.used).toBe(10);
    store.latestPerWindow()[0].quantity!.used = 99; // a caller mutating its copy
    expect(store.latestPerWindow()[0].quantity?.used).toBe(10);
    store.insert(reading(20, "2026-11-11T10:05:00.000Z"));
    expect(store.latestPerWindow()[0].quantity?.used).toBe(20);
  } finally { store.close(); }
});
