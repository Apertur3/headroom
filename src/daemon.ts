import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { readPolicy, readRouting } from "./config.js";
import { readDashboardStore } from "./dashboard-data.js";
import { claudeGrantGate, syncClaudeProbeState } from "./adapters/claude.js";
import { pollAccounts, withBackoffReasons, PROTECTED_STATUS_PATTERN, type AntigravityLocalRead, type PollOptions, type PollResult } from "./collector.js";
import { AgyKeepaliveSupervisor, resolveAgyBinary, sweepPreviousKeepalive } from "./antigravity-keepalive.js";
import { externalAntigravityServerPids } from "./antigravity-discovery.js";
import { recordedLaunchPids, runAgyWatchdog } from "./agy-watchdog.js";
import { allowEngineStarts, liveEngineGroupPids, refuseEngineStarts, setEngineSignalCleanup, terminateEngineGroups } from "./engine/group-run.js";
import { appendDaemonLog } from "./logs.js";
import { isProcessGroupAlive } from "./process-tree.js";
import { canonicalizeHomeForPipe, executablePath, headroomHome, joinForPlatform } from "./paths.js";
import { canRouteWithLeases, unknownMeterPrincipals, type CanDecision, type Policy } from "./policy.js";
import { parseCreditExpiry, withCreditsLapsed } from "./credits.js";
import { withPaceInfo, withStatusInfo } from "./pace.js";
import { buildAgentLine, writeAgentLine } from "./agent-line.js";
import { admitCanCost, fillFor, gateFor, planFor, rateLines, type GateOutcome, type RateLine } from "./orchestrator-reads.js";
import { windowNeedMinutes, type GateNeed } from "./pacing.js";
import { deliverNotifications, readNotifyConfig } from "./notify.js";
import { checkModelAvailability } from "./model-catalog.js";
import { fireDueTimers, DELIVERY_TIMEOUT_MS } from "./heartbeat.js";
import { accountsPath, readAccounts } from "./registry.js";
import { disabledPrincipalForMeter, disabledPrincipalReason, isAccountEnabled, isLocalAccount, type Account, type Observation, type ProviderAccount } from "./types.js";
import { safeHeadroomDirectory, HeadroomStore } from "./store.js";
import { safeError, stripAmbientProxyEnvironment } from "./security.js";
import { headroomVersion } from "./version.js";

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
/** Bounds for the daemon-owned maintenance timer (scheduleMaintenance): never
 * sleeps past a minute even with nothing registered yet, and never re-arms
 * faster than once a second even when a deadline just passed, so a stuck
 * clock or a deadline computed slightly in the past cannot turn this into a
 * hot loop. */
const MAINTENANCE_MAX_DELAY_MS = 60_000;
const MAINTENANCE_MIN_DELAY_MS = 1_000;
/** How soon a principal whose poll schedule could not be computed (a
 * malformed accounts.toml or policy.toml) tries again. */
const SCHEDULE_RETRY_DELAY_MS = 60_000;
/** How long stop() waits for an in-flight maintenance/notifier pass to
 * finish before closing the store regardless -- generous relative to a
 * local inbox write (normally well under a second) while still bounding
 * shutdown against a genuinely stuck filesystem call. */
const STOP_DRAIN_TIMEOUT_MS = 5_000;
/** How long scheduleMaintenance() waits for an in-flight timer-firing pass
 * (timerFiringInFlight) before reading the next deadline and re-arming
 * anyway. fireDueTimers already bounds each individual delivery
 * (heartbeat.ts's DELIVERY_TIMEOUT_MS); this is the outer cap on the whole
 * pass, several due timers included, so the scheduler itself -- the one
 * thing still running heartbeat checks and firing other timers when no
 * account is enabled at all -- can never be stalled indefinitely by
 * awaiting it. */
const MAINTENANCE_TIMER_WAIT_TIMEOUT_MS = 30_000;

function sha256Hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** Awaits every promise in `pending`, capped at `timeoutMs` -- used
 * wherever this daemon would otherwise wait on work it does not fully
 * control the duration of (an in-flight timer delivery, a notifier pass):
 * never blocks longer than the cap, whether or not every promise has
 * settled by then. Every caller's own promises are already wrapped with
 * their own `.catch()` at the point they are created, so this never itself
 * throws. */
async function boundedWait(pending: Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (!pending.length) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => { if (settled) return; settled = true; resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    void Promise.allSettled(pending).then(() => { clearTimeout(timer); finish(); });
  });
}

/** Current Windows pipe name -> the legacy name for the same user and home,
 * filled in by socketPath(). A process derives a pipe name for only a handful
 * of homes, so this never grows past a few entries. */
const legacyPipeNames = new Map<string, string>();

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
  //
  // The name is a digest only: the OS username goes into the hash, never into
  // the name itself, because pipe names show up in handle and process
  // listings and in logs (#137). The username stays part of the input so two
  // Windows users who point HEADROOM_HOME at the same directory still get two
  // pipes (named pipes share one machine-wide namespace).
  if (platform === "win32") {
    const canonicalHome = canonicalizeHomeForPipe(home, platform);
    const digest = sha256Hex(`headroom-pipe-v2\u0000${username.toLowerCase()}\u0000${canonicalHome}`).slice(0, 16);
    const path = `\\\\.\\pipe\\headroom-${digest}`;
    legacyPipeNames.set(path, legacyWindowsPipeName(home, username));
    return path;
  }
  return joinForPlatform(platform, home, "headroom.sock");
}

/** The pipe name versions up to 0.2.6 listened on, which embedded the
 * username. Only ever dialed as a fallback (see legacyPipeFallback); the
 * daemon itself never listens on it. */
export function legacyWindowsPipeName(home: string, username = userInfo().username): string {
  return `\\\\.\\pipe\\headroom-${username}-${sha256Hex(canonicalizeHomeForPipe(home, "win32")).slice(0, 8)}`;
}

/** The legacy pipe a client should try when nothing listens on `path`, so a
 * daemon an older version started (before an upgrade restarted it) is still
 * found. Windows only; undefined for any path socketPath() did not derive.
 * Drop this once releases that listen on the legacy name are out of use. */
export function legacyPipeFallback(path: string, platform = process.platform): string | undefined {
  return platform === "win32" ? legacyPipeNames.get(path) : undefined;
}

/** Why a Unix socket path cannot be bound, or undefined when it can. sun_path
 * includes a terminating NUL: 104 bytes on macOS, 108 on Linux. A Windows
 * named pipe has no such limit. Clients use this to treat an overlong path as
 * "no daemon" (and fall back to a direct read, as before); only the daemon
 * itself and `headroom doctor` turn it into an error. */
export function socketPathProblem(path: string, platform = process.platform): string | undefined {
  if (platform === "win32") return undefined;
  const limit = platform === "darwin" ? 103 : 107;
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= limit) return undefined;
  return `Headroom socket path "${path}" is ${bytes} bytes; the limit is ${limit} bytes on ${platform}. Set HEADROOM_HOME to a shorter directory.`;
}

/** socketPath() for the daemon's own listen: throws the explanation instead of
 * letting listen() fail with a bare EINVAL. */
export function checkedSocketPath(home = headroomHome(), platform = process.platform, username = userInfo().username): string {
  const path = socketPath(home, platform, username);
  const problem = socketPathProblem(path, platform);
  if (problem) throw new Error(problem);
  return path;
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
  private accountsMtime: string | undefined;
  private schedulingStarted = false;
  private stopping = false;
  private sessionToken: string | undefined;
  private keepalive: AgyKeepaliveSupervisor | undefined;
  /** Pids sweepStaleKeepalive() found alive but could not prove were a
   * previous run's (see sweepPreviousKeepalive's `unverified`). Re-checked
   * (ps-free, by process-group signal) before every keepalive launch attempt
   * so a possibly-live orphan is never doubled up on; cleared once none of
   * them are alive any more. */
  private keepaliveUnverifiedPids: number[] = [];
  /** Reflects only the MOST RECENT sweepStaleKeepalive() call: true right
   * after one completes without throwing, reset false the instant one
   * throws. maybeStartKeepalive() re-sweeps immediately before every single
   * launch attempt (not just once per daemon process -- see its own
   * comment) and must never launch a fresh keepalive on the strength of an
   * empty keepaliveUnverifiedPids that only looks empty because THAT sweep
   * never actually ran to completion -- that reads identically to "nothing
   * to worry about" while actually meaning "we never checked". */
  private keepaliveSwept = false;
  /** Set whenever a keepalive is stopped OUTSIDE of the daemon's own stop()
   * (currently: currentAccounts() dropping it once no enabled Antigravity
   * account is left) without waiting for that stop() to finish. Firing
   * `stop()` and moving on -- the previous behavior -- let a quick
   * disable-then-re-enable start a brand new AgyKeepaliveSupervisor on the
   * SAME home/state-file paths while the old one's stop() was still reading
   * or writing them: the old stop() could then kill the NEW agy or delete
   * its state. maybeStartKeepalive() awaits this before ever constructing a
   * new supervisor, so the two can never be in flight at once. */
  private keepaliveStopPending: Promise<void> | undefined;
  /** Serializes a complete keepalive reconciliation. Without this, two poll
   * completions can both sweep: the slower one may find and kill the state a
   * faster one has just launched. Waiters re-evaluate after this settles. */
  private keepaliveReconcilePending: Promise<void> | undefined;
  /** True while the last discovery found an Antigravity server Headroom did
   * not start (the IDE's language server, the user's own agy). It stops our
   * keepalive from starting, and it is exactly as good a source for the
   * local probe, so poll() still lets the collector read it. */
  private externalServerNoted = false;
  /** Single-flight guard for the agy age watchdog pass. */
  private agyWatchdogRunning = false;
  private readonly antigravityLocal = new Map<string, AntigravityLocalRead>();
  private connectionCount = 0;
  /** Guards against a second timer-firing pass starting while a slow one
   * (an inbox write that outlasts the 15s poll throttle below) is still
   * running: see poll()'s own throttled block. `store.claimTimer`'s
   * per-timer atomicity already makes two genuinely overlapping passes safe
   * on their own, but this avoids the wasted duplicate `dueTimers()` scan
   * and log noise a second pass would otherwise produce. */
  private timerFiringInFlight: Promise<number> | undefined;
  /** The single live handle for scheduleMaintenance()'s self-re-arming
   * timer; cleared in stop() so a pending tick never fires (or reschedules)
   * after shutdown. */
  private maintenanceTimer: NodeJS.Timeout | undefined;
  /** Every whole maintenance pass, including time spent awaiting configuration
   * before it starts a timer or notifier child promise. stop() must drain
   * these too: otherwise a pass can resume from that configuration read only
   * after the store has closed. */
  private readonly maintenancePassesInFlight = new Set<Promise<unknown>>();
  /** A request accepted before stop() flips `stopping` may still be awaiting
   * configuration or a poll. Keep its complete handler promise so shutdown
   * does not close SQLite while that handler can later resume. */
  private readonly rpcHandlersInFlight = new Set<Promise<unknown>>();
  /** Every currently-running background notifier pass (runMaintenancePass's
   * own, and poll()'s vendor-triggered one), tracked so stop() can drain
   * them before closing the store out from under a write still in flight --
   * see stop()'s own comment for why this matters together with
   * timerFiringInFlight. */
  private readonly notifyInFlight = new Set<Promise<unknown>>();
  /** `HeadroomStore` has no public open-state probe. Keep the daemon-owned
   * state here, and expose only guarded proxies to asynchronous work so every
   * store method call (including one made by a helper after its own await)
   * checks shutdown state before reaching SQLite. */
  private storeOpen = true;
  private readonly guardedStore: HeadroomStore;
  /** Timer delivery and notification promises were already part of shutdown's
   * drain contract before this change. They may finish their durable store
   * update while the listener is in `stopping`; this proxy still refuses every
   * method once close begins, but does not cancel work stop() is awaiting. */
  private readonly drainingStore: HeadroomStore;
  /** The package version this process started as, read once in start(). An in-place `npm i -g`
   * replaces package.json under a running daemon; reading it lazily at the first health request
   * would report the new version and hide that this process still runs the old code. */
  private startedVersion: string | undefined;
  /** Set by the first authorized `shutdown` request; later ones answer "already requested". */
  private shutdownWasRequested = false;
  private resolveShutdownRequest: () => void = () => undefined;
  /** Resolves once an authorized `shutdown` request arrives. The process entry point (`headroom
   * daemon`) awaits it alongside SIGINT/SIGTERM and then runs the same graceful stop(): on Windows a
   * process cannot be sent a signal it can handle, so this request is the only clean way for another
   * Headroom command (uninstall, install-service after an upgrade) to stop the daemon. The daemon
   * never stops itself from inside the request handler, so the reply is always written first. */
  readonly shutdownRequested: Promise<void> = new Promise<void>((resolve) => { this.resolveShutdownRequest = resolve; });

  private constructor(private readonly rawStore: HeadroomStore, private readonly path: string, private readonly poller: Poller, private readonly home: string, keepalive: AgyKeepaliveSupervisor | undefined, private readonly connectionLimits: ConnectionLimits, private readonly deliveryTimeoutMs: number = DELIVERY_TIMEOUT_MS) {
    this.keepalive = keepalive;
    const guarded = (assertUsable: () => void): HeadroomStore => new Proxy(rawStore, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? (...args: unknown[]) => {
          assertUsable();
          return value.apply(target, args);
        } : value;
      },
    });
    this.guardedStore = guarded(() => this.assertStoreUsable());
    this.drainingStore = guarded(() => this.assertStoreOpen());
  }

  private canUseStore(): boolean { return !this.stopping && this.storeOpen; }

  private assertStoreOpen(): void {
    if (!this.storeOpen) throw new Error("Headroom store is closed");
  }

  private assertStoreUsable(): void {
    if (!this.canUseStore()) throw new Error("Headroom daemon is stopping");
  }

  private get store(): HeadroomStore {
    this.assertStoreUsable();
    return this.guardedStore;
  }

  private get storeWhileDraining(): HeadroomStore {
    this.assertStoreOpen();
    return this.drainingStore;
  }

  static async create(options: { home?: string; path?: string; poller?: Poller; keepalive?: AgyKeepaliveSupervisor; connectionLimits?: Partial<ConnectionLimits>; deliveryTimeoutMs?: number } = {}): Promise<HeadroomDaemon> {
    const home = await safeHeadroomDirectory(options.home);
    const path = options.path ?? socketPath(home);
    const problem = socketPathProblem(path);
    if (problem) throw new Error(problem);
    return new HeadroomDaemon(await HeadroomStore.open(home), path,options.poller ?? pollAccounts, home, options.keepalive, { ...DEFAULT_CONNECTION_LIMITS, ...options.connectionLimits }, options.deliveryTimeoutMs);
  }

  async start(): Promise<void> {
    // The daemon handles its own signals (a graceful stop() that sweeps the
    // engine groups), so group-run must not install its CLI-read handlers
    // here; and engine starts are open until stop() closes them.
    setEngineSignalCleanup(false);
    allowEngineStarts();
    this.startedVersion = await headroomVersion();
    // Before any fetch can happen: an operator's shell proxy must never
    // silently carry a credentialed vendor request unless policy.toml opts in.
    const startupPolicy = await readPolicy();
    stripAmbientProxyEnvironment(startupPolicy.proxy);
    // Establish notification history before any socket-triggered or scheduled
    // poll can insert new events. No token lookup or transport runs at startup.
    if ((await readNotifyConfig(this.home))?.channels.length) this.store.initializeNotificationEvents();
    // The session token always lives under the daemon's own resolved home
    // (this.home), never derived from this.path: this.path is a named pipe
    // in production (nothing to write a token file relative to) and, in
    // tests, sometimes a bare filename standing in for one -- neither is a
    // directory the token file could sensibly live under.
    if (process.platform === "win32") this.sessionToken = await sessionToken(this.home, true);
    await this.prepareSocket();
    // A restrictive umask means the OS never briefly creates the socket file
    // group- or world-connectable between listen() and the chmod below.
    if (process.platform !== "win32") process.umask(0o077);
    await this.bindWithRaceGuard();
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    this.installReloadHandlers();
    // Reap any agy left behind by a previous daemon (crash, forced kill, or
    // a service restart mid-update) before deciding whether to launch a
    // fresh one. Kept as its own tiny call -- see
    // antigravity-keepalive.ts's sweepPreviousKeepalive() for the actual
    // logic -- deliberately not folded into the socket setup above or the
    // keepalive-start below, so it never has to move when either of those
    // does.
    await this.sweepStaleKeepalive();
    // Warm the local source before the first scheduled poll. It supplies
    // consumer quota without the retired Gemini CLI OAuth path.
    try { await this.maybeStartKeepalive(await readAccounts(), startupPolicy); }
    catch (error) { void appendDaemonLog(`antigravity startup: ${safeError(error)}`, this.home); }
    await this.schedulePrincipals();
    this.schedulingStarted = true;
    // Unconditional, before the maintenance scheduler's first pass: a fresh
    // process starting up is proof that any outstanding delivery claim
    // (store.ts's timers.claimed_at) belongs to a now-dead prior instance --
    // this daemon refuses to start while another instance already holds its
    // socket (prepareSocket, above), so nothing else can still be
    // mid-delivery against this store right now. See
    // store.ts's claimTimer/reclaimStaleTimerClaims doc comments for the
    // full crash-recovery story this closes the loop on.
    const reclaimed = this.store.reclaimStaleTimerClaims();
    if (reclaimed > 0) void appendDaemonLog(`reclaimed ${reclaimed} timer delivery claim(s) left by a prior daemon process`, this.home);
    // Independent of account polling above -- see scheduleMaintenance's own
    // doc comment for why heartbeat lapse checks and timer firing cannot
    // wait on it. Not awaited: startup must not block on delivering
    // whatever timers or lapses are already due.
    void this.scheduleMaintenance().catch((error: unknown) => appendDaemonLog(`maintenance scheduler failed: ${safeError(error)}`, this.home));
  }

  /** A sweep that throws leaves keepaliveUnverifiedPids exactly as it was
   * (never emptied by a run that did not actually finish), and
   * keepaliveSwept false, so maybeStartKeepalive() below treats a rejected
   * sweep the same as one that found something unverified: refuse to launch
   * this cycle, not "nothing to worry about". */
  private async sweepStaleKeepalive(): Promise<void> {
    try {
      const result = await sweepPreviousKeepalive(this.home, {
        log: (message) => { void appendDaemonLog(message, this.home); },
        // An injected/already-running supervisor owns its UUID directory;
        // startup reconciliation must never inspect that live launch.
        skipLaunchId: this.keepalive?.launchId,
      });
      this.keepaliveUnverifiedPids = result.unverified;
      this.keepaliveSwept = true;
    }
    catch (error) { this.keepaliveSwept = false; void appendDaemonLog(`antigravity keepalive sweep: ${safeError(error)}`, this.home); }
  }

  /** Start the owned agy PTY once an Antigravity poll needs it. `accounts`/
   * `policy` are the caller's own pre-await snapshot; kept only for
   * signature/call-site compatibility, and deliberately NOT used for the
   * actual launch decision, which always re-reads fresh right before it --
   * see that re-read's own comment for why trusting these parameters here
   * would be wrong. */
  // Never lets its own promise reject: currentAccounts()/readPolicy() below
  // (called both here and inside the try block further down) can throw on
  // a malformed accounts.toml/policy.toml, and this method is called
  // fire-and-forget (no rejection handler) from the poll path -- an
  // unguarded throw there becomes an unhandled promise rejection, which can
  // terminate the whole daemon process over nothing worse than a bad edit
  // to a config file. Every caller, awaited or detached, gets the same
  // guarantee: a failed reload just defers this attempt and logs, exactly
  // like the narrower catch around executablePath()/start() already did.
  private async maybeStartKeepalive(accounts: Account[], policy: Policy): Promise<void> {
    const pending = this.keepaliveReconcilePending;
    if (pending) {
      await pending;
      return this.maybeStartKeepalive(accounts, policy);
    }
    const reconcile = this.attemptStartKeepalive(accounts, policy)
      .catch((error) => { void appendDaemonLog(`antigravity keepalive: reload failed, deferring this attempt: ${safeError(error)}`, this.home); });
    this.keepaliveReconcilePending = reconcile;
    try { await reconcile; }
    finally {
      if (this.keepaliveReconcilePending === reconcile) this.keepaliveReconcilePending = undefined;
    }
  }

  /** An Antigravity IDE language server or agy that Headroom did not start is
   * already reachable. Headroom's own trees (the keepalive, recorded launch
   * pids, live engine groups) never count. */
  private async externalAntigravityServerPresent(): Promise<boolean> {
    const owned = [this.keepalive?.pid, ...liveEngineGroupPids(), ...await recordedLaunchPids(this.home)]
      .filter((pid): pid is number => typeof pid === "number");
    const found = await externalAntigravityServerPids({ ownedRoots: owned });
    if (found.length && !this.externalServerNoted) void appendDaemonLog("antigravity keepalive: an Antigravity server is already reachable; not running our own agy", this.home);
    if (!found.length && this.externalServerNoted) void appendDaemonLog("antigravity keepalive: the external Antigravity server is gone; keepalive may start again", this.home);
    this.externalServerNoted = found.length > 0;
    return found.length > 0;
  }

  /** A local Antigravity server the native probe may read: the daemon's own
   * keepalive, or an external one (IDE, the user's agy) that discovery found
   * and that is the only reason our keepalive is not running. Discovery runs
   * only while policy wants a keepalive, so the external half is gated on the
   * same policy switch: with it off, nothing is probed, as before. */
  private localAntigravityServerAvailable(policy: Policy): boolean {
    return this.keepalive?.running === true || (this.externalServerNoted && policy.antigravity_keepalive && process.platform !== "win32");
  }

  /** The agy age watchdog, run once per poll pass and never overlapping itself.
   * Tracked in notifyInFlight so stop() drains it. */
  private runAgyWatchdogPass(policy: Policy): void {
    if (this.stopping || this.agyWatchdogRunning || process.platform === "win32") return;
    this.agyWatchdogRunning = true;
    const maxAgeMs = (policy.agy_max_age_minutes ?? 10) * 60_000;
    this.trackNotify(runAgyWatchdog({ home: this.home, maxAgeMs, exemptLaunchId: this.keepalive?.launchId })
      .then(() => undefined)
      .catch((error: unknown) => appendDaemonLog(`agy watchdog failed: ${safeError(error)}`, this.home))
      .finally(() => { this.agyWatchdogRunning = false; }));
  }

  private async attemptStartKeepalive(accounts: Account[], policy: Policy): Promise<void> {
    // An existing supervisor must be re-checked to ensure policy and the
    // accounts it serves still justify it. A non-running supervisor with a
    // pending restart (this.restart set, or mid-reap) must not
    // survive `antigravity_keepalive = false` either by silently falling
    // through to the freshPolicy return further down, which only ever
    // declines to launch a NEW one and never stops an EXISTING one. Both
    // route through the exact same serialized stop path (stopKeepaliveUnless
    // / keepaliveStopPending) an accounts.toml-driven disable already uses,
    // checked here -- before any launch logic gets a chance to run.
    if (this.keepalive) {
      const gateAccounts = await this.currentAccounts();
      const gatePolicy = await readPolicy();
      const stillJustified = gatePolicy.antigravity_keepalive
        && gateAccounts.some((account) => isAccountEnabled(account) && !isLocalAccount(account) && account.vendor === "antigravity");
      this.stopKeepaliveUnless(stillJustified, "policy or account disable");
      if (!stillJustified) return;
      // An IDE or agy server showed up since we started: stop ours at this
      // check rather than run two.
      if (await this.externalAntigravityServerPresent()) { this.stopKeepaliveUnless(false, "external Antigravity server reachable"); return; }
      // A supervisor that still owns a lifecycle (a live child, an orphan
      // reap, a scheduled restart) manages it itself; its pid-file discovery
      // may still be pending, so a daemon sweep must not clear that evidence
      // underneath it. An idle supervisor owns nothing and falls through to
      // the normal sweep-and-launch path below.
      if ((this.keepalive as { managingLifecycle?: boolean }).managingLifecycle) return;
    }
    // Never construct a new supervisor while an old one's stop() might still
    // be reading or writing the same shared home/state-file paths -- see
    // keepaliveStopPending's own doc comment.
    if (this.keepaliveStopPending) await this.keepaliveStopPending;
    if (this.stopping) return; // the daemon began shutting down while this call was waiting
    // Re-swept on EVERY attempt, not just once per daemon process: evidence
    // can appear after an earlier successful sweep -- most notably a
    // just-disabled keepalive's own stop() leaving its state behind because
    // it could not confirm agy was actually gone (see
    // AgyKeepaliveSupervisor.stop's own doc comment) -- and a live daemon can
    // disable/re-enable Antigravity any number of times without ever
    // restarting, so "swept once, earlier" is not "still safe to trust now".
    await this.sweepStaleKeepalive();
    if (this.stopping) return;
    if (!this.keepaliveSwept) {
      void appendDaemonLog("antigravity keepalive: deferring a new launch -- the sweep before this attempt did not complete cleanly", this.home);
      return;
    }
    if (this.keepaliveUnverifiedPids.length) {
      // "until the next check": re-probe (ps-free) rather than trusting a
      // sweep result that may be stale by now -- once every unverified pid
      // has actually exited on its own, a fresh keepalive is free to start.
      this.keepaliveUnverifiedPids = this.keepaliveUnverifiedPids.filter(isProcessGroupAlive);
      if (this.keepaliveUnverifiedPids.length) {
        void appendDaemonLog(`antigravity keepalive: deferring a new launch while pid(s) ${this.keepaliveUnverifiedPids.join(", ")} from a previous run remain unverified and alive`, this.home);
        return;
      }
    }
    // The caller's own `accounts`/`policy` were snapshotted before every
    // `await` this function has made so far (keepaliveStopPending, the
    // sweep, and -- moments from now -- executablePath below): a reload
    // that disables Antigravity partway through can land in that window,
    // and a poll that captured its snapshot before the reload must not have
    // its own (correct) decision overridden by THIS call finishing on
    // stale, already-captured data. Re-read fresh, immediately before the
    // actual decision, rather than trusting the parameters for it.
    const freshAccounts = await this.currentAccounts();
    const freshPolicy = await readPolicy();
    if (this.stopping) return;
    if (!freshPolicy.antigravity_keepalive || process.platform === "win32") return;
    // Centralized here (rather than trusting every caller to pre-filter) so
    // a disabled Antigravity account never launches its keepalive, whether
    // this is called from startup with the raw registry read or from a
    // scheduled poll with an already-enabled-only list.
    const antigravity = freshAccounts.find((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "antigravity" && isAccountEnabled(account));
    if (!antigravity) return;
    // agy_path is a value from accounts.toml; verify ownership, mode, and
    // that it isn't a symlink before ever spawning it, the same bar every
    // other executable Headroom runs must clear.
    try {
      const binary = await executablePath(resolveAgyBinary(antigravity.agy_path));
      if (this.stopping) return; // right before start(): never launch after shutdown began
      // executablePath() above is itself an await -- a disable that lands
      // in ITS window is exactly as real a race as the ones the fresh
      // read above this try block already guards against, and checking
      // only `this.stopping` here missed it: nothing re-confirmed the
      // account/policy were still enabled after that specific await, so a
      // disable during the (potentially slow, filesystem-bound) lstat/stat
      // work inside executablePath could still fall through to a launch.
      // Re-read one last time, as the very last step before ever
      // constructing or starting the supervisor.
      const finalAccounts = await this.currentAccounts();
      const finalPolicy = await readPolicy();
      if (this.stopping) return;
      // process.platform === "win32" was already ruled out by the fresh
      // check above this try block, and the platform cannot change mid-run.
      if (!finalPolicy.antigravity_keepalive) return;
      const finalAntigravity = finalAccounts.find((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "antigravity" && isAccountEnabled(account));
      if (!finalAntigravity) return;
      // The executable was validated for the earlier selected account. A
      // reload can replace that account or its agy_path while executablePath()
      // awaits filesystem work; do not start the stale binary merely because
      // some enabled Antigravity account still exists.
      if (finalAntigravity.name !== antigravity.name || finalAntigravity.agy_path !== antigravity.agy_path) return;
      // Only start our own agy when nobody else's server can answer the probe.
      if (await this.externalAntigravityServerPresent()) return;
      if (this.stopping) return;
      this.keepalive ??= new AgyKeepaliveSupervisor({ binary, home: this.home });
      this.keepalive.start();
    } catch (error) {
      void appendDaemonLog(`antigravity keepalive not started: ${safeError(error)}`, this.home);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Before anything below can await: no engine read may start from here on,
    // including one queued behind a read the sweep further down will kill.
    refuseEngineStarts();
    for (const timer of this.schedulers.values()) clearTimeout(timer);
    this.schedulers.clear();
    // A disable cycle (currentAccounts()) may have a keepalive stop still in
    // flight, tracked but deliberately not awaited there (see
    // keepaliveStopPending's own doc comment) -- shutdown must wait for it
    // too. Skipping this let a concurrent maybeStartKeepalive() (also
    // awaiting the same promise, e.g. from a disable/re-enable poll racing
    // this SIGTERM) resume and construct a brand new keepalive AFTER the
    // server and store below were already closed, with nothing left running
    // to supervise or stop it again.
    if (this.keepaliveStopPending) await this.keepaliveStopPending;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    await this.keepalive?.stop();
    // Any engine read still running must not outlive the daemon: TERM, then
    // KILL, the whole group, re-swept (bounded) until none is tracked. Starts
    // were refused above, so nothing new can appear behind the sweep.
    // (process 'exit' reaps them synchronously too.)
    await terminateEngineGroups();
    // Keep the listener bound while this drains. A new daemon treats binding
    // that listener as proof it may reclaim delivery claims, so closing it
    // first would let a replacement resend while this process still writes.
    // handleLine serves health as { state: "stopping" } and rejects every
    // other method during this interval, so it cannot start new store work.
    // Requests and maintenance passes accepted just before that state change
    // are tracked below and either finish while the store is open or observe
    // the stopping guard when one of their awaits resumes.
    await this.drainBackgroundWork();
    this.storeOpen = false;
    this.rawStore.close();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.server === server) this.server = undefined;
    }
    if (process.platform !== "win32") try { await unlink(this.path); } catch { /* already gone */ }
  }

  /** Awaits every current maintenance child, complete maintenance pass, and
   * accepted RPC handler, capped at STOP_DRAIN_TIMEOUT_MS. The sets are
   * populated before any of their asynchronous work can yield; after
   * `stopping` is set no new non-health request or maintenance tick can add
   * store work. Both background children are already caught at creation, and
   * boundedWait uses allSettled for the rest, so this only ever waits. */
  private async drainBackgroundWork(): Promise<void> {
    const pending: Promise<unknown>[] = [
      ...this.maintenancePassesInFlight,
      ...this.rpcHandlersInFlight,
      ...this.notifyInFlight,
    ];
    if (this.timerFiringInFlight) pending.push(this.timerFiringInFlight);
    if (!pending.length) return;
    await boundedWait(pending, STOP_DRAIN_TIMEOUT_MS);
  }

  /** Build a capacity decision from the current SQLite snapshot. The caller
   * may invoke this inside HeadroomStore.admitAndStartLeases, where its lease
   * reads and the following reservation are protected by one write lock. */
  private canDecision(meters: string[], accounts: Account[], localPreference: "fallback" | "prefer" | "never", policy: Policy, allowUnknown: boolean, owner: string, now: Date, includeOwnerReservations = false): CanDecision {
    const blocked = meters.map((meter) => this.store.dispatchBlockForMeter(meter, now) ?? this.store.dispatchBlockForPrincipal(meter.split(":")[0])).find(Boolean);
    if (blocked) return { allowed: false, meter: meters[0], state: "FREEZE", reason: blocked, meters: [{ meter: meters[0], state: "FREEZE", reason: blocked }] };
    const localMeters = accounts.filter(isLocalAccount).filter(isAccountEnabled).map((account) => `${account.name}:capacity`);
    const allMeters = [...new Set([...meters, ...localMeters])];
    const rows = new Map(allMeters.map((meter) => [meter, this.store.latestPerWindow(meter)]));
    const burn = this.store.burnRateFor([...rows.values()].flat(), now);
    const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
    return canRouteWithLeases(meters, localMeters, enriched, localPreference, policy, allowUnknown, this.store.leases(undefined, true, now), owner, now, includeOwnerReservations);
  }

  private async prepareSocket(): Promise<void> {
    if (process.platform === "win32") {
      // Node creates the pipe with the current process token's current-user DACL.
      // Named pipes have no on-disk file: the pipe is created and destroyed
      // atomically with its owning process, so there is nothing here that can
      // go stale the way a POSIX socket file can survive a hard reboot -- the
      // health check below is the whole story on this platform.
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
      // A raw connect() probe first, ahead of (and independent of) the
      // health-check RPC below: a POSIX socket *file* outlives the process
      // that created it (a hard reboot or `kill -9` never gets to unlink it),
      // so its mere presence on disk says nothing about whether anyone is
      // listening. ECONNREFUSED/ENOENT here mean the kernel has no listener
      // for this path at all -- definitively stale, safe to unlink and bind
      // fresh. Only when *something* accepts the connection does startup
      // fall through to the slower health RPC, which tells a live-but-busy
      // daemon (never unlinked -- it just gets a clear error) from one that
      // is fully up and answers "already running".
      if (!(await hasListener(this.path))) { await unlink(this.path); return; }
      const daemon = await daemonRequest(this.path, "health");
      if (daemon.status === "available") throw new Error("Headroom daemon is already running");
      if (daemon.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
      await unlink(this.path); // daemonRequest's own probe found nothing there either
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Binds the socket, and on a bind race -- another process also decided the
   * old socket was stale, unlinked it, and won the path first -- re-probes
   * rather than looping forever. prepareSocket() decides fresh each time: if
   * the winner is a live daemon that has since finished starting up, this
   * throws the same "already running" error a slower loser would always have
   * reported; if the winner is itself just another daemon mid-startup that
   * has not bound yet, or has already crashed, one more unlink-and-bind
   * attempt goes through. Bounded so a socket that somehow keeps losing the
   * race can never spin the process forever. */
  private async bindWithRaceGuard(maxAttempts = 5): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.server = createServer((socket) => this.handleSocket(socket));
      try {
        await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.path, resolve));
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === maxAttempts) throw error;
        await this.prepareSocket();
      }
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
        }).catch(() => { socket.destroy(); }); // no reply can be built; the client sees a closed connection, never a dead daemon
      }
    });
  }

  /** A request's audit row is best-effort: when the store cannot write it (a
   * full or read-only disk), the request is still answered with its own
   * result or error, never turned into a different error or a dropped reply. */
  private auditQuietly(caller: string, method: string, subject: string | null, outcome: string): void {
    try { if (this.canUseStore()) this.store.audit(caller, method, subject, outcome); } catch { /* answer regardless */ }
  }

  /** Tracks the complete lifetime of a request, rather than only its socket
   * write or a child poll. This also covers direct test calls through
   * authedHandleLine(), which intentionally exercise the same private RPC
   * entry point as the transport. */
  private handleLine(line: string, nonce?: string): Promise<HandledLine> {
    const handler = this.handleLineInner(line, nonce);
    const tracked = handler.finally(() => { this.rpcHandlersInFlight.delete(tracked); });
    this.rpcHandlersInFlight.add(tracked);
    return tracked;
  }

  private async handleLineInner(line: string, nonce?: string): Promise<HandledLine> {
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
      this.auditQuietly(caller, request.method as string, subject, "rejected");
      return finish(rpcError(request.id, code, message));
    };
    if (process.platform === "win32" && request.method !== "health") {
      const received = typeof params._proof === "string" ? params._proof : "";
      const expected = nonce && this.sessionToken ? pipeAuthProof(this.sessionToken, nonce) : "";
      if (!expected || !safeTimingEqual(received, expected)) return reject(-32001, "Unauthorized pipe client");
      authenticatedThisCall = true;
    }
    if (request.method === "shutdown") {
      // Authorized exactly like every other mutating request: on Windows the transcript-proof check
      // just above has already rejected a client that does not hold the session token, and on POSIX
      // the 0600 socket decided who could connect at all. Idempotent: a repeat, or a request while a
      // signal-driven stop is already draining, only reports that the daemon is stopping.
      const already = this.shutdownWasRequested || this.stopping;
      this.shutdownWasRequested = true;
      this.auditQuietly(caller, "shutdown", null, already ? "repeat" : "ok");
      if (!already) void appendDaemonLog(`shutdown requested by ${caller}`, this.home);
      this.resolveShutdownRequest();
      return finish(rpcResult(request.id, { state: "stopping", already_requested: already }));
    }
    if (this.stopping && request.method !== "health") return finish(rpcError(request.id, -32000, "Headroom daemon is stopping"));
    try {
      let result: unknown;
      switch (request.method) {
        case "dashboard": {
          const policy = await readPolicy();
          const now = new Date();
          const rows = this.store.latestPerWindow().filter((item) => this.accounts.some((account) => account.name === item.principal_id && isAccountEnabled(account)));
          result = readDashboardStore(this.store, now, rows, policy); break;
        }
        case "status": {
          await this.poll(undefined, false);
          // The daemon's "status" RPC result stays the plain Observation[]
          // array it has always been -- the 1.x JSON contract forbids ever
          // turning it into an object -- so `disabled_principals` is derived
          // by the CLI/MCP layers from the registry instead of returned here.
          result = this.servedStatus(await readPolicy(), new Date());
          break;
        }
        case "plan_downgrades": {
          result = this.store.planDowngrades(this.accounts.map((account) => account.name));
          break;
        }
        case "history": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 86_400_000).toISOString();
          if (!meter) return reject(-32602, "meter is required");
          // Unlike can/gate/plan/fill/lease_start/rate, history cannot create
          // capacity for a disabled principal -- it only reads what was
          // already stored -- so it stays readable regardless of enabled.
          result = this.store.history(meter, since); break;
        }
        case "events": {
          const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 86_400_000).toISOString();
          result = this.store.events(since); break;
        }
        case "models": {
          const principal = typeof params.principal === "string" ? params.principal : undefined;
          result = this.store.knownModels(principal); break;
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
          const disabledMeter = meters.find((meter) => disabledPrincipalForMeter(accounts, meter) !== undefined);
          if (disabledMeter) {
            const reason = disabledPrincipalReason(disabledPrincipalForMeter(accounts, disabledMeter)!);
            result = { allowed: false, meter: disabledMeter, state: "UNKNOWN", reason, meters: meters.map((meter) => ({ meter, state: "UNKNOWN", reason })) } satisfies CanDecision;
            break;
          }
          await this.poll(undefined, false);
          const policy = await readPolicy();
          const now = new Date();
          result = this.canDecision(meters, accounts, routing.local_preference, policy, params.allow_unknown === true, params.owner, now);
          break;
        }
        case "can_lease": {
          const action = typeof params.action_class === "string" ? params.action_class : "";
          const owner = typeof params.owner === "string" ? params.owner.trim() : "";
          const expected = typeof params.expected_percent === "number" ? params.expected_percent : null;
          const ttl = typeof params.ttl_ms === "number" ? params.ttl_ms : 30 * 60_000;
          if (!owner) return reject(-32602, "owner is required");
          if (expected === null || !Number.isFinite(expected) || expected < 0 || expected > 100) return reject(-32602, "expected_percent must be 0 through 100");
          const routing = await readRouting();
          if (!routing.present) return reject(-32602, "No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
          const meters = routing.consumes[action];
          if (!meters) return reject(-32602, `Unknown action class: ${action || "(missing)"}`, action || null);
          const accounts = await this.currentAccounts();
          const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
          if (unknownMeters.length) return reject(-32602, `Routing action class ${action} names unknown meter(s): ${unknownMeters.join(", ")}`, action);
          const disabledMeter = meters.find((meter) => disabledPrincipalForMeter(accounts, meter) !== undefined);
          if (disabledMeter) {
            const reason = disabledPrincipalReason(disabledPrincipalForMeter(accounts, disabledMeter)!);
            result = { decision: { allowed: false, meter: disabledMeter, state: "UNKNOWN", reason, meters: meters.map((meter) => ({ meter, state: "UNKNOWN", reason })) }, leases: [] };
            break;
          }
          // Refreshes may happen before the transaction; the transaction is
          // deliberately only the local decision plus lease write, never a
          // credential-backed network request.
          await this.poll(undefined, false);
          const policy = await readPolicy();
          const now = new Date();
          const admitted = this.store.admitAndStartLeases(() => {
            const raw = this.canDecision(meters, accounts, routing.local_preference, policy, params.allow_unknown === true, owner, now, true);
            const localMeters = accounts.filter(isLocalAccount).filter(isAccountEnabled).map((account) => `${account.name}:capacity`);
            return admitCanCost(this.store, raw, localMeters.includes(raw.meter) ? [raw.meter] : meters, policy, expected, now);
          }, owner, (admittedDecision) => {
            const localMeters = accounts.filter(isLocalAccount).filter(isAccountEnabled).map((account) => `${account.name}:capacity`);
            return localMeters.includes(admittedDecision.meter) ? [admittedDecision.meter] : meters;
          }, expected, ttl, `can:${action}`, now, action);
          result = { decision: admitted.decision, leases: admitted.leases };
          break;
        }
        case "lease_start": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          const meter = typeof params.meter_id === "string" ? params.meter_id : "";
          const expected = typeof params.expected_percent === "number" ? params.expected_percent : null;
          const ttl = typeof params.ttl_ms === "number" ? params.ttl_ms : 30 * 60_000;
          const actionClass = typeof params.action_class === "string" && params.action_class.trim() ? params.action_class.trim() : null;
          const disabled = disabledPrincipalForMeter(await this.currentAccounts(), meter);
          if (disabled) return reject(-32000, disabledPrincipalReason(disabled), meter);
          result = this.store.startLease(owner, meter, expected, ttl, typeof params.note === "string" ? params.note : null, new Date(), actionClass); break;
        }
        case "lease_end": {
          if (typeof params.id !== "string") return reject(-32602, "lease id is required");
          if (typeof params.owner !== "string" || !params.owner.trim()) return reject(-32602, "owner is required");
          result = this.store.endLease(params.id, params.owner, params.force === true);
          if (params.force === true && (result as { owner: string }).owner !== params.owner) {
            const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim().slice(0, 200) : "(no reason given)";
            this.auditQuietly(caller, "lease_force_end", `${params.owner}->${(result as { owner: string }).owner}:${params.id} reason=${reason}`, "ok");
          }
          break;
        }
        case "leases": result = this.store.leases(undefined, true); break;
        case "heartbeat_beat": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          const intervalMs = typeof params.interval_ms === "number" ? params.interval_ms : Number.NaN;
          if (!owner.trim()) return reject(-32602, "owner is required");
          if (!Number.isFinite(intervalMs) || intervalMs <= 0) return reject(-32602, "interval_ms must be positive", owner);
          const resumeSentence = params.resume_sentence === null ? null : typeof params.resume_sentence === "string" ? params.resume_sentence : undefined;
          result = this.store.heartbeatBeat(owner, intervalMs, resumeSentence, new Date()); break;
        }
        case "heartbeat_stop": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          if (!owner.trim()) return reject(-32602, "owner is required");
          result = { stopped: this.store.heartbeatStop(owner) }; break;
        }
        case "heartbeats": result = this.store.heartbeats(); break;
        case "timer_set": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          const timerName = typeof params.name === "string" ? params.name : "";
          const at = typeof params.at === "string" ? params.at : "";
          const action = typeof params.action === "string" ? params.action : "";
          const ifMissed = params.if_missed === "drop" ? "drop" : "notify";
          if (!owner.trim() || !timerName.trim()) return reject(-32602, "owner and name are required");
          if (!action.trim()) return reject(-32602, "action is required", `${owner}:${timerName}`);
          if (!Number.isFinite(Date.parse(at))) return reject(-32602, "at must be a valid ISO instant", `${owner}:${timerName}`);
          result = this.store.setTimer(owner, timerName, at, action, ifMissed, new Date()); break;
        }
        case "timer_list": {
          const owner = typeof params.owner === "string" && params.owner.trim() ? params.owner.trim() : undefined;
          result = this.store.timers(owner); break;
        }
        case "timer_clear": {
          const owner = typeof params.owner === "string" ? params.owner : "";
          const timerName = typeof params.name === "string" ? params.name : "";
          if (!owner.trim() || !timerName.trim()) return reject(-32602, "owner and name are required");
          result = { cleared: this.store.clearTimer(owner, timerName) }; break;
        }
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
          const accounts = await this.currentAccounts();
          const disabled = meter ? disabledPrincipalForMeter(accounts, meter) : undefined;
          if (disabled) {
            // Same documented bare RateLine[] array `rate` always returns
            // (docs/json-contract.md) -- a synthetic UNKNOWN line, not a
            // JSON-RPC error -- so the daemon, CLI, and direct paths agree.
            result = [{ meter: meter!, window_minutes: null, used_percent: null, burn_percent_per_hour: null, empty_in_seconds: null, resets_at: null, reason: disabledPrincipalReason(disabled) }] satisfies RateLine[];
            break;
          }
          result = rateLines(this.store, meter, minutes, new Date(), owner, typeof params.need === "string" ? params.need : undefined, {
            enabledPrincipalIds: meter ? undefined : new Set(accounts.filter(isAccountEnabled).map((account) => account.name)),
          }); break;
        }
        case "spend": {
          const meter = typeof params.meter === "string" && params.meter.trim() ? params.meter.trim() : undefined;
          const owner = typeof params.owner === "string" && params.owner.trim() ? params.owner.trim() : undefined;
          const sinceValue = typeof params.since === "string" && params.since.trim() ? params.since.trim() : new Date(Date.now() - 86_400_000).toISOString();
          result = this.store.spendByOwner({ meter, owner, since: sinceValue }); break;
        }
        case "credits": {
          const enabledPrincipalIds = new Set((await this.currentAccounts()).filter(isAccountEnabled).map((account) => account.name));
          result = this.store.credits(new Date()).filter((item) => enabledPrincipalIds.has(item.meter.split(":", 1)[0])); break;
        }
        case "credits_set": {
          const principal = typeof params.principal === "string" ? params.principal.trim() : "";
          const available = params.available;
          if (!principal) return reject(-32602, "principal is required");
          if (!Number.isFinite(available) || typeof available !== "number" || available < 0 || !Number.isInteger(available)) return reject(-32602, "available must be a non-negative whole number", principal);
          if (typeof params.expires !== "string") return reject(-32602, "expires is required", principal);
          const account = (await this.currentAccounts()).find((item) => item.name === principal);
          if (!account) return reject(-32602, `unknown principal: ${principal}`, principal);
          if (!isAccountEnabled(account)) return reject(-32602, disabledPrincipalReason(account.name), principal);
          let expires: string;
          try { expires = parseCreditExpiry(params.expires); }
          catch (error) { return reject(-32602, error instanceof Error ? error.message : "invalid expiry", principal); }
          this.store.recordManualCredits(principal, available, expires);
          // Audited once, by the common `ok` audit after the switch (it
          // already reads params.principal for the subject) -- a case-local
          // audit here would double the row for this RPC only.
          result = this.store.credits().find((item) => item.meter === `${principal}:credits`)!;
          break;
        }
        case "credits_clear": {
          const principal = typeof params.principal === "string" ? params.principal.trim() : "";
          if (!principal) return reject(-32602, "principal is required");
          const account = (await this.currentAccounts()).find((item) => item.name === principal);
          if (!account) return reject(-32602, `unknown principal: ${principal}`, principal);
          if (!isAccountEnabled(account)) return reject(-32602, disabledPrincipalReason(account.name), principal);
          this.store.clearManualCredits(principal);
          // See credits_set above: the common `ok` audit below covers this too.
          result = this.store.credits().find((item) => item.meter === `${principal}:credits`)!;
          break;
        }
        case "plan": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          if (!meter) return reject(-32602, "meter is required");
          if (params.target_points !== undefined && (typeof params.target_points !== "number" || !Number.isFinite(params.target_points) || params.target_points < 0)) return reject(-32602, "target_points must be a non-negative number", meter);
          const disabled = disabledPrincipalForMeter(await this.currentAccounts(), meter);
          if (disabled) {
            // Same documented { meter, error, notices } failure shape `plan`
            // always returns (docs/json-contract.md), not a JSON-RPC error,
            // so the daemon, CLI, and direct paths agree.
            result = { meter, error: disabledPrincipalReason(disabled), notices: [] };
            break;
          }
          const policy = await readPolicy();
          const reserve = typeof params.reserve_percent === "number" ? params.reserve_percent : policy.freeze_reserve_pct;
          result = planFor(this.store, meter, reserve, new Date(), policy.staleness_minutes, policy.reserve, typeof params.need === "string" ? params.need : undefined, typeof params.target_points === "number" ? params.target_points : undefined, policy.reserve_meta, policy.policy_mtime); break;
        }
        case "gate": {
          const meter: string | string[] | undefined = typeof params.meter === "string" ? params.meter
            : Array.isArray(params.meter) ? params.meter.filter((item): item is string => typeof item === "string")
            : undefined;
          const rawNeeds = Array.isArray(params.needs) ? params.needs : [];
          const needs: GateNeed[] = rawNeeds.flatMap((item) => {
            const candidate = item as { window?: unknown; points?: unknown };
            return typeof candidate.window === "string" && windowNeedMinutes(candidate.window) !== undefined && typeof candidate.points === "number" ? [{ window: candidate.window, points: candidate.points }] : [];
          });
          if (!needs.length) return reject(-32602, "needs is required");
          if (params.allowance !== undefined && params.allowance !== "pro_rata" && params.allowance !== "fill") return reject(-32602, "allowance must be pro_rata or fill");
          if (params.cap_percent !== undefined && (typeof params.cap_percent !== "number" || !Number.isFinite(params.cap_percent) || params.cap_percent < 0 || params.cap_percent > 100)) return reject(-32602, "cap_percent must be 0 through 100");
          if (params.duration_minutes !== undefined && (typeof params.duration_minutes !== "number" || !Number.isFinite(params.duration_minutes) || params.duration_minutes <= 0)) return reject(-32602, "duration_minutes must be greater than 0");
          const targetMeters = meter === undefined ? [] : Array.isArray(meter) ? meter : [meter];
          const accounts = await this.currentAccounts();
          const disabled = targetMeters.map((item) => disabledPrincipalForMeter(accounts, item)).find((item): item is string => item !== undefined);
          if (disabled) {
            // Same documented refused GateOutcome shape `gate` always
            // returns (docs/json-contract.md: allowed, reason,
            // meters_checked, unknown, notices), not a JSON-RPC error, so
            // the daemon, CLI, and direct paths agree.
            result = { allowed: false, reason: disabledPrincipalReason(disabled), unknown: true, meters_checked: targetMeters, notices: [] } satisfies GateOutcome;
            break;
          }
          await this.poll(undefined, false);
          const policy = await readPolicy();
          const reserve = Math.max(policy.freeze_reserve_pct, typeof params.reserve_percent === "number" ? params.reserve_percent : policy.freeze_reserve_pct);
          const owner = typeof params.owner === "string" ? params.owner : undefined;
          const planShare = typeof params.plan_share_percent === "number" ? params.plan_share_percent : undefined;
          const actionClass = typeof params.action_class === "string" ? params.action_class : undefined;
          const routing = actionClass ? await readRouting() : undefined;
          result = gateFor(this.store, needs, meter, reserve, params.plan === true, new Date(), { owner, planSharePercent: planShare, actionClass, pacing: policy.pacing, allowance: typeof params.allowance === "string" ? params.allowance : policy.allowance, capPercent: typeof params.cap_percent === "number" ? params.cap_percent : undefined, durationMinutes: typeof params.duration_minutes === "number" ? params.duration_minutes : routing?.costs[actionClass ?? ""]?.duration_minutes, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve, reserveMeta: policy.reserve_meta, policyMtime: policy.policy_mtime, enabledPrincipalIds: new Set(accounts.filter(isAccountEnabled).map((account) => account.name)) }); break;
        }
        case "fill": {
          const meter = typeof params.meter === "string" ? params.meter : "";
          if (!meter) return reject(-32602, "meter is required");
          if (params.allowance !== undefined && params.allowance !== "pro_rata" && params.allowance !== "fill") return reject(-32602, "allowance must be pro_rata or fill");
          if (params.duration_minutes !== undefined && (typeof params.duration_minutes !== "number" || !Number.isFinite(params.duration_minutes) || params.duration_minutes <= 0)) return reject(-32602, "duration_minutes must be greater than 0");
          const disabled = disabledPrincipalForMeter(await this.currentAccounts(), meter);
          if (disabled) {
            // Same documented { meter, error, notices } failure shape `fill`
            // always returns (docs/json-contract.md), not a JSON-RPC error,
            // so the daemon, CLI, and direct paths agree.
            result = { meter, error: disabledPrincipalReason(disabled), notices: [] };
            break;
          }
          const laneCost = typeof params.lane_cost_percent === "number" ? params.lane_cost_percent : undefined;
          const policy = await readPolicy();
          const weeklyReserve = typeof params.weekly_reserve_percent === "number" ? params.weekly_reserve_percent : policy.freeze_reserve_pct;
          const owner = typeof params.owner === "string" ? params.owner : undefined;
          const planShare = typeof params.plan_share_percent === "number" ? params.plan_share_percent : undefined;
          const actionClass = typeof params.action_class === "string" ? params.action_class : undefined;
          const routing = actionClass ? await readRouting() : undefined;
          result = await fillFor(this.store, meter, laneCost, weeklyReserve, new Date(), { owner, planSharePercent: planShare, actionClass, durationMinutes: typeof params.duration_minutes === "number" ? params.duration_minutes : routing?.costs[actionClass ?? ""]?.duration_minutes, pacing: policy.pacing, allowance: typeof params.allowance === "string" ? params.allowance : policy.allowance, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve, reserveMeta: policy.reserve_meta, policyMtime: policy.policy_mtime, needWindow: typeof params.need === "string" ? params.need : undefined }); break;
        }
        case "health": result = {
          state: this.stopping ? "stopping" : "running",
          socket: this.path,
          // Lets install-service tell a daemon an older install started (after an in-place upgrade) from a current one.
          version: this.startedVersion ?? await headroomVersion(),
          in_flight: this.inFlight.size,
          backoff: [...this.backoff.entries()].map(([principal, item]) => ({ principal, until: new Date(item.until).toISOString(), failures: item.failures })),
          keepalive: {
            running: this.keepalive?.running === true,
            pid: this.keepalive?.pid ?? null,
            uptime_ms: this.keepalive?.uptimeMs ?? null,
            login_state: this.keepalive?.loginState ?? "unknown",
            /** An external Antigravity server (IDE, the user's agy) is serving reads, so our own keepalive is suppressed. */
            external_server: this.externalServerNoted,
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
        : request.method === "heartbeat_beat" || request.method === "heartbeat_stop" ? (typeof params.owner === "string" ? params.owner : "?")
        : request.method === "timer_set" || request.method === "timer_clear" ? `${typeof params.owner === "string" ? params.owner : "?"}:${typeof params.name === "string" ? params.name : "?"}`
        : typeof params.principal === "string" ? params.principal : typeof params.meter === "string" ? params.meter : null;
      // health remains available during shutdown so callers can distinguish
      // a draining daemon from a dead socket; its informational audit must
      // not turn that otherwise store-free reply into a closed-store access.
      this.auditQuietly(caller, request.method, auditSubject, "ok");
      return finish(rpcResult(request.id, result));
    } catch (error) {
      this.auditQuietly(caller, request.method, null, "error");
      const message = this.stopping || !this.storeOpen ? "Headroom daemon is stopping" : safeError(error);
      // The client only ever sees the JSON-RPC error's message; without a
      // matching daemon-log line, a genuine handler exception (as opposed to
      // a domain-level "no" answer) leaves no local trail to diagnose from.
      // Awaited (unlike this file's other informational appendDaemonLog
      // calls) so the log line is guaranteed to land before the error reply
      // does -- an operator reading the log right after seeing the error
      // must never race an unflushed write.
      if (this.canUseStore()) await appendDaemonLog(`${request.method} failed: ${message}`, this.home);
      return finish(rpcError(request.id, -32000, message));
    }
  }

  /**
   * Heartbeat lapse detection and due-timer firing. Called from two
   * independent places: the top of every poll() -- an owner may register a
   * heartbeat with zero accounts configured, so a vendor poll must never be
   * a prerequisite -- and scheduleMaintenance()'s own timer, which runs
   * regardless of whether any account is enabled at all and is what
   * actually guarantees this runs promptly even when poll() itself is never
   * reached (see that method's own doc comment).
   *
   * `respectThrottle` (default true, poll()'s own setting) gates this call
   * behind `claimDaemonInterval`'s 15s window, which exists purely to
   * dampen a *burst of RPCs* re-running the same scan redundantly -- it was
   * never meant to also gate the dedicated scheduler's own tick, which
   * already paces itself far more precisely (down to MAINTENANCE_MIN_DELAY_MS)
   * from the real next deadline. `scheduleMaintenance` passes `false`: a
   * timer due only a couple of seconds after the *previous* pass would
   * otherwise sit blocked behind this same 15s window on every scheduler
   * tick until it happened to outlast it, delivered many seconds later than
   * its own correctly-computed reschedule. The throttle's timestamp is still
   * recorded unconditionally either way (`claimDaemonInterval(..., 0)` never
   * refuses), so a poll()-triggered call arriving soon after a scheduler
   * tick still correctly treats the work as already done. */
  /** Tracks the complete pass, including configuration reads that happen
   * before its existing timer/notifier child promises are created. */
  private runMaintenancePass(now: Date, respectThrottle = true): Promise<void> {
    const pass = this.runMaintenancePassInner(now, respectThrottle);
    const tracked = pass.finally(() => { this.maintenancePassesInFlight.delete(tracked); });
    this.maintenancePassesInFlight.add(tracked);
    return tracked;
  }

  private async runMaintenancePassInner(now: Date, respectThrottle = true): Promise<void> {
    if (!this.canUseStore()) return;
    if (respectThrottle) { if (!this.store.claimDaemonInterval("heartbeat_timer_check", now, 15_000)) return; }
    else this.store.claimDaemonInterval("heartbeat_timer_check", now, 0);
    // Same ordering rule as poll() below (and the same reasoning): this must
    // run before checkHeartbeatLapses()/fireDueTimers() (via claimTimer) can
    // create any heartbeat_lapsed/heartbeat_restored/timer_missed event.
    // Idempotent and cheap once already initialized (a daemon_state marker
    // check), so calling it on every pass is fine -- but skipping it here
    // was a real gap: notifications enabled mid-run (a policy.toml edit,
    // with no daemon restart) previously only got this call from poll()'s
    // own vendor-triggered path, which zero enabled accounts -- or simply no
    // vendor poll happening to run first -- could leave unreached, letting
    // the very first lapse or missed timer after enabling notifications be
    // swallowed as "historical backlog" instead of delivered. Its own
    // failure (a malformed or otherwise unreadable notify/policy config)
    // must never take heartbeat checks and timer firing down with it -- caught
    // and logged on its own, same as checkHeartbeatLapses's own guard just
    // below, rather than left to propagate and abort the rest of this pass.
    try { if ((await readNotifyConfig(this.home))?.channels.length && this.canUseStore()) this.store.initializeNotificationEvents(); }
    catch (error) { void appendDaemonLog(`notification config read failed: ${safeError(error)}`, this.home); }
    // The config read above is the common shutdown race: do not start any
    // later store work when stop() began while it was pending. The guarded
    // store additionally protects helper calls across their own awaits.
    if (!this.canUseStore()) return;
    // Never let a defect here (or an unexpected throw from store access)
    // abort the vendor poll this call is about to make: this whole block
    // is best-effort background bookkeeping, not something a caller
    // waiting on capacity should ever fail behind.
    try { this.store.checkHeartbeatLapses(now); }
    catch (error) { void appendDaemonLog(`heartbeat lapse check failed: ${safeError(error)}`, this.home); }
    // Single-flight: a slow inbox write can outlast this 15s throttle, and
    // starting a second pass while the first is still running would let
    // both see the same due timer as a candidate. store.claimTimer's own
    // per-timer atomicity already makes that safe (only one claim can
    // succeed), but skipping the second pass entirely avoids the wasted
    // work and duplicate log lines it would otherwise produce.
    if (!this.timerFiringInFlight) {
      // A real, advancing clock for each individual claim/send/confirm --
      // not this pass's own frozen `now`, which only decides which timers
      // are due for this pass (see fireDueTimers's own doc comment on why
      // reusing it for every timestamp would let a --since cursor hide a
      // timer this same pass genuinely delivers later, in real time, than
      // some other message written while it was still busy).
      this.timerFiringInFlight = fireDueTimers(this.storeWhileDraining, this.home, now, undefined, undefined, this.deliveryTimeoutMs, () => new Date())
        .catch((error: unknown) => { void appendDaemonLog(`timer firing pass failed: ${safeError(error)}`, this.home); return 0; })
        .finally(() => { this.timerFiringInFlight = undefined; });
    }
    // A dedicated notification pass follows immediately: the vendor-poll
    // notify pass in poll() below only runs once the poller itself actually
    // executes (see the early-return branches just below this call site in
    // poll()), which a heartbeat_lapsed or timer_missed event must never
    // have to wait on.
    this.trackNotify(deliverNotifications(this.storeWhileDraining, { home: this.home })
      .catch((error: unknown) => appendDaemonLog(`notify pass failed: ${safeError(error)}`, this.home)));
  }

  /** Registers a background notifier pass in notifyInFlight so stop() can
   * drain it before closing the store out from under a write still in
   * flight (see stop()'s own comment). Fire-and-forget from every caller's
   * own point of view -- this only changes what stop() waits for, never
   * what the caller itself awaits. */
  private trackNotify(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => { this.notifyInFlight.delete(tracked); });
    this.notifyInFlight.add(tracked);
  }

  /**
   * The daemon-owned maintenance timer: heartbeat lapse checks, timer firing
   * and the notifier pass must not depend on account polling -- with zero
   * enabled accounts, poll() is never reached at all, and even
   * with accounts enabled a due timer could wait a full poll interval,
   * 4-6 minutes at the default cadence). Runs a pass immediately, then
   * reschedules itself around the next real deadline: the soonest pending
   * timer's `at`, or the soonest still-live heartbeat's own lapse instant
   * (`store.nextMaintenanceDeadline`), clamped to [MAINTENANCE_MIN_DELAY_MS,
   * MAINTENANCE_MAX_DELAY_MS] so it neither busy-loops on a deadline that
   * just passed nor sleeps past a minute even with nothing registered yet (a
   * `timer_set` or `heartbeat_beat` racing in right after this tick must
   * still be picked up within that ceiling). Single-flight and self
   * re-arming: only one of these timers is ever live at a time (the old one
   * is always cleared, in `stop()` or implicitly by firing), and the actual
   * work is unref'd so it never by itself keeps the process alive.
   */
  private async scheduleMaintenance(): Promise<void> {
    if (this.stopping) return;
    // A defect here must re-arm the next tick on the default cadence rather
    // than killing this self-re-arming loop outright -- unlike poll()'s own
    // fire-and-forget call to runMaintenancePass (which simply logs and lets
    // the next scheduled poll try again), this timer is the only thing that
    // still runs when no account is enabled at all, so it must never die
    // silently.
    let delay = MAINTENANCE_MAX_DELAY_MS;
    try {
      await this.runMaintenancePass(new Date(), false);
      // Wait for whichever timer-firing pass is in flight (this call's own,
      // or one a concurrent poll() already started) so the deadline read
      // just below reflects timers that pass just fired, not ones still
      // mid-claim -- bounded (MAINTENANCE_TIMER_WAIT_TIMEOUT_MS), since a
      // stuck delivery this pass's own send happens to be waiting out
      // (fireDueTimers has its own per-delivery timeout, but several due
      // timers in one pass still stack) must never stall this scheduler,
      // the one thing still running heartbeat checks with no account
      // enabled at all.
      if (this.timerFiringInFlight) await boundedWait([this.timerFiringInFlight], MAINTENANCE_TIMER_WAIT_TIMEOUT_MS);
      const now = Date.now();
      const deadline = this.store.nextMaintenanceDeadline(new Date(now));
      const untilDeadline = deadline ? deadline.getTime() - now : MAINTENANCE_MAX_DELAY_MS;
      delay = Math.min(MAINTENANCE_MAX_DELAY_MS, Math.max(MAINTENANCE_MIN_DELAY_MS, untilDeadline));
    } catch (error) {
      void appendDaemonLog(`maintenance pass failed: ${safeError(error)}`, this.home);
    }
    if (this.stopping) return;
    const timer = setTimeout(() => { void this.scheduleMaintenance(); }, delay);
    timer.unref();
    this.maintenanceTimer = timer;
  }

  /** The enriched readings the `status` RPC serves, and the agent line is
   * built from. Disabled principals are excluded from capacity: their rows
   * are dropped before anything is computed. */
  private servedStatus(policy: Policy, now: Date): Observation[] {
    const observations = this.store.latestPerWindow().filter((item) => this.accounts.some((account) => account.name === item.principal_id && isAccountEnabled(account)));
    // A principal currently sitting out a live vendor 429 backoff (see
    // poll()'s own backoff bookkeeping) still serves whatever it last
    // read, unchanged, except its reason: naming the real deadline this
    // backoff actually lifts at beats repeating the original failure
    // message, which only grows staler while the backoff runs.
    const withBackoff = withBackoffReasons(observations, (id) => this.backoff.get(id)?.until ?? this.backoff.get("all")?.until, now.getTime());
    return withCreditsLapsed(withStatusInfo(withBackoff, this.store.burnRateFor(withBackoff, now), this.store.lastKnownFor(withBackoff, now), policy.staleness_minutes, now), now);
  }

  /** Rewrites line.txt and line.json (issue #149) from this poll's readings.
   * Built synchronously while the store is known open, written in the
   * background and drained by stop() like a notification pass; a failure is
   * logged and never fails the poll. */
  private refreshAgentLine(policy: Policy): void {
    try {
      const now = new Date();
      const principals = this.accounts.filter((account) => isAccountEnabled(account) && !isLocalAccount(account)).map((account) => account.name);
      const line = buildAgentLine(this.servedStatus(policy, now), policy, principals, now);
      this.trackNotify(writeAgentLine(this.home, line)
        .catch((error: unknown) => appendDaemonLog(`agent line write failed: ${safeError(error)}`, this.home)));
    } catch (error) {
      void appendDaemonLog(`agent line build failed: ${safeError(error)}`, this.home);
    }
  }

  private async poll(principal: string | undefined, forced: boolean): Promise<PollResult | { rate_limited: true }> {
    const key = principal ?? "all";
    const now = Date.now();
    // See runMaintenancePass's own doc comment: this call and the
    // independent maintenance timer both funnel through the same
    // claimDaemonInterval-guarded pass, so racing the two is safe.
    void this.runMaintenancePass(new Date(now))
      .catch((error: unknown) => appendDaemonLog(`maintenance pass failed: ${safeError(error)}`, this.home));
    const policy = await readPolicy(); // mtime/reload safe: no cached config survives a request or SIGHUP.
    // Settings can enable notifications without restarting the daemon. Take
    // the history boundary before this poll creates its first eligible event.
    if ((await readNotifyConfig(this.home))?.channels.length) this.store.initializeNotificationEvents();
    const interval = (policy.principal_intervals[principal ?? ""] ?? policy.poll_interval_minutes) * 60_000;
    const blocked = this.backoff.get(key);
    // Keepalive's local source has no vendor request budget. It is deliberately
    // attempted during a remote backoff so a newly-warmed agy can recover status.
    const warmOnly = blocked !== undefined && blocked.until > now && this.localAntigravityServerAvailable(policy);
    if (blocked && blocked.until > now && !warmOnly) return { rate_limited: true };
    if (!forced && principal === undefined && !warmOnly) {
      try {
        const accounts = await this.currentAccounts();
        const enabled = accounts.filter(isAccountEnabled);
        if (enabled.length && enabled.every((account) => (this.lastPoll.get(account.name) ?? 0) + (policy.principal_intervals[account.name] ?? policy.poll_interval_minutes) * 60_000 > now)) return { observations: [], failures: [] };
      } catch { /* A collection pass returns the useful configuration error. */ }
    }
    if (forced && (this.lastPoll.get(key) ?? 0) + interval > now && !warmOnly) return { rate_limited: true };
    if (!forced && (this.lastPoll.get(key) ?? 0) + interval > now && !warmOnly) return { observations: [], failures: [] };
    const accounts = await this.currentAccounts();
    const enabledAccounts = accounts.filter(isAccountEnabled);
    if (principal && accounts.some((account) => account.name === principal && !isAccountEnabled(account))) return { observations: [], failures: [] };
    if (!principal && accounts.length && !enabledAccounts.length) return { observations: [], failures: [] };
    // Records which probe binary this poll is about to run, before it runs.
    // Idempotent, so two concurrent poll() calls racing here (before the
    // inFlight check/set pair right below, which must stay await-free to keep
    // coalescing them into one poller call) doing this twice is harmless.
    await syncClaudeProbeState(this.store);
    const current = this.inFlight.get(key);
    if (current) return current;
    // The interval gates above ran before several awaits. A concurrent poll
    // that both started and finished during them left no in-flight entry to
    // join, yet did set lastPoll: without this re-check the late arrival
    // would fire a second, duplicate vendor poll. Same await-free step as
    // the inFlight check and set, so nothing can slip in between.
    if (!forced && !warmOnly && (this.lastPoll.get(key) ?? 0) + interval > Date.now()) return { observations: [], failures: [] };
    const task = this.poller(principal, {
      // "May probe a local Antigravity server": our keepalive, or one the
      // discovery found that Headroom did not start (the IDE's).
      daemonOwnsAntigravity: this.localAntigravityServerAvailable(policy),
      skipRemoteAntigravity: warmOnly,
      antigravityLoginState: this.keepalive?.loginState ?? "unknown",
      claudeGrant: claudeGrantGate(this.store),
    }).then((rawResult) => {
      // Keep the daemon's bookkeeping closed even for an injected poller:
      // disabled rows must not create observations, source events, or alerts.
      const disabled = new Set(accounts.filter((account) => !isAccountEnabled(account)).map((account) => account.name));
      const result = {
        ...rawResult,
        observations: rawResult.observations.filter((item) => !disabled.has(item.principal_id)),
        failures: rawResult.failures.filter((failure) => ![...disabled].some((name) => failure.startsWith(`${name} source failed`))),
      };
      this.lastPoll.set(key, Date.now());
      for (const id of new Set(result.observations.map((item) => item.principal_id))) this.lastPoll.set(id, Date.now());
      this.store.insertPoll(result.observations);
      this.store.leases();
      this.refreshAgentLine(policy);
      // Human-facing delivery of the events the inserts above just detected.
      // Deliberately not awaited here: a slow or failing notification
      // channel must never delay a poll, and the ledger inside carries its
      // own retries. Tracked in notifyInFlight so stop() still drains it
      // before closing the store (see stop()'s own comment).
      this.trackNotify(deliverNotifications(this.storeWhileDraining, { home: this.home })
        .catch((error: unknown) => appendDaemonLog(`notify pass failed: ${safeError(error)}`, this.home)));
      // Model-catalog reads are throttled to at most once per hour per
      // principal on their own (see MODEL_CHECK_INTERVAL_MS), independent of
      // this poll's own interval, so piggybacking here adds no load to the
      // ordinary quota poll cadence. Deliberately not awaited, same reason
      // as the notification pass above.
      void checkModelAvailability(this.store, accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && isAccountEnabled(account)), { antigravityModelCatalog: policy.antigravity_model_catalog })
        .catch((error: unknown) => appendDaemonLog(`model availability check failed: ${safeError(error)}`, this.home));
      this.runAgyWatchdogPass(policy);
      for (const [principalId, read] of Object.entries(result.antigravityLocal ?? {})) {
        if (disabled.has(principalId)) continue;
        this.antigravityLocal.set(principalId, read);
        const unsettled = Object.entries(read.lanes ?? {}).filter(([, state]) => state !== "fresh").map(([lane, state]) => `${lane} ${state}`);
        void appendDaemonLog(`antigravity local ${principalId}: ${read.outcome} (${read.payload_kind}${unsettled.length ? `; ${unsettled.join(", ")}` : ""})`, this.home);
      }
      if (this.schedulingStarted && enabledAccounts.some((account) => !isLocalAccount(account) && account.vendor === "antigravity")) {
        // maybeStartKeepalive() itself never rejects (see its own doc
        // comment), but this detached call is guarded again here anyway --
        // defense in depth, not reliance on that guarantee alone -- so a
        // future change to that method can never turn this fire-and-forget
        // call into an unhandled rejection by accident.
        void this.maybeStartKeepalive(enabledAccounts, policy)
          .catch((error: unknown) => appendDaemonLog(`antigravity keepalive: unexpected error from a poll-triggered start attempt: ${safeError(error)}`, this.home));
      }
      // A gate-blocked skip renders the exact same failed observation reason
      // as a real denial on purpose (see PollResult.claudeProbeOutcomes), so
      // the audit outcome comes from the collector's own record of what it
      // did, never from inspecting the observations after the fact.
      for (const [principalId, outcome] of Object.entries(result.claudeProbeOutcomes ?? {})) {
        if (!disabled.has(principalId)) this.store.audit("daemon", "claude_probe", principalId, outcome);
      }
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
    try { for (const account of (await this.currentAccounts()).filter(isAccountEnabled)) this.schedulePrincipal(account.name); }
    catch { this.schedulePrincipal("all"); }
  }

  /** Never rejects: every caller is detached, and an unhandled rejection
   * ends the daemon. A malformed accounts.toml or policy.toml keeps the
   * principal on a retry timer, so polling resumes once the file is fixed. */
  private async schedulePrincipal(principal: string): Promise<void> {
    let delay = SCHEDULE_RETRY_DELAY_MS;
    try {
      if (principal !== "all") {
        const account = (await this.currentAccounts()).find((item) => item.name === principal);
        if (!account || !isAccountEnabled(account)) { this.schedulers.delete(principal); return; }
      }
      const policy = await readPolicy();
      const minutes = policy.principal_intervals[principal] ?? policy.poll_interval_minutes;
      delay = Math.max(1_000, minutes * 60_000 * (0.8 + Math.random() * 0.4));
    } catch (error) {
      void appendDaemonLog(`poll scheduling for ${principal} failed, retrying: ${safeError(error)}`, this.home);
    }
    if (this.stopping) return;
    const timer = setTimeout(() => { void this.runScheduledPoll(principal); }, delay);
    timer.unref(); this.schedulers.set(principal, timer);
  }

  private async runScheduledPoll(principal: string): Promise<void> {
    try { await this.poll(principal === "all" ? undefined : principal, false); }
    catch (error) { void appendDaemonLog(`scheduled poll for ${principal} failed: ${safeError(error)}`, this.home); }
    finally { this.schedulers.delete(principal); void this.schedulePrincipal(principal); }
  }

  private installReloadHandlers(): void {
    process.on("SIGHUP", () => { this.lastPoll.clear(); this.backoff.clear(); this.accountsMtime = undefined; void this.schedulePrincipals(); });
  }

  /** Reloads principal scheduling when accounts.toml changes without a restart. */
  private async currentAccounts(): Promise<Account[]> {
    let mtime: string;
    try { const info = await stat(accountsPath()); mtime = `${info.mtimeMs}:${info.size}`; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.accounts = []; this.accountsMtime = undefined;
        // No accounts.toml at all means no Antigravity account is enabled
        // either: falls through to the SAME stop-if-nothing-enabled check
        // the normal path below applies, rather than returning early and
        // skipping it -- which used to leave a keepalive that was running
        // when accounts.toml got deleted running (or endlessly retrying its
        // own restart) forever, with nothing left in the config to justify it.
        this.stopKeepaliveIfNoneEnabled(this.accounts);
        return this.accounts;
      }
      throw error;
    }
    if (this.accountsMtime === mtime) return this.accounts;
    const accounts = await readAccounts();
    const priorAccounts = new Map(this.accounts.map((account) => [account.name, account]));
    const prior = new Set(priorAccounts.keys());
    const next = new Set(accounts.map((account) => account.name));
    this.accounts = accounts;
    this.accountsMtime = mtime;
    for (const name of prior) if (!next.has(name) || !isAccountEnabled(accounts.find((account) => account.name === name)!)) {
      const timer = this.schedulers.get(name);
      if (timer) clearTimeout(timer);
      this.schedulers.delete(name);
      this.lastPoll.delete(name);
      this.backoff.delete(name);
    }
    if (this.schedulingStarted) for (const account of accounts) if (isAccountEnabled(account) && (!prior.has(account.name) || !isAccountEnabled(priorAccounts.get(account.name)!))) void this.schedulePrincipal(account.name);
    this.stopKeepaliveIfNoneEnabled(accounts);
    return this.accounts;
  }

  /** An existing keepalive with no enabled Antigravity account left to serve
   * (the last one was disabled, removed outright, or accounts.toml itself
   * was deleted -- see both currentAccounts() call sites) must stop -- an
   * `accounts.toml` edit that disables Antigravity while the daemon is
   * already running must not leave its `agy` process running unsupervised.
   * A thin wrapper over stopKeepaliveUnless() -- see that method's own doc
   * comment for why EXISTENCE, not `.running`, is the right gate. */
  private stopKeepaliveIfNoneEnabled(accounts: Account[]): void {
    this.stopKeepaliveUnless(accounts.some((account) => isAccountEnabled(account) && !isLocalAccount(account) && account.vendor === "antigravity"), "disabled");
  }

  /** Shared serialized-stop path for every reason an existing keepalive can
   * stop being justified: no enabled Antigravity account left (accounts.toml,
   * via stopKeepaliveIfNoneEnabled) or the policy itself now disables it
   * (policy.toml, via attemptStartKeepalive's own top-of-function check) --
   * a policy-level disable must stop an existing supervisor exactly as
   * surely as an account-level one already did, through this one path,
   * rather than each caller growing its own ad hoc stop logic.
   * Checked by EXISTENCE (`this.keepalive`), not `.running`: a supervisor
   * that is mid-reap after a crash, or merely has a scheduled restart
   * pending (this.restart set), reports `running` as false too, but will
   * still relaunch on its own the moment that reap or timer resolves unless
   * .stop() -- which clears its restart timer and sets its own `stopping`
   * flag -- is actually called on it. */
  private stopKeepaliveUnless(justified: boolean, reason: string): void {
    if (this.keepalive && !justified) {
      const keepalive = this.keepalive;
      this.keepalive = undefined;
      // Tracked (not fired-and-forgotten): maybeStartKeepalive() awaits this
      // before ever constructing a replacement supervisor, so a quick
      // disable-then-re-enable can never start a new one while this stop()
      // is still reading or writing the shared home/state-file paths.
      this.keepaliveStopPending = keepalive.stop()
        .catch((error: unknown) => { void appendDaemonLog(`antigravity keepalive stop (${reason}): ${safeError(error)}`, this.home); })
        .finally(() => { this.keepaliveStopPending = undefined; });
    }
  }
}

async function socketExists(path: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  try { return (await lstat(path)).isSocket(); }
  catch { return false; }
}

/** A bare connect() probe, deliberately separate from the RPC/health
 * protocol in rpc()/daemonRequest(): it asks the kernel only whether
 * *anyone* is listening at `path`, never sends a request line, and never
 * waits out a health timeout. ECONNREFUSED (nothing bound to the path) and
 * ENOENT (the file vanished between the caller's lstat and this connect) are
 * the only outcomes that mean "no listener" -- resolved as `false`. Anything
 * else, including an error this process cannot interpret (e.g. EACCES), is
 * treated conservatively as "a listener might be there": prepareSocket()
 * then leaves the file alone and falls through to the existing health-based
 * check rather than ever unlinking on an ambiguous signal. */
async function hasListener(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    // A probe that neither connects nor fails in time is ambiguous: treat it as
    // a possible listener so startup never hangs and never unlinks on a guess.
    const timer = setTimeout(() => finish(true), timeoutMs);
    const finish = (value: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"));
  });
}

/**
 * Probe health separately from a potentially slow request. A live daemon may
 * need to poll before answering `status`; that must not look like no daemon.
 *
 * `healthAttempts` (default 1, unchanged for every existing caller) lets a
 * read-only caller that can serve a clearly-flagged cached answer ask for one
 * retry before giving up on the daemon: a poll cycle's own synchronous write
 * (see store.ts's `insertPoll`) can occasionally still run past a single 2s
 * health budget under host load, and a second attempt often lands once it has
 * finished. A write/dispatch caller must keep passing the default: retrying
 * here only ever delays discovering "unresponsive", it never changes a
 * fail-closed answer into anything less strict.
 */
export async function daemonRequest(path: string, method: string, params: Json = {}, healthTimeoutMs = 2_000, requestTimeoutMs = 30_000, signal?: AbortSignal, healthAttempts = 1): Promise<
  | { status: "available"; result: unknown }
  | { status: "absent" }
  | { status: "unresponsive" }
> {
  if (signal?.aborted) return { status: "absent" };
  // No daemon can listen on an overlong path, so there is nothing to dial:
  // every caller then takes its usual no-daemon fallback.
  if (socketPathProblem(path)) return { status: "absent" };
  // Mutual auth (win32 only) is verified entirely inside rpc() itself now: a
  // reply -- health included -- whose transcript proof does not check out
  // comes back as `undefined`, indistinguishable here from no daemon
  // answering at all. There is nothing left for daemonRequest to double-check.
  let health: unknown;
  for (let attempt = 0; attempt < Math.max(1, healthAttempts); attempt += 1) {
    health = await rpc(path, "health", {}, healthTimeoutMs, Math.min(healthTimeoutMs, RPC_ABSOLUTE_DEADLINE_MS), signal);
    if (health !== undefined || signal?.aborted) break;
  }
  if (signal?.aborted) return { status: "absent" };
  if (health === undefined) return (await socketExists(path)) ? { status: "unresponsive" } : { status: "absent" };
  const result = await rpc(path, method, params, requestTimeoutMs, Math.min(requestTimeoutMs, RPC_ABSOLUTE_DEADLINE_MS), signal);
  return result === undefined ? { status: "unresponsive" } : { status: "available", result };
}

/** What asking the daemon on `path` to shut down produced. "accepted": it is stopping (or already
 * was). "absent": nothing listens there. "unsupported": a daemon from a version without the request
 * answered "Method not found". "refused": it answered with another error (for example a failed proof).
 * "unresponsive": something holds the pipe but did not answer in time. */
export type ShutdownOutcome = "accepted" | "absent" | "unsupported" | "refused" | "unresponsive";

/** Asks the daemon to stop itself gracefully over its own authenticated pipe or socket (the same
 * proof every mutating request carries). Bounded by short timeouts; never throws. Dials the legacy
 * Windows pipe name too when nothing listens on the current one, as every client does. */
export async function requestDaemonShutdown(path = socketPath()): Promise<ShutdownOutcome> {
  try {
    const reply = await daemonRequest(path, "shutdown", {}, 1_000, 3_000);
    if (reply.status !== "available") return reply.status;
    const value = reply.result as { state?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    if (value && typeof value === "object" && value.error) {
      if (value.error.code === -32601) return "unsupported";
      // A daemon that already began a signal-driven stop rejects everything but health with this.
      return value.error.code === -32000 && value.error.message === "Headroom daemon is stopping" ? "accepted" : "refused";
    }
    return value && typeof value === "object" && value.state === "stopping" ? "accepted" : "refused";
  } catch { return "unresponsive"; }
}

export async function rpc(path: string, method: string, params: Json = {}, timeoutMs = 2_000, absoluteTimeoutMs = RPC_ABSOLUTE_DEADLINE_MS, signal?: AbortSignal): Promise<unknown | undefined> {
  const outcome = { missing: false };
  const value = await rpcAttempt(path, method, params, timeoutMs, absoluteTimeoutMs, signal, outcome);
  // Only a pipe that does not exist at all (ENOENT) sends the client to the
  // legacy name: a daemon that is there but slow, refuses, or fails the proof
  // keeps its answer, so the fallback can never mask a live current daemon.
  if (value !== undefined || !outcome.missing || signal?.aborted) return value;
  const legacy = legacyPipeFallback(path);
  return legacy === undefined ? undefined : rpcAttempt(legacy, method, params, timeoutMs, absoluteTimeoutMs, signal, { missing: false });
}

async function rpcAttempt(path: string, method: string, params: Json, timeoutMs: number, absoluteTimeoutMs: number, signal: AbortSignal | undefined, outcome: { missing: boolean }): Promise<unknown | undefined> {
  if (signal?.aborted) return undefined;
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
    const onAbort = (): void => done(undefined);
    // An absolute deadline independent of the inactivity timer above: that
    // timer resets on every byte received, so a connection that keeps
    // trickling data -- never enough to go idle, never a complete answer --
    // would otherwise never time out at all. This fires regardless of
    // activity.
    const absoluteDeadline = setTimeout(() => done(undefined), absoluteTimeoutMs);
    absoluteDeadline.unref?.();
    const done = (value: unknown | undefined) => {
      if (finished) return;
      finished = true;
      clearTimeout(absoluteDeadline);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(value);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
    }
    const send = (): void => {
      void (async () => {
        // The session token is read locally from the 0600 token file and used
        // only to compute HMAC proofs; the token itself is never written to
        // the socket.
        if (isWin32) token = await sessionToken();
        if (finished) return;
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
    socket.once("error", (error: NodeJS.ErrnoException) => { if (!finished) outcome.missing = error.code === "ENOENT"; done(undefined); });
    socket.once("timeout", () => done(undefined));
  });
}
