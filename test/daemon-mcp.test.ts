import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpc, TallyDaemon } from "../src/daemon.js";
import { handleMcp } from "../src/mcp.js";
import { canConsume, paceState } from "../src/policy.js";
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
  it("starts on a private temp socket and coalesces concurrent status polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-daemon-")); temporary.push(root);
    const path = join(root, "tally.sock");
    let polls = 0;
    const daemon = await TallyDaemon.create({ home: root, path, poller: async () => { polls += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { observations: [fixture()], failures: [] }; } });
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
    expect(await handleMcp('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: "quota_status" })]) } });
    const response = await handleMcp('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}', async (method) => {
      expect(method).toBe("status"); return [fixture()];
    });
    expect(response).toMatchObject({ result: { structuredContent: [expect.objectContaining({ meter_id: "codex-main:main" })] } });
  });
});

describe("not enforced windows", () => {
  it("are n/a, rather than UNKNOWN, and do not block can", () => {
    const observation = fixture();
    const absent: Observation = { ...observation, quantity: null, freshness: "not_enforced", reason: "vendor returned no 5-hour window" };
    const policy = { freeze_reserve_pct: 10, staleness_minutes: 15, poll_interval_minutes: 5, principal_intervals: {} };
    expect(paceState(absent, policy, new Date("2026-09-03T12:00:00Z"))).toBe("NOT_ENFORCED");
    expect(canConsume([absent.meter_id], new Map([[absent.meter_id, absent]]), policy, false, new Date("2026-09-03T12:00:00Z"))).toMatchObject({ allowed: true, state: "NOT_ENFORCED" });
  });
});
