import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { readPolicy, readRouting } from "./config.js";
import { claudeGrantGate, syncClaudeGrantState } from "./adapters/claude.js";
import { pollAccounts, PROTECTED_STATUS_PATTERN, type AntigravityLocalRead, type PollOptions, type PollResult } from "./collector.js";
import { AgyKeepaliveSupervisor, resolveAgyBinary } from "./antigravity-keepalive.js";
import { appendDaemonLog } from "./logs.js";
import { executablePath, headroomHome } from "./paths.js";
import { canRouteWithLeases, unknownMeterPrincipals } from "./policy.js";
import { withResetsIn } from "./resets.js";
import { withPaceInfo } from "./pace.js";
import { fillFor, gateFor, planFor, rateLines } from "./orchestrator-reads.js";
import type { GateNeed } from "./pacing.js";
import { accountsPath, readAccounts } from "./registry.js";
import { isLocalAccount, type Account, type Observation, type ProviderAccount } from "./types.js";
import { safeHeadroomDirectory, HeadroomStore } from "./store.js";
import { safeError, stripAmbientProxyEnvironment } from "./security.js";

type Json = Record<string, unknown>;
export type Poller = (principal?: string, options?: PollOptions) => Promise<PollResult>;

/** A local, single-user daemon still bounds what any one connection can hold
 * in memory and how many can be open at once, rather than trusting every
 * caller on the machine to behave. */
const MAX_CONNECTION_BUFFER_BYTES = 64 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 64;

export function socketPath(home = headroomHome(), platform = process.platform, username = userInfo().username): string {
  return platform === "win32" ? `\\\\.\\pipe\\headroom-${username}` : join(home, "headroom.sock");
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
function healthSignature(token: string): string { return createHmac("sha256", token).update("headroom-health-v1").digest("hex"); }

/** HMAC of a per-connection server nonce, keyed by the session token. The
 * client proves it holds the token by sending this proof; the raw token
 * itself never has to cross the pipe, so another local user who squats the
 * predictable pipe name before the real daemon starts (and so gets a live
 * connection from an unsuspecting client) learns nothing usable -- an HMAC
 * output does not reveal its key. */
function pipeAuthProof(token: string, nonce: string): string { return createHmac("sha256", token).update(`headroom-pipe-auth-v1:${nonce}`).digest("hex"); }

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

  private constructor(private readonly store: HeadroomStore, private readonly path: string, private readonly poller: Poller, private readonly home: string, keepalive?: AgyKeepaliveSupervisor) { this.keepalive = keepalive; }

  static async create(options: { home?: string; path?: string; poller?: Poller; keepalive?: AgyKeepaliveSupervisor } = {}): Promise<HeadroomDaemon> {
    const home = await safeHeadroomDirectory(options.home);
    return new HeadroomDaemon(await HeadroomStore.open(home), options.path ?? socketPath(home), options.poller ?? pollAccounts, home, options.keepalive);
  }

  async start(): Promise<void> {
    // Before any fetch can happen: an operator's shell proxy must never
    // silently carry a credentialed vendor request unless policy.toml opts in.
    const startupPolicy = await readPolicy();
    stripAmbientProxyEnvironment(startupPolicy.proxy);
    if (process.platform === "win32") this.sessionToken = await sessionToken(this.path.includes("\\pipe\\") ? headroomHome() : this.path, true);
    await this.prepareSocket();
    this.server = createServer((socket) => this.handleSocket(socket));
    // A restrictive umask means the OS never briefly creates the socket file
    // group- or world-connectable between listen() and the chmod below.
    if (process.platform !== "win32") process.umask(0o077);
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.path, resolve));
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    this.installReloadHandlers();
    const policy = await readPolicy();
    const accounts = await this.currentAccounts();
    const antigravity = accounts.find((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "antigravity");
    if (policy.antigravity_keepalive && process.platform !== "win32" && antigravity) {
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
    await this.schedulePrincipals();
    this.schedulingStarted = true;
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
    const closeOnce = () => { if (closed) return; closed = true; this.connectionCount -= 1; };
    socket.once("close", closeOnce);
    socket.setEncoding("utf8");
    let buffer = "";
    // Windows only: a fresh random nonce per connection, sent before anything
    // else. The client proves it holds the session token by HMAC-ing this
    // nonce (see pipeAuthProof); the token itself is read from the local
    // 0600 token file, never placed on the wire.
    const nonce = process.platform === "win32" ? randomBytes(16).toString("hex") : undefined;
    if (nonce) socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "nonce", params: { nonce } })}\n`);
    socket.on("data", (part: string) => {
      buffer += part;
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONNECTION_BUFFER_BYTES) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        void this.handleLine(line, nonce).then((reply) => socket.write(`${JSON.stringify(reply)}\n`));
      }
    });
  }

  private async handleLine(line: string, nonce?: string): Promise<Json> {
    let request: Json;
    try { request = JSON.parse(line) as Json; } catch { return rpcError(null, -32700, "Parse error"); }
    // A malformed envelope (null, a bare string/number, an array, or an
    // object missing method) must produce a JSON-RPC error, never throw:
    // `request.jsonrpc` on a non-object `request` (e.g. the JSON literal
    // `null`) would otherwise throw here, escaping as an unhandled rejection
    // since handleSocket's `.then()` below has no `.catch()`.
    if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      const id = request && typeof request === "object" && !Array.isArray(request) ? (request as Json).id : null;
      return rpcError(id, -32600, "Invalid Request");
    }
    const params = request.params && typeof request.params === "object" ? request.params as Json : {};
    const caller = callerFrom(params);
    // A rejected request is still audited before it returns: a caller
    // learning nothing about capacity does not mean the daemon saw nothing.
    const reject = (code: number, message: string, subject: string | null = null): Json => {
      this.store.audit(caller, request.method as string, subject, "rejected");
      return rpcError(request.id, code, message);
    };
    if (process.platform === "win32" && request.method !== "health") {
      const received = typeof params._proof === "string" ? params._proof : "";
      const expected = nonce && this.sessionToken ? pipeAuthProof(this.sessionToken, nonce) : "";
      if (!expected || !safeTimingEqual(received, expected)) return reject(-32001, "Unauthorized pipe client");
    }
    try {
      let result: unknown;
      switch (request.method) {
        case "status": {
          await this.poll(undefined, false);
          const now = new Date();
          const observations = this.store.latestPerWindow().filter((item) => this.accounts.some((account) => account.name === item.principal_id));
          result = withResetsIn(withPaceInfo(observations, this.store.burnRateFor(observations, now), now));
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
          result = rateLines(this.store, meter, minutes); break;
        }
        case "plan": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          if (!meter) return reject(-32602, "meter is required");
          const policy = await readPolicy();
          const reserve = typeof params.reserve_percent === "number" ? params.reserve_percent : policy.freeze_reserve_pct;
          result = planFor(this.store, meter, reserve); break;
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
          result = gateFor(this.store, needs, meter, reserve, params.plan === true, new Date(), { owner, planSharePercent: planShare, actionClass, pacing: policy.pacing }); break;
        }
        case "fill": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          if (!meter) return reject(-32602, "meter is required");
          const laneCost = typeof params.lane_cost_percent === "number" ? params.lane_cost_percent : undefined;
          const policy = await readPolicy();
          const weeklyReserve = typeof params.weekly_reserve_percent === "number" ? params.weekly_reserve_percent : policy.freeze_reserve_pct;
          const owner = typeof params.owner === "string" ? params.owner : undefined;
          const planShare = typeof params.plan_share_percent === "number" ? params.plan_share_percent : undefined;
          result = await fillFor(this.store, meter, laneCost, weeklyReserve, new Date(), { owner, planSharePercent: planShare, pacing: policy.pacing }); break;
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
          ...(this.sessionToken ? { signature: healthSignature(this.sessionToken) } : {}),
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
      return rpcResult(request.id, result);
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
      return rpcError(request.id, -32000, message);
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
      for (const [principalId, read] of Object.entries(result.antigravityLocal ?? {})) {
        this.antigravityLocal.set(principalId, read);
        void appendDaemonLog(`antigravity local ${principalId}: ${read.outcome} (${read.payload_kind})`, this.home);
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
  const health = await rpc(path, "health", {}, healthTimeoutMs);
  if (health === undefined) return (await socketExists(path)) ? { status: "unresponsive" } : { status: "absent" };
  if (process.platform === "win32") {
    const token = await sessionToken();
    const signature = health && typeof health === "object" ? (health as Json).signature : undefined;
    if (!token || typeof signature !== "string" || signature !== healthSignature(token)) return { status: "unresponsive" };
  }
  const result = await rpc(path, method, params, 30_000);
  return result === undefined ? { status: "unresponsive" } : { status: "available", result };
}

export async function rpc(path: string, method: string, params: Json = {}, timeoutMs = 2_000): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.setEncoding("utf8"); socket.setTimeout(timeoutMs);
    let buffer = "";
    let nonce: string | undefined;
    const isWin32 = process.platform === "win32";
    const done = (value: unknown | undefined) => { socket.destroy(); resolve(value); };
    const send = (): void => {
      void (async () => {
        // The session token is read locally from the 0600 token file and used
        // only to compute an HMAC proof of the server's per-connection nonce;
        // the token itself is never written to the socket.
        const proof = isWin32 && nonce && method !== "health" ? pipeAuthProof((await sessionToken()) ?? "", nonce) : undefined;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(proof ? { _proof: proof } : {}), _caller: { pid: process.pid, process: process.argv[1] ?? "headroom" } } })}\n`);
      })().catch(() => done(undefined));
    };
    // On Windows the server always sends a nonce notification first; wait for
    // it before sending anything. Elsewhere there is nothing to wait for.
    socket.once("connect", () => { if (!isWin32) send(); });
    socket.on("data", (part: string) => {
      buffer += part;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (isWin32 && nonce === undefined) {
          try {
            const parsed = JSON.parse(line) as Json;
            const parsedParams = parsed.params && typeof parsed.params === "object" ? parsed.params as Json : undefined;
            if (parsed.method === "nonce" && parsedParams && typeof parsedParams.nonce === "string") { nonce = parsedParams.nonce; send(); continue; }
          } catch { done(undefined); return; }
        }
        try { const reply = JSON.parse(line) as Json; done(reply.error ? reply : reply.result); }
        catch { done(undefined); }
        return;
      }
    });
    socket.once("error", () => done(undefined)); socket.once("timeout", () => done(undefined));
  });
}
