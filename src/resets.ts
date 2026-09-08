/**
 * Time-to-reset countdowns, computed fresh at response time from an
 * observation's resets_at, never stored. An agent consuming Headroom's output
 * should not have to parse an ISO timestamp and subtract "now" itself.
 */

/** Full precision: minutes below an hour, hours+minutes below two days, days+hours beyond that. */
export function formatResetsIn(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/** Single largest unit only, for compact inline reasons like `can`'s output. */
export function formatResetsInCoarse(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Local HH:MM, no date -- for a short-horizon estimate (a next poll time,
 * a backoff deadline) where the day is always implicitly "soon" and adding
 * it would only be noise. cli.ts's own reset-time formatting adds a date
 * once the target isn't today; this helper is for estimates always close
 * enough that the date never matters. */
export function formatClockTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export interface ResetsIn { resets_in_seconds: number | null; resets_in: string | null; }

export function resetsIn(resetsAt: string | null | undefined, now = new Date()): ResetsIn {
  if (!resetsAt) return { resets_in_seconds: null, resets_in: null };
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return { resets_in_seconds: null, resets_in: null };
  const seconds = Math.max(0, Math.round((target - now.getTime()) / 1000));
  return { resets_in_seconds: seconds, resets_in: formatResetsIn(seconds) };
}

/** Attaches resets_in_seconds/resets_in to every observation, without mutating the input. */
export function withResetsIn<T extends { resets_at: string | null }>(observations: T[], now = new Date()): Array<T & ResetsIn> {
  return observations.map((item) => ({ ...item, ...resetsIn(item.resets_at, now) }));
}

/**
 * store.ts's `resetSeenFor` answers `Map<string, string>` (meter+window key
 * to the reset_seen event's `created_at`), a shape callers across the CLI,
 * the daemon RPC and status-view.ts all already forward as an opaque string
 * with no room to add a second field. An unscheduled reset (issue #20) still
 * needs to say so all the way through that same string, so the flag is
 * encoded into it here instead of widening the map's value type -- every
 * existing caller that just forwards or `new Date()`s the string keeps
 * compiling and working unchanged; only status-view.ts, which renders the
 * "(unscheduled)" note, needs to decode it. `UNSCHEDULED_SUFFIX` is not a
 * valid ISO 8601 character sequence, so it can never collide with a real
 * timestamp.
 */
const UNSCHEDULED_SUFFIX = "|unscheduled";

export function encodeResetSeen(at: string, unscheduled: boolean): string {
  return unscheduled ? `${at}${UNSCHEDULED_SUFFIX}` : at;
}

export interface DecodedResetSeen { at: string; unscheduled: boolean; }

export function decodeResetSeen(value: string): DecodedResetSeen {
  return value.endsWith(UNSCHEDULED_SUFFIX) ? { at: value.slice(0, -UNSCHEDULED_SUFFIX.length), unscheduled: true } : { at: value, unscheduled: false };
}
