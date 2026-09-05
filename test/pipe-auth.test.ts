import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpc, daemonRequest, HeadroomDaemon } from "../src/daemon.js";

const temporary: string[] = [];
// maxRetries/retryDelay: this file's client-side test spins up a raw
// net.Server on a real Windows named pipe: server.close()'s callback firing
// doesn't guarantee Windows has finished releasing the underlying handle,
// which otherwise intermittently fails this recursive delete with EPERM on
// a just-vacated temp dir (a well-documented Node/Windows race -- see
// fs.rm's own docs for these options). A plain retry with backoff is enough;
// no other file in this suite spins up a raw platform-level pipe server.
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))); });

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
 * rpc()/daemonRequest() wire construction (tested against a plain
 * TCP-shaped fake server that speaks the same nonce-then-request protocol).
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
function pipeServerProof(token: string, serverNonce: string, clientNonce: string): string {
  return createHmac("sha256", token).update(`headroom-pipe-server-v1:${serverNonce}:${clientNonce}`).digest("hex");
}

/** Sets up a fresh HEADROOM_HOME with a real session-token file and runs
 * `run` with the environment pointed at it, restoring HEADROOM_HOME after. */
async function withSessionToken<T>(root: string, token: string, run: () => Promise<T>): Promise<T> {
  const home = join(root, ".headroom");
  const previousHome = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "pipe-session-token"), `${token}\n`, { mode: 0o600 });
    await chmod(join(home, "pipe-session-token"), 0o600);
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  }
}

async function listenOrSkip(server: ReturnType<typeof createServer>, path: string, label: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write(`SKIP ${label}: sandbox forbids listen(2)\n`); return false; }
    throw error;
  }
}

describe("Windows pipe authentication: server side (handleLine)", () => {
  it("rejects a missing or wrong client proof, accepts the correct one, and binds every reply's server_proof to the caller's own nonce", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-server-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as {
      sessionToken?: string;
      handleLine(line: string, nonce?: string): Promise<{ error?: { code: number }; result?: unknown; server_proof?: string }>;
    };
    // The real token file is only ever created by start() on win32; setting
    // it directly here exercises handleLine()'s auth check without needing
    // an actual Windows named pipe.
    internal.sessionToken = randomBytes(32).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const clientNonce = randomBytes(16).toString("hex");
    try {
      await withFakePlatform("win32", async () => {
        const noProof = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { _client_nonce: clientNonce } }), nonce);
        expect(noProof).toMatchObject({ error: { code: -32001 } });
        // A rejection still proves the server's own identity: mutual auth's
        // server half never depends on the client's own proof succeeding.
        expect(noProof.server_proof).toBe(pipeServerProof(internal.sessionToken!, nonce, clientNonce));

        const plaintextToken = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { _session_token: internal.sessionToken, _client_nonce: clientNonce } }), nonce);
        expect(plaintextToken).toMatchObject({ error: { code: -32001 } });

        const wrongProof = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { _proof: "0".repeat(64), _client_nonce: clientNonce } }), nonce);
        expect(wrongProof).toMatchObject({ error: { code: -32001 } });

        const correctProof = pipeAuthProof(internal.sessionToken!, nonce);
        const authorized = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { _proof: correctProof, _client_nonce: clientNonce } }), nonce);
        expect(authorized.error).toBeUndefined();
        expect(authorized.server_proof).toBe(pipeServerProof(internal.sessionToken!, nonce, clientNonce));

        // health never needs a client proof, even on win32, but its reply
        // still carries a server_proof bound to whatever client_nonce came
        // with the request -- no static, replayable signature.
        const health = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: { _client_nonce: clientNonce } }), nonce);
        expect(health.error).toBeUndefined();
        expect(health.result).not.toHaveProperty("signature");
        expect(health.server_proof).toBe(pipeServerProof(internal.sessionToken!, nonce, clientNonce));
        // A different client_nonce yields a different, non-reusable proof.
        const otherClientNonce = randomBytes(16).toString("hex");
        const healthOther = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: { _client_nonce: otherClientNonce } }), nonce);
        expect(healthOther.server_proof).not.toBe(health.server_proof);

        // No client_nonce at all: nothing to bind a server_proof to, so the
        // reply carries none -- a verifying client must treat that exactly
        // like a wrong one, never as a valid answer.
        const noClientNonce = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"health","params":{}}', nonce);
        expect(noClientNonce.server_proof).toBeUndefined();
      });
    } finally { await daemon.stop(); }
  });
});

describe("Windows pipe authentication: client side (rpc)", () => {
  it("computes an HMAC proof of the server's nonce, sends its own client nonce, and never sends the plaintext session token", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-client-")); temporary.push(root);
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
        const params = received.params as Record<string, unknown>;
        const clientNonce = typeof params._client_nonce === "string" ? params._client_nonce : "";
        const proof = pipeAuthProof(token, nonce);
        socket.write(`${JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { proofMatchedExpected: params._proof === proof },
          server_proof: pipeServerProof(token, nonce, clientNonce),
        })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth client test"))) return;
    try {
      await withSessionToken(root, token, async () => {
        const result = await withFakePlatform("win32", () => rpc(path, "status"));
        expect((result as { proofMatchedExpected?: boolean } | undefined)?.proofMatchedExpected).toBe(true);
        expect(received).toBeDefined();
        expect(JSON.stringify(received)).not.toContain(token);
        expect(received).not.toHaveProperty("params._session_token");
        expect(typeof (received!.params as Record<string, unknown>)._client_nonce).toBe("string");
      });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("Windows pipe mutual authentication: the client verifies the server too", () => {
  it("accepts a genuine daemon's mutually authenticated replies for both health and a regular method", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-genuine-")); temporary.push(root);
    const path = testSocketPath(root, "genuine");
    const token = randomBytes(32).toString("hex");
    const server = createServer((socket) => {
      const serverNonce = randomBytes(16).toString("hex");
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce: serverNonce } })}\n`);
      let buffer = "";
      socket.on("data", (part: string) => {
        buffer += part;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string; params?: Record<string, unknown> };
        const clientNonce = typeof request.params?._client_nonce === "string" ? request.params._client_nonce : undefined;
        if (request.method !== "health" && request.params?._proof !== pipeAuthProof(token, serverNonce)) {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "Unauthorized pipe client" } })}\n`);
          return;
        }
        const result = request.method === "health" ? { ok: true } : { allowed: true, echoed: request.method };
        const reply: Record<string, unknown> = { jsonrpc: "2.0", id: request.id, result };
        if (clientNonce) reply.server_proof = pipeServerProof(token, serverNonce, clientNonce);
        socket.write(`${JSON.stringify(reply)}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth genuine-daemon test"))) return;
    try {
      await withSessionToken(root, token, () => withFakePlatform("win32", async () => {
        await expect(daemonRequest(path, "can", { action_class: "build", owner: "cadence" })).resolves.toMatchObject({
          status: "available", result: { allowed: true, echoed: "can" },
        });
      }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("rejects an impostor pipe that answers without a valid server_proof, for both health and a regular method", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-impostor-")); temporary.push(root);
    const path = testSocketPath(root, "impostor");
    // The real session token: an impostor squatting the pipe path before the
    // real daemon starts has no way to read it (a different local user, or
    // simply first). It can still speak the nonce handshake -- the pipe name
    // and wire format are public -- but cannot compute a matching
    // server_proof, so it either omits one or fabricates one.
    const token = randomBytes(32).toString("hex");
    const server = createServer((socket) => {
      const serverNonce = randomBytes(16).toString("hex");
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce: serverNonce } })}\n`);
      let buffer = "";
      socket.on("data", (part: string) => {
        buffer += part;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string };
        // A confident-looking forged answer -- exactly what a naive client
        // that trusted any reply, or a static per-token signature, would
        // have accepted before this change.
        const result = request.method === "health" ? { ok: true } : { allowed: true };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result, server_proof: "f".repeat(64) })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth impostor test"))) return;
    try {
      await withSessionToken(root, token, () => withFakePlatform("win32", async () => {
        await expect(rpc(path, "health")).resolves.toBeUndefined();
        await expect(rpc(path, "can", { action_class: "build", owner: "cadence" })).resolves.toBeUndefined();
        // The higher-level client treats the impostor exactly like no daemon
        // answering at all -- never "available" with its forged result.
        // ("absent", not "unresponsive": socketExists() always reports false
        // on win32, since there is no stat()-able pipe file there, so a
        // verification failure reads the same as no pipe existing at all.)
        await expect(daemonRequest(path, "can", { action_class: "build", owner: "cadence" })).resolves.toMatchObject({ status: "absent" });
      }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("rejects a health reply that replays a server_proof captured from a different connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-replay-")); temporary.push(root);
    const path = testSocketPath(root, "replay");
    const token = randomBytes(32).toString("hex");
    // Stands in for a server_proof an attacker captured from one genuine
    // exchange (own server_nonce, own client_nonce) and now replays on a
    // fresh connection, hoping the client accepts it without recomputing.
    const capturedServerNonce = randomBytes(16).toString("hex");
    const capturedClientNonce = randomBytes(16).toString("hex");
    const capturedProof = pipeServerProof(token, capturedServerNonce, capturedClientNonce);
    const server = createServer((socket) => {
      const serverNonce = randomBytes(16).toString("hex"); // this connection's own, unrelated nonce
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce: serverNonce } })}\n`);
      let buffer = "";
      socket.on("data", (part: string) => {
        buffer += part;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number };
        // Replays the captured proof verbatim instead of computing a real
        // one for this connection's actual server_nonce/client_nonce pair.
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true }, server_proof: capturedProof })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth replay test"))) return;
    try {
      // This connection's client generates its own fresh client_nonce (it
      // cannot be the captured one), so the replayed proof -- computed for a
      // different client_nonce as well as a different server_nonce -- can
      // never match what this connection expects.
      await withSessionToken(root, token, () => withFakePlatform("win32", async () => {
        await expect(rpc(path, "health")).resolves.toBeUndefined();
      }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("POSIX pipe path is unchanged", () => {
  it("never exchanges a nonce or a proof of any kind outside win32", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-posix-")); temporary.push(root);
    const path = join(root, "posix.sock");
    let received: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (part: string) => {
        buffer += part;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth posix test"))) return;
    try {
      const result = await withFakePlatform("darwin", () => rpc(path, "health"));
      expect(result).toEqual({ ok: true });
      const params = (received?.params ?? {}) as Record<string, unknown>;
      expect(params).not.toHaveProperty("_client_nonce");
      expect(params).not.toHaveProperty("_proof");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
