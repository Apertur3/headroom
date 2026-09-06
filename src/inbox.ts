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
import { readBoundedRegularFile, safeOutputDirectory, writeFileAtomic, SAFE_READ_MAX_BYTES } from "./security.js";
import { safeHeadroomDirectory } from "./store.js";

export const INBOX_KINDS = ["budget", "note", "handoff"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** One path segment, no separators, no drive letters, no percent escapes. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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
  if (session === "." || session === "..") throw new Error("session id must not be a directory reference");
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

/** Writes one message atomically, 0600, into the recipient's inbox. */
export async function sendInboxMessage(options: SendOptions): Promise<{ path: string; file: string; session: string }> {
  const session = assertSessionId(options.to);
  const from = options.from ? assertSessionId(options.from) : null;
  if (!isInboxKind(options.kind)) throw new Error(`kind must be one of ${INBOX_KINDS.join(", ")}`);
  const bytes = Buffer.byteLength(options.text, "utf8");
  if (!bytes) throw new Error("message body is empty");
  if (bytes > MAX_INBOX_MESSAGE_BYTES) throw new Error(`message body is ${bytes} bytes, over the ${MAX_INBOX_MESSAGE_BYTES} byte cap`);
  const now = options.now ?? new Date();
  const directory = await sessionDirectory(session, options.home);
  const { path, file } = await freeMessagePath(directory, options.kind, now.getTime());
  const envelope = { version: 1, kind: options.kind, to: session, from, at: now.toISOString(), body: parseBody(options.text) };
  await writeFileAtomic(path, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  return { path, file, session };
}

function parseBody(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

/** `<epoch>-<kind>.json` for a known kind, or undefined for any other name --
 * a stray file in the directory is skipped, never guessed at. */
function parseMessageName(file: string): { epoch: number; kind: InboxKind } | undefined {
  const match = /^(\d{1,15})-([a-z]+)\.json$/.exec(file);
  if (!match || !isInboxKind(match[2])) return undefined;
  const epoch = Number(match[1]);
  return Number.isFinite(epoch) ? { epoch, kind: match[2] } : undefined;
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
