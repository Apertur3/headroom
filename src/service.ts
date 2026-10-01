import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { joinForPlatform, headroomHome } from "./paths.js";
import { daemonLogPath } from "./logs.js";

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
}

export type ServiceStartState =
  /** The definition on disk was already current and the daemon already answers; nothing was rewritten or reloaded. */
  | "already-running"
  /** Loaded, and the daemon answered. */
  | "started"
  /** Loaded, but the daemon did not answer within the wait. */
  | "unconfirmed"
  /** The service manager refused (for example no GUI session over ssh); `reason` says why. */
  | "not-loaded";

export interface ServiceStartResult { state: ServiceStartState; reason?: string; install?: Awaited<ReturnType<typeof installService>>; manual: string }

const SERVICE_LABEL = "com.headroom.daemon";
const WINDOWS_TASK = "Headroom Daemon";
const STOP_CONFIRMATIONS = 3;

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
  if (previous === contents && await serviceManagerHasService(platform, uid, runner) && await probe()) return { state: "already-running", manual };
  const install = await installService(script, platform, home, runtime, false, env, username);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? 500;
  for (const step of serviceLoadSteps(platform, path, uid, previous !== undefined)) {
    const { code, output } = await runner(step.command, step.args);
    if (code !== 0 && !step.optional) return { state: "not-loaded", reason: `${step.command} ${step.args.join(" ")} exited ${code}${output ? `: ${output}` : ""}`, install, manual };
    if (step.confirmStopped) {
      // Only "the task was not running" is a harmless /End failure; anything else means the old daemon may still be up.
      if (code !== 0 && !/not\s+(currently\s+)?running/i.test(output)) return { state: "not-loaded", reason: `${step.command} ${step.args.join(" ")} exited ${code}${output ? `: ${output}` : ""}`, install, manual };
      // One failed probe can be a busy daemon, so require consecutive misses within a bounded deadline.
      const stopDeadline = Date.now() + (options.stopWaitMs ?? 10_000);
      let misses = 0;
      while (misses < STOP_CONFIRMATIONS && Date.now() <= stopDeadline) {
        misses = (await probe()) ? 0 : misses + 1;
        if (misses < STOP_CONFIRMATIONS) await sleep(interval);
      }
      if (misses < STOP_CONFIRMATIONS) return { state: "not-loaded", reason: `${step.command} ${step.args.join(" ")} did not stop the old daemon${output ? `: ${output}` : ""}`, install, manual };
    }
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
