import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { readConsumes, readPolicy } from "./config.js";
import { pollAccounts, type PollResult } from "./collector.js";
import { tallyHome } from "./paths.js";
import { canConsume } from "./policy.js";
import { readAccounts } from "./registry.js";
import { safeTallyDirectory, TallyStore } from "./store.js";

type Json = Record<string, unknown>;
export type Poller = (principal?: string) => Promise<PollResult>;

export function socketPath(home = tallyHome()): string { return join(home, "tally.sock"); }

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

export class TallyDaemon {
  private server: Server | undefined;
  private readonly inFlight = new Map<string, Promise<PollResult>>();
  private readonly lastPoll = new Map<string, number>();
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  private readonly schedulers = new Map<string, NodeJS.Timeout>();
  private stopping = false;

  private constructor(private readonly store: TallyStore, private readonly path: string, private readonly poller: Poller) {}

  static async create(options: { home?: string; path?: string; poller?: Poller } = {}): Promise<TallyDaemon> {
    const home = await safeTallyDirectory(options.home);
    return new TallyDaemon(await TallyStore.open(home), options.path ?? socketPath(home), options.poller ?? pollAccounts);
  }

  async start(): Promise<void> {
    await this.prepareSocket();
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.path, resolve));
    await chmod(this.path, 0o600);
    this.installReloadHandlers();
    await this.schedulePrincipals();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.schedulers.values()) clearTimeout(timer);
    this.schedulers.clear();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
    this.store.close();
    try { await unlink(this.path); } catch { /* already gone */ }
  }

  private async prepareSocket(): Promise<void> {
    try {
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("Refusing unsafe tally socket");
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing tally socket owned by another user");
      if ((stat.mode & 0o077) !== 0) throw new Error("Refusing tally socket with group or world permissions");
      const daemon = await daemonRequest(this.path, "health");
      if (daemon.status === "available") throw new Error("Tally daemon is already running");
      if (daemon.status === "unresponsive") throw new Error("Tally daemon socket is present but health did not respond within 2s");
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
    const caller = callerFrom(params);
    try {
      let result: unknown;
      switch (request.method) {
        case "status":
          await this.poll(undefined, false);
          result = this.store.latestAll();
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
          const meters = (await readConsumes())[action];
          if (!meters) return rpcError(request.id, -32602, `Unknown action class: ${action || "(missing)"}`);
          const policy = await readPolicy();
          result = canConsume(meters, new Map(meters.map((meter) => [meter, this.store.latest(meter)])), policy, params.allow_unknown === true);
          break;
        }
        case "refresh": {
          const principal = typeof params.principal === "string" ? params.principal : undefined;
          result = await this.poll(principal, true); break;
        }
        case "health": result = { socket: this.path, in_flight: this.inFlight.size, backoff: [...this.backoff.entries()].map(([principal, item]) => ({ principal, until: new Date(item.until).toISOString(), failures: item.failures })) }; break;
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
        const accounts = await readAccounts();
        if (accounts.length && accounts.every((account) => (this.lastPoll.get(account.name) ?? 0) + (policy.principal_intervals[account.name] ?? policy.poll_interval_minutes) * 60_000 > now)) return { observations: [], failures: [] };
      } catch { /* a later collection pass returns the useful configuration error */ }
    }
    if (forced && (this.lastPoll.get(key) ?? 0) + interval > now) return { rate_limited: true };
    if (!forced && (this.lastPoll.get(key) ?? 0) + interval > now) return { observations: [], failures: [] };
    const current = this.inFlight.get(key);
    if (current) return current;
    const task = this.poller(principal).then((result) => {
      this.lastPoll.set(key, Date.now());
      for (const id of new Set(result.observations.map((item) => item.principal_id))) this.lastPoll.set(id, Date.now());
      this.store.insertAll(result.observations);
      const protectedFailure = result.failures.some((failure) => /\b(401|403|429)\b/.test(failure));
      if (protectedFailure) {
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
    try { for (const account of await readAccounts()) this.schedulePrincipal(account.name); }
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
    process.on("SIGHUP", () => { this.lastPoll.clear(); this.backoff.clear(); void this.schedulePrincipals(); });
  }
}

async function socketExists(path: string): Promise<boolean> {
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
  const result = await rpc(path, method, params, 30_000);
  return result === undefined ? { status: "unresponsive" } : { status: "available", result };
}

export async function rpc(path: string, method: string, params: Json = {}, timeoutMs = 2_000): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.setEncoding("utf8"); socket.setTimeout(timeoutMs);
    let buffer = "";
    const done = (value: unknown | undefined) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _caller: { pid: process.pid, process: process.argv[1] ?? "tally" } } })}\n`));
    socket.on("data", (part: string) => { buffer += part; const newline = buffer.indexOf("\n"); if (newline >= 0) { try { const reply = JSON.parse(buffer.slice(0, newline)) as Json; done(reply.error ? reply : reply.result); } catch { done(undefined); } } });
    socket.once("error", () => done(undefined)); socket.once("timeout", () => done(undefined));
  });
}
