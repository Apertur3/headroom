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
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import * as daemonModule from "../src/daemon.js";
import { normalizeDaemonTimer } from "../src/json-contract.js";
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
 * other unknown method still answers a plain -32601, unaffected.
 *
 * `additiveResults`, when given, supplies each additive method's own genuine
 * success result instead of the default `-32601` error. Keeping the two
 * results independent matters: a Timer row is never a valid Heartbeat row.
 * It is used to simulate a daemon old enough to predate a Timer field (but
 * not the RPC itself), or a malformed success reply. */
function startLegacyDaemon(path: string, additiveError: { code: number; message: string } = { code: -32601, message: "Method not found" }, additiveResults?: Partial<Record<"heartbeats" | "timer_list", unknown>>): Promise<Server> {
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
            ? (additiveResults && Object.hasOwn(additiveResults, request.method) ? { jsonrpc: "2.0", id: request.id, result: additiveResults[request.method] } : { jsonrpc: "2.0", id: request.id, error: additiveError })
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

  it("`headroom status --json` throws when `heartbeats` answers a non-array SUCCESS reply, instead of reading it as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-nonarray-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    // A malformed (non-array) success value, not a JSON-RPC error at all --
    // only -32601 (the documented compatibility gap) may become "none".
    try { server = await startLegacyDaemon(path, undefined, { heartbeats: { unexpected: "shape" } }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI non-array test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      await expect(main(["--json"])).rejects.toThrow(/not an array/);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("MCP quota_status throws when `heartbeats` answers a non-array SUCCESS reply, instead of reading it as empty", async () => {
    const reply = await handleMcp(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}',
      async (method) => {
        if (method === "status") return [];
        if (method === "plan_downgrades") return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
        if (method === "heartbeats") return { unexpected: "shape" }; // malformed success, no error envelope
        return undefined;
      },
    ) as { error?: { code: number; message: string }; result?: unknown };
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toContain("not an array");
  });

  it("`headroom status --json` rejects a malformed heartbeat member instead of emitting it in the contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-bad-heartbeat-")); temporary.push(root);
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const request = vi.spyOn(daemonModule, "daemonRequest").mockImplementation(async (_path, method) => ({
      status: "available" as const,
      result: method === "heartbeats" ? [{ owner: "orch-malformed" }]
        : method === "status" || method === "leases" || method === "plan_downgrades" || method === "timer_list" ? []
          : {},
    }));
    try {
      await expect(main(["--json"])).rejects.toThrow('Daemon heartbeat row is missing required field "started_at"');
    } finally {
      request.mockRestore();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });

  it("MCP quota_status rejects a malformed heartbeat member instead of emitting it in the contract", async () => {
    const reply = await handleMcp(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}',
      async (method) => {
        if (method === "status" || method === "plan_downgrades" || method === "timer_list") return [];
        if (method === "heartbeats") return [{ owner: "orch-malformed" }];
        return undefined;
      },
    ) as { error?: { message: string }; result?: unknown };
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toContain('missing required field "started_at"');
  });

  // a timer row from a daemon that predates the attempts/
  // failed_at fields (still-running, still answers `timer_list`, just an
  // older Timer shape) must read the same way an older on-disk schema's row
  // already does (store.ts's own timerFromRow default) at every protocol
  // boundary -- not just the local-store read path.
  const timerRowMissingDeliveryFields = { owner: "orch-oldshape", name: "wake", at: "2020-01-01T00:00:00.000Z", action: "check the deploy", if_missed: "notify", created_at: "2019-12-31T23:00:00.000Z", fired_at: null, cleared_at: null };

  it("`headroom status --json` normalizes attempts/failed_at for a due_timer from a daemon reply that predates those fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-oldtimer-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path, undefined, { heartbeats: [], timer_list: [timerRowMissingDeliveryFields] }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI old-timer-shape test: sandbox forbids listen(2)\n"); return; }
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
    const parsed = JSON.parse(logSpy.at(-1)!) as { due_timers: Array<{ owner: string; attempts: number; failed_at: string | null }> };
    expect(parsed.due_timers).toEqual([expect.objectContaining({ owner: "orch-oldshape", attempts: 0, failed_at: null })]);
  });

  it("`headroom timer list --json` normalizes attempts/failed_at for a row from a daemon reply that predates those fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-oldtimer-list-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path, undefined, { timer_list: [timerRowMissingDeliveryFields] }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI timer-list old-shape test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => { logSpy.push(line); };
    try {
      const code = await main(["timer", "list", "--json"]);
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const parsed = JSON.parse(logSpy.at(-1)!) as { timers: Array<{ owner: string; attempts: number; failed_at: string | null }> };
    expect(parsed.timers).toEqual([expect.objectContaining({ owner: "orch-oldshape", attempts: 0, failed_at: null })]);
  });

  // a malformed (non-array) SUCCESS reply to `timer_list` must
  // fail loud, the same way it already does on the `status` path -- never
  // silently normalized into an empty list, which would hide a real daemon
  // defect behind "no pending timers".
  it("`headroom timer list --json` throws on a malformed (non-array) SUCCESS reply, instead of reading it as an empty list", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-timerlist-nonarray-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path, undefined, { timer_list: { unexpected: "shape" } }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI timer-list non-array test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      await expect(main(["timer", "list", "--json"])).rejects.toThrow(/not an array/);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("MCP quota_status normalizes attempts/failed_at for a due_timer from a daemon reply that predates those fields", async () => {
    const reply = await handleMcp(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}',
      async (method) => {
        if (method === "status") return [];
        if (method === "plan_downgrades") return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
        if (method === "heartbeats") return [];
        if (method === "timer_list") return [timerRowMissingDeliveryFields];
        return undefined;
      },
    ) as { result: { structuredContent: { due_timers: Array<{ owner: string; attempts: number; failed_at: string | null }> } } };
    expect(reply.result.structuredContent.due_timers).toEqual([expect.objectContaining({ owner: "orch-oldshape", attempts: 0, failed_at: null })]);
  });

  // normalizeDaemonTimer used to default attempts/failed_at onto
  // ANY object, missing pre-additive fields included -- silently producing a
  // contract-invalid Timer (an `owner` of `undefined`) instead of surfacing
  // the malformed reply. Only the two genuinely additive fields may be
  // defaulted; every other required field is now checked and fails loud when
  // missing or misshapen, at each of the three protocol boundaries a timer
  // row reaches from a daemon reply.
  const timerRowMalformed = { name: "wake", at: "2020-01-01T00:00:00.000Z", action: "check the deploy", if_missed: "notify", created_at: "2019-12-31T23:00:00.000Z", fired_at: null, cleared_at: null }; // missing owner

  it("defaults additive timer fields only when absent, not when a present value is malformed", () => {
    for (const [field, value] of [["attempts", "bad"], ["failed_at", 123]] as const) {
      expect(() => normalizeDaemonTimer({ ...timerRowMissingDeliveryFields, [field]: value })).toThrow(`invalid "${field}"`);
    }
  });

  it("`headroom status --json` throws on a malformed timer_list member, instead of normalizing it into a contract-invalid due_timer", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-malformed-member-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path, undefined, { heartbeats: [], timer_list: [timerRowMalformed] }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI malformed-member test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      await expect(main(["--json"])).rejects.toThrow(/missing required field "owner"/);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("`headroom timer list --json` throws on a malformed row, instead of normalizing it into a contract-invalid timer", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-legacy-daemon-cli-timerlist-malformed-member-")); temporary.push(root);
    const path = join(root, "headroom.sock");
    let server: Server;
    try { server = await startLegacyDaemon(path, undefined, { timer_list: [timerRowMalformed] }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP legacy-daemon CLI timer-list malformed-member test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      await expect(main(["timer", "list", "--json"])).rejects.toThrow(/missing required field "owner"/);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("MCP quota_status throws on a malformed timer_list member, instead of normalizing it into a contract-invalid due_timer", async () => {
    const reply = await handleMcp(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}',
      async (method) => {
        if (method === "status") return [];
        if (method === "plan_downgrades") return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
        if (method === "heartbeats") return [];
        if (method === "timer_list") return [timerRowMalformed];
        return undefined;
      },
    ) as { error?: { code: number; message: string }; result?: unknown };
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toContain('missing required field "owner"');
  });
});
