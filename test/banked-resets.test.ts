import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { HeadroomDaemon, socketPath } from "../src/daemon.js";
import { handleMcp } from "../src/mcp.js";
import { gateFor, planFor, routeFor } from "../src/orchestrator-reads.js";
import { canConsume, canRoute, defaultPolicy } from "../src/policy.js";
import { formatMeters } from "../src/status-view.js";
import { HeadroomStore } from "../src/store.js";
import { creditsLapsed, parseCreditExpiry } from "../src/credits.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";
import type { Observation, ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function home(label = "banked"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `headroom-${label}-`));
  temporary.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "accounts.toml"), [
    "[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/synthetic/claude"', 'adapter = "native-ts"', "",
    "[[accounts]]", 'name = "codex-main"', 'vendor = "codex"', 'location = "/synthetic/codex"', 'adapter = "native-ts"', "",
  ].join("\n"), { mode: 0o600 });
  return root;
}

async function withHome<T>(value: string, run: () => Promise<T>): Promise<T> {
  const prior = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = value;
  try { return await run(); }
  finally { if (prior === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = prior; }
}

function percent(principal: string, meter: string, minutes: number, used: number, now: Date, resetsAt: string): Observation {
  const at = now.toISOString();
  return {
    principal_id: principal, meter_id: `${principal}:${meter}`, window: { kind: minutes === 10_080 ? "fixed" : "rolling", minutes, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: at, fetched_at: at, source: "fixture", truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function vendorCredits(principal: string, available: number, expiresAt: string, now: Date): Observation {
  const at = now.toISOString();
  return {
    principal_id: principal, meter_id: `${principal}:credits`, window: { kind: "count", minutes: null, enforcement: "hard" },
    quantity: { used: 0, limit: null, remaining: available, unit: "credits" }, resets_at: expiresAt,
    observed_at: at, fetched_at: at, source: "native:codex", truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "fixture", upstream_schema_version: "fixture", metadata: { free_resets_available: available },
  };
}

describe("manual banked-reset storage", () => {
  it("keeps an auditable manual row, emits an inferred credits change, yields to a later vendor fact, and ignores a later failed poll", async () => {
    const value = await home("banked-store");
    const store = await HeadroomStore.open(value);
    try {
      const now = new Date();
      const expires = new Date(now.getTime() + 48 * 3_600_000).toISOString();
      const manual = store.recordManualCredits("claude-main", 2, expires, false, now);
      expect(manual).toMatchObject({ meter_id: "claude-main:credits", source: "manual", truth: "estimated", freshness: "fresh", confidence: 0.9, adapter_version: "manual", metadata: { free_resets_available: 2, manual: true } });
      expect(store.events(new Date(now.getTime() - 1_000).toISOString())).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "credits_changed", origin: "inferred", confidence: 0.9, reason: "manual credits entry" }),
      ]));

      const failedAt = new Date(now.getTime() + 1_000).toISOString();
      store.insert({ ...vendorCredits("claude-main", 0, expires, new Date(failedAt)), window: null, quantity: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "fixture poll failed" });
      expect(store.latestPerWindow("claude-main:credits").find((row) => row.quantity?.unit === "credits")).toMatchObject({ source: "manual", quantity: { remaining: 2 } });

      store.insert(vendorCredits("claude-main", 1, expires, new Date(now.getTime() + 2_000)));
      expect(store.latestPerWindow("claude-main:credits").find((row) => row.quantity?.unit === "credits")).toMatchObject({ source: "native:codex", quantity: { remaining: 1 } });
    } finally { store.close(); }
  });

  it("clears with a zero-valued manual history row and treats an expired count as zero without rewriting it", async () => {
    const value = await home("banked-clear");
    const store = await HeadroomStore.open(value);
    try {
      const now = new Date();
      const expires = new Date(now.getTime() + 3_600_000).toISOString();
      store.recordManualCredits("claude-main", 1, expires, false, now);
      store.clearManualCredits("claude-main", new Date(now.getTime() + 1_000));
      // A clear is a current fact ("the balance is zero now"), not a stale
      // reading; only metadata.manual_cleared marks it for ranking/exclusion.
      expect(store.latestPerWindow("claude-main:credits")[0]).toMatchObject({ source: "manual", freshness: "fresh", quantity: { remaining: 0 }, metadata: { manual: true, manual_cleared: true } });
      expect(store.history("claude-main:credits", new Date(now.getTime() - 1_000).toISOString())).toHaveLength(2);

      const lapsedExpires = new Date(now.getTime() + 2_000).toISOString();
      store.recordManualCredits("codex-main", 1, lapsedExpires, false, now);
      expect(store.credits(new Date(now.getTime() + 3_000)).find((row) => row.meter === "codex-main:credits")).toMatchObject({ available: 0, lapsed: true, expires_at: lapsedExpires });
      expect(store.latestPerWindow("codex-main:credits")[0].quantity?.remaining).toBe(1);
    } finally { store.close(); }
  });

  it("keeps an unexpired manual credit over a reopened store and failures after an hour, but not after clear or expiry", async () => {
    const value = await home("banked-manual-authority");
    const now = new Date();
    const enteredAt = new Date(now.getTime() - 2 * 3_600_000);
    const future = new Date(now.getTime() + 24 * 3_600_000).toISOString();
    let store = await HeadroomStore.open(value);
    try { store.recordManualCredits("claude-main", 2, future, false, enteredAt); }
    finally { store.close(); }

    store = await HeadroomStore.open(value);
    try {
      store.insert({ ...vendorCredits("claude-main", 0, future, now), window: null, quantity: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "fixture poll failed" });
      expect(store.latestPerWindow("claude-main:credits")[0]).toMatchObject({ source: "manual", quantity: { remaining: 2 } });

      store.clearManualCredits("claude-main", new Date(now.getTime() + 1_000));
      store.insert({ ...vendorCredits("claude-main", 0, future, new Date(now.getTime() + 2_000)), window: null, quantity: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "fixture poll failed" });
      expect(store.latestPerWindow("claude-main:credits")[0]).toMatchObject({ freshness: "failed" });
    } finally { store.close(); }

    store = await HeadroomStore.open(value);
    try {
      const expired = new Date(now.getTime() - 1_000).toISOString();
      store.recordManualCredits("codex-main", 1, expired, false, enteredAt);
      store.insert({ ...vendorCredits("codex-main", 0, expired, new Date(now.getTime() + 3_000)), window: null, quantity: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "fixture poll failed" });
      expect(store.latestPerWindow("codex-main:credits")[0]).toMatchObject({ freshness: "failed" });
    } finally { store.close(); }
  });
});

describe("reset-aware plans", () => {
  async function planned(options: { used?: number; reserve?: number; credits?: number; expiresOffset?: number; target?: number; resetOffset?: number } = {}) {
    const value = await home("banked-plan");
    const store = await HeadroomStore.open(value);
    const now = new Date("2026-10-01T12:00:00Z");
    const reset = new Date(now.getTime() + (options.resetOffset ?? 48 * 3_600_000)).toISOString();
    store.insert(percent("claude-main", "all", 300, 0, now, new Date(now.getTime() + 5 * 3_600_000).toISOString()));
    store.insert(percent("claude-main", "all", 10_080, options.used ?? 40, now, reset));
    if (options.credits !== undefined) store.recordManualCredits("claude-main", options.credits, new Date(now.getTime() + (options.expiresOffset ?? 72 * 3_600_000)).toISOString(), false, now);
    const result = planFor(store, "claude-main:all", options.reserve ?? 10, now, 15, {}, undefined, options.target);
    store.close();
    return result;
  }

  it("reports target arithmetic, the reserve-derived worth, and the no-credits advice", async () => {
    const result = await planned({ reserve: 20, target: 220 });
    expect(result).toMatchObject({ usable_now_percent: 40, banked: { available: 0, worth_percent: 80, source: null, lapsed: false }, target: { points: 220, fits_now: false, fits_with_banked: false, resets_needed: 3 }, advice: { use_now: false, reason: "no banked reset available" } });
  });

  it("advises use before an expiring reset is lost", async () => {
    const result = await planned({ credits: 1, expiresOffset: 3_600_000 });
    expect(result).toMatchObject({ banked: { available: 1, source: "manual" }, advice: { use_now: true, use_before: "2026-10-01T13:00:00.000Z", reason: "expires 2026-10-01T13:00:00.000Z before the scheduled reset 2026-10-03T12:00:00.000Z; it is lost otherwise" } });
  });

  it("advises use for a blocked target more than a day away", async () => {
    const result = await planned({ used: 80, credits: 1, target: 20 });
    expect(result).toMatchObject({ target: { fits_now: false, fits_with_banked: true, resets_needed: 1 }, advice: { use_now: true, reason: "the target does not fit in what is left and the reset is 48 h away" } });
  });

  it("says a target that already fits does not need a banked reset", async () => {
    const result = await planned({ credits: 1, target: 20 });
    expect(result).toMatchObject({ target: { fits_now: true, fits_with_banked: true, resets_needed: 0 }, advice: { use_now: false, reason: "the queued work fits without it" } });
  });

  it("waits when the scheduled reset is within a day and there is no target otherwise", async () => {
    const near = await planned({ used: 80, credits: 1, target: 20, resetOffset: 24 * 3_600_000 });
    expect(near).toMatchObject({ advice: { use_now: false, reason: "reset in 24 h; wait for it" } });
    const untargeted = await planned({ credits: 1 });
    expect(untargeted).toMatchObject({ advice: { use_now: false, reason: "no target given; nothing is blocked" } });
  });

  it("counts a lapsed reset as zero and preserves an explicit no-credits result", async () => {
    const lapsed = await planned({ credits: 2, expiresOffset: -3_600_000, target: 20 });
    expect(lapsed).toMatchObject({ banked: { available: 0, lapsed: true }, advice: { reason: "the banked reset has lapsed" } });
    const none = await planned();
    expect(none).toMatchObject({ banked: { available: 0, expires_at: null, source: null, lapsed: false } });
  });

  it("does not turn a money balance, non-fresh vendor count, or held vendor count into banked reset capacity", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const reset = new Date(now.getTime() + 48 * 3_600_000).toISOString();
    const expiry = new Date(now.getTime() + 72 * 3_600_000).toISOString();
    const cases: Array<[string, Observation]> = [
      ["money balance", { ...vendorCredits("claude-main", 1, expiry, now), metadata: {} }],
      ["stale vendor reset", vendorCredits("claude-main", 1, expiry, new Date(now.getTime() - 16 * 60_000))],
      ["not-enforced vendor reset", { ...vendorCredits("claude-main", 1, expiry, now), freshness: "not_enforced" }],
      ["held vendor reset", { ...vendorCredits("claude-main", 1, expiry, now), metadata: { free_resets_available: 1, vendor_window_held: true } }],
    ];
    for (const [label, credit] of cases) {
      const value = await home(`banked-${label.replaceAll(" ", "-")}`);
      const store = await HeadroomStore.open(value);
      try {
        store.insert(percent("claude-main", "all", 300, 0, now, new Date(now.getTime() + 5 * 3_600_000).toISOString()));
        store.insert(percent("claude-main", "all", 10_080, 80, now, reset));
        store.insert(credit);
        expect(planFor(store, "claude-main:all", 10, now, 15, {}, undefined, 20)).toMatchObject({ banked: { available: 0, source: null, lapsed: false }, target: { fits_with_banked: false } });
      } finally { store.close(); }
    }
  });

  it("reports reserve-100 banked targets as impossible and never advises spending a zero-worth reset", async () => {
    const blocked = await planned({ used: 80, reserve: 100, credits: 1, target: 20 });
    expect(blocked).toMatchObject({ banked: { available: 1, worth_percent: 0 }, target: { fits_now: false, fits_with_banked: false, resets_needed: null }, advice: { use_now: false, reason: "the reserve leaves no usable capacity per banked reset" } });
    const expiring = await planned({ reserve: 100, credits: 1, expiresOffset: 3_600_000 });
    expect(expiring).toMatchObject({ banked: { available: 1, worth_percent: 0 }, advice: { use_now: false, reason: "the reserve leaves no usable capacity per banked reset" } });
  });
});

describe("count meters never dispatch", () => {
  it("refuses count meters through can, route, and gate even with allow_unknown", async () => {
    const value = await home("banked-count-dispatch");
    const now = new Date("2026-10-01T12:00:00Z");
    const credit = vendorCredits("claude-main", 1, new Date(now.getTime() + 48 * 3_600_000).toISOString(), now);
    const account: ProviderAccount = { name: "claude-main", vendor: "claude", location: "/synthetic/claude", adapter: "native-ts" };
    const can = canConsume([credit.meter_id], new Map([[credit.meter_id, credit]]), defaultPolicy, true, now);
    expect(can).toMatchObject({ allowed: false, state: "UNKNOWN", reason: "count meter claude-main:credits cannot be used for dispatch" });
    const local: Observation = {
      ...credit, principal_id: "local", meter_id: "local:capacity", window: { kind: "state", minutes: null, enforcement: "soft" },
      quantity: { used: 0, limit: null, remaining: null, unit: "requests" }, metadata: { state: "UP" },
    };
    expect(canRoute([credit.meter_id], [local.meter_id], new Map([[credit.meter_id, credit], [local.meter_id, local]]), "prefer", defaultPolicy, true, now)).toMatchObject({ allowed: false, meter: credit.meter_id, local_meter_considered: false });
    const store = await HeadroomStore.open(value);
    try {
      store.insert(credit);
      expect(gateFor(store, [{ window: "5h", points: 1 }], credit.meter_id, 10, false, now)).toMatchObject({ allowed: false, reason: "count meter claude-main:credits cannot be used for dispatch" });
      expect(routeFor(store, [credit.meter_id], [account], defaultPolicy, true, now)).toMatchObject({ principal: null, candidates: [expect.objectContaining({ state: "UNKNOWN", remaining_percent: null })] });
    } finally { store.close(); }
  });

  it("skips a credits meter during an omitted-meter global gate instead of refusing every account, but still refuses it when explicitly targeted", async () => {
    const value = await home("banked-count-global-gate");
    const now = new Date("2026-10-01T12:00:00Z");
    const store = await HeadroomStore.open(value);
    try {
      store.insert(percent("claude-main", "all", 300, 10, now, new Date(now.getTime() + 5 * 3_600_000).toISOString()));
      store.insert(percent("claude-main", "all", 10_080, 20, now, new Date(now.getTime() + 48 * 3_600_000).toISOString()));
      store.insert(vendorCredits("claude-main", 1, new Date(now.getTime() + 48 * 3_600_000).toISOString(), now));
      // No --meter/--class at all: the credits meter is inferred as a
      // candidate alongside the percent one but must be silently skipped,
      // not treated as a global refusal.
      expect(gateFor(store, [{ window: "5h", points: 1 }], undefined, 10, false, now)).toMatchObject({ allowed: true, meters_checked: ["claude-main:all"] });
      // Named explicitly (a --meter or a --class resolved to it), the same
      // credits meter still refuses.
      expect(gateFor(store, [{ window: "5h", points: 1 }], "claude-main:credits", 10, false, now)).toMatchObject({ allowed: false, reason: "count meter claude-main:credits cannot be used for dispatch" });
      expect(gateFor(store, [{ window: "5h", points: 1 }], ["claude-main:all", "claude-main:credits"], 10, false, now)).toMatchObject({ allowed: false, reason: "count meter claude-main:credits cannot be used for dispatch" });
    } finally { store.close(); }
  });
});

describe("credits CLI, daemon RPC, MCP and status", () => {
  it("sets, lists and clears manual credits directly, and rejects unknown principals and invalid expiries", async () => {
    const value = await home("banked-cli");
    const expires = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      await withHome(value, async () => {
        expect(await main(["credits", "set", "--principal", "claude-main", "--available", "2", "--expires", expires, "--json"])).toBe(0);
        expect(await main(["credits", "--json"])).toBe(0);
        expect(await main(["credits", "clear", "--principal", "claude-main"])).toBe(0);
        await expect(main(["credits", "set", "--principal", "missing", "--available", "1", "--expires", expires])).rejects.toThrow("unknown principal: missing");
        await expect(main(["credits", "set", "--principal", "claude-main", "--available", "1", "--expires", "not-a-date"])).rejects.toThrow("--expires must be YYYY-MM-DD or an ISO instant");
      });
    } finally { spy.mockRestore(); }
    expect(JSON.parse(logs[0])).toMatchObject({ credit: { meter: "claude-main:credits", available: 2, source: "manual" } });
    expect(JSON.parse(logs[1])).toMatchObject({ credits: [expect.objectContaining({ meter: "claude-main:credits", available: 2, source: "manual" })] });
    expect(logs[2]).toContain("0 available");
  });

  it("keeps direct and daemon credits writes aligned, including authenticated RPC dispatch and quota_plan target_points", async () => {
    const value = await home("banked-rpc");
    const expires = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    await withHome(value, async () => {
      await main(["credits", "set", "--principal", "claude-main", "--available", "1", "--expires", expires, "--json"]);
      const direct = JSON.parse(logs.pop()!);
      const daemon = await HeadroomDaemon.create({ home: value, path: socketPath(value), poller: async () => ({ observations: [], failures: [] }) });
      try { await daemon.start(); }
      catch (error: unknown) {
        await daemon.stop();
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      try {
        const reply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "credits_set", params: { principal: "claude-main", available: 1, expires } }));
        expect(reply).toMatchObject({ result: { meter: "claude-main:credits", available: 1, source: "manual" } });
        await main(["credits", "set", "--principal", "claude-main", "--available", "1", "--expires", expires, "--json"]);
        const throughDaemon = JSON.parse(logs.pop()!);
        expect(throughDaemon.credit).toEqual(direct.credit);
      } finally { await daemon.stop(); }

      const store = await HeadroomStore.open(value);
      const now = new Date();
      store.insert(percent("claude-main", "all", 300, 0, now, new Date(now.getTime() + 5 * 3_600_000).toISOString()));
      store.insert(percent("claude-main", "all", 10_080, 80, now, new Date(now.getTime() + 48 * 3_600_000).toISOString()));
      store.close();
      const noDaemon = async () => undefined;
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_plan","arguments":{"meter":"claude-main:all","target_points":20}}}', noDaemon);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", target: { points: 20, fits_now: false }, banked: { available: 1 } } } });
      const invalid = await handleMcp('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quota_plan","arguments":{"meter":"claude-main:all","target_points":-1}}}', noDaemon);
      expect(invalid).toMatchObject({ error: { code: -32602, message: "target_points must be at least 0" } });
    });
    spy.mockRestore();
  });

  it("audits credits_set and credits_clear exactly once each through the daemon RPC path (not doubled by the case-local and common audit)", async () => {
    const value = await home("banked-rpc-audit");
    const expires = new Date(Date.now() + 48 * 3_600_000).toISOString();
    await withHome(value, async () => {
      const daemon = await HeadroomDaemon.create({ home: value, path: socketPath(value), poller: async () => ({ observations: [], failures: [] }) });
      try { await daemon.start(); }
      catch (error: unknown) {
        await daemon.stop();
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      try {
        const setReply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "credits_set", params: { principal: "claude-main", available: 1, expires } }));
        expect(setReply).toMatchObject({ result: { meter: "claude-main:credits", available: 1 } });
        const clearReply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "credits_clear", params: { principal: "claude-main" } }));
        expect(clearReply).toMatchObject({ result: { meter: "claude-main:credits", available: 0 } });
      } finally { await daemon.stop(); }
    });

    const store = await HeadroomStore.open(value);
    try {
      const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
      const setRows = db.prepare("SELECT * FROM audit WHERE action = 'credits_set' AND meter_or_principal = 'claude-main'").all();
      const clearRows = db.prepare("SELECT * FROM audit WHERE action = 'credits_clear' AND meter_or_principal = 'claude-main'").all();
      expect(setRows).toHaveLength(1);
      expect(clearRows).toHaveLength(1);
      expect(setRows[0]).toMatchObject({ outcome: "ok" });
      expect(clearRows[0]).toMatchObject({ outcome: "ok" });
    } finally { store.close(); }
  });

  it("marks manual credits in status and renders them expired after their expiry", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const future = { ...vendorCredits("claude-main", 1, "2026-10-02T12:00:00Z", now), source: "manual", truth: "estimated", confidence: 0.9, adapter_version: "manual", metadata: { free_resets_available: 1, manual: true } };
    const past = { ...future, resets_at: "2026-09-30T12:00:00Z" };
    expect(formatMeters([future], defaultPolicy, new Map(), new Map(), new Map(), now)[0]).toContain("credits 1 available (expires Oct 2) (manual)");
    expect(formatMeters([past], defaultPolicy, new Map(), new Map(), new Map(), now)[0]).toContain("credits 1 expired Sep 30 (manual)");
  });

  it("rejects an ISO instant with an impossible calendar date instead of silently normalizing it forward, with both Z and an offset", () => {
    // 2026 is not a leap year, so Feb has 28 days; Date.parse would otherwise
    // silently roll 2026-02-30 forward into March, extending a manual
    // banked-reset expiry past what the operator actually typed.
    expect(() => parseCreditExpiry("2026-02-30T00:00:00Z")).toThrow("--expires must be YYYY-MM-DD or an ISO instant");
    expect(() => parseCreditExpiry("2026-02-30T00:00:00+02:00")).toThrow("--expires must be YYYY-MM-DD or an ISO instant");
    // April only has 30 days.
    expect(() => parseCreditExpiry("2026-04-31T00:00:00Z")).toThrow("--expires must be YYYY-MM-DD or an ISO instant");
    // 2026 is not a leap year: Feb 29 does not exist that year, but it does
    // in 2028 -- the check is a real leap-year calculation, not a fixed cap.
    expect(() => parseCreditExpiry("2026-02-29T00:00:00Z")).toThrow("--expires must be YYYY-MM-DD or an ISO instant");
    expect(parseCreditExpiry("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    // A genuine last-of-month date, with both suffix forms, still parses.
    expect(parseCreditExpiry("2026-02-28T00:00:00Z")).toBe("2026-02-28T00:00:00.000Z");
    expect(parseCreditExpiry("2026-04-30T12:00:00+02:00")).toBe(new Date("2026-04-30T12:00:00+02:00").toISOString());
  });

  it("uses UTC calendar dates for date-only expiry input in every local timezone and lapses at the exact instant", () => {
    const previous = process.env.TZ;
    try {
      for (const timezone of ["UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
        process.env.TZ = timezone;
        const expiry = parseCreditExpiry("2026-10-05");
        const observation = { ...vendorCredits("claude-main", 1, expiry, new Date("2026-10-01T12:00:00Z")), source: "manual", metadata: { manual: true, free_resets_available: 1 } };
        expect(expiry).toBe("2026-10-05T00:00:00.000Z");
        expect(creditsLapsed(observation, new Date(expiry))).toBe(true);
        expect(formatMeters([observation], defaultPolicy, new Map(), new Map(), new Map(), new Date("2026-10-04T12:00:00Z"))[0]).toContain("expires Oct 5");
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });

  it("adds credits_lapsed only to an enriched status JSON row", async () => {
    const value = await home("banked-status-json");
    await writeFile(join(value, "accounts.toml"), "", { mode: 0o600 }); // avoid a direct status poll
    const store = await HeadroomStore.open(value);
    const now = new Date();
    store.recordManualCredits("claude-main", 1, new Date(now.getTime() - 1_000).toISOString(), false, now);
    store.close();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try { await withHome(value, () => main(["--json"])); }
    finally { spy.mockRestore(); }
    const observation = JSON.parse(logs[0]).observations.find((row: { meter_id: string }) => row.meter_id === "claude-main:credits");
    expect(observation).toMatchObject({ credits_lapsed: true, quantity: { remaining: 1 } });
  });
});
