import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import { descendantsOf, listProcesses } from "../../src/process-tree.js";

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
 *    SIGKILLs every tracked pid, its process group and every descendant `ps`
 *    can still see, then waits until each tracked pid is gone.
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

const tracked = new Set<number>();

/** Register a pid this test started (or discovered) for the afterEach reaper. */
export function track(pid: number | undefined): number | undefined {
  if (typeof pid === "number" && pid > 1 && pid !== process.pid) tracked.add(pid);
  return pid;
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sigkill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  if (process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ } }
}

/** SIGKILL every tracked pid, its group and its live descendants, then wait
 * (bounded) until each tracked pid is gone. Descendants are collected before
 * any signal is sent, so a child reparented to init by its parent's death is
 * still reached. Returns the pids that were still alive when reaping began. */
export async function reapTracked(timeoutMs = 3_000): Promise<number[]> {
  const pids = [...tracked]; tracked.clear();
  if (!pids.length) return [];
  const snapshot = process.platform === "win32" ? [] : await listProcesses();
  const targets = new Set(pids);
  for (const pid of pids) for (const entry of descendantsOf(pid, snapshot)) targets.add(entry.pid);
  const survivors = [...targets].filter(alive);
  for (const pid of survivors) sigkill(pid);
  const deadline = Date.now() + timeoutMs;
  while (survivors.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return survivors;
}

/** Call once at the top of a test file that starts real processes. */
export function useProcessReaper(): void {
  afterEach(async () => { await reapTracked(); });
}
