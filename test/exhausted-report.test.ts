import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatMeters, main, vendorLimitEvidence } from "../src/cli.js";
import { defaultPolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function reading(used: number, reset: string | null, at = "2026-09-09T12:00:00Z"): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main",
    window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: reset,
    observed_at: at, fetched_at: at, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

async function openStore(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-exhausted-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("exhausted reports", () => {
  it("is superseded by the next fresh, below-limit binding-window reading with a new reset", async () => {
    const store = await openStore();
    try {
      store.insert(reading(91, "2026-09-09T13:00:00Z"));
      store.reportExhausted("codex-main:main", "2026-09-09T13:00:00Z", null, new Date("2026-09-09T12:05:00Z"));
      expect(store.dispatchBlockForMeter("codex-main:main", new Date("2026-09-09T12:06:00Z"))).toContain("limit reached");

      store.insert(reading(24, "2026-09-09T18:00:00Z", "2026-09-09T12:10:00Z"));

      expect(store.dispatchBlockForMeter("codex-main:main", new Date("2026-09-09T12:11:00Z"))).toBeUndefined();
      expect(store.latestPerWindow("codex-main:main")[0]).toMatchObject({ quantity: { used: 24 } });
      expect(store.events("2026-09-09T00:00:00Z")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "exhausted_cleared", origin: "vendor_reported" }),
      ]));
    } finally { store.close(); }
  });

  it("clears manually without leaving its synthetic 100% reading in the gate", async () => {
    const store = await openStore();
    try {
      store.insert(reading(42, "2026-09-09T13:00:00Z"));
      store.reportExhausted("codex-main:main", "2026-09-09T13:00:00Z", "mistaken report", new Date("2026-09-09T12:05:00Z"));
      expect(store.recoverExhausted("codex-main:main", "restored", new Date("2026-09-09T12:06:00Z"))).toBe(true);

      expect(store.dispatchBlockForMeter("codex-main:main", new Date("2026-09-09T12:07:00Z"))).toBeUndefined();
      expect(store.latestPerWindow("codex-main:main")[0]).toMatchObject({ quantity: { used: 42 } });
      expect(store.events("2026-09-09T00:00:00Z")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "exhausted_cleared", reason: "restored" }),
      ]));
    } finally { store.close(); }
  });

  it("exposes manual recovery through headroom report --recovered", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-exhausted-cli-"));
    temporary.push(root);
    const home = join(root, ".headroom");
    const seeded = await HeadroomStore.open(home);
    try { seeded.insert(reading(42, "2026-09-09T13:00:00Z")); }
    finally { seeded.close(); }
    await withHeadroomHome(home, async () => {
      expect(await main(["report", "--meter", "codex-main:main", "--exhausted"])).toBe(0);
      expect(await main(["report", "--meter", "codex-main:main", "--recovered", "--note", "fixed"])).toBe(0);
    });
    const checked = await HeadroomStore.open(home);
    try { expect(checked.dispatchBlockForMeter("codex-main:main")).toBeUndefined(); }
    finally { checked.close(); }
  });

  it("uses the binding reset, or a visible 24-hour fallback, for an unspecified report", async () => {
    const store = await openStore();
    try {
      store.insert(reading(42, "2026-09-09T13:00:00Z"));
      store.reportExhausted("codex-main:main", null, null, new Date("2026-09-09T12:05:00Z"));
      expect(store.latestPerWindow("codex-main:main")[0]).toMatchObject({ resets_at: "2026-09-09T13:00:00.000Z" });
      expect(store.dispatchBlockForMeter("codex-main:main", new Date("2026-09-09T13:01:00Z"))).toBeUndefined();
    } finally { store.close(); }

    const noReset = await openStore();
    try {
      const now = new Date("2026-09-09T12:05:00Z");
      noReset.insert(reading(42, null));
      noReset.reportExhausted("codex-main:main", null, null, now);
      const current = noReset.latestPerWindow("codex-main:main");
      expect(current[0]).toMatchObject({ resets_at: "2026-09-10T12:05:00.000Z" });
      expect(formatMeters(current, defaultPolicy, new Map(), new Map(), new Map(), now)[0]).not.toContain("↻?");
      expect(noReset.dispatchBlockForMeter("codex-main:main", new Date("2026-09-10T12:05:01Z"))).toBeUndefined();
    } finally { noReset.close(); }
  });
});

describe("run limit evidence", () => {
  it("never treats successful docs or echo output as exhaustion", () => {
    const docs = "Usage: run\nYou've hit your usage limit\n";
    expect(vendorLimitEvidence(0, docs, "")).toBeUndefined();
    expect(vendorLimitEvidence(0, "", docs)).toBeUndefined();
  });

  it("accepts stderr or a terminal failed-output message, but not an earlier stdout mention", () => {
    expect(vendorLimitEvidence(1, "", "You've hit your usage limit")).toContain("usage limit");
    expect(vendorLimitEvidence(1, "You've hit your usage limit\n" + Array.from({ length: 13 }, () => "normal output").join("\n"), "")).toBeUndefined();
    expect(vendorLimitEvidence(1, "normal output\nYou've hit your usage limit", "")).toContain("usage limit");
  });
});
