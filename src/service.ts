import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { joinForPlatform, headroomHome } from "./paths.js";
import { daemonLogPath } from "./logs.js";
import { safeError } from "./security.js";
import { headroomVersion } from "./version.js";
import type { ShutdownOutcome } from "./daemon.js";

const execFileAsync = promisify(execFile);

export function servicePath(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === "darwin") return joinForPlatform(platform, home, "Library", "LaunchAgents", "com.headroom.daemon.plist");
  if (platform === "win32") return joinForPlatform(platform, headroomHome({ platform, home, env }), "headroom-daemon.xml");
  return joinForPlatform(platform, home, ".config", "systemd", "user", "headroom.service");
}

export function serviceEnvironmentPath(home: string, platform = process.platform, inherited = process.env.PATH): string {
  const separator = platform === "win32" ? ";" : ":";
  const local = joinForPlatform(platform, home, ".local", "bin");
  const required = platform === "win32" ? [local] : [local, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([...required, ...(inherited ?? "").split(separator).filter(Boolean)])].join(separator);
}

function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

export function windowsTaskXml(script: string, runtime: string, username = userInfo().username, logPath?: string, pathValue = serviceEnvironmentPath(homedir(), "win32")): string {
  const command = logPath ? "cmd.exe" : runtime;
  const arguments_ = logPath ? `/d /s /c "set \"PATH=${pathValue}\" && \"${runtime}\" \"${script}\" daemon >> \"${logPath}\" 2>&1"` : `"${script}" daemon`;
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>${xml(username)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Hidden>true</Hidden><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(arguments_)}</Arguments></Exec></Actions></Task>\n`;
}

export function serviceContents(script: string, platform = process.platform, runtime = process.execPath, username = userInfo().username, home = homedir(), env = process.env): string {
  const log = daemonLogPath(headroomHome({ platform, home, env }), platform);
  const path = serviceEnvironmentPath(home, platform, env.PATH);
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.headroom.daemon</string><key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>${xml(script)}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  if (platform === "win32") return windowsTaskXml(script, runtime, username, log, path);
  return `[Unit]\nDescription=Headroom quota daemon\n[Service]\nEnvironment="PATH=${path}"\nExecStart=${JSON.stringify(runtime)} ${JSON.stringify(script)} daemon\nStandardOutput=append:${log}\nStandardError=append:${log}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
}

/** schtasks rejects a task XML that is not UTF-16 ("unable to switch the encoding"), so the
 * Windows file is written as UTF-16LE with a byte-order mark; every other platform stays UTF-8. */
export function serviceFileBytes(platform: string, contents: string): Buffer {
  return platform === "win32" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(contents, "utf16le")]) : Buffer.from(contents, "utf8");
}

async function readServiceFile(path: string): Promise<string | undefined> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return undefined;
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
}

/**
 * Writes the service definition pointing at the exact executable that runs
 * it -- `runtime` (process.execPath by default) and `script` (the resolved
 * entry point, process.argv[1] by default) -- so a maintainer who installs
 * the service from a repo checkout gets a daemon bound to that checkout
 * rather than to whatever `headroom` a global npm install happens to resolve
 * to elsewhere on the machine. Both are echoed back on the result (alongside
 * the existing `path`/`command`/`contents`) so a caller can print which
 * binary the installed service will run.
 */
export async function installService(script = process.argv[1] ?? "headroom", platform = process.platform, home = homedir(), runtime = process.execPath, dryRun = false, env = process.env, username = userInfo().username): Promise<{ path: string; command: string; dryRun: boolean; contents: string; script: string; runtime: string }> {
  const path = servicePath(platform, home, env);
  const command = platform === "darwin" ? `launchctl bootstrap gui/$(id -u) ${path}` : platform === "win32" ? `schtasks /Create /TN "Headroom Daemon" /XML "${path}" /F` : "systemctl --user enable --now headroom.service";
  const contents = serviceContents(script, platform, runtime, username, home, env);
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await mkdir(dirname(daemonLogPath(headroomHome({ platform, home, env }), platform)), { recursive: true, mode: 0o700 });
    await writeFile(path, serviceFileBytes(platform, contents), { mode: 0o600 });
  }
  return { path, command, dryRun, contents, script, runtime };
}

/** Runs one service-manager command (launchctl, systemctl, schtasks) and reports its exit code and
 * combined output. Never throws: a missing binary or a refusal is data for the caller to report.
 * Tests pass their own runner so no real service manager is ever touched. */
export type ServiceRunner = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

async function defaultServiceRunner(command: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { windowsHide: true, timeout: 30_000 });
    return { code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim() || failed.message || "" };
  }
}

async function defaultDaemonProbe(): Promise<boolean> {
  // Loaded lazily: daemon.ts is the whole daemon, and only this one check needs it.
  const { daemonRequest, socketPath } = await import("./daemon.js");
  return (await daemonRequest(socketPath(), "health", {}, 500, 500)).status === "available";
}

async function defaultRequestShutdown(): Promise<ShutdownOutcome> {
  const { requestDaemonShutdown, socketPath } = await import("./daemon.js");
  return requestDaemonShutdown(socketPath());
}

/** What a running daemon says about itself in its health reply. */
export interface DaemonIdentity { version?: string; socket?: string }

async function defaultDaemonIdentity(): Promise<DaemonIdentity | undefined> {
  const { daemonRequest, socketPath } = await import("./daemon.js");
  const reply = await daemonRequest(socketPath(), "health", {}, 500, 500);
  if (reply.status !== "available" || !reply.result || typeof reply.result !== "object") return undefined;
  const health = reply.result as { version?: unknown; socket?: unknown; error?: unknown };
  if (health.error) return undefined;
  return { version: typeof health.version === "string" ? health.version : undefined, socket: typeof health.socket === "string" ? health.socket : undefined };
}

async function defaultExpectedIdentity(): Promise<DaemonIdentity> {
  const { socketPath } = await import("./daemon.js");
  return { version: await headroomVersion(), socket: socketPath() };
}

/** Why a running daemon is not the one this CLI would start (it serves another pipe name, or runs
 * another version), or undefined when it matches. A daemon that cannot be identified is never called
 * stale: Headroom does not restart what it cannot read. Versions before 0.2.7 report no version, so a
 * missing one counts as different. */
export function staleDaemonReason(running: DaemonIdentity | undefined, expected: DaemonIdentity): string | undefined {
  if (!running) return undefined;
  if (running.socket !== undefined && expected.socket !== undefined && running.socket !== expected.socket) return `the running daemon serves the older pipe name ${running.socket}`;
  if (running.version !== expected.version) return running.version ? `the running daemon is version ${running.version}, this is ${expected.version}` : `the running daemon predates version ${expected.version}`;
  return undefined;
}

/** Consecutive health misses before the daemon counts as gone: one miss can be a busy daemon. */
const STOP_CONFIRMATIONS = 3;

/** Polls until the daemon has missed STOP_CONFIRMATIONS health probes in a row (true) or the
 * deadline passes while it still answers (false). With waitMs 0 this is a plain check: any answer
 * means it is running. A probe that throws counts as a miss. */
export async function waitForDaemonExit(probe: () => Promise<boolean>, sleep: (ms: number) => Promise<void>, waitMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  let misses = 0;
  for (;;) {
    let answering: boolean;
    try { answering = await probe(); } catch { answering = false; }
    misses = answering ? 0 : misses + 1;
    if (misses >= STOP_CONFIRMATIONS) return true;
    // Past the deadline, give up only while it still answers: a streak of misses already under way
    // gets its remaining (at most STOP_CONFIRMATIONS - 1) probes.
    if (misses === 0 && Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

export interface WindowsDaemonStopOptions {
  /** Asks the daemon to stop itself over its authenticated pipe (requestDaemonShutdown). */
  requestShutdown: () => Promise<ShutdownOutcome>;
  /** True while a daemon answers health. */
  probe: () => Promise<boolean>;
  /** Runs `schtasks /End /TN "Headroom Daemon"`. */
  end: () => Promise<{ code: number; output: string }>;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the daemon to go after the shutdown request (or after /End, for a daemon that cannot take the request). */
  waitMs: number;
  intervalMs?: number;
}

export interface WindowsDaemonStopResult { stopped: boolean; shutdown: ShutdownOutcome; end: { code: number; output: string } }

/**
 * Stops the Windows daemon cleanly: the authenticated shutdown request first (the daemon finishes its
 * handlers, closes SQLite and its pipe, and exits), a bounded wait for it to stop answering, then
 * `schtasks /End` as a backup. /End on its own does not stop the daemon: the task's action is
 * cmd.exe (it sets PATH and redirects output to the log), and Task Scheduler ends only that process,
 * not the node.exe it started. It still matters as the last step, because it returns the task to
 * Ready, so a following /Run is not ignored under the task's IgnoreNew policy while the wrapper is
 * still exiting. Nothing is ever killed by pid or name: Headroom cannot verify a Windows process's
 * identity. A daemon from a version without the shutdown request gets the old sequence: /End, then
 * the same bounded wait.
 */
export async function stopWindowsDaemon(options: WindowsDaemonStopOptions): Promise<WindowsDaemonStopResult> {
  const interval = options.intervalMs ?? 500;
  let shutdown: ShutdownOutcome;
  try { shutdown = await options.requestShutdown(); } catch { shutdown = "unresponsive"; }
  // Only a daemon that accepted the request (or no daemon at all) goes away on its own.
  const selfStopping = shutdown === "accepted" || shutdown === "absent";
  let stopped = selfStopping ? await waitForDaemonExit(options.probe, options.sleep, options.waitMs, interval) : false;
  let end: { code: number; output: string };
  try { end = await options.end(); } catch (error) { end = { code: 1, output: safeError(error) }; }
  if (!stopped) stopped = await waitForDaemonExit(options.probe, options.sleep, selfStopping ? 0 : options.waitMs, interval);
  return { stopped, shutdown, end };
}

export interface WindowsRestartOptions {
  runner: ServiceRunner;
  requestShutdown: () => Promise<ShutdownOutcome>;
  probe: () => Promise<boolean>;
  /** True once the new daemon answers the way the caller expects. */
  confirm: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  stopWaitMs: number;
  waitMs: number;
  intervalMs?: number;
}

/**
 * Restarts the Windows daemon without killing anything: stopWindowsDaemon (shutdown request, bounded
 * wait, /End as a backup), then `schtasks /Run`, then a bounded wait for `confirm`, with one more /Run
 * if the first was ignored. "not-stopped" leaves the old daemon running and says why.
 */
export async function restartWindowsDaemon(options: WindowsRestartOptions): Promise<{ state: "restarted" | "not-stopped" | "not-loaded" | "unconfirmed"; reason?: string }> {
  const interval = options.intervalMs ?? 500;
  const stop = await stopWindowsDaemon({ requestShutdown: options.requestShutdown, probe: options.probe, end: () => options.runner("schtasks", ["/End", "/TN", WINDOWS_TASK]), sleep: options.sleep, waitMs: options.stopWaitMs, intervalMs: interval });
  if (!stop.stopped) return { state: "not-stopped", reason: windowsStopFailure(stop) };
  for (let attempt = 1; attempt <= RESTART_RUN_ATTEMPTS; attempt += 1) {
    const run = await options.runner("schtasks", ["/Run", "/TN", WINDOWS_TASK]);
    if (run.code !== 0) return { state: "not-loaded", reason: `schtasks /Run /TN ${WINDOWS_TASK} exited ${run.code}${run.output ? `: ${run.output}` : ""}` };
    const deadline = Date.now() + options.waitMs;
    for (;;) {
      let confirmed: boolean;
      try { confirmed = await options.confirm(); } catch { confirmed = false; }
      if (confirmed) return { state: "restarted" };
      if (Date.now() > deadline) break;
      await options.sleep(interval);
    }
    // A /Run that landed while the old task still counted as running is ignored (IgnoreNew); one more
    // /Run is harmless when the new daemon is merely slow, since that one is ignored too. Never /End
    // here: it would orphan a starting daemon (it ends only the cmd.exe wrapper).
  }
  return { state: "unconfirmed" };
}

/** One sentence on why stopWindowsDaemon could not stop the daemon, for a report line. */
export function windowsStopFailure(result: WindowsDaemonStopResult): string {
  const asked = result.shutdown === "accepted" ? "it accepted the shutdown request but kept answering"
    : result.shutdown === "unsupported" ? "it is from a version without the shutdown request"
    : result.shutdown === "refused" ? "it refused the shutdown request"
    : "it did not answer the shutdown request";
  return `${asked}, and schtasks /End did not stop it (/End ends only the task's cmd.exe wrapper)`;
}

/** True when the service manager itself has the service loaded (and, on systemd, running and enabled),
 * which a foreground `headroom daemon` answering health says nothing about. */
async function serviceManagerHasService(platform: NodeJS.Platform, uid: number, runner: ServiceRunner): Promise<boolean> {
  const ok = async (command: string, args: string[]) => (await runner(command, args)).code === 0;
  if (platform === "darwin") return ok("launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`]);
  if (platform === "win32") {
    // Get-ScheduledTask's State is an enum name (Running, Ready, Disabled, Queued, Unknown) whatever the Windows language, unlike schtasks' localized text.
    // Only Running counts as running and enabled; Ready (enabled, idle), Disabled, anything else, or a failed query fails closed.
    const { code, output } = await runner("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-ScheduledTask -TaskName '${WINDOWS_TASK}').State`]);
    return code === 0 && output.trim().toLowerCase() === "running";
  }
  return (await ok("systemctl", ["--user", "is-active", "headroom.service"])) && (await ok("systemctl", ["--user", "is-enabled", "headroom.service"]));
}

export interface ServiceStartOptions {
  runner?: ServiceRunner;
  /** True when the daemon answers a health request. */
  probe?: () => Promise<boolean>;
  /** How long to wait for the daemon to answer after loading the service. */
  waitMs?: number;
  intervalMs?: number;
  /** How long to wait for a replaced Windows task's old daemon to stop answering. */
  stopWaitMs?: number;
  uid?: number;
  /** Test seam so the bounded wait does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Windows: asks the running daemon to shut down over its pipe (requestDaemonShutdown). */
  requestShutdown?: () => Promise<ShutdownOutcome>;
  /** Windows: the running daemon's own version and pipe name, from its health reply. */
  identify?: () => Promise<DaemonIdentity | undefined>;
  /** Windows: the version and pipe name this CLI's daemon would have. */
  expected?: DaemonIdentity;
}

export type ServiceStartState =
  /** The definition on disk was already current and the daemon already answers; nothing was rewritten or reloaded. */
  | "already-running"
  /** Loaded, and the daemon answered. */
  | "started"
  /** Windows: the definition was current but the running daemon was an older one (another version or
   * pipe name, after an in-place upgrade); it was shut down cleanly and the new one answers. */
  | "restarted"
  /** Windows: the running daemon is an older one and could not be stopped cleanly; it keeps serving
   * (clients still find a daemon on the older pipe name). `reason` says why. */
  | "stale"
  /** Loaded, but the daemon did not answer within the wait. */
  | "unconfirmed"
  /** The service manager refused (for example no GUI session over ssh); `reason` says why. */
  | "not-loaded";

export interface ServiceStartResult { state: ServiceStartState; reason?: string; install?: Awaited<ReturnType<typeof installService>>; manual: string }

const SERVICE_LABEL = "com.headroom.daemon";
const WINDOWS_TASK = "Headroom Daemon";
/** /Run attempts while confirming a restarted daemon answers on its new pipe. */
const RESTART_RUN_ATTEMPTS = 2;

/** The service manager's own commands, in run order, to load (or reload) the service and start it.
 * `optional` steps may fail without meaning anything: launchctl bootout on a service that was never
 * loaded, and schtasks /End on a task that is not running. `confirmStopped` steps must leave the daemon
 * no longer answering before the next step runs. */
export function serviceLoadSteps(platform: NodeJS.Platform, path: string, uid: number, replacing: boolean): { command: string; args: string[]; optional?: boolean; confirmStopped?: boolean }[] {
  if (platform === "darwin") return [
    // A rewritten plist only takes effect once the old job is gone, so unload first; on a first install this fails harmlessly.
    { command: "launchctl", args: ["bootout", `gui/${uid}/${SERVICE_LABEL}`], optional: true },
    { command: "launchctl", args: ["bootstrap", `gui/${uid}`, path] },
  ];
  if (platform === "win32") return [
    { command: "schtasks", args: ["/Create", "/TN", WINDOWS_TASK, "/XML", path, "/F"] },
    // The task XML says IgnoreNew, so /Run is a no-op while the old process lives: end it first.
    ...(replacing ? [{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK], optional: true, confirmStopped: true }] : []),
    { command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK] },
  ];
  return [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "enable", "--now", "headroom.service"] },
    // `enable --now` leaves an already-running unit on its old definition.
    ...(replacing ? [{ command: "systemctl", args: ["--user", "restart", "headroom.service"] }] : []),
  ];
}

/**
 * Writes the service definition (installService) and then actually loads and starts it, so
 * `headroom install-service` leaves a running daemon instead of a command for the user to paste.
 * Idempotent: an unchanged definition with a daemon that already answers is left alone, and a
 * changed one is unloaded before it is loaded again so the new file takes effect. A refusal from the
 * service manager (no GUI session over ssh is the usual one: launchctl bootstrap error 5 or 125) is
 * returned with its reason and the exact manual command rather than thrown -- the file is written
 * either way, so the install itself did not fail.
 */
export async function installAndStartService(script = process.argv[1] ?? "headroom", platform = process.platform, home = homedir(), runtime = process.execPath, env = process.env, username = userInfo().username, options: ServiceStartOptions = {}): Promise<ServiceStartResult> {
  const path = servicePath(platform, home, env);
  const probe = options.probe ?? defaultDaemonProbe;
  const previous = await readServiceFile(path);
  const contents = serviceContents(script, platform, runtime, username, home, env);
  const manual = (await installService(script, platform, home, runtime, true, env, username)).command;
  const runner = options.runner ?? defaultServiceRunner;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? 500;
  const stopWindows = (end: () => Promise<{ code: number; output: string }>) => stopWindowsDaemon({ requestShutdown: options.requestShutdown ?? defaultRequestShutdown, probe, end, sleep, waitMs: options.stopWaitMs ?? 10_000, intervalMs: interval });
  if (previous === contents && await serviceManagerHasService(platform, uid, runner) && await probe()) {
    if (platform !== "win32") return { state: "already-running", manual };
    // After an in-place upgrade the definition is unchanged (same node, same script path) but the
    // daemon still runs the old code, on the old pipe name. Restart it then, and only then.
    const identify = options.identify ?? defaultDaemonIdentity;
    const expected = options.expected ?? await defaultExpectedIdentity();
    const stale = staleDaemonReason(await identify().catch(() => undefined), expected);
    if (!stale) return { state: "already-running", manual };
    const restart = await restartWindowsDaemon({
      runner, requestShutdown: options.requestShutdown ?? defaultRequestShutdown, probe, sleep, intervalMs: interval,
      stopWaitMs: options.stopWaitMs ?? 10_000, waitMs: options.waitMs ?? 10_000,
      // Confirmed only once the daemon answers on this CLI's pipe name, not merely once anything answers.
      confirm: async () => (await identify().catch(() => undefined))?.socket === expected.socket,
    });
    if (restart.state === "restarted") return { state: "restarted", reason: stale, manual };
    if (restart.state === "not-stopped") return { state: "stale", reason: `${stale}; ${restart.reason}`, manual };
    return { state: restart.state, reason: restart.reason, manual };
  }
  const install = await installService(script, platform, home, runtime, false, env, username);
  for (const step of serviceLoadSteps(platform, path, uid, previous !== undefined)) {
    if (step.confirmStopped) {
      // Windows, replacing a task: shut the old daemon down cleanly first, with /End as the backup.
      const stop = await stopWindows(() => runner(step.command, step.args));
      const { code, output } = stop.end;
      // Only "the task was not running" is a harmless /End failure; anything else means the task may still be up.
      if (code !== 0 && !/not\s+(currently\s+)?running/i.test(output)) return { state: "not-loaded", reason: `${step.command} ${step.args.join(" ")} exited ${code}${output ? `: ${output}` : ""}`, install, manual };
      if (!stop.stopped) return { state: "not-loaded", reason: `${step.command} ${step.args.join(" ")} did not stop the old daemon: ${windowsStopFailure(stop)}${output ? ` (${output})` : ""}`, install, manual };
      continue;
    }
    const { code, output } = await runner(step.command, step.args);
    if (code !== 0 && !step.optional) return { state: "not-loaded", reason: `${step.command} ${step.args.join(" ")} exited ${code}${output ? `: ${output}` : ""}`, install, manual };
  }
  const waitMs = options.waitMs ?? 10_000;
  const deadline = Date.now() + waitMs;
  for (let waited = 0; waited <= waitMs && Date.now() <= deadline; waited += interval) {
    if (await probe()) return { state: "started", install, manual };
    await sleep(interval);
  }
  return { state: "unconfirmed", install, manual };
}

/** The lines `install-service` and `setup` print for a start result, so both say the same thing. */
export function describeServiceStart(result: ServiceStartResult): string[] {
  if (result.state === "already-running") return ["already installed and running"];
  if (result.state === "restarted") return [`restarted the daemon so it runs this version (${result.reason})`, "service loaded; the daemon is answering"];
  if (result.state === "stale") return [
    `the service is installed, but ${result.reason}`,
    "the older daemon keeps serving (clients still find it). To switch to this version, stop the node.exe running `headroom daemon` (Task Manager), then run `headroom install-service` again",
  ];
  const lines = result.install ? [`wrote ${result.install.path}`] : [];
  if (result.state === "started") lines.push("service loaded; the daemon is answering");
  else if (result.state === "unconfirmed") lines.push("service loaded, but the daemon has not answered yet; check `headroom logs --tail`, then `headroom doctor`");
  else lines.push(`could not load the service: ${result.reason}`, `load it yourself from a normal login session: ${result.manual}`);
  return lines;
}

export async function uninstallService(platform = process.platform, home = homedir(), dryRun = false, env = process.env): Promise<{ path: string; command: string; dryRun: boolean }> {
  const path = servicePath(platform, home, env);
  if (!dryRun) await rm(path, { force: true });
  return { path, dryRun, command: platform === "darwin" ? `launchctl bootout gui/$(id -u) ${path}` : platform === "win32" ? "schtasks /Delete /TN \"Headroom Daemon\" /F" : "systemctl --user disable --now headroom.service" };
}
