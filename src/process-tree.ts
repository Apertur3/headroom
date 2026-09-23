import { execFile } from "node:child_process";
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
    const { stdout } = await runner("ps", ["-Ao", "pid=,ppid=,rss=,comm="], { maxBuffer: 8 * 1024 * 1024 });
    return parsePsOutput(stdout);
  } catch {
    // ps missing, or refused (e.g. a locked-down sandbox): callers treat an
    // empty list the same as "no descendants found", never as a signal to
    // give up entirely -- killTree still signals the root pid it was given.
    return [];
  }
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
