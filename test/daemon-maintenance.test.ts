/**
 * P1 fix: heartbeat lapse checks, timer firing and the notifier pass used to
 * run only inside account polling (poll()), so with zero enabled accounts
 * they never ran at all, and even with accounts enabled a due timer could
 * wait a full poll interval (4-6 minutes at the default cadence). daemon.ts
 * now owns an independent maintenance timer (scheduleMaintenance) started in
 * start() and stopped in stop(), which reschedules itself around the next
 * real deadline (src/store.ts's nextMaintenanceDeadline) regardless of
 * whether the vendor poller is ever invoked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
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

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error("condition never became true within the timeout");
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
      await waitFor(() => internal.store.timers("orch-a").length === 0);
      // claimTimer() marks a timer fired synchronously, before
      // fireDueTimers's own inbox write (an async filesystem call)
      // completes -- retry the inbox read rather than racing it.
      let delivered = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !delivered) {
        const inbox = await readInbox({ session: "orch-a", home: root, markRead: false });
        delivered = inbox.messages.some((message) => message.kind === "handoff");
        if (!delivered) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(delivered).toBe(true);
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
});
