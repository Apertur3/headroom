import { spawn } from "node:child_process";
import { isProcessGroupAlive } from "../process-tree.js";

/**
 * Runs an engine child in its OWN process group, so a timeout, a daemon stop
 * or a daemon crash can signal the whole group -- the engine and anything it
 * spawned (agy, language_server) -- instead of only the engine pid. Node's
 * `execFile` timeout signals just the child, which is how a leaked agy tree
 * outlived a read. On win32 there are no process groups: the child is
 * signalled alone, as before.
 */

export const ENGINE_KILL_GRACE_MS = 2_000;
const KILL_CONFIRM_MS = 1_500;

const liveGroups = new Set<number>();
let exitHookInstalled = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") { try { process.kill(pid, signal); } catch { /* gone */ } return; }
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
  try { process.kill(pid, signal); } catch { /* pid already gone */ }
}

function groupAlive(pid: number): boolean {
  if (process.platform === "win32") { try { process.kill(pid, 0); return true; } catch { return false; } }
  return isProcessGroupAlive(pid);
}

async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/** SIGTERM the whole group, then SIGKILL it once the grace period has passed,
 * and wait (bounded) until the kernel confirms the group is empty. */
export async function terminateGroup(pid: number, graceMs = ENGINE_KILL_GRACE_MS): Promise<void> {
  if (!groupAlive(pid)) return;
  signalGroup(pid, "SIGTERM");
  if (await waitGone(pid, graceMs)) return;
  signalGroup(pid, "SIGKILL");
  await waitGone(pid, KILL_CONFIRM_MS);
}

/** Number of engine process groups currently tracked as live. */
export function liveEngineGroupCount(): number { return liveGroups.size; }

/** Leader pids of the engine process groups currently tracked as live. */
export function liveEngineGroupPids(): number[] { return [...liveGroups]; }

/** Graceful shutdown path: terminate every live engine group. */
export async function terminateEngineGroups(graceMs = ENGINE_KILL_GRACE_MS): Promise<void> {
  await Promise.all([...liveGroups].map((pid) => terminateGroup(pid, graceMs)));
}

/** Synchronous last resort, safe inside a process 'exit' handler. */
export function killEngineGroupsNow(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killEngineGroupsNow);
}

export interface GroupRunOptions {
  timeoutMs: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  graceMs?: number;
}

export interface GroupRunError extends Error {
  stdout: string;
  stderr: string;
  killed: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

function runError(message: string, stdout: string, stderr: string, extra: Partial<GroupRunError> = {}): GroupRunError {
  return Object.assign(new Error(message), { stdout, stderr, killed: false }, extra) as GroupRunError;
}

/** execFile-shaped: resolves with stdout/stderr on a zero exit, rejects with an
 * error carrying stdout/stderr otherwise. Whatever happens, the child's whole
 * process group is gone before this settles. */
export function runInGroup(command: string, args: string[], options: GroupRunOptions): Promise<{ stdout: string; stderr: string }> {
  installExitHook();
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = ""; let overflow = false; let timedOut = false; let settled = false;
    const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const pid = child.pid;
    if (typeof pid === "number") liveGroups.add(pid);
    const finish = async (outcome: () => void): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof pid === "number") {
        // The leader may have exited while its children did not: never leave
        // any member of the group behind, on success or failure.
        await terminateGroup(pid, options.graceMs ?? ENGINE_KILL_GRACE_MS);
        liveGroups.delete(pid);
      }
      outcome();
    };
    const take = (which: "out" | "err") => (chunk: Buffer): void => {
      if (settled) return;
      if (which === "out") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > options.maxBuffer && !overflow) { overflow = true; void finish(() => reject(runError("engine output exceeded maxBuffer", stdout, stderr, { killed: true }))); }
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    const timer = setTimeout(() => {
      timedOut = true;
      void finish(() => reject(runError(`engine timed out after ${options.timeoutMs}ms`, stdout, stderr, { killed: true, signal: "SIGTERM" })));
    }, options.timeoutMs);
    child.once("error", (error) => { void finish(() => reject(runError(error.message, stdout, stderr))); });
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      void finish(() => {
        if (timedOut) return;
        if (code === 0) resolve({ stdout, stderr });
        else reject(runError(`engine exited with ${signal ?? `code ${code}`}`, stdout, stderr, { code, signal }));
      });
    };
    // 'close' means the pipes are drained. A grandchild holding them open
    // would delay it forever, so 'exit' arms a short fallback instead.
    child.once("close", settle);
    child.once("exit", (code, signal) => { setTimeout(() => settle(code, signal), 250).unref(); });
  });
}
