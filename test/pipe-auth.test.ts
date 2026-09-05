import { createHash, createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpc, daemonRequest, HeadroomDaemon, socketPath } from "../src/daemon.js";

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

function sha256Hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function pipeAuthProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`headroom-pipe-auth-v1:${nonce}`).digest("hex");
}
/** v2: bound to the exact request and reply bytes exchanged, not only the
 * nonce pair -- see src/daemon.ts's own pipeServerProof for why. Every fake
 * server below that plays the role of a genuine daemon computes this the
 * same way the real one does. */
function pipeServerProof(token: string, serverNonce: string, clientNonce: string, requestHash: string, replyHash: string): string {
  return createHmac("sha256", token).update(`headroom-pipe-server-v2:${serverNonce}:${clientNonce}:${requestHash}:${replyHash}`).digest("hex");
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

/** Minimal stand-in for net.Socket, implementing only what handleSocket()
 * actually calls on it. Used to exercise the server's real connection-level
 * bookkeeping (handshake deadline, idle timeout, in-flight limit) directly,
 * without needing a live platform-appropriate listener -- the same reason
 * the rest of this file drives handleLine() directly for server-side pipe
 * protocol assertions instead of a real accepted connection. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  setEncoding(): this { return this; }
  write(_data: string): boolean { return true; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

describe("Windows pipe authentication: server side (handleLine)", () => {
  it("rejects a missing or wrong client proof, accepts the correct one, and binds every reply's transcript proof to the caller's own nonce, request, and reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-server-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as {
      sessionToken?: string;
      handleLine(line: string, nonce?: string): Promise<{ replyLine: string; proofLine?: string; authenticated: boolean }>;
    };
    // The real token file is only ever created by start() on win32; setting
    // it directly here exercises handleLine()'s auth check without needing
    // an actual Windows named pipe.
    internal.sessionToken = randomBytes(32).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const clientNonce = randomBytes(16).toString("hex");
    // handleLine() now returns the reply and its transcript-proof frame as
    // two separate wire lines (see src/daemon.ts's HandledLine); parse both
    // back the way a real client does.
    async function parsed(line: string): Promise<{ reply: Record<string, unknown>; proof?: string }> {
      const handled = await internal.handleLine(line, nonce);
      const reply = JSON.parse(handled.replyLine) as Record<string, unknown>;
      const proof = handled.proofLine ? (JSON.parse(handled.proofLine) as { params: { proof: string } }).params.proof : undefined;
      return { reply, proof };
    }
    try {
      await withFakePlatform("win32", async () => {
        const noProofLine = `{"jsonrpc":"2.0","id":1,"method":"status","params":{"_client_nonce":"${clientNonce}"}}`;
        const noProof = await parsed(noProofLine);
        expect(noProof.reply).toMatchObject({ error: { code: -32001 } });
        // A rejection still proves the server's own identity: mutual auth's
        // server half never depends on the client's own proof succeeding.
        expect(noProof.proof).toBe(pipeServerProof(internal.sessionToken!, nonce, clientNonce, sha256Hex(noProofLine), sha256Hex(JSON.stringify(noProof.reply))));

        const plaintextLine = `{"jsonrpc":"2.0","id":1,"method":"status","params":{"_session_token":"${internal.sessionToken}","_client_nonce":"${clientNonce}"}}`;
        expect((await parsed(plaintextLine)).reply).toMatchObject({ error: { code: -32001 } });

        const wrongProofLine = `{"jsonrpc":"2.0","id":1,"method":"status","params":{"_proof":"${"0".repeat(64)}","_client_nonce":"${clientNonce}"}}`;
        expect((await parsed(wrongProofLine)).reply).toMatchObject({ error: { code: -32001 } });

        const correctProof = pipeAuthProof(internal.sessionToken!, nonce);
        const authorizedLine = `{"jsonrpc":"2.0","id":1,"method":"status","params":{"_proof":"${correctProof}","_client_nonce":"${clientNonce}"}}`;
        const authorized = await parsed(authorizedLine);
        expect(authorized.reply.error).toBeUndefined();
        expect(authorized.proof).toBe(pipeServerProof(internal.sessionToken!, nonce, clientNonce, sha256Hex(authorizedLine), sha256Hex(JSON.stringify(authorized.reply))));

        // health never needs a client proof, even on win32, but its reply
        // still carries a transcript proof bound to whatever client_nonce
        // came with the request -- no static, replayable signature, and the
        // proof is never folded back into the result payload itself.
        const healthLine = `{"jsonrpc":"2.0","id":1,"method":"health","params":{"_client_nonce":"${clientNonce}"}}`;
        const health = await parsed(healthLine);
        expect(health.reply.error).toBeUndefined();
        expect(health.reply).not.toHaveProperty("server_proof");
        expect(health.reply.result).not.toHaveProperty("signature");
        expect(health.proof).toBe(pipeServerProof(internal.sessionToken!, nonce, clientNonce, sha256Hex(healthLine), sha256Hex(JSON.stringify(health.reply))));
        // A different client_nonce yields a different, non-reusable proof.
        const otherClientNonce = randomBytes(16).toString("hex");
        const healthOtherLine = `{"jsonrpc":"2.0","id":1,"method":"health","params":{"_client_nonce":"${otherClientNonce}"}}`;
        const healthOther = await parsed(healthOtherLine);
        expect(healthOther.proof).not.toBe(health.proof);

        // No client_nonce at all: nothing to bind a proof to, so no proof
        // line is sent at all -- a verifying client must treat that exactly
        // like a wrong one, never as a valid answer.
        const noClientNonce = await internal.handleLine('{"jsonrpc":"2.0","id":1,"method":"health","params":{}}', nonce);
        expect(noClientNonce.proofLine).toBeUndefined();
      });
    } finally { await daemon.stop(); }
  });
});

describe("Windows pipe authentication: client side (rpc)", () => {
  it("computes an HMAC proof of the server's nonce, sends its own client nonce, verifies the server's transcript proof, and never sends the plaintext session token", async () => {
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
        const requestLine = buffer.slice(0, newline);
        received = JSON.parse(requestLine) as Record<string, unknown>;
        const params = received.params as Record<string, unknown>;
        const clientNonce = typeof params._client_nonce === "string" ? params._client_nonce : "";
        const proofMatchedExpected = params._proof === pipeAuthProof(token, nonce);
        const replyLine = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { proofMatchedExpected } });
        socket.write(`${replyLine}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof: pipeServerProof(token, nonce, clientNonce, sha256Hex(requestLine), sha256Hex(replyLine)) } })}\n`);
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
        const requestLine = buffer.slice(0, newline);
        const request = JSON.parse(requestLine) as { id: number; method: string; params?: Record<string, unknown> };
        const clientNonce = typeof request.params?._client_nonce === "string" ? request.params._client_nonce : "";
        if (request.method !== "health" && request.params?._proof !== pipeAuthProof(token, serverNonce)) {
          const replyLine = JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "Unauthorized pipe client" } });
          socket.write(`${replyLine}\n`);
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof: pipeServerProof(token, serverNonce, clientNonce, sha256Hex(requestLine), sha256Hex(replyLine)) } })}\n`);
          return;
        }
        const result = request.method === "health" ? { ok: true } : { allowed: true, echoed: request.method };
        const replyLine = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
        socket.write(`${replyLine}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof: pipeServerProof(token, serverNonce, clientNonce, sha256Hex(requestLine), sha256Hex(replyLine)) } })}\n`);
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

  it("rejects an impostor pipe that answers without a valid transcript proof, for both health and a regular method", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-impostor-")); temporary.push(root);
    const path = testSocketPath(root, "impostor");
    // The real session token: an impostor squatting the pipe path before the
    // real daemon starts has no way to read it (a different local user, or
    // simply first). It can still speak the nonce handshake -- the pipe name
    // and wire format are public -- but cannot compute a matching transcript
    // proof, so it either omits one or fabricates one.
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
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof: "f".repeat(64) } })}\n`);
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

  it("rejects a health reply that replays a transcript proof captured from a different exchange", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-auth-replay-")); temporary.push(root);
    const path = testSocketPath(root, "replay");
    const token = randomBytes(32).toString("hex");
    // Stands in for a proof an attacker captured from one genuine exchange
    // (its own server_nonce, client_nonce, request bytes, and reply bytes)
    // and now replays on a fresh connection, hoping the client accepts it
    // without recomputing.
    const capturedProof = pipeServerProof(
      token, randomBytes(16).toString("hex"), randomBytes(16).toString("hex"),
      sha256Hex('{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'), sha256Hex('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'),
    );
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
        // one for this connection's actual server_nonce/client_nonce/
        // request/reply.
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof: capturedProof } })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth replay test"))) return;
    try {
      // This connection's client generates its own fresh client_nonce (it
      // cannot be the captured one), so the replayed proof -- computed for a
      // different client_nonce, request, and reply -- can never match what
      // this connection expects.
      await withSessionToken(root, token, () => withFakePlatform("win32", async () => {
        await expect(rpc(path, "health")).resolves.toBeUndefined();
      }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  // F16(a): before binding the reply into the proof, a live relay could
  // forward a genuine handshake, get a genuinely-proved answer to *some*
  // request from the real daemon, and hand the client different result
  // content while replaying that same proof -- the proof only ever checked
  // the nonce pair, which never changes when the payload does.
  it("rejects a reply whose content differs from the bytes a genuine transcript proof was actually computed over", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-reply-sub-")); temporary.push(root);
    const path = testSocketPath(root, "reply-sub");
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
        const requestLine = buffer.slice(0, newline);
        const request = JSON.parse(requestLine) as { id: number; params?: Record<string, unknown> };
        const clientNonce = typeof request.params?._client_nonce === "string" ? request.params._client_nonce : "";
        // A genuine proof, correctly computed over a genuine denial reply --
        // then the connection hands the client a *different*, more
        // favorable result while still attaching that same proof.
        const genuineReplyLine = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { allowed: false, reason: "genuine denial" } });
        const genuineProof = pipeServerProof(token, serverNonce, clientNonce, sha256Hex(requestLine), sha256Hex(genuineReplyLine));
        const substitutedReplyLine = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { allowed: true } });
        socket.write(`${substitutedReplyLine}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof: genuineProof } })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth reply-sub test"))) return;
    try {
      await withSessionToken(root, token, () => withFakePlatform("win32", async () => {
        await expect(rpc(path, "can", { action_class: "build", owner: "cadence" })).resolves.toBeUndefined();
      }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  // F16(a), the other half: a relay that swaps the request it actually sends
  // the real daemon for a different one than the client asked. The daemon's
  // proof is honest about the request it received; that just is not the
  // request this connection's client sent, so the hash never matches.
  it("rejects a proof computed over a different request than the one this connection actually sent", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-req-sub-")); temporary.push(root);
    const path = testSocketPath(root, "request-sub");
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
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number; params?: Record<string, unknown> };
        const clientNonce = typeof request.params?._client_nonce === "string" ? request.params._client_nonce : "";
        const replyLine = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { allowed: true } });
        // Computed over a stand-in "different request" -- the bytes a relay
        // actually forwarded to a real daemon -- never the bytes this
        // connection's own client sent.
        const proof = pipeServerProof(token, serverNonce, clientNonce, sha256Hex('{"jsonrpc":"2.0","id":1,"method":"quota_status","params":{}}'), sha256Hex(replyLine));
        socket.write(`${replyLine}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof } })}\n`);
      });
    });
    if (!(await listenOrSkip(server, path, "pipe-auth request-sub test"))) return;
    try {
      await withSessionToken(root, token, () => withFakePlatform("win32", async () => {
        await expect(rpc(path, "can", { action_class: "build", owner: "cadence" })).resolves.toBeUndefined();
      }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

// F16(b): socketPath()'s win32 branch canonicalizes the home before hashing
// it (see src/paths.ts's canonicalizeHomeForPipe and test/socket-path.test.ts
// for the pure-function coverage). This is the concrete regression the
// finding described: the daemon's realpath'd home and a client's raw,
// differently-spelled HEADROOM_HOME must land on one pipe.
describe("Windows pipe naming: equivalent home spellings select one pipe", () => {
  it("gives a daemon's realpath-shaped home and a client's raw, differently-spelled HEADROOM_HOME the same pipe name", () => {
    const daemonHome = "C:\\Users\\example\\headroom";
    const clientHome = "c:\\Users\\example\\headroom\\";
    expect(socketPath(clientHome, "win32", "example")).toBe(socketPath(daemonHome, "win32", "example"));
  });
});

// F3: the connection cap counted unauthenticated pipe connections with no
// deadline on ever completing the handshake, so one could hold its slot
// forever. handleSocket() is exercised directly against a fake socket here
// for the same reason handleLine() is elsewhere in this file: a real
// platform-appropriate listener isn't available on this host.
describe("Windows pipe connections: an unauthenticated connection cannot hold its slot forever", () => {
  it("closes a connection that never completes the proof handshake once the deadline passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-handshake-deadline-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({
      home: root, path: join(root, "headroom.sock"),
      connectionLimits: { handshakeDeadlineMs: 30, idleTimeoutMs: 30_000, maxPendingWriteBytes: 1024 * 1024 },
    });
    const internal = daemon as unknown as { handleSocket(socket: unknown): void };
    const fake = new FakeSocket();
    try {
      await withFakePlatform("win32", async () => {
        internal.handleSocket(fake);
        expect(fake.destroyed).toBe(false); // immediately after connecting: the deadline has not passed yet
        await new Promise((resolve) => setTimeout(resolve, 90));
        expect(fake.destroyed).toBe(true);
      });
    } finally { await daemon.stop(); }
  });
});

// F4: rpc()'s receive loop previously had no cap on total bytes received and
// no absolute deadline independent of the inactivity timer, so an
// unauthenticated impostor holding a connection open could make the client
// allocate without bound by continuously sending data.
describe("Windows pipe client bounds: an impostor cannot exhaust client memory or hold a connection open forever", () => {
  it("rejects a response once its total size crosses the client's bound instead of buffering it without limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-big-resp-")); temporary.push(root);
    const path = testSocketPath(root, "big-resp");
    const server = createServer((socket) => {
      const nonce = randomBytes(16).toString("hex");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce } })}\n`);
      // Never sends a real reply -- just keeps streaming bytes with no
      // newline, the shape a pipe impostor (no session token, so it could
      // never produce a valid proof anyway) could use to try to keep a naive
      // client allocating forever.
      const chunk = "x".repeat(64 * 1024);
      const timer = setInterval(() => { if (!socket.destroyed) socket.write(chunk); }, 1);
      socket.once("close", () => clearInterval(timer));
      // The client destroys its side once it crosses the size bound; a write
      // racing that on the server side raises EPIPE, which -- with no
      // listener -- would otherwise surface as an uncaught exception rather
      // than just ending this fake server's one connection.
      socket.once("error", () => clearInterval(timer));
    });
    if (!(await listenOrSkip(server, path, "pipe-auth big-resp test"))) return;
    try {
      await withFakePlatform("win32", async () => {
        await expect(rpc(path, "health", {}, 5_000)).resolves.toBeUndefined();
      });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 10_000);

  it("rejects a nonce frame whose value is not exactly 32 lowercase hex characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-pipe-big-nonce-")); temporary.push(root);
    const path = testSocketPath(root, "big-nonce");
    const server = createServer((socket) => {
      // Not a genuine daemon nonce (randomBytes(16).toString("hex") is
      // always exactly 32 lowercase hex characters) -- oversized and
      // non-hex, the shape a malformed or hostile pipe could send instead.
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce: "g".repeat(400) } })}\n`);
    });
    if (!(await listenOrSkip(server, path, "pipe-auth big-nonce test"))) return;
    try {
      await withFakePlatform("win32", async () => {
        await expect(rpc(path, "health")).resolves.toBeUndefined();
      });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe.skipIf(process.platform === "win32")("POSIX pipe path is unchanged", () => {
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
