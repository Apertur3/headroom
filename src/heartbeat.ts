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
 * before the crash: `sendInboxMessageAt`'s identity-verified filename (keyed
 * by the timer's own unique, persisted `delivery_id`, see store.ts's
 * `claimTimer`/`setTimer`) makes the write itself idempotent, so a retried
 * delivery for the same claim never produces a second inbox entry.
 */
import { appendDaemonLog } from "./logs.js";
import { sendInboxMessageAt } from "./inbox.js";
import { safeError, TIMER_DELIVERY_FROM, TIMER_DELIVERY_KIND } from "./security.js";
import type { HeadroomStore } from "./store.js";

const RELATIVE_AT = /^\+(\d+)(s|m|h|d)$/;

/** How long fireDueTimers waits for one timer's inbox write before giving
 * up on that specific attempt and moving on to the next due timer -- see
 * fireDueTimers's own doc comment for what happens to the claim after a
 * timeout. Generous relative to a local filesystem write (normally well
 * under a second) while still bounding the whole pass -- and the daemon's
 * maintenance scheduler, which awaits it -- against a single stuck delivery
 * blocking every other timer and every heartbeat check behind it. */
export const DELIVERY_TIMEOUT_MS = 10_000;

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
 *
 * Each delivery is itself bounded by `deliveryTimeoutMs`: a `send` call that
 * never settles at all (a stuck filesystem, not merely a slow one) would
 * otherwise leave this whole pass -- and every other due timer still queued
 * behind it -- waiting forever, and the daemon's own maintenance scheduler
 * awaits this same pass before it can re-arm for the next one (see
 * daemon.ts's own bounded wait around `timerFiringInFlight`). On timeout
 * this simply moves on without confirming or releasing the claim: its true
 * outcome is unknown (the write may still land after this function returns,
 * unobserved), so the claim is left exactly as a crash would leave it --
 * recoverable once it goes stale (`TIMER_CLAIM_STALE_MS`), and safe to retry
 * either way because `sendInboxMessageAt`'s delivery-id verification makes a
 * retry idempotent even if the abandoned attempt's write does eventually
 * succeed.
 *
 * `clock` supplies the timestamp for each individual claim, send and
 * confirm/release -- deliberately NOT the same instant as this pass's own
 * `now` (which only decides WHICH timers are due for this pass, via
 * `dueTimers(now)`). A pass can take real, unbounded wall-clock time to run
 * (one timer's own delivery can take up to `deliveryTimeoutMs`, and a pass
 * with several due timers serializes them); stamping every one of them with
 * the single instant the pass happened to start would let a later timer in
 * the same pass land on disk, in real time, strictly after some ordinary
 * hand-off written meanwhile -- yet carry an OLDER epoch in its own
 * filename than that hand-off, since the pass's frozen `now` predates it.
 * A `--since` cursor taken right after that hand-off would then wrongly
 * skip the timer message a moment later, even though it had not been
 * written yet when the cursor was read. Defaults to returning this pass's
 * own `now` unchanged -- exactly today's (pre-fix) behavior -- so every
 * caller that does not pass an explicit clock (every test that predates
 * this) is unaffected; only a caller that wants each timestamp to reflect
 * real elapsed time (daemon.ts's own production call site) supplies
 * `() => new Date()`.
 */
export async function fireDueTimers(store: HeadroomStore, home: string, now = new Date(), log: (message: string) => Promise<void> = (message) => appendDaemonLog(message, home), send: typeof sendInboxMessageAt = sendInboxMessageAt, deliveryTimeoutMs = DELIVERY_TIMEOUT_MS, clock: () => Date = () => now, logTimeoutMs = LOG_TIMEOUT_MS): Promise<number> {
  let fired = 0;
  for (const timer of store.dueTimers(now)) {
    // The snapshot's own delivery_id, not just its owner/name: a later
    // registration for the same owner+name (replacing this exact due entry
    // while an earlier delivery in this same pass is still in flight) must
    // never be claimed and delivered under this snapshot entry's place --
    // see claimTimer's own doc comment.
    const claimed = store.claimTimer(timer.owner, timer.name, clock(), undefined, timer.delivery_id);
    if (!claimed) continue; // an overlapping pass already claimed it, or its claim is still fresh
    const sendAt = clock();
    const sendPromise = send({
      to: claimed.owner, kind: TIMER_DELIVERY_KIND, from: TIMER_DELIVERY_FROM,
      text: JSON.stringify({ timer: claimed.name, at: claimed.at, action: claimed.action }),
      delivery_id: claimed.delivery_id,
      home, now: sendAt, inFlightTimeoutMs: deliveryTimeoutMs,
    });
    // A late settlement from an abandoned (timed-out) attempt is expected,
    // not a defect: by the time it happens this loop has already moved on,
    // and nothing here awaits it a second time. Without this, Node would
    // report an unhandled rejection for a `send` that eventually fails
    // after its own timeout already gave up on it.
    sendPromise.catch(() => { /* handled by the race below, or abandoned on timeout */ });
    try {
      const timedOut = await raceDeliveryTimeout(sendPromise, deliveryTimeoutMs);
      if (timedOut) {
        await safeLog(log, `timer ${claimed.owner}/${claimed.name} delivery timed out after ${deliveryTimeoutMs}ms; abandoning this attempt, its claim will go stale and be retried`, logTimeoutMs);
        continue;
      }
      // Durable only once the message is confirmed on disk -- freshly
      // written just now, or already there from an earlier attempt this
      // same idempotent send recognized (see sendInboxMessageAt's own doc
      // comment). confirmTimerDelivered is a no-op (false) if a different
      // pass already closed this exact claim out first; `fired` only counts
      // the call that actually did.
      if (store.confirmTimerDelivered(claimed.owner, claimed.name, claimed.claim_token, clock())) fired += 1;
    } catch (error) {
      // Bounded retry (store.ts's own MAX_TIMER_DELIVERY_ATTEMPTS): past the
      // limit, releaseTimerClaim sets failed_at instead of releasing the
      // claim, so dueTimers() never offers this row again -- an
      // undeliverable timer (an invalid owner, an oversized action) stops
      // being retried on every future maintenance pass rather than forever.
      const outcome = store.releaseTimerClaim(claimed.owner, claimed.name, claimed.claim_token, clock());
      const reason = safeError(error);
      await safeLog(log, outcome?.permanentlyFailed
        ? `timer ${claimed.owner}/${claimed.name} permanently failed after ${outcome.attempts} delivery attempts, giving up: ${reason}`
        : `timer ${claimed.owner}/${claimed.name} failed to deliver (attempt ${outcome?.attempts ?? "?"}): ${reason}`, logTimeoutMs);
    }
  }
  return fired;
}

/** How long `safeLog` waits for one `log` call before giving up on it and
 * moving on -- generous relative to appendDaemonLog's own local file
 * append, while still bounding this loop against a logger that never
 * settles at all. */
const LOG_TIMEOUT_MS = 2_000;

/** Wraps a `fireDueTimers` log call so neither a rejecting nor a never-
 * settling `log` can take this loop down with it. By the time this runs,
 * the due timer it describes has already been claimed and either delivered
 * or released -- that outcome is real and already durable in the store;
 * losing the ONE log line describing it to an unrelated logging problem
 * (a full disk, a broken custom `log` test double, or any other) is a far
 * smaller loss than aborting the rest of this pass -- every other due timer
 * still queued behind it -- over a log write, or hanging this pass (and so
 * the daemon's own maintenance scheduler, which awaits it) forever on one
 * that never settles. Bounded the same way a delivery itself already is
 * (see DELIVERY_TIMEOUT_MS/raceDeliveryTimeout): a `log` call abandoned on
 * timeout is left running, unobserved, its own eventual rejection or
 * resolution already swallowed by the `.catch` below. */
async function safeLog(log: (message: string) => Promise<void>, message: string, timeoutMs: number): Promise<void> {
  await Promise.race([
    log(message).catch(() => { /* a broken logger must never fail this loop */ }),
    new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]);
}

/** Races `promise` against a `timeoutMs` timer; returns `true` when the
 * timeout wins (the promise is left running, unobserved, exactly as
 * fireDueTimers's own doc comment describes), `false` when `promise` itself
 * settles first. A rejection from `promise` before the timeout propagates
 * normally through `Promise.race`, unaffected by this wrapper. */
async function raceDeliveryTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timedOut = false;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([promise, timeout]);
  clearTimeout(timer!);
  return timedOut;
}
