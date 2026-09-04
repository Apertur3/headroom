import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Spawn = (command: string, args: string[], options: { stdio: "ignore"; env: NodeJS.ProcessEnv }) => ChildProcess;

export type AgyLoginState = "unknown" | "logged_in" | "not_logged_in";

export interface AgyKeepaliveOptions {
  binary?: string;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  restartDelay?: (attempt: number) => number;
  logDirectory?: string;
  logPollIntervalMs?: number;
  logWatchMs?: number;
}

/** Reads only auth-state markers, never credentials or quota values, from agy's newest log. */
export async function agyLoginStateFromLog(logDirectory = join(homedir(), ".gemini", "antigravity-cli", "log")): Promise<AgyLoginState> {
  try {
    const entries = await readdir(logDirectory);
    const logs = await Promise.all(entries.filter((name) => /^cli-.*\.log$/.test(name)).map(async (name) => ({ path: join(logDirectory, name), modified: (await stat(join(logDirectory, name))).mtimeMs })));
    const newest = logs.sort((left, right) => right.modified - left.modified)[0];
    if (!newest) return "unknown";
    const text = await readFile(newest.path, "utf8");
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

  constructor(options: AgyKeepaliveOptions = {}) {
    this.binary = options.binary ?? resolveAgyBinary(process.env.ANTIGRAVITY_CLI_PATH);
    this.platform = options.platform ?? process.platform;
    this.startChild = options.spawn ?? spawn as Spawn;
    this.delay = options.restartDelay ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)));
    this.logDirectory = options.logDirectory ?? join(homedir(), ".gemini", "antigravity-cli", "log");
    this.logPollIntervalMs = options.logPollIntervalMs ?? 1_000;
    this.logWatchMs = options.logWatchMs ?? 60_000;
  }

  get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }
  get pid(): number | undefined { return this.running ? this.child?.pid : undefined; }
  get uptimeMs(): number | undefined { return this.running && this.startedAt !== undefined ? Date.now() - this.startedAt : undefined; }
  get loginState(): AgyLoginState { return this._loginState; }

  start(): void {
    this.stopping = false;
    if (!this.child && !this.restart) this.launch();
  }

  stop(): void {
    this.stopping = true;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    this.stopLoginWatch();
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  private launch(): void {
    if (this.stopping || this.child) return;
    try {
      const [command, args] = this.ptyCommand();
      const child = this.startChild(command, args, { stdio: "ignore", env: inheritedAgyEnvironment() });
      this.child = child;
      this.startedAt = Date.now();
      this.startLoginWatch();
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
    this.loginWatchStartedAt = Date.now();
    const inspect = () => {
      void agyLoginStateFromLog(this.logDirectory).then((state) => {
        if (!this.running || state === "unknown") return;
        if (state === "logged_in") { this._loginState = state; this.stopLoginWatch(); return; }
        this.notLoggedInSamples += 1;
        // A single line can be startup noise; retain the negative result only
        // after it appears in consecutive samples from the newest agy log.
        if (this.notLoggedInSamples >= 2) this._loginState = state;
      }).catch(() => { /* Log discovery is diagnostic-only. */ });
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

  private ptyCommand(): [string, string[]] {
    // BSD script and util-linux script use different argument order. Both create
    // a pseudo-terminal; the Linux command is shell-quoted before script receives it.
    if (this.platform === "darwin") return ["/usr/bin/script", ["-q", "/dev/null", this.binary]];
    return ["script", ["-qefc", shellQuote(this.binary), "/dev/null"]];
  }
}

/** POSIX single-quote escaping: end the quoted string, emit a literal quote
 * via a backslash outside of any quoting, then resume the quoted string. */
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
