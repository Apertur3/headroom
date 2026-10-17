import { mkdtemp, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { HeadroomStore } from "../src/store.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
import { buildCostEstimate, learnedCostText, leaseSpendText } from "../src/cost.js";
import { gateFor } from "../src/orchestrator-reads.js";
import { exportCommand } from "../src/export.js";
import { handleMcp } from "../src/mcp.js";
import type { Observation } from "../src/types.js";

// All accounts and jobs in these tests are synthetic.
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "lease-spend-"));
  paths.push(home);
  return { home, store: await HeadroomStore.open(home) };
}
const at = (minute: number) => new Date(Date.UTC(2026, 8, 3, 12, minute));
function reading(minute: number, used: number, minutes = 300, kind: "fixed" | "rolling" = "fixed"): Observation {
  return { principal_id: "account", meter_id: "account:all", window: { kind, minutes, enforcement: "hard" },
    quantity: { used, remaining: 100 - used, limit: 100, unit: "percent" },
    resets_at: at(600).toISOString(), observed_at: at(minute).toISOString(), fetched_at: at(minute).toISOString(),
    source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" };
}
const start = (store: HeadroomStore, minute = 0, action = "review") => store.startLease("worker", "account:all", 90, 60 * 60_000, null, at(minute), action);
const find = (store: HeadroomStore, id: string) => store.leases(undefined, false, at(10)).find((l) => l.id === id)!;

it("keeps three ten-point windows separate and trains only the shortest hard window", async () => {
  const { store } = await setup();
  try {
    for (const [minutes, kind] of [[300, "fixed"], [10080, "fixed"], [600, "rolling"]] as const) store.insert(reading(0, 0, minutes, kind));
    const lease = start(store);
    for (const [minutes, kind] of [[300, "fixed"], [10080, "fixed"], [600, "rolling"]] as const) store.insert(reading(5, 10, minutes, kind));
    const ended = store.endLease(lease.id, "worker", false, at(5));
    expect(ended).toMatchObject({ spent_percent: 10, spend_resolution: "resolved", spent_percent_bound: "exact", spend_window_minutes: 300 });
    expect(ended.spend_windows?.map((w) => [w.lower_percent, w.upper_percent])).toEqual([[10, 10], [10, 10], [10, 10]]);
    expect(store.learnedCost("review", at(10))).toMatchObject([{ median_percent: 10, sample_count: 1, basis: "exact", bounded_sample_count: 0 }]);
    expect(store.learnedCostForMeter("account:all", at(10))).toMatchObject({ median_percent: 10, sample_count: 1, basis: "exact", bounded_sample_count: 0 });
  } finally { store.close(); }
});

it("trains on the whole interval's conservative upper bound for a single short lease between polls", async () => {
  const { store } = await setup();
  try {
    store.insert(reading(0, 0));
    const lease = start(store, 1);
    expect(store.endLease(lease.id, "worker", false, at(2))).toMatchObject({ spent_percent: 0, spent_percent_bound: "lower", spend_resolution: "unresolved" });
    store.insert(reading(5, 6));
    expect(leaseSpendText(find(store, lease.id))).toBe("at most 6.0% (bounded)");
    expect(find(store, lease.id)).toMatchObject({ spent_percent: 6, spent_percent_bound: "upper", spend_resolution: "bounded",
      spend_windows: [{ lower_percent: 0, upper_percent: 6, overlapping_leases: 1 }] });
    const learned = store.learnedCost("review", at(10))[0]!;
    expect(learned).toMatchObject({ median_percent: 6, sample_count: 1, basis: "upper_bound", bounded_sample_count: 1 });
    expect(store.learnedCostForMeter("account:all", at(10))).toMatchObject({ median_percent: 6, sample_count: 1, basis: "upper_bound", bounded_sample_count: 1 });
    expect(buildCostEstimate("review", null, learned, 30)).toMatchObject({ expected_percent: 6, max_more_before_reset: 5, basis: "upper_bound", bounded_sample_count: 1 });
    expect(learnedCostText(learned)).toContain("median at most 6.00%");
    expect(learnedCostText(learned)).toContain("conservative");
  } finally { store.close(); }
});

it.each([false, true])("excludes two leases sharing a poll even when sequential=%s", async (sequential) => {
  const { store } = await setup();
  try {
    store.insert(reading(0, 0));
    const a = start(store, 1);
    store.endLease(a.id, "worker", false, at(2));
    const b = start(store, sequential ? 3 : 1);
    store.endLease(b.id, "worker", false, at(4));
    store.insert(reading(5, 6));
    for (const lease of store.leases(undefined, false, at(10))) expect(lease).toMatchObject({ spent_percent: 6, spent_percent_bound: "upper", spend_resolution: "unattributable",
      spend_windows: [{ lower_percent: 0, upper_percent: 6, overlapping_leases: 2 }] });
    expect(store.learnedCost(undefined, at(10))).toEqual([]);
    expect(store.learnedCostForMeter("account:all", at(10))).toBeUndefined();
  } finally { store.close(); }
});

it("keeps boundary-touching leases bounded and out of a reset bracket's overlap count", async () => {
  const { home, store } = await setup();
  try {
    store.insert({ ...reading(0, 0), resets_at: at(8).toISOString() });
    const before = start(store, 1);
    store.insert({ ...reading(5, 6), resets_at: at(8).toISOString() });
    store.endLease(before.id, "worker", false, at(5));
    const inside = start(store, 6, "reset");
    store.endLease(inside.id, "worker", false, at(7));
    const after = start(store, 10, "after");
    store.insert({ ...reading(10, 0), resets_at: at(700).toISOString() });
    store.endLease(after.id, "worker", false, at(11));
    store.insert({ ...reading(15, 3), resets_at: at(700).toISOString() });

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(home, "headroom.db"));
    try {
      expect(db.prepare("SELECT lease_id, overlapping_leases FROM lease_window_spend WHERE delta_percent IS NULL").all())
        .toEqual([{ lease_id: inside.id, overlapping_leases: 1 }]);
      // Persisted rows from older writers must also respect strict overlap on read.
      for (const id of [before.id, after.id]) db.prepare(`INSERT INTO lease_window_spend
        (lease_id,meter_id,window_minutes,observation_id,from_at,to_at,delta_percent,overlapping_leases)
        SELECT ?,meter_id,window_minutes,observation_id,from_at,to_at,delta_percent,overlapping_leases
        FROM lease_window_spend WHERE lease_id = ?`).run(id, inside.id);
    } finally { db.close(); }

    expect(find(store, before.id)).toMatchObject({ spend_resolution: "bounded", spent_percent: 6,
      spend_windows: [{ upper_percent: 6, overlapping_leases: 1 }] });
    expect(find(store, after.id)).toMatchObject({ spend_resolution: "bounded", spent_percent: 3,
      spend_windows: [{ upper_percent: 3, overlapping_leases: 1 }] });
    expect(store.learnedCost("review", at(20))).toMatchObject([{ median_percent: 6, sample_count: 1, basis: "upper_bound" }]);
  } finally { store.close(); }
});

it.each([false, true])("counts only trustworthy brackets when a reset overlaps two leases (valid bracket=%s)", async (valid) => {
  const { store } = await setup();
  try {
    store.insert({ ...reading(0, 0), resets_at: at(3).toISOString() });
    const first = start(store);
    if (valid) store.insert({ ...reading(1, 6), resets_at: at(3).toISOString() });
    const second = start(store, 2);
    store.insert({ ...reading(5, 0), resets_at: at(700).toISOString() });
    store.endLease(first.id, "worker", false, at(5));
    store.endLease(second.id, "worker", false, at(5));
    expect(find(store, first.id)).toMatchObject({ spend_resolution: "unresolved",
      spend_windows: [{ upper_percent: null, overlapping_leases: valid ? 1 : null }] });
    expect(find(store, second.id)).toMatchObject({ spend_resolution: "unresolved",
      spend_windows: [{ upper_percent: null, overlapping_leases: null }] });
    expect(store.learnedCost("review", at(10))).toEqual([]);
  } finally { store.close(); }
});

it("store, JSON/CSV export, MCP and learning agree, excluding unresolved samples", async () => {
  const { home, store } = await setup();
  const oldHome = process.env.HEADROOM_HOME;
  try {
    process.env.HEADROOM_HOME = home;
    store.insert(reading(0, 0));
    const exact = start(store);
    store.insert(reading(1, 10));
    store.endLease(exact.id, "worker", false, at(1));
    const bounded = start(store, 2);
    store.endLease(bounded.id, "worker", false, at(3));
    store.insert(reading(5, 16));
    const leases = store.leases(undefined, false, at(10));
    expect(store.learnedCost("review", at(10))).toMatchObject([{ median_percent: 8, sample_count: 2, basis: "upper_bound", bounded_sample_count: 1 }]);
    expect(store.learnedCostForMeter("account:all", at(10))).toMatchObject({ median_percent: 8, sample_count: 2, basis: "upper_bound", bounded_sample_count: 1 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await exportCommand(["--kind", "leases", "--since", "3650d", "--until", at(10).toISOString()]);
      expect(JSON.parse(String(log.mock.calls[0][0])).leases).toEqual(leases);
      await exportCommand(["--kind", "leases", "--format", "csv", "--out", join(home, "leases.csv"), "--since", "3650d", "--until", at(10).toISOString()]);
      expect(await readFile(join(home, "leases.csv"), "utf8")).toContain("spent_percent,spend_resolution,spent_percent_bound,spend_window_minutes,spend_windows");
    } finally { log.mockRestore(); }
    const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_lease_end", arguments: { id: bounded.id, owner: "worker" } } }), async () => undefined);
    const result = reply?.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).lease).toMatchObject({ ...leases.find((l) => l.id === bounded.id), already_ended: true });
  } finally {
    if (oldHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = oldHome;
    store.close();
  }
});

it("migrates old scalar data idempotently, preserving rows as legacy and excluding learning", async () => {
  const { home, store } = await setup();
  store.close();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(join(home, "headroom.db"));
  db.exec("DROP TABLE lease_window_spend; ALTER TABLE leases DROP COLUMN spend_version; PRAGMA user_version = 7");
  db.prepare("INSERT INTO leases (id,owner,meter_id,action_class,started_at,expires_at,ended_at) VALUES (?,?,?,?,?,?,?)")
    .run("legacy", "worker", "account:all", "review", at(0).toISOString(), at(5).toISOString(), at(5).toISOString());
  db.prepare("INSERT INTO lease_spend (lease_id,meter_id,observation_id,amount_percent,estimated,at) VALUES (?,?,?,?,?,?)")
    .run("legacy", "account:all", 1, 30, 1, at(5).toISOString());
  await runMigrations(db, async () => {});
  // The migration body is also safe if a shape was already installed.
  MIGRATIONS.at(-1)!.up(db);
  await runMigrations(db, async () => { throw new Error("unexpected migration"); });
  expect(db.prepare("SELECT amount_percent FROM lease_spend").get()).toEqual({ amount_percent: 30 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM lease_window_spend").get()).toEqual({ n: 0 });
  db.close();
  await chmod(join(home, "headroom.db"), 0o600);
  const migrated = await HeadroomStore.open(home);
  try {
    expect(migrated.leases(undefined, false, at(10))[0]).toMatchObject({ spend_resolution: "legacy", spent_percent_bound: "lower", spent_percent: 0 });
    expect(migrated.learnedCost("review", at(10))).toEqual([]);
    expect(migrated.learnedCostForMeter("account:all", at(10))).toBeUndefined();
  } finally { migrated.close(); }
});

it("requires full coverage, rejects reset gaps, and learns a measured zero only", async () => {
  const { store } = await setup();
  try {
    const lease = start(store);
    store.insert(reading(1, 0));
    store.insert(reading(2, 10));
    store.endLease(lease.id, "worker", false, at(3));
    store.insert(reading(5, 10));
    expect(find(store, lease.id)).toMatchObject({ spend_resolution: "unresolved", spent_percent_bound: "lower", spent_percent: 10 });
    expect(store.learnedCost(undefined, at(10))).toEqual([]);
    expect(store.learnedCostForMeter("account:all", at(10))).toBeUndefined();
    const reset = start(store, 5);
    store.insert({ ...reading(6, 10), resets_at: at(700).toISOString() });
    store.endLease(reset.id, "worker", false, at(6));
    expect(find(store, reset.id).spend_resolution).toBe("unresolved");
    store.insert({ ...reading(7, 10), resets_at: at(700).toISOString() });
    const zero = start(store, 7);
    store.insert({ ...reading(8, 10), resets_at: at(700).toISOString() });
    store.endLease(zero.id, "worker", false, at(8));
    expect(find(store, zero.id)).toMatchObject({ spent_percent: 0, spend_resolution: "resolved", spent_percent_bound: "exact" });
    expect(store.learnedCost(undefined, at(10))).toMatchObject([{ median_percent: 0, sample_count: 1 }]);
  } finally { store.close(); }
});

it("keeps unknown learning out of cost estimates and preserves ordinary gate decisions", async () => {
  const { store } = await setup();
  try {
    store.insert(reading(0, 80));
    const lease = start(store, 1);
    store.endLease(lease.id, "worker", false, at(2));
    // No reading after the lease: no complete bracket and no training sample.
    expect(store.learnedCost("review", at(3))).toEqual([]);
    expect(store.learnedCostForMeter("account:all", at(3))).toBeUndefined();
    expect(buildCostEstimate("review", null, store.learnedCost("review", at(3))[0], 20)).toMatchObject({
      source: "unknown", expected_percent: null, median_percent: null, sample_count: 0, max_more_before_reset: null,
    });
    for (const points of [5, 15]) {
      const needs = [{ window: "5h" as const, points }];
      const plain = gateFor(store, needs, "account:all", 10, false, at(3));
      const withUnknownClass = gateFor(store, needs, "account:all", 10, false, at(3), { actionClass: "review" });
      expect(withUnknownClass.allowed).toBe(points === 5);
      const { lanes_remaining_for_class, ...decision } = withUnknownClass;
      expect(decision).toEqual(plain);
      if (plain.allowed) expect(lanes_remaining_for_class).toBeNull();
    }
  } finally { store.close(); }
});

it("uses one duration consistently when fixed and rolling presentations coexist, excluding soft windows", async () => {
  const { store } = await setup();
  try {
    store.insert(reading(0, 0, 300, "fixed"));
    store.insert(reading(0, 0, 300, "rolling"));
    store.insert({ ...reading(0, 0, 60), window: { kind: "fixed", minutes: 60, enforcement: "soft" } });
    const lease = start(store);
    store.insert(reading(5, 10, 300, "fixed"));
    store.insert(reading(5, 10, 300, "rolling"));
    store.insert({ ...reading(5, 40, 60), window: { kind: "fixed", minutes: 60, enforcement: "soft" } });
    const ended = store.endLease(lease.id, "worker", false, at(5));
    expect(ended).toMatchObject({ spent_percent: 10, spend_resolution: "resolved", spend_window_minutes: 300 });
    expect(ended.spend_windows).toHaveLength(1);
    expect(store.learnedCost("review", at(10))).toMatchObject([{ median_percent: 10, sample_count: 1 }]);
  } finally { store.close(); }
});

it.each([[0, 5], [0, 1], [1, 5]])("does not resolve conflicting readings at the same observation timestamp for lease [%s, %s]", async (from, to) => {
  const { store } = await setup();
  try {
    store.insert(reading(0, 0));
    const lease = start(store, from);
    store.insert(reading(1, 5));
    store.insert({ ...reading(1, 10), fetched_at: at(2).toISOString() });
    store.insert(reading(5, 15));
    store.endLease(lease.id, "worker", false, at(to));
    expect(find(store, lease.id)).toMatchObject({ spend_resolution: "unresolved", spent_percent_bound: "lower" });
    expect(store.learnedCost("review", at(10))).toEqual([]);
  } finally { store.close(); }
});
