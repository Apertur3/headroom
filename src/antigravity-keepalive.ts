import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { descendantsOf, killTree, listProcesses, processSignature, type ExecFile } from "./process-tree.js";

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
  scriptCommand: string;
  scriptStartedAt: string;
  agyPid?: number;
  agyCommand?: string;
  agyStartedAt?: string;
  recordedAt: string;
}

export function keepaliveStateFilePath(home: string): string { return join(home, "antigravity-keepalive-state.json"); }

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
    };
    if (typeof parsed.agyPid === "number" && typeof parsed.agyCommand === "string" && typeof parsed.agyStartedAt === "string") {
      state.agyPid = parsed.agyPid; state.agyCommand = parsed.agyCommand; state.agyStartedAt = parsed.agyStartedAt;
    }
    return state;
  } catch { return undefined; }
}

export interface SweepResult { swept: number[]; }

/**
 * Reap whatever a previous daemon's keepalive left behind, before this
 * daemon launches its own. Reads the pids that daemon's own
 * AgyKeepaliveSupervisor recorded (see launch()/recordState() below) and,
 * for each one, re-reads its *current* command and start time from `ps`:
 * only a pid whose live signature still matches exactly what was recorded
 * is killed. A pid that has since exited, or been recycled by the OS to an
 * unrelated process, fails that check and is left alone -- and a user's own
 * interactively-started agy is never in the file at all, since only
 * launch() ever writes one. Always clears the state file afterward so nothing
 * here is re-examined by a later sweep. Never called on win32 (no `script`,
 * so nothing this daemon could have started to sweep).
 */
export async function sweepPreviousKeepalive(home: string, options: { execImpl?: ExecFile; killTree?: typeof killTree } = {}): Promise<SweepResult> {
  if (process.platform === "win32") return { swept: [] };
  const path = keepaliveStateFilePath(home);
  const state = await readKeepaliveState(path);
  if (!state) return { swept: [] };
  const candidates: Array<{ pid: number; command: string; startedAt: string }> = [
    { pid: state.scriptPid, command: state.scriptCommand, startedAt: state.scriptStartedAt },
  ];
  if (state.agyPid !== undefined && state.agyCommand !== undefined && state.agyStartedAt !== undefined) {
    candidates.push({ pid: state.agyPid, command: state.agyCommand, startedAt: state.agyStartedAt });
  }
  // Verify every candidate's live signature BEFORE killing any of them.
  // script and agy are killed independently below, but killing script's
  // tree legitimately takes agy down with it (it is script's own
  // descendant) -- checking signatures interleaved with killing would let
  // an already-reaped agy look like "pid not found; never recorded" and
  // get silently skipped from the result, undercounting a sweep that in
  // fact fully succeeded.
  const verified: number[] = [];
  for (const candidate of candidates) {
    const live = await processSignature(candidate.pid, options.execImpl);
    if (live && live.command === candidate.command && live.startedAt === candidate.startedAt) verified.push(candidate.pid);
  }
  const kill = options.killTree ?? killTree;
  // A pid already reaped as another verified pid's descendant makes this a
  // harmless no-op (killTree swallows ESRCH on a pid that is already gone).
  for (const pid of verified) await kill(pid);
  try { await unlink(path); } catch { /* already gone */ }
  return { swept: verified };
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
    if (child && child.exitCode === null) {
      const pid = child.pid;
      if (typeof pid === "number") await killTree(pid, { graceMs: this.killGraceMs });
      else child.kill("SIGTERM");
    }
    await this.clearState();
  }

  private launch(): void {
    if (this.stopping || this.child) return;
    try {
      const [command, args] = this.ptyCommand();
      const child = this.startChild(command, args, { stdio: "ignore", env: inheritedAgyEnvironment(), detached: this.platform !== "win32" });
      this.child = child;
      this.startedAt = Date.now();
      this.startLoginWatch();
      void this.recordState(child);
      let handled = false;
      const exited = () => {
        if (handled) return;
        handled = true;
        if (this.child === child) { this.child = undefined; this.startedAt = undefined; this.stopLoginWatch(); }
        if (!this.stopping) this.scheduleRestart();
      };
      child.once("exit", exited);
      child.once("error", exited);
    } catch { this.scheduleRestart(); }
  }

  /**
   * Best-effort persistence for sweepPreviousKeepalive(): records this
   * script's pid and (once discovered) agy's own pid, each with the exact
   * command + start time `ps` reports for it right now, so a future daemon
   * start can verify a pid it finds still IS that same process before ever
   * killing it. Failure here (no `home` configured, `ps` unavailable, the
   * supervisor already moved on to a different child) just means the next
   * daemon start has nothing to sweep -- never fatal to this one running.
   */
  private async recordState(child: ChildProcess): Promise<void> {
    if (!this.stateFilePath || this.platform === "win32") return;
    const scriptPid = child.pid;
    if (typeof scriptPid !== "number") return;
    try {
      const scriptSignature = await processSignature(scriptPid);
      if (!scriptSignature || this.child !== child) return;
      let agyPid: number | undefined;
      for (let attempt = 0; attempt < this.pidDiscoveryAttempts && agyPid === undefined; attempt += 1) {
        if (this.child !== child) return; // stopped or replaced before discovery finished
        const processes = await listProcesses();
        agyPid = descendantsOf(scriptPid, processes)[0]?.pid;
        if (agyPid === undefined) await sleep(this.pidDiscoveryIntervalMs);
      }
      if (this.child !== child) return;
      const agySignature = agyPid !== undefined ? await processSignature(agyPid) : undefined;
      const state: KeepaliveState = {
        scriptPid, scriptCommand: scriptSignature.command, scriptStartedAt: scriptSignature.startedAt,
        recordedAt: new Date().toISOString(),
      };
      if (agyPid !== undefined && agySignature) { state.agyPid = agyPid; state.agyCommand = agySignature.command; state.agyStartedAt = agySignature.startedAt; }
      await writeKeepaliveState(this.stateFilePath, state);
    } catch { /* best-effort only; the next sweep just finds nothing recorded */ }
  }

  private async clearState(): Promise<void> {
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

  private ptyCommand(): [string, string[]] { return agyPtyCommand(this.binary, this.platform); }
}

/**
 * BSD script and util-linux script use different argument order. Both
 * create a pseudo-terminal; the Linux command is shell-quoted before script
 * receives it. Exported (rather than kept as a private method) so tests can
 * spawn the exact real command Headroom would for the current platform --
 * including the PTY session-leader behavior issue #56 is about -- instead
 * of duplicating (and risking drifting from) this logic.
 */
export function agyPtyCommand(binary: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") return ["/usr/bin/script", ["-q", "/dev/null", binary]];
  return ["script", ["-qefc", shellQuote(binary), "/dev/null"]];
}

/** POSIX single-quote escaping: end the quoted string, emit a literal quote
 * via a backslash outside of any quoting, then resume the quoted string. */
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
