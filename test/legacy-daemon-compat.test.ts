/**
 * P1 fix: a 0.2.0 CLI/MCP against a still-running 0.1.7 daemon.
 * `status` requests the new `heartbeats` and `timer_list` RPCs; an older
 * daemon answers both with a plain JSON-RPC `-32601 Method not found`, which
 * used to make `unwrapRpc` throw despite the surrounding code's own comment
 * claiming older-daemon compatibility. `status --json` (src/cli.ts's
 * observe(), via `unwrapAdditiveRpc`) and MCP `quota_status` (src/mcp.ts,
 * via `decodeAdditiveRpcReply`) must both still succeed, with empty
 * `heartbeats`/`due_timers`, against exactly this daemon.
 *
 * The other half of that same decode logic: `-32601` is the ONLY error code
 * either treats as "none registered". A genuine handler failure on these
 * two RPCs (most commonly `-32000`, a real daemon-side exception) must still
 * propagate as a real, visible failure on both the CLI and MCP paths, not be
 * silently folded into "no heartbeats/timers" alongside the compatibility
 * case.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A minimal stand-in for a daemon: answers `health` and `status` (and the
 * other fields `observe()` unconditionally requests once `status` succeeds)
 * normally. `heartbeats`/`timer_list` answer with `additiveError` when
 * given (default `{code: -32601, message: "Method not found"}`, a real
 * pre-0.2.0 daemon's exact reply for an unknown method) -- passing a
 * different code (most usefully `-32000`, a genuine handler exception) lets
 * a test simulate a real daemon-side failure on these two RPCs specifically,
 * as opposed to the compatibility gap this file otherwise covers. Every
 * other unknown method still answers a plain -32601, unaffected. */
function startLegacyDaemon(path: string, additiveError: { code: number; message: string } = { code: -32601, message: "Method not found" }): Promise<Server> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as { id: number; method: string };
        const known = ["health", "status", "reset_seen", "free_reset_used", "plan_downgrades", "leases"];
        const reply = known.includes(request.method)
          ? { jsonrpc: "2.0", id: request.id, result: request.method === "status" ? [] : request.method === "reset_seen" || request.method === "free_reset_used" ? {} : [] }
          : request.method === "heartbeats" || request.method === "timer_list"
            ? { jsonrpc: "2.0", id: request.id, error: additiveError }
            : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  return new Promise((resolve, reject) => { server.once("error", reject).listen(path, () => resolve(server)); });
}

describe.skipIf(process.platform === "win32")("0.2.0 client against a simulated 0.1.7 daemon", () => {
  it("`headroom status --json` succeeds with empty heartbeats/due_timers instead of throwing on -32601", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => { logSpy.push(line); };
    try {
      const code = await main(["--json"]);
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const parsed = JSON.parse(logSpy.at(-1)!) as { heartbeats: unknown[]; due_timers: unknown[] };
    expect(parsed.heartbeats).toEqual([]);
    expect(parsed.due_timers).toEqual([]);
  });

  it("MCP quota_status succeeds with empty heartbeats/due_timers against the same -32601 shape", async () => {
    const calls: string[] = [];
    const reply = await handleMcp(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}',
      async (method) => {
        calls.push(method);
        if (method === "status") return [];
        if (method === "plan_downgrades") return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
        if (method === "heartbeats" || method === "timer_list") return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
        return undefined;
      },
    );
    expect(calls).toEqual(expect.arrayContaining(["status", "heartbeats", "timer_list"]));
    const structured = (reply as { result: { structuredContent: { heartbeats: unknown[]; due_timers: unknown[] } } }).result.structuredContent;
    expect(structured.heartbeats).toEqual([]);
    expect(structured.due_timers).toEqual([]);
  });

  it("`headroom status --json` still fails loudly on a genuine -32000 from `heartbeats`, never silently reads it as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-32000-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path, { code: -32000, message: "simulated heartbeats handler failure" }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI -32000 test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      await expect(main(["--json"])).rejects.toThrow(/simulated heartbeats handler failure/);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("MCP quota_status still fails loudly on a genuine -32000 from `heartbeats`, never silently reads it as empty", async () => {
    const calls: string[] = [];
    const reply = await handleMcp(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}',
      async (method) => {
        calls.push(method);
        if (method === "status") return [];
        if (method === "plan_downgrades") return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
        if (method === "heartbeats") return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "simulated heartbeats handler failure" } };
        return undefined;
      },
    ) as { error?: { code: number; message: string }; result?: unknown };
    expect(calls).toContain("heartbeats");
    // A real handler failure surfaces as an MCP tool error, not a
    // structuredContent success with heartbeats quietly read as [].
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatchObject({ code: -32000 });
    expect(reply.error?.message).toContain("simulated heartbeats handler failure");
  });
});
