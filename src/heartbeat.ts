/**
 * Orchestrator heartbeat leases and named wake-ups: a crashed orchestrator
 * session takes every in-session timer and watcher down with it, and can go
 * unnoticed for as long as nobody happens to look. The daemon is the one
 * process that survives a session crash, so it holds both:
 * store.ts owns the SQLite rows and the lapse/event bookkeeping
 * (`heartbeatBeat`, `checkHeartbeatLapses`, `dueTimers`, `claimTimer`,
 * `confirmTimerDelivered`, `releaseTimerClaim`, `reclaimStaleTimerClaims`,
 * ...); this module holds the two pieces that are not plain SQL -- `--at`'s
 * ISO-or-relative parsing, and the async inbox delivery a due timer needs,
 * which store.ts's synchronous SQLite wrapper cannot do itself.
 *
 * Headroom never executes a timer's action text. `fireDueTimers` only ever
 * copies it into one inbox message and, when the owner's heartbeat is
 * lapsed and the timer asked for it, into one `timer_missed` event for the
 * notifier -- nothing here ever spawns, evals, or shells out to it.
 *
 * Each due timer is claimed (store.claimTimer, a *recoverable* claim -- see
 * its own doc comment) before its inbox write is even attempted. The
 * terminal `fired_at` is set only afterward, by `confirmTimerDelivered`,
 * once the inbox message is known durable -- so a crash between the claim
 * and the confirm (this process dying, or the daemon's own `stop()` closing
 * the store mid-delivery) never leaves a timer both undelivered and
 * unrecoverable: the claim simply goes stale and a later pass (or a fresh
 * daemon process, via `reclaimStaleTimerClaims`) tries again. That retry is
 * safe even if the original attempt's inbox write actually landed just
 * before the crash: `sendInboxMessageAt`'s deterministic, identity-based
 * filename makes the write itself idempotent, so a retried delivery for the
 * same claim never produces a second inbox entry.
 */
import { createHash } from "node:crypto";
import { appendDaemonLog } from "./logs.js";
import { sendInboxMessageAt } from "./inbox.js";
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
 * A deterministic inbox message identity for one timer's delivery, stable
 * across every retry of the same (owner, name, at) row -- what makes
 * `sendInboxMessageAt` able to recognize a re-delivery attempt and skip
 * writing a duplicate rather than creating a second inbox entry. Built from
 * the timer's own `at` (so the message still sorts close to when it was
 * actually due, same as a plain send's `now.getTime()` would) with the low
 * 3 digits replaced by a hash of `name`: `at` alone does not disambiguate
 * two different timers for the same owner sharing the same due instant.
 */
export function timerMessageEpoch(name: string, at: string): number {
  const base = Date.parse(at);
  const suffix = createHash("sha256").update(name, "utf8").digest().readUInt16BE(0) % 1000;
  return base - (base % 1000) + suffix;
}

/**
 * The daemon's per-maintenance-pass firing pass. Every timer at or past
 * `now` gets claimed (see this module's own doc comment) before its one
 * inbox entry is delivered to its owner's session -- the hand-off channel
 * orchestrators already share (inbox.ts). A timer a concurrent pass already
 * claimed, or whose claim is still fresh, comes back `undefined` from
 * `claimTimer` and is simply skipped, never delivered twice. A single timer
 * whose inbox write fails (a filesystem error) is logged, its claim
 * released so a later pass can retry it (bounded -- see store.ts's
 * MAX_TIMER_DELIVERY_ATTEMPTS), and skipped rather than losing every other
 * due timer in the same pass.
 *
 * `send` is a test seam (defaults to the real `sendInboxMessageAt`): a test
 * that wants to exercise two genuinely overlapping passes, or a crash
 * between claim and delivery, injects a slow or throwing one.
 */
export async function fireDueTimers(store: HeadroomStore, home: string, now = new Date(), log: (message: string) => Promise<void> = (message) => appendDaemonLog(message, home), send: typeof sendInboxMessageAt = sendInboxMessageAt): Promise<number> {
  let fired = 0;
  for (const timer of store.dueTimers(now)) {
    const claimed = store.claimTimer(timer.owner, timer.name, now);
    if (!claimed) continue; // an overlapping pass already claimed it, or its claim is still fresh
    try {
      await send({
        to: claimed.owner, kind: "handoff", from: "headroom-timer",
        text: JSON.stringify({ timer: claimed.name, at: claimed.at, action: claimed.action }),
        at_epoch: timerMessageEpoch(claimed.name, claimed.at),
        home, now,
      });
      // Durable only once the message is confirmed on disk -- freshly
      // written just now, or already there from an earlier attempt this
      // same idempotent send recognized (see sendInboxMessageAt's own doc
      // comment). confirmTimerDelivered is a no-op (false) if a different
      // pass already closed this exact claim out first; `fired` only counts
      // the call that actually did.
      if (store.confirmTimerDelivered(claimed.owner, claimed.name, claimed.claim_token, now)) fired += 1;
    } catch (error) {
      // Bounded retry (store.ts's own MAX_TIMER_DELIVERY_ATTEMPTS): past the
      // limit, releaseTimerClaim sets failed_at instead of releasing the
      // claim, so dueTimers() never offers this row again -- an
      // undeliverable timer (an invalid owner, an oversized action) stops
      // being retried on every future maintenance pass rather than forever.
      const outcome = store.releaseTimerClaim(claimed.owner, claimed.name, claimed.claim_token, now);
      const reason = safeError(error);
      await log(outcome?.permanentlyFailed
        ? `timer ${claimed.owner}/${claimed.name} permanently failed after ${outcome.attempts} delivery attempts, giving up: ${reason}`
        : `timer ${claimed.owner}/${claimed.name} failed to deliver (attempt ${outcome?.attempts ?? "?"}): ${reason}`);
    }
  }
  return fired;
}
