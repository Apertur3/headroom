import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, open, readdir, readFile, unlink } from "node:fs/promises";
import { homedir, uptime } from "node:os";
import { join } from "node:path";
import { descendantsOf, isProcessGroupAlive, killProcessGroup, killTree, listProcesses, processSignature, type ExecFile } from "./process-tree.js";

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
   * stop() persists nothing itself, but launch() records the owned pids
   * here so a *future* daemon start can find and reap them if this one
   * never gets to call stop() (crash, SIGKILL, forced service restart). */
  home?: string;
  /** Overrides the state file path derived from `home`; mainly for tests. */
  stateFile?: string;
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
   * later sweep has for the pid named by the launch wrapper's `.agy-pid` file
   * when `ps` was never reachable in between (see sweepPreviousKeepalive). */
  launchedAt?: string;
  recordedAt: string;
  /** True once `ps` has confirmed scriptCommand/scriptStartedAt live, at
   * record time. False for the provisional record recordProvisionalState()
   * writes synchronously at spawn, before any `ps` call has had a chance to
   * run or answer. */
  verified: boolean;
  /** A fresh random id, generated once per launch() call (never reused,
   * never derived from a pid or a counter that resets per-instance).
   * Persisted so a supervisor INSTANCE that is stopping can tell, by
   * re-reading this file, whether the shared state/pid file paths still
   * belong to the launch it itself made -- an in-memory generation counter
   * (see launchGeneration) only disambiguates between launches of the SAME
   * instance; it is invisible to (and no protection against) a DIFFERENT
   * AgyKeepaliveSupervisor instance that has since started using the same
   * `home`. Optional only for backward compatibility with an on-disk record
   * written before this field existed; every write from this version on
   * always includes it. */
  launchId?: string;
}

export function keepaliveStateFilePath(home: string): string { return join(home, "antigravity-keepalive-state.json"); }

/** Path of the ps-independent pid file the launch wrapper writes (see
 * agyPtyCommand). Deterministic from `home` alone, so sweepPreviousKeepalive
 * can look for it even when the JSON state never got far enough to record it. */
function agyPidFilePathFor(stateFilePath: string): string { return `${stateFilePath}.agy-pid`; }

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
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isIso8601Instant(value: unknown): value is string {
  return typeof value === "string" && ISO_8601_INSTANT.test(value) && Number.isFinite(Date.parse(value));
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

/** Never trusts the file blindly: rejects a symlink, a non-regular file, or
 * a shape that doesn't match a state this module wrote -- by throwing
 * InvalidKeepaliveEvidenceError, not by silently reporting "nothing here"
 * the way ENOENT does. A state is either legacy (none of launchId,
 * launchedAt, or verified) or current (all three, with a UUID, ISO instant,
 * and boolean respectively). A partial agy* tuple (some but not all of
 * agyPid/agyCommand/agyStartedAt present) is corruption, not "no agy info
 * recorded yet" (which has none of the three) -- it is rejected the same
 * way, rather than silently dropped. */
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
  if (!isPlausiblePid(parsed.scriptPid) || typeof parsed.scriptCommand !== "string" || typeof parsed.scriptStartedAt !== "string") {
    throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} does not match the recorded shape`);
  }
  const has = (field: keyof KeepaliveState): boolean => Object.hasOwn(parsed, field);
  // recordedAt has been written by every version that wrote this state file.
  // The three launch fields were added together, so accepting only one or two
  // as a harmless legacy record would make malformed evidence clearable.
  if (!isIso8601Instant(parsed.recordedAt)) throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has malformed recorded metadata`);
  const hasLaunchId = has("launchId");
  const hasLaunchedAt = has("launchedAt");
  const hasVerified = has("verified");
  if (hasLaunchId || hasLaunchedAt || hasVerified) {
    if (!hasLaunchId || !hasLaunchedAt || !hasVerified || !isUuid(parsed.launchId) || !isIso8601Instant(parsed.launchedAt) || typeof parsed.verified !== "boolean") {
      throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has malformed recorded metadata`);
    }
  }
  const state: KeepaliveState = {
    scriptPid: parsed.scriptPid, scriptCommand: parsed.scriptCommand, scriptStartedAt: parsed.scriptStartedAt,
    recordedAt: parsed.recordedAt,
    verified: parsed.verified ?? false,
  };
  if (has("launchedAt")) state.launchedAt = parsed.launchedAt;
  if (has("launchId")) state.launchId = parsed.launchId;
  const agyFieldsPresent = "agyPid" in parsed || "agyCommand" in parsed || "agyStartedAt" in parsed;
  if (agyFieldsPresent) {
    if (!isPlausiblePid(parsed.agyPid) || typeof parsed.agyCommand !== "string" || typeof parsed.agyStartedAt !== "string") {
      throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has an incomplete or invalid agy pid/command/start-time tuple`);
    }
    state.agyPid = parsed.agyPid; state.agyCommand = parsed.agyCommand; state.agyStartedAt = parsed.agyStartedAt;
  }
  // A verified record means ps supplied signatures, not merely fields of the
  // right type. Empty strings would otherwise suppress signature matching and
  // let malformed current evidence fall through to clearing logic.
  if (state.verified && (!state.scriptCommand.trim() || !state.scriptStartedAt.trim() || (agyFieldsPresent && (!state.agyCommand?.trim() || !state.agyStartedAt?.trim())))) {
    throw new InvalidKeepaliveEvidenceError(`keepalive state ${path} has empty verified process signatures`);
  }
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

/** How far a `.agy-pid` file's mtime may precede the `launchedAt` recorded
 * alongside it and still count as "written by that same launch": filesystem
 * mtime resolution (as coarse as 1s on some volumes) plus the real (small)
 * gap between recordProvisionalState()'s synchronous write in the daemon
 * process and the launch wrapper's own `echo` in the separate child process
 * it just spawned -- both happen at launch, but never at the exact same
 * instant. Wide enough to absorb that gap, narrow enough that a `.agy-pid`
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
 * evidence (its state-file entry, its `.agy-pid` file) nor its membership in
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

/**
 * Reap whatever a previous daemon's keepalive left behind, before this
 * daemon launches its own. Reconciles TWO independent sources left by that
 * daemon's own AgyKeepaliveSupervisor: the JSON state file (written by
 * recordState(), see below, once `ps` confirms a signature -- or, at minimum,
 * the provisional record recordProvisionalState() writes synchronously at
 * spawn, before recordState ever gets to run) and the launch wrapper's OWN
 * `.agy-pid` file (written by the spawned shell itself, so it can exist even
 * when the JSON state never got written at all, e.g. `ps` was denied for the
 * whole run). Neither file alone is trusted to be the last word; both are
 * read before anything is decided.
 *
 * Two tiers of proof, tried per candidate pid, strongest first:
 *  1. Exact `ps` signature match against a *recorded* command+start time.
 *     The strongest proof -- used whenever a prior signature was recorded
 *     AND `ps` answers now (it does not have to have answered back then). A
 *     live signature that comes back but does NOT match is definitive proof
 *     this is a different (recycled) process: it is rejected outright, never
 *     falling through to the weaker tier below.
 *  2. ps-free evidence, tried only for the pid the `.agy-pid` file itself
 *     names, when no exact recorded signature could settle it (no `ps`
 *     answer, or nothing was ever recorded to compare against): the launch
 *     time recorded alongside it is still FRESH (isLaunchEvidenceFresh --
 *     after the current boot and within AGY_PID_FILE_MAX_EVIDENCE_AGE_MS of
 *     now; without this bound the proof below never expires, and a pid the
 *     OS recycles long after the original agy exited would eventually pass
 *     it), AND the file's mtime falls within AGY_PID_FILE_MTIME_TOLERANCE_MS
 *     of that launch time IN EITHER DIRECTION (a mtime long after the
 *     recorded launch is just as disqualifying as one long before -- both
 *     mean this file was not written by that launch), AND the pid's process
 *     GROUP is still alive (checked with a signal-0 send, isProcessGroupAlive
 *     -- no `ps` involved). This is NOT a full identity proof even when
 *     fresh: a pid the OS recycled in the meantime to an unrelated new
 *     session/group leader would still pass it. It is the strongest evidence
 *     obtainable without `ps`, which is why it is only ever applied to this
 *     one specific, freshly-orphaned pid -- never used to positively
 *     identify some other stranger pid.
 *
 * Signalling a verified pid can itself fail (EPERM) or simply not have taken
 * effect yet by the time this returns (SIGKILL is asynchronous): either way
 * the pid moves to `unverified` rather than `swept`, via waitUntilGroupGone's
 * bounded confirmation poll -- a pid is never counted as reaped, and its
 * evidence never discarded, until it is actually confirmed gone.
 *
 * A pid that clears neither tier but is still alive (by process-group
 * signal), OR that was signalled but never confirmed dead, is reported in
 * `unverified`, and both files are left in place so this same evidence is
 * available to reconcile it again later. Both files are removed only once
 * nothing remains unverified.
 *
 * Evidence that is PRESENT but cannot be trusted (a symlink, a non-regular
 * or unreadable file, content that doesn't parse) is a different case from
 * evidence that is simply absent (ENOENT, the normal, expected case): the
 * two readers this function calls throw InvalidKeepaliveEvidenceError for
 * the former rather than returning "nothing here" for it, and that error is
 * deliberately left uncaught here -- reporting a clean sweep over evidence
 * that could not actually be read would let the daemon launch a fresh
 * keepalive over a possibly-live orphan this sweep never really got to look
 * at. The daemon's own sweepStaleKeepalive() treats this exactly like a
 * failed kill: this cycle's launch is refused and the sweep is retried.
 *
 * A user's own interactively-started agy is never in either file to begin
 * with, since only launch() ever writes them. Never called on win32 (no
 * `script`, so nothing this daemon could have started to sweep).
 */
export async function sweepPreviousKeepalive(home: string, options: { execImpl?: ExecFile; killTree?: typeof killTree; log?: (message: string) => void } = {}): Promise<SweepResult> {
  if (process.platform === "win32") return { swept: [], unverified: [] };
  const path = keepaliveStateFilePath(home);
  const pidFilePath = agyPidFilePathFor(path);
  const state = await readKeepaliveState(path);
  const pidFileEntry = await readAgyPidFile(pidFilePath);
  if (!state && !pidFileEntry) return { swept: [], unverified: [] };
  const log = options.log ?? ((): void => undefined);

  // Every candidate pid this run might need to reconcile, keyed by pid so
  // the common case (the state file and the pid file both naming agy's same
  // pid) is examined once, not twice.
  const candidates = new Map<number, { command?: string; startedAt?: string }>();
  if (state) {
    candidates.set(state.scriptPid, { command: state.scriptCommand || undefined, startedAt: state.scriptStartedAt || undefined });
    if (state.agyPid !== undefined) candidates.set(state.agyPid, { command: state.agyCommand, startedAt: state.agyStartedAt });
  }
  if (pidFileEntry && !candidates.has(pidFileEntry.pid)) candidates.set(pidFileEntry.pid, {});

  // Verify every candidate's identity BEFORE killing any of them: script and
  // agy are killed independently, but killing one legitimately reaps the
  // other as its descendant, and doing that interleaved with verification
  // could make an already-reaped candidate look like "pid not found; never
  // recorded" and get silently skipped from the result, undercounting a
  // sweep that in fact fully succeeded.
  const verified: Array<{ pid: number; tier: "ps" | "ps-free" }> = [];
  const unverified: number[] = [];
  for (const [pid, recorded] of candidates) {
    if (recorded.command && recorded.startedAt) {
      const live = await processSignature(pid, options.execImpl);
      if (live) {
        if (live.command === recorded.command && live.startedAt === recorded.startedAt) verified.push({ pid, tier: "ps" });
        // else: `ps` just proved this pid is something else now (reuse) --
        // never touch it, and never fall through to the weaker tier either.
        continue;
      }
      // `ps` did not answer for this pid (denied/unavailable): fall through.
    }
    if (pidFileEntry && pidFileEntry.pid === pid && state?.launchedAt) {
      const launchedAtMs = Date.parse(state.launchedAt);
      if (
        Number.isFinite(launchedAtMs) &&
        isLaunchEvidenceFresh(launchedAtMs) &&
        Math.abs(pidFileEntry.mtimeMs - launchedAtMs) <= AGY_PID_FILE_MTIME_TOLERANCE_MS &&
        isProcessGroupAlive(pid)
      ) {
        verified.push({ pid, tier: "ps-free" });
        continue;
      }
    }
    if (isProcessGroupAlive(pid)) unverified.push(pid);
  }

  const kill = options.killTree ?? killTree;
  const swept: number[] = [];
  for (const { pid, tier } of verified) {
    try {
      if (tier === "ps") await kill(pid);
      // killTree()'s SIGKILL escalation re-lists via `ps` to decide who
      // survived the SIGTERM, which is exactly what a ps-free verification
      // has no access to -- SIGKILL directly instead, the same ps-free
      // primitive stop() and the exit handler already rely on for this
      // situation.
      else killProcessGroup(pid, { groupOnly: true });
    } catch {
      // Signalling itself failed (e.g. EPERM): the pid was never actually
      // touched. Treat exactly like an unverifiable pid -- reported, not
      // counted as reaped, and left alone rather than assumed dead.
      unverified.push(pid);
      continue;
    }
    // A kill call returning (or killProcessGroup's fire-and-forget signal)
    // does not mean the target is actually gone yet -- SIGKILL is
    // asynchronous. Confirm before this pid is trusted as swept, so a launch
    // decided moments later never races a process that is still exiting.
    if (await waitUntilGroupGone(pid)) swept.push(pid);
    else unverified.push(pid);
  }
  if (unverified.length) {
    log(`antigravity keepalive sweep: pid(s) ${unverified.join(", ")} left by a previous run could not be verified, or could not be confirmed dead after signalling -- left alone; a new keepalive will not launch until they are confirmed gone`);
  } else {
    // Only reached once every candidate this sweep found alive is either
    // confirmed dead or was never alive to begin with -- never while
    // anything remains unverified, so the evidence that would let a later
    // sweep finish the job is never discarded while it might still be needed.
    try { await unlink(path); } catch { /* already gone */ }
    try { await unlink(pidFilePath); } catch { /* already gone */ }
  }
  return { swept, unverified };
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
  /** A fresh random id generated per launch() call, persisted into the
   * written state (KeepaliveState.launchId) -- see that field's own doc
   * comment for why an in-memory generation counter alone cannot protect
   * cleanup decisions that read shared, on-disk evidence: it disambiguates
   * only between launches of THIS instance, never between this instance and
   * a completely different AgyKeepaliveSupervisor sharing the same `home`. */
  private currentLaunchId: string | undefined;
  /** True from the first successful launch() onward, never reset. Lets
   * stop() tell "this instance never launched anything" (safe to clear
   * whatever stray evidence exists, nothing of ours to protect) apart from
   * "this instance's child has since exited" (its own 'exit' handler owns
   * reaping it; script no longer being alive means a pid found in the
   * shared pid file right now cannot be proven to still be agy's -- see
   * stop()'s own doc comment). Both leave `this.child` equally undefined,
   * which is why this field, not a null check on `child`, is what stop()
   * branches on. */
  private everLaunched = false;
  /** True from the moment the unexpected-exit path (reapOrphanedAgyThenRestart)
   * starts, until it either confirms the old agy is gone (or never existed)
   * and is about to restart, or a real stop() takes over. `this.child` is
   * ALSO cleared synchronously at that same moment (so `running` correctly
   * goes false right away), which otherwise leaves a window where a
   * concurrent caller sees `running === false` and `start()`'s own guard
   * (`!this.child && !this.restart`) sees nothing to stop it either --
   * letting it launch a replacement on top of the old pid file before the
   * reap even finishes, so a later reap retry can end up killing the
   * replacement instead of the orphan it was actually after. start() checks
   * this flag too, so it refuses (no-ops) for as long as it is true. */
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
  private readonly stateFilePath: string | undefined;
  private readonly killGraceMs: number;
  private readonly pidDiscoveryAttempts: number;
  private readonly pidDiscoveryIntervalMs: number;
  /** Where the launch wrapper writes agy's pid (see agyPtyCommand). Known
   * without `ps`, so stop() and an unexpected script exit can reap agy even
   * on a host where the process table cannot be read. */
  private readonly agyPidFile: string | undefined;

  constructor(options: AgyKeepaliveOptions = {}) {
    this.binary = options.binary ?? resolveAgyBinary(process.env.ANTIGRAVITY_CLI_PATH);
    this.platform = options.platform ?? process.platform;
    this.startChild = options.spawn ?? spawn as Spawn;
    this.delay = options.restartDelay ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)));
    this.logDirectory = options.logDirectory ?? join(homedir(), ".gemini", "antigravity-cli", "log");
    this.logPollIntervalMs = options.logPollIntervalMs ?? 1_000;
    this.logWatchMs = options.logWatchMs ?? 60_000;
    this.stateFilePath = options.stateFile ?? (options.home ? keepaliveStateFilePath(options.home) : undefined);
    this.killGraceMs = options.killGraceMs ?? 300;
    this.pidDiscoveryAttempts = options.pidDiscoveryAttempts ?? 20;
    this.pidDiscoveryIntervalMs = options.pidDiscoveryIntervalMs ?? 100;
    this.agyPidFile = this.stateFilePath && this.platform !== "win32" ? agyPidFilePathFor(this.stateFilePath) : undefined;
  }

  get running(): boolean { return this.child !== undefined && this.child.exitCode === null; }
  get pid(): number | undefined { return this.running ? this.child?.pid : undefined; }
  get uptimeMs(): number | undefined { return this.running && this.startedAt !== undefined ? Date.now() - this.startedAt : undefined; }
  get loginState(): AgyLoginState { return this._loginState; }

  start(): void {
    this.stopping = false;
    if (!this.child && !this.restart && !this.reaping) this.launch();
  }

  /**
   * Stops the owned PTY and, on POSIX, everything descended from it --
   * including agy itself, which (see the module doc above `killTree`) is
   * commonly its OWN process-group and session leader once `script` starts
   * it, so a plain SIGTERM to `script` alone reliably leaves it running,
   * reparented to init, at ~100 MB resident (issue #56). killTree() is what
   * actually reaches agy, verified against a live process snapshot rather
   * than assumed from how the tree was spawned -- and it, not this method,
   * must send script's own first SIGTERM: signalling script directly here
   * first would let it die and reparent agy to init *before* killTree ever
   * takes that snapshot, which would make agy's parent no longer be script
   * by the time the tree is walked and let it slip through uncaught (this
   * was a real bug caught by antigravity-keepalive-sweep.test.ts, not a
   * hypothetical). child.kill() is only a fallback for when there is no
   * real numeric pid to walk a tree from at all (a test double). Awaiting
   * the returned promise waits out the SIGTERM grace period and any SIGKILL
   * escalation; callers that only need `running` to go false (most of this
   * file's existing tests) can ignore it, since that flips synchronously,
   * before this function's first `await`.
   *
   * Only ever tries to discover and signal an agy pid while `child` (script)
   * is CONFIRMED ALIVE at the moment this method starts: script's own
   * liveness is what proves a pid found in the shared `.agy-pid` file right
   * now is still agy's (see the block below). Once script has already
   * exited on its own, that proof no longer holds -- the file could since
   * name anything -- so this method does NOT look it up at all in that case
   * (antigravity-keepalive-sweep.test.ts's "never signals a pid it cannot
   * prove is agy" fixture exercises exactly this), and `agyConfirmedGone`
   * is never defaulted to true just because there was nothing for THIS call
   * to confirm: see the `everLaunched` branch below.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    this.stopLoginWatch();
    const child = this.child;
    this.child = undefined;
    // Only cleared once agy is actually confirmed gone (or there was never
    // one to launch in the first place): SIGKILL is asynchronous, and
    // discarding the evidence files while agy might still be alive -- or
    // while this method never even had proof-backed grounds to look for it
    // -- would strip the one identity a future sweep needs to finish the
    // job.
    let agyConfirmedGone: boolean;
    if (child && isAlive(child)) {
      // Read agy's pid while script is still alive: script lives exactly as
      // long as its PTY session, so a pid written by this launch's wrapper is
      // proven to be agy right now, with no `ps` involved and no chance of a
      // recycled pid. Bounded wait first (rather than reading once,
      // immediately) so the wrapper gets a real chance to have run at all
      // before anything is killed.
      let agyPid = this.agyPidFile ? await this.awaitAgyPid(child) : undefined;
      const pid = child.pid;
      if (typeof pid === "number") await killTree(pid, { graceMs: this.killGraceMs });
      else child.kill("SIGTERM");
      // Re-read AFTER killTree() ran: the wrapper can still manage to write
      // its pid file only while dying from killTree's own signal, which the
      // lookup above (which ran before killTree ever fired) would otherwise
      // miss entirely, leaving a freshly-orphaned agy with no evidence this
      // method ever tried to find it.
      if (agyPid === undefined) { const detailed = this.readAgyPidDetailed(); if (detailed.kind === "found") agyPid = detailed.pid; }
      if (agyPid !== undefined && await this.ownsCurrentEvidence()) {
        // killTree reaches agy through a live `ps` walk; where that walk
        // finds nothing (ps denied, or agy already reparented) agy would
        // survive as an orphan holding a PTY, so reap the proven pid
        // directly as well. Group only: agy leads its own process group,
        // and a group with that id exists only while agy or one of its
        // children is alive, so this cannot reach a stranger that inherited
        // the bare pid during the grace period.
        killProcessGroup(agyPid, { groupOnly: true });
        agyConfirmedGone = await waitUntilGroupGone(agyPid);
      } else {
        // Either this launch tracks a pid file and neither lookup found
        // anything in it (a missing pid is not proof no agy exists, only
        // that this method failed to discover it), or a newer launch has
        // since claimed the shared files (ownsCurrentEvidence() said no) and
        // whatever the pid file names is no longer provably agy's: never
        // assumed safe on its own.
        agyConfirmedGone = agyPid === undefined && this.agyPidFile === undefined;
      }
    } else if (this.everLaunched) {
      // script had already exited by the time stop() ran: its own 'exit'
      // handler (reapOrphanedAgyThenRestart) owns reaping it and may still
      // be mid-retry. Nothing is looked up or signalled here -- see this
      // method's own doc comment -- so there is nothing this call itself
      // confirmed.
      agyConfirmedGone = false;
    } else {
      // This instance never successfully launched anything: nothing of
      // ours could exist to protect.
      agyConfirmedGone = true;
    }
    if (agyConfirmedGone) await this.clearState();
    // else: leave the state and pid files in place -- exactly the same
    // evidence a crash would have left, for the next sweepPreviousKeepalive()
    // to pick up and finish reconciling.
  }

  private launch(): void {
    if (this.stopping || this.child) return;
    try {
      this.removeAgyPidFile(); // a pid left by an earlier launch must never be read as this one's
      const [command, args] = this.ptyCommand();
      const child = this.startChild(command, args, { stdio: "ignore", env: inheritedAgyEnvironment(), detached: this.platform !== "win32" });
      this.child = child;
      this.everLaunched = true;
      this.startedAt = Date.now();
      // Bumped synchronously, before anything else about this launch is
      // recorded: recordState()'s eventual write checks this is still the
      // current generation, immediately before writing, so it can never
      // clobber a newer launch's record (see the field's own doc comment).
      this.launchGeneration += 1;
      const generation = this.launchGeneration;
      this.currentLaunchId = randomUUID();
      const launchId = this.currentLaunchId;
      // Synchronous and ps-free, in the same tick as spawn(): a crash at ANY
      // point from here on -- even before this method's own next line, let
      // alone recordState()'s first `await` -- still leaves durable evidence
      // of this launch behind for the next daemon start's sweep to find.
      this.recordProvisionalState(child, launchId);
      this.startLoginWatch();
      void this.recordState(child, generation, launchId);
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

  /**
   * script died on its own (crash, external kill): its agy is now an orphan
   * session leader. Reaped here, confirmed dead (waitUntilGroupGone),
   * BEFORE any restart is scheduled -- scheduling first would let
   * removeAgyPidFile() (at the top of the next launch()) delete the only
   * evidence of a kill that had not actually taken effect yet, leaving that
   * orphan permanently unrecoverable beside its own freshly-spawned
   * replacement (exactly the accumulation issue #56 / the leak this whole
   * file exists to prevent). The pid file was written by this launch
   * (removed before every launch) and script exited only now, so a pid
   * actually found in it is proven to be agy's -- unlike stop()'s own reap,
   * which can no longer assume that once script itself is no longer alive
   * (see stop()'s doc comment); this method only ever runs synchronously off
   * script's own 'exit'/'error' event, so that proof still holds here.
   *
   * That covers the pid file's CONTENT, but not that the file itself is
   * still this launch's to read: a newer launch (this same instance's own
   * next one, or -- see ownsCurrentEvidence's own doc comment -- a
   * completely different AgyKeepaliveSupervisor instance sharing this
   * `home`) can have replaced both shared files with its own launchId at
   * any point after script exited, and this reap runs asynchronously,
   * across a real bounded discovery wait -- ownsCurrentEvidence() is
   * checked again right before ever acting on the pid file's content, not
   * assumed once up front.
   *
   * The pid file itself can be in one of three states, each handled
   * differently (readAgyPidDetailed distinguishes them):
   *  - found: killed and its liveness polled; confirmed dead lets this
   *    proceed to restart, unconfirmed retries (below) exactly like the
   *    other two "never restart yet" cases.
   *  - absent: the wrapper can legitimately still be a moment away from
   *    writing it (script only just exited) -- retried, rapidly and
   *    bounded (reusing pidDiscoveryAttempts/pidDiscoveryIntervalMs, the
   *    same budget recordState()'s own discovery loop gets), and ONLY once
   *    it never appears across that whole bounded window is it reasonably
   *    concluded that nothing was ever spawned for this launch, and a
   *    restart is safe.
   *  - invalid (present but unreadable or malformed): unlike "absent", this
   *    means something DID write to that path -- treating it the same as
   *    "nothing to worry about" is exactly the hazard this case exists to
   *    close. Retried indefinitely, with the same backoff as an unconfirmed
   *    kill, and NEVER allowed to fall through to a restart on its own.
   *
   * `this.reaping` is true for the whole of this method's lifetime (across
   * every retry), so start() refuses to launch a replacement while a
   * previous orphan is still unresolved -- see that field's own doc comment
   * for the race this closes. `this.stopping` (set by stop()) ends this
   * loop the moment a real stop() takes over; every exit path clears
   * `reaping` except the one that schedules another retry, since that is
   * the only case still actually in progress.
   */
  private async reapOrphanedAgyThenRestart(attempt = 0): Promise<void> {
    if (this.stopping) { this.reaping = false; return; }
    this.reaping = true;
    let result = this.readAgyPidDetailed();
    // No agyPidFile configured at all (no `home`/`stateFile` option -- the
    // whole evidence-file mechanism is off for this instance) means there is
    // fundamentally nothing a bounded wait could ever discover: skip it
    // rather than waiting out pidDiscoveryAttempts for no reason.
    if (this.agyPidFile) {
      for (let discovery = 0; result.kind === "absent" && discovery < this.pidDiscoveryAttempts; discovery += 1) {
        if (this.stopping) { this.reaping = false; return; }
        await sleep(this.pidDiscoveryIntervalMs);
        result = this.readAgyPidDetailed();
      }
    }
    if (this.stopping) { this.reaping = false; return; }
    // Before ever signalling anything the pid file names, OR restarting on
    // the strength of it being merely absent, confirm the shared JSON state
    // still names THIS launch's own launchId. Without this, a NEWER launch
    // (this same instance's own, from a launch this reap attempt started
    // before, or -- see ownsCurrentEvidence's own doc comment -- a
    // completely different AgyKeepaliveSupervisor instance sharing this
    // `home`) that has since replaced both shared files would have its own,
    // unrelated agy killed by this OLDER attempt, or its restart wrongly
    // permitted on the strength of "absent" evidence that was never this
    // launch's own to interpret. Missing, invalid, or mismatched state is
    // treated exactly like invalid pid-file evidence: retried indefinitely,
    // never signalled, never restarted.
    // No `home`/state-file configured at all (the whole shared-evidence
    // mechanism is off for this instance, e.g. a unit test driving the
    // supervisor directly with fake timers and a mocked spawn) means
    // ownership is trivially this launch's own -- and, just as importantly,
    // must resolve with NO extra microtask hop: ownsCurrentEvidence() itself
    // already takes this exact shortcut internally, but going through an
    // `await` on it regardless would defer the found/absent branch below by
    // one full turn even in this trivial case, which a caller that never
    // awaits reapOrphanedAgyThenRestart()'s own returned promise (the exit
    // handler above is fire-and-forget) can never itself wait out.
    const owns = (!this.stateFilePath || this.currentLaunchId === undefined) ? true : await this.ownsCurrentEvidence();
    if (this.stopping) { this.reaping = false; return; }
    if (owns && result.kind === "found") {
      killProcessGroup(result.pid, { groupOnly: true });
      const confirmed = await waitUntilGroupGone(result.pid);
      if (this.stopping) { this.reaping = false; return; }
      if (confirmed) { this.reaping = false; this.scheduleRestart(); return; }
    } else if (owns && result.kind === "absent") {
      // Never appeared across the whole bounded discovery window: nothing
      // was reasonably ever spawned for this launch.
      this.reaping = false;
      this.scheduleRestart();
      return;
    }
    // Either a found pid could not be confirmed dead, the evidence is
    // present but invalid, or ownership of the shared files could not be
    // confirmed -- `this.reaping` stays true, and this retries rather than
    // ever letting a restart proceed past unresolved or superseded evidence.
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
   * window left only the launch wrapper's bare `.agy-pid` file on disk, with
   * no launch time to cross-check it against -- see sweepPreviousKeepalive's
   * ps-free tier. recordState() overwrites this with a `ps`-verified record
   * once (if) one becomes available; until then, this is what a sweep has.
   */
  private recordProvisionalState(child: ChildProcess, launchId: string): void {
    if (!this.stateFilePath || this.platform === "win32") return;
    const scriptPid = child.pid;
    if (typeof scriptPid !== "number" || this.startedAt === undefined) return;
    const state: KeepaliveState = {
      scriptPid, scriptCommand: "", scriptStartedAt: "",
      launchedAt: new Date(this.startedAt).toISOString(),
      recordedAt: new Date().toISOString(),
      verified: false,
      launchId,
    };
    try { writeKeepaliveStateSync(this.stateFilePath, state); }
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
  private async recordState(child: ChildProcess, generation: number, launchId: string): Promise<void> {
    if (!this.stateFilePath || this.platform === "win32") return;
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
      writeKeepaliveStateSync(this.stateFilePath, state);
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

  /** Throws unless the file is gone afterwards: launch() must never run while
   * a stale pid from an earlier launch could still be read as this one's. */
  private removeAgyPidFile(): void {
    if (!this.agyPidFile) return;
    try { unlinkSync(this.agyPidFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  /**
   * True ONLY if the on-disk state still names THIS launch's own launchId.
   * False for every other case, including the state being missing: a
   * missing file is NOT evidence of ownership, only the absence of
   * evidence -- it could mean this launch's own record was already cleared
   * (fine, there is nothing left to act on anyway), but it could just as
   * easily mean a DIFFERENT launch (a newer one from this same instance's
   * own restart, or -- despite the daemon's own serialization around
   * stop()/maybeStartKeepalive() -- some other AgyKeepaliveSupervisor
   * instance sharing this `home`) removed and has not yet rewritten it, or
   * removed it entirely, leaving the separate `.agy-pid` file's pid with no
   * corroborating proof at all. Treating "missing" as "still owned" would
   * let stop() sign off on killing whatever that pid file currently names
   * on the strength of nothing. `launchGeneration` alone cannot make this
   * call either: it is invisible to (and no protection against) a different
   * supervisor INSTANCE, since each instance's counter starts at its own
   * zero. Unreadable/invalid evidence where our own record should be is
   * treated the same as "not owned" (never crashes this check -- always the
   * conservative answer instead).
   */
  private async ownsCurrentEvidence(): Promise<boolean> {
    if (!this.stateFilePath || this.currentLaunchId === undefined) return true;
    try {
      const onDisk = await readKeepaliveState(this.stateFilePath);
      return onDisk !== undefined && onDisk.launchId === this.currentLaunchId;
    } catch { return false; }
  }

  private async clearState(): Promise<void> {
    if (!(await this.ownsCurrentEvidence())) return; // a newer launch has since claimed these files; not ours to touch
    try { this.removeAgyPidFile(); } catch { /* the next launch refuses to start until it can remove it */ }
    if (!this.stateFilePath) return;
    try { await unlink(this.stateFilePath); } catch { /* already gone */ }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restart) return;
    const timeout = setTimeout(() => { this.restart = undefined; this.launch(); }, this.delay(this.failures++));
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
