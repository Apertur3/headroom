import { spawn } from "node:child_process";
import { ownProcessGroup, processSignature, processSignatureSync } from "../process-tree.js";

/**
 * Runs an engine child in its OWN process group, so a timeout, a daemon stop
 * or a daemon crash can signal the whole group -- the engine and anything it
 * spawned (agy, language_server) -- instead of only the engine pid. Node's
 * `execFile` timeout signals just the child, which is how a leaked agy tree
 * outlived a read. On win32 there are no process groups: the child is
 * signalled alone, as before.
 *
 * Identity. Headroom must never signal a process it did not start, so a group
 * is signalled only while it is provably ours:
 *
 * - While the leader has not been reaped (its ChildProcess has not emitted
 *   'exit'), its pid cannot be reused: an unreaped child keeps its pid. The
 *   `ps` command and start time recorded right after spawn are re-read
 *   immediately before every signal, with no await in between, as a second,
 *   independent check.
 * - The moment 'exit' fires the leader is dropped from tracking. Its group can
 *   outlive it (a grandchild), and while any member lives the kernel keeps the
 *   group id reserved, so no new process can take that pid. A live process
 *   holding the pid therefore proves the group is empty and the number was
 *   recycled: the group is then gone for Headroom and is never signalled.
 * - A group signal that fails with ESRCH means the group is gone. There is no
 *   fallback to the bare pid, ever; group ids <= 1 and this process's own
 *   group are never signalled.
 */

export const ENGINE_KILL_GRACE_MS = 2_000;
const KILL_CONFIRM_MS = 1_500;
/** Upper bound on terminateEngineGroups()'s re-sweeps. */
const SHUTDOWN_SWEEP_MS = ENGINE_KILL_GRACE_MS + KILL_CONFIRM_MS + 2_000;

interface ProcessSignatureValue { command: string; startedAt: string }

interface EngineGroup {
  pid: number;
  spawnedAtMs: number;
  /** `ps` command and start time, read right after spawn while the child was unreaped. */
  identity?: ProcessSignatureValue;
  identityRead: Promise<void>;
  /** Set synchronously in the child's 'exit' handler: the leader is reaped. */
  exited: boolean;
  /** The one termination in progress for this group, if any. */
  reaping?: Promise<ReapOutcome>;
}

type ReapOutcome = "gone" | "refused" | "survived";

/** Leaders not yet reaped. */
const liveGroups = new Map<number, EngineGroup>();
/** Reaped leaders whose group is still being swept. */
const drainingGroups = new Map<number, EngineGroup>();
let exitHookInstalled = false;
let startsRefused = false;
let signalCleanupEnabled = true;
let signalHandlersInstalled = false;
/** Engine spawns in progress (synchronous; see runInGroup). */
let spawning = 0;

interface GroupRunSeams {
  signal(target: number, signal: NodeJS.Signals | 0): void;
  lookup(pid: number): Promise<ProcessSignatureValue | undefined>;
  lookupSync(pid: number): ProcessSignatureValue | undefined;
  raise(signal: NodeJS.Signals): void;
}

const defaultSeams: GroupRunSeams = {
  signal: (target, signal) => { process.kill(target, signal); },
  // The default path: bounded `ps`, or /proc on Linux, the same source as lookupSync.
  lookup: (pid) => processSignature(pid),
  lookupSync: (pid) => processSignatureSync(pid),
  raise: (signal) => { process.kill(process.pid, signal); },
};
let seams: GroupRunSeams = defaultSeams;

/** Test seam: replace the process-table lookups (to simulate pid reuse) or the
 * re-raise of a caught signal. `undefined` restores the real ones. */
export function setGroupRunSeamsForTest(overrides: Partial<GroupRunSeams> | undefined): void {
  seams = { ...defaultSeams, ...overrides };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Same process: same exact start time. The command is recorded for reports
 * but not compared, because an engine that exec()s (a wrapper script) keeps
 * its pid and start time while its command changes, and refusing to signal
 * it would leave it behind; reuse is what the start time rules out. */
function sameIdentity(live: ProcessSignatureValue | undefined, recorded: ProcessSignatureValue): boolean {
  return live !== undefined && live.startedAt === recorded.startedAt;
}

function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

/** True while any process holds `pid` (EPERM counts: it exists, just not ours). */
function pidHeld(pid: number): boolean {
  try { seams.signal(pid, 0); return true; } catch (error) { return errno(error) !== "ESRCH"; }
}

/** Sends `signal` to group `pgid` only. Never the bare pid, never pgid <= 1,
 * never this process's own group or pid. */
function sendToGroup(pgid: number, signal: NodeJS.Signals | 0): "sent" | "gone" | "refused" {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === ownProcessGroup()) return "refused";
  try { seams.signal(-pgid, signal); return "sent"; }
  catch (error) { return errno(error) === "ESRCH" ? "gone" : "refused"; }
}

/** The leader is reaped: signal the leftover group only while no process
 * holds its id (see the file comment). */
function signalLeaderless(pgid: number, signal: NodeJS.Signals | 0): "sent" | "gone" | "refused" {
  if (pidHeld(pgid)) return "gone";
  return sendToGroup(pgid, signal);
}

/** Win32 has no groups: the unreaped child is signalled alone. */
function signalWin32(group: EngineGroup, signal: NodeJS.Signals): "sent" | "gone" {
  if (group.exited) return "gone";
  try { process.kill(group.pid, signal); return "sent"; } catch { return "gone"; }
}

/** One verified signal to `group`: identity is read, then -- with no await in
 * between -- the group is signalled or left alone. */
async function signalGroup(group: EngineGroup, signal: NodeJS.Signals): Promise<"sent" | "gone" | "refused"> {
  if (process.platform === "win32") return signalWin32(group, signal);
  if (group.exited) return signalLeaderless(group.pid, signal);
  await group.identityRead;
  const live = group.identity ? await seams.lookup(group.pid) : undefined;
  if (group.exited) return signalLeaderless(group.pid, signal);
  if (group.identity && !sameIdentity(live, group.identity)) return "refused";
  return sendToGroup(group.pid, signal);
}

/** Synchronous variant for exit and signal handlers. */
function signalGroupNow(group: EngineGroup, signal: NodeJS.Signals): void {
  if (process.platform === "win32") { signalWin32(group, signal); return; }
  if (group.exited) { signalLeaderless(group.pid, signal); return; }
  if (group.identity && !sameIdentity(seams.lookupSync(group.pid), group.identity)) return;
  if (group.exited) { signalLeaderless(group.pid, signal); return; }
  sendToGroup(group.pid, signal);
}

/** True once the group is gone for Headroom: the leader reaped and either no
 * member left, or its id taken by a stranger (so ours is certainly empty). */
function groupGone(group: EngineGroup): boolean {
  if (!group.exited) return false;
  if (process.platform === "win32") return true;
  return signalLeaderless(group.pid, 0) !== "sent";
}

async function waitGone(group: EngineGroup, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!groupGone(group)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/** SIGTERM the group, SIGKILL it once the grace period has passed, and wait
 * (bounded) until it is confirmed gone. Refuses, without signalling, a group
 * whose identity no longer matches. */
async function terminate(group: EngineGroup, graceMs: number): Promise<ReapOutcome> {
  if (groupGone(group)) return "gone";
  const first = await signalGroup(group, "SIGTERM");
  if (first === "refused") return "refused";
  if (await waitGone(group, graceMs)) return "gone";
  const second = await signalGroup(group, "SIGKILL");
  if (second === "refused") return "refused";
  return (await waitGone(group, KILL_CONFIRM_MS)) ? "gone" : "survived";
}

function reap(group: EngineGroup, graceMs: number): Promise<ReapOutcome> {
  if (group.reaping) return group.reaping;
  const reaping = terminate(group, graceMs).finally(() => {
    if (group.reaping === reaping) group.reaping = undefined;
    if (group.exited && groupGone(group)) { drainingGroups.delete(group.pid); syncSignalHandlers(); }
  });
  group.reaping = reaping;
  return reaping;
}

/** Number of engine process groups currently tracked (live or being swept). */
export function liveEngineGroupCount(): number { return liveGroups.size + drainingGroups.size; }

/** Leader pids of engine groups whose leader has not been reaped yet. */
export function liveEngineGroupPids(): number[] { return [...liveGroups.keys()]; }

/** Unreaped engine leaders with their age, for the age watchdog. */
export function liveEngineGroups(): Array<{ pid: number; ageMs: number; command?: string }> {
  const now = Date.now();
  return [...liveGroups.values()].map((group) => ({ pid: group.pid, ageMs: now - group.spawnedAtMs, command: group.identity?.command }));
}

/** Terminates one tracked engine group by leader pid. False when that pid is
 * not a tracked, unreaped engine leader (nothing is signalled then), or when
 * its identity no longer matched. */
export async function terminateEngineGroup(pid: number, graceMs = ENGINE_KILL_GRACE_MS): Promise<boolean> {
  const group = liveGroups.get(pid);
  if (!group) return false;
  return (await reap(group, graceMs)) === "gone";
}

/** Refuses every new engine start in this process (daemon shutdown). */
export function refuseEngineStarts(): void { startsRefused = true; }
/** Re-allows engine starts (a daemon starting in this process). */
export function allowEngineStarts(): void { startsRefused = false; }
export function engineStartsRefused(): boolean { return startsRefused; }
export const ENGINE_SHUTTING_DOWN = "native engine start refused: Headroom is shutting down";

/**
 * Graceful shutdown path: terminate every tracked engine group, then sweep
 * again until none is left, bounded. Call refuseEngineStarts() first so no
 * new group can appear behind the sweep; a round in which every remaining
 * group refused (identity mismatch) ends the loop, since nothing it could do
 * would change that.
 */
export async function terminateEngineGroups(graceMs = ENGINE_KILL_GRACE_MS): Promise<void> {
  const deadline = Date.now() + Math.max(SHUTDOWN_SWEEP_MS, graceMs + KILL_CONFIRM_MS + 2_000);
  while (Date.now() < deadline) {
    const groups = [...liveGroups.values(), ...drainingGroups.values()];
    if (!groups.length) return;
    const outcomes = await Promise.all(groups.map((group) => reap(group, graceMs)));
    if (outcomes.every((outcome) => outcome === "refused")) return;
    await sleep(10);
  }
}

/** Synchronous last resort, safe inside a process 'exit' or signal handler:
 * SIGKILL every tracked group that is still provably ours. */
export function killEngineGroupsNow(): void {
  for (const group of [...liveGroups.values(), ...drainingGroups.values()]) signalGroupNow(group, "SIGKILL");
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killEngineGroupsNow);
}

const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** A terminal Ctrl-C (or a SIGTERM/SIGHUP) ends a plain CLI read without
 * 'exit', and the engine's own group never sees the terminal's signal. Kill
 * the groups, restore the default disposition and re-raise, so the process
 * still exits by that signal exactly as it would have. A process that has
 * its own handler for the signal keeps its own semantics: the groups are
 * killed, and the signal is left to that handler (this one runs first, being
 * prepended, so a `once` handler of theirs is still registered here). */
function onCleanupSignal(signal: NodeJS.Signals): void {
  killEngineGroupsNow();
  removeSignalHandlers();
  if (process.listenerCount(signal) === 0) seams.raise(signal);
}

function removeSignalHandlers(): void {
  if (!signalHandlersInstalled) return;
  signalHandlersInstalled = false;
  for (const signal of CLEANUP_SIGNALS) process.removeListener(signal, onCleanupSignal);
}

function syncSignalHandlers(): void {
  const wanted = signalCleanupEnabled && process.platform !== "win32" && (liveEngineGroupCount() > 0 || spawning > 0);
  if (wanted && !signalHandlersInstalled) {
    signalHandlersInstalled = true;
    for (const signal of CLEANUP_SIGNALS) process.prependListener(signal, onCleanupSignal);
  } else if (!wanted) removeSignalHandlers();
}

/** The daemon owns its signals (graceful stop()); it turns this off. Every
 * other process gets the handlers only while an engine group is live. */
export function setEngineSignalCleanup(enabled: boolean): void {
  signalCleanupEnabled = enabled;
  syncSignalHandlers();
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
 * process group is gone before this settles, as far as it is provably ours. */
export function runInGroup(command: string, args: string[], options: GroupRunOptions): Promise<{ stdout: string; stderr: string }> {
  if (startsRefused) return Promise.reject(runError(ENGINE_SHUTTING_DOWN, "", ""));
  installExitHook();
  const graceMs = options.graceMs ?? ENGINE_KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = ""; let overflow = false; let timedOut = false; let settled = false;
    // The handlers go in BEFORE spawn: a signal that lands after the engine
    // exists but before it is tracked would otherwise take the default action
    // and leave the new group behind. A JS signal listener only runs between
    // ticks, so by the time it does, the group below is tracked.
    spawning += 1;
    syncSignalHandlers();
    let child;
    try { child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }); }
    catch (error) { spawning -= 1; syncSignalHandlers(); throw error; }
    spawning -= 1;
    const pid = child.pid;
    let group: EngineGroup | undefined;
    if (typeof pid === "number") {
      const tracked: EngineGroup = { pid, spawnedAtMs: Date.now(), exited: false, identityRead: Promise.resolve() };
      // Recorded only while the child is still unreaped, so it is the engine's own.
      tracked.identityRead = seams.lookup(pid).then((identity) => { if (!tracked.exited && identity) tracked.identity = identity; }, () => undefined);
      group = tracked;
      liveGroups.set(pid, tracked);
    }
    syncSignalHandlers();
    const finish = async (outcome: () => void): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The leader may have exited while its children did not: never leave
      // any member of the group behind, on success or failure.
      if (group) await reap(group, graceMs);
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
    child.once("exit", (code, signal) => {
      // Reaped: from here the pid may be recycled once the group empties.
      // Stop tracking the leader and sweep what is left of its group now.
      if (group) {
        group.exited = true;
        liveGroups.delete(group.pid);
        drainingGroups.set(group.pid, group);
        void reap(group, graceMs);
      }
      setTimeout(() => settle(code, signal), 250).unref();
    });
  });
}
