import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Real-process test fixtures, built so a test can never leave one running.
 *
 * These tests reproduce issue #56 for real: a fake `agy` that ignores
 * SIGTERM/SIGHUP, started under `script` so it becomes its own PTY session
 * leader. Before this helper existed, afterEach only deleted the temp
 * directory; the shell kept running from its unlinked script, each one holding
 * a pseudo-terminal, and every `npm test` left about six of them behind until
 * a machine ran out of PTYs. Two independent defences now apply:
 *
 * 1. Mortal by construction: every shim exits on its own after
 *    `lifetimeSeconds`, whatever happens to the runner (crash, SIGKILL, a
 *    sandbox where `ps` and `kill` are denied).
 * 2. Reaped by the test: `useProcessReaper()` registers an afterEach that
 *    SIGKILLs every tracked pid, its process group and its descendants, after
 *    checking each one's live command line still names the fixture (so a
 *    recycled pid is never touched), then waits until they are gone.
 *
 * test/global-leak-gate.ts is the third, suite-level defence: it fails the
 * whole run if anything started under the run's temp directory survives it.
 */

export const SHIM_LIFETIME_SECONDS = 30;

/** A `#!/bin/sh` loop that records its pid, optionally ignores TERM/HUP, and
 * exits by itself after `lifetimeSeconds`. The deadline check is a builtin
 * comparison plus one `date` per second, so a shim costs nothing while alive. */
export async function writeMortalShim(path: string, options: { pidFile?: string; ignoreTerm?: boolean; lifetimeSeconds?: number } = {}): Promise<string> {
  const lifetime = options.lifetimeSeconds ?? SHIM_LIFETIME_SECONDS;
  await writeFile(path, [
    "#!/bin/sh",
    ...(options.ignoreTerm ? ["trap '' TERM HUP"] : []),
    ...(options.pidFile ? [`echo $$ > '${options.pidFile}'`] : []),
    `end=$(( $(date +%s) + ${lifetime} ))`,
    `while [ "$(date +%s)" -lt "$end" ]; do sleep 1; done`,
    "exit 0",
  ].join("\n") + "\n", { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

/** The fake agy of issue #56: ignores TERM and HUP, writes its pid, mortal. */
export function writeFakeAgy(root: string, pidFile: string): Promise<string> {
  return writeMortalShim(join(root, "agy"), { pidFile, ignoreTerm: true });
}

interface Tracked { pid: number; needle: string; at: number }
const tracked = new Map<number, Tracked>();

/** Register a process this test started (or discovered) for the afterEach
 * reaper. `needle` is a string its live command line must contain before the
 * reaper will signal it, normally the fixture's temp directory: a pid whose
 * command no longer matches has been recycled and is left alone. */
export function track(pid: number | undefined, needle: string): number | undefined {
  if (typeof pid === "number" && pid > 1 && pid !== process.pid) tracked.set(pid, { pid, needle, at: Date.now() });
  return pid;
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sigkill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  if (process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ } }
}

/** pid -> {ppid, full command line}, or undefined when `ps` is unavailable. */
function processTable(): Map<number, { ppid: number; command: string }> | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const stdout = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const table = new Map<number, { ppid: number; command: string }>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
    }
    return table;
  } catch { return undefined; }
}

/** Shims live SHIM_LIFETIME_SECONDS; a pid tracked more recently than this
 * cannot have exited naturally and been handed to a stranger yet. Only used
 * when `ps` is unavailable and identity cannot be checked directly. */
const UNVERIFIED_KILL_WINDOW_MS = (SHIM_LIFETIME_SECONDS - 5) * 1_000;

/**
 * SIGKILL every tracked process (and its group) plus every live descendant
 * whose command carries the same needle, then wait until they are gone.
 * With `ps`, a pid is signalled only while its command still contains its
 * needle. Without `ps` (a sandbox), a tracked pid is signalled only inside
 * UNVERIFIED_KILL_WINDOW_MS; anything older is left to its own lifetime.
 * Throws if a verified fixture is still alive afterwards.
 */
export async function reapTracked(timeoutMs = 3_000): Promise<void> {
  const entries = [...tracked.values()]; tracked.clear();
  if (!entries.length) return;
  const table = processTable();
  const targets = new Map<number, string>();
  if (table) {
    const children = new Map<number, number[]>();
    for (const [pid, row] of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), pid]);
    for (const entry of entries) {
      const queue = [entry.pid];
      while (queue.length) {
        const pid = queue.shift() as number;
        const row = table.get(pid);
        if (row && row.command.includes(entry.needle) && !targets.has(pid)) targets.set(pid, entry.needle);
        queue.push(...(children.get(pid) ?? []));
      }
    }
  } else {
    for (const entry of entries) if (Date.now() - entry.at < UNVERIFIED_KILL_WINDOW_MS) targets.set(entry.pid, entry.needle);
  }
  const live = [...targets.keys()].filter(alive);
  for (const pid of live) sigkill(pid);
  const deadline = Date.now() + timeoutMs;
  while (live.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const survivors = live.filter(alive);
  if (survivors.length && table) throw new Error(`test fixtures still alive after SIGKILL: ${survivors.join(", ")}`);
}

/** Call once at the top of a test file that starts real processes. */
export function useProcessReaper(): void {
  afterEach(async () => { await reapTracked(); });
}
