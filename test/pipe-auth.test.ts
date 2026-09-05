import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpc, HeadroomDaemon } from "../src/daemon.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A real Windows host has no filesystem-backed Unix-domain-socket
 * equivalent: net.Server#listen() on a plain temp-dir path fails with
 * EACCES there. A `\\.\pipe\...` name is the only thing that actually binds. */
function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

/**
 * The Windows pipe session-token handshake only runs when process.platform
 * is "win32". On a real Windows CI runner this is a harmless no-op (the
 * platform already is "win32"); on macOS/Linux it lets these tests exercise
 * that handshake without a Windows machine. Every filesystem/path helper
 * elsewhere in the codebase also branches on process.platform (path
 * separators, ancestry checks, socket-vs-pipe naming), so faking the global
 * platform for an entire daemon start()/create() would fight those unrelated
 * branches on a real macOS/Linux filesystem. Instead these tests fake the
 * platform only around the two places that actually implement the pipe
 * protocol: the server's handleLine() dispatch (tested directly, with a
 * daemon created and started under the real platform) and the client's
 * rpc() wire construction (tested against a plain fake TCP-shaped server
 * that speaks the same nonce-then-request protocol).
 */
async function withFakePlatform<T>(platform: NodeJS.Platform, run: () => T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return await run(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

function pipeAuthProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`headroom-pipe-auth-v1:${nonce}`).digest("hex");
}

describe("Windows pipe authentication: server side (handleLine)", () => {
  it("rejects a missing proof, rejects a wrong proof, and accepts the correct HMAC-of-nonce proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-server-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as { sessionToken?: string; handleLine(line: string, nonce?: string): Promise<{ error?: { code: number }; result?: unknown }> };
    // The real token file is only ever created by start() on win32; setting
    // it directly here exercises handleLine()'s auth check without needing
    // an actual Windows named pipe.
    internal.sessionToken = randomBytes(32).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    try {
      await withFakePlatform("win32", async () => {
        const noProof = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"status","params":{}}', nonce);
        expect(noProof).toMatchObject({ error: { code: -32001 } });

        const plaintextToken = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { _session_token: internal.sessionToken } }), nonce);
        expect(plaintextToken).toMatchObject({ error: { code: -32001 } });

        const wrongProof = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"status","params":{"_proof":"0000000000000000000000000000000000000000000000000000000000000000"}}', nonce);
        expect(wrongProof).toMatchObject({ error: { code: -32001 } });

        const correctProof = pipeAuthProof(internal.sessionToken!, nonce);
        const authorized = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { _proof: correctProof } }), nonce);
        expect(authorized.error).toBeUndefined();

        // health never needs a proof, even on win32.
        const health = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"health","params":{}}', nonce);
        expect(health.error).toBeUndefined();
      });
    } finally { await daemon.stop(); }
  });
});

describe("Windows pipe authentication: client side (rpc)", () => {
  it("computes an HMAC proof of the server's nonce and never sends the plaintext session token", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-client-")); temporary.push(root);
    const home = join(root, ".headroom");
    const path = testSocketPath(root, "fake-pipe");
    const token = randomBytes(32).toString("hex");
    let received: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
      const nonce = randomBytes(16).toString("hex");
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce } })}\n`);
      let buffer = "";
      socket.on("data", (part: string) => {
        buffer += part;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        const proof = pipeAuthProof(token, nonce);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { proofMatchedExpected: JSON.stringify((received.params as Record<string, unknown>)?._proof) === JSON.stringify(proof) } })}\n`);
      });
    });
    temporary.push(root);
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP pipe-auth client test: sandbox forbids listen(2)\n"); return; }
      throw error;
    }
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try {
      const { mkdir, writeFile, chmod } = await import("node:fs/promises");
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(home, "pipe-session-token"), `${token}\n`, { mode: 0o600 });
      await chmod(join(home, "pipe-session-token"), 0o600);
      const result = await withFakePlatform("win32", () => rpc(path, "status"));
      expect((result as { proofMatchedExpected?: boolean } | undefined)?.proofMatchedExpected).toBe(true);
      expect(received).toBeDefined();
      expect(JSON.stringify(received)).not.toContain(token);
      expect(received).not.toHaveProperty("params._session_token");
    } finally {
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
