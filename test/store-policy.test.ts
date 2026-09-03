import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canConsume, defaultPolicy, paceDecision, paceState } from "../src/policy.js";
import { TallyStore } from "../src/store.js";
import { formatMeters, thresholdReport } from "../src/cli.js";
import { AVAILABILITY_ONLY_REASON } from "../src/engine/observation.js";
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
      const credit = (remaining: number) => observation({ meter_id: "codex-main:credits", window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining, unit: "credits" } });
      store.insert(credit(1));
      store.insert(credit(0));
      store.insert(credit(2));
      store.insert(observation({ quantity: { used: 80, limit: 100, remaining: 20, unit: "percent" } }));
      store.insert(observation({ quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" } }));
      store.insert(observation({ quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: "2026-09-03T15:00:00Z", metadata: { free_resets_available: 0 } }));
      store.insert(observation({ freshness: "failed", quantity: null, reason: "fixture outage" }));
      store.insert(observation({ quantity: { used: 11, limit: 100, remaining: 89, unit: "percent" }, metadata: { free_resets_available: 0 } }));
      const events = store.events("2026-09-03T00:00:00Z");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "reset_seen", origin: "inferred", confidence: 0.5 }),
        expect.objectContaining({ kind: "reset_seen", origin: "inferred", confidence: 0.9 }),
        expect.objectContaining({ kind: "free_reset_used", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "free_reset_granted", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "credits_changed", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "source_failed" }),
        expect.objectContaining({ kind: "source_recovered" }),
      ]));
      expect(store.history("codex-main:main", "2026-09-03T00:00:00Z")).toHaveLength(5);
    } finally { store.close(); }
  });

  it("returns only the latest fetched observation for each meter window", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-store-latest-")); temporary.push(root);
    const store = await TallyStore.open(join(root, ".tally"));
    try {
      store.insert(observation({ fetched_at: "2026-09-03T12:00:00Z", quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" } }));
      store.insert(observation({ fetched_at: "2026-09-03T12:02:00Z", quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" } }));
      // Arrival order can differ from the upstream fetch order; history keeps it,
      // whereas current status must not let it replace the 12:02 reading.
      store.insert(observation({ fetched_at: "2026-09-03T12:01:00Z", quantity: { used: 30, limit: 100, remaining: 70, unit: "percent" } }));
      expect(store.history("codex-main:main", "2026-09-03T00:00:00Z")).toHaveLength(3);
      expect(store.latestPerWindow()).toEqual([expect.objectContaining({ meter_id: "codex-main:main", fetched_at: "2026-09-03T12:02:00Z", quantity: expect.objectContaining({ used: 20 }) })]);
    } finally { store.close(); }
  });

  it("does not display an older failed read beside a newer scoped window", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-store-failure-")); temporary.push(root);
    const store = await TallyStore.open(join(root, ".tally"));
    try {
      store.insert(observation({ meter_id: "claude-main:fable", window: null, quantity: null, freshness: "failed", reason: "Claude OAuth usage unavailable", fetched_at: "2026-09-03T12:00:00Z" }));
      store.insert(observation({ meter_id: "claude-main:fable", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "not_enforced", reason: "no scoped limit in response", fetched_at: "2026-09-03T12:01:00Z" }));
      expect(store.latestPerWindow("claude-main:fable")).toEqual([expect.objectContaining({ freshness: "not_enforced", reason: "no scoped limit in response" })]);
    } finally { store.close(); }
  });

  it("normalizes availability-only batches, fails closed, and records recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-store-placeholder-")); temporary.push(root);
    const store = await TallyStore.open(join(root, ".tally"));
    const fetchedAt = "2026-09-03T19:38:37Z";
    const fiveHour = observation({
      principal_id: "antigravity", meter_id: "antigravity:gemini", window: { kind: "fixed", minutes: 300, enforcement: "hard" },
      quantity: { used: 0, limit: 100, remaining: 100, unit: "percent" }, fetched_at: fetchedAt, observed_at: fetchedAt, resets_at: "2026-09-04T00:38:37Z",
    });
    const weekly = { ...fiveHour, window: { kind: "fixed" as const, minutes: 10_080, enforcement: "hard" as const }, resets_at: "2026-09-10T19:38:37Z" };
    try {
      store.insertAll([fiveHour, weekly]);
      const failed = store.latestPerWindow("antigravity:gemini");
      expect(failed).toEqual(expect.arrayContaining([
        expect.objectContaining({ freshness: "failed", truth: "estimated", reason: AVAILABILITY_ONLY_REASON }),
      ]));
      expect(formatMeters(failed, defaultPolicy)[0]).toContain("antigravity:gemini  5h UNKNOWN (availability-only payload; quota summary not served) | wk UNKNOWN (availability-only payload; quota summary not served)");
      expect(canConsume(["antigravity:gemini"], new Map([["antigravity:gemini", failed]]), defaultPolicy, false, new Date(fetchedAt))).toMatchObject({ allowed: false, state: "UNKNOWN" });
      expect(store.events("2026-09-03T00:00:00Z")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "source_failed", origin: "inferred", confidence: 0.8, reason: AVAILABILITY_ONLY_REASON }),
      ]));

      store.insertAll([{ ...fiveHour, fetched_at: "2026-09-03T19:39:37Z", observed_at: "2026-09-03T19:39:37Z", quantity: { used: 12, limit: 100, remaining: 88, unit: "percent" }, resets_at: "2026-09-03T23:10:00Z" }]);
      expect(store.events("2026-09-03T00:00:00Z")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "source_recovered", origin: "inferred", confidence: 0.8 }),
      ]));
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
    expect(canConsume([parent.meter_id, frozen.meter_id], new Map([[parent.meter_id, parent], [frozen.meter_id, frozen]]), policy, false, now)).toMatchObject({ allowed: false, meter: "claude-main:fable", state: "FREEZE", reason: "100m 95% FREEZE", meters: [expect.objectContaining({ meter: "claude-main:all" }), expect.objectContaining({ meter: "claude-main:fable", state: "FREEZE" })] });
  });

  it("holds pace at NORMAL for the early grace period unless frozen", () => {
    const early = paced(70, { resets_at: "2026-09-03T13:35:00Z" }); // 5% into a 100-minute window
    const later = paced(70, { resets_at: "2026-09-03T13:25:00Z" }); // 15% elapsed
    expect(paceDecision(early, policy, now)).toEqual({ state: "NORMAL", reason: "grace period" });
    expect(paceState(later, policy, now)).toBe("CONSERVE");
    expect(paceState(paced(95, { resets_at: "2026-09-03T13:35:00Z" }), policy, now)).toBe("FREEZE");
  });

  it("blocks on an enforced weekly window even if the 5h window is not enforced", () => {
    const fiveHour = paced(0, { window: { kind: "rolling", minutes: 300, enforcement: "hard" }, freshness: "not_enforced", quantity: null, resets_at: null });
    const weekly = paced(17, { window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, resets_at: "2026-09-10T12:00:00Z" });
    const decision = canConsume([weekly.meter_id], new Map([[weekly.meter_id, [fiveHour, weekly]]]), { ...policy, pace_grace_fraction: 0 }, false, now);
    expect(decision).toMatchObject({ allowed: false, state: "CONSERVE", reason: "wk 17% CONSERVE", meters: [expect.objectContaining({ state: "CONSERVE", reason: "wk 17% CONSERVE" })] });
  });

  it("formats each latest window once, with reasons only once", () => {
    const now = new Date();
    const failed = observation({ meter_id: "claude-main:fable", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: null, freshness: "failed", reason: "Claude OAuth usage unavailable", fetched_at: now.toISOString() });
    const absent = observation({ meter_id: "claude-main:fable", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "not_enforced", reason: "no scoped limit in response", fetched_at: now.toISOString() });
    expect(formatMeters([failed, absent], defaultPolicy)).toMatchInlineSnapshot(`
      [
        "claude-main:fable  5h UNKNOWN (Claude OAuth usage unavailable) | wk n/a (no scoped limit in response)  (failed <1m)",
      ]
    `);
  });

  it("renders credit counts as availability and excludes them from can decisions", () => {
    const credit = observation({ meter_id: "codex-main:credits", window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: 1, unit: "credits" }, resets_at: "2026-09-21T12:00:00Z", fetched_at: new Date().toISOString() });
    expect(formatMeters([credit], defaultPolicy)[0]).toContain("credits 1 available (expires Sep 21)");
    expect(canConsume([credit.meter_id], new Map([[credit.meter_id, credit]]), defaultPolicy)).toMatchObject({ allowed: true, state: "NOT_ENFORCED" });
  });

  it("labels a multi-window meter fresh when any enforced window is fresh", () => {
    const fresh = observation({ meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, fetched_at: new Date().toISOString() });
    const absent = observation({ meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, freshness: "not_enforced", quantity: null, fetched_at: new Date().toISOString() });
    expect(formatMeters([fresh, absent], defaultPolicy)[0]).toContain("(fresh <1m)");
    expect(formatMeters([absent], defaultPolicy)[0]).toContain("(not enforced <1m)");
  });

  it("returns every window's threshold result and preserves fail-closed blocking", () => {
    const fresh = observation({ meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 91, limit: 100, remaining: 9, unit: "percent" } });
    const stale = observation({ meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: { used: 12, limit: 100, remaining: 88, unit: "percent" }, freshness: "stale" });
    const absent = observation({ meter_id: "codex-main:spark", quantity: null, freshness: "not_enforced" });
    expect(thresholdReport([fresh, stale, absent], 90)).toEqual([
      expect.objectContaining({ meter_id: "codex-main:main", window_minutes: 300, used_percent: 91, crossed: true, blocking: true }),
      expect.objectContaining({ meter_id: "claude-main:all", window_minutes: 10_080, used_percent: 12, crossed: false, blocking: true }),
      expect.objectContaining({ meter_id: "codex-main:spark", crossed: false, blocking: false, freshness: "not_enforced" }),
    ]);
  });

  it("shows reset evidence beside the matching current window", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-reset-label-")); temporary.push(root);
    const store = await TallyStore.open(join(root, ".tally"));
    try {
      const first = observation({ window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 80, limit: 100, remaining: 20, unit: "percent" }, resets_at: "2026-09-03T13:00:00Z" });
      const current = { ...first, quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-03T17:00:00Z" };
      store.insert(first);
      store.insert(current);
      const latest = store.latestPerWindow();
      const seen = store.resetSeenFor(latest, new Date("2026-09-03T12:00:00Z"));
      expect(seen.get("codex-main:main:300")).toBe("2026-09-03T12:00:00.000Z");
      expect(formatMeters(latest, defaultPolicy, seen)[0]).toContain("reset seen");
    } finally { store.close(); }
  });
});
