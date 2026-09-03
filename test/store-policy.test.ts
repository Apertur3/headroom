import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canConsume, defaultPolicy, paceDecision, paceState } from "../src/policy.js";
import { TallyStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function observation(overrides: Partial<Observation> = {}): Observation {
  const now = new Date("2026-09-03T12:00:00Z");
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes: 100, enforcement: "hard" },
    quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-03T13:00:00Z",
    observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}

describe("SQLite observations and event detector", () => {
  it("allows two live connections to share a WAL database", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-store-wal-")); temporary.push(root);
    const home = join(root, ".tally");
    const [first, second] = await Promise.all([TallyStore.open(home), TallyStore.open(home)]);
    try {
      const db = (first as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> | undefined } } }).db;
      expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
      first.insert(observation({ meter_id: "codex-main:first" }));
      second.insert(observation({ meter_id: "codex-main:second" }));
      expect(first.latest("codex-main:second")).toMatchObject({ meter_id: "codex-main:second" });
    } finally { first.close(); second.close(); }
  });

  it("records reset confidences, vendor reset use, and source recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-store-")); temporary.push(root);
    const store = await TallyStore.open(join(root, ".tally"));
    try {
      store.insert(observation({ quantity: { used: 80, limit: 100, remaining: 20, unit: "percent" }, metadata: { free_resets_available: 1 } }));
      store.insert(observation({ quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, metadata: { free_resets_available: 0 } }));
      store.insert(observation({ quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: "2026-09-03T15:00:00Z", metadata: { free_resets_available: 0 } }));
      store.insert(observation({ freshness: "failed", quantity: null, reason: "fixture outage" }));
      store.insert(observation({ quantity: { used: 11, limit: 100, remaining: 89, unit: "percent" }, metadata: { free_resets_available: 0 } }));
      const events = store.events("2026-09-03T00:00:00Z");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "reset_seen", origin: "inferred", confidence: 0.5 }),
        expect.objectContaining({ kind: "reset_seen", origin: "inferred", confidence: 0.9 }),
        expect.objectContaining({ kind: "free_reset_used", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "source_failed" }),
        expect.objectContaining({ kind: "source_recovered" }),
      ]));
      expect(store.history("codex-main:main", "2026-09-03T00:00:00Z")).toHaveLength(5);
    } finally { store.close(); }
  });
});

describe("pace and consumes", () => {
  const policy = { ...defaultPolicy, freeze_reserve_pct: 10, staleness_minutes: 15 };
  const now = new Date("2026-09-03T12:00:00Z");
  function paced(used: number, extra: Partial<Observation> = {}): Observation {
    return observation({ quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, fetched_at: now.toISOString(), observed_at: now.toISOString(), resets_at: "2026-09-03T12:50:00Z", ...extra });
  }

  it("implements all pace states and blocks an action on a frozen scoped meter", () => {
    expect(paceState(paced(10), policy, now)).toBe("HARVEST");
    expect(paceState(paced(50), policy, now)).toBe("NORMAL");
    expect(paceState(paced(70), policy, now)).toBe("CONSERVE");
    const frozen = paced(95, { meter_id: "claude-main:fable" });
    expect(paceState(frozen, policy, now)).toBe("FREEZE");
    expect(paceState(paced(10, { freshness: "stale" }), policy, now)).toBe("UNKNOWN");
    const parent = paced(10, { meter_id: "claude-main:all" });
    expect(canConsume([parent.meter_id, frozen.meter_id], new Map([[parent.meter_id, parent], [frozen.meter_id, frozen]]), policy, false, now)).toMatchObject({ allowed: false, meter: "claude-main:fable", state: "FREEZE", reason: "reserve reached", meters: [expect.objectContaining({ meter: "claude-main:all" }), expect.objectContaining({ meter: "claude-main:fable", state: "FREEZE" })] });
  });

  it("holds pace at NORMAL for the early grace period unless frozen", () => {
    const early = paced(70, { resets_at: "2026-09-03T13:35:00Z" }); // 5% into a 100-minute window
    const later = paced(70, { resets_at: "2026-09-03T13:25:00Z" }); // 15% elapsed
    expect(paceDecision(early, policy, now)).toEqual({ state: "NORMAL", reason: "grace period" });
    expect(paceState(later, policy, now)).toBe("CONSERVE");
    expect(paceState(paced(95, { resets_at: "2026-09-03T13:35:00Z" }), policy, now)).toBe("FREEZE");
  });
});
