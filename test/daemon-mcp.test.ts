import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeGrantNeededReason } from "../src/adapters/claude.js";
import { daemonRequest, rpc, HeadroomDaemon } from "../src/daemon.js";
import { directStatus, handleMcp } from "../src/mcp.js";
import { canConsume, defaultPolicy, paceState } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function fixture(): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-03T13:00:00Z",
    observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

describe("daemon JSON-RPC", () => {
  it("keeps a warm local Antigravity read running while its remote source is backed off", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-warm-")); temporary.push(root);
    const options: Array<Record<string, unknown> | undefined> = [];
    const keepalive = { running: true, pid: 17, uptimeMs: 2_000, start() {}, stop() {} } as never;
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), keepalive, poller: async (_principal, option) => {
      options.push(option as Record<string, unknown> | undefined);
      return { observations: [], failures: [], antigravityLocal: { antigravity: { outcome: "failed", payload_kind: "placeholder", at: "2026-09-03T12:00:00Z" } } };
    } });
    const internal = daemon as unknown as { backoff: Map<string, { failures: number; until: number }>; poll(principal: string | undefined, forced: boolean): Promise<unknown>; antigravityLocal: Map<string, unknown> };
    internal.backoff.set("all", { failures: 1, until: Date.now() + 60_000 });
    await internal.poll(undefined, false);
    expect(options).toEqual([expect.objectContaining({ daemonOwnsAntigravity: true, skipRemoteAntigravity: true })]);
    expect(internal.antigravityLocal.get("antigravity")).toMatchObject({ outcome: "failed", payload_kind: "placeholder" });
    await daemon.stop();
  });

  it("never spawns the Claude probe in the poll path once a keychain grant marker exists for the principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-grant-gate-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "accounts.toml"), [
      "[[accounts]]",
      'name = "claude-main"',
      'vendor = "claude"',
      'location = "/nonexistent/.claude"',
      'adapter = "native-ts"',
      "",
    ].join("\n"), { mode: 0o600 });
    await withHeadroomHome(root, async () => {
      const seed = await HeadroomStore.open(root);
      seed.setKeychainGrantNeeded("claude-main", "Keychain access denied");
      seed.close();
      // The default (real) poller, not an injected fake: this exercises the
      // actual collector gate end to end through the daemon's own poll path.
      const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
      const internal = daemon as unknown as { poll(principal: string | undefined, forced: boolean): Promise<{ observations: Observation[] } | { rate_limited: true }> };
      const result = await internal.poll(undefined, true);
      const observations = (result as { observations: Observation[] }).observations;
      const claudeRows = observations.filter((item) => item.principal_id === "claude-main");
      expect(claudeRows).toHaveLength(3);
      // Never "Claude probe not built" or any other message the real
      // observeClaude()/claudeProbe() would produce: the gate short-circuits
      // before the probe is ever attempted.
      expect(claudeRows.every((item) => item.freshness === "failed" && item.reason === claudeGrantNeededReason("claude-main"))).toBe(true);
      await daemon.stop();
      const store = await HeadroomStore.open(root);
      try {
        const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
        const rows = db.prepare("SELECT * FROM audit WHERE action = 'claude_probe' AND caller = 'daemon'").all();
        expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ meter_or_principal: "claude-main", outcome: "skipped: grant needed" })]));
        expect(rows.some((row) => row.outcome === "called")).toBe(false);
      } finally { store.close(); }
    });
  });

  it("returns only active leases through the daemon status/MCP lease surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-leases-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
    const internal = daemon as unknown as { store: { startLease(owner: string, meter: string, expected: number | null, ttl: number, note: string | null, now: Date): { id: string }; endLease(id: string, owner: string, force: boolean, now: Date): unknown }; handleLine(line: string): Promise<{ result: unknown }> };
    const now = new Date();
    const active = internal.store.startLease("cadence", "codex-main:main", null, 60_000, null, now);
    const ended = internal.store.startLease("cadence", "codex-main:main", null, 60_000, null, now);
    internal.store.endLease(ended.id, "cadence", false, now);
    try {
      await expect(internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"leases"}')).resolves.toMatchObject({ result: [expect.objectContaining({ id: active.id })] });
      const reply = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"leases"}');
      expect((reply.result as Array<{ id: string }>).map((lease) => lease.id)).toEqual([active.id]);
    } finally { await daemon.stop(); }
  });

  it("uses a healthy fake daemon after its bounded health probe", async function () {
    const root = await mkdtemp(join(tmpdir(), "headroom-client-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    const methods: string[] = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (line: string) => {
        const request = JSON.parse(line) as { id: number; method: string };
        methods.push(request.method);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "status" ? [fixture()] : { ok: true } })}\n`);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject).listen(path, resolve); });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP fake Unix-socket daemon test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    try {
      await expect(daemonRequest(path, "status")).resolves.toMatchObject({ status: "available", result: [expect.objectContaining({ meter_id: "codex-main:main" })] });
      expect(methods).toEqual(["health", "status"]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("starts on a private temp socket and coalesces concurrent status polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let polls = 0;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => { polls += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { observations: [fixture()], failures: [] }; } });
    try { await daemon.start(); }
    catch (error: unknown) {
      // The hosted sandbox forbids AF_UNIX listen(2); local/macOS CI runs the
      // round-trip below. Treat only that environmental restriction as skipped.
      if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
      throw error;
    }
    try {
      const [first, second] = await Promise.all([rpc(path, "status"), rpc(path, "status")]);
      expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ meter_id: "codex-main:main" })]));
      expect(second).toEqual(expect.arrayContaining([expect.objectContaining({ meter_id: "codex-main:main" })]));
      expect(polls).toBe(1);
    } finally { await daemon.stop(); }
  });
});

describe("MCP JSON-RPC", () => {
  it("handles initialize, tools/list, and a fixture-backed quota_status call", async () => {
    expect(await handleMcp('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toMatchObject({ result: { capabilities: { tools: {} } } });
    expect(await handleMcp('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: "quota_status" }), expect.objectContaining({ name: "quota_lease_start" }), expect.objectContaining({ name: "quota_lease_end" }), expect.objectContaining({ name: "quota_leases" })]) } });
    const response = await handleMcp('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}', async (method) => {
      expect(method).toBe("status"); return [fixture()];
    });
    expect(response).toMatchObject({ result: { structuredContent: [expect.objectContaining({ meter_id: "codex-main:main" })] } });
  });

  it("uses a direct marked result when the daemon is absent", async () => {
    const response = await handleMcp('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}', async () => undefined, async (method) => {
      expect(method).toBe("status");
      return { source: "direct", observations: [fixture()], failures: [] };
    });
    expect(response).toMatchObject({ result: { structuredContent: { source: "direct", observations: [expect.objectContaining({ meter_id: "codex-main:main" })] } } });
  });

  it("never spawns the Claude probe from a direct (no-daemon) MCP status read once a keychain grant marker exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-mcp-grant-gate-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "accounts.toml"), [
      "[[accounts]]",
      'name = "claude-main"',
      'vendor = "claude"',
      'location = "/nonexistent/.claude"',
      'adapter = "native-ts"',
      "",
    ].join("\n"), { mode: 0o600 });
    await withHeadroomHome(root, async () => {
      const seed = await HeadroomStore.open(root);
      seed.setKeychainGrantNeeded("claude-main", "Keychain access denied");
      seed.close();
      const result = await directStatus();
      const claudeRows = (result.observations as Observation[]).filter((item) => item.principal_id === "claude-main");
      expect(claudeRows).toHaveLength(3);
      expect(claudeRows.every((item) => item.freshness === "failed" && item.reason === claudeGrantNeededReason("claude-main"))).toBe(true);
      const store = await HeadroomStore.open(root);
      try {
        const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
        const rows = db.prepare("SELECT * FROM audit WHERE action = 'claude_probe' AND caller = 'mcp'").all();
        expect(rows).toEqual([expect.objectContaining({ meter_or_principal: "claude-main", outcome: "skipped: grant needed" })]);
      } finally { store.close(); }
    });
  });
});

describe("not enforced windows", () => {
  it("are n/a, rather than UNKNOWN, and do not block can", () => {
    const observation = fixture();
    const absent: Observation = { ...observation, quantity: null, freshness: "not_enforced", reason: "vendor returned no 5-hour window" };
    const policy = defaultPolicy;
    expect(paceState(absent, policy, new Date("2026-09-03T12:00:00Z"))).toBe("NOT_ENFORCED");
    expect(canConsume([absent.meter_id], new Map([[absent.meter_id, absent]]), policy, false, new Date("2026-09-03T12:00:00Z"))).toMatchObject({ allowed: true, state: "NOT_ENFORCED" });
  });
});
