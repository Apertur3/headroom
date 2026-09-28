/**
 * Orchestrator heartbeat leases and named wake-ups: a crashed orchestrator
 * session takes every in-session timer and watcher down with it, and can go
 * unnoticed for as long as nobody happens to look. The daemon is the one
 * process that survives a session crash, so it holds both:
 * store.ts owns the SQLite rows and the lapse/event bookkeeping
 * (`heartbeatBeat`, `checkHeartbeatLapses`, `dueTimers`, `claimTimer`,
 * `unclaimTimer`, ...); this module holds the two pieces that are not plain
 * SQL --
 * `--at`'s ISO-or-relative parsing, and the async inbox delivery a due timer
 * needs, which store.ts's synchronous SQLite wrapper cannot do itself.
 *
 * Headroom never executes a timer's action text. `fireDueTimers` only ever
 * copies it into one inbox message and, when the owner's heartbeat is
 * lapsed and the timer asked for it, into one `timer_missed` event for the
 * notifier -- nothing here ever spawns, evals, or shells out to it.
 *
 * Each due timer is claimed (store.claimTimer, an atomic UPDATE guarded by
 * `fired_at IS NULL`) before its inbox write is even attempted, and released
 * again (store.unclaimTimer) only if that write fails. This is what makes
 * two overlapping firing passes -- a slow inbox write outlasting the
 * daemon's own poll throttle -- safe on their own: whichever pass's claim
 * lands first is the only one that ever delivers a given timer, and a
 * delivery that fails leaves the timer claimable again for a later pass
 * rather than silently losing it.
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
 * claimed (see this module's own doc comment) before its one inbox entry is
 * delivered to its owner's session -- the hand-off channel orchestrators
 * already share (inbox.ts). A timer a concurrent pass already claimed comes
 * back `undefined` from `claimTimer` and is simply skipped, never delivered
 * twice. A single timer whose inbox write fails (a filesystem error, a
 * malformed owner id) is logged, un-claimed so a later pass can retry it,
 * and skipped rather than losing every other due timer in the same pass.
 *
 * `send` is a test seam (defaults to the real `sendInboxMessage`): a test
 * that wants to exercise two genuinely overlapping passes -- not just two
 * calls that happen to run back to back -- injects a slow one and starts a
 * second pass while the first is still awaiting it.
 */
export async function fireDueTimers(store: HeadroomStore, home: string, now = new Date(), log: (message: string) => Promise<void> = (message) => appendDaemonLog(message, home), send: typeof sendInboxMessage = sendInboxMessage): Promise<number> {
  let fired = 0;
  for (const timer of store.dueTimers(now)) {
    const claimed = store.claimTimer(timer.owner, timer.name, now);
    if (!claimed) continue; // an overlapping pass already claimed (or cleared) it
    try {
      await send({
        to: claimed.owner, kind: "handoff", from: "headroom-timer",
        text: JSON.stringify({ timer: claimed.name, at: claimed.at, action: claimed.action }),
        home, now,
      });
      fired += 1;
    } catch (error) {
      store.unclaimTimer(claimed.owner, claimed.name, claimed.fired_at!);
      await log(`timer ${claimed.owner}/${claimed.name} failed to deliver: ${safeError(error)}`);
    }
  }
  return fired;
}
