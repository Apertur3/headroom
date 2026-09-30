import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type ExecFile = typeof execFileAsync;

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Resident set size in kilobytes, as `ps` reports it. */
  rssKb: number;
  /** The executable's command name/path only -- never the full argv, which
   * on some platforms could otherwise leak into a log line. */
  command: string;
}

/**
 * Parses `ps -Ao pid=,ppid=,rss=,comm=` output, accepted by both BSD `ps`
 * (macOS) and procps `ps` (Linux), so one command line works on every POSIX
 * platform Headroom runs on. `comm` is last precisely because it is the
 * only field that can itself contain spaces (a binary path with a space in
 * it, as one of this file's own tests uses) -- the three fixed numeric
 * columns ahead of it are what make splitting the rest of the line as
 * "everything after the third number" unambiguous.
 *
 * Pure text parsing, deliberately platform-independent: it is exercised
 * directly (with fabricated `ps`-shaped input) even on a win32 test runner,
 * where nothing here ever actually shells out. Only listProcesses() itself
 * decides whether to invoke a real `ps`.
 */
export function parsePsOutput(stdout: string): ProcessEntry[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] }];
  });
}

/**
 * List every process this user can see, with pid/parent/memory/command, by
 * shelling out to `ps` and handing its output to parsePsOutput() above.
 *
 * The real `ps` invocation is skipped on win32 (there is no `script`/agy
 * PTY tree to walk there, and Windows `tasklist`'s output shape is
 * different enough not to bother unifying with this parser for a feature
 * that never runs on that platform) -- but only when the caller is relying
 * on the default, real `execFileAsync`. A caller that passes its own
 * `execImpl` (this file's own tests, on any platform including a win32 CI
 * runner) always gets a real call through to it and a real parse of
 * whatever it returns, so the platform-independent parsing logic above is
 * actually verified everywhere, not skipped on Windows along with the
 * `ps` call it has nothing to do with.
 */
export async function listProcesses(execImpl?: ExecFile): Promise<ProcessEntry[]> {
  if (process.platform === "win32" && !execImpl) return [];
  const runner = execImpl ?? execFileAsync;
  try {
    // A short timeout, not just a maxBuffer cap: this call also backs
    // host-health.ts's host-pressure probe, which must never block a `run`
    // dispatch decision on a hung or wedged `ps` -- an overloaded host is
    // exactly the condition most likely to make one hang.
    const { stdout } = await runner("ps", ["-Ao", "pid=,ppid=,rss=,comm="], { maxBuffer: 8 * 1024 * 1024, timeout: 2000, killSignal: "SIGKILL" });
    return parsePsOutput(stdout);
  } catch {
    // ps missing, refused (e.g. a locked-down sandbox), or timed out:
    // callers treat an empty list the same as "no descendants found", never
    // as a signal to give up entirely -- killTree still signals the root pid
    // it was given.
    return [];
  }
}

/** Matches the command name (comm, no path/args) of a leaked keepalive
 * process: the `agy` binary Antigravity's CLI ultimately execs. A live one
 * is always still parented by the `script` PTY wrapper (or an interactive
 * shell); once ppid is 1, its PTY owner is gone -- the leak shape of issue
 * #56. A bare `script` is deliberately not matched: a user's own `script`
 * session is legitimate and must never read as a leak. Shared by doctor.ts's antigravityOrphanCheck and
 * host-health.ts's host-pressure probe so both count exactly the same leak
 * instead of maintaining two patterns that could drift apart. */
export function isOrphanedAgentProcess(entry: ProcessEntry): boolean {
  return entry.ppid === 1 && /(^|[\\/])agy(\.exe)?$/.test(entry.command);
}

/** Every transitive child of `rootPid` (rootPid itself is not included),
 * found by walking the live ppid graph rather than assumed from process
 * group membership -- a PTY session leader (see antigravity-keepalive.ts)
 * commonly ends up in its OWN new session and process group, so parentage
 * is the only relationship guaranteed to still connect it to `rootPid`. */
export function descendantsOf(rootPid: number, processes: ProcessEntry[]): ProcessEntry[] {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    const siblings = byParent.get(entry.ppid);
    if (siblings) siblings.push(entry); else byParent.set(entry.ppid, [entry]);
  }
  const result: ProcessEntry[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const pid = queue.shift() as number;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue; // a stray ppid==pid cycle can't happen from a live kernel, but never loop on one
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* already exited, or never ours to signal */ }
}

/** ps-free liveness probe for a process GROUP (not just the bare pid): true
 * iff a signal-0 send to `-pid` succeeds, fails with EPERM (exists, just not
 * ours to signal -- still alive), or fails with anything else that is NOT
 * ESRCH; false ONLY on ESRCH (kernel-confirmed: no such process group).
 * Fails closed on purpose -- every caller treats `true` as "leave it alone"
 * and `false` as "confirmed gone, safe to act" (reap, restart, clear
 * evidence), so an unexpected errno (EINVAL, a sandboxed/virtualized kill(2)
 * behaving unusually, anything not in POSIX's documented set for kill(2))
 * must never be read as proof of death -- only ESRCH is that proof. Uses no
 * `ps` at all, so it is the one identity signal that still works when `ps`
 * is denied or absent. Checking the GROUP specifically (not the bare pid) is
 * deliberately more specific than a plain liveness check: a pid the OS
 * recycled to an ordinary, non-leader process would essentially never also
 * happen to be a session/group leader of that exact id, whereas an agy
 * process (see antigravity-keepalive.ts) always is one. It is still not a
 * full identity proof -- see sweepPreviousKeepalive()'s use of it alongside
 * a launch-time/mtime cross-check for what that combination does and does
 * not verify. */
export function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** SIGKILL a pid and, on POSIX, the process group it may lead (a PTY session
 * leader like agy always is one -- see antigravity-keepalive.ts). Uses no
 * `ps` or process listing at all, unlike killTree()'s SIGKILL escalation
 * (which re-lists via `ps` to decide who survived a SIGTERM and, if `ps`
 * cannot answer, silently skips escalating at all): this is the one kill
 * primitive that still reliably reaps a SIGTERM-ignoring process when `ps` is
 * denied or unavailable. Errors mean the target is already gone. */
export function killProcessGroup(pid: number, options: { groupOnly?: boolean } = {}): void {
  for (const target of options.groupOnly ? [-pid] : [-pid, pid]) { try { process.kill(target, "SIGKILL"); } catch { /* already gone */ } }
}

/** Signal both `pid` itself and, on POSIX, the process group it may be the
 * leader of (negative pid). A pid that never became its own group leader
 * (the common case for an ordinary child) just makes the group signal a
 * harmless no-op (ESRCH, swallowed); a pid that DID become one -- exactly
 * what a PTY session leader like agy does -- is the case this exists for. */
function trySignalGroupAndSelf(pid: number, signal: NodeJS.Signals): void {
  trySignal(pid, signal);
  if (process.platform !== "win32") trySignal(-pid, signal);
}

export interface KillTreeOptions {
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  graceMs?: number;
  listProcesses?: () => Promise<ProcessEntry[]>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Terminate `rootPid` and everything descended from it, however many
 * process groups or sessions the tree has split into. Walks the live
 * process tree *before* signalling (so what actually gets killed is proven
 * against a real snapshot, not assumed from how the tree was spawned),
 * SIGTERMs every pid found (root plus descendants) and each one's own
 * process group, waits a short grace period, then re-checks and SIGKILLs
 * whatever is still alive.
 *
 * On win32 this only ever signals `rootPid` itself: Windows has no `script`
 * and no POSIX process groups, so there is no PTY tree to walk and a
 * negative-pid group signal is not a valid concept there.
 */
export async function killTree(rootPid: number, options: KillTreeOptions = {}): Promise<void> {
  if (process.platform === "win32") { trySignal(rootPid, "SIGTERM"); return; }
  const list = options.listProcesses ?? (() => listProcesses());
  const sleep = options.sleep ?? defaultSleep;
  const grace = options.graceMs ?? 300;
  const before = await list();
  const targets = [rootPid, ...descendantsOf(rootPid, before).map((entry) => entry.pid)];
  for (const pid of targets) trySignalGroupAndSelf(pid, "SIGTERM");
  await sleep(grace);
  const after = await list();
  const stillAlive = new Set(after.map((entry) => entry.pid));
  for (const pid of targets) if (stillAlive.has(pid)) trySignalGroupAndSelf(pid, "SIGKILL");
}

/** A stable identity for one running process: its command (no args) and its
 * exact start timestamp, both read fresh from `ps`. Two separate `ps`
 * invocations rather than one combined `-o comm=,lstart=` line: `lstart`'s
 * own format ("Wed Sep 23 11:48:12 2026") and a command path can each
 * contain spaces, so nothing about a single combined line can tell where
 * one field ends and the other begins once both are unpredictable-width.
 * Used to prove pid reuse hasn't happened before ever killing a pid found
 * only in a state file left by an earlier daemon run (see
 * antigravity-keepalive.ts's sweepPreviousKeepalive) -- a live process whose
 * command or start time no longer matches what was recorded is never
 * touched, whatever else is running under that pid now. */
export async function processSignature(pid: number, execImpl: ExecFile = execFileAsync): Promise<{ command: string; startedAt: string } | undefined> {
  const field = async (keyword: "comm" | "lstart"): Promise<string | undefined> => {
    try {
      const { stdout } = await execImpl("ps", ["-o", `${keyword}=`, "-p", String(pid)]);
      const value = stdout.split("\n")[0]?.trim();
      return value ? value : undefined;
    } catch { return undefined; }
  };
  const [command, startedAt] = await Promise.all([field("comm"), field("lstart")]);
  return command && startedAt ? { command, startedAt } : undefined;
}

/** How long one process has been running, in whole seconds, from `ps`'s
 * `etime` (`[[dd-]hh:]mm:ss`, the same on BSD and procps). Unlike `lstart`,
 * this is measured on one clock: procps derives `lstart` from the boot time,
 * kept in whole seconds, so it can read up to a second early against the
 * wall clock. Undefined when the process is gone or `ps` cannot be run. */
export async function processElapsedSeconds(pid: number, execImpl: ExecFile = execFileAsync): Promise<number | undefined> {
  let raw: string | undefined;
  try { raw = (await execImpl("ps", ["-o", "etime=", "-p", String(pid)])).stdout.split("\n")[0]?.trim(); }
  catch { return undefined; }
  const match = raw?.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** One process's full argument line from `ps`, never truncated to a
 * terminal width (`-ww`, accepted by both BSD and procps ps). Undefined when
 * the process is gone or `ps` cannot be run. */
export async function processArgs(pid: number, execImpl: ExecFile = execFileAsync): Promise<string | undefined> {
  try {
    const { stdout } = await execImpl("ps", ["-ww", "-o", "args=", "-p", String(pid)]);
    const value = stdout.split("\n")[0]?.trim();
    return value ? value : undefined;
  } catch { return undefined; }
}

/** A process's signature (see processSignature) plus its parent and process
 * group, all read fresh from `ps`. Undefined when the process is gone or `ps`
 * cannot answer. */
export interface LiveIdentity { command: string; startedAt: string; ppid: number; pgid: number }

export async function processIdentity(pid: number, execImpl: ExecFile = execFileAsync): Promise<LiveIdentity | undefined> {
  const ids = async (): Promise<{ ppid: number; pgid: number } | undefined> => {
    try {
      const { stdout } = await execImpl("ps", ["-o", "ppid=,pgid=", "-p", String(pid)]);
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout.split("\n")[0] ?? "");
      return match ? { ppid: Number(match[1]), pgid: Number(match[2]) } : undefined;
    } catch { return undefined; }
  };
  const [signature, groupIds] = await Promise.all([processSignature(pid, execImpl), ids()]);
  return signature && groupIds ? { ...signature, ...groupIds } : undefined;
}

/** processSignature for synchronous contexts (a process 'exit' handler, or a
 * signal handler about to re-raise), each `ps` bounded by a short timeout. */
export function processSignatureSync(pid: number): { command: string; startedAt: string } | undefined {
  const field = (keyword: "comm" | "lstart"): string | undefined => {
    try {
      const stdout = execFileSync("ps", ["-o", `${keyword}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
      const value = stdout.split("\n")[0]?.trim();
      return value ? value : undefined;
    } catch { return undefined; }
  };
  const command = field("comm");
  const startedAt = command ? field("lstart") : undefined;
  return command && startedAt ? { command, startedAt } : undefined;
}

let ownGroupCache: { value: number | undefined } | undefined;
/** This process's own process group id, read once. Undefined on win32 or
 * when `ps` cannot tell. Group signals are never sent to it. */
export function ownProcessGroup(): number | undefined {
  if (ownGroupCache) return ownGroupCache.value;
  let value: number | undefined;
  if (process.platform !== "win32") {
    try {
      const stdout = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
      const parsed = Number(stdout.trim());
      value = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    } catch { value = undefined; }
  }
  ownGroupCache = { value };
  return value;
}

/** A process identified by what `ps` reported for it at a time it was
 * provably Headroom's: pid, command, and exact start time. */
export interface VerifiedProcess { pid: number; command: string; startedAt: string }

export interface VerifiedKillOptions {
  execImpl?: ExecFile;
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
  /** How long to wait for the kernel to confirm the SIGKILLs. */
  confirmMs?: number;
  /** Test seam; process.kill by default. */
  signal?: (target: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type VerifiedKillResult = "killed" | "not-ours" | "survived";

function sameProcess(live: { command: string; startedAt: string } | undefined, recorded: VerifiedProcess): boolean {
  return live !== undefined && live.command === recorded.command && live.startedAt === recorded.startedAt;
}

/** Re-reads `target`'s identity and, with no await between that read and the
 * signal, sends `signal` to its process group when it leads one (never a
 * group id <= 1 or this process's own group) or else to the pid alone. A pid
 * whose command or start time changed belongs to someone else now and is
 * never signalled. */
async function signalVerified(target: VerifiedProcess, signal: NodeJS.Signals, options: VerifiedKillOptions): Promise<void> {
  const live = await processIdentity(target.pid, options.execImpl);
  if (!live || !sameProcess(live, target) || target.pid <= 1 || target.pid === process.pid) return;
  const own = ownProcessGroup();
  const asGroup = live.pgid === target.pid && live.pgid > 1 && live.pgid !== own;
  const send = options.signal ?? ((pid: number, sig: NodeJS.Signals): void => { process.kill(pid, sig); });
  try { send(asGroup ? -target.pid : target.pid, signal); }
  catch { /* ESRCH: exited since the read; EPERM: not ours to signal */ }
}

/** The verified root plus every descendant proven to be one: a child counts
 * only when `ps` reports its ppid as a tree member whose own identity still
 * matches AFTER the child was read, so that parent was the same process for
 * the whole interval. */
async function collectVerifiedTree(root: VerifiedProcess, options: VerifiedKillOptions): Promise<VerifiedProcess[] | undefined> {
  if (!sameProcess(await processSignature(root.pid, options.execImpl), root)) return undefined;
  const snapshot = await listProcesses(options.execImpl);
  const tree: VerifiedProcess[] = [root];
  const queue: VerifiedProcess[] = [root];
  while (queue.length) {
    const parent = queue.shift() as VerifiedProcess;
    for (const entry of snapshot) {
      if (entry.ppid !== parent.pid || tree.some((member) => member.pid === entry.pid)) continue;
      const live = await processIdentity(entry.pid, options.execImpl);
      if (!live || live.ppid !== parent.pid) continue;
      if (!sameProcess(await processSignature(parent.pid, options.execImpl), parent)) continue;
      const child = { pid: entry.pid, command: live.command, startedAt: live.startedAt };
      tree.push(child); queue.push(child);
    }
  }
  return tree;
}

/**
 * Terminates a process Headroom recorded, and its descendants, without ever
 * signalling a pid the kernel has since handed to someone else. Unlike
 * killTree(), whose SIGKILL escalation re-signals bare pids after a sleep,
 * every individual signal here follows a fresh identity read (command and
 * exact start time) with no await in between. SIGTERM first, SIGKILL after
 * `graceMs` to whatever still matches, then a bounded wait for the kernel to
 * confirm. "not-ours" means the root no longer matches its record (already
 * gone, or recycled) and nothing was signalled.
 */
export async function killVerifiedTree(root: VerifiedProcess, options: VerifiedKillOptions = {}): Promise<VerifiedKillResult> {
  if (process.platform === "win32") return "not-ours";
  const tree = await collectVerifiedTree(root, options);
  if (!tree) return "not-ours";
  const sleep = options.sleep ?? defaultSleep;
  const stillOurs = async (): Promise<VerifiedProcess[]> => {
    const found: VerifiedProcess[] = [];
    for (const member of tree) if (sameProcess(await processSignature(member.pid, options.execImpl), member)) found.push(member);
    return found;
  };
  const waitGone = async (ms: number): Promise<VerifiedProcess[]> => {
    const deadline = Date.now() + ms;
    let remaining = await stillOurs();
    while (remaining.length && Date.now() < deadline) { await sleep(50); remaining = await stillOurs(); }
    return remaining;
  };
  for (const member of tree) await signalVerified(member, "SIGTERM", options);
  const survivors = await waitGone(options.graceMs ?? 300);
  if (!survivors.length) return "killed";
  for (const member of survivors) await signalVerified(member, "SIGKILL", options);
  return (await waitGone(options.confirmMs ?? 1_500)).length ? "survived" : "killed";
}
