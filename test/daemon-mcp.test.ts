import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeGrantNeededReason } from "../src/adapters/claude.js";
import { main } from "../src/cli.js";
import { daemonRequest, rpc, HeadroomDaemon } from "../src/daemon.js";
import { tailDaemonLog } from "../src/logs.js";
import { directStatus, handleMcp, serveMcp } from "../src/mcp.js";
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

describe("malformed requests never crash the daemon or MCP loop", () => {
  it("returns a JSON-RPC error instead of throwing for null, a bare string, and a method-less object", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-malformed-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
    const internal = daemon as unknown as { handleLine(line: string): Promise<{ error?: { code: number } }> };
    try {
      for (const line of ["null", '"just a string"', '{"jsonrpc":"2.0","id":1}', "42", "[1,2,3]"]) {
        await expect(internal.handleLine(line)).resolves.toMatchObject({ error: { code: -32600 } });
      }
    } finally { await daemon.stop(); }
  });

  it("returns a JSON-RPC error for the MCP loop on the same malformed inputs", async () => {
    for (const line of ["null", '"just a string"', '{"jsonrpc":"2.0","id":1}']) {
      await expect(handleMcp(line)).resolves.toMatchObject({ error: { code: -32600 } });
    }
  });

  it("converts a thrown MCP tool error into a JSON-RPC error instead of rejecting", async () => {
    const response = await handleMcp('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"quota_can","arguments":{}}}', async () => { throw new Error("owner is required"); });
    expect(response).toMatchObject({ error: { code: -32000, message: "owner is required" } });
  });
});

describe("can validates routing before ever answering", () => {
  it("rejects an unknown action class, and audits the rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-can-unknown-action-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "routing.toml"), '[consumes]\nbuild = ["codex-main:main"]\n', { mode: 0o600 });
    await withHeadroomHome(root, async () => {
      const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
      const internal = daemon as unknown as { handleLine(line: string): Promise<{ error?: { code: number; message: string } }> };
      try {
        const reply = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"can","params":{"action_class":"typo-action","owner":"cadence"}}');
        expect(reply.error).toMatchObject({ code: -32602 });
        expect(reply.error?.message).toContain("Unknown action class");
      } finally { await daemon.stop(); }
      const store = await HeadroomStore.open(root);
      try {
        const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
        const rows = db.prepare("SELECT * FROM audit WHERE action = 'can' AND outcome = 'rejected'").all();
        expect(rows.length).toBeGreaterThan(0);
      } finally { store.close(); }
    });
  });

  it("rejects can when no routing.toml is configured at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-can-no-routing-")); temporary.push(root);
    await withHeadroomHome(root, async () => {
      const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
      const internal = daemon as unknown as { handleLine(line: string): Promise<{ error?: { code: number; message: string } }> };
      try {
        const reply = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"can","params":{"action_class":"build","owner":"cadence"}}');
        expect(reply.error).toMatchObject({ code: -32602 });
        expect(reply.error?.message).toContain("No routing.toml configured");
      } finally { await daemon.stop(); }
    });
  });

  it("rejects a routing action class that names a meter with no matching configured account", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-can-unknown-meter-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "routing.toml"), '[consumes]\nbuild = ["ghost-principal:main"]\n', { mode: 0o600 });
    await writeFile(join(root, "accounts.toml"), ["[[accounts]]", 'name = "codex-main"', 'vendor = "codex"', 'location = "/nonexistent/.codex"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    await withHeadroomHome(root, async () => {
      const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
      const internal = daemon as unknown as { handleLine(line: string): Promise<{ error?: { code: number; message: string } }> };
      try {
        const reply = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"can","params":{"action_class":"build","owner":"cadence"}}');
        expect(reply.error).toMatchObject({ code: -32602 });
        expect(reply.error?.message).toContain("unknown meter");
        expect(reply.error?.message).toContain("ghost-principal:main");
      } finally { await daemon.stop(); }
    });
  });
});

describe("every scheduled vendor poll is audited, not only Claude's", () => {
  it("writes a 'poll' audit row for a non-Claude principal polled by the daemon's scheduler", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-poll-audit-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: async () => ({ observations: [fixture()], failures: [] }) });
    const internal = daemon as unknown as { poll(principal: string | undefined, forced: boolean): Promise<unknown> };
    try {
      await internal.poll(undefined, true);
      const store = await HeadroomStore.open(root);
      try {
        const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
        const rows = db.prepare("SELECT * FROM audit WHERE action = 'poll' AND caller = 'daemon'").all();
        expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ meter_or_principal: "codex-main", outcome: "ok" })]));
      } finally { store.close(); }
    } finally { await daemon.stop(); }
  });

  it("marks a poll audit row 'failed' when the collector reports a source failure for that principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-poll-audit-failed-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({
      home: root, path: join(root, "headroom.sock"),
      poller: async () => ({ observations: [fixture()], failures: ["codex-main source failed: Codex usage request failed (429)"] }),
    });
    const internal = daemon as unknown as { poll(principal: string | undefined, forced: boolean): Promise<unknown> };
    try {
      await internal.poll(undefined, true);
      const store = await HeadroomStore.open(root);
      try {
        const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
        const rows = db.prepare("SELECT * FROM audit WHERE action = 'poll' AND caller = 'daemon'").all();
        expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ meter_or_principal: "codex-main", outcome: "failed" })]));
      } finally { store.close(); }
    } finally { await daemon.stop(); }
  });
});

describe("MCP stdio loop bounds its own input", () => {
  it("drops an oversized unterminated line instead of growing its buffer without bound", () => {
    serveMcp();
    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      process.stdin.emit("data", "x".repeat(70 * 1024)); // no newline: never resolves into a request
    } finally { process.stdout.write = originalWrite; }
    expect(written.some((line) => { try { return JSON.parse(line).error?.message === "Request line exceeds the maximum size"; } catch { return false; } })).toBe(true);
  });
});

describe("MCP direct status shares a persisted backoff across calls", () => {
  it("skips a fresh poll and returns cached observations within the same poll interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-mcp-direct-backoff-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "policy.toml"), "poll_interval_minutes = 5\n", { mode: 0o600 });
    // No accounts.toml at all: readAccounts() would throw ENOENT if a second
    // poll were attempted, so a passing test proves the second directStatus()
    // call took the cached-backoff path instead of polling again.
    await withHeadroomHome(root, async () => {
      const store = await HeadroomStore.open(root);
      store.insert(fixture());
      store.setDirectPollBackoff({ lastPollAt: Date.now(), until: 0, failures: 0 });
      store.close();
      const result = await directStatus();
      expect(result.source).toBe("direct");
      expect((result.observations as Observation[]).some((item) => item.meter_id === "codex-main:main")).toBe(true);
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

describe("a genuine daemon handler exception is logged and surfaced with its real message", () => {
  it("logs '<method> failed: <message>' to the daemon log and returns a JSON-RPC error carrying that same message", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-log-error-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock") });
    const internal = daemon as unknown as { handleLine(line: string): Promise<{ error?: { code: number; message: string } }> };
    try {
      // store.endLease() throws "lease not found" for an id that was never
      // started -- a genuine handler exception, not a domain-level "no".
      const reply = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"lease_end","params":{"id":"nonexistent","owner":"cadence"}}');
      expect(reply.error).toMatchObject({ code: -32000, message: "lease not found" });
    } finally { await daemon.stop(); }
    const log = await tailDaemonLog(50, root);
    expect(log).toContain("lease_end failed: lease not found");
  });
});

describe("plan/gate/fill round-trip through a real daemon socket for a meter whose 5h window is not enforced", () => {
  // The exact live defect reported against codex-main:main: its 5h window is
  // not_enforced (Codex reports no 5-hour limit), only the weekly window is
  // fresh. `plan` used to come back through the daemon as the generic
  // "Daemon request failed" -- unwrapRpc mistook plan's own domain-level
  // `{meter, error}` result for a JSON-RPC error envelope because both carry
  // an "error" key, discarding the real "no weekly window" reason -- itself a
  // symptom of meterWindows() losing the weekly window once the not_enforced
  // 5h row displaced it as "the only window known".
  it("plan finds the weekly window and returns real numbers, not a generic 'Daemon request failed'", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-plan-liveroundtrip-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    const daemon = await HeadroomDaemon.create({ home: root, path });
    try { await daemon.start(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      const store = await HeadroomStore.open(root);
      store.insert({
        principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
        quantity: null, resets_at: null, observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture",
        truth: "official", freshness: "not_enforced", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
      });
      store.insert({
        principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
        quantity: { used: 83, limit: 100, remaining: 17, unit: "percent" }, resets_at: "2026-09-10T12:00:00Z",
        observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture",
        truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
      });
      store.close();
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
      try {
        const code = await main(["plan", "--meter", "codex-main:main", "--until", "reset", "--reserve", "10", "--json"]);
        expect(code).toBe(0);
      } finally { spy.mockRestore(); }
      const result = JSON.parse(logs[0]);
      expect(result).toMatchObject({ meter: "codex-main:main", weekly_remaining_percent: 17 });
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await daemon.stop();
    }
  });
});
