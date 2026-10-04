/**
 * The authenticated `shutdown` request: the clean way for uninstall and install-service to stop a
 * Windows daemon, where schtasks /End ends only the task's cmd.exe wrapper and no signal can be
 * handled. It must be authorized exactly like every other mutating request, idempotent, and only
 * request the stop (the process entry point runs the graceful stop()).
 */
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon, requestDaemonShutdown } from "../src/daemon.js";
import { headroomVersion } from "../src/version.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))); });

const poller = async () => ({ observations: [], failures: [] });

function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

async function withFakePlatform<T>(platform: NodeJS.Platform, run: () => T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return await run(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

/** Whether the daemon's shutdownRequested promise has resolved, without waiting on it. */
async function requested(daemon: HeadroomDaemon): Promise<boolean> {
  return Promise.race([daemon.shutdownRequested.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]);
}

describe("daemon shutdown request", () => {
  it("on Windows rejects a client without the pipe proof and does not stop; accepts one with it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-shutdown-auth-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller });
    const internal = daemon as unknown as { sessionToken?: string; handleLine(line: string, nonce?: string): Promise<{ replyLine: string }> };
    internal.sessionToken = "a".repeat(64);
    try {
      await withFakePlatform("win32", async () => {
        const nonce = "b".repeat(32);
        for (const params of [{}, { _proof: "0".repeat(64) }, { _session_token: internal.sessionToken }]) {
          const { replyLine } = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown", params }), nonce);
          expect(JSON.parse(replyLine)).toMatchObject({ error: { code: -32001, message: "Unauthorized pipe client" } });
        }
        expect(await requested(daemon)).toBe(false);
      });
      // Accepted with the proof. Outside the faked platform: an accepted request writes a daemon log
      // line, and a faked win32 would join that path with backslashes into the working directory.
      // authedHandleLine signs the request on a real Windows runner, as rpc() does.
      const reply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown", params: {} }));
      expect(reply.result).toEqual({ state: "stopping", already_requested: false });
      expect(await requested(daemon)).toBe(true);
    } finally { await daemon.stop(); }
  });

  it("is idempotent, only requests the stop (health keeps answering), and is still accepted while a stop drains", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-shutdown-idem-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller });
    try {
      const first = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown", params: {} }));
      expect(first.result).toEqual({ state: "stopping", already_requested: false });
      const second = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} }));
      expect(second.result).toEqual({ state: "stopping", already_requested: true });
      expect(await requested(daemon)).toBe(true);
      // The handler never stops the daemon itself: the reply is written first, and the entry point owns the stop.
      const health = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "health", params: {} }));
      expect(health.result).toMatchObject({ state: "running", version: await headroomVersion() });
    } finally { await daemon.stop(); }
  });

  it("answers 'already requested' to a shutdown that arrives while a signal-driven stop is draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-shutdown-stopping-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller });
    (daemon as unknown as { stopping: boolean }).stopping = true;
    try {
      const reply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown", params: {} }));
      expect(reply.result).toEqual({ state: "stopping", already_requested: true });
    } finally { (daemon as unknown as { stopping: boolean }).stopping = false; await daemon.stop(); }
  });

  it("requestDaemonShutdown: accepted by a live daemon over the real transport, absent once it has stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-shutdown-live-")); temporary.push(root);
    const path = testSocketPath(root, "headroom");
    const daemon = await HeadroomDaemon.create({ home: root, path, poller });
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root; // the client reads the Windows session token from this home
    try {
      await daemon.start();
      expect(await requestDaemonShutdown(path)).toBe("accepted");
      await daemon.shutdownRequested;
      await daemon.stop();
      expect(await requestDaemonShutdown(path)).toBe("absent");
    } finally {
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
    }
  });
});

// A plain socket server stands in for a daemon from a version without the request. Windows clients
// insist on the pipe proof handshake, which this stand-in does not speak, so POSIX only.
describe.skipIf(process.platform === "win32")("requestDaemonShutdown against an older daemon", () => {
  function fakeDaemon(path: string, reply: (method: string) => unknown): Promise<Server> {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string };
          buffer = buffer.slice(newline + 1);
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(reply(request.method) as object) })}\n`);
        }
      });
    });
    return new Promise((resolve) => server.listen(path, () => resolve(server)));
  }

  it("maps Method not found to unsupported, and a stopping daemon's refusal to accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-shutdown-old-")); temporary.push(root);
    for (const [error, outcome] of [[{ code: -32601, message: "Method not found" }, "unsupported"], [{ code: -32000, message: "Headroom daemon is stopping" }, "accepted"], [{ code: -32000, message: "boom" }, "refused"]] as const) {
      const path = join(root, `${outcome}-${error.message.length}.sock`);
      const server = await fakeDaemon(path, (method) => method === "health" ? { result: { state: "running" } } : { error });
      try { expect(await requestDaemonShutdown(path)).toBe(outcome); }
      finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  });
});
