import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonRequest, rpc, HeadroomDaemon } from "../src/daemon.js";
import { handleMcp } from "../src/mcp.js";
import { canConsume, defaultPolicy, paceState } from "../src/policy.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fixture(): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-03T13:00:00Z",
    observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

describe("daemon JSON-RPC", () => {
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
