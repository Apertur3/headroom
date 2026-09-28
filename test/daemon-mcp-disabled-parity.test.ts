import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import { cacheCan, handleMcp } from "../src/mcp.js";
import { HeadroomStore } from "../src/store.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
  try { return await run(); } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

/**
 * Routes an MCP `call` straight through a real (unstarted -- no socket, no
 * bind, no sandbox EPERM concerns; handleLine() is the private method the
 * daemon's own socket handler calls) HeadroomDaemon, converting a JSON-RPC
 * error reply into the same `{jsonrpc, error}` envelope the real socket
 * transport would hand back, so handleMcp's own error-propagation logic
 * (finding #5) still applies exactly as it does against a live daemon.
 */
function daemonCallVia(daemon: HeadroomDaemon) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const reply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    if (reply.error) return { jsonrpc: "2.0", id: 1, error: reply.error };
    return reply.result;
  };
}

/**
 * Strips the fields that are *documented* to differ between the two paths
 * (never a parity bug): `generated_at`/`contract` are per-call envelope
 * stamps, `source` is present only on the direct path (absent when
 * daemon-backed -- docs/json-contract.md's "MCP quota_X adds source?:
 * 'direct'"), and `host` is a live, independently-sampled machine reading
 * (checked separately, only for presence).
 */
function stableFields(value: Record<string, unknown>): Record<string, unknown> {
  const { generated_at: _generatedAt, contract: _contract, source: _source, daemon: _daemon, host: _host, ...rest } = value;
  return rest;
}

function structuredContentOf(response: Record<string, unknown> | undefined): Record<string, unknown> {
  return (response?.result as { structuredContent: Record<string, unknown> }).structuredContent;
}

const DISABLED_ACCOUNTS_TOML = ['[[accounts]]', 'name = "claude-2"', 'enabled = false', 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ''].join("\n");
const ROUTING_TOML = ['[consumes]', 'parked = ["claude-2:all"]', ''].join("\n");

async function seedDisabledReading(home: string): Promise<void> {
  const store = await HeadroomStore.open(home);
  try {
    const now = new Date();
    store.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(now.getTime() + 3_600_000).toISOString(), observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" });
  } finally { store.close(); }
}

describe("daemon RPC and direct MCP path agree on a disabled meter", () => {
  it("unscoped quota_rate and quota_gate ignore disabled-only historical capacity", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-parity-unscoped-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    await seedDisabledReading(home);
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withHome(home, async () => {
        const rateLine = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_rate", arguments: {} } });
        expect(stableFields(structuredContentOf(await handleMcp(rateLine, daemonCallVia(daemon))))).toEqual({ lines: [] });
        expect(stableFields(structuredContentOf(await handleMcp(rateLine, async () => undefined)))).toEqual({ lines: [] });

        const gateLine = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quota_gate", arguments: { needs: ["5h:1"] } } });
        const daemonResult = structuredContentOf(await handleMcp(gateLine, daemonCallVia(daemon)));
        const directResult = structuredContentOf(await handleMcp(gateLine, async () => undefined));
        expect(stableFields(daemonResult)).toEqual(stableFields(directResult));
        expect(stableFields(daemonResult)).toEqual({ allowed: false, reason: "no meters configured", meters_checked: [], notices: [] });
      });
    } finally { await daemon.stop().catch(() => undefined); }
  });

  it("quota_rate: same lines: [RateLine] with a reason from both paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-parity-rate-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withHome(home, async () => {
        const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_rate", arguments: { meter: "claude-2:all" } } });
        const daemonShape = stableFields(structuredContentOf(await handleMcp(line, daemonCallVia(daemon))));
        const directShape = stableFields(structuredContentOf(await handleMcp(line, async () => undefined)));
        expect(daemonShape).toEqual(directShape);
        expect(daemonShape).toEqual({ lines: [expect.objectContaining({ meter: "claude-2:all", reason: expect.stringContaining("disabled") })] });
      });
    } finally { await daemon.stop().catch(() => undefined); }
  });

  it("quota_plan: same { meter, error, notices } from both paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-parity-plan-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withHome(home, async () => {
        const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_plan", arguments: { meter: "claude-2:all" } } });
        const daemonShape = stableFields(structuredContentOf(await handleMcp(line, daemonCallVia(daemon))));
        const directShape = stableFields(structuredContentOf(await handleMcp(line, async () => undefined)));
        expect(daemonShape).toEqual(directShape);
        expect(daemonShape).toEqual({ meter: "claude-2:all", error: expect.stringContaining("disabled"), notices: [] });
      });
    } finally { await daemon.stop().catch(() => undefined); }
  });

  it("quota_fill: same { meter, error, notices } from both paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-parity-fill-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withHome(home, async () => {
        const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_fill", arguments: { meter: "claude-2:all" } } });
        const daemonShape = stableFields(structuredContentOf(await handleMcp(line, daemonCallVia(daemon))));
        const directShape = stableFields(structuredContentOf(await handleMcp(line, async () => undefined)));
        expect(daemonShape).toEqual(directShape);
        expect(daemonShape).toEqual({ meter: "claude-2:all", error: expect.stringContaining("disabled"), notices: [] });
      });
    } finally { await daemon.stop().catch(() => undefined); }
  });

  it("quota_gate: same refused GateOutcome from both paths (host checked separately: a live, independently-sampled reading)", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-parity-gate-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    await writeFile(join(home, "routing.toml"), ROUTING_TOML, { mode: 0o600 });
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withHome(home, async () => {
        const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_gate", arguments: { needs: ["5h:1"], meter: "claude-2:all", owner: "test" } } });
        const daemonResponse = structuredContentOf(await handleMcp(line, daemonCallVia(daemon)));
        const directResponse = structuredContentOf(await handleMcp(line, async () => undefined));
        expect(stableFields(daemonResponse)).toEqual(stableFields(directResponse));
        expect(stableFields(daemonResponse)).toEqual({ allowed: false, unknown: true, reason: expect.stringContaining("disabled"), meters_checked: ["claude-2:all"], notices: [] });
        expect(daemonResponse.host).toBeDefined();
        expect(directResponse.host).toBeDefined();
      });
    } finally { await daemon.stop().catch(() => undefined); }
  });

  it("quota_can uses the same disabled refusal wrapper and unknown cost in daemon, direct, and cached paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-parity-can-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    await writeFile(join(home, "routing.toml"), ROUTING_TOML, { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try {
      const lease = store.startLease("test", "claude-2:all", null, 60_000, null, new Date(), "parked");
      store.endLease(lease.id, "test");
    } finally { store.close(); }
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withHome(home, async () => {
        const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_can", arguments: { action_class: "parked", owner: "test" } } });
        const daemonResult = stableFields(structuredContentOf(await handleMcp(line, daemonCallVia(daemon))));
        const directResult = stableFields(structuredContentOf(await handleMcp(line, async () => undefined)));
        const cachedResult = stableFields(await cacheCan("parked", false, "test", null));
        expect(daemonResult).toEqual(directResult);
        expect(daemonResult).toEqual(cachedResult);
        expect(daemonResult).toMatchObject({ decision: { allowed: false, meter: "claude-2:all", reason: expect.stringContaining("disabled") }, cost: { source: "unknown", expected_percent: null, sample_count: 0 }, leased_id: null });
      });
    } finally { await daemon.stop().catch(() => undefined); }
  });
});
