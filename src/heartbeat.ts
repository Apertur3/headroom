/**
 * Orchestrator heartbeat leases and named wake-ups (issue: the P0 on
 * 2026-09-27 -- .claude/INCIDENT-2026-09-27-pty-leak.md -- where a crashed
 * orchestrator session took every in-session timer and watcher down with it,
 * and burn fell under 5%/h for 45 minutes before anything noticed). The
 * daemon is the one process that survives a session crash, so it holds both:
 * store.ts owns the SQLite rows and the lapse/event bookkeeping
 * (`heartbeatBeat`, `checkHeartbeatLapses`, `dueTimers`, `markTimerFired`,
 * ...); this module holds the two pieces that are not plain SQL --
 * `--at`'s ISO-or-relative parsing, and the async inbox delivery a due timer
 * needs, which store.ts's synchronous SQLite wrapper cannot do itself.
 *
 * Headroom never executes a timer's action text. `fireDueTimers` only ever
 * copies it into one inbox message and, when the owner's heartbeat is
 * lapsed and the timer asked for it, into one `timer_missed` event for the
 * notifier -- nothing here ever spawns, evals, or shells out to it.
 */
import { appendDaemonLog } from "./logs.js";
import { sendInboxMessage } from "./inbox.js";
import { safeError } from "./security.js";
import type { HeadroomStore } from "./store.js";

const RELATIVE_AT = /^\+(\d+)(s|m|h|d)$/;

/** `--at`'s two accepted spellings: an ISO instant, or `+<n><s|m|h|d>`
 * relative to `now`. Always returns a normalized ISO string, never the raw
 * input, so every stored `timers.at` is directly comparable and sortable. */
export function parseTimerAt(value: string, now = new Date()): string {
  const relative = RELATIVE_AT.exec(value.trim());
  if (relative) {
    const multiplier = relative[2] === "s" ? 1_000 : relative[2] === "m" ? 60_000 : relative[2] === "h" ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + Number(relative[1]) * multiplier).toISOString();
  }
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) throw new Error("--at must be an ISO instant or a relative duration like +30m, +2h, +1d");
  return new Date(parsed).toISOString();
}

/**
 * The daemon's per-poll firing pass. Every timer at or past `now` gets
 * exactly one inbox entry delivered to its owner's session -- the hand-off
 * channel orchestrators already share (inbox.ts) -- and `store.markTimerFired`
 * is what actually records "delivered", not the inbox write's own success:
 * a poll that raced this one and already advanced the row past `fired_at
 * IS NULL` simply has nothing left to send. A single timer whose inbox
 * write fails (a filesystem error, a malformed owner id) is logged and
 * skipped rather than losing every other due timer in the same pass.
 */
export async function fireDueTimers(store: HeadroomStore, home: string, now = new Date(), log: (message: string) => Promise<void> = (message) => appendDaemonLog(message, home)): Promise<number> {
  let fired = 0;
  for (const timer of store.dueTimers(now)) {
    try {
      await sendInboxMessage({
        to: timer.owner, kind: "handoff", from: "headroom-timer",
        text: JSON.stringify({ timer: timer.name, at: timer.at, action: timer.action }),
        home, now,
      });
      store.markTimerFired(timer.owner, timer.name, now);
      fired += 1;
    } catch (error) {
      await log(`timer ${timer.owner}/${timer.name} failed to deliver: ${safeError(error)}`);
    }
  }
  return fired;
}
