import { spawn, type ChildProcess } from "node:child_process";

type Spawn = (command: string, args: string[], options: { stdio: "ignore"; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface AgyKeepaliveOptions {
  binary?: string;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  restartDelay?: (attempt: number) => number;
}

/** Owns only the `script` PTY it starts, so daemon shutdown cannot kill a user-launched agy. */
export class AgyKeepaliveSupervisor {
  private child: ChildProcess | undefined;
  private restart: NodeJS.Timeout | undefined;
  private stopping = false;
  private failures = 0;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly startChild: Spawn;
  private readonly delay: (attempt: number) => number;

  constructor(options: AgyKeepaliveOptions = {}) {
    this.binary = options.binary ?? process.env.ANTIGRAVITY_CLI_PATH ?? "agy";
    this.platform = options.platform ?? process.platform;
    this.startChild = options.spawn ?? spawn as Spawn;
    this.delay = options.restartDelay ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)));
  }

  get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }

  start(): void {
    this.stopping = false;
    if (!this.child && !this.restart) this.launch();
  }

  stop(): void {
    this.stopping = true;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  private launch(): void {
    if (this.stopping || this.child) return;
    try {
      const [command, args] = this.ptyCommand();
      const child = this.startChild(command, args, { stdio: "ignore", env: { HOME: process.env.HOME, PATH: process.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" } });
      this.child = child;
      let handled = false;
      const exited = () => {
        if (handled) return;
        handled = true;
        if (this.child === child) this.child = undefined;
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

  private ptyCommand(): [string, string[]] {
    // BSD script and util-linux script use different argument order. Both create
    // a pseudo-terminal; the Linux command is shell-quoted before script receives it.
    if (this.platform === "darwin") return ["/usr/bin/script", ["-q", "/dev/null", this.binary]];
    return ["script", ["-qefc", shellQuote(this.binary), "/dev/null"]];
  }
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`; }
