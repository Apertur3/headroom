/**
 * P1 fix: a direct-mode `headroom timer set` or
 * `headroom heartbeat` write with no daemon running used to look exactly
 * like any other direct read -- the generic "(direct read, no daemon)"
 * notice on stderr -- even though nothing will ever notice the heartbeat
 * lapse or fire the timer until a daemon actually starts. Both commands now
 * print an explicit, specific warning instead.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("timer set / heartbeat with no daemon running", () => {
  it("still stores the timer directly, but warns it will not be delivered until a daemon starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-timer-no-daemon-")); temporary.push(root);
    await withHeadroomHome(root, async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let warnings: string[];
      try {
        const code = await main(["timer", "set", "--owner", "orch-x", "--name", "wake", "--at", "+5m", "--action", "check status"]);
        expect(code).toBe(0);
        // Captured before mockRestore(), which clears mock.calls like mockReset().
        warnings = stderrSpy.mock.calls.map(([chunk]) => String(chunk));
      } finally { stderrSpy.mockRestore(); }
      expect(warnings.some((line) => /no daemon running/.test(line) && /deliver it when due/.test(line))).toBe(true);
      // Not merely a warning: the write itself still happened directly.
      const store = await HeadroomStore.open(root);
      try { expect(store.timers("orch-x")).toHaveLength(1); } finally { store.close(); }
    });
  });

  it("still records the heartbeat directly, but warns nothing will watch for a lapse until a daemon starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-heartbeat-no-daemon-")); temporary.push(root);
    await withHeadroomHome(root, async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let warnings: string[];
      try {
        const code = await main(["heartbeat", "--owner", "orch-y", "--every", "5m"]);
        expect(code).toBe(0);
        warnings = stderrSpy.mock.calls.map(([chunk]) => String(chunk));
      } finally { stderrSpy.mockRestore(); }
      expect(warnings.some((line) => /no daemon running/.test(line) && /watch for a lapse/.test(line))).toBe(true);
      const store = await HeadroomStore.open(root);
      try { expect(store.heartbeats()).toHaveLength(1); } finally { store.close(); }
    });
  });

  // P2 fix: `headroom timer set` refuses an owner that is not a
  // valid inbox session id, or an action too large to ever be delivered,
  // rather than storing a timer that will retry forever and fail every
  // single delivery attempt.
  it("`timer set` refuses an invalid owner and never stores the row", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-timer-bad-owner-cli-")); temporary.push(root);
    await withHeadroomHome(root, async () => {
      await expect(main(["timer", "set", "--owner", "not a valid id", "--name", "wake", "--at", "+5m", "--action", "check status"])).rejects.toThrow(/valid inbox session id/);
      const store = await HeadroomStore.open(root);
      try { expect(store.timers()).toHaveLength(0); } finally { store.close(); }
    });
  });

  it("heartbeat --stop and timer list still use the plain direct-read notice, not the new warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-heartbeat-stop-no-daemon-")); temporary.push(root);
    await withHeadroomHome(root, async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let warnings: string[];
      try {
        expect(await main(["heartbeat", "--owner", "orch-z", "--stop"])).toBe(0);
        expect(await main(["timer", "list"])).toBe(0);
        warnings = stderrSpy.mock.calls.map(([chunk]) => String(chunk));
      } finally { stderrSpy.mockRestore(); }
      expect(warnings.every((line) => !/watch for a lapse|deliver it when due/.test(line))).toBe(true);
    });
  });
});
