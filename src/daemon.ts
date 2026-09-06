import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { readPolicy, readRouting } from "./config.js";
import { claudeGrantGate, syncClaudeGrantState } from "./adapters/claude.js";
import { pollAccounts, withBackoffReasons, PROTECTED_STATUS_PATTERN, type AntigravityLocalRead, type PollOptions, type PollResult } from "./collector.js";
import { AgyKeepaliveSupervisor, resolveAgyBinary } from "./antigravity-keepalive.js";
import { appendDaemonLog } from "./logs.js";
import { canonicalizeHomeForPipe, executablePath, headroomHome, joinForPlatform } from "./paths.js";
import { canRouteWithLeases, unknownMeterPrincipals, type Policy } from "./policy.js";
import { withResetsIn } from "./resets.js";
import { withPaceInfo } from "./pace.js";
import { fillFor, gateFor, planFor, rateLines } from "./orchestrator-reads.js";
import type { GateNeed } from "./pacing.js";
import { deliverNotifications } from "./notify.js";
import { accountsPath, readAccounts } from "./registry.js";
import { isLocalAccount, type Account, type Observation, type ProviderAccount } from "./types.js";
import { safeHeadroomDirectory, HeadroomStore } from "./store.js";
import { safeError, stripAmbientProxyEnvironment } from "./security.js";

type Json = Record<string, unknown>;
export type Poller = (principal?: string, options?: PollOptions) => Promise<PollResult>;

/** What handleLine() actually hands back to the socket to write out: the
 * reply line always; the transcript-proof line only when this connection is
 * proving its identity (win32, once nonces are established); `authenticated`
 * tells handleSocket() this call itself cleared the win32 proof check, so it
 * can cancel the connection's handshake deadline. Kept as two separate wire
 * lines rather than one object with the proof folded in, precisely so
 * neither side ever needs to reconstruct "the reply bytes minus one field" --
 * see pipeServerProof's and finish()'s own comments for why that would be
 * ambiguous. */
interface HandledLine { replyLine: string; proofLine?: string; authenticated: boolean; }

/** A local, single-user daemon still bounds what any one connection can hold
 * in memory and how many can be open at once, rather than trusting every
 * caller on the machine to behave. */
const MAX_CONNECTION_BUFFER_BYTES = 64 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 64;
// Client-side bounds on a pipe reply (rpc(), below): a connection that never
// authenticates can otherwise stream data forever and make this process
// allocate without bound, or hold the promise open past any sane deadline
// even though the inactivity timer keeps resetting on every byte it sends.
const MAX_RPC_RESPONSE_BYTES = 256 * 1024;
const RPC_ABSOLUTE_DEADLINE_MS = 10_000;

function sha256Hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function socketPath(home = headroomHome(), platform = process.platform, username = userInfo().username): string {
  // joinForPlatform, not a bare join(): join() always uses the *host* OS's
  // separator, which would mis-simulate a non-native `platform` argument
  // (e.g. a "linux" home path on a real Windows host) with backslashes.
  // A named pipe has no directory, so the pipe name carries a digest of the
  // Headroom home: two homes for one Windows user (or two test daemons on
  // one runner) get two pipes instead of fighting over one. The home is run
  // through canonicalizeHomeForPipe first -- and only there -- so the
  // daemon (which calls this with a realpath'd home) and a client (which
  // calls it with the raw, un-resolved HEADROOM_HOME) always agree on one
  // digest for one directory, whatever separator style or case either side
  // happened to spell it with.
  if (platform === "win32") {
    const homeDigest = sha256Hex(canonicalizeHomeForPipe(home, platform)).slice(0, 8);
    return `\\\\.\\pipe\\headroom-${username}-${homeDigest}`;
  }
  return joinForPlatform(platform, home, "headroom.sock");
}

const SESSION_FILE = "pipe-session-token";
async function sessionToken(home = headroomHome(), create = false): Promise<string | undefined> {
  const path = join(home, SESSION_FILE);
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("unsafe");
    return token;
  } catch (error: unknown) {
    if (!create) return undefined;
    const token = randomBytes(32).toString("hex");
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "w" });
    if (process.platform !== "win32") await chmod(path, 0o600);
    return token;
  }
}
/** HMAC of a per-connection server nonce, keyed by the session token. The
 * client proves it holds the token by sending this proof; the raw token
 * itself never has to cross the pipe, so another local user who squats the
 * predictable pipe name before the real daemon starts (and so gets a live
 * connection from an unsuspecting client) learns nothing usable -- an HMAC
 * output does not reveal its key. */
function pipeAuthProof(token: string, nonce: string): string { return createHmac("sha256", token).update(`headroom-pipe-auth-v1:${nonce}`).digest("hex"); }

/** The other half of mutual authentication: proves the *server* holds the
 * session token, so a process that squats the pipe path before the real
 * daemon starts cannot forge answers even though the nonces it needs travel
 * in plain text. Binding both the server's own per-connection nonce and the
 * client's freshly generated one means a reply captured on one connection
 * (for example a `health` reply, which needs no client proof to request)
 * can never be replayed on another connection -- the pair never repeats.
 *
 * v2 additionally binds the transcript itself: requestHash and replyHash are
 * SHA-256 hex digests of the exact bytes the server received for the request
 * line and is about to send for the reply line. v1 bound only the nonce pair,
 * which is enough to stop replay across connections but not enough to stop a
 * live relay that forwards a genuine nonce handshake and then substitutes the
 * request it actually sends the real daemon, or the reply it hands back to
 * the waiting client -- the nonce pair alone never changes when the payload
 * does. Binding both hashes closes that gap: any substitution on either side
 * changes a hash, and the proof no longer verifies. */
function pipeServerProof(token: string, serverNonce: string, clientNonce: string, requestHash: string, replyHash: string): string {
  return createHmac("sha256", token).update(`headroom-pipe-server-v2:${serverNonce}:${clientNonce}:${requestHash}:${replyHash}`).digest("hex");
}

/** Byte-length-safe constant-time string compare. Buffer.from(x).length is a
 * byte count, not the string's UTF-16 length; comparing string.length before
 * calling timingSafeEqual (the prior check) can pass while the byte buffers
 * still differ in length, which throws instead of just failing closed. */
function safeTimingEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && bufferA.length > 0 && timingSafeEqual(bufferA, bufferB);
}

function rpcResult(id: unknown, result: unknown): Json { return { jsonrpc: "2.0", id: id ?? null, result }; }
function rpcError(id: unknown, code: number, message: string): Json { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function parseResetWindows(value: unknown): Array<Pick<Observation, "meter_id" | "window" | "resets_at">> {
  const candidates = Array.isArray(value) ? value : [];
  return candidates.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { meter_id?: unknown; minutes?: unknown; resets_at?: unknown };
    if (typeof candidate.meter_id !== "string" || (typeof candidate.minutes !== "number" && candidate.minutes !== null)) return [];
    return [{ meter_id: candidate.meter_id, window: candidate.minutes === null ? null : { kind: "rolling" as const, minutes: candidate.minutes, enforcement: "hard" as const }, resets_at: typeof candidate.resets_at === "string" ? candidate.resets_at : null }];
  });
}

function callerFrom(params: Json): string {
  const caller = params._caller;
  if (!caller || typeof caller !== "object") return "peer:unavailable";
  const value = caller as Json;
  const pid = typeof value.pid === "number" ? String(value.pid) : "unknown";
  const processName = typeof value.process === "string" ? basename(value.process).slice(0, 80) : "unknown";
  return `pid:${pid};process:${processName}`;
}

export interface ConnectionLimits {
  /** Windows only: a pipe connection that has not completed the proof
   * handshake -- any non-`health` request whose proof checks out -- within
   * this many milliseconds is closed. POSIX authenticates a connection the
   * instant it is accepted (the 0600 socket file already decided who could
   * connect at all), so this never applies there. */
  handshakeDeadlineMs: number;
  /** Either platform: a connection with no complete request line for this
   * long is closed; the timer resets each time one arrives. */
  idleTimeoutMs: number;
  /** Either platform: a connection is destroyed, rather than left to buffer
   * writes without bound, once its own unwritten output exceeds this. */
  maxPendingWriteBytes: number;
}
const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = { handshakeDeadlineMs: 5_000, idleTimeoutMs: 30_000, maxPendingWriteBytes: 1024 * 1024 };

export class HeadroomDaemon {
  private server: Server | undefined;
  private readonly inFlight = new Map<string, Promise<PollResult>>();
  private readonly lastPoll = new Map<string, number>();
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  private readonly schedulers = new Map<string, NodeJS.Timeout>();
  private accounts: Account[] = [];
  private accountsMtime: number | undefined;
  private schedulingStarted = false;
  private stopping = false;
  private sessionToken: string | undefined;
  private keepalive: AgyKeepaliveSupervisor | undefined;
  private readonly antigravityLocal = new Map<string, AntigravityLocalRead>();
  private connectionCount = 0;

  private constructor(private readonly store: HeadroomStore, private readonly path: string, private readonly poller: Poller, private readonly home: string, keepalive: AgyKeepaliveSupervisor | undefined, private readonly connectionLimits: ConnectionLimits) { this.keepalive = keepalive; }

  static async create(options: { home?: string; path?: string; poller?: Poller; keepalive?: AgyKeepaliveSupervisor; connectionLimits?: Partial<ConnectionLimits> } = {}): Promise<HeadroomDaemon> {
    const home = await safeHeadroomDirectory(options.home);
    return new HeadroomDaemon(await HeadroomStore.open(home), options.path ?? socketPath(home), options.poller ?? pollAccounts, home, options.keepalive, { ...DEFAULT_CONNECTION_LIMITS, ...options.connectionLimits });
  }

  async start(): Promise<void> {
    // Before any fetch can happen: an operator's shell proxy must never
    // silently carry a credentialed vendor request unless policy.toml opts in.
    const startupPolicy = await readPolicy();
    stripAmbientProxyEnvironment(startupPolicy.proxy);
    // The session token always lives under the daemon's own resolved home
    // (this.home), never derived from this.path: this.path is a named pipe
    // in production (nothing to write a token file relative to) and, in
    // tests, sometimes a bare filename standing in for one -- neither is a
    // directory the token file could sensibly live under.
    if (process.platform === "win32") this.sessionToken = await sessionToken(this.home, true);
    await this.prepareSocket();
    this.server = createServer((socket) => this.handleSocket(socket));
    // A restrictive umask means the OS never briefly creates the socket file
    // group- or world-connectable between listen() and the chmod below.
    if (process.platform !== "win32") process.umask(0o077);
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.path, resolve));
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    this.installReloadHandlers();
    // Keepalive is secondary now that the remote quota endpoint can answer
    // directly: it is never started here at boot, only lazily by
    // maybeStartKeepalive() below, the first time a poll's remote read for
    // an Antigravity principal comes back short of real buckets. A daemon
    // whose remote reads are always real spawns agy exactly never.
    await this.schedulePrincipals();
    this.schedulingStarted = true;
  }

  /**
   * Starts the daemon-owned warm `agy` only when it isn't already running
   * and policy/platform allow it -- called after a poll's remote Antigravity
   * read comes back without real buckets (availability-only, a 403, or a
   * transport failure), never unconditionally at daemon startup. No-op once
   * agy is already running: keepalive, once started, keeps running the way
   * it always has, rather than stopping and restarting as remote recovers.
   */
  private async maybeStartKeepalive(accounts: Account[], policy: Policy): Promise<void> {
    if (this.keepalive?.running) return;
    if (!policy.antigravity_keepalive || process.platform === "win32") return;
    const antigravity = accounts.find((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "antigravity");
    if (!antigravity) return;
    // agy_path is a value from accounts.toml; verify ownership, mode, and
    // that it isn't a symlink before ever spawning it, the same bar every
    // other executable Headroom runs must clear.
    try {
      const binary = await executablePath(resolveAgyBinary(antigravity.agy_path));
      this.keepalive ??= new AgyKeepaliveSupervisor({ binary });
      this.keepalive.start();
    } catch (error) {
      void appendDaemonLog(`antigravity keepalive not started: ${safeError(error)}`, this.home);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.schedulers.values()) clearTimeout(timer);
    this.schedulers.clear();
    this.keepalive?.stop();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
    this.store.close();
    if (process.platform !== "win32") try { await unlink(this.path); } catch { /* already gone */ }
  }

  private async prepareSocket(): Promise<void> {
    if (process.platform === "win32") {
      // Node creates the pipe with the current process token's current-user DACL.
      const daemon = await daemonRequest(this.path, "health");
      if (daemon.status === "available") throw new Error("Headroom daemon is already running");
      if (daemon.status === "unresponsive") throw new Error("Headroom daemon pipe is present but health did not respond within 2s");
      return;
    }
    try {
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("Refusing unsafe headroom socket");
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing headroom socket owned by another user");
      if ((stat.mode & 0o077) !== 0) throw new Error("Refusing headroom socket with group or world permissions");
      const daemon = await daemonRequest(this.path, "health");
      if (daemon.status === "available") throw new Error("Headroom daemon is already running");
      if (daemon.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
      await unlink(this.path); // a safe, inaccessible stale socket only
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private handleSocket(socket: Socket): void {
    if (this.connectionCount >= MAX_CONCURRENT_CONNECTIONS) { socket.destroy(); return; }
    this.connectionCount += 1;
    let closed = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let handshakeTimer: NodeJS.Timeout | undefined;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      this.connectionCount -= 1;
      if (idleTimer) clearTimeout(idleTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
    };
    socket.once("close", closeOnce);
    // A socket with no "error" listener turns a peer reset, or any other
    // transport failure, into an uncaught exception that crashes the whole
    // daemon process instead of costing just this one connection its slot.
    socket.once("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let processing = false;
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.destroy(), this.connectionLimits.idleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdleTimer();
    // Windows only: POSIX has nothing to hand-shake -- the 0600 socket file
    // already decided who could connect at all before accept() ever ran.
    let authenticated = process.platform !== "win32";
    if (!authenticated) {
      handshakeTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, this.connectionLimits.handshakeDeadlineMs);
      handshakeTimer.unref?.();
    }
    const safeWrite = (line: string): void => {
      if (socket.destroyed) return;
      // Bounded output: a client that stops reading its replies (or was
      // never going to) must not let this connection's unwritten output grow
      // without limit -- destroy it instead of buffering forever.
      if (socket.writableLength > this.connectionLimits.maxPendingWriteBytes) { socket.destroy(); return; }
      socket.write(line);
    };
    // Windows only: a fresh random nonce per connection, sent before anything
    // else. The client proves it holds the session token by HMAC-ing this
    // nonce (see pipeAuthProof); the token itself is read from the local
    // 0600 token file, never placed on the wire.
    const nonce = process.platform === "win32" ? randomBytes(16).toString("hex") : undefined;
    if (nonce) safeWrite(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce } })}\n`);
    socket.on("data", (part: string) => {
      buffer += part;
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONNECTION_BUFFER_BYTES) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        // One request in flight per connection: every real client (rpc(),
        // below) opens a fresh connection per request and never pipelines a
        // second one onto it, so a further complete line arriving before the
        // first has been answered is either a confused client or an attempt
        // to pile up concurrent work on a single connection slot -- close
        // rather than queue it.
        if (processing) { socket.destroy(); return; }
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        processing = true;
        resetIdleTimer();
        void this.handleLine(line, nonce).then(({ replyLine, proofLine, authenticated: provedThisCall }) => {
          processing = false;
          if (provedThisCall) { authenticated = true; if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = undefined; } }
          safeWrite(`${replyLine}\n`);
          if (proofLine) safeWrite(`${proofLine}\n`);
        });
      }
    });
  }

  private async handleLine(line: string, nonce?: string): Promise<HandledLine> {
    // Hashed unconditionally, from the exact bytes received, before any
    // parsing: this becomes part of the win32 transcript proof below (see
    // pipeServerProof's own comment), binding the *request* into the
    // exchange so a relay that forwards a genuine handshake but substitutes
    // the request text it actually sends the real daemon can never pass that
    // daemon's honest reply off as an answer to a different request the
    // waiting client believes it asked.
    const requestHash = sha256Hex(line);
    let request: Json;
    // A malformed envelope (null, a bare string/number, an array, or an
    // object missing method) must produce a JSON-RPC error, never throw:
    // `request.jsonrpc` on a non-object `request` (e.g. the JSON literal
    // `null`) would otherwise throw here, escaping as an unhandled rejection
    // since handleSocket's `.then()` below has no `.catch()`. A line that
    // fails to parse at all has no client nonce to bind a proof to either,
    // so it is returned as a plain, unproved reply line -- exactly like the
    // "no client_nonce at all" case below.
    try { request = JSON.parse(line) as Json; } catch { return { replyLine: JSON.stringify(rpcError(null, -32700, "Parse error")), authenticated: false }; }
    // Read defensively, ahead of the envelope-shape check below: even an
    // "Invalid Request" reply needs a server_proof, and the client's own
    // nonce (echoed back into every server_proof so a reply is bound to this
    // exact connection and cannot be replayed onto a different one -- see
    // pipeServerProof's own comment) is read from params regardless of
    // whether the rest of the envelope turns out to be well-formed.
    const rawParams = request && typeof request === "object" && !Array.isArray(request) && request.params && typeof request.params === "object" ? request.params as Json : {};
    const clientNonce = process.platform === "win32" && typeof rawParams._client_nonce === "string" && /^[0-9a-f]{32}$/.test(rawParams._client_nonce) ? rawParams._client_nonce : undefined;
    let authenticatedThisCall = false;
    const finish = (reply: Json): HandledLine => {
      if (process.platform === "win32" && nonce && clientNonce && this.sessionToken) {
        const replyLine = JSON.stringify(reply);
        const replyHash = sha256Hex(replyLine);
        const proof = pipeServerProof(this.sessionToken, nonce, clientNonce, requestHash, replyHash);
        // The proof travels on its own line, sent immediately after the
        // reply line, so what the client hashes to verify it is exactly the
        // bytes it already received for the reply -- never a value it has to
        // reconstruct by parsing the reply, deleting a field, and
        // re-serializing, which would depend on reproducing this object's
        // exact key order. See F16 in docs/reports for why that
        // reconstruction approach was rejected as ambiguous.
        const proofLine = JSON.stringify({ jsonrpc: "2.0", method: "transcript_proof", params: { proof } });
        return { replyLine, proofLine, authenticated: authenticatedThisCall };
      }
      return { replyLine: JSON.stringify(reply), authenticated: authenticatedThisCall };
    };
    if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      const id = request && typeof request === "object" && !Array.isArray(request) ? (request as Json).id : null;
      return finish(rpcError(id, -32600, "Invalid Request"));
    }
    const params = rawParams;
    const caller = callerFrom(params);
    // A rejected request is still audited before it returns: a caller
    // learning nothing about capacity does not mean the daemon saw nothing.
    const reject = (code: number, message: string, subject: string | null = null): HandledLine => {
      this.store.audit(caller, request.method as string, subject, "rejected");
      return finish(rpcError(request.id, code, message));
    };
    if (process.platform === "win32" && request.method !== "health") {
      const received = typeof params._proof === "string" ? params._proof : "";
      const expected = nonce && this.sessionToken ? pipeAuthProof(this.sessionToken, nonce) : "";
      if (!expected || !safeTimingEqual(received, expected)) return reject(-32001, "Unauthorized pipe client");
      authenticatedThisCall = true;
    }
    try {
      let result: unknown;
      switch (request.method) {
        case "status": {
          await this.poll(undefined, false);
          const now = new Date();
          const observations = this.store.latestPerWindow().filter((item) => this.accounts.some((account) => account.name === item.principal_id));
          // A principal currently sitting out a live vendor 429 backoff (see
          // poll()'s own backoff bookkeeping) still serves whatever it last
          // read, unchanged, except its reason: naming the real deadline this
          // backoff actually lifts at beats repeating the original failure
          // message, which only grows staler while the backoff runs.
          const withBackoff = withBackoffReasons(observations, (id) => this.backoff.get(id)?.until ?? this.backoff.get("all")?.until, now.getTime());
          result = withResetsIn(withPaceInfo(withBackoff, this.store.burnRateFor(withBackoff, now), now));
          break;
        }
        case "history": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 86_400_000).toISOString();
          if (!meter) return reject(-32602, "meter is required");
          result = this.store.history(meter, since); break;
        }
        case "events": {
          const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 86_400_000).toISOString();
          result = this.store.events(since); break;
        }
        case "can": {
          const action = typeof params.action_class === "string" ? params.action_class : "";
          if (typeof params.owner !== "string" || !params.owner.trim()) return reject(-32602, "owner is required");
          const routing = await readRouting();
          if (!routing.present) return reject(-32602, "No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
          const meters = routing.consumes[action];
          if (!meters) return reject(-32602, `Unknown action class: ${action || "(missing)"}`, action || null);
          const accounts = await this.currentAccounts();
          const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
          if (unknownMeters.length) return reject(-32602, `Routing action class ${action} names unknown meter(s): ${unknownMeters.join(", ")}`, action);
          await this.poll(undefined, false);
          const policy = await readPolicy();
          const localMeters = accounts.filter(isLocalAccount).map((account) => `${account.name}:capacity`);
          const allMeters = [...new Set([...meters, ...localMeters])];
          const now = new Date();
          const rows = new Map(allMeters.map((meter) => [meter, this.store.latestPerWindow(meter)]));
          const burn = this.store.burnRateFor([...rows.values()].flat(), now);
          const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
          result = canRouteWithLeases(meters, localMeters, enriched, routing.local_preference, policy, params.allow_unknown === true, this.store.leases(undefined, true), params.owner, now);
          break;
        }
        case "lease_start": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          const meter = typeof params.meter_id === "string" ? params.meter_id : "";
          const expected = typeof params.expected_percent === "number" ? params.expected_percent : null;
          const ttl = typeof params.ttl_ms === "number" ? params.ttl_ms : 30 * 60_000;
          const actionClass = typeof params.action_class === "string" && params.action_class.trim() ? params.action_class.trim() : null;
          result = this.store.startLease(owner, meter, expected, ttl, typeof params.note === "string" ? params.note : null, new Date(), actionClass); break;
        }
        case "lease_end": {
          if (typeof params.id !== "string") return reject(-32602, "lease id is required");
          if (typeof params.owner !== "string" || !params.owner.trim()) return reject(-32602, "owner is required");
          result = this.store.endLease(params.id, params.owner, params.force === true);
          if (params.force === true && (result as { owner: string }).owner !== params.owner) {
            const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim().slice(0, 200) : "(no reason given)";
            this.store.audit(caller, "lease_force_end", `${params.owner}->${(result as { owner: string }).owner}:${params.id} reason=${reason}`, "ok");
          }
          break;
        }
        case "leases": result = this.store.leases(undefined, true); break;
        case "refresh": {
          const principal = typeof params.principal === "string" ? params.principal : undefined;
          result = await this.poll(principal, true); break;
        }
        case "reset_seen": {
          result = Object.fromEntries(this.store.resetSeenFor(parseResetWindows(params.windows))); break;
        }
        case "free_reset_used": {
          result = Object.fromEntries(this.store.freeResetUsedFor(parseResetWindows(params.windows))); break;
        }
        case "cost": {
          const actionClass = typeof params.action_class === "string" && params.action_class.trim() ? params.action_class.trim() : undefined;
          result = this.store.learnedCost(actionClass); break;
        }
        case "rate": {
          const meter = typeof params.meter === "string" ? params.meter : undefined;
          const minutes = typeof params.minutes === "number" && params.minutes > 0 ? params.minutes : 30;
          const owner = typeof params.owner === "string" && params.owner.trim() ? params.owner.trim() : undefined;
          result = rateLines(this.store, meter, minutes, new Date(), owner); break;
        }
        case "spend": {
          const meter = typeof params.meter === "string" && params.meter.trim() ? params.meter.trim() : undefined;
          const owner = typeof params.owner === "string" && params.owner.trim() ? params.owner.trim() : undefined;
          const sinceValue = typeof params.since === "string" && params.since.trim() ? params.since.trim() : new Date(Date.now() - 86_400_000).toISOString();
          result = this.store.spendByOwner({ meter, owner, since: sinceValue }); break;
        }
        case "plan": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          if (!meter) return reject(-32602, "meter is required");
          const policy = await readPolicy();
          const reserve = typeof params.reserve_percent === "number" ? params.reserve_percent : policy.freeze_reserve_pct;
          result = planFor(this.store, meter, reserve, new Date(), policy.staleness_minutes, policy.reserve); break;
        }
        case "gate": {
          const meter: string | string[] | undefined = typeof params.meter === "string" ? params.meter
            : Array.isArray(params.meter) ? params.meter.filter((item): item is string => typeof item === "string")
            : undefined;
          const rawNeeds = Array.isArray(params.needs) ? params.needs : [];
          const needs: GateNeed[] = rawNeeds.flatMap((item) => {
            const candidate = item as { window?: unknown; points?: unknown };
            return (candidate.window === "5h" || candidate.window === "wk") && typeof candidate.points === "number" ? [{ window: candidate.window, points: candidate.points }] : [];
          });
          if (!needs.length) return reject(-32602, "needs is required");
          await this.poll(undefined, false);
          const policy = await readPolicy();
          const reserve = typeof params.reserve_percent === "number" ? params.reserve_percent : policy.freeze_reserve_pct;
          const owner = typeof params.owner === "string" ? params.owner : undefined;
          const planShare = typeof params.plan_share_percent === "number" ? params.plan_share_percent : undefined;
          const actionClass = typeof params.action_class === "string" ? params.action_class : undefined;
          result = gateFor(this.store, needs, meter, reserve, params.plan === true, new Date(), { owner, planSharePercent: planShare, actionClass, pacing: policy.pacing, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve }); break;
        }
        case "fill": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          if (!meter) return reject(-32602, "meter is required");
          const laneCost = typeof params.lane_cost_percent === "number" ? params.lane_cost_percent : undefined;
          const policy = await readPolicy();
          const weeklyReserve = typeof params.weekly_reserve_percent === "number" ? params.weekly_reserve_percent : policy.freeze_reserve_pct;
          const owner = typeof params.owner === "string" ? params.owner : undefined;
          const planShare = typeof params.plan_share_percent === "number" ? params.plan_share_percent : undefined;
          result = await fillFor(this.store, meter, laneCost, weeklyReserve, new Date(), { owner, planSharePercent: planShare, pacing: policy.pacing, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve }); break;
        }
        case "health": result = {
          socket: this.path,
          in_flight: this.inFlight.size,
          backoff: [...this.backoff.entries()].map(([principal, item]) => ({ principal, until: new Date(item.until).toISOString(), failures: item.failures })),
          keepalive: {
            running: this.keepalive?.running === true,
            pid: this.keepalive?.pid ?? null,
            uptime_ms: this.keepalive?.uptimeMs ?? null,
            login_state: this.keepalive?.loginState ?? "unknown",
            local_reads: Object.fromEntries(this.antigravityLocal),
          },
        }; break;
        default: return reject(-32601, "Method not found");
      }
      // For a lease call the audit row also names the owner and meter, since
      // `caller` alone (the peer pid/argv[1] the client reports at every
      // request, see callerFrom) does not identify which lease was touched.
      const auditSubject = request.method === "lease_start" ? `${typeof params.owner === "string" ? params.owner : "?"}:${typeof params.meter_id === "string" ? params.meter_id : "?"}`
        : request.method === "lease_end" ? `${typeof params.owner === "string" ? params.owner : "?"}:${typeof params.id === "string" ? params.id : "?"}`
        : typeof params.principal === "string" ? params.principal : typeof params.meter === "string" ? params.meter : null;
      this.store.audit(caller, request.method, auditSubject, "ok");
      return finish(rpcResult(request.id, result));
    } catch (error) {
      this.store.audit(caller, request.method, null, "error");
      const message = safeError(error);
      // The client only ever sees the JSON-RPC error's message; without a
      // matching daemon-log line, a genuine handler exception (as opposed to
      // a domain-level "no" answer) leaves no local trail to diagnose from.
      // Awaited (unlike this file's other informational appendDaemonLog
      // calls) so the log line is guaranteed to land before the error reply
      // does -- an operator reading the log right after seeing the error
      // must never race an unflushed write.
      await appendDaemonLog(`${request.method} failed: ${message}`, this.home);
      return finish(rpcError(request.id, -32000, message));
    }
  }

  private async poll(principal: string | undefined, forced: boolean): Promise<PollResult | { rate_limited: true }> {
    const key = principal ?? "all";
    const now = Date.now();
    const policy = await readPolicy(); // mtime/reload safe: no cached config survives a request or SIGHUP.
    const interval = (policy.principal_intervals[principal ?? ""] ?? policy.poll_interval_minutes) * 60_000;
    const blocked = this.backoff.get(key);
    // Keepalive's local source has no vendor request budget. It is deliberately
    // attempted during a remote backoff so a newly-warmed agy can recover status.
    const warmOnly = blocked !== undefined && blocked.until > now && this.keepalive?.running === true;
    if (blocked && blocked.until > now && !warmOnly) return { rate_limited: true };
    if (!forced && principal === undefined && !warmOnly) {
      try {
        const accounts = await this.currentAccounts();
        if (accounts.length && accounts.every((account) => (this.lastPoll.get(account.name) ?? 0) + (policy.principal_intervals[account.name] ?? policy.poll_interval_minutes) * 60_000 > now)) return { observations: [], failures: [] };
      } catch { /* A collection pass returns the useful configuration error. */ }
    }
    if (forced && (this.lastPoll.get(key) ?? 0) + interval > now && !warmOnly) return { rate_limited: true };
    if (!forced && (this.lastPoll.get(key) ?? 0) + interval > now && !warmOnly) return { observations: [], failures: [] };
    const accounts = await this.currentAccounts();
    const claudePrincipalIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude").map((account) => account.name);
    // A rebuilt probe binary marks every Claude principal before the poll
    // below ever runs, so the gate skips the probe call this cycle instead of
    // popping a fresh Keychain dialog with the new binary. Idempotent, so two
    // concurrent poll() calls racing here (before the inFlight check/set pair
    // right below, which must stay await-free to keep coalescing them into
    // one poller call) doing this twice is harmless.
    await syncClaudeGrantState(this.store, claudePrincipalIds);
    const current = this.inFlight.get(key);
    if (current) return current;
    const task = this.poller(principal, {
      daemonOwnsAntigravity: this.keepalive?.running === true,
      skipRemoteAntigravity: warmOnly,
      antigravityLoginState: this.keepalive?.loginState ?? "unknown",
      claudeGrant: claudeGrantGate(this.store),
    }).then((result) => {
      this.lastPoll.set(key, Date.now());
      for (const id of new Set(result.observations.map((item) => item.principal_id))) this.lastPoll.set(id, Date.now());
      this.store.insertAll(result.observations);
      this.store.leases();
      // Human-facing delivery of the events the inserts above just detected.
      // Deliberately not awaited: a slow or failing notification channel must
      // never delay a poll, and the ledger inside carries its own retries.
      void deliverNotifications(this.store, { home: this.home })
        .catch((error: unknown) => appendDaemonLog(`notify pass failed: ${safeError(error)}`, this.home));
      for (const [principalId, read] of Object.entries(result.antigravityLocal ?? {})) {
        this.antigravityLocal.set(principalId, read);
        void appendDaemonLog(`antigravity local ${principalId}: ${read.outcome} (${read.payload_kind})`, this.home);
      }
      // Keepalive is secondary: only start the warm agy once a real poll
      // cycle (this.schedulingStarted, set at the end of start() -- never
      // true for a daemon a test drives directly through poll()/handleLine()
      // without ever starting it) shows the remote quota endpoint fell short
      // of real buckets for an Antigravity principal. A no-op once agy is
      // already running.
      if (this.schedulingStarted && !this.keepalive?.running) {
        const antigravityAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "antigravity");
        const remoteFellShort = antigravityAccounts.some((account) => {
          const remoteRows = result.observations.filter((item) => item.principal_id === account.name && item.source === "remote:antigravity");
          return remoteRows.length === 0 || remoteRows.some((item) => item.freshness !== "fresh");
        });
        if (antigravityAccounts.length && remoteFellShort) void this.maybeStartKeepalive(accounts, policy);
      }
      // A gate-blocked skip renders the exact same failed observation reason
      // as a real denial on purpose (see PollResult.claudeProbeOutcomes), so
      // the audit outcome comes from the collector's own record of what it
      // did, never from inspecting the observations after the fact.
      for (const [principalId, outcome] of Object.entries(result.claudeProbeOutcomes ?? {})) this.store.audit("daemon", "claude_probe", principalId, outcome);
      // Every scheduled vendor poll is audited, not only Claude's (which
      // already gets its own claude_probe row above): a non-Claude principal
      // that failed to fetch must leave the same evidence trail.
      for (const principalId of new Set(result.observations.map((item) => item.principal_id))) {
        if (result.claudeProbeOutcomes && principalId in result.claudeProbeOutcomes) continue;
        const failed = result.failures.some((failure) => failure.startsWith(`${principalId} source failed`));
        this.store.audit("daemon", "poll", principalId, failed ? "failed" : "ok");
      }
      // A Claude Keychain denial/timeout no longer gets a timed backoff: the
      // grant gate (set above, and by the collector on this very denial)
      // already stops the next poll from retrying until the operator runs
      // `headroom keychain grant`, which is a stronger and more honest signal
      // than a fixed hour.
      const protectedFailure = result.failures.some((failure) => PROTECTED_STATUS_PATTERN.test(failure));
      if (protectedFailure) {
        const previous = this.backoff.get(key)?.failures ?? 0;
        this.backoff.set(key, { failures: previous + 1, until: Date.now() + Math.min(3_600_000, 60_000 * 2 ** previous) });
      } else if (!warmOnly) this.backoff.delete(key);
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async schedulePrincipals(): Promise<void> {
    if (this.stopping) return;
    for (const timer of this.schedulers.values()) clearTimeout(timer);
    this.schedulers.clear();
    try { for (const account of await this.currentAccounts()) this.schedulePrincipal(account.name); }
    catch { this.schedulePrincipal("all"); }
  }

  private async schedulePrincipal(principal: string): Promise<void> {
    const policy = await readPolicy();
    const minutes = policy.principal_intervals[principal] ?? policy.poll_interval_minutes;
    const delay = Math.max(1_000, minutes * 60_000 * (0.8 + Math.random() * 0.4));
    const timer = setTimeout(async () => {
      try { await this.poll(principal === "all" ? undefined : principal, false); }
      finally { this.schedulers.delete(principal); void this.schedulePrincipal(principal); }
    }, delay);
    timer.unref(); this.schedulers.set(principal, timer);
  }

  private installReloadHandlers(): void {
    process.on("SIGHUP", () => { this.lastPoll.clear(); this.backoff.clear(); this.accountsMtime = undefined; void this.schedulePrincipals(); });
  }

  /** Reloads principal scheduling when accounts.toml changes without a restart. */
  private async currentAccounts(): Promise<Account[]> {
    let mtime: number;
    try { mtime = (await stat(accountsPath())).mtimeMs; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.accounts = []; this.accountsMtime = undefined; return this.accounts; } throw error; }
    if (this.accountsMtime === mtime) return this.accounts;
    const accounts = await readAccounts();
    const prior = new Set(this.accounts.map((account) => account.name));
    const next = new Set(accounts.map((account) => account.name));
    this.accounts = accounts;
    this.accountsMtime = mtime;
    for (const name of prior) if (!next.has(name)) {
      const timer = this.schedulers.get(name);
      if (timer) clearTimeout(timer);
      this.schedulers.delete(name);
      this.lastPoll.delete(name);
      this.backoff.delete(name);
    }
    if (this.schedulingStarted) for (const account of accounts) if (!prior.has(account.name)) void this.schedulePrincipal(account.name);
    return this.accounts;
  }
}

async function socketExists(path: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  try { return (await lstat(path)).isSocket(); }
  catch { return false; }
}

/**
 * Probe health separately from a potentially slow request. A live daemon may
 * need to poll before answering `status`; that must not look like no daemon.
 */
export async function daemonRequest(path: string, method: string, params: Json = {}, healthTimeoutMs = 2_000): Promise<
  | { status: "available"; result: unknown }
  | { status: "absent" }
  | { status: "unresponsive" }
> {
  // Mutual auth (win32 only) is verified entirely inside rpc() itself now: a
  // reply -- health included -- whose transcript proof does not check out
  // comes back as `undefined`, indistinguishable here from no daemon
  // answering at all. There is nothing left for daemonRequest to double-check.
  const health = await rpc(path, "health", {}, healthTimeoutMs);
  if (health === undefined) return (await socketExists(path)) ? { status: "unresponsive" } : { status: "absent" };
  const result = await rpc(path, method, params, 30_000);
  return result === undefined ? { status: "unresponsive" } : { status: "available", result };
}

export async function rpc(path: string, method: string, params: Json = {}, timeoutMs = 2_000): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.setEncoding("utf8"); socket.setTimeout(timeoutMs);
    let buffer = "";
    let totalBytes = 0;
    let nonce: string | undefined; // the server's per-connection nonce
    let sentLine: string | undefined; // the exact request-line bytes this connection sent
    let replyLine: string | undefined; // the exact reply-line bytes received, pending its proof line
    let replyValue: Json | undefined;
    const isWin32 = process.platform === "win32";
    // Generated once per connection and, on the wire, sent with the single
    // request this connection ever makes (see the loop below): it is the
    // other half of pipeServerProof, so a captured reply from a different
    // connection -- a different server_nonce, a different client_nonce --
    // never verifies here, even for a replayed `health` answer.
    const clientNonce = isWin32 ? randomBytes(16).toString("hex") : undefined;
    let token: string | undefined;
    let finished = false;
    // An absolute deadline independent of the inactivity timer above: that
    // timer resets on every byte received, so a connection that keeps
    // trickling data -- never enough to go idle, never a complete answer --
    // would otherwise never time out at all. This fires regardless of
    // activity.
    const absoluteDeadline = setTimeout(() => done(undefined), RPC_ABSOLUTE_DEADLINE_MS);
    absoluteDeadline.unref?.();
    const done = (value: unknown | undefined) => {
      if (finished) return;
      finished = true;
      clearTimeout(absoluteDeadline);
      socket.destroy();
      resolve(value);
    };
    const send = (): void => {
      void (async () => {
        // The session token is read locally from the 0600 token file and used
        // only to compute HMAC proofs; the token itself is never written to
        // the socket.
        if (isWin32) token = await sessionToken();
        const proof = isWin32 && nonce && token && method !== "health" ? pipeAuthProof(token, nonce) : undefined;
        sentLine = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(proof ? { _proof: proof } : {}), ...(clientNonce ? { _client_nonce: clientNonce } : {}), _caller: { pid: process.pid, process: process.argv[1] ?? "headroom" } } });
        socket.write(`${sentLine}\n`);
      })().catch(() => done(undefined));
    };
    // On Windows the server always sends a nonce notification first; wait for
    // it before sending anything. Elsewhere there is nothing to wait for.
    socket.once("connect", () => { if (!isWin32) send(); });
    socket.on("data", (part: string) => {
      totalBytes += Buffer.byteLength(part, "utf8");
      // Bounded response: without this, a pipe impostor holding an
      // unauthenticated connection open could stream data forever and make
      // this process allocate without bound -- the inactivity timer above
      // never fires because it keeps resetting on every byte received.
      if (totalBytes > MAX_RPC_RESPONSE_BYTES) { done(undefined); return; }
      buffer += part;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (isWin32 && nonce === undefined) {
          try {
            const parsed = JSON.parse(line) as Json;
            const parsedParams = parsed.params && typeof parsed.params === "object" ? parsed.params as Json : undefined;
            const candidateNonce = typeof parsedParams?.nonce === "string" ? parsedParams.nonce : undefined;
            // Exactly 32 lowercase hex characters, matching what a genuine
            // daemon always generates (randomBytes(16).toString("hex")): a
            // missing, malformed, or oversized value here is never a nonce
            // worth computing a proof against.
            if (parsed.method !== "nonce" || !candidateNonce || !/^[0-9a-f]{32}$/.test(candidateNonce)) { done(undefined); return; }
            nonce = candidateNonce; send(); continue;
          } catch { done(undefined); return; }
        }
        if (isWin32 && replyLine === undefined) {
          // Stored verbatim, never re-serialized: the hash this client
          // verifies below must be exactly what the server hashed on its
          // side, which is the whole point of the proof traveling on its own
          // line instead of being folded back into the reply object.
          replyLine = line;
          try { replyValue = JSON.parse(line) as Json; } catch { done(undefined); return; }
          continue;
        }
        if (isWin32) {
          // This line is the transcript-proof frame that follows the reply.
          try {
            const proofFrame = JSON.parse(line) as Json;
            const proofParams = proofFrame.params && typeof proofFrame.params === "object" ? proofFrame.params as Json : undefined;
            const proof = typeof proofParams?.proof === "string" ? proofParams.proof : "";
            const requestHash = sentLine ? sha256Hex(sentLine) : "";
            const replyHash = sha256Hex(replyLine!);
            // The server's half of mutual auth: now bound to this exact
            // request and reply, not only the nonce pair, so a relay that
            // forwarded a genuine handshake but substituted the request it
            // sent the real daemon, or the reply it hands back here, changes
            // one of these hashes and never verifies -- treated exactly like
            // no answer at all, whatever it claims.
            const expected = token && nonce && clientNonce ? pipeServerProof(token, nonce, clientNonce, requestHash, replyHash) : undefined;
            if (!expected || !safeTimingEqual(proof, expected)) { done(undefined); return; }
          } catch { done(undefined); return; }
          done(replyValue!.error ? replyValue : replyValue!.result);
          return;
        }
        // POSIX: no nonce, no proof -- resolve on the first line, unchanged.
        try {
          const reply = JSON.parse(line) as Json;
          done(reply.error ? reply : reply.result);
        } catch { done(undefined); }
        return;
      }
    });
    socket.once("error", () => done(undefined)); socket.once("timeout", () => done(undefined));
  });
}
