import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { readPolicy, readRouting } from "./config.js";
import { pollAccounts, type PollResult } from "./collector.js";
import { headroomHome } from "./paths.js";
import { canRouteWithLeases } from "./policy.js";
import { accountsPath, readAccounts } from "./registry.js";
import { isLocalAccount, type Account, type Observation } from "./types.js";
import { safeHeadroomDirectory, HeadroomStore } from "./store.js";

type Json = Record<string, unknown>;
export type Poller = (principal?: string) => Promise<PollResult>;

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

function rpcResult(id: unknown, result: unknown): Json { return { jsonrpc: "2.0", id: id ?? null, result }; }
function rpcError(id: unknown, code: number, message: string): Json { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
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

  private constructor(private readonly store: HeadroomStore, private readonly path: string, private readonly poller: Poller) {}

  static async create(options: { home?: string; path?: string; poller?: Poller } = {}): Promise<HeadroomDaemon> {
    const home = await safeHeadroomDirectory(options.home);
    return new HeadroomDaemon(await HeadroomStore.open(home), options.path ?? socketPath(home), options.poller ?? pollAccounts);
  }

  async start(): Promise<void> {
    if (process.platform === "win32") this.sessionToken = await sessionToken(this.path.includes("\\pipe\\") ? headroomHome() : this.path, true);
    await this.prepareSocket();
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.path, resolve));
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    this.installReloadHandlers();
    await this.schedulePrincipals();
    this.schedulingStarted = true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.schedulers.values()) clearTimeout(timer);
    this.schedulers.clear();
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
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (part: string) => {
      buffer += part;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        void this.handleLine(line).then((reply) => socket.write(`${JSON.stringify(reply)}\n`));
      }
    });
  }

  private async handleLine(line: string): Promise<Json> {
    let request: Json;
    try { request = JSON.parse(line) as Json; } catch { return rpcError(null, -32700, "Parse error"); }
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(request.id, -32600, "Invalid Request");
    const params = request.params && typeof request.params === "object" ? request.params as Json : {};
    if (process.platform === "win32" && request.method !== "health") {
      const received = typeof params._session_token === "string" ? params._session_token : "";
      const expected = this.sessionToken ?? "";
      if (!expected || received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return rpcError(request.id, -32001, "Unauthorized pipe client");
    }
    const caller = callerFrom(params);
    try {
      let result: unknown;
      switch (request.method) {
        case "status":
          await this.poll(undefined, false);
          result = this.store.latestPerWindow().filter((item) => this.accounts.some((account) => account.name === item.principal_id));
          break;
        case "history": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 86_400_000).toISOString();
          if (!meter) return rpcError(request.id, -32602, "meter is required");
          result = this.store.history(meter, since); break;
        }
        case "events": {
          const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 86_400_000).toISOString();
          result = this.store.events(since); break;
        }
        case "can": {
          const action = typeof params.action_class === "string" ? params.action_class : "";
          if (typeof params.owner !== "string" || !params.owner.trim()) return rpcError(request.id, -32602, "owner is required");
          const routing = await readRouting();
          const meters = routing.consumes[action];
          if (!meters) return rpcError(request.id, -32602, `Unknown action class: ${action || "(missing)"}`);
          await this.poll(undefined, false);
          const policy = await readPolicy();
          const localMeters = (await this.currentAccounts()).filter(isLocalAccount).map((account) => `${account.name}:capacity`);
          const allMeters = [...new Set([...meters, ...localMeters])];
          result = canRouteWithLeases(meters, localMeters, new Map(allMeters.map((meter) => [meter, this.store.latestPerWindow(meter)])), routing.local_preference, policy, params.allow_unknown === true, this.store.leases(undefined, true), params.owner);
          break;
        }
        case "lease_start": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          const meter = typeof params.meter_id === "string" ? params.meter_id : "";
          const expected = typeof params.expected_percent === "number" ? params.expected_percent : null;
          const ttl = typeof params.ttl_ms === "number" ? params.ttl_ms : 30 * 60_000;
          result = this.store.startLease(owner, meter, expected, ttl, typeof params.note === "string" ? params.note : null); break;
        }
        case "lease_end": {
          if (typeof params.id !== "string") return rpcError(request.id, -32602, "lease id is required");
          if (typeof params.owner !== "string" || !params.owner.trim()) return rpcError(request.id, -32602, "owner is required");
          result = this.store.endLease(params.id, params.owner, params.force === true);
          if (params.force === true && (result as { owner: string }).owner !== params.owner) this.store.audit(caller, "lease_force_end", `${params.owner}->${(result as { owner: string }).owner}`, "ok");
          break;
        }
        case "leases": result = this.store.leases(); break;
        case "refresh": {
          const principal = typeof params.principal === "string" ? params.principal : undefined;
          result = await this.poll(principal, true); break;
        }
        case "reset_seen": {
          const candidates = Array.isArray(params.windows) ? params.windows : [];
          const windows: Array<Pick<Observation, "meter_id" | "window" | "resets_at">> = candidates.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const candidate = item as { meter_id?: unknown; minutes?: unknown; resets_at?: unknown };
            if (typeof candidate.meter_id !== "string" || (typeof candidate.minutes !== "number" && candidate.minutes !== null)) return [];
            return [{ meter_id: candidate.meter_id, window: candidate.minutes === null ? null : { kind: "rolling", minutes: candidate.minutes, enforcement: "hard" }, resets_at: typeof candidate.resets_at === "string" ? candidate.resets_at : null }];
          });
          result = Object.fromEntries(this.store.resetSeenFor(windows)); break;
        }
        case "health": result = { socket: this.path, in_flight: this.inFlight.size, backoff: [...this.backoff.entries()].map(([principal, item]) => ({ principal, until: new Date(item.until).toISOString(), failures: item.failures })), ...(this.sessionToken ? { signature: healthSignature(this.sessionToken) } : {}) }; break;
        default: return rpcError(request.id, -32601, "Method not found");
      }
      this.store.audit(caller, request.method, typeof params.principal === "string" ? params.principal : typeof params.meter === "string" ? params.meter : null, "ok");
      return rpcResult(request.id, result);
    } catch (error) {
      this.store.audit(caller, request.method, null, "error");
      return rpcError(request.id, -32000, error instanceof Error ? error.message : "Daemon error");
    }
  }

  private async poll(principal: string | undefined, forced: boolean): Promise<PollResult | { rate_limited: true }> {
    const key = principal ?? "all";
    const now = Date.now();
    const policy = await readPolicy(); // mtime/reload safe: no cached config survives a request or SIGHUP.
    const interval = (policy.principal_intervals[principal ?? ""] ?? policy.poll_interval_minutes) * 60_000;
    const blocked = this.backoff.get(key);
    if (blocked && blocked.until > now) return { rate_limited: true };
    if (!forced && principal === undefined) {
      try {
        const accounts = await this.currentAccounts();
        if (accounts.length && accounts.every((account) => (this.lastPoll.get(account.name) ?? 0) + (policy.principal_intervals[account.name] ?? policy.poll_interval_minutes) * 60_000 > now)) return { observations: [], failures: [] };
      } catch { /* A collection pass returns the useful configuration error. */ }
    }
    if (forced && (this.lastPoll.get(key) ?? 0) + interval > now) return { rate_limited: true };
    if (!forced && (this.lastPoll.get(key) ?? 0) + interval > now) return { observations: [], failures: [] };
    const current = this.inFlight.get(key);
    if (current) return current;
    const task = this.poller(principal).then((result) => {
      this.lastPoll.set(key, Date.now());
      for (const id of new Set(result.observations.map((item) => item.principal_id))) this.lastPoll.set(id, Date.now());
      this.store.insertAll(result.observations);
      this.store.leases();
      for (const principalId of new Set(result.observations.map((item) => item.principal_id))) {
        if (result.observations.some((item) => item.principal_id === principalId && item.source === "native:claude")) this.store.audit("daemon", "claude_probe", principalId, "called");
      }
      const keychainDenied = result.observations.some((item) => item.freshness === "failed" && item.reason === "Keychain access denied; run: headroom keychain grant");
      const protectedFailure = result.failures.some((failure) => /\b(401|403|429)\b/.test(failure));
      if (keychainDenied) {
        this.backoff.set(key, { failures: 1, until: Date.now() + 3_600_000 });
      } else if (protectedFailure) {
        const previous = this.backoff.get(key)?.failures ?? 0;
        this.backoff.set(key, { failures: previous + 1, until: Date.now() + Math.min(3_600_000, 60_000 * 2 ** previous) });
      } else this.backoff.delete(key);
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
    const done = (value: unknown | undefined) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => {
      void (async () => {
        const token = process.platform === "win32" ? await sessionToken() : undefined;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(token ? { _session_token: token } : {}), _caller: { pid: process.pid, process: process.argv[1] ?? "headroom" } } })}\n`);
      })().catch(() => done(undefined));
    });
    socket.on("data", (part: string) => { buffer += part; const newline = buffer.indexOf("\n"); if (newline >= 0) { try { const reply = JSON.parse(buffer.slice(0, newline)) as Json; done(reply.error ? reply : reply.result); } catch { done(undefined); } } });
    socket.once("error", () => done(undefined)); socket.once("timeout", () => done(undefined));
  });
}
