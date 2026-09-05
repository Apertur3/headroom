import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canConsume, canRouteWithLeases, defaultPolicy, paceDecision, paceState, unknownMeterPrincipals } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import { endedLeaseMessage, formatMeters, printEventsOutput, thresholdReport } from "../src/cli.js";
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
  it("merges an adjacent legacy database observation history then logs and removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-db-")); temporary.push(root);
    const home = join(root, ".headroom");
    const legacy = await HeadroomStore.open(home);
    legacy.insert(observation({ meter_id: "codex-main:legacy" }));
    legacy.close();
    await rename(join(home, "headroom.db"), join(home, ["ta", "lly.db"].join("")));
    const store = await HeadroomStore.open(home);
    try {
      expect(store.history("codex-main:legacy", "2026-09-03T00:00:00Z")).toHaveLength(1);
      await expect(import("node:fs/promises").then(({ lstat }) => lstat(join(home, ["ta", "lly.db"].join(""))))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(home, "logs", "daemon.log"), "utf8")).resolves.toContain(`merged ${["ta", "lly.db"].join("")} observations=1`);
    } finally { store.close(); }
  });

  it("returns only active, unexpired leases and marks a repeated end idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-leases-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      const active = store.startLease("cadence", "codex-main:main", null, 60_000, null, now);
      const ended = store.startLease("cadence", "codex-main:main", null, 60_000, null, now);
      store.endLease(ended.id, "cadence", false, now);
      const expired = store.startLease("cadence", "codex-main:main", null, 1, null, now);
      expect(store.leases(undefined, true, new Date(now.getTime() + 2))).toEqual([expect.objectContaining({ id: active.id, ended_at: null })]);
      expect(store.endLease(ended.id, "cadence", false, now)).toMatchObject({ already_ended: true, id: ended.id });
      expect(endedLeaseMessage({ ...ended, ended_at: now.toISOString(), ended_reason: "ended", already_ended: true })).toContain("already ended");
      expect(expired.id).toBeTruthy();
    } finally { store.close(); }
  });
  it("allows two live connections to share a WAL database", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-wal-")); temporary.push(root);
    const home = join(root, ".headroom");
    const [first, second] = await Promise.all([HeadroomStore.open(home), HeadroomStore.open(home)]);
    try {
      const db = (first as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> | undefined } } }).db;
      expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
      first.insert(observation({ meter_id: "codex-main:first" }));
      second.insert(observation({ meter_id: "codex-main:second" }));
      expect(first.latest("codex-main:second")).toMatchObject({ meter_id: "codex-main:second" });
    } finally { first.close(); second.close(); }
  });

  it("records reset confidences, vendor reset use, and source recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
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
        // 80% to 20% with resets_at unchanged and now before that reset time is a
        // free reset fired ahead of schedule, not a vendor-scheduled reset.
        expect.objectContaining({ kind: "free_reset_used", origin: "inferred", confidence: 0.8, reason: "usage dropped from 80% to 20% before the scheduled reset" }),
        expect.objectContaining({ kind: "free_reset_used", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "free_reset_granted", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "credits_changed", origin: "vendor_reported" }),
        expect.objectContaining({ kind: "source_failed" }),
        expect.objectContaining({ kind: "source_recovered" }),
      ]));
      expect(store.history("codex-main:main", "2026-09-03T00:00:00Z")).toHaveLength(5);
    } finally { store.close(); }
  });

  it("never infers a reset from an advancing rolling timestamp or a zero-use window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-rolling-reset-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const rolling = (used: number, fetched_at: string, resets_at: string) => observation({
        window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, fetched_at, observed_at: fetched_at, resets_at,
      });
      store.insert(rolling(0, "2026-09-03T21:00:00Z", "2026-09-04T02:00:00Z"));
      store.insert(rolling(0, "2026-09-03T21:05:00Z", "2026-09-04T02:05:00Z"));
      store.insert(rolling(26, "2026-09-03T21:10:00Z", "2026-09-04T02:10:00Z"));
      store.insert(rolling(26, "2026-09-03T21:15:00Z", "2026-09-04T02:15:00Z"));
      expect(store.events("2026-09-03T21:00:00Z").filter((event) => event.kind === "reset_seen")).toHaveLength(0);

      store.insert(observation({ freshness: "failed", quantity: null, window: { kind: "rolling", minutes: 300, enforcement: "hard" }, fetched_at: "2026-09-03T21:20:00Z" }));
      store.insert(rolling(5, "2026-09-03T21:25:00Z", "2026-09-04T02:25:00Z"));
      const recoveryEvents = store.events("2026-09-03T21:00:00Z").filter((event) => event.created_at === "2026-09-03T21:25:00Z");
      expect(recoveryEvents).toEqual([expect.objectContaining({ kind: "source_recovered" })]);
    } finally { store.close(); }
  });

  it("detects a reset that happened while the principal was failing, using the last fresh baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-baseline-gap-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const weekly = (used: number, fetched_at: string) => observation({
        principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2026-09-06T13:59:00Z", fetched_at, observed_at: fetched_at,
      });
      store.insert(weekly(68, "2026-09-03T20:00:00Z"));
      store.insert(observation({ principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "failed", reason: "no credentials", fetched_at: "2026-09-03T20:05:00Z" }));
      store.insert(observation({ principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "failed", reason: "no credentials", fetched_at: "2026-09-03T20:10:00Z" }));
      store.insert(weekly(2, "2026-09-03T20:15:00Z"));
      const events = store.events("2026-09-03T00:00:00Z");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "source_recovered", meter_id: "claude-main:all" }),
        expect.objectContaining({ kind: "free_reset_used", meter_id: "claude-main:all", origin: "inferred", confidence: 0.8, reason: "usage dropped from 68% to 2% before the scheduled reset" }),
      ]));
      // Comparing against the immediately prior row (a failed one) instead of
      // the baseline would have missed this drop entirely.
      expect(events.filter((event) => event.kind === "free_reset_used")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("classifies an advanced reset timestamp as reset_seen and an unchanged one before schedule as free_reset_used", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-classify-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const weekly = (used: number, fetched_at: string, resets_at: string) => observation({
        principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at, fetched_at, observed_at: fetched_at,
      });
      store.insert(weekly(90, "2026-09-03T12:00:00Z", "2026-09-06T13:59:00Z"));
      // The window's own reset fired: resets_at moved forward by a full week,
      // far more than the minute that actually passed between polls.
      store.insert(weekly(3, "2026-09-03T12:01:00Z", "2026-09-13T13:59:00Z"));
      const advanced = store.events("2026-09-03T00:00:00Z").find((event) => event.kind === "reset_seen");
      expect(advanced).toMatchObject({ origin: "inferred", confidence: 0.9 });

      store.insert(weekly(80, "2026-09-04T12:00:00Z", "2026-09-13T13:59:00Z"));
      // resets_at held still while usage already collapsed, well before that
      // scheduled reset: a free reset was fired ahead of it.
      store.insert(weekly(4, "2026-09-04T12:05:00Z", "2026-09-13T13:59:00Z"));
      const freeReset = store.events("2026-09-04T00:00:00Z").find((event) => event.kind === "free_reset_used" && event.created_at === "2026-09-04T12:05:00Z");
      expect(freeReset).toMatchObject({ origin: "inferred", confidence: 0.8, reason: "usage dropped from 80% to 4% before the scheduled reset" });
    } finally { store.close(); }
  });

  it("lowers confidence and suffixes the reason when the baseline is more than 24h old", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-stale-baseline-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const weekly = (used: number, fetched_at: string, resets_at: string) => observation({
        principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at, fetched_at, observed_at: fetched_at,
      });
      store.insert(weekly(70, "2026-09-01T12:00:00Z", "2026-09-06T13:59:00Z"));
      store.insert(weekly(5, "2026-09-03T14:00:00Z", "2026-09-06T13:59:00Z")); // 50h later, resets_at unchanged
      const event = store.events("2026-09-01T00:00:00Z").find((item) => item.kind === "free_reset_used");
      expect(event).toMatchObject({ confidence: 0.5, reason: "usage dropped from 70% to 5% before the scheduled reset; baseline 50h old" });
    } finally { store.close(); }
  });

  it("also accepts the legacy doubled-principal meter id as a baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-legacy-meter-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const window = { kind: "fixed" as const, minutes: 10_080, enforcement: "hard" as const };
      store.insert(observation({
        principal_id: "claude-main", meter_id: "claude-main:claude-main:all", window,
        quantity: { used: 68, limit: 100, remaining: 32, unit: "percent" }, resets_at: "2026-09-06T13:59:00Z",
        fetched_at: "2026-09-03T20:00:00Z", observed_at: "2026-09-03T20:00:00Z",
      }));
      store.insert(observation({
        principal_id: "claude-main", meter_id: "claude-main:all", window,
        quantity: { used: 2, limit: 100, remaining: 98, unit: "percent" }, resets_at: "2026-09-06T13:59:00Z",
        fetched_at: "2026-09-03T20:15:00Z", observed_at: "2026-09-03T20:15:00Z",
      }));
      expect(store.events("2026-09-03T00:00:00Z")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "free_reset_used", meter_id: "claude-main:all" }),
      ]));
    } finally { store.close(); }
  });

  it("never classifies a local pool's running-count drop as a reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-local-pool-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const local = (running: number, fetched_at: string) => observation({
        principal_id: "workstation", meter_id: "workstation:capacity", window: { kind: "state", minutes: null, enforcement: "soft" },
        quantity: { used: running, limit: null, remaining: null, unit: "requests" }, resets_at: null, fetched_at, observed_at: fetched_at,
        metadata: { state: running > 0 ? "BUSY" : "UP" },
      });
      store.insert(local(6, "2026-09-03T20:00:00Z"));
      store.insert(local(0, "2026-09-03T20:01:00Z"));
      expect(store.events("2026-09-03T00:00:00Z").filter((event) => event.meter_id === "workstation:capacity")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("emits source_failed once for a run of failures and advances last_seen_at instead of duplicating the event", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-failure-run-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const window = { kind: "fixed" as const, minutes: 10_080, enforcement: "hard" as const };
      const failing = (fetched_at: string) => observation({ principal_id: "claude-main", meter_id: "claude-main:all", window, quantity: null, freshness: "failed", reason: "no credentials", fetched_at, observed_at: fetched_at });
      store.insert(observation({ principal_id: "claude-main", meter_id: "claude-main:all", window, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: "2026-09-10T12:00:00Z", fetched_at: "2026-09-03T20:00:00Z", observed_at: "2026-09-03T20:00:00Z" }));
      store.insert(failing("2026-09-03T20:05:00Z"));
      store.insert(failing("2026-09-03T20:10:00Z"));
      store.insert(failing("2026-09-03T20:15:00Z"));
      const failedEvents = store.events("2026-09-03T00:00:00Z").filter((event) => event.kind === "source_failed" && event.meter_id === "claude-main:all");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toMatchObject({ created_at: "2026-09-03T20:05:00Z", last_seen_at: "2026-09-03T20:15:00Z" });
    } finally { store.close(); }
  });

  it("fires exactly one vendor_reported free_reset_granted event when Codex credits go from 0 to 1", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-credit-grant-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const credit = (remaining: number, fetched_at: string) => observation({
        principal_id: "codex-main", meter_id: "codex-main:credits", window: { kind: "count", minutes: null, enforcement: "hard" },
        quantity: { used: 0, limit: null, remaining, unit: "credits" }, resets_at: "2026-10-04T00:00:00Z", fetched_at, observed_at: fetched_at,
      });
      // Live-observed shape: "credits 1 available (expires Oct 4)" appeared
      // after a prior read of 0 available credits.
      store.insert(credit(0, "2026-09-03T22:00:00Z"));
      store.insert(credit(1, "2026-09-03T22:05:00Z"));
      const granted = store.events("2026-09-03T00:00:00Z").filter((event) => event.kind === "free_reset_granted");
      expect(granted).toHaveLength(1);
      expect(granted[0]).toMatchObject({ origin: "vendor_reported", meter_id: "codex-main:credits" });
    } finally { store.close(); }
  });

  it("collapses pre-existing duplicate source_failed events into the first one, once per database", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-collapse-failures-")); temporary.push(root);
    const home = join(root, ".headroom");
    const { DatabaseSync: RawDatabase } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void } };

    const seed = await HeadroomStore.open(home);
    const window = { kind: "fixed" as const, minutes: 10_080, enforcement: "hard" as const };
    seed.insert(observation({ principal_id: "claude-main", meter_id: "claude-main:all", window, quantity: { used: 5, limit: 100, remaining: 95, unit: "percent" }, fetched_at: "2026-09-03T20:00:00Z", observed_at: "2026-09-03T20:00:00Z" }));
    seed.close();

    // Model a database written before the fix landed, when every failed poll
    // inserted its own source_failed row for the same still-down meter.
    const raw = new RawDatabase(join(home, "headroom.db"));
    raw.exec("DELETE FROM schema_migrations WHERE id = '2026-09-05-collapse-source-failed-duplicates'");
    for (const [id, createdAt] of [["source_failed:planted-1", "2026-09-03T20:05:00Z"], ["source_failed:planted-2", "2026-09-03T20:10:00Z"], ["source_failed:planted-3", "2026-09-03T20:15:00Z"]] as const) {
      raw.prepare("INSERT INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, "source_failed", "vendor_reported", 1, "[]", createdAt, null, "claude-main:all", "claude-main", null, createdAt);
    }
    raw.close();

    const reopened = await HeadroomStore.open(home);
    try {
      const failedEvents = reopened.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "source_failed" && event.meter_id === "claude-main:all");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toMatchObject({ id: "source_failed:planted-1", created_at: "2026-09-03T20:05:00Z", last_seen_at: "2026-09-03T20:15:00Z" });
      await expect(readFile(join(home, "logs", "daemon.log"), "utf8")).resolves.toContain("collapsed 2 duplicate source_failed events");
    } finally { reopened.close(); }
  });

  it("backfills a missing reset event across a failure gap and removes false local-pool reset events, once per database", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-backfill-")); temporary.push(root);
    const home = join(root, ".headroom");
    const { DatabaseSync: RawDatabase } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };
    type RawDb = { prepare(sql: string): { run(...params: unknown[]): unknown } };

    const seed = await HeadroomStore.open(home);
    const seedDb = (seed as unknown as { db: RawDb }).db;
    const weekly = (used: number, fetched_at: string) => observation({
      principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
      quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2026-09-06T13:59:00Z", fetched_at, observed_at: fetched_at,
    });
    const local = (running: number, fetched_at: string) => observation({
      principal_id: "workstation", meter_id: "workstation:capacity", window: { kind: "state", minutes: null, enforcement: "soft" },
      quantity: { used: running, limit: null, remaining: null, unit: "requests" }, resets_at: null, fetched_at, observed_at: fetched_at,
      metadata: { state: "UP" },
    });
    seed.insert(weekly(68, "2026-09-03T20:00:00Z"));
    seed.insert(observation({ principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "failed", reason: "no credentials", fetched_at: "2026-09-03T20:05:00Z" }));
    const local1 = seed.insert(local(3, "2026-09-03T20:00:00Z"));
    const local2 = seed.insert(local(0, "2026-09-03T20:01:00Z"));
    seed.insert(weekly(2, "2026-09-03T20:15:00Z"));
    // The live insert above already classifies this correctly (item 1). Delete
    // its event and plant a bogus local-pool one to model a database written
    // by a version of this code that predates both fixes.
    seedDb.prepare("DELETE FROM events WHERE meter_id = 'claude-main:all' AND kind = 'free_reset_used'").run();
    seedDb.prepare("INSERT INTO events (id,kind,origin,confidence,evidence_observation_ids,created_at,corrected_by,meter_id,principal_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("reset_seen:planted", "reset_seen", "inferred", 0.5, JSON.stringify([local1.id, local2.id]), local2.fetched_at, null, "workstation:capacity", "workstation", null);
    seed.close();

    // Erase the backfill's own migration marker so the next open reprocesses
    // history, modeling a database that has not seen this migration yet.
    const raw = new RawDatabase(join(home, "headroom.db"));
    raw.exec("DELETE FROM schema_migrations WHERE id = '2026-09-04-reset-detection-backfill'");
    raw.close();

    const reopened = await HeadroomStore.open(home);
    try {
      const events = reopened.events("2000-01-01T00:00:00Z");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "free_reset_used", meter_id: "claude-main:all", origin: "inferred" }),
      ]));
      expect(events.some((event) => event.meter_id === "workstation:capacity")).toBe(false);
      await expect(readFile(join(home, "logs", "daemon.log"), "utf8")).resolves.toContain("reset detection backfill");

      // Reopening again must not error or duplicate the event: the migration
      // marker is now set, so this is a no-op.
      const third = await HeadroomStore.open(home);
      try { expect(third.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "free_reset_used" && event.meter_id === "claude-main:all")).toHaveLength(1); }
      finally { third.close(); }
    } finally { reopened.close(); }
  });

  it("returns only the latest fetched observation for each meter window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-latest-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
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

  it("prefers a fresh reading over a stale one for the same window, regardless of which fetched_at is numerically later", async () => {
    // The live defect: Codex's session-log fallback keeps re-inserting the
    // exact same old (07:31) event on every poll, alongside the endpoint's
    // own genuinely fresh (13:13) weekly reading -- both landing in the same
    // (meter, window) partition. A plain "latest fetched_at wins" rule
    // happens to pick the fresh one here only because 13:13 > 07:31; the
    // real requirement is that "fresh" always wins over "stale", independent
    // of that coincidence.
    const root = await mkdtemp(join(tmpdir(), "headroom-store-fresh-over-stale-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const weekly = (fetchedAt: string, freshness: Observation["freshness"], used: number, metadata?: Observation["metadata"]) => observation({
        meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2026-09-10T13:08:00Z",
        fetched_at: fetchedAt, observed_at: fetchedAt, freshness, source: freshness === "fresh" ? "native:codex" : "fixture", ...(metadata ? { metadata } : {}),
      });
      // Several polls, each re-appending the same stale session-log-shaped
      // reading alongside that poll's own fresh one -- exactly the alternate
      // pattern seen in the real store, minus the source-level dedup guard
      // (covered separately) so this test isolates the selection rule itself.
      store.insert(weekly("2026-09-05T12:00:00Z", "fresh", 80));
      store.insert(weekly("2026-09-05T07:31:04Z", "stale", 83));
      store.insert(weekly("2026-09-05T13:13:51Z", "fresh", 83, { plan: "prolite", free_resets_available: 2 }));
      store.insert(weekly("2026-09-05T07:31:04Z", "stale", 83));
      const latest = store.latestPerWindow("codex-main:main");
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ fetched_at: "2026-09-05T13:13:51Z", freshness: "fresh", quantity: { used: 83, limit: 100, remaining: 17, unit: "percent" } });
    } finally { store.close(); }
  });

  it("falls back to the freshest non-fresh reading only when no fresh reading exists at all for that window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-no-fresh-yet-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(observation({ freshness: "failed", quantity: null, fetched_at: "2026-09-03T12:00:00Z" }));
      store.insert(observation({ freshness: "stale", fetched_at: "2026-09-03T12:05:00Z" }));
      const latest = store.latestPerWindow("codex-main:main");
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ freshness: "stale", fetched_at: "2026-09-03T12:05:00Z" });
    } finally { store.close(); }
  });

  it("never re-appends a session-log observation once the store already holds a reading at least as recent for that window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-session-log-dedup-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const sessionLogWeekly = (fetchedAt: string, used: number) => observation({
        meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2026-09-10T13:08:00Z",
        fetched_at: fetchedAt, observed_at: fetchedAt, freshness: "stale", source: "native:codex:session-log",
      });
      const first = store.insert(sessionLogWeekly("2026-09-05T07:31:04Z", 41));
      // Re-reading the same unchanged session log file on a later poll must
      // not append a second identical (or older) row.
      const second = store.insert(sessionLogWeekly("2026-09-05T07:31:04Z", 41));
      expect(second.id).toBe(first.id);
      expect(store.history("codex-main:main", "2000-01-01T00:00:00Z")).toHaveLength(1);
      // A genuinely older session event (e.g. a rotated-in older log) is
      // rejected the same way.
      const older = store.insert(sessionLogWeekly("2026-09-05T06:00:00Z", 41));
      expect(older.id).toBe(first.id);
      expect(store.history("codex-main:main", "2000-01-01T00:00:00Z")).toHaveLength(1);
      // A genuinely newer session event (a new Codex CLI session actually
      // ran) is still recorded normally.
      const newer = store.insert(sessionLogWeekly("2026-09-05T09:00:00Z", 41));
      expect(newer.id).not.toBe(first.id);
      expect(store.history("codex-main:main", "2000-01-01T00:00:00Z")).toHaveLength(2);
    } finally { store.close(); }
  });

  it("does not display an older failed read beside a newer scoped window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-failure-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(observation({ meter_id: "claude-main:fable", window: null, quantity: null, freshness: "failed", reason: "Claude OAuth usage unavailable", fetched_at: "2026-09-03T12:00:00Z" }));
      store.insert(observation({ meter_id: "claude-main:fable", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "not_enforced", reason: "no scoped limit in response", fetched_at: "2026-09-03T12:01:00Z" }));
      expect(store.latestPerWindow("claude-main:fable")).toEqual([expect.objectContaining({ freshness: "not_enforced", reason: "no scoped limit in response" })]);
    } finally { store.close(); }
  });

  it("keeps a failed 5h window visible beside a fresh weekly window of the same meter, instead of one hiding the other", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-cross-window-failure-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insert(observation({
        meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
        quantity: null, freshness: "failed", reason: "no credentials", fetched_at: "2026-09-03T12:00:00Z",
      }));
      store.insert(observation({
        meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used: 12, limit: 100, remaining: 88, unit: "percent" }, resets_at: "2026-09-10T12:00:00Z", fetched_at: "2026-09-03T12:01:00Z",
      }));
      const latest = store.latestPerWindow("codex-main:main");
      expect(latest).toHaveLength(2);
      expect(latest).toEqual(expect.arrayContaining([
        expect.objectContaining({ freshness: "failed", window: expect.objectContaining({ minutes: 300 }) }),
        expect.objectContaining({ freshness: "fresh", window: expect.objectContaining({ minutes: 10_080 }) }),
      ]));
      // A CONSERVE/UNKNOWN 5h window must still block the action, not be
      // hidden by the weekly window's healthy state.
      expect(canConsume(["codex-main:main"], new Map([["codex-main:main", latest]]), defaultPolicy, false, new Date("2026-09-03T12:01:00Z"))).toMatchObject({ allowed: false, state: "UNKNOWN" });
    } finally { store.close(); }
  });

  it("emits a second source_failed after a real recovery closes a windowless outage, instead of extending the first", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-windowless-outage-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const windowless = (fetched_at: string) => observation({ meter_id: "claude-main:fable", window: null, quantity: null, freshness: "failed", reason: "Claude OAuth usage unavailable", fetched_at });
      const recovered = (fetched_at: string) => observation({
        meter_id: "claude-main:fable", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
        quantity: { used: 5, limit: 100, remaining: 95, unit: "percent" }, resets_at: "2026-09-03T18:00:00Z", fetched_at,
      });
      store.insert(windowless("2026-09-03T12:00:00Z")); // outage 1 begins
      store.insert(recovered("2026-09-03T12:05:00Z")); // recovers with a real window
      store.insert(windowless("2026-09-03T12:10:00Z")); // outage 2 begins
      const events = store.events("2026-09-03T00:00:00Z").filter((event) => event.meter_id === "claude-main:fable");
      expect(events.filter((event) => event.kind === "source_failed")).toHaveLength(2);
      expect(events.filter((event) => event.kind === "source_recovered")).toHaveLength(1);
      const failures = events.filter((event) => event.kind === "source_failed").sort((a, b) => a.created_at.localeCompare(b.created_at));
      expect(failures[0]).toMatchObject({ created_at: "2026-09-03T12:00:00Z" });
      expect(failures[1]).toMatchObject({ created_at: "2026-09-03T12:10:00Z" });
    } finally { store.close(); }
  });

  it("normalizes availability-only batches, fails closed, and records recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-store-placeholder-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
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
    expect(canConsume([parent.meter_id, frozen.meter_id], new Map([[parent.meter_id, parent], [frozen.meter_id, frozen]]), policy, false, now)).toMatchObject({ allowed: false, meter: "claude-main:fable", state: "FREEZE", reason: "100m 95% FREEZE, resets in 50m", meters: [expect.objectContaining({ meter: "claude-main:all" }), expect.objectContaining({ meter: "claude-main:fable", state: "FREEZE" })] });
  });

  it("prints the next scheduled poll time (fetched_at + poll_interval_minutes) for a stale reading", () => {
    const explicitlyStale = paced(10, { freshness: "stale", fetched_at: "2026-09-03T11:50:00Z" });
    const withInterval = { ...policy, poll_interval_minutes: 5 };
    const decision = paceDecision(explicitlyStale, withInterval, now);
    expect(decision.state).toBe("UNKNOWN");
    expect(decision.reason).toMatch(/^stale; next poll ~\d\d:\d\d$/);

    // A freshness: "fresh" reading that has simply aged past staleness_minutes
    // by wall clock, not just an adapter-flagged "stale" one, gets the same hint.
    const agedByClock = paced(10, { freshness: "fresh", fetched_at: "2026-09-03T11:00:00Z" }); // 60 minutes old, staleness_minutes = 15
    const agedDecision = paceDecision(agedByClock, withInterval, now);
    expect(agedDecision.reason).toMatch(/^stale 60m; next poll ~\d\d:\d\d$/);
  });

  it("holds pace at NORMAL for the early grace period unless frozen", () => {
    const early = paced(70, { resets_at: "2026-09-03T13:35:00Z" }); // 5% into a 100-minute window
    const later = paced(70, { resets_at: "2026-09-03T13:25:00Z" }); // 15% elapsed
    expect(paceDecision(early, policy, now)).toEqual({ state: "NORMAL", reason: "grace period" });
    expect(paceState(later, policy, now)).toBe("CONSERVE");
    expect(paceState(paced(95, { resets_at: "2026-09-03T13:35:00Z" }), policy, now)).toBe("FREEZE");
  });

  it("formats an UNKNOWN window's can reason as 'wk UNKNOWN (reason)', not a duplicated state", () => {
    // Regression for the bug where a window with no percentage rendered its
    // own state twice, e.g. "wk UNKNOWN UNKNOWN", hiding the actual reason.
    const failedWeekly = observation({ meter_id: "antigravity:gemini", window: { kind: "rolling", minutes: 10_080, enforcement: "hard" }, quantity: null, freshness: "failed", reason: "Gemini CLI OAuth client unavailable", fetched_at: now.toISOString() });
    const decision = canConsume([failedWeekly.meter_id], new Map([[failedWeekly.meter_id, failedWeekly]]), policy, false, now);
    expect(decision.state).toBe("UNKNOWN");
    expect(decision.reason).toBe("wk UNKNOWN (Gemini CLI OAuth client unavailable)");
    expect(decision.meters).toEqual([expect.objectContaining({ meter: failedWeekly.meter_id, state: "UNKNOWN", reason: "wk UNKNOWN (Gemini CLI OAuth client unavailable)" })]);
  });

  it("blocks on an enforced weekly window even if the 5h window is not enforced", () => {
    const fiveHour = paced(0, { window: { kind: "rolling", minutes: 300, enforcement: "hard" }, freshness: "not_enforced", quantity: null, resets_at: null });
    const weekly = paced(17, { window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, resets_at: "2026-09-10T12:00:00Z" });
    const decision = canConsume([weekly.meter_id], new Map([[weekly.meter_id, [fiveHour, weekly]]]), { ...policy, pace_grace_fraction: 0 }, false, now);
    expect(decision).toMatchObject({ allowed: false, state: "CONSERVE", reason: "wk 17% CONSERVE, resets in 7d", meters: [expect.objectContaining({ state: "CONSERVE", reason: "wk 17% CONSERVE, resets in 7d" })] });
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

  it("treats an empty observation set for a consumed meter as UNKNOWN, not NOT_ENFORCED, and blocks with a named reason", () => {
    const decision = canConsume(["codex-main:main"], new Map(), policy, false, now);
    expect(decision).toMatchObject({ allowed: false, state: "UNKNOWN", reason: "no readings for codex-main:main" });
    expect(decision.meters).toEqual([expect.objectContaining({ meter: "codex-main:main", state: "UNKNOWN", reason: "no readings for codex-main:main" })]);
    // A meter present in the map but with an undefined value (never observed
    // yet, distinct from an empty array) hits the same path.
    expect(canConsume(["codex-main:main"], new Map([["codex-main:main", undefined]]), policy, false, now)).toMatchObject({ allowed: false, state: "UNKNOWN" });
  });

  it("flags a routing meter whose principal is not any known account, leaving known ones alone", () => {
    const known = new Set(["codex-main", "claude-main"]);
    expect(unknownMeterPrincipals(["codex-main:main", "claude-main:all"], known)).toEqual([]);
    expect(unknownMeterPrincipals(["codex-mian:main"], known)).toEqual(["codex-mian:main"]);
    expect(unknownMeterPrincipals(["codex-main:main", "typo-principal:main"], known)).toEqual(["typo-principal:main"]);
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

  it("prints a reset countdown next to the absolute reset time, and omits it when the window has no reset", () => {
    const resetsAt = new Date(Date.now() + 5 * 3_600_000);
    const fresh = observation({ meter_id: "codex-main:main", fetched_at: new Date().toISOString(), resets_at: resetsAt.toISOString() });
    expect(formatMeters([fresh], defaultPolicy)[0]).toContain("(in 5h)");
    const unknown = observation({ meter_id: "codex-main:main", freshness: "failed", quantity: null, reason: "boom" });
    expect(formatMeters([unknown], defaultPolicy)[0]).not.toContain("(in ");
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
    const root = await mkdtemp(join(tmpdir(), "headroom-reset-label-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
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

  it("shows a free reset beside the matching current window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-free-reset-label-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const window = { kind: "fixed" as const, minutes: 10_080, enforcement: "hard" as const };
      const first = observation({ meter_id: "claude-main:all", window, quantity: { used: 68, limit: 100, remaining: 32, unit: "percent" }, resets_at: "2026-09-06T13:59:00Z", fetched_at: "2026-09-03T20:00:00Z", observed_at: "2026-09-03T20:00:00Z" });
      const current = { ...first, quantity: { used: 2, limit: 100, remaining: 98, unit: "percent" }, fetched_at: "2026-09-03T20:15:00Z", observed_at: "2026-09-03T20:15:00Z" };
      store.insert(first);
      store.insert(current);
      const latest = store.latestPerWindow();
      const seen = store.freeResetUsedFor(latest, new Date("2026-09-03T20:15:00Z"));
      expect(seen.get("claude-main:all:10080")).toBe("2026-09-03T20:15:00Z");
      expect(formatMeters(latest, defaultPolicy, undefined, undefined, seen)[0]).toContain("free reset");
    } finally { store.close(); }
  });
});

describe("events output", () => {
  it("always prints a JSON array, empty allowed, and reserves the human table for --table", () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => { logs.push(line); };
    try {
      printEventsOutput([], false);
      printEventsOutput([{ id: "reset_seen:1", kind: "reset_seen", origin: "inferred", confidence: 0.9, evidence_observation_ids: [1, 2], created_at: "2026-09-03T12:00:00.000Z", corrected_by: null, meter_id: "claude-main:all", principal_id: "claude-main", reason: null }], false);
      expect(JSON.parse(logs[0])).toEqual([]);
      expect(JSON.parse(logs[1])).toEqual([expect.objectContaining({ kind: "reset_seen" })]);
      logs.length = 0;
      printEventsOutput([{ id: "free_reset_used:2", kind: "free_reset_used", origin: "inferred", confidence: 0.8, evidence_observation_ids: [1, 2], created_at: "2026-09-03T20:15:00.000Z", corrected_by: null, meter_id: "claude-main:all", principal_id: "claude-main", reason: "usage dropped from 68% to 2% before the scheduled reset" }], true);
      expect(logs[0]).toContain("claude-main:all");
      expect(logs[0]).toContain("free reset used");
      expect(() => JSON.parse(logs[0])).toThrow();
    } finally { console.log = original; }
  });
});

describe("leases", () => {
  it("starts, attributes, expires, and ends leases with ownership checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-lease-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const started = store.startLease("cadence", "codex-main:main", 20, 2 * 3_600_000, "fanout", new Date("2026-09-03T12:00:00Z"));
      store.insert(observation({ fetched_at: "2026-09-03T12:00:00Z", quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" } }));
      store.insert(observation({ fetched_at: "2026-09-03T12:01:00Z", quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" } }));
      expect(store.leases(undefined, false, new Date("2026-09-03T12:01:00Z"))[0]).toMatchObject({ id: started.id, spent_percent: 10, ended_at: null });
      expect(() => store.endLease(started.id, "other", false, new Date("2026-09-03T12:01:00Z"))).toThrow("--force");
      const ended = store.endLease(started.id, "other", true, new Date("2026-09-03T12:01:00Z"));
      expect(ended.ended_reason).toBe("ended");
      expect(store.endLease(started.id, "cadence", false, new Date("2026-09-03T12:02:00Z"))).toMatchObject({ id: started.id, owner: "cadence", ended_reason: "ended" });
      expect(endedLeaseMessage(ended)).toBe(`ended ${started.id} (owner cadence)`);
      const expiring = store.startLease("cadence", "codex-main:main", null, 1, null, new Date("2026-09-03T13:00:00Z"));
      expect(store.leases(undefined, false, new Date("2026-09-03T13:00:01Z")).find((item) => item.id === expiring.id)).toMatchObject({ ended_reason: "expired" });
      expect(store.events("2026-09-03T00:00:00Z")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lease_started" }), expect.objectContaining({ kind: "lease_ended" })]));
    } finally { store.close(); }
  });

  it("splits a meter delta by expected leases and makes a foreign claim conserve", () => {
    const first = observation({ window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: { used: 68, limit: 100, remaining: 32, unit: "percent" }, resets_at: "2026-09-10T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z" });
    const leases = [{ id: "a", owner: "cadence", meter_id: first.meter_id, expected_percent: 6, note: null, started_at: first.fetched_at, expires_at: "2026-09-04T12:00:00Z", ended_at: null, ended_reason: null, spent_percent: 0 }];
    const decision = canRouteWithLeases([first.meter_id], [], new Map([[first.meter_id, [first]]]), "never", { ...defaultPolicy, pace_grace_fraction: 0 }, false, leases, "other", new Date(first.fetched_at));
    expect(decision).toMatchObject({ allowed: false, state: "CONSERVE" });
    expect(decision.reason).toBe("wk 68% + 6% leased by cadence → CONSERVE");
  });

  it("uses equal weights for unspecified expected shares", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-lease-split-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const at = new Date("2026-09-03T12:00:00Z");
      store.startLease("one", "codex-main:main", null, 2 * 3_600_000, null, at);
      store.startLease("two", "codex-main:main", null, 2 * 3_600_000, null, at);
      store.insert(observation({ fetched_at: at.toISOString(), quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" } }));
      store.insert(observation({ fetched_at: "2026-09-03T12:01:00Z", quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" } }));
      expect(store.leases(undefined, false, new Date("2026-09-03T12:01:00Z")).map((item) => item.spent_percent).sort()).toEqual([5, 5]);
    } finally { store.close(); }
  });
});

describe("Keychain grant marker lifecycle", () => {
  it("records, queries, and clears a per-principal keychain_grant_needed marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-keychain-grant-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      expect(store.keychainGrantNeeded("claude-main")).toBe(false);
      expect(store.keychainGrantReason("claude-main")).toBeUndefined();
      expect(store.keychainGrantsNeeded()).toEqual([]);

      store.setKeychainGrantNeeded("claude-main", "Keychain access denied");
      expect(store.keychainGrantNeeded("claude-main")).toBe(true);
      expect(store.keychainGrantReason("claude-main")).toBe("Keychain access denied");
      expect(store.keychainGrantsNeeded()).toEqual([expect.objectContaining({ principal_id: "claude-main", reason: "Keychain access denied" })]);

      // A second marker for the same principal replaces the reason rather than duplicating the row.
      store.setKeychainGrantNeeded("claude-main", "probe binary rebuilt");
      expect(store.keychainGrantsNeeded()).toHaveLength(1);
      expect(store.keychainGrantReason("claude-main")).toBe("probe binary rebuilt");

      store.setKeychainGrantNeeded("claude-2", "Keychain access timed out");
      expect(store.keychainGrantsNeeded().map((item) => item.principal_id).sort()).toEqual(["claude-2", "claude-main"]);

      store.clearKeychainGrantNeeded("claude-main");
      expect(store.keychainGrantNeeded("claude-main")).toBe(false);
      expect(store.keychainGrantNeeded("claude-2")).toBe(true);

      // Clearing an already-clear (or never-set) principal is a harmless no-op.
      store.clearKeychainGrantNeeded("claude-main");
      expect(store.keychainGrantNeeded("claude-main")).toBe(false);
    } finally { store.close(); }
  });

  it("tracks the Claude probe binary's last-known hash for rebuild detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-hash-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      expect(store.probeBinaryHash()).toBeUndefined();
      store.setProbeBinaryHash("hash-a");
      expect(store.probeBinaryHash()).toBe("hash-a");
      store.setProbeBinaryHash("hash-b");
      expect(store.probeBinaryHash()).toBe("hash-b");
    } finally { store.close(); }
  });

  it("tracks the last probe binary hash that actually proved itself, independently of the last-seen hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-granted-hash-")); temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      expect(store.probeGrantedHash()).toBeUndefined();
      store.setProbeGrantedHash("hash-a");
      expect(store.probeGrantedHash()).toBe("hash-a");
      // Independent of the last-seen hash: a rebuild can move probeBinaryHash
      // forward well before the new binary proves itself under a grant or a
      // successful poll.
      store.setProbeBinaryHash("hash-b");
      expect(store.probeGrantedHash()).toBe("hash-a");
      store.setProbeGrantedHash("hash-b");
      expect(store.probeGrantedHash()).toBe("hash-b");
    } finally { store.close(); }
  });
});
