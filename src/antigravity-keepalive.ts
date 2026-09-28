import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, open, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { homedir, uptime } from "node:os";
import { join } from "node:path";
import { descendantsOf, isProcessGroupAlive, killProcessGroup, killTree, listProcesses, processArgs, processElapsedSeconds, processSignature, type ExecFile } from "./process-tree.js";

type Spawn = (command: string, args: string[], options: { stdio: "ignore"; env: NodeJS.ProcessEnv; detached?: boolean }) => ChildProcess;

export type AgyLoginState = "unknown" | "logged_in" | "not_logged_in";

/** bytes read from the tail of agy's newest log per sample --
 * enough to catch the auth-state markers even past rotation noise, small
 * enough that a growing (or adversarial) log can never make this unbounded. */
const LOG_TAIL_BYTES = 64 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Regular files only (lstat, never followed through a symlink), and never
 * more than LOG_TAIL_BYTES read regardless of how large the log has grown. */
async function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("not a regular file");
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

export interface AgyKeepaliveOptions {
  binary?: string;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  restartDelay?: (attempt: number) => number;
  logDirectory?: string;
  logPollIntervalMs?: number;
  logWatchMs?: number;
  /** Headroom's own state directory. When set (production always sets it),
   * launch() creates a private directory beneath it and records the owned
   * pids there so a *future* daemon start can find and reap them if this one
   * never gets to call stop() (crash, SIGKILL, forced service restart). */
  home?: string;
  /** How long stop() waits after SIGTERM before escalating to SIGKILL. */
  killGraceMs?: number;
  /** How many times launch() polls for agy's pid (script's child) before
   * giving up and recording script's pid alone. */
  pidDiscoveryAttempts?: number;
  pidDiscoveryIntervalMs?: number;
}

export interface KeepaliveState {
  scriptPid: number;
  /** "" until a `ps` call has confirmed it (see `verified`); never absent, so
   * the on-disk shape stays uniform whether or not `ps` ever answered. */
  scriptCommand: string;
  scriptStartedAt: string;
  agyPid?: number;
  agyCommand?: string;
  agyStartedAt?: string;
  /** ISO timestamp of Date.now() at spawn, known the instant the ChildProcess
   * exists -- no `ps` call needed. This is the only start-time evidence a
   * later sweep has for the pid named by the launch wrapper's `agy.pid` file
   * when `ps` was never reachable in between (see sweepPreviousKeepalive). */
  launchedAt?: string;
  recordedAt: string;
  /** True once `ps` has confirmed scriptCommand/scriptStartedAt live, at
   * record time. False for the provisional record recordProvisionalState()
   * writes synchronously at spawn, before any `ps` call has had a chance to
   * run or answer. */
  verified: boolean;
  /** The UUID naming this launch's private evidence directory. Optional only
   * for compatibility with evidence written before launch directories. */
  launchId?: string;
}

/** The pre-directory-layout paths are deliberately retained only for startup
 * migration. New launches never write either path. */
export function keepaliveStateFilePath(home: string): string { return join(home, "antigravity-keepalive-state.json"); }
function legacyAgyPidFilePath(home: string): string { return `${keepaliveStateFilePath(home)}.agy-pid`; }

export function keepaliveDirectoryPath(home: string): string { return join(home, "keepalive"); }
export function keepaliveLaunchDirectoryPath(home: string, launchId: string): string { return join(keepaliveDirectoryPath(home), launchId); }
export function keepaliveLaunchStateFilePath(home: string, launchId: string): string { return join(keepaliveLaunchDirectoryPath(home, launchId), "state.json"); }
export function keepaliveLaunchAgyPidFilePath(home: string, launchId: string): string { return join(keepaliveLaunchDirectoryPath(home, launchId), "agy.pid"); }
function launchStateFilePath(directory: string): string { return join(directory, "state.json"); }
function launchAgyPidFilePath(directory: string): string { return join(directory, "agy.pid"); }

/** Synchronous, deliberately: recordState() checks its launch generation is
 * still current and calls this in the same synchronous step, with nothing
 * else able to run in between (single-threaded JS) -- an async write here
 * would reopen exactly the race it exists to close (see recordState's own
 * comment: an older launch's write landing, via the fs layer's own timing,
 * after a newer launch's synchronous provisional record). */
function writeKeepaliveStateSync(path: string, state: KeepaliveState): void {
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

/** Thrown by readKeepaliveState()/readAgyPidFile() when evidence PRESENT on
 * disk cannot be trusted -- a symlink, a non-regular file, unreadable
 * (permissions), or content that does not parse into the shape this module
 * itself ever writes. Deliberately distinct from "genuinely absent"
 * (ENOENT, the normal case: nothing here, safe to proceed): silently
 * treating the two the same way -- as sweepPreviousKeepalive() and
 * readAgyPidFile() both used to -- reports a clean sweep and lets the
 * daemon launch a fresh keepalive even though this file might be exactly
 * what a live orphan's identity was recorded in, just unreadable right now.
 * Left uncaught by sweepPreviousKeepalive() on purpose, so it propagates to
 * the daemon's own sweepStaleKeepalive() catch -- the same "a failed sweep
 * blocks this cycle's launch and gets retried" handling a thrown kill
 * already relies on. */
export class InvalidKeepaliveEvidenceError extends Error {}

/** A conservative but generous upper bound: Linux's own documented absolute
 * pid_max ceiling (64-bit kernels) is 4,194,304; every other POSIX platform
 * Headroom targets (macOS, *BSD) uses a far smaller range. Anything above
 * this, whatever wrote it, was never a real pid. */
const MAX_PID = 4_194_304;

/** True only for a plain, positive, in-range integer -- never NaN (whose
 * `typeof` is deceptively "number"), a float, zero, negative, 1 (reserved on
 * every POSIX platform), or a value no real process could ever have. Used
 * everywhere a pid is read back from disk, so a corrupt or out-of-range
 * value is rejected the same rigorous way regardless of which reader saw it
 * first. */
function isPlausiblePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 1 && value <= MAX_PID;
}

/** The state writer uses Date#toISOString(), but accept any complete,
 * timezone-qualified ISO 8601 instant that Date can parse. Never let a
 * locale-dependent Date.parse() success turn arbitrary text into evidence. */
const ISO_8601_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function isIso8601Instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_8601_INSTANT.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  // Date.parse normalizes impossible calendar values (for example February
  // 31) instead of rejecting them. Round-trip the wall-clock date through
  // UTC before accepting it as durable identity evidence.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
}

/** launchId comes from randomUUID(); accept only a canonical RFC UUID, not
 * an arbitrary string that could make unrelated evidence look owned. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

/** Strict canonical-decimal-integer parse of a pid FILE's raw text content
 * (never used for a JSON state field, which is already a native, unambiguous
 * JS number once parsed): only plain digits, plus the one trailing newline
 * the launch wrapper's `echo $$` may write. No sign, decimal point, exponent,
 * leading zero (other than a bare "0", itself never a plausible pid), or
 * whitespace is accepted. `Number(raw)` alone accepts far more than the
 * launch wrapper could ever produce -- `Number("2e3")` is 2000,
 * `Number(" 123")` is 123 -- and none of that leniency is safe to extend to
 * evidence a kill decision may act on: a string this loose was either never
 * actually written by this file's own wrapper, or has been corrupted since,
 * and either way must be rejected as invalid, not silently reinterpreted.
 * Combined with isPlausiblePid for the numeric range check both pid readers
 * apply on top of this. */
function parseCanonicalPid(raw: string): number | undefined {
  const digits = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!digits || [...digits].some((character) => character < "0" || character > "9")) return undefined;
  return digits === "0" || !digits.startsWith("0") ? Number(digits) : undefined;
}

/** Never trusts the file blindly: it must be one exact evidence variant.
 * Legacy records predate launch directories. Current provisional records
 * have no ps signatures at all; current verified records have complete,
 * non-empty signatures. This prevents a malformed mixture from being
 * mistaken for the harmless provisional form. */
async function readKeepaliveState(path: string): Promise<KeepaliveState | undefined> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new InvalidKeepaliveEvidenceError(`cannot stat keepalive state ${path}: ${(error as Error).message}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} is not a plain regular file`);
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new InvalidKeepaliveEvidenceError(`cannot read keepalive state ${path}: ${(error as Error).message}`); }
  let parsed: Partial<KeepaliveState>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Partial<KeepaliveState>;
  }
  catch (error) { throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} is not valid JSON: ${(error as Error).message}`); }
  if (!isPlausiblePid(parsed.scriptPid) || typeof parsed.scriptCommand !== "string" || typeof parsed.scriptStartedAt !== "string" || !isIso8601Instant(parsed.recordedAt)) {
    throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} does not match the recorded shape`);
  }
  const has = (field: keyof KeepaliveState): boolean => Object.hasOwn(parsed, field);
  const hasLaunchId = has("launchId");
  const hasLaunchedAt = has("launchedAt");
  const hasVerified = has("verified");
  const current = hasLaunchId || hasLaunchedAt || hasVerified;
  if (current && (!hasLaunchId || !hasLaunchedAt || !hasVerified || !isUuid(parsed.launchId) || !isIso8601Instant(parsed.launchedAt) || typeof parsed.verified !== "boolean")) {
    throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has malformed recorded metadata`);
  }
  const agyFieldsPresent = has("agyPid") || has("agyCommand") || has("agyStartedAt");
  if (agyFieldsPresent) {
    if (!isPlausiblePid(parsed.agyPid) || typeof parsed.agyCommand !== "string" || typeof parsed.agyStartedAt !== "string") {
      throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has an incomplete or invalid agy pid/command/start-time tuple`);
    }
  }
  const allowed = new Set(["scriptPid", "scriptCommand", "scriptStartedAt", "recordedAt", ...(current ? ["launchId", "launchedAt", "verified"] : []), ...(agyFieldsPresent ? ["agyPid", "agyCommand", "agyStartedAt"] : [])]);
  if (Object.keys(parsed).some((field) => !allowed.has(field))) throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has unexpected fields`);
  if (current && parsed.verified === false && (parsed.scriptCommand !== "" || parsed.scriptStartedAt !== "" || agyFieldsPresent)) {
    throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} mixes provisional and verified fields`);
  }
  if ((current && parsed.verified === true) || !current) {
    if (!parsed.scriptCommand.trim() || !parsed.scriptStartedAt.trim() || (agyFieldsPresent && (!parsed.agyCommand?.trim() || !parsed.agyStartedAt?.trim()))) {
      throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has empty verified process signatures`);
    }
  }
  const state: KeepaliveState = {
    scriptPid: parsed.scriptPid, scriptCommand: parsed.scriptCommand, scriptStartedAt: parsed.scriptStartedAt,
    recordedAt: parsed.recordedAt, verified: current ? parsed.verified as boolean : true,
  };
  if (current) { state.launchedAt = parsed.launchedAt; state.launchId = parsed.launchId; }
  if (agyFieldsPresent) { state.agyPid = parsed.agyPid; state.agyCommand = parsed.agyCommand; state.agyStartedAt = parsed.agyStartedAt; }
  return state;
}

interface AgyPidFileEntry { pid: number; mtimeMs: number }

/** Reads the launch wrapper's OWN pid file directly -- independent of the
 * JSON state above, which a crash before recordState() ever wrote it, or
 * `ps` being unreachable for the whole life of a run, can leave without ever
 * knowing this pid at all. Same trust bar as readKeepaliveState, and the
 * same ENOENT-vs-everything-else distinction: throws
 * InvalidKeepaliveEvidenceError for a symlink, a non-regular file, an
 * unreadable file, or content that isn't a plain positive pid, rather than
 * reporting "nothing here" for evidence that is actually present but
 * cannot be trusted. */
async function readAgyPidFile(path: string): Promise<AgyPidFileEntry | undefined> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new InvalidKeepaliveEvidenceError(`cannot stat agy pid file ${path}: ${(error as Error).message}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new InvalidKeepaliveEvidenceError(`agy pid file ${path} is not a plain regular file`);
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new InvalidKeepaliveEvidenceError(`cannot read agy pid file ${path}: ${(error as Error).message}`); }
  const pid = parseCanonicalPid(raw);
  if (pid === undefined || !isPlausiblePid(pid)) throw new InvalidKeepaliveEvidenceError(`agy pid file ${path} does not contain a plain pid`);
  return { pid, mtimeMs: info.mtimeMs };
}

/** How far an `agy.pid` file's mtime may precede the `launchedAt` recorded
 * alongside it and still count as "written by that same launch": filesystem
 * mtime resolution (as coarse as 1s on some volumes) plus the real (small)
 * gap between recordProvisionalState()'s synchronous write in the daemon
 * process and the launch wrapper's own `echo` in the separate child process
 * it just spawned -- both happen at launch, but never at the exact same
 * instant. Wide enough to absorb that gap, narrow enough that an `agy.pid`
 * file left by a much older, unrelated launch cannot pass it. Symmetric: a
 * mtime long AFTER launchedAt is just as disqualifying as one long before --
 * either direction means this file was not written by the launch this record
 * describes. */
const AGY_PID_FILE_MTIME_TOLERANCE_MS = 5_000;

/** Internal mtime/launchedAt consistency (above) proves this evidence is
 * SELF-consistent; it says nothing about whether it is still TRUSTWORTHY
 * relative to now. Without an independent age bound, that proof never
 * expires: once the process this evidence actually describes has long since
 * exited, the OS is free to recycle its exact pid number to any unrelated
 * process that also happens to become its own process-group leader (nothing
 * headroom-specific about that -- any detached/setsid'd process qualifies),
 * and the mtime check alone would wrongly re-verify it as "ours" and SIGKILL
 * an innocent stranger, however long ago the original launch happened. See
 * isLaunchEvidenceFresh(). */
const AGY_PID_FILE_MAX_EVIDENCE_AGE_MS = 60 * 60 * 1000; // 1 hour

/** True only if `launchedAtMs` is after the current boot (a pid number
 * cannot possibly still refer to the same process across a reboot, so
 * evidence timestamped before the machine last booted is unconditionally
 * stale), not implausibly in the FUTURE (allowing only a small clock-skew
 * tolerance -- without this, `now - launchedAtMs` going negative would make
 * the age check below trivially pass for ANY future timestamp, however far
 * out, since a negative number is always <= the age bound), AND within
 * AGY_PID_FILE_MAX_EVIDENCE_AGE_MS of `now` (the longer a pid has sat
 * unreaped even within the same boot, the more likely the OS has since
 * handed it to something else entirely on a long-running system). Evidence
 * that fails this is never used to positively identify a pid -- only
 * isProcessGroupAlive's plain liveness check still applies, which is what
 * routes a stale-but-still-alive pid to `unverified` rather than `swept`. */
function isLaunchEvidenceFresh(launchedAtMs: number, now = Date.now()): boolean {
  const bootTimeMs = now - uptime() * 1000;
  return (
    launchedAtMs >= bootTimeMs &&
    launchedAtMs <= now + AGY_PID_FILE_MTIME_TOLERANCE_MS &&
    now - launchedAtMs <= AGY_PID_FILE_MAX_EVIDENCE_AGE_MS
  );
}

/** How long to poll (ps-free, via isProcessGroupAlive) for a signalled pid to
 * actually disappear before trusting that it has. SIGKILL is asynchronous --
 * the kernel still has to schedule and reap the target -- so neither a pid's
 * evidence (its state-file entry, its `agy.pid` file) nor its membership in
 * `swept` may be settled the instant a signal is sent; only once this confirms
 * the process (or its group) is actually gone. */
const KILL_CONFIRM_TIMEOUT_MS = 1_000;
const KILL_CONFIRM_POLL_MS = 25;

/** Polls isProcessGroupAlive until it reports false (confirmed gone) or
 * `timeoutMs` elapses. See KILL_CONFIRM_TIMEOUT_MS for why this exists at
 * all rather than trusting a kill call's return to mean "gone now". */
async function waitUntilGroupGone(pid: number, timeoutMs = KILL_CONFIRM_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(KILL_CONFIRM_POLL_MS);
  }
  return true;
}

export interface SweepResult {
  /** Pids this sweep proved were ours, signalled, and confirmed dead
   * (waitUntilGroupGone) before returning. */
  swept: number[];
  /** Pids that either could not be proven ours by any tier of evidence, or
   * WERE signalled but could not be confirmed dead (signalling itself failed,
   * e.g. EPERM, or the process outlived the confirm timeout) -- left running
   * (or possibly running) untouched. The caller must not start a fresh
   * keepalive while any of these might still be alive (see the daemon's own
   * re-check before every launch attempt). */
  unverified: number[];
}

interface EvidenceLocation {
  statePath: string;
  pidPath: string;
  /** Set for the private, per-launch layout. Legacy shared files have none. */
  directory?: string;
}

interface SweepOptions {
  execImpl?: ExecFile;
  killTree?: typeof killTree;
  log?: (message: string) => void;
  /** Never sweep the live supervisor's own directory. */
  skipLaunchId?: string;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InvalidKeepaliveEvidenceError(`cannot remove keepalive evidence ${path}: ${(error as Error).message}`);
  }
}

async function removeEvidence(location: EvidenceLocation): Promise<void> {
  await unlinkIfPresent(location.statePath);
  await unlinkIfPresent(location.pidPath);
  if (!location.directory) return;
  try { await rmdir(location.directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InvalidKeepaliveEvidenceError(`cannot remove keepalive launch directory ${location.directory}: ${(error as Error).message}`);
  }
}

async function launchEvidenceLocations(home: string, skipLaunchId?: string): Promise<EvidenceLocation[]> {
  const root = keepaliveDirectoryPath(home);
  let rootInfo;
  try { rootInfo = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new InvalidKeepaliveEvidenceError(`cannot stat keepalive directory ${root}: ${(error as Error).message}`);
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new InvalidKeepaliveEvidenceError(`keepalive directory ${root} is not a plain directory`);
  let entries: string[];
  try { entries = await readdir(root); }
  catch (error) { throw new InvalidKeepaliveEvidenceError(`cannot read keepalive directory ${root}: ${(error as Error).message}`); }
  const locations: EvidenceLocation[] = [];
  for (const launchId of entries) {
    if (launchId === skipLaunchId) continue;
    const directory = join(root, launchId);
    let info;
    try { info = await lstat(directory); }
    catch (error) { throw new InvalidKeepaliveEvidenceError(`cannot stat keepalive launch directory ${directory}: ${(error as Error).message}`); }
    if (!isUuid(launchId) || !info.isDirectory() || info.isSymbolicLink()) throw new InvalidKeepaliveEvidenceError(`keepalive launch directory ${directory} is invalid`);
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { throw new InvalidKeepaliveEvidenceError(`cannot read keepalive launch directory ${directory}: ${(error as Error).message}`); }
    if (files.some((name) => name !== "state.json" && name !== "agy.pid")) throw new InvalidKeepaliveEvidenceError(`keepalive launch directory ${directory} has unexpected evidence`);
    locations.push({ directory, statePath: launchStateFilePath(directory), pidPath: launchAgyPidFilePath(directory) });
  }
  return locations;
}

/** Reconciles exactly one isolated evidence location. All identity decisions
 * are made from its own files before any signal is sent; the private launch
 * directory is the ownership boundary, so no launch-id compare-and-act dance
 * is needed. */
async function reconcileEvidence(location: EvidenceLocation, options: SweepOptions = {}): Promise<SweepResult> {
  const state = await readKeepaliveState(location.statePath);
  const pidFileEntry = await readAgyPidFile(location.pidPath);
  if (!state && !pidFileEntry) { await removeEvidence(location); return { swept: [], unverified: [] }; }
  if (state?.agyPid !== undefined && pidFileEntry && pidFileEntry.pid !== state.agyPid) {
    throw new InvalidKeepaliveEvidenceError(`keepalive evidence ${location.directory ?? location.statePath} has conflicting agy pids`);
  }

  const candidates = new Map<number, { command?: string; startedAt?: string }>();
  if (state) {
    candidates.set(state.scriptPid, { command: state.scriptCommand || undefined, startedAt: state.scriptStartedAt || undefined });
    if (state.agyPid !== undefined) candidates.set(state.agyPid, { command: state.agyCommand, startedAt: state.agyStartedAt });
  }
  if (pidFileEntry && !candidates.has(pidFileEntry.pid)) candidates.set(pidFileEntry.pid, {});

  const verified: Array<{ pid: number; tier: "ps" | "ps-free" }> = [];
  const unverified = new Set<number>();
  // The ps-free tier exists for hosts where the process table cannot be read.
  // Where it can, a pid without a recorded ps signature is never signalled on
  // pid-file evidence alone: a recycled pid can pass a freshness and
  // group-alive check, and killing a stranger is worse than an orphan that is
  // reported and blocks the next launch.
  const psAvailable = (await processSignature(process.pid, options.execImpl)) !== undefined;
  for (const [pid, recorded] of candidates) {
    if (recorded.command && recorded.startedAt) {
      const live = await processSignature(pid, options.execImpl);
      if (live) {
        if (live.command === recorded.command && live.startedAt === recorded.startedAt) verified.push({ pid, tier: "ps" });
        // A different live signature proves the recorded process is gone;
        // never fall through to weaker evidence for a recycled pid.
        continue;
      }
    }
    if (!psAvailable && pidFileEntry && pidFileEntry.pid === pid && state?.launchedAt) {
      const launchedAtMs = Date.parse(state.launchedAt);
      if (isLaunchEvidenceFresh(launchedAtMs)
        && Math.abs(pidFileEntry.mtimeMs - launchedAtMs) <= AGY_PID_FILE_MTIME_TOLERANCE_MS
        && isProcessGroupAlive(pid)) {
        verified.push({ pid, tier: "ps-free" });
        continue;
      }
    }
    if (isProcessGroupAlive(pid)) unverified.add(pid);
  }

  const kill = options.killTree ?? killTree;
  const swept: number[] = [];
  for (const { pid, tier } of verified) {
    try {
      if (tier === "ps") await kill(pid);
      else killProcessGroup(pid, { groupOnly: true });
    } catch { unverified.add(pid); continue; }
    if (await waitUntilGroupGone(pid)) swept.push(pid);
    else unverified.add(pid);
  }
  const unresolved = [...unverified];
  if (!unresolved.length) await removeEvidence(location);
  return { swept, unverified: unresolved };
}

/** Reap all stale launch directories plus the old shared pair (migration
 * only). Invalid or unresolved evidence is deliberately left in place and
 * blocks the next launch. */
export async function sweepPreviousKeepalive(home: string, options: SweepOptions = {}): Promise<SweepResult> {
  if (process.platform === "win32") return { swept: [], unverified: [] };
  const locations = await launchEvidenceLocations(home, options.skipLaunchId);
  // The shared paths are never written by this version. Treat them as one
  // final legacy launch until it can be proven gone and removed.
  locations.push({ statePath: keepaliveStateFilePath(home), pidPath: legacyAgyPidFilePath(home) });
  const swept: number[] = [];
  const unverified = new Set<number>();
  for (const location of locations) {
    const result = await reconcileEvidence(location, options);
    swept.push(...result.swept);
    for (const pid of result.unverified) unverified.add(pid);
  }
  const unresolved = [...unverified];
  if (unresolved.length) (options.log ?? (() => undefined))(`antigravity keepalive sweep: pid(s) ${unresolved.join(", ")} could not be verified, or could not be confirmed dead after signalling -- left alone; a new keepalive will not launch until they are confirmed gone`);
  return { swept, unverified: unresolved };
}

/** Reads only auth-state markers, never credentials or quota values, from
 * agy's newest log -- a bounded tail of a verified regular file, never a
 * symlink or other non-regular entry, and never the whole (possibly still
 * growing) file. */
export async function agyLoginStateFromLog(logDirectory = join(homedir(), ".gemini", "antigravity-cli", "log")): Promise<AgyLoginState> {
  try {
    const entries = await readdir(logDirectory);
    const candidates = await Promise.all(entries.filter((name) => /^cli-.*\.log$/.test(name)).map(async (name) => {
      const path = join(logDirectory, name);
      try {
        const info = await lstat(path);
        return info.isFile() ? { path, modified: info.mtimeMs } : undefined;
      } catch { return undefined; }
    }));
    const logs = candidates.filter((item): item is { path: string; modified: number } => item !== undefined);
    const newest = logs.sort((left, right) => right.modified - left.modified)[0];
    if (!newest) return "unknown";
    const text = await readLogTail(newest.path);
    if (/applyAuthResult.*authMethod=/.test(text)) return "logged_in";
    return text.includes("You are not logged into Antigravity") ? "not_logged_in" : "unknown";
  } catch { return "unknown"; }
}

function inheritedAgyEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(name) && !name.startsWith("HEADROOM_")));
}

/** Service managers commonly omit the interactive shell PATH. Registry wins,
 * then well-known local installs, then the inherited PATH fallback. */
export function resolveAgyBinary(registryPath?: string, home = homedir(), path = process.env.PATH, platform = process.platform): string {
  if (registryPath?.trim()) return registryPath;
  const local = join(home, ".local", "bin", platform === "win32" ? "agy.exe" : "agy");
  const homebrew = platform === "win32" ? undefined : "/opt/homebrew/bin/agy";
  const separator = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "agy.exe" : "agy";
  const onPath = (path ?? "").split(separator).filter(Boolean).map((directory) => join(directory, name)).find((candidate) => existsSync(candidate));
  const candidates = [local, ...(homebrew ? [homebrew] : []), ...(onPath ? [onPath] : [])];
  return candidates.find((candidate) => existsSync(candidate)) ?? "agy";
}

/** True when a `ps` args line runs `binary`: as the command itself, or as a
 * script's path after its interpreter. Matched as a whole argument, so a
 * binary path that is a prefix or substring of another argument never counts;
 * a path with spaces still matches because ps joins arguments with one space. */
function argsRunBinary(args: string, binary: string): boolean {
  return args === binary || args.startsWith(`${binary} `) || args.endsWith(` ${binary}`) || args.includes(` ${binary} `);
}

/** Owns only the `script` PTY it starts, so daemon shutdown cannot kill a user-launched agy. */
export class AgyKeepaliveSupervisor {
  private child: ChildProcess | undefined;
  private restart: NodeJS.Timeout | undefined;
  private stopping = false;
  private failures = 0;
  private startedAt: number | undefined;
  /** Incremented, synchronously, on every launch(). recordState()'s eventual
   * (async, `ps`-dependent) write checks this immediately before writing, in
   * the same synchronous step, so a stale write from an OLDER launch can
   * never land after (and clobber) a NEWER launch's own synchronous
   * provisional record, however the two async chains happen to interleave. */
  private launchGeneration = 0;
  /** Names this launch's private evidence directory. */
  private currentLaunchId: string | undefined;
  /** True from the moment the unexpected-exit path (reapOrphanedAgyThenRestart)
   * starts, until it either confirms the old agy is gone (or never existed)
   * and is about to restart, or a real stop() takes over. `this.child` is
   * ALSO cleared synchronously at that same moment (so `running` correctly
   * goes false right away), which otherwise leaves a window where a
   * concurrent caller sees `running === false` and `start()`'s own guard
   * (`!this.child && !this.restart`) sees nothing to stop it either. start()
   * checks this flag too, so it refuses while reconciliation is unresolved. */
  private reaping = false;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly startChild: Spawn;
  private readonly delay: (attempt: number) => number;
  private readonly logDirectory: string;
  private readonly logPollIntervalMs: number;
  private readonly logWatchMs: number;
  private loginWatch: NodeJS.Timeout | undefined;
  private loginWatchStartedAt: number | undefined;
  private notLoggedInSamples = 0;
  private _loginState: AgyLoginState = "unknown";
  /** a sample already in flight skips the next tick instead of
   * starting a second concurrent read of the same log file. */
  private sampling = false;
  private readonly home: string | undefined;
  private launchDirectory: string | undefined;
  private stateFilePath: string | undefined;
  private readonly killGraceMs: number;
  private readonly pidDiscoveryAttempts: number;
  private readonly pidDiscoveryIntervalMs: number;
  /** Where the launch wrapper writes agy's pid (see agyPtyCommand). Known
   * without `ps`, so stop() and an unexpected script exit can reap agy even
   * on a host where the process table cannot be read. */
  private agyPidFile: string | undefined;

  constructor(options: AgyKeepaliveOptions = {}) {
    this.binary = options.binary ?? resolveAgyBinary(process.env.ANTIGRAVITY_CLI_PATH);
    this.platform = options.platform ?? process.platform;
    this.startChild = options.spawn ?? spawn as Spawn;
    this.delay = options.restartDelay ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)));
    this.logDirectory = options.logDirectory ?? join(homedir(), ".gemini", "antigravity-cli", "log");
    this.logPollIntervalMs = options.logPollIntervalMs ?? 1_000;
    this.logWatchMs = options.logWatchMs ?? 60_000;
    this.home = options.home;
    this.killGraceMs = options.killGraceMs ?? 300;
    this.pidDiscoveryAttempts = options.pidDiscoveryAttempts ?? 20;
    this.pidDiscoveryIntervalMs = options.pidDiscoveryIntervalMs ?? 100;
  }

  get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }
  /** True while this supervisor still owns a lifecycle of its own: a live
   * child, an orphan reap in progress, or a scheduled restart. An idle
   * supervisor (never started, or cleanly stopped) owns nothing and is
   * started again by the daemon's normal launch path. */
  get managingLifecycle(): boolean { return this.running || this.reaping || this.restart !== undefined; }
  get pid(): number | undefined { return this.running ? this.child?.pid : undefined; }
  get uptimeMs(): number | undefined { return this.running && this.startedAt !== undefined ? Date.now() - this.startedAt : undefined; }
  get loginState(): AgyLoginState { return this._loginState; }
  get launchId(): string | undefined { return this.currentLaunchId; }

  start(): void {
    this.stopping = false;
    if (this.child || this.restart || this.reaping) return;
    if (!this.launchDirectory) { this.launch(); return; }
    // A caller can explicitly start us again after a failed stop. Do not let
    // that bypass the same own-directory reconciliation a timered restart
    // receives.
    this.reaping = true;
    void this.reconcileThenLaunch();
  }

  /** Stops only this launch's PTY tree, then reconciles only this launch's
   * directory. The directory is removed by reconcileEvidence() solely after
   * every recorded process is confirmed gone. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    this.stopLoginWatch();
    const child = this.child;
    this.child = undefined;
    let pidFileNeverAppeared = false;
    if (child && isAlive(child)) {
      // Give the wrapper a bounded chance to leave its evidence before the
      // tree starts exiting. It may otherwise write during shutdown.
      let agyPid = this.agyPidFile ? await this.awaitAgyPid(child) : undefined;
      const pid = child.pid;
      if (typeof pid === "number") await killTree(pid, { graceMs: this.killGraceMs });
      else child.kill("SIGTERM");
      // killTree's descendant snapshot can be unavailable when ps is denied.
      // This is still this launch's private wrapper file, captured while its
      // script was alive, so its group is safe to reap directly. Confirm the
      // result before considering its directory clearable.
      if (agyPid === undefined) { const detailed = this.readAgyPidDetailed(); if (detailed.kind === "found") agyPid = detailed.pid; }
      if (agyPid === undefined && this.agyPidFile) {
        try { pidFileNeverAppeared = (await readKeepaliveState(this.stateFilePath!))?.agyPid === undefined; }
        catch { return; } // unreadable state is unresolved evidence
      }
      let pidMatchesState = false;
      if (agyPid !== undefined && this.stateFilePath) {
        try {
          const state = await readKeepaliveState(this.stateFilePath);
          pidMatchesState = state !== undefined && (state.agyPid === undefined || state.agyPid === agyPid);
        } catch { /* invalid or missing state is never authority to signal */ }
      }
      if (agyPid !== undefined && pidMatchesState) {
        killProcessGroup(agyPid, { groupOnly: true });
        if (!(await waitUntilGroupGone(agyPid))) return;
      }
    }
    // A wrapper that never left a pid file and whose state never learned agy
    // remains unresolved even if killTree happened to reap it. Discarding
    // that directory would turn a missed descendant into an unrecoverable
    // orphan; a later sweep can make the same conservative decision again.
    if (pidFileNeverAppeared) return;
    if (await this.reconcileOwnLaunchDirectory()) this.forgetLaunchDirectory();
  }

  private launch(): void {
    if (this.stopping || this.child) return;
    try {
      const launchId = randomUUID();
      this.configureLaunchDirectory(launchId); // must exist, mode 0700, before spawn
      const [command, args] = this.ptyCommand();
      const child = this.startChild(command, args, { stdio: "ignore", env: inheritedAgyEnvironment(), detached: this.platform !== "win32" });
      this.child = child;
      this.startedAt = Date.now();
      // Bumped synchronously, before anything else about this launch is
      // recorded: recordState()'s eventual write checks this is still the
      // current generation, immediately before writing, so it can never
      // clobber a newer launch's record (see the field's own doc comment).
      this.launchGeneration += 1;
      const generation = this.launchGeneration;
      // Synchronous and ps-free, in the same tick as spawn(): a crash at ANY
      // point from here on -- even before this method's own next line, let
      // alone recordState()'s first `await` -- still leaves durable evidence
      // of this launch behind for the next daemon start's sweep to find.
      const statePath = this.stateFilePath;
      this.recordProvisionalState(child, launchId, statePath);
      this.startLoginWatch();
      void this.recordState(child, generation, launchId, statePath);
      let handled = false;
      const exited = () => {
        if (handled) return;
        handled = true;
        this.stopLoginWatch();
        if (this.child === child) { this.child = undefined; this.startedAt = undefined; }
        if (this.stopping) return; // stop() owns its own reap of this exact exit
        void this.reapOrphanedAgyThenRestart();
      };
      child.once("exit", exited);
      child.once("error", exited);
    } catch { this.scheduleRestart(); }
  }

  /** An exited script can have left agy in a separate PTY session. Reconcile
   * this launch directory before scheduling any replacement, and retry while
   * evidence is invalid or any recorded process remains unresolved. */
  private async reapOrphanedAgyThenRestart(attempt = 0): Promise<void> {
    if (this.stopping) { this.reaping = false; return; }
    // Without a Headroom home there is no launch evidence to reap or
    // reconcile: schedule the restart synchronously, as before.
    if (!this.home) { this.reaping = false; this.scheduleRestart(); return; }
    this.reaping = true;
    if (await this.waitForOwnPidEvidence() && await this.reapOwnPidFileGroup() && await this.reconcileOwnLaunchDirectory()) {
      this.forgetLaunchDirectory();
      this.reaping = false;
      this.scheduleRestart();
      return;
    }
    if (this.stopping) { this.reaping = false; return; }
    const timeout = setTimeout(() => { void this.reapOrphanedAgyThenRestart(attempt + 1); }, this.delay(Math.min(attempt, 6)));
    timeout.unref();
  }

  /**
   * Writes the ps-independent half of the state sweepPreviousKeepalive()
   * needs, from information this process already holds with certainty --
   * script's own pid (straight from the ChildProcess node just returned,
   * never from `ps`) and the moment it was launched -- BEFORE recordState()
   * below ever gets to run its `ps` calls, which can take up to
   * pidDiscoveryAttempts * pidDiscoveryIntervalMs to resolve or simply never
   * resolve at all when `ps` is denied. Without this, a crash inside that
   * window left only the launch wrapper's bare `agy.pid` file on disk, with
   * no launch time to cross-check it against -- see sweepPreviousKeepalive's
   * ps-free tier. recordState() overwrites this with a `ps`-verified record
   * once (if) one becomes available; until then, this is what a sweep has.
   */
  private recordProvisionalState(child: ChildProcess, launchId: string, statePath = this.stateFilePath): void {
    if (!statePath || this.platform === "win32") return;
    const scriptPid = child.pid;
    if (typeof scriptPid !== "number" || this.startedAt === undefined) return;
    const state: KeepaliveState = {
      scriptPid, scriptCommand: "", scriptStartedAt: "",
      launchedAt: new Date(this.startedAt).toISOString(),
      recordedAt: new Date().toISOString(),
      verified: false,
      launchId,
    };
    try { writeKeepaliveStateSync(statePath, state); }
    catch { /* best-effort; recordState() may still succeed once ps answers */ }
  }

  /**
   * Best-effort persistence for sweepPreviousKeepalive(): records this
   * script's pid and (once discovered) agy's own pid, each with the exact
   * command + start time `ps` reports for it right now, so a future daemon
   * start can verify a pid it finds still IS that same process before ever
   * killing it. Failure here (no `home` configured, `ps` unavailable, the
   * supervisor already moved on to a different child) leaves the provisional,
   * unverified record recordProvisionalState() already wrote in place -- the
   * next daemon start still has that to sweep with, just without a `ps`
   * signature to match against.
   *
   * `generation` is this launch's own launchGeneration, captured by launch()
   * before any `await`; it is checked again immediately before the final
   * write, IN THE SAME SYNCHRONOUS STEP as that write (writeKeepaliveStateSync
   * is synchronous specifically for this), so nothing else can run in
   * between. Without that, `this.child !== child` alone is not enough: two
   * recordState() calls can each pass their own check and then have their
   * actual disk writes complete in either order (an async writeFile's I/O is
   * dispatched to a thread pool the instant it is called, so nothing about
   * which call's *check* passed first controls which call's *bytes* land on
   * disk last) -- an older launch's stale, `ps`-verified write could then
   * land after a newer launch's synchronous provisional record and clobber
   * it, silently erasing the newer launch's identity from disk.
   */
  private async recordState(child: ChildProcess, generation: number, launchId: string, statePath = this.stateFilePath): Promise<void> {
    if (!statePath || this.platform === "win32") return;
    const scriptPid = child.pid;
    if (typeof scriptPid !== "number") return;
    const launchedAt = this.startedAt !== undefined ? new Date(this.startedAt).toISOString() : undefined;
    try {
      const scriptSignature = await processSignature(scriptPid);
      if (!scriptSignature || this.child !== child) return;
      let agyPid: number | undefined;
      for (let attempt = 0; attempt < this.pidDiscoveryAttempts && agyPid === undefined; attempt += 1) {
        if (this.child !== child) return; // stopped or replaced before discovery finished
        const detailed = this.readAgyPidDetailed();
        agyPid = detailed.kind === "found" ? detailed.pid : descendantsOf(scriptPid, await listProcesses())[0]?.pid;
        if (agyPid === undefined) await sleep(this.pidDiscoveryIntervalMs);
      }
      if (this.child !== child) return;
      const agySignature = agyPid !== undefined ? await processSignature(agyPid) : undefined;
      const state: KeepaliveState = {
        scriptPid, scriptCommand: scriptSignature.command, scriptStartedAt: scriptSignature.startedAt,
        launchedAt, recordedAt: new Date().toISOString(), verified: true, launchId,
      };
      if (agyPid !== undefined && agySignature) { state.agyPid = agyPid; state.agyCommand = agySignature.command; state.agyStartedAt = agySignature.startedAt; }
      // The awaits above can outlive this launch: never write a stopped,
      // replaced, or superseded launch's pids over the state a newer one (or
      // stop) left. Checked and written synchronously together -- see this
      // method's own doc comment for why the generation check alone,
      // followed by an async write, would not be enough.
      if (this.launchGeneration !== generation || this.child !== child || !isAlive(child)) return;
      writeKeepaliveStateSync(statePath, state);
    } catch { /* best-effort only; the next sweep just finds nothing recorded */ }
  }

  /** stop() right after start() can beat the wrapper to its pid file; wait
   * (bounded) while script is alive, since agy cannot outlive an unseen pid
   * any other way on a host where killTree's ps walk finds nothing. */
  private async awaitAgyPid(child: ChildProcess, timeoutMs = 1_000): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = this.readAgyPidDetailed();
      if (result.kind === "found") return result.pid;
      if (!this.agyPidFile || !isAlive(child) || Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  }

  /** Synchronous, ENOENT-vs-everything-else-distinguishing read of the
   * launch wrapper's own pid file, with the same trust bar as the async
   * readers: never follows a symlink, never accepts a non-regular file, and
   * never accepts anything but a canonical decimal integer
   * (parseCanonicalPid) within the plausible pid range (isPlausiblePid).
   * "absent" (never written, or written by a launch that has since been
   * cleaned up) and "invalid" (present but a symlink, not a regular file,
   * unreadable, non-canonical, out of the plausible pid range, or otherwise
   * malformed) are never conflated: a caller deciding whether it is safe to
   * restart or to trust a kill needs to tell "nothing here" apart from
   * "something here that cannot be trusted". */
  private readAgyPidDetailed(): { kind: "found"; pid: number } | { kind: "absent" } | { kind: "invalid" } {
    if (!this.agyPidFile) return { kind: "absent" };
    let info;
    try { info = lstatSync(this.agyPidFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      return { kind: "invalid" };
    }
    if (!info.isFile() || info.isSymbolicLink()) return { kind: "invalid" };
    let raw: string;
    try { raw = readFileSync(this.agyPidFile, "utf8"); }
    catch (error) {
      // Only ENOENT here (the file vanished between the lstat above and
      // this read) still counts as "absent"; anything else found something
      // it could not read.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      return { kind: "invalid" };
    }
    const pid = parseCanonicalPid(raw);
    return pid !== undefined && isPlausiblePid(pid) ? { kind: "found", pid } : { kind: "invalid" };
  }

  /** Creates a UUID-named directory before spawn. It is intentionally the
   * only ownership mechanism: no other supervisor ever has a reason to read
   * or replace a file in this directory. */
  private configureLaunchDirectory(launchId: string): void {
    this.currentLaunchId = launchId;
    this.launchDirectory = undefined;
    this.stateFilePath = undefined;
    this.agyPidFile = undefined;
    if (!this.home || this.platform === "win32") return;
    const root = keepaliveDirectoryPath(this.home);
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new InvalidKeepaliveEvidenceError(`keepalive directory ${root} is not a plain directory`);
    const directory = keepaliveLaunchDirectoryPath(this.home, launchId);
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    this.launchDirectory = directory;
    this.stateFilePath = launchStateFilePath(directory);
    this.agyPidFile = launchAgyPidFilePath(directory);
  }

  private ownEvidenceLocation(): EvidenceLocation | undefined {
    if (!this.launchDirectory || !this.stateFilePath || !this.agyPidFile) return undefined;
    return { directory: this.launchDirectory, statePath: this.stateFilePath, pidPath: this.agyPidFile };
  }

  /** Missing pid evidence needs its historical bounded wait only when the
   * state has not already recorded agy's pid. A recorded agyPid is reconciled
   * through its state signature instead of being mistaken for permission to
   * spawn another wrapper. */
  private async waitForOwnPidEvidence(): Promise<boolean> {
    const location = this.ownEvidenceLocation();
    if (!location) return true;
    try {
      let state = await readKeepaliveState(location.statePath);
      let pid = await readAgyPidFile(location.pidPath);
      if (pid || state?.agyPid !== undefined) return true;
      for (let attempt = 0; attempt < this.pidDiscoveryAttempts && !pid && state?.agyPid === undefined; attempt += 1) {
        if (this.stopping) return false;
        await sleep(this.pidDiscoveryIntervalMs);
        state = await readKeepaliveState(location.statePath);
        pid = await readAgyPidFile(location.pidPath);
      }
      return true;
    } catch { return false; }
  }

  /** Reconciles just this supervisor's directory. Invalid evidence and any
   * still-live process fail closed, leaving that directory untouched. */
  private async reconcileOwnLaunchDirectory(): Promise<boolean> {
    const location = this.ownEvidenceLocation();
    if (!location) return true;
    try { return (await reconcileEvidence(location)).unverified.length === 0; }
    catch { return false; }
  }

  /** Fast ps-free reap for the wrapper pid after script exit. If state has
   * already learned agy's pid, the two sources must agree before a signal;
   * otherwise corruption is left for the normal fail-closed reconciliation. */
  private async reapOwnPidFileGroup(): Promise<boolean> {
    const location = this.ownEvidenceLocation();
    const detailed = this.readAgyPidDetailed();
    if (!location || detailed.kind === "absent") return true;
    if (detailed.kind === "invalid") return false;
    try {
      // Signal only on positive agreement: the state learned this same pid as
      // a descendant of this launch's own script, or, when script exited
      // before recordState() got that far, ps identifies the pid as this
      // launch's agy. Without either, defer to the full reconciliation, which
      // never signals unverifiable evidence.
      const state = await readKeepaliveState(location.statePath);
      const agrees = state?.agyPid !== undefined
        ? state.agyPid === detailed.pid
        : await this.isThisLaunchAgy(detailed.pid, location.pidPath, state?.launchedAt);
      if (!agrees) return (await reconcileEvidence(location)).unverified.length === 0;
    } catch { return false; }
    killProcessGroup(detailed.pid, { groupOnly: true });
    return waitUntilGroupGone(detailed.pid);
  }

  /** The wrapper's pid is this launch's agy when it still runs this
   * supervisor's binary and has been running at least as long as its pid
   * file has existed (the wrapper writes the file after it starts) and no
   * longer than this launch. A pid recycled after agy died is younger than
   * the file, and anything else runs a different command. Both ages are
   * durations, so ps's whole-second truncation is the only slack. Without
   * ps this says no, and reconcileEvidence's ps-free tier decides. */
  private async isThisLaunchAgy(pid: number, pidPath: string, launchedAt: string | undefined): Promise<boolean> {
    const launchedAtMs = launchedAt ? Date.parse(launchedAt) : NaN;
    const entry = await readAgyPidFile(pidPath);
    if (!Number.isFinite(launchedAtMs) || !entry || entry.pid !== pid) return false;
    const now = Date.now();
    const [elapsed, args] = await Promise.all([processElapsedSeconds(pid), processArgs(pid)]);
    if (elapsed === undefined || !args || !argsRunBinary(args, this.binary)) return false;
    return elapsed >= Math.floor((now - entry.mtimeMs) / 1000) && elapsed <= Math.ceil((Date.now() - launchedAtMs) / 1000) + 1;
  }

  private forgetLaunchDirectory(): void {
    this.launchDirectory = undefined;
    this.stateFilePath = undefined;
    this.agyPidFile = undefined;
  }

  private async reconcileThenLaunch(): Promise<void> {
    if (await this.waitForOwnPidEvidence() && await this.reconcileOwnLaunchDirectory()) {
      this.forgetLaunchDirectory();
      this.reaping = false;
      if (!this.stopping) this.launch();
      return;
    }
    this.reaping = false;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restart) return;
    const timeout = setTimeout(() => { void this.restartAfterDelay(); }, this.delay(this.failures++));
    timeout.unref();
    this.restart = timeout;
  }

  /** The timer does not launch directly. Evidence can change during its
   * delay, so this repeats the own-directory reconciliation immediately
   * before spawn and leaves the restart pending when it cannot prove safety. */
  private async restartAfterDelay(): Promise<void> {
    if (this.stopping) { this.restart = undefined; return; }
    // Without a Headroom home there is no launch evidence to reconcile, so
    // restart synchronously (no extra await between the timer and spawn).
    if (!this.home) { this.restart = undefined; this.launch(); return; }
    this.reaping = true;
    const clean = await this.waitForOwnPidEvidence() && await this.reconcileOwnLaunchDirectory();
    this.reaping = false;
    if (this.stopping) { this.restart = undefined; return; }
    if (clean) {
      this.restart = undefined;
      this.forgetLaunchDirectory();
      this.launch();
      return;
    }
    const timeout = setTimeout(() => { void this.restartAfterDelay(); }, this.delay(this.failures++));
    timeout.unref();
    this.restart = timeout;
  }

  private startLoginWatch(): void {
    this.stopLoginWatch();
    this._loginState = "unknown";
    this.notLoggedInSamples = 0;
    this.sampling = false;
    this.loginWatchStartedAt = Date.now();
    const inspect = () => {
      if (this.sampling) return; // a sample is still in flight; skip this tick rather than overlap it
      this.sampling = true;
      void agyLoginStateFromLog(this.logDirectory).then((state) => {
        if (!this.running || state === "unknown") return;
        if (state === "logged_in") { this._loginState = state; this.stopLoginWatch(); return; }
        this.notLoggedInSamples += 1;
        // A single line can be startup noise; retain the negative result only
        // after it appears in consecutive samples from the newest agy log.
        if (this.notLoggedInSamples >= 2) this._loginState = state;
      }).catch(() => { /* Log discovery is diagnostic-only. */ }).finally(() => { this.sampling = false; });
      if (this.loginWatchStartedAt !== undefined && Date.now() - this.loginWatchStartedAt >= this.logWatchMs) this.stopLoginWatch();
    };
    inspect();
    this.loginWatch = setInterval(inspect, this.logPollIntervalMs);
    this.loginWatch.unref();
  }

  private stopLoginWatch(): void {
    if (this.loginWatch) clearInterval(this.loginWatch);
    this.loginWatch = undefined;
    this.loginWatchStartedAt = undefined;
  }

  private ptyCommand(): [string, string[]] { return agyPtyCommand(this.binary, this.platform, this.agyPidFile); }
}

/**
 * BSD script and util-linux script use different argument order. Both
 * create a pseudo-terminal; the Linux command is shell-quoted before script
 * receives it. Exported (rather than kept as a private method) so tests can
 * spawn the exact real command Headroom would for the current platform --
 * including the PTY session-leader behavior issue #56 is about -- instead
 * of duplicating (and risking drifting from) this logic.
 */
export function agyPtyCommand(binary: string, platform: NodeJS.Platform, pidFile?: string): [string, string[]] {
  // With a pid file, a tiny sh wrapper records its own pid and then execs
  // agy, which keeps that pid: the supervisor learns agy's pid without `ps`.
  const wrapped = pidFile ? ["/bin/sh", "-c", 'echo $$ > "$0" && exec "$1"', pidFile, binary] : [binary];
  if (platform === "darwin") return ["/usr/bin/script", ["-q", "/dev/null", ...wrapped]];
  return ["script", ["-qefc", wrapped.map(shellQuote).join(" "), "/dev/null"]];
}

function isAlive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode == null; }

/** POSIX single-quote escaping: end the quoted string, emit a literal quote
 * via a backslash outside of any quoting, then resume the quoted string. */
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
