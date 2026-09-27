import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { HeadroomDaemon } from "../src/daemon.js";
import { handleMcp } from "../src/mcp.js";
import { planFor } from "../src/orchestrator-reads.js";
import { defaultPolicy } from "../src/policy.js";
import { formatMeters } from "../src/status-view.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

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
      expect(store.latestPerWindow("claude-main:credits")[0]).toMatchObject({ source: "manual", quantity: { remaining: 0 }, metadata: { manual: true, manual_cleared: true } });
      expect(store.history("claude-main:credits", new Date(now.getTime() - 1_000).toISOString())).toHaveLength(2);

      const lapsedExpires = new Date(now.getTime() + 2_000).toISOString();
      store.recordManualCredits("codex-main", 1, lapsedExpires, false, now);
      expect(store.credits(new Date(now.getTime() + 3_000)).find((row) => row.meter === "codex-main:credits")).toMatchObject({ available: 0, lapsed: true, expires_at: lapsedExpires });
      expect(store.latestPerWindow("codex-main:credits")[0].quantity?.remaining).toBe(1);
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
});

describe("credits CLI, daemon RPC, MCP and status", () => {
  it("sets, lists and clears manual credits directly, and rejects unknown principals and invalid expiries", async () => {
    const value = await home("banked-cli");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      await withHome(value, async () => {
        expect(await main(["credits", "set", "--principal", "claude-main", "--available", "2", "--expires", "2026-10-05", "--json"])).toBe(0);
        expect(await main(["credits", "--json"])).toBe(0);
        expect(await main(["credits", "clear", "--principal", "claude-main"])).toBe(0);
        await expect(main(["credits", "set", "--principal", "missing", "--available", "1", "--expires", "2026-10-05"])).rejects.toThrow("unknown principal: missing");
        await expect(main(["credits", "set", "--principal", "claude-main", "--available", "1", "--expires", "not-a-date"])).rejects.toThrow("--expires must be YYYY-MM-DD or an ISO instant");
      });
    } finally { spy.mockRestore(); }
    expect(JSON.parse(logs[0])).toMatchObject({ credit: { meter: "claude-main:credits", available: 2, source: "manual" } });
    expect(JSON.parse(logs[1])).toMatchObject({ credits: [expect.objectContaining({ meter: "claude-main:credits", available: 2, source: "manual" })] });
    expect(logs[2]).toContain("0 available");
  });

  it("accepts the same credits write through the daemon RPC and quota_plan target_points", async () => {
    const value = await home("banked-rpc");
    await withHome(value, async () => {
      const daemon = await HeadroomDaemon.create({ home: value, path: join(value, "banked.sock"), poller: async () => ({ observations: [], failures: [] }) });
      const internal = daemon as unknown as { handleLine(line: string): Promise<{ replyLine: string }> };
      try {
        const reply = JSON.parse((await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "credits_set", params: { principal: "claude-main", available: 1, expires: "2026-10-05" } }))).replyLine);
        expect(reply).toMatchObject({ result: { meter: "claude-main:credits", available: 1, source: "manual" } });
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
  });

  it("marks manual credits in status and renders them expired after their expiry", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const future = { ...vendorCredits("claude-main", 1, "2026-10-02T12:00:00Z", now), source: "manual", truth: "estimated", confidence: 0.9, adapter_version: "manual", metadata: { free_resets_available: 1, manual: true } };
    const past = { ...future, resets_at: "2026-09-30T12:00:00Z" };
    expect(formatMeters([future], defaultPolicy, new Map(), new Map(), new Map(), now)[0]).toContain("credits 1 available (expires Oct 2) (manual)");
    expect(formatMeters([past], defaultPolicy, new Map(), new Map(), new Map(), now)[0]).toContain("credits 1 expired Sep 30 (manual)");
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
