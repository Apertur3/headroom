/**
 * A per-session hand-off inbox under `<HEADROOM_HOME>/inbox/<session-id>/`.
 *
 * Several orchestrators sharing one account already share a meter, a lease
 * table and a spend ledger; what they have no way to do is leave each other a
 * structured note ("I am taking 40% of the weekly window until 18:00", "here
 * is the lane you asked me to pick up"). This is that channel, deliberately
 * built out of the filesystem rather than the database: a message is one
 * small file another process can drop without holding the SQLite writer, and
 * reading it is a directory scan with no lock at all.
 *
 * Everything here stays inside the verified Headroom home. A session id is a
 * single path segment matched against a strict allowlist -- and `.` and `..`,
 * which that allowlist would otherwise admit, are refused by name -- with the
 * resolved directory re-checked to be an immediate child of the inbox root,
 * so a caller-supplied id can never walk out of it. Both the root and each
 * session directory are created 0700, messages are written 0600 through the
 * shared atomic writer, and every read is bounded by the same 64 KiB cap the
 * rest of the codebase applies to files it did not write itself.
 */
import { lstat, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isReservedSessionId, readBoundedRegularFile, safeOutputDirectory, serializeInboxEnvelope, writeFileAtomic, SAFE_READ_MAX_BYTES, SESSION_ID_PATTERN } from "./security.js";
import { safeHeadroomDirectory } from "./store.js";

export const INBOX_KINDS = ["budget", "note", "handoff"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Re-exported from security.js, which now hosts the pattern so store.ts's
 * timer owner validation can share it without importing this module (see
 * security.ts's own doc comment on SESSION_ID_PATTERN for why). */
export { SESSION_ID_PATTERN };

/** Bytes accepted for one message body, matching security.ts's own bound. */
export const MAX_INBOX_MESSAGE_BYTES = SAFE_READ_MAX_BYTES;

/** Messages returned by one `inbox` read. A backlog larger than this is not
 * an error: the rest stays queued and is reported as `remaining`. */
export const MAX_INBOX_READ = 200;

/** The suffix a message file gains once it has been handed to its reader. */
const READ_SUFFIX = ".read";

export interface InboxMessage {
  file: string;
  session: string;
  kind: InboxKind;
  /** Milliseconds since the epoch, from the filename -- the ordering key. */
  at_epoch: number;
  at: string;
  from: string | null;
  /** The sender's payload: the parsed value when it was valid JSON, the raw
   * text otherwise. */
  body: unknown;
}

export interface InboxReadResult {
  session: string;
  messages: InboxMessage[];
  remaining: number;
}

export function isInboxKind(value: string): value is InboxKind {
  return (INBOX_KINDS as readonly string[]).includes(value);
}

/** Refuses anything that is not a plain single path segment. `.` and `..`
 * match the character class but are directory references, not names, so they
 * are rejected explicitly rather than left to the traversal check below. */
export function assertSessionId(value: string): string {
  const session = value.trim();
  if (!SESSION_ID_PATTERN.test(session)) throw new Error("session id must be 1 to 64 characters of A-Z a-z 0-9 . _ -");
  if (isReservedSessionId(session)) throw new Error("session id must not be a directory reference");
  return session;
}

export function inboxRoot(home: string): string { return join(home, "inbox"); }

/** The verified, 0700 directory for one session, created if absent. The
 * resolved path is re-checked to be an immediate child of the inbox root, so
 * a session id that somehow satisfied the pattern yet still resolved
 * elsewhere is refused rather than written to. */
export async function sessionDirectory(session: string, home?: string): Promise<string> {
  const id = assertSessionId(session);
  const base = home ?? await safeHeadroomDirectory();
  const root = await safeOutputDirectory(inboxRoot(base));
  const directory = resolve(root, id);
  if (directory !== join(resolve(root), id)) throw new Error("refusing session id outside the inbox directory");
  return safeOutputDirectory(directory);
}

/** `<epoch>-<kind>.json`, with the epoch advanced on collision so two
 * messages of the same kind written in the same millisecond both survive
 * instead of one overwriting the other. */
async function freeMessagePath(directory: string, kind: InboxKind, epoch: number): Promise<{ path: string; file: string }> {
  for (let candidate = epoch; candidate < epoch + 1000; candidate += 1) {
    const file = `${candidate}-${kind}.json`;
    const path = join(directory, file);
    // A name is free only when neither the unread file nor its already-read
    // counterpart holds it, so a redelivered millisecond cannot overwrite a
    // message the recipient has read but not yet cleaned up.
    if (await absent(path) && await absent(`${path}${READ_SUFFIX}`)) return { path, file };
  }
  throw new Error("could not find a free message name in this millisecond range");
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export interface SendOptions {
  to: string;
  kind: InboxKind;
  text: string;
  from?: string | null;
  home?: string;
  now?: Date;
}

function validateSendOptions(options: Pick<SendOptions, "to" | "kind" | "text" | "from">): { session: string; from: string | null } {
  const session = assertSessionId(options.to);
  const from = options.from ? assertSessionId(options.from) : null;
  if (!isInboxKind(options.kind)) throw new Error(`kind must be one of ${INBOX_KINDS.join(", ")}`);
  const bytes = Buffer.byteLength(options.text, "utf8");
  if (!bytes) throw new Error("message body is empty");
  if (bytes > MAX_INBOX_MESSAGE_BYTES) throw new Error(`message body is ${bytes} bytes, over the ${MAX_INBOX_MESSAGE_BYTES} byte cap`);
  return { session, from };
}

/** Writes one message atomically, 0600, into the recipient's inbox. */
export async function sendInboxMessage(options: SendOptions): Promise<{ path: string; file: string; session: string }> {
  const { session, from } = validateSendOptions(options);
  const now = options.now ?? new Date();
  const directory = await sessionDirectory(session, options.home);
  const { path, file } = await freeMessagePath(directory, options.kind, now.getTime());
  await writeFileAtomic(path, serializeInboxEnvelope({ kind: options.kind, to: session, from, at: now.toISOString(), body: parseBody(options.text) }), 0o600);
  return { path, file, session };
}

export interface SendAtOptions extends SendOptions {
  /** A unique identity for this exact delivery, generated once by store.ts's
   * `setTimer` and persisted on the timer row (never derived here, and never
   * shared with any other timer or ordinary handoff) -- in place of
   * `sendInboxMessage`'s own "now.getTime(), advance on collision"
   * numbering, which both collides across distinct messages that happen to
   * land in the same window and cannot be idempotent (it is different on
   * every call). Appended as its own filename component (see
   * `parseMessageName` below) and carried in the envelope's own
   * `delivery_id` field, so a retried delivery -- which necessarily runs at
   * a different wall-clock instant than the original attempt, and so gets a
   * different leading `<epoch-ms>` -- can still be recognized as the same
   * delivery by identity, not by path. Used by src/heartbeat.ts's
   * fireDueTimers so a timer retried after a crash or a timeout (claimed,
   * possibly delivered, but never confirmed durable) is never delivered
   * twice. */
  delivery_id: number;
}

/*
 * A timer delivery's filename is `<epoch-ms>-<delivery_id>-<kind>.json` --
 * keeping the real timestamp (the delivery attempt's own send time) in the
 * documented `<epoch-ms>` position, so `at_epoch`, oldest-first ordering and
 * `--since` all keep working exactly like an ordinary hand-off's
 * `<epoch-ms>-<kind>.json`. The delivery id is a second, separate
 * component, appended rather than substituted -- it never collides with an
 * ordinary hand-off's filename shape (which has no middle numeric component
 * at all), and it is what idempotency is keyed on, not the timestamp, since
 * a retry's own send time differs from the original attempt's. See
 * `parseMessageName`'s own regex for both shapes.
 */

/** Every file already on disk (unread, or read and renamed with
 * READ_SUFFIX) for this exact `kind`/`deliveryId`, regardless of the
 * `<epoch-ms>` a previous attempt happened to send it under -- a directory
 * scan, not a single-path check, precisely because a retry's own send time
 * (and so its own filename) legitimately differs from the original
 * attempt's. At most one is expected under normal operation; the first
 * found is treated as authoritative -- but only once its own envelope
 * confirms it: the filename is what THIS scan searches by, never what it
 * trusts. A corrupt file, or a genuine collision with some unrelated
 * message that happens to carry a matching kind and delivery id in its own
 * name, must never be mistaken for this exact delivery already landing --
 * that would report `delivered: false` for a delivery that never actually
 * happened, and (via fireDueTimers's confirmTimerDelivered) let a timer be
 * marked fired without its action ever reaching its owner. The envelope's
 * own `delivery_id` field is the one place that identity is written under
 * the writer's control (serializeInboxEnvelope), so it -- and the `kind` and
 * `to` fields alongside it -- has to agree with what this scan is actually
 * looking for before the file is trusted. A file this scan cannot read back
 * at all (gone since the directory listing, or genuinely corrupt) is
 * skipped, not thrown on: it is not proof of anything either way, and the
 * caller's own write attempt will simply proceed past it. A file that DOES
 * parse but disagrees on identity is the one case worth failing loud on. */
async function findExistingDelivery(directory: string, kind: InboxKind, deliveryId: number, to: string): Promise<{ path: string; file: string } | undefined> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  for (const entry of entries) {
    const bare = entry.endsWith(READ_SUFFIX) ? entry.slice(0, -READ_SUFFIX.length) : entry;
    const parsed = parseMessageName(bare);
    if (!parsed || parsed.kind !== kind || parsed.deliveryId !== deliveryId) continue;
    const path = join(directory, entry);
    let raw: string;
    try { raw = await readBoundedRegularFile(path); }
    catch { continue; } // gone or unreadable since the directory listing above; not proof of anything
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { continue; } // not a name match worth trusting either
    const record = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope as Record<string, unknown> : {};
    if (record.delivery_id === deliveryId && record.kind === kind && record.to === to) return { path, file: entry };
    throw new Error(`inbox file ${entry} matches delivery ${deliveryId} by name but not by envelope content`);
  }
  return undefined;
}

/** Every currently in-flight `sendInboxMessageAt` call, keyed by exactly
 * what identifies one delivery (home/session/kind/delivery_id). A second
 * call for the same key -- a genuinely concurrent retry, or a crash-
 * recovery retry that starts while the original attempt (its own send
 * merely slow, not actually dead -- fireDueTimers's own delivery timeout
 * only stops AWAITING it, it does not cancel it) is still running -- joins
 * the SAME promise instead of racing its own independent
 * check-then-write against it. Without this, two overlapping attempts
 * could both see "no file yet" (`findExistingDelivery` finding nothing
 * because the first attempt's write has not landed yet) and both write --
 * or the first's file could be read and renamed to `.read` in the gap
 * between the second's own check and its write, making the delivery
 * reappear as a second, fresh, unread message. Cleared once the attempt
 * itself settles (success or failure), independent of whether any
 * particular caller is still awaiting it. */
const inFlightTimerDeliveries = new Map<string, Promise<{ path: string; file: string; session: string; delivered: boolean }>>();

/**
 * The idempotent-by-identity counterpart of `sendInboxMessage`. Calling
 * this twice for the same `to`/`kind`/`delivery_id` -- whether truly
 * concurrent, or a later crash/timeout-recovery retry -- is safe: see
 * `inFlightTimerDeliveries`'s own doc comment for how a still-running
 * attempt is joined rather than duplicated, and `findExistingDelivery`'s
 * for how an already-completed one (found by identity, not by the exact
 * path a retry would otherwise have to guess) is recognized instead of
 * re-sent.
 */
export async function sendInboxMessageAt(options: SendAtOptions): Promise<{ path: string; file: string; session: string; delivered: boolean }> {
  const { session, from } = validateSendOptions(options);
  if (!Number.isInteger(options.delivery_id) || options.delivery_id < 0) throw new Error("delivery_id must be a non-negative integer");
  const key = `${options.home ?? ""}\u0000${session}\u0000${options.kind}\u0000${options.delivery_id}`;
  const inFlight = inFlightTimerDeliveries.get(key);
  if (inFlight) return inFlight;
  const attempt = (async (): Promise<{ path: string; file: string; session: string; delivered: boolean }> => {
    const now = options.now ?? new Date();
    const directory = await sessionDirectory(session, options.home);
    const existing = await findExistingDelivery(directory, options.kind, options.delivery_id, session);
    if (existing) return { path: existing.path, file: existing.file, session, delivered: false };
    const file = `${now.getTime()}-${options.delivery_id}-${options.kind}.json`;
    const path = join(directory, file);
    await writeFileAtomic(path, serializeInboxEnvelope({ kind: options.kind, to: session, from, at: now.toISOString(), deliveryId: options.delivery_id, body: parseBody(options.text) }), 0o600);
    return { path, file, session, delivered: true };
  })();
  inFlightTimerDeliveries.set(key, attempt);
  try { return await attempt; }
  finally { inFlightTimerDeliveries.delete(key); }
}

function parseBody(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

/** `<epoch-ms>-<kind>.json` (an ordinary hand-off) or
 * `<epoch-ms>-<delivery_id>-<kind>.json` (a timer delivery) for a known
 * kind, or undefined for any other name --
 * a stray file in the directory is skipped, never guessed at. `[a-z]+`
 * never matches a digit, so the two shapes are never ambiguous: the
 * (optional) middle numeric group only ever consumes a genuine
 * `-<digits>-` run immediately before the kind. */
function parseMessageName(file: string): { epoch: number; deliveryId: number | null; kind: InboxKind } | undefined {
  const match = /^(\d{1,15})-(?:(\d{1,19})-)?([a-z]+)\.json$/.exec(file);
  if (!match || !isInboxKind(match[3])) return undefined;
  const epoch = Number(match[1]);
  const deliveryId = match[2] === undefined ? null : Number(match[2]);
  return Number.isFinite(epoch) && (deliveryId === null || Number.isFinite(deliveryId)) ? { epoch, deliveryId, kind: match[3] } : undefined;
}

export interface ReadOptions {
  session: string;
  /** Milliseconds since the epoch; only messages at or after it are returned. */
  since?: number;
  home?: string;
  /** False leaves the messages unread, for a caller that only wants to look. */
  markRead?: boolean;
}

/**
 * Unread messages for one session, oldest first, each marked read by renaming
 * it with a `.read` suffix once its content has been handed back. The rename
 * happens after the read, so a message whose file could not be parsed is
 * skipped and left in place rather than silently consumed.
 */
export async function readInbox(options: ReadOptions): Promise<InboxReadResult> {
  const session = assertSessionId(options.session);
  const directory = await sessionDirectory(session, options.home);
  const entries = await readdir(directory);
  const candidates = entries
    .flatMap((file) => { const parsed = parseMessageName(file); return parsed ? [{ file, ...parsed }] : []; })
    .filter((item) => options.since === undefined || item.epoch >= options.since)
    .sort((a, b) => a.epoch - b.epoch || a.file.localeCompare(b.file));
  const messages: InboxMessage[] = [];
  for (const candidate of candidates.slice(0, MAX_INBOX_READ)) {
    const path = join(directory, candidate.file);
    let raw: string;
    try { raw = await readBoundedRegularFile(path, MAX_INBOX_MESSAGE_BYTES); }
    catch { continue; }
    const envelope = parseBody(raw);
    const record = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope as Record<string, unknown> : {};
    messages.push({
      file: candidate.file, session, kind: candidate.kind, at_epoch: candidate.epoch,
      at: typeof record.at === "string" ? record.at : new Date(candidate.epoch).toISOString(),
      from: typeof record.from === "string" ? record.from : null,
      body: "body" in record ? record.body : envelope,
    });
    if (options.markRead !== false) await rename(path, `${path}${READ_SUFFIX}`);
  }
  return { session, messages, remaining: Math.max(0, candidates.length - messages.length) };
}
