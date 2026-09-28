/**
 * P1 fix: heartbeat lapse checks, timer firing and the notifier pass used to
 * run only inside account polling (poll()), so with zero enabled accounts
 * they never ran at all, and even with accounts enabled a due timer could
 * wait a full poll interval (4-6 minutes at the default cadence). daemon.ts
 * now owns an independent maintenance timer (scheduleMaintenance) started in
 * start() and stopped in stop(), which reschedules itself around the next
 * real deadline (src/store.ts's nextMaintenanceDeadline) regardless of
 * whether the vendor poller is ever invoked.
 *
 * This file also covers the blocker fix for the daemon's own lifecycle: a
 * claimed timer's delivery is confirmed durable only after the inbox write
 * lands (never before), and stop() drains any in-flight maintenance/notifier
 * work before it closes the store -- see src/store.ts's claimTimer/
 * confirmTimerDelivered/releaseTimerClaim/reclaimStaleTimerClaims and
 * src/heartbeat.ts's fireDueTimers for the store/delivery half of that
 * story; test/heartbeat.test.ts covers those directly. What only a real
 * HeadroomDaemon can exercise -- the re-armed scheduler actually firing a
 * future timer, several passes never double-firing, stop() draining an
 * in-flight pass, and a fresh daemon delivering a timer a crashed one left
 * claimed -- is covered here.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import * as inboxModule from "../src/inbox.js";
import { readInbox } from "../src/inbox.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// A Unix socket on POSIX; a named pipe on win32 (see daemon-mcp.test.ts's
// identical helper -- a real Windows daemon never listens on a bare
// filesystem path).
function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

/**
 * Bounded, short real-time polling -- not a fake clock. A real
 * HeadroomDaemon.start()/stop() does real async I/O the daemon-owned
 * scheduler's own delay clamps mean no wait in this file ever needs to
 * exceed a few seconds (MAINTENANCE_MIN_DELAY_MS is 1s, and every timer
 * below is scheduled only a couple of seconds out): mixing a real socket
 * bind/keepalive-sweep lifecycle with a faked global clock risks destabilizing
 * unrelated internals (net/fs scheduling) for a test correctness gain this
 * short, bounded polling already gets without that risk.
 */
async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error("condition never became true within the timeout");
}

async function waitForDelivery(session: string, home: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inbox = await readInbox({ session, home, markRead: false });
    if (inbox.messages.some((message) => message.kind === "handoff")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timer for ${session} was never delivered within the timeout`);
}

describe("daemon-owned maintenance scheduler", () => {
  it("lapses a heartbeat and fires a due timer with zero accounts configured, without the vendor poller ever running", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-maintenance-")); temporary.push(root);
    let pollerCalls = 0;
    const daemon = await HeadroomDaemon.create({
      home: root,
      path: testSocketPath(root, "maintenance"),
      poller: async () => { pollerCalls += 1; return { observations: [], failures: [] }; },
    });
    const internal = daemon as unknown as { store: HeadroomStore };
    const now = new Date();
    // Both registered directly on the store, as if an orchestrator had beat
    // and scheduled a wake-up before this daemon process (re)started -- no
    // accounts.toml exists in this home, so nothing here is ever reachable
    // through poll()'s account-driven scheduling or an RPC that triggers it.
    internal.store.heartbeatBeat("orch-a", 200, undefined, new Date(now.getTime() - 5_000));
    internal.store.setTimer("orch-a", "wake", new Date(now.getTime() - 1_000).toISOString(), "check status", "notify", now);
    try {
      await daemon.start();
      await waitFor(() => internal.store.heartbeatLapsed("orch-a"));
      await waitForDelivery("orch-a", root);
      expect(pollerCalls).toBe(0);
    } finally { await daemon.stop(); }
  });

  it("stop() cancels the maintenance timer so no further pass is scheduled", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-maintenance-stop-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "maintenance-stop"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as { maintenanceTimer?: NodeJS.Timeout };
    await daemon.start();
    await waitFor(() => internal.maintenanceTimer !== undefined);
    await daemon.stop();
    expect(internal.maintenanceTimer).toBeUndefined();
  });

  // Unlike the first test above (whose timer is already due the instant the
  // daemon starts, so the very first immediate pass delivers it without ever
  // exercising the reschedule/wait logic at all), this one registers a timer
  // due only after startup, so it is provably NOT delivered by that first
  // pass -- only by the scheduler correctly re-arming itself around the new
  // deadline and firing again once it is actually reached.
  it("a timer due only after startup is not delivered early, and fires once the scheduler's re-armed tick reaches it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-maintenance-rearm-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "maintenance-rearm"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as { store: HeadroomStore };
    const now = new Date();
    internal.store.setTimer("orch-future", "wake", new Date(now.getTime() + 2_000).toISOString(), "check status", "notify", now);
    try {
      await daemon.start();
      // Not due yet: the first (immediate) pass must not have delivered it.
      // A short, fixed wait -- not a race against the eventual delivery --
      // since we are asserting the ABSENCE of something at this point.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await readInbox({ session: "orch-future", home: root, markRead: false })).messages).toHaveLength(0);
      expect(internal.store.timers("orch-future")).toHaveLength(1);

      // The scheduler's own re-armed tick (computed by its first pass from
      // nextMaintenanceDeadline()) must reach and fire it on its own, with
      // nothing here ever calling fireDueTimers directly.
      await waitForDelivery("orch-future", root);
      expect(internal.store.timers("orch-future")).toHaveLength(0);
    } finally { await daemon.stop(); }
  });

  // Guards against a double-fire across the scheduler's own recurring
  // passes -- not just within one instant (that is what fireDueTimers'
  // single-claim guarantee, tested directly in heartbeat.test.ts, already
  // covers), but across several real re-arms as the deadline keeps moving
  // from one timer to the next.
  it("recurring passes each fire their own due timer exactly once, never twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-maintenance-recurring-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "maintenance-recurring"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as { store: HeadroomStore };
    const now = new Date();
    const owners = ["orch-r1", "orch-r2", "orch-r3"];
    const offsetsMs = [300, 1_200, 2_400];
    for (const [index, owner] of owners.entries()) {
      internal.store.setTimer(owner, "wake", new Date(now.getTime() + offsetsMs[index]).toISOString(), "check status", "notify", now);
    }
    try {
      await daemon.start();
      for (const owner of owners) await waitForDelivery(owner, root);
      // Give the scheduler a little longer to keep ticking (nothing left to
      // do) and confirm nothing was ever delivered twice.
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const owner of owners) {
        const inbox = await readInbox({ session: owner, home: root, markRead: false });
        expect(inbox.messages.filter((message) => message.kind === "handoff")).toHaveLength(1);
        expect(internal.store.timers(owner)).toHaveLength(0);
      }
    } finally { await daemon.stop(); }
  });

  // Blocker fix: stop() must drain an in-flight delivery before it closes
  // the store, rather than racing it -- otherwise the pending
  // confirmTimerDelivered/releaseTimerClaim call this in-flight send is
  // about to make would run against an already-closed SQLite handle.
  it("stop() waits out an in-flight delivery instead of closing the store underneath it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-maintenance-stop-inflight-")); temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "maintenance-stop-inflight"), poller: async () => ({ observations: [], failures: [] }) });
    const internal = daemon as unknown as { store: HeadroomStore };
    const now = new Date();
    internal.store.setTimer("orch-inflight", "wake", new Date(now.getTime() - 1_000).toISOString(), "check status", "notify", now);

    const realSend = inboxModule.sendInboxMessageAt;
    const calls: string[] = [];
    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const sendSpy = vi.spyOn(inboxModule, "sendInboxMessageAt").mockImplementation(async (options) => {
      calls.push(options.to);
      await gate; // held open until this test explicitly releases it
      return realSend(options);
    });
    try {
      await daemon.start();
      // Wait until the maintenance pass has actually reached the (now
      // gated) send call -- proof a delivery is genuinely in flight, not
      // merely scheduled.
      await waitFor(() => calls.length > 0);

      let stopSettled = false;
      const stopPromise = daemon.stop().then(() => { stopSettled = true; });
      // stop() must not resolve while the gated send is still held open.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stopSettled).toBe(false);

      releaseGate!();
      await stopPromise;
      expect(stopSettled).toBe(true);

      // The delivery that was in flight when stop() was called completed
      // cleanly (against the still-open store stop() correctly waited for),
      // rather than being lost or throwing against an already-closed one.
      const store = await HeadroomStore.open(root);
      try {
        expect(store.timers("orch-inflight")).toHaveLength(0);
      } finally { store.close(); }
      const inbox = await readInbox({ session: "orch-inflight", home: root, markRead: false });
      expect(inbox.messages.filter((message) => message.kind === "handoff")).toHaveLength(1);
    } finally {
      sendSpy.mockRestore();
      await daemon.stop().catch(() => { /* already stopped above in the success path */ });
    }
  });

  // Blocker fix, end to end: a crashed process (never reaches
  // confirmTimerDelivered, never even reaches store.close()'s own cleanup --
  // simulated here by claiming the timer and then closing the store
  // directly, skipping the daemon's own graceful stop()) leaves a claimed
  // but undelivered timer. A fresh daemon process pointed at the same home
  // must still deliver it exactly once, via reclaimStaleTimerClaims() on
  // start().
  it("a fresh daemon delivers a timer a crashed prior process left claimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-maintenance-restart-")); temporary.push(root);
    const now = new Date();
    const crashedStore = await HeadroomStore.open(root);
    crashedStore.setTimer("orch-restart", "wake", new Date(now.getTime() - 1_000).toISOString(), "check status", "notify", now);
    const crashedClaim = crashedStore.claimTimer("orch-restart", "wake", now)!;
    expect(crashedClaim.fired_at).toBeNull();
    crashedStore.close(); // no confirm, no graceful stop() -- simulates a hard kill

    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "maintenance-restart"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      await daemon.start();
      await waitForDelivery("orch-restart", root);
      const inbox = await readInbox({ session: "orch-restart", home: root, markRead: false });
      expect(inbox.messages.filter((message) => message.kind === "handoff")).toHaveLength(1); // exactly once
    } finally { await daemon.stop(); }
  });
});
