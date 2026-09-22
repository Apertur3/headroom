/**
 * The file-only, explicitly-invoked usage collector: reads one bounded batch
 * of new bytes from one Claude Code transcript JSONL file, folds every
 * complete line through usage-events.ts's pure parser and accumulator, and
 * persists the result through usage-store.ts inside one SQLite transaction.
 *
 * Deliberately narrow: one call reads exactly one file the caller named
 * explicitly (no directory walk, no glob, no autodiscovery), advances that
 * file's own cursor by at most `maxBytes`, and returns. Resuming a large
 * file, or picking up new files, is the caller's job (re-invoke with the
 * same arguments); nothing here schedules itself.
 *
 * Two properties are worth stating plainly, because both are limits:
 *
 * - **Append-oriented, not whole-file integrity -- for bytes already
 *   imported.** Continuity across runs rests on the file's identity
 *   (device/inode), its size, a fixed hash of its first bytes and a hash of
 *   the window immediately behind the cursor. An edit made to *previously
 *   imported* bytes, outside those two anchors, by a process running as this
 *   same user, is not detectable with bounded incremental reads and is not
 *   claimed to be. Bytes being ingested *right now* are a different matter:
 *   the entire range a batch consumed is rehashed from disk before anything
 *   is committed, so a batch is never a mix of pre- and post-edit content.
 * - **Reads happen outside the write lock.** Filesystem reads are async and
 *   bounded, so they cannot be held inside a synchronous SQLite transaction.
 *   The cursor row therefore carries a `revision`: this run records the
 *   revision it started from, and the transaction re-checks it under
 *   `BEGIN IMMEDIATE` before writing anything. If another collector
 *   committed in between, this run commits *nothing at all* (no counters, no
 *   identities, no cursor) and reports `interrupted` -- a cursor can never be
 *   moved backwards by a racing writer's stale view.
 */
import { open, lstat, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, join, posix, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { assertSafeAncestry } from "./paths.js";
import { MAX_LINE_BYTES, parseUsageLine } from "./usage-events.js";
import { parseCodexUsageLine } from "./codex-usage-events.js";
import { detectUsageLineFormat } from "./usage-format-detect.js";
import { isKnownClaudeModel, type CursorRow, type IdentityOutcome, type InterruptReason, type UsageStore } from "./usage-store.js";

export { isKnownClaudeModel } from "./usage-store.js";

/** Bytes hashed at generation start (fixed once, never grown) to notice a
 * same-inode in-place rewrite of a file's beginning. */
const FIXED_PREFIX_BYTES = 4096;
/** Bytes immediately before the committed cursor, hashed after every run and
 * re-checked at the start of the next one, to notice content changing just
 * behind the cursor even when size and inode both still look plausible. */
const BOUNDARY_WINDOW_BYTES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
/** Upper bound on lines produced by one batch, independent of the byte
 * budget: a file of very short lines would otherwise turn a byte budget into
 * an unbounded amount of per-line work. Leftover bytes stay uncommitted and
 * are reread next run, so the cap costs a repeated read, never a lost or
 * duplicated line. */
const MAX_BATCH_EVENTS = 10_000;

export type CollectFileReason =
  | "not_found"
  | "is_directory"
  | "not_regular_file"
  | "symlink_refused"
  | "parent_symlink_refused"
  | "unsafe_ownership"
  | "unsafe_permissions"
  | "unsafe_ancestry"
  | "changed_before_read";

/** Never carries the raw OS error or a path in its message -- the CLI layer
 * already knows the path (the caller typed it) and prints it itself; this
 * only ever needs to say *why*. */
export class CollectInputError extends Error {
  constructor(readonly reason: CollectFileReason) {
    super(`refusing input file: ${reason}`);
    this.name = "CollectInputError";
  }
}

/** `job_conflict` is deliberately not an outcome of its own: a conflicting
 * `--job` withholds the linkage claim (see `jobConflict` below) but never
 * blocks the numeric import, since a job label is optional linkage evidence,
 * not proof of ownership. A conflicting `--principal` or `--source`, by
 * contrast, is a hard stop: both are dimensions usage is attributed under,
 * and reassigning either would silently relabel already-imported bytes. */
export type CollectOutcomeKind = "imported" | "interrupted" | "principal_conflict" | "source_conflict";

export interface CollectResult {
  kind: CollectOutcomeKind;
  cursorKey: string;
  generation: number;
  byteOffset: number;
  bytesReadThisRun: number;
  /** The scan reached the file's end *as it stood during this run*. On its
   * own this does not mean the file is fully imported: check `pendingPartial`
   * (a trailing line with no newline yet) and `discardPending` (an oversized
   * line still being skipped) too. */
  atEof: boolean;
  /** A trailing incomplete line was seen and deliberately left uncommitted;
   * it is reread in full next run. */
  pendingPartial: boolean;
  /** The run stopped because it hit `maxBytes`, not because it ran out of
   * file: there are more bytes to read right now. */
  budgetExhausted: boolean;
  discardPending: boolean;
  /** True when this run supplied a `--job` that conflicts with a job already
   * bound to this file's cursor: the existing binding is left untouched
   * (never silently overwritten, never duplicated) and this run's claim is
   * withheld rather than recorded. */
  jobConflict: boolean;
  /** How many individual identities this run found already claimed by a
   * different job (the same message reimported from a copied transcript).
   * Each such identity loses its job association entirely and is flagged. */
  jobConflictIdentities: number;
  /** Set on `interrupted`: why this run refused to commit. */
  interruptReason: InterruptReason | null;
  /** Delta counters for this run only, keyed the same way as the persisted
   * per-cursor counters (see usage-store.ts's incrementCounter). */
  counters: Record<string, number>;
}

export interface CollectRequest {
  sourceAlias: string;
  principalAlias: string;
  path: string;
  jobAlias?: string;
  maxBytes: number;
  /** Which normalizer to run the file's lines through. `"codex"` switches to
   * `parseCodexUsageLine` and `store.applyAndPersistCodex`, and skips the
   * Claude-only `isKnownClaudeModel` gate entirely (Codex counter records
   * carry no model field at all). `"auto"` detects each line's shape with
   * `detectUsageLineFormat` and routes it to whichever normalizer matches;
   * a line whose shape cannot be told apart (see that module's "unknown"
   * case) falls back to the Claude normalizer, which then rejects or skips
   * it exactly as it would today with no `--format` given at all -- `auto`
   * never invents a third rejection vocabulary just for itself. Omitted or
   * `"claude"` keeps today's behavior. */
  vendor?: "claude" | "codex" | "auto";
  /** Test seam only: awaited after all filesystem reads and immediately
   * before the write transaction, so a test can deterministically interleave
   * a second collector at the one point where a race is possible. */
  afterRead?: () => Promise<void>;
  /** Test seam only: awaited after each chunk of the bounded read, so a test
   * can deterministically mutate the file mid-scan. */
  afterChunk?: () => Promise<void>;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function cursorKeyFor(sourceKeyHash: string, canonicalPath: string): string {
  return createHash("sha256").update(`${sourceKeyHash} ${canonicalPath}`).digest("hex").slice(0, 32);
}

/** Injectable filesystem for `canonicalInputDirectory`. Production always
 * passes the real `node:fs/promises` functions and the real platform; the
 * seam exists so the Windows branch of the policy below can be exercised
 * from any host, since junction/symlink behaviour cannot be simulated with
 * real files on POSIX. */
export interface DirectoryWalkOptions {
  platform?: NodeJS.Platform;
  lstat?: typeof lstat;
  realpath?: typeof realpath;
}

/**
 * Canonicalizes the directory chain above the input file under an explicit
 * symlink policy, because `realpath` alone cannot express one: it resolves
 * *every* link silently, which would let an intermediary link redirect
 * `--path` somewhere else entirely while still passing an ownership check on
 * the resolved chain.
 *
 * The policy differs by platform, and deliberately so:
 *
 * - **POSIX:** an intermediary symlink is followed only when it is owned by
 *   root -- the shape of a system alias like macOS's `/var` ->
 *   `/private/var`, which a non-root user cannot create or replace. Any
 *   other directory link in the chain is refused.
 * - **Windows:** every intermediary reparse point (symlink *or* junction --
 *   `lstat().isSymbolicLink()` reports both) is refused. There is no
 *   root-owned-system-alias equivalent to admit, and uid is meaningless
 *   there, so pretending a `uid === 0` test authenticates anything would be
 *   worse than useless. Junctions need no elevation to create, which is
 *   exactly why this path must be walked rather than skipped.
 *
 * The walk starts at the real filesystem root (`path.parse().root`, so a
 * drive root or a UNC share root on Windows, not a bare separator), and the
 * returned path is the canonical one the cursor key is derived from -- two
 * spellings of one file keep one cursor.
 */
export async function canonicalInputDirectory(resolvedPath: string, options: DirectoryWalkOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const doLstat = options.lstat ?? lstat;
  const doRealpath = options.realpath ?? realpath;
  const pathApi = platform === "win32" ? win32 : posix;
  const directory = pathApi.dirname(resolvedPath);
  const root = pathApi.parse(directory).root;
  if (!root) throw new CollectInputError("unsafe_ancestry");

  let current = root;
  for (const segment of directory.slice(root.length).split(pathApi.sep).filter(Boolean)) {
    current = pathApi.join(current, segment);
    let info;
    try {
      info = await doLstat(current);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CollectInputError("not_found");
      throw new CollectInputError("unsafe_ancestry");
    }
    if (info.isSymbolicLink()) {
      if (platform === "win32" || info.uid !== 0) throw new CollectInputError("parent_symlink_refused");
      try {
        current = await doRealpath(current);
      } catch {
        throw new CollectInputError("unsafe_ancestry");
      }
      continue;
    }
    if (!info.isDirectory()) throw new CollectInputError("unsafe_ancestry");
  }
  return current;
}

interface SafeInput {
  canonicalPath: string;
  stat: Stats;
}

/** Owned regular file only: no symlink leaf, no user-owned symlinked
 * intermediary directory, not group/world writable, and not a directory (a
 * clear, specific reason instead of a generic "not regular file" for the
 * common mistake of pointing `--path` at a project directory). */
async function assertSafeUsageInputFile(rawPath: string): Promise<SafeInput> {
  const resolved = resolve(rawPath);
  // The chain is walked on every platform. `assertSafeAncestry` adds the
  // ownership and writable-without-sticky checks on top, and returns early on
  // Windows (no uid model); the walk above is what keeps a Windows junction
  // from redirecting both the read and the cursor identity.
  const directory = await canonicalInputDirectory(resolved);
  try {
    await assertSafeAncestry(directory);
  } catch {
    throw new CollectInputError("unsafe_ancestry");
  }
  const canonicalPath = join(directory, basename(resolved));
  let stat;
  try {
    stat = await lstat(canonicalPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CollectInputError("not_found");
    throw new CollectInputError("not_regular_file");
  }
  if (stat.isSymbolicLink()) throw new CollectInputError("symlink_refused");
  if (stat.isDirectory()) throw new CollectInputError("is_directory");
  if (!stat.isFile()) throw new CollectInputError("not_regular_file");
  assertSafeInputStat(stat);
  return { canonicalPath, stat };
}

function assertSafeInputStat(stat: Stats): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new CollectInputError("unsafe_ownership");
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) throw new CollectInputError("unsafe_permissions");
}

function openFlags(): number {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  return fsConstants.O_RDONLY | noFollow;
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let readTotal = 0;
  while (readTotal < length) {
    const { bytesRead } = await handle.read(buffer, readTotal, length - readTotal, position + readTotal);
    if (bytesRead === 0) break;
    readTotal += bytesRead;
  }
  return buffer.subarray(0, readTotal);
}

type LineEvent = { kind: "line"; text: string } | { kind: "oversized" };

interface ReadBatch {
  events: LineEvent[];
  newByteOffset: number;
  discardPending: boolean;
  discardBytes: number;
  bytesReadFromDisk: number;
  atEof: boolean;
  pendingPartial: boolean;
  budgetExhausted: boolean;
  /** Hash of every byte this run consumed, accumulated as they were
   * consumed. The same range is reread from disk afterwards and hashed
   * again: equality is what proves the batch describes one coherent
   * snapshot rather than a mix of pre- and post-edit content. Kept as a
   * rolling hash, never as a buffer, so a batch of millions of short lines
   * costs one hash state rather than a copy per line. */
  consumedHash: string | null;
  /** The per-batch event cap was reached: bytes remain buffered but
   * unprocessed, so this run is not at the end of anything. */
  eventCapReached: boolean;
}

/**
 * Reads at most `maxBytes` new bytes starting at `startOffset`, splitting
 * them into complete lines.
 *
 * A line whose length passes MAX_LINE_BYTES before its newline is found is
 * never handed to the parser as a (necessarily truncated) standalone value:
 * it is counted once as oversized and then discarded byte-for-byte, carrying
 * `discardPending`/`discardBytes` forward across runs until its newline
 * finally appears, however many runs that takes. Progress across runs is what
 * forces `maxBytes` to be strictly greater than MAX_LINE_BYTES (the CLI's
 * `--max-bytes` minimum): with a budget of exactly MAX_LINE_BYTES the buffer
 * could never *exceed* the limit, so the discard would never start and the
 * cursor would never move.
 *
 * A trailing incomplete line at the end of this read is left uncommitted
 * (`newByteOffset` never advances past it) and is simply reread, in full,
 * from disk on the next call -- nothing here ever keeps its bytes in memory
 * between calls or persists them anywhere.
 *
 * Work is bounded twice over, because bytes alone do not bound it: a default
 * 8 MiB budget of two-byte lines would be millions of events in one batch.
 * At most MAX_BATCH_EVENTS lines are produced per call; anything still
 * buffered past that point is left uncommitted and simply reread next call,
 * exactly like a partial line, and the batch reports `eventCapReached` so the
 * caller knows to come back rather than treating the file as finished.
 */
async function readBoundedBatch(
  handle: FileHandle,
  fileSize: number,
  startOffset: number,
  maxBytes: number,
  initialDiscardPending: boolean,
  initialDiscardBytes: number,
  afterChunk?: () => Promise<void>,
): Promise<ReadBatch> {
  let readPos = startOffset;
  let budget = maxBytes;
  let buffer = Buffer.alloc(0);
  let discardPending = initialDiscardPending;
  let discardBytes = initialDiscardBytes;
  let committed = startOffset;
  let bytesReadFromDisk = 0;
  let eventCapReached = false;
  const consumed = createHash("sha256");
  const events: LineEvent[] = [];
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);

  const commit = (bytes: Buffer): void => {
    committed += bytes.length;
    consumed.update(bytes);
  };

  while (budget > 0 && readPos < fileSize && !eventCapReached) {
    const toRead = Math.min(READ_CHUNK_BYTES, budget, fileSize - readPos);
    const { bytesRead } = await handle.read(chunk, 0, toRead, readPos);
    if (bytesRead === 0) break; // file shrank mid-read; stop rather than spin
    if (afterChunk) await afterChunk();
    readPos += bytesRead;
    budget -= bytesRead;
    bytesReadFromDisk += bytesRead;
    buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);

    for (;;) {
      const newlineIndex = buffer.indexOf(0x0a);
      if (discardPending) {
        if (newlineIndex === -1) {
          discardBytes += buffer.length;
          commit(buffer);
          buffer = Buffer.alloc(0);
          break;
        }
        discardBytes = 0;
        commit(buffer.subarray(0, newlineIndex + 1));
        buffer = buffer.subarray(newlineIndex + 1);
        discardPending = false;
        continue;
      }
      if (newlineIndex === -1) {
        if (buffer.length > MAX_LINE_BYTES) {
          events.push({ kind: "oversized" });
          discardPending = true;
          discardBytes = buffer.length;
          commit(buffer);
          buffer = Buffer.alloc(0);
          eventCapReached = events.length >= MAX_BATCH_EVENTS;
        }
        break;
      }
      const lineBytes = buffer.subarray(0, newlineIndex);
      commit(buffer.subarray(0, newlineIndex + 1));
      buffer = buffer.subarray(newlineIndex + 1);
      events.push(lineBytes.length > MAX_LINE_BYTES ? { kind: "oversized" } : { kind: "line", text: lineBytes.toString("utf8") });
      if (events.length >= MAX_BATCH_EVENTS) {
        eventCapReached = true;
        break;
      }
    }
  }

  return {
    events,
    newByteOffset: committed,
    discardPending,
    discardBytes,
    bytesReadFromDisk,
    // With the event cap hit there are unprocessed complete lines still
    // buffered, so neither "reached the end" nor "waiting on a partial line"
    // is true; the caller is simply owed another run.
    atEof: readPos >= fileSize && !eventCapReached,
    pendingPartial: !discardPending && !eventCapReached && buffer.length > 0,
    budgetExhausted: eventCapReached || (budget <= 0 && readPos < fileSize),
    consumedHash: committed > startOffset ? consumed.digest("hex") : null,
    eventCapReached,
  };
}

/**
 * Rehashes a byte range straight from disk, in bounded chunks. Used after a
 * batch to prove the bytes just ingested are still exactly the bytes on disk
 * -- the whole read range, not only its two anchors, because a same-length
 * rewrite in the middle of the range leaves both anchors intact while turning
 * the batch into a mix of pre- and post-edit content. `undefined` means the
 * range could not be reread in full (the file shrank underneath it).
 */
async function rehashRange(handle: FileHandle, start: number, end: number): Promise<string | undefined> {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let position = start;
  while (position < end) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(READ_CHUNK_BYTES, end - position), position);
    if (bytesRead === 0) return undefined;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function interrupted(cursorKey: string, existing: CursorRow | undefined, reason: InterruptReason): CollectResult {
  return {
    kind: "interrupted",
    cursorKey,
    generation: existing?.generation ?? 0,
    byteOffset: existing?.byteOffset ?? 0,
    bytesReadThisRun: 0,
    atEof: false,
    pendingPartial: existing?.pendingPartial ?? false,
    budgetExhausted: false,
    discardPending: existing?.discardPending ?? false,
    jobConflict: existing?.jobConflict ?? false,
    jobConflictIdentities: 0,
    interruptReason: reason,
    counters: {},
  };
}

function conflict(kind: "principal_conflict" | "source_conflict", cursorKey: string, existing: CursorRow | undefined): CollectResult {
  return {
    kind,
    cursorKey,
    generation: existing?.generation ?? 0,
    byteOffset: existing?.byteOffset ?? 0,
    bytesReadThisRun: 0,
    atEof: false,
    pendingPartial: existing?.pendingPartial ?? false,
    budgetExhausted: false,
    discardPending: existing?.discardPending ?? false,
    jobConflict: existing?.jobConflict ?? false,
    jobConflictIdentities: 0,
    interruptReason: null,
    counters: {},
  };
}

export async function collectUsageFile(store: UsageStore, request: CollectRequest): Promise<CollectResult> {
  const sourceKey = store.hashAlias("source", request.sourceAlias);
  const principalKey = store.hashAlias("principal", request.principalAlias);
  const jobKey = request.jobAlias !== undefined ? store.hashAlias("job", request.jobAlias) : null;

  const input = await assertSafeUsageInputFile(request.path);
  const canonicalPath = input.canonicalPath;
  const cursorKey = cursorKeyFor(sourceKey, canonicalPath);
  const pathKey = store.hashPath(canonicalPath);

  const handle = await open(canonicalPath, openFlags());
  try {
    // The file that ended up open must be the very file that passed the
    // lstat checks: an O_NOFOLLOW open plus this comparison closes the
    // window between checking a path and using it.
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CollectInputError("not_regular_file");
    assertSafeInputStat(stat);
    if (stat.dev !== input.stat.dev || stat.ino !== input.stat.ino) throw new CollectInputError("changed_before_read");

    const existing = store.getCursor(cursorKey);
    const baselineRevision = existing?.revision ?? null;

    // Binding conflicts are cheap to detect and mutate nothing, so check
    // them before reading a single byte; the authoritative re-check happens
    // under the write lock below.
    const binding = store.getPathBinding(pathKey);
    if (binding && binding.sourceKey !== sourceKey) return conflict("source_conflict", cursorKey, existing);
    if (binding && binding.principalKey !== principalKey) return conflict("principal_conflict", cursorKey, existing);
    if (existing && existing.principalKey !== principalKey) return conflict("principal_conflict", cursorKey, existing);

    // A conflicting --job withholds the claim rather than blocking the
    // import: it is optional linkage evidence, not proof this run owns
    // every call in the file, so it must never silently overwrite (or be
    // silently overwritten by) a different job already bound to this cursor.
    const jobConflict = Boolean(existing?.jobKey && jobKey && existing.jobKey !== jobKey);
    const nextJobKey = jobConflict ? existing!.jobKey : (existing?.jobKey ?? jobKey);

    const dev = String(stat.dev);
    const ino = String(stat.ino);
    let generation = existing?.generation ?? 1;
    let byteOffset = existing?.byteOffset ?? 0;
    let prefixLen = existing?.prefixLen ?? 0;
    let prefixHash = existing?.prefixHash ?? null;
    let discardPending = existing?.discardPending ?? false;
    let discardBytes = existing?.discardBytes ?? 0;
    let boundaryHash = existing?.boundaryHash ?? null;
    const totalBytesReadSoFar = existing?.totalBytesRead ?? 0;
    const createdAt = existing?.createdAt ?? new Date().toISOString();

    const establishPrefix = async (): Promise<void> => {
      prefixLen = Math.min(stat.size, FIXED_PREFIX_BYTES);
      prefixHash = prefixLen > 0 ? sha256Hex(await readExact(handle, 0, prefixLen)) : null;
    };
    const resetGeneration = async (): Promise<void> => {
      generation += 1;
      byteOffset = 0;
      discardPending = false;
      discardBytes = 0;
      boundaryHash = null;
      await establishPrefix();
    };

    if (!existing) {
      await establishPrefix();
    } else if (existing.dev !== dev || existing.ino !== ino || stat.size < byteOffset || stat.size < prefixLen) {
      // A different physical file at this path (replacement, e.g. log
      // rotation) or the same file shrunk below where we last stopped
      // (truncation). Either way, prior identities stay on record as
      // historical evidence; only this file's own cursor restarts.
      await resetGeneration();
    } else if (prefixLen === 0 && byteOffset === 0) {
      // The previous run saw an empty file, so there was no prefix to anchor
      // to. Anchor now, against content none of which has been read yet --
      // never by growing a short anchor into a longer one, which would
      // compare two different ranges and report a false replacement.
      await establishPrefix();
    } else if (prefixLen > 0) {
      const currentPrefix = sha256Hex(await readExact(handle, 0, prefixLen));
      if (currentPrefix !== prefixHash) await resetGeneration();
    }

    if (existing && generation === existing.generation && byteOffset > 0 && boundaryHash) {
      const windowStart = Math.max(0, byteOffset - BOUNDARY_WINDOW_BYTES);
      const currentWindow = sha256Hex(await readExact(handle, windowStart, byteOffset - windowStart));
      if (currentWindow !== boundaryHash) {
        // Content immediately before the cursor changed even though the
        // inode, size and fixed prefix all still look consistent -- an edit
        // this collector cannot safely resume past. Nothing is written: no
        // cursor move, no identities, no counters. The operator sees
        // "interrupted" and can investigate before the next run.
        return interrupted(cursorKey, existing, "boundary_changed");
      }
    }

    const batch = await readBoundedBatch(handle, stat.size, byteOffset, request.maxBytes, discardPending, discardBytes, request.afterChunk);

    if (request.afterRead) await request.afterRead();

    // Post-read validation, deliberately *after* the seam above so that a
    // mutation racing this run's write cannot slip past it.
    //
    // The whole ingested range is rehashed from disk and compared against the
    // hash accumulated while consuming it. Anchors alone are not enough: a
    // same-length rewrite between the fixed prefix and the trailing window
    // leaves both anchors intact while making the batch a mix of pre- and
    // post-edit content. Timestamps are not consulted at all -- an ordinary
    // append moves mtime too, and content equality is the stronger claim
    // anyway. Growth past the range we read is benign and stays allowed; a
    // shrink, an inode change, or a replacement of the path while this
    // descriptor stays open all cost the batch rather than half-importing it.
    const afterStat = await handle.stat();
    if (afterStat.dev !== stat.dev || afterStat.ino !== stat.ino || afterStat.size < stat.size) {
      return interrupted(cursorKey, existing, "changed_during_scan");
    }
    try {
      const nowAtPath = await lstat(canonicalPath);
      if (nowAtPath.dev !== stat.dev || nowAtPath.ino !== stat.ino) return interrupted(cursorKey, existing, "changed_during_scan");
    } catch {
      return interrupted(cursorKey, existing, "changed_during_scan");
    }
    const reread = await rehashRange(handle, byteOffset, batch.newByteOffset);
    if (batch.newByteOffset > byteOffset && reread !== batch.consumedHash) {
      return interrupted(cursorKey, existing, "changed_during_scan");
    }
    if (prefixLen > 0 && sha256Hex(await readExact(handle, 0, prefixLen)) !== prefixHash) {
      return interrupted(cursorKey, existing, "changed_during_scan");
    }
    // The boundary anchor for the next run: the window may reach back before
    // this run's range (a short batch), so it is read separately rather than
    // taken from the rehash above.
    const windowStart = Math.max(0, batch.newByteOffset - BOUNDARY_WINDOW_BYTES);
    const newBoundaryHash = batch.newByteOffset > 0 ? sha256Hex(await readExact(handle, windowStart, batch.newByteOffset - windowStart)) : null;

    const counters: Record<string, number> = {};
    const bump = (kind: string, delta = 1): void => { counters[kind] = (counters[kind] ?? 0) + delta; };

    const committedRun = store.withTransaction((): { raced: boolean; conflict?: "principal_conflict" | "source_conflict"; jobConflictIdentities: number } => {
      // Compare-and-set, under the write lock: every filesystem read above
      // happened outside it, so the only safe thing to do when the baseline
      // has moved is to abandon this run entirely. Returning here leaves the
      // transaction empty -- no stale cursor is written, no counter is
      // double-counted, and a retry reads the new baseline from scratch.
      if (!store.cursorRevisionMatches(cursorKey, baselineRevision)) return { raced: true, jobConflictIdentities: 0 };
      const current = store.getPathBinding(pathKey);
      if (current && current.sourceKey !== sourceKey) return { raced: false, conflict: "source_conflict", jobConflictIdentities: 0 };
      if (current && current.principalKey !== principalKey) return { raced: false, conflict: "principal_conflict", jobConflictIdentities: 0 };
      if (!current) store.bindPath({ pathKey, sourceKey, principalKey, createdAt: new Date().toISOString() });

      let jobConflictIdentities = 0;
      // The job claim is recorded per identity, not per file: the same
      // message arriving again from a copied transcript under a different
      // --job must not end up claimed by both. Shared between both vendor
      // branches below since it depends only on the identity key.
      const claimJob = (identityKey: string, identityOutcome: IdentityOutcome): void => {
        if (!jobKey || jobConflict || identityOutcome === "quarantined_new" || identityOutcome === "quarantined_repeat") return;
        if (store.bindIdentityJob(identityKey, jobKey) === "conflict") {
          jobConflictIdentities += 1;
          bump("job_conflict");
          store.incrementCounter(cursorKey, "job_conflict");
        }
      };

      for (const event of batch.events) {
        if (event.kind === "oversized") {
          bump("rejected:line_too_large");
          store.incrementCounter(cursorKey, "rejected:line_too_large");
          continue;
        }

        // "auto" resolves per line, never once for the whole file: a
        // "codex" detection routes to the Codex normalizer, and both
        // "claude" and "unknown" fall back to the Claude one (see
        // usage-format-detect.ts's module doc for why "unknown" defaults
        // there rather than getting its own rejection vocabulary).
        const lineVendor = request.vendor === "auto" ? (detectUsageLineFormat(event.text) === "codex" ? "codex" : "claude") : request.vendor;

        if (lineVendor === "codex") {
          const outcome = parseCodexUsageLine({ line: event.text, source: { principalKey, sourceKey }, sequence: 0 });
          if (outcome.kind === "skipped") {
            // Rate-limit observations riding along on a skipped line (e.g.
            // "rate_limit_only") are persisted below, independent of the
            // skip reason -- a single token_count event can be both
            // unidentified/cumulative (the skip reason) *and* carry a real
            // rate_limits block, and dropping the observations just because
            // the line itself has nothing accountable would silently lose
            // that half of its evidence (PR #57's "counted here but not yet
            // persisted anywhere" gap).
            bump(`skipped:${outcome.reason}`);
            store.incrementCounter(cursorKey, `skipped:${outcome.reason}`);
            if (outcome.observations.length) {
              store.persistRateLimitObservations(outcome.observations);
              bump("rate_limit_observed", outcome.observations.length);
              store.incrementCounter(cursorKey, "rate_limit_observed", outcome.observations.length);
            }
            continue;
          }
          if (outcome.kind === "rejected") {
            bump(`rejected:${outcome.reason}`);
            store.incrementCounter(cursorKey, `rejected:${outcome.reason}`);
            continue;
          }
          const identityOutcome: IdentityOutcome = store.applyAndPersistCodex(outcome.snapshot);
          bump(identityOutcome);
          store.incrementCounter(cursorKey, identityOutcome);
          claimJob(outcome.snapshot.identityKey, identityOutcome);
          if (outcome.observations.length) {
            store.persistRateLimitObservations(outcome.observations);
            bump("rate_limit_observed", outcome.observations.length);
            store.incrementCounter(cursorKey, "rate_limit_observed", outcome.observations.length);
          }
          continue;
        }

        const outcome = parseUsageLine({ line: event.text, source: { principalKey, sourceKey }, sequence: 0 });
        if (outcome.kind === "skipped") {
          bump(`skipped:${outcome.reason}`);
          store.incrementCounter(cursorKey, `skipped:${outcome.reason}`);
          continue;
        }
        if (outcome.kind === "rejected") {
          bump(`rejected:${outcome.reason}`);
          store.incrementCounter(cursorKey, `rejected:${outcome.reason}`);
          continue;
        }
        if (!isKnownClaudeModel(outcome.snapshot.model)) {
          bump("rejected:unknown_model");
          store.incrementCounter(cursorKey, "rejected:unknown_model");
          continue;
        }
        const identityOutcome: IdentityOutcome = store.applyAndPersist(outcome.snapshot);
        bump(identityOutcome);
        store.incrementCounter(cursorKey, identityOutcome);
        claimJob(outcome.snapshot.identityKey, identityOutcome);
      }

      const row: CursorRow = {
        cursorKey, sourceKey, principalKey,
        jobKey: nextJobKey,
        jobConflict,
        dev, ino, generation,
        revision: (baselineRevision ?? 0) + 1,
        byteOffset: batch.newByteOffset,
        prefixLen, prefixHash, boundaryHash: newBoundaryHash,
        discardPending: batch.discardPending, discardBytes: batch.discardBytes,
        atEof: batch.atEof, pendingPartial: batch.pendingPartial, budgetExhausted: batch.budgetExhausted,
        status: "ok",
        interruptReason: null,
        totalBytesRead: totalBytesReadSoFar + batch.bytesReadFromDisk,
        lastScanAt: new Date().toISOString(),
        createdAt,
      };
      store.putCursor(row);
      return { raced: false, jobConflictIdentities };
    });

    if (committedRun.raced) return interrupted(cursorKey, existing, "concurrent_update");
    if (committedRun.conflict) return conflict(committedRun.conflict, cursorKey, existing);

    return {
      kind: "imported",
      cursorKey,
      generation,
      byteOffset: batch.newByteOffset,
      bytesReadThisRun: batch.bytesReadFromDisk,
      atEof: batch.atEof,
      pendingPartial: batch.pendingPartial,
      budgetExhausted: batch.budgetExhausted,
      discardPending: batch.discardPending,
      jobConflict,
      jobConflictIdentities: committedRun.jobConflictIdentities,
      interruptReason: null,
      counters,
    };
  } finally {
    await handle.close();
  }
}
