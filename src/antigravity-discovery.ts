import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { descendantsOf, type ProcessEntry } from "./process-tree.js";

const execFileAsync = promisify(execFile);

/**
 * Finds an Antigravity language server that is already running, so Headroom
 * does not start a second agy next to it. The command-line rules mirror the
 * native probe's own discovery (CodexBarCore's AntigravityStatusProbe:
 * language_server + antigravity for the app and IDE, and the agy /
 * antigravity-cli binary for the CLI), so the keepalive and the probe agree on
 * what "a server is reachable" means. Classification is read-only: nothing
 * found here is ever signalled.
 */

export interface ProcessCommand { pid: number; ppid: number; command: string }

export function parsePsCommands(stdout: string): ProcessCommand[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

async function listCommands(): Promise<ProcessCommand[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-wwAo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024, timeout: 2_000, killSignal: "SIGKILL" });
    return parsePsCommands(stdout);
  } catch { return []; }
}

function isLanguageServer(lower: string): boolean {
  return /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/.test(lower);
}

function isAntigravityCommand(lower: string): boolean {
  return (lower.includes("--app_data_dir") && lower.includes("antigravity"))
    || lower.includes("antigravity.app/") || lower.includes("antigravity.app\\")
    || lower.includes("/gemini.app/") || lower.includes("\\gemini.app\\")
    || lower.includes("antigravity ide.app/") || lower.includes("antigravity ide.app\\")
    || lower.includes("/antigravity/") || lower.includes("\\antigravity\\");
}

function isAntigravityCli(lower: string): boolean {
  return /(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)/.test(lower) || /(^|[/\\])agy(\s|$)/.test(lower);
}

/** True for the command line of an Antigravity app/IDE language server or the
 * agy CLI itself. Callers exclude Headroom's own trees (its keepalive and
 * engine groups) before counting a match as someone else's server. */
export function isAntigravityServerCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return (isLanguageServer(lower) && isAntigravityCommand(lower)) || isAntigravityCli(lower);
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
    .filter((row) => row.pid !== process.pid && !owned.has(row.pid) && isAntigravityServerCommand(row.command))
    .map((row) => row.pid);
}
