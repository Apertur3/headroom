import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { descendantsOf, isProcessGroupAlive, killProcessGroup, killTree, listProcesses, processSignature, type ExecFile } from "./process-tree.js";

type Spawn = (command: string, args: string[], options: { stdio: "ignore"; env: NodeJS.ProcessEnv; detached?: boolean }) => ChildProcess;

export type AgyLoginState = "unknown" | "logged_in" | "not_logged_in";

/** bytes read from the tail of agy's newest log per sample --
 * enough to catch the auth-state markers even past rotation noise, small
 * enough that a growing (or adversarial) log can never make this unbounded. */
const LOG_TAIL_BYTES = 64 * 1024;

/** Regular files only (lstat, never followed through a symlink), and never
 * more than LOG_TAIL_BYTES read regardless of how large the log has grown. */
async function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("not a regular file");
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

export interface AgyKeepaliveOptions {
  binary?: string;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  restartDelay?: (attempt: number) => number;
  logDirectory?: string;
  logPollIntervalMs?: number;
  logWatchMs?: number;
  /** Headroom's own state directory. When set (production always sets it),
   * stop() persists nothing itself, but launch() records the owned pids
   * here so a *future* daemon start can find and reap them if this one
   * never gets to call stop() (crash, SIGKILL, forced service restart). */
  home?: string;
  /** Overrides the state file path derived from `home`; mainly for tests. */
  stateFile?: string;
  /** How long stop() waits after SIGTERM before escalating to SIGKILL. */
  killGraceMs?: number;
  /** How many times launch() polls for agy's pid (script's child) before
   * giving up and recording script's pid alone. */
  pidDiscoveryAttempts?: number;
  pidDiscoveryIntervalMs?: number;
}

export interface KeepaliveState {
  scriptPid: number;
  /** "" until a `ps` call has confirmed it (see `verified`); never absent, so
   * the on-disk shape stays uniform whether or not `ps` ever answered. */
  scriptCommand: string;
  scriptStartedAt: string;
  agyPid?: number;
  agyCommand?: string;
  agyStartedAt?: string;
  /** ISO timestamp of Date.now() at spawn, known the instant the ChildProcess
   * exists -- no `ps` call needed. This is the only start-time evidence a
   * later sweep has for the pid named by the launch wrapper's `.agy-pid` file
   * when `ps` was never reachable in between (see sweepPreviousKeepalive). */
  launchedAt?: string;
  recordedAt: string;
  /** True once `ps` has confirmed scriptCommand/scriptStartedAt live, at
   * record time. False for the provisional record recordProvisionalState()
   * writes synchronously at spawn, before any `ps` call has had a chance to
   * run or answer. */
  verified: boolean;
}

export function keepaliveStateFilePath(home: string): string { return join(home, "antigravity-keepalive-state.json"); }

/** Path of the ps-independent pid file the launch wrapper writes (see
 * agyPtyCommand). Deterministic from `home` alone, so sweepPreviousKeepalive
 * can look for it even when the JSON state never got far enough to record it. */
function agyPidFilePathFor(stateFilePath: string): string { return `${stateFilePath}.agy-pid`; }

async function writeKeepaliveState(path: string, state: KeepaliveState): Promise<void> {
  await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: "w" });
}

/** Never trusts the file blindly: rejects a symlink, a non-regular file, or
 * a shape that doesn't match what writeKeepaliveState() itself ever writes. */
async function readKeepaliveState(path: string): Promise<KeepaliveState | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<KeepaliveState>;
    if (typeof parsed.scriptPid !== "number" || typeof parsed.scriptCommand !== "string" || typeof parsed.scriptStartedAt !== "string") return undefined;
    const state: KeepaliveState = {
      scriptPid: parsed.scriptPid, scriptCommand: parsed.scriptCommand, scriptStartedAt: parsed.scriptStartedAt,
      recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
      verified: parsed.verified === true,
    };
    if (typeof parsed.launchedAt === "string") state.launchedAt = parsed.launchedAt;
    if (typeof parsed.agyPid === "number" && typeof parsed.agyCommand === "string" && typeof parsed.agyStartedAt === "string") {
      state.agyPid = parsed.agyPid; state.agyCommand = parsed.agyCommand; state.agyStartedAt = parsed.agyStartedAt;
    }
    return state;
  } catch { return undefined; }
}

interface AgyPidFileEntry { pid: number; mtimeMs: number }

/** Reads the launch wrapper's OWN pid file directly -- independent of the
 * JSON state above, which a crash before recordState() ever wrote it, or
 * `ps` being unreachable for the whole life of a run, can leave without ever
 * knowing this pid at all. Same trust bar as readKeepaliveState: rejects a
 * symlink or a non-regular file. */
async function readAgyPidFile(path: string): Promise<AgyPidFileEntry | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(pid) && pid > 1 ? { pid, mtimeMs: info.mtimeMs } : undefined;
  } catch { return undefined; }
}

/** How far a `.agy-pid` file's mtime may precede the `launchedAt` recorded
 * alongside it and still count as "written by that same launch": filesystem
 * mtime resolution (as coarse as 1s on some volumes) plus the real (small)
 * gap between recordProvisionalState()'s synchronous write in the daemon
 * process and the launch wrapper's own `echo` in the separate child process
 * it just spawned -- both happen at launch, but never at the exact same
 * instant. Wide enough to absorb that gap, narrow enough that a `.agy-pid`
 * file left by a much older, unrelated launch cannot pass it. */
const AGY_PID_FILE_MTIME_TOLERANCE_MS = 5_000;

export interface SweepResult {
  /** Pids this sweep proved were ours and killed. */
  swept: number[];
  /** Pids found alive (by process-group signal, ps-free) that could NOT be
   * proven ours by any tier of evidence -- left running untouched. The
   * caller must not start a fresh keepalive while any of these are still
   * alive (see the daemon's own re-check before every launch attempt). */
  unverified: number[];
}

/**
 * Reap whatever a previous daemon's keepalive left behind, before this
 * daemon launches its own. Reconciles TWO independent sources left by that
 * daemon's own AgyKeepaliveSupervisor: the JSON state file (written by
 * recordState(), see below, once `ps` confirms a signature -- or, at minimum,
 * the provisional record recordProvisionalState() writes synchronously at
 * spawn, before recordState ever gets to run) and the launch wrapper's OWN
 * `.agy-pid` file (written by the spawned shell itself, so it can exist even
 * when the JSON state never got written at all, e.g. `ps` was denied for the
 * whole run). Neither file alone is trusted to be the last word; both are
 * read before anything is decided.
 *
 * Two tiers of proof, tried per candidate pid, strongest first:
 *  1. Exact `ps` signature match against a *recorded* command+start time.
 *     The strongest proof -- used whenever a prior signature was recorded
 *     AND `ps` answers now (it does not have to have answered back then). A
 *     live signature that comes back but does NOT match is definitive proof
 *     this is a different (recycled) process: it is rejected outright, never
 *     falling through to the weaker tier below.
 *  2. ps-free evidence, tried only for the pid the `.agy-pid` file itself
 *     names, when no exact recorded signature could settle it (no `ps`
 *     answer, or nothing was ever recorded to compare against): the file's
 *     mtime falls within AGY_PID_FILE_MTIME_TOLERANCE_MS of the launch time
 *     recorded alongside it, AND the pid's process GROUP is still alive
 *     (checked with a signal-0 send, isProcessGroupAlive -- no `ps`
 *     involved). This is NOT a full identity proof: a pid the OS recycled,
 *     in between, to an unrelated new session/group leader would pass it
 *     too. It is the strongest evidence obtainable without `ps`, which is
 *     why it is only ever applied to this one specific, freshly-orphaned
 *     pid -- never used to positively identify some other stranger pid.
 *
 * A pid that clears neither tier but is still alive (by process-group
 * signal) is reported in `unverified`, never signalled, and both files are
 * left in place so this same evidence is available to reconcile it again
 * later. Both files are removed only once nothing remains unverified.
 * A user's own interactively-started agy is never in either file to begin
 * with, since only launch() ever writes them. Never called on win32 (no
 * `script`, so nothing this daemon could have started to sweep).
 */
export async function sweepPreviousKeepalive(home: string, options: { execImpl?: ExecFile; killTree?: typeof killTree; log?: (message: string) => void } = {}): Promise<SweepResult> {
  if (process.platform === "win32") return { swept: [], unverified: [] };
  const path = keepaliveStateFilePath(home);
  const pidFilePath = agyPidFilePathFor(path);
  const state = await readKeepaliveState(path);
  const pidFileEntry = await readAgyPidFile(pidFilePath);
  if (!state && !pidFileEntry) return { swept: [], unverified: [] };
  const log = options.log ?? ((): void => undefined);

  // Every candidate pid this run might need to reconcile, keyed by pid so
  // the common case (the state file and the pid file both naming agy's same
  // pid) is examined once, not twice.
  const candidates = new Map<number, { command?: string; startedAt?: string }>();
  if (state) {
    candidates.set(state.scriptPid, { command: state.scriptCommand || undefined, startedAt: state.scriptStartedAt || undefined });
    if (state.agyPid !== undefined) candidates.set(state.agyPid, { command: state.agyCommand, startedAt: state.agyStartedAt });
  }
  if (pidFileEntry && !candidates.has(pidFileEntry.pid)) candidates.set(pidFileEntry.pid, {});

  // Verify every candidate's identity BEFORE killing any of them: script and
  // agy are killed independently, but killing one legitimately reaps the
  // other as its descendant, and doing that interleaved with verification
  // could make an already-reaped candidate look like "pid not found; never
  // recorded" and get silently skipped from the result, undercounting a
  // sweep that in fact fully succeeded.
  const verified: Array<{ pid: number; tier: "ps" | "ps-free" }> = [];
  const unverified: number[] = [];
  for (const [pid, recorded] of candidates) {
    if (recorded.command && recorded.startedAt) {
      const live = await processSignature(pid, options.execImpl);
      if (live) {
        if (live.command === recorded.command && live.startedAt === recorded.startedAt) verified.push({ pid, tier: "ps" });
        // else: `ps` just proved this pid is something else now (reuse) --
        // never touch it, and never fall through to the weaker tier either.
        continue;
      }
      // `ps` did not answer for this pid (denied/unavailable): fall through.
    }
    if (pidFileEntry && pidFileEntry.pid === pid && state?.launchedAt) {
      const launchedAtMs = Date.parse(state.launchedAt);
      if (Number.isFinite(launchedAtMs) && pidFileEntry.mtimeMs >= launchedAtMs - AGY_PID_FILE_MTIME_TOLERANCE_MS && isProcessGroupAlive(pid)) {
        verified.push({ pid, tier: "ps-free" });
        continue;
      }
    }
    if (isProcessGroupAlive(pid)) unverified.push(pid);
  }

  const kill = options.killTree ?? killTree;
  for (const { pid, tier } of verified) {
    if (tier === "ps") await kill(pid);
    // killTree()'s SIGKILL escalation re-lists via `ps` to decide who
    // survived the SIGTERM, which is exactly what a ps-free verification has
    // no access to -- SIGKILL directly instead, the same ps-free primitive
    // stop() and the exit handler already rely on for this situation.
    else killProcessGroup(pid);
  }
  if (unverified.length) {
    log(`antigravity keepalive sweep: pid(s) ${unverified.join(", ")} left by a previous run could not be verified (no ps signature match and ps-free evidence was incomplete) -- left running untouched; a new keepalive will not launch until they are confirmed gone`);
  } else {
    try { await unlink(path); } catch { /* already gone */ }
    try { await unlink(pidFilePath); } catch { /* already gone */ }
  }
  return { swept: verified.map((entry) => entry.pid), unverified };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads only auth-state markers, never credentials or quota values, from
 * agy's newest log -- a bounded tail of a verified regular file, never a
 * symlink or other non-regular entry, and never the whole (possibly still
 * growing) file. */
export async function agyLoginStateFromLog(logDirectory = join(homedir(), ".gemini", "antigravity-cli", "log")): Promise<AgyLoginState> {
  try {
    const entries = await readdir(logDirectory);
    const candidates = await Promise.all(entries.filter((name) => /^cli-.*\.log$/.test(name)).map(async (name) => {
      const path = join(logDirectory, name);
      try {
        const info = await lstat(path);
        return info.isFile() ? { path, modified: info.mtimeMs } : undefined;
      } catch { return undefined; }
    }));
    const logs = candidates.filter((item): item is { path: string; modified: number } => item !== undefined);
    const newest = logs.sort((left, right) => right.modified - left.modified)[0];
    if (!newest) return "unknown";
    const text = await readLogTail(newest.path);
    if (/applyAuthResult.*authMethod=/.test(text)) return "logged_in";
    return text.includes("You are not logged into Antigravity") ? "not_logged_in" : "unknown";
  } catch { return "unknown"; }
}

function inheritedAgyEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(name) && !name.startsWith("HEADROOM_")));
}

/** Service managers commonly omit the interactive shell PATH. Registry wins,
 * then well-known local installs, then the inherited PATH fallback. */
export function resolveAgyBinary(registryPath?: string, home = homedir(), path = process.env.PATH, platform = process.platform): string {
  if (registryPath?.trim()) return registryPath;
  const local = join(home, ".local", "bin", platform === "win32" ? "agy.exe" : "agy");
  const homebrew = platform === "win32" ? undefined : "/opt/homebrew/bin/agy";
  const separator = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "agy.exe" : "agy";
  const onPath = (path ?? "").split(separator).filter(Boolean).map((directory) => join(directory, name)).find((candidate) => existsSync(candidate));
  const candidates = [local, ...(homebrew ? [homebrew] : []), ...(onPath ? [onPath] : [])];
  return candidates.find((candidate) => existsSync(candidate)) ?? "agy";
}

/** Owns only the `script` PTY it starts, so daemon shutdown cannot kill a user-launched agy. */
export class AgyKeepaliveSupervisor {
  private child: ChildProcess | undefined;
  private restart: NodeJS.Timeout | undefined;
  private stopping = false;
  private failures = 0;
  private startedAt: number | undefined;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly startChild: Spawn;
  private readonly delay: (attempt: number) => number;
  private readonly logDirectory: string;
  private readonly logPollIntervalMs: number;
  private readonly logWatchMs: number;
  private loginWatch: NodeJS.Timeout | undefined;
  private loginWatchStartedAt: number | undefined;
  private notLoggedInSamples = 0;
  private _loginState: AgyLoginState = "unknown";
  /** a sample already in flight skips the next tick instead of
   * starting a second concurrent read of the same log file. */
  private sampling = false;
  private readonly stateFilePath: string | undefined;
  private readonly killGraceMs: number;
  private readonly pidDiscoveryAttempts: number;
  private readonly pidDiscoveryIntervalMs: number;
  /** Where the launch wrapper writes agy's pid (see agyPtyCommand). Known
   * without `ps`, so stop() and an unexpected script exit can reap agy even
   * on a host where the process table cannot be read. */
  private readonly agyPidFile: string | undefined;

  constructor(options: AgyKeepaliveOptions = {}) {
    this.binary = options.binary ?? resolveAgyBinary(process.env.ANTIGRAVITY_CLI_PATH);
    this.platform = options.platform ?? process.platform;
    this.startChild = options.spawn ?? spawn as Spawn;
    this.delay = options.restartDelay ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)));
    this.logDirectory = options.logDirectory ?? join(homedir(), ".gemini", "antigravity-cli", "log");
    this.logPollIntervalMs = options.logPollIntervalMs ?? 1_000;
    this.logWatchMs = options.logWatchMs ?? 60_000;
    this.stateFilePath = options.stateFile ?? (options.home ? keepaliveStateFilePath(options.home) : undefined);
    this.killGraceMs = options.killGraceMs ?? 300;
    this.pidDiscoveryAttempts = options.pidDiscoveryAttempts ?? 20;
    this.pidDiscoveryIntervalMs = options.pidDiscoveryIntervalMs ?? 100;
    this.agyPidFile = this.stateFilePath && this.platform !== "win32" ? agyPidFilePathFor(this.stateFilePath) : undefined;
  }

  get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }
  get pid(): number | undefined { return this.running ? this.child?.pid : undefined; }
  get uptimeMs(): number | undefined { return this.running && this.startedAt !== undefined ? Date.now() - this.startedAt : undefined; }
  get loginState(): AgyLoginState { return this._loginState; }

  start(): void {
    this.stopping = false;
    if (!this.child && !this.restart) this.launch();
  }

  /**
   * Stops the owned PTY and, on POSIX, everything descended from it --
   * including agy itself, which (see the module doc above `killTree`) is
   * commonly its OWN process-group and session leader once `script` starts
   * it, so a plain SIGTERM to `script` alone reliably leaves it running,
   * reparented to init, at ~100 MB resident (issue #56). killTree() is what
   * actually reaches agy, verified against a live process snapshot rather
   * than assumed from how the tree was spawned -- and it, not this method,
   * must send script's own first SIGTERM: signalling script directly here
   * first would let it die and reparent agy to init *before* killTree ever
   * takes that snapshot, which would make agy's parent no longer be script
   * by the time the tree is walked and let it slip through uncaught (this
   * was a real bug caught by antigravity-keepalive-sweep.test.ts, not a
   * hypothetical). child.kill() is only a fallback for when there is no
   * real numeric pid to walk a tree from at all (a test double). Awaiting
   * the returned promise waits out the SIGTERM grace period and any SIGKILL
   * escalation; callers that only need `running` to go false (most of this
   * file's existing tests) can ignore it, since that flips synchronously,
   * before this function's first `await`.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    this.stopLoginWatch();
    const child = this.child;
    this.child = undefined;
    if (child && isAlive(child)) {
      // Read agy's pid while script is still alive: script lives exactly as
      // long as its PTY session, so a pid written by this launch's wrapper is
      // proven to be agy right now, with no `ps` involved and no chance of a
      // recycled pid.
      const agyPid = this.agyPidFile ? await this.awaitAgyPid(child) : undefined;
      const pid = child.pid;
      if (typeof pid === "number") await killTree(pid, { graceMs: this.killGraceMs });
      else child.kill("SIGTERM");
      // killTree reaches agy through a live `ps` walk; where that walk finds
      // nothing (ps denied, or agy already reparented) agy would survive as an
      // orphan holding a PTY, so reap the proven pid directly as well.
      // Group only: agy leads its own process group, and a group with that id
      // exists only while agy or one of its children is alive, so this cannot
      // reach a stranger that inherited the bare pid during the grace period.
      if (agyPid !== undefined) killProcessGroup(agyPid, { groupOnly: true });
    }
    await this.clearState();
  }

  private launch(): void {
    if (this.stopping || this.child) return;
    try {
      this.removeAgyPidFile(); // a pid left by an earlier launch must never be read as this one's
      const [command, args] = this.ptyCommand();
      const child = this.startChild(command, args, { stdio: "ignore", env: inheritedAgyEnvironment(), detached: this.platform !== "win32" });
      this.child = child;
      this.startedAt = Date.now();
      // Synchronous and ps-free, in the same tick as spawn(): a crash at ANY
      // point from here on -- even before this method's own next line, let
      // alone recordState()'s first `await` -- still leaves durable evidence
      // of this launch behind for the next daemon start's sweep to find.
      this.recordProvisionalState(child);
      this.startLoginWatch();
      void this.recordState(child);
      let handled = false;
      const exited = () => {
        if (handled) return;
        handled = true;
        // script died on its own (crash, external kill): its agy is now an
        // orphan session leader. Reap it synchronously, before any restart can
        // launch another. The pid file was written by this launch (it is
        // removed before every launch) and script exited only now, so the pid
        // is agy's; stop() handles its own reap, hence the stopping check.
        if (!this.stopping) { const agyPid = this.readAgyPid(); if (agyPid !== undefined) killProcessGroup(agyPid); }
        if (this.child === child) { this.child = undefined; this.startedAt = undefined; this.stopLoginWatch(); }
        if (!this.stopping) this.scheduleRestart();
      };
      child.once("exit", exited);
      child.once("error", exited);
    } catch { this.scheduleRestart(); }
  }

  /**
   * Writes the ps-independent half of the state sweepPreviousKeepalive()
   * needs, from information this process already holds with certainty --
   * script's own pid (straight from the ChildProcess node just returned,
   * never from `ps`) and the moment it was launched -- BEFORE recordState()
   * below ever gets to run its `ps` calls, which can take up to
   * pidDiscoveryAttempts * pidDiscoveryIntervalMs to resolve or simply never
   * resolve at all when `ps` is denied. Without this, a crash inside that
   * window left only the launch wrapper's bare `.agy-pid` file on disk, with
   * no launch time to cross-check it against -- see sweepPreviousKeepalive's
   * ps-free tier. recordState() overwrites this with a `ps`-verified record
   * once (if) one becomes available; until then, this is what a sweep has.
   */
  private recordProvisionalState(child: ChildProcess): void {
    if (!this.stateFilePath || this.platform === "win32") return;
    const scriptPid = child.pid;
    if (typeof scriptPid !== "number" || this.startedAt === undefined) return;
    const state: KeepaliveState = {
      scriptPid, scriptCommand: "", scriptStartedAt: "",
      launchedAt: new Date(this.startedAt).toISOString(),
      recordedAt: new Date().toISOString(),
      verified: false,
    };
    try { writeFileSync(this.stateFilePath, JSON.stringify(state), { mode: 0o600 }); }
    catch { /* best-effort; recordState() may still succeed once ps answers */ }
  }

  /**
   * Best-effort persistence for sweepPreviousKeepalive(): records this
   * script's pid and (once discovered) agy's own pid, each with the exact
   * command + start time `ps` reports for it right now, so a future daemon
   * start can verify a pid it finds still IS that same process before ever
   * killing it. Failure here (no `home` configured, `ps` unavailable, the
   * supervisor already moved on to a different child) leaves the provisional,
   * unverified record recordProvisionalState() already wrote in place -- the
   * next daemon start still has that to sweep with, just without a `ps`
   * signature to match against.
   */
  private async recordState(child: ChildProcess): Promise<void> {
    if (!this.stateFilePath || this.platform === "win32") return;
    const scriptPid = child.pid;
    if (typeof scriptPid !== "number") return;
    const launchedAt = this.startedAt !== undefined ? new Date(this.startedAt).toISOString() : undefined;
    try {
      const scriptSignature = await processSignature(scriptPid);
      if (!scriptSignature || this.child !== child) return;
      let agyPid: number | undefined;
      for (let attempt = 0; attempt < this.pidDiscoveryAttempts && agyPid === undefined; attempt += 1) {
        if (this.child !== child) return; // stopped or replaced before discovery finished
        agyPid = this.readAgyPid() ?? descendantsOf(scriptPid, await listProcesses())[0]?.pid;
        if (agyPid === undefined) await sleep(this.pidDiscoveryIntervalMs);
      }
      if (this.child !== child) return;
      const agySignature = agyPid !== undefined ? await processSignature(agyPid) : undefined;
      const state: KeepaliveState = {
        scriptPid, scriptCommand: scriptSignature.command, scriptStartedAt: scriptSignature.startedAt,
        launchedAt, recordedAt: new Date().toISOString(), verified: true,
      };
      if (agyPid !== undefined && agySignature) { state.agyPid = agyPid; state.agyCommand = agySignature.command; state.agyStartedAt = agySignature.startedAt; }
      // The awaits above can outlive this launch: never write a stopped or
      // replaced launch's pids over the state a newer one (or stop) left.
      if (this.child !== child || !isAlive(child)) return;
      await writeKeepaliveState(this.stateFilePath, state);
    } catch { /* best-effort only; the next sweep just finds nothing recorded */ }
  }

  /** stop() right after start() can beat the wrapper to its pid file; wait
   * (bounded) while script is alive, since agy cannot outlive an unseen pid
   * any other way on a host where killTree's ps walk finds nothing. */
  private async awaitAgyPid(child: ChildProcess, timeoutMs = 1_000): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pid = this.readAgyPid();
      if (pid !== undefined || !this.agyPidFile || !isAlive(child) || Date.now() >= deadline) return pid;
      await sleep(10);
    }
  }

  private readAgyPid(): number | undefined {
    if (!this.agyPidFile) return undefined;
    try {
      const pid = Number(readFileSync(this.agyPidFile, "utf8").trim());
      return Number.isInteger(pid) && pid > 1 ? pid : undefined;
    } catch { return undefined; }
  }

  /** Throws unless the file is gone afterwards: launch() must never run while
   * a stale pid from an earlier launch could still be read as this one's. */
  private removeAgyPidFile(): void {
    if (!this.agyPidFile) return;
    try { unlinkSync(this.agyPidFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async clearState(): Promise<void> {
    try { this.removeAgyPidFile(); } catch { /* the next launch refuses to start until it can remove it */ }
    if (!this.stateFilePath) return;
    try { await unlink(this.stateFilePath); } catch { /* already gone */ }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restart) return;
    const timeout = setTimeout(() => { this.restart = undefined; this.launch(); }, this.delay(this.failures++));
    timeout.unref();
    this.restart = timeout;
  }

  private startLoginWatch(): void {
    this.stopLoginWatch();
    this._loginState = "unknown";
    this.notLoggedInSamples = 0;
    this.sampling = false;
    this.loginWatchStartedAt = Date.now();
    const inspect = () => {
      if (this.sampling) return; // a sample is still in flight; skip this tick rather than overlap it
      this.sampling = true;
      void agyLoginStateFromLog(this.logDirectory).then((state) => {
        if (!this.running || state === "unknown") return;
        if (state === "logged_in") { this._loginState = state; this.stopLoginWatch(); return; }
        this.notLoggedInSamples += 1;
        // A single line can be startup noise; retain the negative result only
        // after it appears in consecutive samples from the newest agy log.
        if (this.notLoggedInSamples >= 2) this._loginState = state;
      }).catch(() => { /* Log discovery is diagnostic-only. */ }).finally(() => { this.sampling = false; });
      if (this.loginWatchStartedAt !== undefined && Date.now() - this.loginWatchStartedAt >= this.logWatchMs) this.stopLoginWatch();
    };
    inspect();
    this.loginWatch = setInterval(inspect, this.logPollIntervalMs);
    this.loginWatch.unref();
  }

  private stopLoginWatch(): void {
    if (this.loginWatch) clearInterval(this.loginWatch);
    this.loginWatch = undefined;
    this.loginWatchStartedAt = undefined;
  }

  private ptyCommand(): [string, string[]] { return agyPtyCommand(this.binary, this.platform, this.agyPidFile); }
}

/**
 * BSD script and util-linux script use different argument order. Both
 * create a pseudo-terminal; the Linux command is shell-quoted before script
 * receives it. Exported (rather than kept as a private method) so tests can
 * spawn the exact real command Headroom would for the current platform --
 * including the PTY session-leader behavior issue #56 is about -- instead
 * of duplicating (and risking drifting from) this logic.
 */
export function agyPtyCommand(binary: string, platform: NodeJS.Platform, pidFile?: string): [string, string[]] {
  // With a pid file, a tiny sh wrapper records its own pid and then execs
  // agy, which keeps that pid: the supervisor learns agy's pid without `ps`.
  const wrapped = pidFile ? ["/bin/sh", "-c", 'echo $$ > "$0" && exec "$1"', pidFile, binary] : [binary];
  if (platform === "darwin") return ["/usr/bin/script", ["-q", "/dev/null", ...wrapped]];
  return ["script", ["-qefc", wrapped.map(shellQuote).join(" "), "/dev/null"]];
}

function isAlive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode == null; }

/** POSIX single-quote escaping: end the quoted string, emit a literal quote
 * via a backslash outside of any quoting, then resume the quoted string. */
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
