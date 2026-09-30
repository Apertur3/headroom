import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { descendantsOf, type ProcessEntry } from "./process-tree.js";

const execFileAsync = promisify(execFile);

/**
 * Finds an Antigravity language server that is already running, so Headroom
 * does not start a second agy next to it. The rules mirror the native probe's
 * own discovery (CodexBarCore's AntigravityStatusProbe: a language_server
 * binary with an Antigravity marker for the app and IDE, and the agy /
 * antigravity-cli binary for the CLI), so the keepalive and the probe agree on
 * what "a server is reachable" means. They are applied to the process's
 * EXECUTABLE, never to its arguments: `vim ~/.local/bin/agy` or
 * `tail -f /tmp/antigravity-cli/log` is not a server, and counting one would
 * keep the keepalive off indefinitely. Only the language server's
 * `--app_data_dir` value is read from the arguments, and only once the
 * executable itself is a language server. Classification is read-only:
 * nothing found here is ever signalled.
 */

export interface ProcessCommand {
  pid: number;
  ppid: number;
  /** The full argument line (`ps args`). */
  command: string;
  /** The executable path: `ps comm` on macOS (the full path, spaces intact),
   * or argv[0] where procps truncates `comm` to a short name. When absent,
   * argv[0] is taken as the first word of `command`. */
  executable?: string;
}

function lastSegment(path: string): string { return path.split(/[/\\]/).pop() ?? path; }

/** The executable for one process, from its `ps comm` and its argument line. */
function executableOf(comm: string, args: string): string {
  if (/[/\\]/.test(comm)) return comm; // macOS: comm is the full executable path
  const argv0 = args.split(/\s+/)[0] ?? "";
  // procps: comm is the (possibly 15-character truncated) executable name;
  // argv[0] is its full path when its last segment starts with that name.
  return argv0 && lastSegment(argv0).startsWith(comm) ? argv0 : comm;
}

/** Joins `ps -Ao pid=,ppid=,comm=` (comm last: it may contain spaces) with
 * `ps -wwAo pid=,args=` by pid. */
export function parseProcessListing(commStdout: string, argsStdout: string): Array<Required<ProcessCommand>> {
  const args = new Map<number, string>();
  for (const line of argsStdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match) args.set(Number(match[1]), match[2]);
  }
  return commStdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = args.get(pid) ?? match[3];
    return [{ pid, ppid: Number(match[2]), executable: executableOf(match[3], command), command }];
  });
}

async function listCommands(): Promise<ProcessCommand[]> {
  if (process.platform === "win32") return [];
  try {
    const options = { maxBuffer: 16 * 1024 * 1024, timeout: 2_000, killSignal: "SIGKILL" as const };
    const [comm, args] = await Promise.all([
      execFileAsync("ps", ["-Ao", "pid=,ppid=,comm="], options),
      execFileAsync("ps", ["-wwAo", "pid=,args="], options),
    ]);
    return parseProcessListing(comm.stdout, args.stdout);
  } catch { return []; }
}

function isLanguageServerName(name: string): boolean {
  return /^language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?$/.test(name);
}

/** An Antigravity marker in the executable's own path (the app or IDE bundle,
 * or an antigravity install directory). */
function hasAntigravityPath(executable: string): boolean {
  return executable.includes("antigravity.app/") || executable.includes("antigravity.app\\")
    || executable.includes("/gemini.app/") || executable.includes("\\gemini.app\\")
    || executable.includes("antigravity ide.app/") || executable.includes("antigravity ide.app\\")
    || executable.includes("/antigravity/") || executable.includes("\\antigravity\\")
    || /(^|[/\\])(antigravity-cli|antigravity_cli)[/\\]/.test(executable);
}

/** The probe's app-data flag, read only from a language server's own arguments. */
function hasAntigravityAppData(args: string): boolean {
  return /(?:^|\s)--app_data_dir(?:=|\s+)\S*antigravity/.test(args);
}

/** True when the process is an Antigravity app/IDE language server or the agy
 * CLI itself, judged by its executable. `executable` defaults to argv[0], the
 * first word of `command`. Callers exclude Headroom's own trees (its keepalive
 * and engine groups) before counting a match as someone else's server. */
export function isAntigravityServerCommand(command: string, executable?: string): boolean {
  const args = command.toLowerCase();
  const exe = (executable ?? command.split(/\s+/)[0] ?? "").toLowerCase();
  const name = lastSegment(exe);
  if (/^(agy|antigravity-cli|antigravity_cli)(\.exe)?$/.test(name)) return true;
  if (isLanguageServerName(name)) return hasAntigravityPath(exe) || hasAntigravityAppData(args);
  return /(^|[/\\])(antigravity-cli|antigravity_cli)[/\\]/.test(exe);
}

export interface ServerDiscoveryOptions {
  /** Roots of process trees Headroom started itself (its keepalive, live engine groups); never counted. */
  ownedRoots?: number[];
  list?: () => Promise<ProcessCommand[]>;
}

/** Pids of Antigravity servers that are NOT Headroom's own. */
export async function externalAntigravityServerPids(options: ServerDiscoveryOptions = {}): Promise<number[]> {
  const processes = await (options.list ?? listCommands)();
  const entries: ProcessEntry[] = processes.map((row) => ({ pid: row.pid, ppid: row.ppid, rssKb: 0, command: row.command }));
  const owned = new Set<number>();
  for (const root of options.ownedRoots ?? []) {
    owned.add(root);
    for (const child of descendantsOf(root, entries)) owned.add(child.pid);
  }
  return processes
    .filter((row) => row.pid !== process.pid && !owned.has(row.pid) && isAntigravityServerCommand(row.command, row.executable))
    .map((row) => row.pid);
}
