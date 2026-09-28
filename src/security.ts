import { lstat, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { assertSafeAncestry } from "./paths.js";

/** Redact values that may identify an account or authorize a provider request. */
export function redact(value: string): string {
  return value
    // [^\n,;]+ (not [^\s,;]+): a header value can contain spaces ("Bearer
    // <opaque token>"); the prior pattern only ever consumed the scheme word
    // ("Bearer") up to that space, leaving the actual opaque token -- one
    // that doesn't happen to match sk-/eyJ/ya29./GOCSPX- below -- untouched.
    .replace(/Authorization\s*:\s*[^\n,;]+/gi, "[REDACTED]")
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\n]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\bGOCSPX-[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\b([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g, "[REDACTED]");
}

export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const AMBIENT_PROXY_ENV_KEYS = ["NODE_USE_ENV_PROXY", ...PROXY_ENV_KEYS];

/** Child processes never inherit ambient proxy routing. */
export function outboundEnvironment(proxy?: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output = { ...env };
  for (const key of PROXY_ENV_KEYS) delete output[key];
  if (proxy) output.HTTPS_PROXY = proxy;
  return output;
}

/**
 * Call once at daemon and CLI process start, before any fetch happens. Recent
 * Node versions read HTTP_PROXY/HTTPS_PROXY/ALL_PROXY out of the environment
 * for the global fetch dispatcher when NODE_USE_ENV_PROXY is set; deleting all
 * four here means a proxy the operator's shell happened to have set cannot
 * silently route a credentialed vendor request through it unless Headroom's
 * own policy.toml opts in with an explicit `proxy` value.
 */
export function stripAmbientProxyEnvironment(proxy: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (proxy) return;
  for (const key of AMBIENT_PROXY_ENV_KEYS) delete env[key];
}

export function allowedOutbound(url: string, localBaseUrls: string[] = []): URL {
  const parsed = new URL(url);
  if (parsed.hostname === "api.anthropic.com" || parsed.hostname === "chatgpt.com" || parsed.hostname === "cloudcode-pa.googleapis.com" || parsed.hostname === "oauth2.googleapis.com") return parsed;
  // The Grok CLI's chat proxy, the only host the Grok adapter contacts.
  if (parsed.hostname === "cli-chat-proxy.grok.com") return parsed;
  // Kimi's subscription gateway, the Kimi Code CLI's own usages endpoint, and
  // the Moonshot platform balance endpoint its optional credits meter reads.
  // Nothing else in the Kimi adapter is allowed to leave the machine.
  if (parsed.hostname === "www.kimi.com" || parsed.hostname === "api.kimi.com" || parsed.hostname === "api.moonshot.ai") return parsed;
  // headroom update's own version check and --notes release body, neither of
  // which is a credentialed vendor endpoint or carries anything about this
  // machine -- just the package name.
  if (parsed.hostname === "registry.npmjs.org" || parsed.hostname === "api.github.com") return parsed;
  if (localBaseUrls.some((base) => parsed.origin === new URL(base).origin)) return parsed;
  throw new Error("Outbound host is not allowed");
}

export interface OutboundFetchOptions {
  /** Additional origins allowed for this call only, e.g. a configured local pool base_url. */
  localBaseUrls?: string[];
}

/**
 * Every credentialed fetch in this repo goes through here instead of the bare
 * global fetch (or a test double standing in for it): it re-checks the
 * destination against the outbound allowlist before sending, refuses to
 * follow any redirect (`redirect: "manual"`, and any 3xx response is treated
 * as a failed fetch rather than resolved), and re-checks the allowlist
 * against the response's own final URL before handing the response back —
 * so a vendor endpoint cannot silently redirect a bearer token to a host
 * Headroom never approved.
 */
export async function outboundFetch(fetcher: typeof fetch, request: Request, options: OutboundFetchOptions = {}): Promise<Response> {
  const localBaseUrls = options.localBaseUrls ?? [];
  allowedOutbound(request.url, localBaseUrls);
  const response = await fetcher(request, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error("redirect refused");
  if (response.url) allowedOutbound(response.url, localBaseUrls);
  return response;
}

/**
 * Shared filesystem-trust helpers. These mirror the checks store.ts's
 * safeHeadroomDirectory() and paths.ts's executablePath()/assertSafeAncestry()
 * already apply to the Headroom home and its executables, so any other spot
 * that reads from or writes to a directory outside Headroom's own database
 * (a configured statusline snapshot directory, the statusline output
 * directory) can reuse exactly the same trust boundary instead of a weaker
 * one-off check.
 */

/** Directory a Headroom command is about to write trusted output into:
 * created 0700 if absent, otherwise refused if it is a symlink, owned by
 * another user, or writable by group/other. Mirrors safeHeadroomDirectory's
 * own mkdir-then-lstat-verify order, under which a symlinked leaf is created
 * as a no-op by `mkdir(recursive)` (it already "exists") and only ever
 * caught by the lstat check that follows. Windows has no POSIX mode bits, so
 * only the symlink and (where meaningful) ownership checks apply there. */
export async function safeOutputDirectory(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${dir}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Refusing directory owned by another user: ${dir}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Refusing directory with group or world permissions: ${dir}`);
  return dir;
}

/** Read-only counterpart for a directory Headroom is about to scan for
 * external input it did not write itself (a configured statusline snapshot
 * directory): never created, and its ancestry (see assertSafeAncestry) must
 * be safe on top of the directory itself not being a symlink or
 * foreign-owned. Unlike safeOutputDirectory above (Headroom's own private
 * output, which it creates 0700 and expects to stay that way), an ordinary,
 * merely group/world-*readable* externally configured directory (0755, the
 * common default) is not itself a problem -- what assertSafeAncestry already
 * checks for the ancestor chain, and this repeats for the leaf: writable by
 * someone other than its owner, without the sticky bit that would stop them
 * from swapping its contents. A missing directory throws ENOENT, same as a
 * plain lstat, so a caller can tell "not configured" apart from "unsafe". */
export async function assertSafeReadableDirectory(dir: string): Promise<void> {
  await assertSafeAncestry(dirname(dir));
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${dir}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Refusing directory owned by another user: ${dir}`);
  if (process.platform !== "win32") {
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) throw new Error(`Refusing directory writable by group or other without the sticky bit: ${dir}`);
  }
}

/** Bytes trusted from one external snapshot file, matching the 64 KiB bound
 * quoted in the security review. */
export const SAFE_READ_MAX_BYTES = 64 * 1024;

/** The character-class rule inbox.ts's own `assertSessionId` applies to a
 * session id (one path segment, no separators, no drive letters, no percent
 * escapes), hosted here rather than in inbox.ts so a module with no
 * business reading a session's messages -- store.ts's timer owner
 * validation, since a timer's owner is always an inbox delivery target --
 * can enforce the identical rule without importing inbox.ts, which itself
 * imports from store.ts (a cycle). */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** `.` and `..` satisfy SESSION_ID_PATTERN's character class but are
 * directory references, not names -- refused by every session-id validator
 * that shares this rule (see SESSION_ID_PATTERN's own doc comment). */
export function isReservedSessionId(value: string): boolean { return value === "." || value === ".."; }

/** The exact on-disk shape of one inbox message, shared by inbox.ts's own
 * writers (`sendInboxMessage`/`sendInboxMessageAt`) and store.ts's
 * `setTimer`, which must reject an action too large to ever be delivered
 * *before* storing it. Both sides call this one function so the size check
 * validates the actual serialized FILE inbox.ts will write -- pretty-print
 * whitespace, the envelope wrapper, and all -- never just the inner body:
 * a body that fits under the cap can still produce a file that does not,
 * since `readBoundedRegularFile` (what every inbox reader uses) enforces
 * the same cap against the whole file, not the body alone. Hosted here
 * (not in inbox.ts) so store.ts can call it without importing inbox.ts,
 * which itself imports from store.ts (a cycle) -- see SESSION_ID_PATTERN's
 * own doc comment for the identical reasoning. */
export function serializeInboxEnvelope(input: { kind: string; to: string; from: string | null; at: string; deliveryId?: number; body: unknown }): string {
  const envelope: Record<string, unknown> = { version: 1, kind: input.kind, to: input.to, from: input.from, at: input.at };
  if (input.deliveryId !== undefined) envelope.delivery_id = input.deliveryId;
  envelope.body = input.body;
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** The `kind`/`from` a due timer's inbox delivery always uses -- shared
 * between src/heartbeat.ts's fireDueTimers (the real send) and store.ts's
 * setTimer (the pre-write size check via serializeInboxEnvelope above), so
 * the two can never drift apart and silently make that check inexact. */
export const TIMER_DELIVERY_KIND = "handoff";
export const TIMER_DELIVERY_FROM = "headroom-timer";

/** Reads `path` only after an lstat proves it is a regular file, not a
 * symlink, FIFO, or device -- and refuses it outright if it is already
 * larger than `maxBytes`, before ever opening a descriptor. A second check on
 * the open descriptor's own fstat guards the (theoretical, single-user-scale)
 * race between that lstat and the open call. */
export async function readBoundedRegularFile(path: string, maxBytes: number = SAFE_READ_MAX_BYTES): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing symlink or non-regular file: ${path}`);
  if (info.size > maxBytes) throw new Error(`Refusing oversized file (${info.size} > ${maxBytes} bytes): ${path}`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.isSymbolicLink() || !opened.isFile() || opened.size > maxBytes) throw new Error(`Refusing unsafe file after open: ${path}`);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** True when `value`'s object/array nesting exceeds `maxDepth`. Walks with an
 * explicit stack rather than recursion, so a pathologically deep (but still
 * small, under the byte bound above) JSON document cannot exhaust the call
 * stack while it is being rejected. */
export function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > maxDepth) return true;
    if (Array.isArray(item.value)) { for (const entry of item.value) stack.push({ value: entry, depth: item.depth + 1 }); }
    else if (item.value !== null && typeof item.value === "object") { for (const entry of Object.values(item.value as Record<string, unknown>)) stack.push({ value: entry, depth: item.depth + 1 }); }
  }
  return false;
}

/**
 * Writes `data` into `path` atomically and never through a link: a uniquely
 * named temporary file is created (exclusively, so it cannot itself already
 * be a link) in the same directory with the requested `mode`, then renamed
 * into place. `rename()` replaces whatever directory entry currently sits at
 * `path` -- including a symlink -- without ever dereferencing it, but an
 * existing symlink at `path` is refused outright rather than silently
 * replaced, since a link there is itself a sign the destination is not what
 * Headroom last wrote. The atomic-replace guarantee holds on every platform;
 * `mode`'s POSIX permission bits are meaningless on Windows (`fs.open`
 * accepts the argument there but the resulting file has no such bits to
 * set), which has no directly equivalent per-file ACL this project sets.
 * `beforeCommit`, when supplied, runs after the temporary file is durable but
 * immediately before its rename. Returning false abandons that temporary
 * file without replacing the destination; callers that coordinate a later
 * identity check can therefore avoid committing a stale result.
 */
export async function writeFileAtomic(path: string, data: string, mode: number, beforeCommit?: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new Error(`Refusing to write through symlinked destination: ${path}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  try { await handle.writeFile(data, "utf8"); }
  finally { await handle.close(); }
  try {
    if (beforeCommit && !(await beforeCommit())) {
      await unlink(temporaryPath).catch(() => {});
      return false;
    }
    await rename(temporaryPath, path);
    return true;
  }
  catch (error) { await unlink(temporaryPath).catch(() => {}); throw error; }
}

/**
 * Creates a file exclusively (O_EXCL via the "wx" open flag), and on a name
 * collision retries under `<path>-1`, `<path>-2`, ... until one succeeds,
 * returning whichever path was actually written. Two callers that both
 * derive the same nominal name from a millisecond-resolution timestamp (two
 * `policy set` backups taken in the same millisecond, say) each get their
 * own file this way instead of the second silently replacing the first
 * through a plain writeFile.
 */
export async function writeExclusiveFile(path: string, data: string, mode: number): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? path : `${path}-${attempt}`;
    let handle;
    try { handle = await open(candidate, "wx", mode); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // A failure past this point still exclusively created `candidate` --
    // clean it up before rethrowing, or a half-written file would linger
    // and permanently claim this name for every future caller.
    try {
      await handle.writeFile(data, "utf8");
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(candidate).catch(() => {});
      throw error;
    }
    try {
      await handle.close();
    } catch (error) {
      await unlink(candidate).catch(() => {});
      throw error;
    }
    return candidate;
  }
}

const LOCK_HARD_BOUND_MS = 10 * 60_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

export interface ExclusiveLockOptions {
  /** Reclaim floor for when the owner's liveness cannot be determined (a
   * dead pid, or a missing/unreadable owner file): a lock directory older
   * than this many ms is reclaimed regardless. A lock whose owner is
   * confirmed alive is never reclaimed before this either, no matter how
   * long `fn` runs -- there is no heartbeat here on purpose (see
   * withExclusiveLock's own doc comment for why one is unnecessary and, as
   * a previous version of this file proved, actively unsafe). */
  hardBoundMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  /** Test seam: the clock `isReclaimable` judges a lock directory's age
   * against `hardBoundMs` with. Production always reads the real wall
   * clock (`Date.now`); a test can advance it instantly, with no real
   * waiting, to prove the hard-bound path without a 10-minute sleep. */
  now?: () => number;
  /** Test seam: the liveness probe run on a recorded owner pid. Production
   * always calls the real `process.kill(pid, 0)`, which throws `ESRCH` for
   * a pid that no longer exists and `EPERM` for one that exists under
   * another user (both distinguishable from a live, callable pid, which
   * throws nothing). */
  kill?: (pid: number, signal: 0) => void;
}

interface LockOwner { token: string; pid: number; created_at: string; }

function lockErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** A random id (never just the pid, which a crashed-and-restarted process
 * could reuse) identifying the one call that currently holds a given lock
 * directory. Read back before every reclaim decision and before release, so
 * one holder's lock is never mistaken for, reclaimed as, or released in
 * place of, another's. */
function newLockToken(): string {
  return `${process.pid}:${randomBytes(8).toString("hex")}`;
}

function ownerFilePath(lockDir: string): string {
  return join(lockDir, "owner");
}

/** Reads back a lock directory's owner metadata. Any failure to find, read,
 * or parse it (missing, truncated by a crash, corrupted) is reported as
 * "no owner known" rather than thrown -- `isReclaimable` and
 * `releaseLockDirectory` both treat that the same as "cannot be reasoned
 * about", never as an error that should itself block a caller. */
async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
  let text: string;
  try { text = await readFile(ownerFilePath(lockDir), "utf8"); }
  catch { return undefined; }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as LockOwner).token === "string" && typeof (parsed as LockOwner).pid === "number") return parsed as LockOwner;
  } catch { /* malformed content: treated the same as missing, below */ }
  return undefined;
}

/**
 * Creates the lock directory (`mkdir`, atomic on every platform -- unlike
 * exclusive file creation, there is no separate O_EXCL flag to get right,
 * and Windows supports it identically) and writes its owner file. If the
 * owner-file write fails, removes the directory this call just created --
 * a lock left behind by a failed write would otherwise wedge every future
 * caller for the full hard bound with no live owner to blame it on.
 */
async function acquireLockDirectory(lockDir: string, token: string): Promise<void> {
  await mkdir(lockDir); // EEXIST: already locked. ENOENT: the parent (Headroom's home) is missing -- a caller error, propagated as-is.
  try {
    await writeFile(ownerFilePath(lockDir), JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * A lock directory may be reclaimed only when its recorded owner process is
 * confirmed dead (`kill(pid, 0)` throws `ESRCH`), or the directory itself is
 * older than `hardBoundMs` -- never merely because `fn()` has been running
 * a while: a live owner is never reclaimed before the bound, however long
 * it holds the lock. A missing or unreadable owner file carries no liveness
 * signal at all, so it counts as fresh (never stolen early) until
 * `hardBoundMs` on age alone.
 */
async function isReclaimable(lockDir: string, hardBoundMs: number, now: () => number, kill: (pid: number, signal: 0) => void): Promise<boolean> {
  let info;
  try { info = await stat(lockDir); }
  catch (error: unknown) { if (lockErrorCode(error) === "ENOENT") return false; throw error; } // nothing there to reclaim; the caller just retries the create
  const ageMs = now() - info.mtimeMs;
  if (ageMs > hardBoundMs) return true;
  const owner = await readLockOwner(lockDir);
  if (!owner) return false; // no liveness signal available -- fresh until the hard bound
  try { kill(owner.pid, 0); return false; } // no throw: the pid exists and is ours to signal -- alive
  catch (killError: unknown) { return lockErrorCode(killError) === "ESRCH"; } // ESRCH: confirmed dead. EPERM (exists, owned by someone else) or anything else: treated as alive, never reclaimed early.
}

/**
 * Atomically claims a stale lock directory for deletion: `rename()` on a
 * given source path succeeds for at most one racing reclaimer -- everyone
 * else gets `ENOENT` once the first rename has already moved it -- so at
 * most one waiter ever deletes a given stale lock, never a fresh
 * replacement a moment later (another waiter's own successful reclaim, or
 * the true owner's release once it actually finishes).
 */
async function reclaimLockDirectory(lockDir: string): Promise<void> {
  const tombstone = `${lockDir}.tombstone-${randomBytes(4).toString("hex")}`;
  try { await rename(lockDir, tombstone); }
  catch (error: unknown) {
    if (lockErrorCode(error) === "ENOENT") return; // someone else's reclaim (or the real owner's own release) already won this
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true }).catch(() => {});
}

/**
 * Releases a lock directory this call still owns: reads the owner file back
 * and only removes it (and the directory) when the token matches.
 *
 * This is a plain read-then-act, not an atomic compare-and-delete -- and
 * that is deliberate, not an oversight. The invariant that makes it safe:
 * `isReclaimable` refuses to reclaim a lock with a confirmed-live owner
 * before `hardBoundMs` (10 minutes) has passed, full stop, regardless of
 * how long `fn` runs. Every real writer this lock guards (a `policy.toml`
 * or `accounts.toml` edit) holds it for milliseconds -- read, modify,
 * write, release. For a token mismatch to occur here, this call's own
 * process would have to go unresponsive for the entire `hardBoundMs`
 * window while still holding the lock, which is many orders of magnitude
 * longer than any edit this guards ever takes. So a successor's token can
 * never actually be read back here in practice, and the read-then-act
 * window between `readLockOwner` and the removal below is not a real race
 * to close -- there is nothing running fast enough on the other side of it
 * to land in that window before this call's own removal completes. The
 * check exists as a documented invariant guard against a bug elsewhere
 * (`isReclaimable` wrongly reclaiming a live owner), not as protection
 * against a plausible ordinary race. A release failure is reported
 * (`console.error`), never thrown, so a cleanup problem can never cost
 * `fn()`'s own already-computed result.
 */
async function releaseLockDirectory(lockDir: string, token: string): Promise<void> {
  const owner = await readLockOwner(lockDir);
  if (!owner || owner.token !== token) return; // not ours to remove: already gone, or (should never happen within hardBoundMs) reclaimed by someone else
  try {
    await unlink(ownerFilePath(lockDir));
    await rm(lockDir, { recursive: true, force: true });
  } catch (error: unknown) {
    console.error(`headroom: failed to release lock ${lockDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Serializes concurrent writers of the same file (every `policy.toml`
 * writer -- `headroom policy set/clear`, `notify configure`'s
 * reread-compare-write -- shares one lock via `withPolicyLock` below)
 * through an exclusive lock directory next to it: `fn`'s own
 * read-modify-write critical section runs to completion, and the lock is
 * removed, before the next waiting caller's `mkdir` can ever succeed -- so
 * a second writer never reads the same pre-edit source a first writer
 * already replaced, and the first writer's edit is never silently erased
 * by the second's rename.
 *
 * Deliberately no heartbeat: a real policy edit holds the lock for
 * milliseconds, so a lock is reclaimable only when its owner process is
 * confirmed dead or the lock has sat past a long hard bound (10 minutes by
 * default) -- see `isReclaimable`. An earlier version of this lock instead
 * judged staleness by raw file age and refreshed it with a periodic
 * heartbeat; because both the heartbeat refresh and release were
 * read-then-act on a shared pathname with no ownership check tight enough
 * to close the gap, an in-flight heartbeat could recreate or truncate a
 * successor's lock, and release could unlink a lock a reclaimer had since
 * taken over. Reclaiming by confirmed-dead-or-hard-bound instead of by age
 * removes the need for a heartbeat entirely: nothing needs to be kept
 * "fresh" for a lock that is only ever reclaimed once its owner is
 * verifiably gone.
 *
 * The same invariant is what makes release's own token check (a plain
 * read-then-act, not an atomic compare-and-delete) safe: a live owner is
 * never reclaimed inside `hardBoundMs`, and every real edit this lock
 * guards finishes in milliseconds -- many orders of magnitude under that
 * bound -- so a release ever reading back a successor's token is not a
 * plausible race to close, only a bug-in-`isReclaimable` guard. See
 * `releaseLockDirectory`'s own doc comment for the full argument.
 */
export async function withExclusiveLock<T>(lockDir: string, fn: () => Promise<T>, options: ExclusiveLockOptions = {}): Promise<T> {
  const hardBoundMs = options.hardBoundMs ?? LOCK_HARD_BOUND_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const kill = options.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  const token = newLockToken();
  // Monotonic: immune to a concurrent wall-clock change (NTP step, DST),
  // unlike Date.now(). Checked before every acquisition attempt, including
  // right after a sleep, so a stuck reclaim (a denied delete, a busy
  // directory) fails closed at timeoutMs instead of busy-looping past it.
  const deadline = performance.now() + timeoutMs;

  for (;;) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for a lock: ${lockDir}`);
    try {
      await acquireLockDirectory(lockDir, token);
      break;
    } catch (error: unknown) {
      if (lockErrorCode(error) !== "EEXIST") throw error;
      if (performance.now() > deadline) throw new Error(`Timed out waiting for a lock: ${lockDir}`);
      if (await isReclaimable(lockDir, hardBoundMs, now, kill)) { await reclaimLockDirectory(lockDir); continue; }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for a lock: ${lockDir}`);
      // Capped to whatever budget is actually left, never a full retryMs
      // past the deadline.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(retryMs, remaining))));
    }
  }

  try {
    return await fn();
  } finally {
    await releaseLockDirectory(lockDir, token);
  }
}

/** The lock directory path every `policy.toml` writer shares -- see
 * `withPolicyLock` below. */
export function policyLockPath(home: string): string {
  return join(home, "policy.lock");
}

/** The one lock every `policy.toml` writer (`headroom policy set/clear` in
 * cli.ts, `notify configure`'s reread-compare-write in notify-configure.ts,
 * and config seeding's exclusive create in config.ts) takes before touching
 * the file, so no two of them can ever interleave a read and a write across
 * each other, or a write across another's exclusive create. */
export async function withPolicyLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  return withExclusiveLock(policyLockPath(home), fn);
}

/** The lock directory path every `accounts.toml` writer shares -- see
 * `withAccountsLock` below. A separate lock from `policy.lock`: the two
 * files are edited by disjoint sets of commands and have no read/write
 * ordering to protect between them, so sharing one lock would only add
 * needless contention. */
export function accountsLockPath(home: string): string {
  return join(home, "accounts.lock");
}

/** The one lock every `accounts.toml` writer (`headroom accounts
 * enable/disable` and `headroom accounts discover`'s rediscovery, both in
 * registry.ts) takes for its complete read-modify-write section, so a
 * rediscovery can never read a principal's `enabled` flag before a
 * concurrent `accounts disable` writes it and then overwrite that write
 * with a fresh scan's default (re-enabling a principal an operator just
 * parked). Same design as `withPolicyLock` above, just a different lock
 * directory. */
export async function withAccountsLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  return withExclusiveLock(accountsLockPath(home), fn);
}
