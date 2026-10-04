/**
 * Orchestrator heartbeat leases and named wake-ups.
 * Covers store.ts's heartbeat/timer persistence and lapse/fire bookkeeping,
 * src/heartbeat.ts's inbox delivery, and the notifier picking up
 * heartbeat_lapsed/heartbeat_restored/timer_missed the same way it already
 * picks up every other event kind (quiet hours, one-message-per-lapse
 * dedupe).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import { fireDueTimers, parseTimerAt } from "../src/heartbeat.js";
import { readInbox, sendInboxMessage, sendInboxMessageAt } from "../src/inbox.js";
import { handleMcp } from "../src/mcp.js";
import { deliverNotifications, parseNotifyConfig, type CommandRunner, type NotifyConfig, type NotifyOptions } from "../src/notify.js";
import { HeadroomStore, MAX_TIMER_DELIVERY_ATTEMPTS, TIMER_CLAIM_STALE_MS } from "../src/store.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function tempHome(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return join(root, ".headroom");
}

async function openStore(prefix: string): Promise<{ store: HeadroomStore; home: string }> {
  const home = await tempHome(prefix);
  return { store: await HeadroomStore.open(home), home };
}

// ---------------------------------------------------------------------------
// store.ts: heartbeat record/refresh/stop
// ---------------------------------------------------------------------------

// HeadroomStore.db is private; this is the slice of its sqlite handle the test reaches into.
type RawDb = { prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[] } };

describe("heartbeat record/refresh/stop", () => {
  it("records, refreshes (keeping the resume sentence when omitted), and stops", async () => {
    const { store } = await openStore("headroom-heartbeat-basic-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const created = store.heartbeatBeat("orch-a", 5 * 60_000, "resume: check PR #78 CI", start);
      expect(created).toMatchObject({ owner: "orch-a", interval_ms: 300_000, resume_sentence: "resume: check PR #78 CI", started_at: start.toISOString(), last_beat_at: start.toISOString(), lapsed_since: null });

      const later = new Date(start.getTime() + 60_000);
      const refreshed = store.heartbeatBeat("orch-a", 300_000, undefined, later);
      expect(refreshed.resume_sentence).toBe("resume: check PR #78 CI");
      expect(refreshed.last_beat_at).toBe(later.toISOString());
      expect(refreshed.started_at).toBe(start.toISOString());

      const cleared = store.heartbeatBeat("orch-a", 300_000, null, later);
      expect(cleared.resume_sentence).toBeNull();

      expect(store.heartbeats()).toHaveLength(1);
      expect(store.heartbeatStop("orch-a")).toBe(true);
      expect(store.heartbeatStop("orch-a")).toBe(false);
      expect(store.heartbeats()).toHaveLength(0);
    } finally { store.close(); }
  });

  it("rejects a blank owner and a non-positive interval", async () => {
    const { store } = await openStore("headroom-heartbeat-invalid-");
    try {
      expect(() => store.heartbeatBeat("  ", 1000, null)).toThrow(/owner/);
      expect(() => store.heartbeatBeat("orch", 0, null)).toThrow(/interval/);
      expect(() => store.heartbeatBeat("orch", -1, null)).toThrow(/interval/);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: lapse detection with an injected clock
// ---------------------------------------------------------------------------

describe("heartbeat lapse detection", () => {
  it("does not lapse at exactly 2x the interval, but does the instant after", async () => {
    const { store } = await openStore("headroom-heartbeat-lapse-boundary-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 10 * 60_000;
      store.heartbeatBeat("orch-b", intervalMs, "resume: nothing to do", start);

      store.checkHeartbeatLapses(new Date(start.getTime() + 2 * intervalMs));
      expect(store.heartbeatLapsed("orch-b")).toBe(false);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_lapsed")).toHaveLength(0);

      store.checkHeartbeatLapses(new Date(start.getTime() + 2 * intervalMs + 1));
      expect(store.heartbeatLapsed("orch-b")).toBe(true);
      const lapsed = store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_lapsed");
      expect(lapsed).toHaveLength(1);
      expect(lapsed[0].metadata).toMatchObject({ owner: "orch-b", interval_ms: intervalMs, resume_sentence: "resume: nothing to do" });
    } finally { store.close(); }
  });

  it("never repeats the lapse event across later polls of the same open lapse", async () => {
    const { store } = await openStore("headroom-heartbeat-lapse-norepeat-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 5 * 60_000;
      store.heartbeatBeat("orch-c", intervalMs, null, start);
      const first = new Date(start.getTime() + 2 * intervalMs + 1_000);
      store.checkHeartbeatLapses(first);
      store.checkHeartbeatLapses(new Date(first.getTime() + 60_000));
      store.checkHeartbeatLapses(new Date(first.getTime() + 3_600_000));
      expect(store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_lapsed")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("a later beat closes the lapse and emits exactly one heartbeat_restored", async () => {
    const { store } = await openStore("headroom-heartbeat-restore-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 5 * 60_000;
      store.heartbeatBeat("orch-d", intervalMs, null, start);
      const lapsedAt = new Date(start.getTime() + 2 * intervalMs + 1_000);
      store.checkHeartbeatLapses(lapsedAt);
      expect(store.heartbeatLapsed("orch-d")).toBe(true);

      const resumeAt = new Date(lapsedAt.getTime() + 60_000);
      store.heartbeatBeat("orch-d", intervalMs, null, resumeAt);
      expect(store.heartbeatLapsed("orch-d")).toBe(false);

      const events = store.events(start.toISOString());
      expect(events.filter((event) => event.kind === "heartbeat_lapsed")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "heartbeat_restored")).toHaveLength(1);

      // Calling checkHeartbeatLapses again immediately after the restore must
      // not resurrect the closed lapse.
      store.checkHeartbeatLapses(new Date(resumeAt.getTime() + 1_000));
      expect(store.heartbeatLapsed("orch-d")).toBe(false);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_restored")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("an owner with no registered heartbeat is never considered lapsed", async () => {
    const { store } = await openStore("headroom-heartbeat-unregistered-");
    try {
      expect(store.heartbeatLapsed("nobody")).toBe(false);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: timers
// ---------------------------------------------------------------------------

describe("timers", () => {
  it("sets, lists (pending only), and clears a named wake-up", async () => {
    const { store } = await openStore("headroom-timer-basic-");
    try {
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      const at = new Date("2026-09-28T12:05:00.000Z");
      const timer = store.setTimer("orch-e", "check-pr", at.toISOString(), "check PR #78 CI status", "notify", createdAt);
      expect(timer).toMatchObject({ owner: "orch-e", name: "check-pr", at: at.toISOString(), action: "check PR #78 CI status", if_missed: "notify", fired_at: null, cleared_at: null });

      expect(store.timers("orch-e")).toHaveLength(1);
      expect(store.timers()).toHaveLength(1);
      expect(store.dueTimers(new Date(at.getTime() - 60_000))).toHaveLength(0);
      expect(store.dueTimers(at)).toHaveLength(1);

      expect(store.clearTimer("orch-e", "check-pr")).toBe(true);
      expect(store.timers("orch-e")).toHaveLength(0);
      // Idempotent: clearing an already-cleared row is not an error.
      expect(store.clearTimer("orch-e", "check-pr")).toBe(true);
      expect(store.clearTimer("orch-e", "never-existed")).toBe(false);
    } finally { store.close(); }
  });

  it("re-setting the same owner+name replaces it and clears any prior fired/cleared state", async () => {
    const { store } = await openStore("headroom-timer-replace-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-f", "wake", "2026-09-28T12:05:00.000Z", "first", "notify", now);
      store.clearTimer("orch-f", "wake");
      expect(store.timers("orch-f")).toHaveLength(0);
      const replaced = store.setTimer("orch-f", "wake", "2026-09-28T13:00:00.000Z", "second", "drop", now);
      expect(replaced).toMatchObject({ action: "second", if_missed: "drop", fired_at: null, cleared_at: null, attempts: 0, failed_at: null });
      expect(store.timers("orch-f")).toHaveLength(1);
    } finally { store.close(); }
  });

  // P2 fix: an invalid owner id was previously stored and left
  // to fail every inbox delivery forever (inbox.ts's assertSessionId refuses
  // it at delivery time, never at set time). setTimer now applies the same
  // SESSION_ID_PATTERN rule up front and refuses to store the row at all.
  it("refuses an owner that is not a valid inbox session id", async () => {
    const { store } = await openStore("headroom-timer-bad-owner-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      for (const bad of ["has spaces", "slash/in/it", "../escape", ".", "..", "a".repeat(65)]) {
        expect(() => store.setTimer(bad, "wake", now.toISOString(), "check", "notify", now)).toThrow(/valid inbox session id/);
      }
      expect(store.timers()).toHaveLength(0);
    } finally { store.close(); }
  });

  // P2 fix: an oversized action was previously stored and then
  // failed inbox delivery forever (sendInboxMessage's own size cap, applied
  // only once fireDueTimers tries to deliver it). setTimer now rejects it
  // up front, computing the exact envelope fireDueTimers will build.
  it("refuses an action too large for the serialized envelope to ever be delivered", async () => {
    const { store } = await openStore("headroom-timer-oversized-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      const huge = "x".repeat(70 * 1024); // comfortably over the 64 KiB inbox cap
      expect(() => store.setTimer("orch-big", "wake", now.toISOString(), huge, "notify", now)).toThrow(/too large to ever be delivered/);
      expect(store.timers()).toHaveLength(0);
      // Just under the cap still succeeds -- this is a size check, not a
      // blanket refusal of long actions.
      const fits = "x".repeat(1024);
      expect(() => store.setTimer("orch-big", "wake", now.toISOString(), fits, "notify", now)).not.toThrow();
    } finally { store.close(); }
  });

  // P2 fix: the size check used to validate only the inner `{ timer, at,
  // action }` body, so an action that fit under the cap could still produce
  // a fully serialized FILE (envelope wrapper, pretty-print whitespace,
  // delivery_id and all) over it -- readBoundedRegularFile (what every
  // inbox reader uses) refuses to even read a file past the cap, so that
  // timer would be confirmed fired without ever being readable. This finds
  // the real byte boundary end to end, through setTimer itself (a binary
  // search, not a hand-computed offset, so it stays correct if the envelope
  // shape ever changes), and proves a message right at that boundary is
  // both storable and actually deliverable/readable.
  it("accepts an action that lands the fully serialized file exactly at the cap, rejects one byte more, and the boundary message is actually deliverable", async () => {
    const { store, home } = await openStore("headroom-timer-boundary-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      const owner = "orch-boundary";
      let low = 0;
      let high = 66 * 1024; // definitely fits .. definitely does not
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        try { store.setTimer(owner, "wake", now.toISOString(), "x".repeat(mid), "notify", now); low = mid; }
        catch { high = mid - 1; }
      }
      expect(low).toBeGreaterThan(0);
      const boundary = store.setTimer(owner, "wake", now.toISOString(), "x".repeat(low), "notify", now);
      expect(boundary.action).toHaveLength(low);
      expect(() => store.setTimer(owner, "wake", now.toISOString(), "x".repeat(low + 1), "notify", now)).toThrow(/too large to ever be delivered/);
      // The rejected attempt never touched the still-stored boundary row.
      expect(store.timers(owner)[0]).toMatchObject({ action: "x".repeat(low) });

      const fired = await fireDueTimers(store, home, now);
      expect(fired).toBe(1);
      const inbox = await readInbox({ session: owner, home, markRead: false });
      expect(inbox.messages).toHaveLength(1);
      expect((inbox.messages[0].body as { action: string }).action).toHaveLength(low);
    } finally { store.close(); }
  });

  it("a fresh timer starts at zero delivery attempts, never failed", async () => {
    const { store } = await openStore("headroom-timer-fresh-attempts-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      const timer = store.setTimer("orch-j", "wake", now.toISOString(), "check", "notify", now);
      expect(timer.attempts).toBe(0);
      expect(timer.failed_at).toBeNull();
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: unclaimTimer's bounded retry (P2 fix) -- an
// undeliverable timer stops being offered by dueTimers()/timers() once it
// has failed MAX_TIMER_DELIVERY_ATTEMPTS times, instead of being retried on
// every maintenance pass forever.
// ---------------------------------------------------------------------------

describe("releaseTimerClaim bounded retry", () => {
  it("releases the claim for retry below the attempt limit, and permanently fails it at the limit", async () => {
    const { store } = await openStore("headroom-timer-bounded-retry-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-k", "wake", at.toISOString(), "check", "notify", at);
      const maxAttempts = 3;
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        const claimed = store.claimTimer("orch-k", "wake", at)!;
        expect(claimed).toBeDefined();
        const outcome = store.releaseTimerClaim("orch-k", "wake", claimed.claim_token, at, maxAttempts);
        expect(outcome).toEqual({ attempts: attempt, permanentlyFailed: false });
        // Retryable again: dueTimers()/timers() still see it as pending.
        expect(store.dueTimers(at)).toHaveLength(1);
        expect(store.timers("orch-k")).toHaveLength(1);
      }
      // The attempt that reaches the limit gives up for good.
      const finalClaim = store.claimTimer("orch-k", "wake", at)!;
      const finalOutcome = store.releaseTimerClaim("orch-k", "wake", finalClaim.claim_token, at, maxAttempts);
      expect(finalOutcome).toEqual({ attempts: maxAttempts, permanentlyFailed: true });
      // No longer offered for delivery or listed as pending -- but not
      // deleted either (findable by a direct row read, if ever needed).
      expect(store.dueTimers(at)).toHaveLength(0);
      expect(store.timers("orch-k")).toHaveLength(0);
      expect(store.claimTimer("orch-k", "wake", at)).toBeUndefined();
    } finally { store.close(); }
  });

  it("returns undefined when the claim token no longer matches (already cleared, confirmed, or reclaimed)", async () => {
    const { store } = await openStore("headroom-timer-stale-unclaim-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-l", "wake", at.toISOString(), "check", "notify", at);
      const claimed = store.claimTimer("orch-l", "wake", at)!;
      store.clearTimer("orch-l", "wake");
      expect(store.releaseTimerClaim("orch-l", "wake", claimed.claim_token, at)).toBeUndefined();
    } finally { store.close(); }
  });

  it("re-setting a permanently-failed timer clears failed_at/attempts and makes it deliverable again", async () => {
    const { store } = await openStore("headroom-timer-reset-after-fail-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-m", "wake", at.toISOString(), "check", "notify", at);
      const claimed = store.claimTimer("orch-m", "wake", at)!;
      const outcome = store.releaseTimerClaim("orch-m", "wake", claimed.claim_token, at, 1);
      expect(outcome).toEqual({ attempts: 1, permanentlyFailed: true });
      expect(store.timers("orch-m")).toHaveLength(0);
      const reset = store.setTimer("orch-m", "wake", new Date(at.getTime() + 60_000).toISOString(), "check again", "notify", at);
      expect(reset).toMatchObject({ attempts: 0, failed_at: null });
      expect(store.timers("orch-m")).toHaveLength(1);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: the recoverable claim itself -- claimTimer/confirmTimerDelivered/
// reclaimStaleTimerClaims. Covers this: claimTimer no longer sets
// the terminal fired_at, so a crash between claim and delivery leaves a
// recoverable claim, never a silently-lost timer.
// ---------------------------------------------------------------------------

describe("recoverable timer claim (claimTimer/confirmTimerDelivered/reclaimStaleTimerClaims)", () => {
  it("claimTimer sets claimed_at, not fired_at -- the timer is not terminal until confirmTimerDelivered", async () => {
    const { store } = await openStore("headroom-claim-not-terminal-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-n", "wake", at.toISOString(), "check", "notify", at);
      const claimed = store.claimTimer("orch-n", "wake", at)!;
      expect(claimed.fired_at).toBeNull();
      expect(typeof claimed.claim_token).toBe("string");
      // Still fired_at: null on a direct row read too (never set at claim time).
      expect(store.timers("orch-n")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("a fresh claim (claimed_at just set) is not offered to a second claimTimer call or dueTimers()", async () => {
    const { store } = await openStore("headroom-claim-exclusive-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-o", "wake", at.toISOString(), "check", "notify", at);
      store.claimTimer("orch-o", "wake", at);
      expect(store.claimTimer("orch-o", "wake", at)).toBeUndefined();
      expect(store.dueTimers(at)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("confirmTimerDelivered sets fired_at and clears the claim; a stale/mismatched token is a no-op", async () => {
    const { store } = await openStore("headroom-confirm-delivered-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-p", "wake", at.toISOString(), "check", "notify", at);
      const claimed = store.claimTimer("orch-p", "wake", at)!;
      expect(store.confirmTimerDelivered("orch-p", "wake", "not-the-real-token", at)).toBe(false);
      expect(store.confirmTimerDelivered("orch-p", "wake", claimed.claim_token, at)).toBe(true);
      expect(store.timers("orch-p")).toHaveLength(0); // fired, no longer pending
      // Idempotent: confirming the same already-consumed token again is a
      // harmless no-op, never a second effect.
      expect(store.confirmTimerDelivered("orch-p", "wake", claimed.claim_token, at)).toBe(false);
    } finally { store.close(); }
  });

  it("dueTimers()/claimTimer() offer a claim back up once it goes stale, without waiting for a crash", async () => {
    const { store } = await openStore("headroom-claim-stale-reclaim-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-q", "wake", at.toISOString(), "check", "notify", at);
      store.claimTimer("orch-q", "wake", at);
      const staleMs = 30_000;
      // Not yet stale: still excluded.
      expect(store.dueTimers(new Date(at.getTime() + staleMs - 1), staleMs)).toHaveLength(0);
      expect(store.claimTimer("orch-q", "wake", new Date(at.getTime() + staleMs - 1), staleMs)).toBeUndefined();
      // Past the staleness window: offered again, and re-claimable.
      const later = new Date(at.getTime() + staleMs + 1);
      expect(store.dueTimers(later, staleMs)).toHaveLength(1);
      const reclaimed = store.claimTimer("orch-q", "wake", later, staleMs)!;
      expect(reclaimed).toBeDefined();
      expect(reclaimed.claim_token).not.toBe(""); // a fresh token, not a reused one
    } finally { store.close(); }
  });

  it("reclaimStaleTimerClaims() resets every outstanding claim unconditionally, regardless of age", async () => {
    const { store } = await openStore("headroom-reclaim-on-start-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-r", "wake-1", at.toISOString(), "check", "notify", at);
      store.setTimer("orch-r", "wake-2", at.toISOString(), "check", "notify", at);
      store.claimTimer("orch-r", "wake-1", at); // claimed a moment ago -- not remotely stale
      const secondClaim = store.claimTimer("orch-r", "wake-2", at)!;
      store.confirmTimerDelivered("orch-r", "wake-2", secondClaim.claim_token, at); // already terminal
      // Immediately after claiming (no staleness elapsed at all), a plain
      // claimTimer()/dueTimers() call still correctly excludes wake-1.
      expect(store.dueTimers(at)).toHaveLength(0);
      expect(store.reclaimStaleTimerClaims()).toBe(1); // only wake-1 had an outstanding claim
      // wake-1 is claimable again right away; wake-2 stays terminal (fired), untouched.
      expect(store.dueTimers(at)).toHaveLength(1);
      expect(store.dueTimers(at)[0]).toMatchObject({ owner: "orch-r", name: "wake-1" });
      expect(store.reclaimStaleTimerClaims()).toBe(0); // nothing left to reclaim
    } finally { store.close(); }
  });

  // replacing a timer (the same owner+name re-set while an OLD
  // delivery for the PREVIOUS registration is still in flight) used to leave
  // claimed_at/claim_token untouched, so that old, now-orphaned delivery's
  // eventual confirmTimerDelivered call would match the NEW row's guard
  // (claim_token unchanged) and mark the REPLACEMENT fired -- without the
  // replacement's own content ever having been delivered.
  it("re-setting a timer clears the old claim and delivery_id, so an in-flight old delivery can never confirm the replacement as fired", async () => {
    const { store } = await openStore("headroom-replace-inflight-claim-");
    try {
      const at = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-s", "wake", at.toISOString(), "check the old deploy", "notify", at);
      // An in-flight delivery for the ORIGINAL registration: claimed, not
      // yet confirmed -- exactly the window setTimer must protect against.
      // delivery_id/claim_token are internal (ClaimedTimer-only, not part
      // of the plain Timer setTimer itself returns), so they are only ever
      // observed here through a claim.
      const staleClaim = store.claimTimer("orch-s", "wake", at)!;
      expect(typeof staleClaim.delivery_id).toBe("number");

      // The timer gets replaced (a fresh `headroom timer set` for the same
      // owner+name) while that old delivery is still outstanding.
      const later = new Date(at.getTime() + 5_000);
      const replaced = store.setTimer("orch-s", "wake", new Date(at.getTime() + 60_000).toISOString(), "check the NEW deploy", "notify", later);
      expect(replaced.fired_at).toBeNull();

      // The stale (pre-replace) claim's own eventual confirm must be a
      // gated no-op: its claim_token no longer matches anything live.
      expect(store.confirmTimerDelivered("orch-s", "wake", staleClaim.claim_token, later)).toBe(false);
      const row = store.timers("orch-s")[0];
      expect(row).toMatchObject({ fired_at: null, action: "check the NEW deploy" }); // never falsely marked fired

      // The replacement is claimable fresh, under its own new delivery_id
      // and claim_token -- once it is actually due (claimTimer now
      // requires `at <= now` too, see its own doc comment) -- confirming
      // THAT one genuinely fires it.
      const muchLater = new Date(at.getTime() + 60_000);
      expect(store.claimTimer("orch-s", "wake", later)).toBeUndefined(); // not due yet
      const freshClaim = store.claimTimer("orch-s", "wake", muchLater)!;
      expect(freshClaim.delivery_id).not.toBe(staleClaim.delivery_id);
      expect(freshClaim.claim_token).not.toBe(staleClaim.claim_token);
      expect(store.confirmTimerDelivered("orch-s", "wake", freshClaim.claim_token, muchLater)).toBe(true);
      expect(store.timers("orch-s")).toHaveLength(0);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: claimDaemonInterval -- the shared throttle both poll() and the
// daemon's own maintenance scheduler claim heartbeat_timer_check through.
// ---------------------------------------------------------------------------

describe("claimDaemonInterval", () => {
  it("claims on first use, then refuses within the interval, then claims again once it has genuinely elapsed", async () => {
    const { store } = await openStore("headroom-claim-interval-basic-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      expect(store.claimDaemonInterval("k", start, 10_000)).toBe(true);
      expect(store.claimDaemonInterval("k", new Date(start.getTime() + 5_000), 10_000)).toBe(false);
      expect(store.claimDaemonInterval("k", new Date(start.getTime() + 10_000), 10_000)).toBe(true);
    } finally { store.close(); }
  });

  // P2 fix: a backwards wall-clock step (an NTP correction, a manual clock
  // change) made `now - previousAt` negative, which used to still satisfy
  // `< intervalMs` and refuse the claim -- suppressing the next poll or
  // maintenance pass until the real clock caught back up to the old,
  // now-future-dated claim, however long that took. A negative elapsed time
  // must instead be treated as already expired.
  it("treats a backwards clock step as an expired interval, not a not-yet-due one", async () => {
    const { store } = await openStore("headroom-claim-interval-clock-back-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      expect(store.claimDaemonInterval("k", start, 10_000)).toBe(true);
      // The clock now reads five minutes EARLIER than the claim just made.
      const steppedBack = new Date(start.getTime() - 5 * 60_000);
      expect(store.claimDaemonInterval("k", steppedBack, 10_000)).toBe(true);
      // The overwritten claim is honored going forward from the new (earlier) time.
      expect(store.claimDaemonInterval("k", new Date(steppedBack.getTime() + 5_000), 10_000)).toBe(false);
    } finally { store.close(); }
  });

  it("an intervalMs of 0 always claims, recording the timestamp without ever refusing", async () => {
    const { store } = await openStore("headroom-claim-interval-zero-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      expect(store.claimDaemonInterval("k", start, 0)).toBe(true);
      expect(store.claimDaemonInterval("k", start, 0)).toBe(true); // same instant, still claims
      expect(store.claimDaemonInterval("k", new Date(start.getTime() + 1), 0)).toBe(true);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: nextMaintenanceDeadline -- what daemon.ts's independent
// maintenance timer (scheduleMaintenance) reschedules itself around.
// ---------------------------------------------------------------------------

describe("nextMaintenanceDeadline", () => {
  it("returns undefined with no pending timer and no live heartbeat", async () => {
    const { store } = await openStore("headroom-deadline-empty-");
    try { expect(store.nextMaintenanceDeadline(new Date())).toBeUndefined(); } finally { store.close(); }
  });

  it("picks the soonest pending timer's `at` over a later heartbeat lapse deadline", async () => {
    const { store } = await openStore("headroom-deadline-timer-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      // Lapses at 12:10 (2x a 5-minute interval), later than the timer.
      store.heartbeatBeat("orch-g", 5 * 60_000, undefined, now);
      const timerAt = new Date("2026-09-28T12:03:00.000Z");
      store.setTimer("orch-g", "wake", timerAt.toISOString(), "check", "notify", now);
      expect(store.nextMaintenanceDeadline(now)).toEqual(timerAt);
    } finally { store.close(); }
  });

  it("picks the soonest heartbeat lapse deadline over a later pending timer", async () => {
    const { store } = await openStore("headroom-deadline-heartbeat-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      // Lapses at 12:00:20 (2x a 10-second interval).
      store.heartbeatBeat("orch-h", 10_000, undefined, now);
      store.setTimer("orch-h", "wake", new Date("2026-09-28T13:00:00.000Z").toISOString(), "check", "notify", now);
      expect(store.nextMaintenanceDeadline(now)).toEqual(new Date(now.getTime() + 20_000));
    } finally { store.close(); }
  });

  it("ignores an already-lapsed heartbeat and a fired/cleared timer", async () => {
    const { store } = await openStore("headroom-deadline-ignore-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      store.heartbeatBeat("orch-i", 1_000, undefined, new Date(now.getTime() - 10_000));
      store.checkHeartbeatLapses(now); // marks orch-i lapsed_since
      store.setTimer("orch-i", "wake", new Date(now.getTime() - 1_000).toISOString(), "check", "notify", now);
      store.clearTimer("orch-i", "wake");
      expect(store.nextMaintenanceDeadline(now)).toBeUndefined();
    } finally { store.close(); }
  });
});

describe("parseTimerAt", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  it("accepts a relative duration", () => {
    expect(parseTimerAt("+30m", now)).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
    expect(parseTimerAt("+2h", now)).toBe(new Date(now.getTime() + 2 * 3_600_000).toISOString());
  });
  it("accepts and normalizes an ISO instant", () => {
    expect(parseTimerAt("2026-09-29T00:00:00Z", now)).toBe(new Date("2026-09-29T00:00:00Z").toISOString());
  });
  it("rejects anything else", () => {
    expect(() => parseTimerAt("tomorrow", now)).toThrow(/ISO instant or a relative duration/);
  });
});

// ---------------------------------------------------------------------------
// src/heartbeat.ts: fireDueTimers -- the daemon's async delivery pass
// ---------------------------------------------------------------------------

describe("fireDueTimers", () => {
  it("delivers exactly one inbox entry per due timer, and never twice", async () => {
    const { store, home } = await openStore("headroom-firedue-once-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-g", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));

      const firstPass = await fireDueTimers(store, home, at);
      expect(firstPass).toBe(1);
      const firstRead = await readInbox({ session: "orch-g", home, markRead: false });
      expect(firstRead.messages).toHaveLength(1);
      expect(firstRead.messages[0].body).toMatchObject({ timer: "wake", action: "check the deploy" });

      // The timer is now fired_at-marked; a later poll must not deliver it
      // again even though `at` is still in the past.
      const secondPass = await fireDueTimers(store, home, new Date(at.getTime() + 3_600_000));
      expect(secondPass).toBe(0);
      const secondRead = await readInbox({ session: "orch-g", home, markRead: false });
      expect(secondRead.messages).toHaveLength(1);
    } finally { store.close(); }
  });

  it("two overlapping passes with a slow inbox sender never deliver the same timer twice", async () => {
    const { store, home } = await openStore("headroom-firedue-overlap-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-overlap", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));

      let releaseFirst: () => void;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const sent: string[] = [];
      const slowSend: typeof sendInboxMessageAt = async (options) => {
        sent.push(options.to);
        await gate; // held open until the test explicitly releases it
        return sendInboxMessageAt(options);
      };

      // Started but not awaited: this pass claims the timer synchronously
      // (store.claimTimer runs before the first await inside slowSend) and
      // then blocks on the gate, exactly like a slow inbox write outlasting
      // the daemon's own 15s poll throttle.
      const firstPass = fireDueTimers(store, home, at, undefined, slowSend);
      // A second, independent pass starts while the first is still stuck in
      // its slow send. Its own dueTimers() scan must no longer see the
      // timer at all -- claimTimer already recorded a fresh claimed_at the
      // instant the first pass claimed it -- so this resolves immediately
      // without ever touching slowSend.
      const secondPass = await fireDueTimers(store, home, at, undefined, slowSend);
      expect(secondPass).toBe(0);
      expect(sent).toEqual(["orch-overlap"]); // only the first pass ever called send

      releaseFirst!();
      expect(await firstPass).toBe(1);

      const inbox = await readInbox({ session: "orch-overlap", home, markRead: false });
      expect(inbox.messages).toHaveLength(1);
    } finally { store.close(); }
  });

  // dueTimers() takes one snapshot at the top of a pass, but
  // claimTimer() used to require only that the row still be pending, never
  // that it still be the SAME registration due at THAT snapshot -- awaiting
  // an earlier timer's delivery in the same pass is a real window in which
  // a LATER snapshot entry gets replaced (a fresh `setTimer` for the same
  // owner+name, here with a future `at`). Without checking the snapshot's
  // own delivery_id at claim time, that replacement would still be claimed
  // and delivered under its old place in the snapshot, early.
  it("replacing a later snapshot entry with a future registration while an earlier delivery is in flight does not deliver the replacement", async () => {
    const { store, home } = await openStore("headroom-firedue-replaced-midpass-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      // orch-first sorts before orch-second (dueTimers() orders by `at`,
      // then this store's own row order for ties) so the loop reaches it
      // first and gates there while orch-second is still just a snapshot
      // entry, not yet claimed.
      store.setTimer("orch-first", "wake", new Date(at.getTime() - 1_000).toISOString(), "check the deploy", "notify", createdAt);
      store.setTimer("orch-second", "wake", at.toISOString(), "check the deploy", "notify", createdAt);

      let releaseFirst: () => void;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const sent: string[] = [];
      const gatedSend: typeof sendInboxMessageAt = async (options) => {
        sent.push(options.to);
        if (options.to === "orch-first") await gate; // held open until released below
        return sendInboxMessageAt(options);
      };

      const pass = fireDueTimers(store, home, at, undefined, gatedSend);
      // While orch-first's delivery is gated (the pass has not reached
      // orch-second's claim yet), replace orch-second with a registration
      // due an hour from now -- a legitimate `headroom timer set` racing
      // in, exactly like an RPC connection handler running while this same
      // process awaits the first delivery.
      const futureAt = new Date(at.getTime() + 3_600_000);
      store.setTimer("orch-second", "wake", futureAt.toISOString(), "check the NEW deploy", "notify", at);

      releaseFirst!();
      const fired = await pass;
      expect(fired).toBe(1); // only orch-first
      expect(sent).not.toContain("orch-second"); // never even attempted

      const secondInbox = await readInbox({ session: "orch-second", home, markRead: false });
      expect(secondInbox.messages).toHaveLength(0);
      const row = store.timers("orch-second")[0];
      expect(row).toMatchObject({ fired_at: null, action: "check the NEW deploy", at: futureAt.toISOString() });
    } finally { store.close(); }
  });

  // Same race, but the replacement is ALSO already due (not future) --
  // isolating the identity (delivery_id) check from the plain `at <= now`
  // one: a due-date check alone would let this claim through, since the
  // replacement genuinely is due by the time the pass reaches it. Only
  // recognizing that the snapshot's own registration no longer exists
  // skips it, leaving it for the NEXT pass to claim (and deliver) fresh,
  // under its own new identity.
  it("replacing a later snapshot entry with an equally-due-but-different registration while an earlier delivery is in flight still skips the stale snapshot entry", async () => {
    const { store, home } = await openStore("headroom-firedue-replaced-samedue-midpass-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-first", "wake", new Date(at.getTime() - 1_000).toISOString(), "check the deploy", "notify", createdAt);
      store.setTimer("orch-second", "wake", at.toISOString(), "check the deploy", "notify", createdAt);

      let releaseFirst: () => void;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const sent: string[] = [];
      const gatedSend: typeof sendInboxMessageAt = async (options) => {
        sent.push(options.to);
        if (options.to === "orch-first") await gate;
        return sendInboxMessageAt(options);
      };

      const pass = fireDueTimers(store, home, at, undefined, gatedSend);
      // Replaced with a registration that is ALSO already due right now --
      // `at <= now` alone would admit this claim; only the snapshot's own
      // delivery_id no longer matching the live row's stops it.
      store.setTimer("orch-second", "wake", at.toISOString(), "check the NEW deploy", "notify", at);

      releaseFirst!();
      const fired = await pass;
      expect(fired).toBe(1); // only orch-first
      expect(sent).not.toContain("orch-second"); // never even attempted this pass

      const secondInbox = await readInbox({ session: "orch-second", home, markRead: false });
      expect(secondInbox.messages).toHaveLength(0);
      // Left pending under its own new identity for the next pass, which
      // now correctly claims and delivers it fresh.
      expect(store.timers("orch-second")).toHaveLength(1);
      const delivered = await fireDueTimers(store, home, at);
      expect(delivered).toBe(1);
      const secondInboxAfter = await readInbox({ session: "orch-second", home, markRead: false });
      expect(secondInboxAfter.messages).toHaveLength(1);
      expect((secondInboxAfter.messages[0].body as { action: string }).action).toBe("check the NEW deploy");
    } finally { store.close(); }
  });

  // The two tests above race a REPLACEMENT against an in-flight delivery
  // across an async gap (fireDueTimers awaiting an earlier timer's send).
  // This one isolates a narrower window: claimTimer's own pre-check reads
  // the row, then a SEPARATE connection replaces that exact row, then
  // claimTimer's own UPDATE runs -- all with no async gap of this call's
  // own. The pre-check alone cannot see a write that lands after it read,
  // so the atomic UPDATE's own WHERE clause has to repeat the identity
  // check itself.
  it("claimTimer's own SELECT-then-UPDATE has no window for a concurrent replacement to slip through", async () => {
    const { store } = await openStore("headroom-claimtimer-select-update-race-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-race", "wake", at.toISOString(), "check the deploy", "notify", createdAt);
      const snapshot = store.dueTimers(at)[0];
      expect(snapshot.owner).toBe("orch-race");

      const db = (store as unknown as { db: RawDb }).db;
      const originalPrepare = db.prepare.bind(db);
      let intercepted = false;
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        const real = originalPrepare(sql);
        if (!intercepted && sql.startsWith("SELECT * FROM timers WHERE owner")) {
          intercepted = true;
          return {
            run: real.run.bind(real),
            all: real.all.bind(real),
            get: (...args: unknown[]) => {
              const row = real.get(...args);
              // A genuinely different connection replaces this exact row
              // right here -- after claimTimer's own SELECT already read
              // it, before claimTimer's own UPDATE runs.
              store.setTimer("orch-race", "wake", at.toISOString(), "check the NEW deploy", "notify", at);
              return row;
            },
          };
        }
        return real;
      });

      const claimed = store.claimTimer("orch-race", "wake", at, undefined, snapshot.delivery_id);
      prepareSpy.mockRestore();
      expect(claimed).toBeUndefined(); // the row it read is not the row now live

      const row = store.timers("orch-race")[0];
      expect(row.action).toBe("check the NEW deploy");
      // claimed_at/claim_token are internal-only, not on the public Timer
      // shape timers() returns -- read the raw row to prove the replaced
      // row itself was never touched by the stale attempt.
      const raw = db.prepare("SELECT claimed_at, claim_token FROM timers WHERE owner = ? AND name = ?").get("orch-race", "wake") as { claimed_at: unknown; claim_token: unknown };
      expect(raw.claimed_at).toBeNull();
      expect(raw.claim_token).toBeNull();
    } finally { store.close(); }
  });

  // every claim/send/confirm in a pass used to share the same
  // frozen `now` the pass started with. A pass with a slow earlier delivery
  // can genuinely take real, unbounded time to reach a later timer -- long
  // enough for an ordinary hand-off to land, in real time, before that later
  // timer's own delivery -- yet the later timer's filename epoch would
  // still predate the hand-off's, since it was stamped with the pass's
  // original instant. A --since cursor read right after the hand-off would
  // then wrongly hide the timer message. `clock` (a test seam here; a real
  // wall clock in production) lets this test simulate real elapsed time
  // between each individual claim/send/confirm without depending on actual
  // wall-clock timing.
  it("captures a fresh time for each claim, send and confirm, so a --since cursor set after an ordinary message sent mid-pass does not hide a timer message the same pass delivers later", async () => {
    const { store, home } = await openStore("headroom-firedue-fresh-clock-");
    try {
      const passStart = new Date("2026-09-28T12:05:00.000Z");
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-cursor-a", "wake", passStart.toISOString(), "first", "notify", createdAt);
      store.setTimer("orch-cursor-b", "wake", passStart.toISOString(), "second", "notify", createdAt);

      let calls = 0;
      const clock = () => new Date(passStart.getTime() + 1000 * (calls += 1));

      let releaseFirst: () => void;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const gatedSend: typeof sendInboxMessageAt = async (options) => {
        if (options.to === "orch-cursor-a") await gate;
        return sendInboxMessageAt(options);
      };

      const pass = fireDueTimers(store, home, passStart, undefined, gatedSend, undefined, clock);
      // A genuinely concurrent ordinary hand-off lands for orch-cursor-b
      // while this pass is still stuck delivering orch-cursor-a -- its own
      // real send time sits strictly between this pass's claim/send calls
      // for the two timers (see `clock` above).
      await sendInboxMessage({ to: "orch-cursor-b", kind: "note", text: "unrelated", home, now: new Date(passStart.getTime() + 2_500) });
      releaseFirst!();
      const fired = await pass;
      expect(fired).toBe(2);

      const inbox = await readInbox({ session: "orch-cursor-b", home, markRead: false });
      // Real send order (note at +2500ms, the timer delivered strictly
      // later), not pass-start order (which would put the timer first, at
      // the pass's own frozen `now`).
      expect(inbox.messages.map((message) => message.kind)).toEqual(["note", "handoff"]);
      const sinceOrdinary = await readInbox({ session: "orch-cursor-b", home, since: inbox.messages[0].at_epoch + 1, markRead: false });
      // The timer delivery, written after the ordinary note in real time,
      // is not hidden behind a cursor set just past that note.
      expect(sinceOrdinary.messages.map((message) => message.kind)).toEqual(["handoff"]);
    } finally { store.close(); }
  });

  it("un-claims a timer whose inbox delivery fails, so a later pass can retry and succeed", async () => {
    const { store, home } = await openStore("headroom-firedue-retry-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-retry", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));

      const failingSend: typeof sendInboxMessageAt = async () => { throw new Error("simulated inbox write failure"); };
      const failedPass = await fireDueTimers(store, home, at, undefined, failingSend);
      expect(failedPass).toBe(0);
      // Un-claimed: the timer is pending again, not lost.
      expect(store.timers("orch-retry")).toHaveLength(1);
      expect((await readInbox({ session: "orch-retry", home, markRead: false })).messages).toHaveLength(0);

      const retryPass = await fireDueTimers(store, home, new Date(at.getTime() + 60_000));
      expect(retryPass).toBe(1);
      expect(store.timers("orch-retry")).toHaveLength(0);
      expect((await readInbox({ session: "orch-retry", home, markRead: false })).messages).toHaveLength(1);
    } finally { store.close(); }
  });

  // P2 fix: a timer whose delivery NEVER succeeds (an invalid
  // owner that slipped past setTimer's own validation via an older row, or
  // any other permanent inbox failure) used to be un-claimed and retried on
  // every single maintenance pass forever. It now stops being offered after
  // MAX_TIMER_DELIVERY_ATTEMPTS failed passes, with a logged reason.
  it("gives up on a timer whose delivery always fails after MAX_TIMER_DELIVERY_ATTEMPTS passes, and logs why", async () => {
    const { store, home } = await openStore("headroom-firedue-permanent-fail-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-doomed", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));
      const alwaysFailingSend: typeof sendInboxMessageAt = async () => { throw new Error("simulated permanent inbox failure"); };
      const logged: string[] = [];
      const log = async (message: string) => { logged.push(message); };

      for (let pass = 1; pass < MAX_TIMER_DELIVERY_ATTEMPTS; pass += 1) {
        const fired = await fireDueTimers(store, home, at, log, alwaysFailingSend);
        expect(fired).toBe(0);
        expect(store.timers("orch-doomed")).toHaveLength(1); // still pending, still retryable
      }
      expect(logged.at(-1)).toMatch(/failed to deliver \(attempt \d+\)/);

      // The pass that reaches the limit gives up for good.
      const finalPass = await fireDueTimers(store, home, at, log, alwaysFailingSend);
      expect(finalPass).toBe(0);
      expect(logged.at(-1)).toMatch(/permanently failed after \d+ delivery attempts, giving up/);
      expect(store.timers("orch-doomed")).toHaveLength(0);
      expect(store.dueTimers(new Date(at.getTime() + 3_600_000))).toHaveLength(0);

      // No further pass ever tries to deliver it again, however far past
      // `at` the clock runs.
      const sendCalls: string[] = [];
      const countingSend: typeof sendInboxMessageAt = async (options) => { sendCalls.push(options.to); throw new Error("would still fail if tried"); };
      await fireDueTimers(store, home, new Date(at.getTime() + 3_600_000), log, countingSend);
      expect(sendCalls).toHaveLength(0);
      expect((await readInbox({ session: "orch-doomed", home, markRead: false })).messages).toHaveLength(0);
    } finally { store.close(); }
  });

  // a `send` that never settles at all (a stuck filesystem, not
  // merely a slow one) used to leave fireDueTimers -- and every other due
  // timer queued behind it in the same pass, and the daemon's own
  // maintenance scheduler, which awaits this whole pass before it can
  // re-arm -- waiting forever. A bounded per-delivery timeout means this
  // now moves on instead, leaving the claim exactly as a crash would (never
  // confirmed, never released): recoverable once it goes stale.
  it("does not hang forever on a sender that never resolves, and leaves the claim recoverable rather than confirmed or released", async () => {
    const { store, home } = await openStore("headroom-firedue-never-resolves-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-stuck", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));
      const neverResolvingSend: typeof sendInboxMessageAt = () => new Promise(() => { /* never settles */ });
      const logged: string[] = [];
      const log = async (message: string) => { logged.push(message); };

      const start = Date.now();
      const fired = await fireDueTimers(store, home, at, log, neverResolvingSend, 100); // 100ms delivery timeout
      const elapsed = Date.now() - start;
      expect(fired).toBe(0);
      expect(elapsed).toBeLessThan(5_000); // bounded, nowhere near a real hang
      expect(logged.at(-1)).toMatch(/delivery timed out after 100ms/);

      // Neither confirmed nor released: still claimed (not fired_at, not
      // failed_at, attempts unchanged), same state a genuine crash would
      // leave it in -- store.timers() (which does not filter on claim
      // freshness) still lists it as pending.
      expect(store.timers("orch-stuck")).toHaveLength(1);
      expect(store.timers("orch-stuck")[0]).toMatchObject({ fired_at: null, failed_at: null, attempts: 0 });
      // Still fresh (just claimed): not yet offered back up.
      expect(store.dueTimers(at)).toHaveLength(0);
      // Once its claim goes stale, it is recoverable exactly like a crash
      // would leave it -- proven with a short claimStaleMs rather than
      // waiting out the real (2 minute) default.
      const later = new Date(at.getTime() + 50);
      expect(store.dueTimers(later, 10)).toHaveLength(1);
    } finally { store.close(); }
  });

  // fireDueTimers's own timeout/failure logging used to be an
  // unprotected `await log(...)`. A `log` that rejects (a broken custom
  // logger, a full disk under appendDaemonLog) must never abort this pass --
  // the timer it was about to log about has already been claimed and
  // released, a real, already-durable outcome that losing one log line
  // must never take down with it -- and every other due timer still queued
  // behind it in the same pass must still get processed.
  it("a rejecting logger never aborts the pass, and every other due timer is still processed", async () => {
    const { store, home } = await openStore("headroom-firedue-log-rejects-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-log-a", "wake", at.toISOString(), "check the deploy", "notify", createdAt);
      store.setTimer("orch-log-b", "wake", at.toISOString(), "check the deploy", "notify", createdAt);
      const alwaysFailingSend: typeof sendInboxMessageAt = async () => { throw new Error("simulated permanent inbox failure"); };
      const rejectingLog = async (): Promise<void> => { throw new Error("simulated broken logger"); };

      const fired = await fireDueTimers(store, home, at, rejectingLog, alwaysFailingSend);
      expect(fired).toBe(0); // both deliveries failed, but the pass itself completed
      // Both timers' claims were released for retry -- the rejecting logger
      // never stopped the second one from even being reached.
      expect(store.timers("orch-log-a")[0]).toMatchObject({ fired_at: null, attempts: 1 });
      expect(store.timers("orch-log-b")[0]).toMatchObject({ fired_at: null, attempts: 1 });
    } finally { store.close(); }
  });

  // a `log` that never settles at all (a stuck
  // filesystem under appendDaemonLog, not merely a slow one) must not hang
  // this pass -- and so the daemon's own maintenance scheduler, which
  // awaits it -- forever either. Proven with a short logTimeoutMs rather
  // than waiting out the real (2s) default.
  it("does not hang forever on a logger that never resolves, and still processes every other due timer", async () => {
    const { store, home } = await openStore("headroom-firedue-log-never-resolves-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-log-hang-a", "wake", at.toISOString(), "check the deploy", "notify", createdAt);
      store.setTimer("orch-log-hang-b", "wake", at.toISOString(), "check the deploy", "notify", createdAt);
      const alwaysFailingSend: typeof sendInboxMessageAt = async () => { throw new Error("simulated permanent inbox failure"); };
      const neverResolvingLog = (): Promise<void> => new Promise(() => { /* never settles */ });

      const start = Date.now();
      const fired = await fireDueTimers(store, home, at, neverResolvingLog, alwaysFailingSend, undefined, undefined, 20); // 20ms log timeout
      const elapsed = Date.now() - start;
      expect(fired).toBe(0);
      expect(elapsed).toBeLessThan(5_000); // bounded, nowhere near a real hang -- and nowhere near two real 2s log timeouts
      expect(store.timers("orch-log-hang-a")[0]).toMatchObject({ fired_at: null, attempts: 1 });
      expect(store.timers("orch-log-hang-b")[0]).toMatchObject({ fired_at: null, attempts: 1 });
    } finally { store.close(); }
  });

  // `attempts` (docs/json-contract.md's `timer list` entry,
  // types.ts's own Timer comment) counts delivery attempts that completed
  // and failed, never one that merely timed out with the outcome unknown --
  // more consecutive timeouts than MAX_TIMER_DELIVERY_ATTEMPTS must never
  // permanently fail a timer, since none of them was ever a KNOWN failure.
  it("repeated timeouts never count toward MAX_TIMER_DELIVERY_ATTEMPTS -- attempts stays 0, never permanently failed", async () => {
    const { store, home } = await openStore("headroom-firedue-timeout-not-attempt-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-timeout-loop", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));
      const neverResolvingSend: typeof sendInboxMessageAt = () => new Promise(() => { /* never settles */ });
      let now = at;
      // More passes than MAX_TIMER_DELIVERY_ATTEMPTS would ever tolerate for
      // a real, completed failure -- each one only times out, never throws.
      for (let pass = 0; pass < MAX_TIMER_DELIVERY_ATTEMPTS + 3; pass += 1) {
        const fired = await fireDueTimers(store, home, now, undefined, neverResolvingSend, 20);
        expect(fired).toBe(0);
        expect(store.timers("orch-timeout-loop")).toHaveLength(1); // never permanently failed
        expect(store.timers("orch-timeout-loop")[0]).toMatchObject({ attempts: 0, failed_at: null });
        now = new Date(now.getTime() + TIMER_CLAIM_STALE_MS + 1); // past this pass's own claim going stale (fireDueTimers/dueTimers use the default staleness)
      }
      // Still genuinely retryable, not stuck: a real (non-hanging) delivery
      // still succeeds after all those timeouts.
      const delivered = await fireDueTimers(store, home, now);
      expect(delivered).toBe(1);
    } finally { store.close(); }
  });

  // claimTimer used to write the terminal fired_at before the
  // async inbox write, so a crash (or the daemon's own stop() closing
  // SQLite) between claim and delivery left the timer excluded forever with
  // no message, retry, or failure marker. These two tests simulate that
  // crash directly at the store/module level (a real process crash cannot
  // be simulated in-process) and drive the recovery path a daemon restart
  // takes: reclaimStaleTimerClaims() first, then a normal fireDueTimers pass.
  it("crash between claim and delivery (never even attempted) -- after reclaim, a restart delivers exactly once", async () => {
    const { store, home } = await openStore("headroom-firedue-crash-before-send-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-crash-a", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));
      // Simulates the crashed process: claimed, but the inbox write never
      // even started, let alone confirmed.
      const crashedClaim = store.claimTimer("orch-crash-a", "wake", at)!;
      expect(crashedClaim.fired_at).toBeNull();
      expect((await readInbox({ session: "orch-crash-a", home, markRead: false })).messages).toHaveLength(0);

      // "Restart": exactly what daemon.ts's start() does before scheduling
      // any maintenance pass.
      expect(store.reclaimStaleTimerClaims()).toBe(1);

      const delivered = await fireDueTimers(store, home, new Date(at.getTime() + 1_000));
      expect(delivered).toBe(1);
      const inbox = await readInbox({ session: "orch-crash-a", home, markRead: false });
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0].body).toMatchObject({ timer: "wake", action: "check the deploy" });
      expect(store.timers("orch-crash-a")).toHaveLength(0); // now genuinely fired
    } finally { store.close(); }
  });

  it("crash after the inbox write landed but before confirmTimerDelivered -- the retried delivery is idempotent, exactly one inbox entry", async () => {
    const { store, home } = await openStore("headroom-firedue-crash-after-send-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-crash-b", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));
      const crashedClaim = store.claimTimer("orch-crash-b", "wake", at)!;
      // Simulates the crashed process's own write having actually landed on
      // disk just before it died -- the exact same call fireDueTimers itself
      // would have made, with the exact same deterministic identity.
      const firstWrite = await sendInboxMessageAt({
        to: "orch-crash-b", kind: "handoff", from: "headroom-timer",
        text: JSON.stringify({ timer: "wake", at: crashedClaim.at, action: crashedClaim.action }),
        delivery_id: crashedClaim.delivery_id,
        home, now: at,
      });
      expect(firstWrite.delivered).toBe(true);
      // Crash: confirmTimerDelivered was never reached, so the claim is
      // still outstanding and fired_at is still null.
      expect(store.timers("orch-crash-b")).toHaveLength(1);

      expect(store.reclaimStaleTimerClaims()).toBe(1);
      const delivered = await fireDueTimers(store, home, new Date(at.getTime() + 1_000));
      // The retried attempt's own send recognizes the message already on
      // disk (delivered: false internally) and skips writing -- but
      // confirmTimerDelivered still runs and still counts as this pass
      // having closed the timer out.
      expect(delivered).toBe(1);
      const inbox = await readInbox({ session: "orch-crash-b", home, markRead: false });
      expect(inbox.messages).toHaveLength(1); // never two
      expect(store.timers("orch-crash-b")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("still delivers the inbox entry with --if-missed drop, but raises no timer_missed event even while the owner's heartbeat is lapsed", async () => {
    const { store, home } = await openStore("headroom-firedue-drop-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 60_000;
      store.heartbeatBeat("orch-h", intervalMs, null, start);
      const at = new Date(start.getTime() + 2 * intervalMs + 5_000);
      store.checkHeartbeatLapses(at);
      expect(store.heartbeatLapsed("orch-h")).toBe(true);

      store.setTimer("orch-h", "silent-check", at.toISOString(), "check silently", "drop", start);
      const fired = await fireDueTimers(store, home, at);
      expect(fired).toBe(1);
      const inbox = await readInbox({ session: "orch-h", home, markRead: false });
      expect(inbox.messages).toHaveLength(1);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "timer_missed")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("raises one timer_missed event when --if-missed notify fires while the owner's heartbeat is lapsed, and none while it is not", async () => {
    const { store, home } = await openStore("headroom-firedue-notify-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 60_000;

      // Not lapsed: a due timer for an owner who is beating on schedule
      // raises no timer_missed at all.
      store.heartbeatBeat("orch-i", intervalMs, null, start);
      store.setTimer("orch-i", "on-time-check", start.toISOString(), "check on time", "notify", start);
      await fireDueTimers(store, home, start);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "timer_missed")).toHaveLength(0);

      // Lapsed: a due timer for an owner whose heartbeat has lapsed raises
      // exactly one timer_missed.
      const lapsedAt = new Date(start.getTime() + 2 * intervalMs + 5_000);
      store.checkHeartbeatLapses(lapsedAt);
      expect(store.heartbeatLapsed("orch-i")).toBe(true);
      store.setTimer("orch-i", "missed-check", lapsedAt.toISOString(), "check while unattended", "notify", start);
      await fireDueTimers(store, home, lapsedAt);
      const missed = store.events(start.toISOString()).filter((event) => event.kind === "timer_missed");
      expect(missed).toHaveLength(1);
      // The owner is an orchestrator identity, not a vendor account: it
      // belongs in metadata/reason only, never in principal_id -- same
      // convention as heartbeat_lapsed/heartbeat_restored.
      expect(missed[0].principal_id).toBeNull();
      expect(missed[0].metadata).toMatchObject({ owner: "orch-i", timer_name: "missed-check", action: "check while unattended" });
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// notify.ts integration: heartbeat_lapsed/heartbeat_restored/timer_missed go
// through the exact same ledger dedupe and quiet-hours gate as every other
// event kind -- no bespoke delivery path.
// ---------------------------------------------------------------------------

const TOKEN = "1234567:AA-not-a-real-token";
const CONFIG = `
[notify]
channels = ["telegram"]
events = ["heartbeat_lapsed", "heartbeat_restored", "timer_missed"]

[notify.telegram]
chat_id = "555"
`;

function config(): NotifyConfig {
  const parsed = parseNotifyConfig(CONFIG);
  if (!parsed) throw new Error("expected a notify config");
  return parsed;
}

const secretStore: CommandRunner = async () => `${TOKEN}\n`;

interface Call { url: string; body: string; }
function recorder(): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input) => {
    const request = input as Request;
    calls.push({ url: request.url, body: await request.text() });
    return new Response("ok", { status: 200 });
  };
  return { calls, fetcher };
}

function options(extra: Partial<NotifyOptions> = {}): NotifyOptions {
  return { config: config(), platform: "darwin", run: secretStore, log: async () => undefined, ...extra };
}

describe("notify integration", () => {
  it("delivers one message for a lapse, never repeats it across polls, and delivers one restore message", async () => {
    const { store } = await openStore("headroom-notify-heartbeat-");
    const { calls, fetcher } = recorder();
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 5 * 60_000;
      // Priming pass before anything exists: establishes the discovery
      // marker so only what happens after this counts as "new".
      await deliverNotifications(store, options({ fetcher, now: start }));
      expect(calls).toHaveLength(0);

      store.heartbeatBeat("orch-j", intervalMs, "resume: rerun the deploy", start);
      const lapsedAt = new Date(start.getTime() + 2 * intervalMs + 1_000);
      store.checkHeartbeatLapses(lapsedAt);

      const firstPass = await deliverNotifications(store, options({ fetcher, now: lapsedAt }));
      expect(firstPass.sent).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toContain("Heartbeat lapsed");
      expect(calls[0].body).toContain("orch-j");
      expect(calls[0].body).toContain("resume: rerun the deploy");

      // A later poll before anything changes must never resend it.
      const secondPass = await deliverNotifications(store, options({ fetcher, now: new Date(lapsedAt.getTime() + 60_000) }));
      expect(secondPass.sent).toBe(0);
      expect(calls).toHaveLength(1);

      const resumeAt = new Date(lapsedAt.getTime() + 120_000);
      store.heartbeatBeat("orch-j", intervalMs, null, resumeAt);
      const thirdPass = await deliverNotifications(store, options({ fetcher, now: resumeAt }));
      expect(thirdPass.sent).toBe(1);
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toContain("Heartbeat restored");
      expect(calls[1].body).toContain("orch-j");
    } finally { store.close(); }
  });

  it("holds a lapse message through quiet hours and sends it once quiet hours end", async () => {
    const { store } = await openStore("headroom-notify-heartbeat-quiet-");
    const { calls, fetcher } = recorder();
    try {
      const night = new Date(2026, 8, 28, 23, 30);
      const morning = new Date(2026, 8, 29, 8, 0);
      const quiet = { ...config(), quiet_hours: { start: 23 * 60, end: 7 * 60 } };
      await deliverNotifications(store, options({ config: quiet, fetcher, now: new Date(night.getTime() - 3_600_000) }));

      store.heartbeatBeat("orch-k", 60_000, "resume: nothing", new Date(night.getTime() - 200_000));
      store.checkHeartbeatLapses(new Date(night.getTime() - 60_000));

      const held = await deliverNotifications(store, options({ config: quiet, fetcher, now: night }));
      expect(held).toMatchObject({ quiet: true, sent: 0 });
      expect(calls).toHaveLength(0);
      expect(store.notifyPending("telegram")).toHaveLength(1);

      const sent = await deliverNotifications(store, options({ config: quiet, fetcher, now: morning }));
      expect(sent.sent).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toContain("Heartbeat lapsed");
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// mcp.ts: quota_heartbeat -- both the daemon-code-path wrapping (a stubbed
// `call`, no real socket) and the direct fallback (no daemon at all).
// ---------------------------------------------------------------------------

describe("quota_heartbeat", () => {
  it("wraps a daemon-sourced beat and stop reply the same shape as the direct fallback", async () => {
    const home = await tempHome("headroom-mcp-heartbeat-daemon-");
    await withHeadroomHome(home, async () => {
      const beat = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_heartbeat","arguments":{"owner":"triage-bot","interval_ms":300000,"resume_sentence":"rerun the deploy"}}}', async (method, params) => {
        expect(method).toBe("heartbeat_beat");
        expect(params).toMatchObject({ owner: "triage-bot", interval_ms: 300_000, resume_sentence: "rerun the deploy" });
        return { owner: "triage-bot", interval_ms: 300_000, resume_sentence: "rerun the deploy", started_at: "2026-09-28T12:00:00.000Z", last_beat_at: "2026-09-28T12:00:00.000Z", lapsed_since: null, updated_at: "2026-09-28T12:00:00.000Z" };
      });
      expect(beat).toMatchObject({ result: { structuredContent: { source: "daemon", heartbeat: { owner: "triage-bot", interval_ms: 300_000 } } } });

      const stop = await handleMcp('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quota_heartbeat","arguments":{"owner":"triage-bot","stop":true}}}', async (method, params) => {
        expect(method).toBe("heartbeat_stop");
        expect(params).toEqual({ owner: "triage-bot" });
        return { stopped: true };
      });
      expect(stop).toMatchObject({ result: { structuredContent: { source: "daemon", stopped: true } } });
    });
  });

  it("beats and stops directly with no daemon running, deriving an owner when none is given", async () => {
    const home = await tempHome("headroom-mcp-heartbeat-direct-");
    await withHeadroomHome(home, async () => {
      const beat = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_heartbeat","arguments":{"interval_ms":60000}}}', async () => undefined);
      const structured = (beat as { result: { structuredContent: { source: string; heartbeat: { owner: string; interval_ms: number } } } }).result.structuredContent;
      expect(structured.source).toBe("direct");
      expect(structured.heartbeat.interval_ms).toBe(60_000);
      expect(structured.heartbeat.owner).toMatch(/^mcp-client#/);

      const store = await HeadroomStore.open(home);
      try { expect(store.heartbeats()).toHaveLength(1); } finally { store.close(); }
    });
  });
});

// ---------------------------------------------------------------------------
// CLI/MCP parity: quota_status must carry heartbeats/due_timers exactly like
// `headroom status --json` does, over every path -- daemon, direct, and
// cache (the cache path is exercised in test/cached-reads.test.ts's own
// "quota_status is served from the read-only cache, flagged" test).
// ---------------------------------------------------------------------------

describe("quota_status daemon-path parity", () => {
  it("carries heartbeats and due_timers from a real (in-process) daemon's own store, via the heartbeats/timer_list RPCs quota_status now calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-mcp-status-parity-"));
    temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      const internal = daemon as unknown as { store: HeadroomStore };
      const now = new Date("2026-09-28T12:00:00.000Z");
      internal.store.heartbeatBeat("cadence", 60_000, "resume: rerun the deploy", new Date(now.getTime() - 3 * 60_000));
      internal.store.checkHeartbeatLapses(now);
      // mcp.ts's own due-timer filter (unlike the store methods above) uses
      // the real wall clock, since it runs inside production dispatch code
      // with no injected test clock -- the timer's `at` must therefore be
      // safely in the past relative to real now, not merely before the
      // fixture's own fixed `now`.
      internal.store.setTimer("cadence", "check-pr", "2020-01-01T00:00:00.000Z", "check PR CI status", "notify", new Date(now.getTime() - 60_000));
      // The "status" RPC's own poll() call fires any currently-due timer as
      // a real side effect (see daemon.ts's own throttled block) -- correct
      // production behavior, but it would otherwise consume this test's
      // timer before quota_status ever gets to read it back as "due".
      // Pre-claiming the same throttle key is exactly what a status call a
      // few seconds earlier would already have done, and isolates the
      // wiring this test is actually about: that quota_status's `due_timers`
      // reads from the same store this timer was seeded into.
      internal.store.claimDaemonInterval("heartbeat_timer_check", new Date(), 15_000);

      // A stand-in for daemonCall that dispatches to this same in-process
      // daemon's private handleLine() (authedHandleLine, the project's own
      // helper for exactly this) instead of dialing a real socket -- the
      // point here is exercising handleMcp's own daemon-array-normalization
      // path (mcp.ts's `method === "status" && Array.isArray(finalResult)`
      // branch, which now also calls "heartbeats"/"timer_list"), not the
      // socket transport itself.
      const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const reply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
      };
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}', call);
      const structured = (response as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      expect(structured.heartbeats).toEqual([expect.objectContaining({ owner: "cadence", resume_sentence: "resume: rerun the deploy", lapsed_since: expect.any(String) })]);
      expect(structured.due_timers).toEqual([expect.objectContaining({ owner: "cadence", name: "check-pr", action: "check PR CI status" })]);
    } finally { await daemon.stop(); }
  });
});
