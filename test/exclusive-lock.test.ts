import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withExclusiveLock } from "../src/security.js";

// withExclusiveLock is the primitive `headroom policy set/clear` serializes
// concurrent writers through (see review finding 10). These tests exercise
// it directly, with explicit deferred barriers rather than Promise.all's
// unforced scheduling, so a passing run is real proof of serialization --
// not a race that merely happened not to lose on this particular run.

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

const temporary: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mocked = await import("node:fs/promises");
  vi.mocked(mocked.open).mockReset().mockImplementation(actual.open);
  vi.mocked(mocked.unlink).mockReset().mockImplementation(actual.unlink);
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "headroom-exclusive-lock-"));
  temporary.push(dir);
  return dir;
}

/** An externally resolvable promise, standing in for "this holder's own
 * work has not finished yet" -- the deferred barrier that forces a real
 * interleaving between two calls instead of hoping Promise.all schedules
 * them the way a bug would need to be caught. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withExclusiveLock", () => {
  it("serializes two holders with a deferred barrier: the second's fn() never starts until the first's finishes", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const order: string[] = [];
    const releaseA = deferred<void>();

    const runA = withExclusiveLock(lockPath, async () => {
      order.push("A-start");
      await releaseA.promise;
      order.push("A-end");
      return "a";
    }, { timeoutMs: 3_000 });

    await sleep(30); // let A actually create the lock before B starts racing for it
    const runB = withExclusiveLock(lockPath, async () => {
      order.push("B-start");
      return "b";
    }, { timeoutMs: 3_000, retryMs: 10 });

    // B must genuinely still be waiting here -- not just "the test happened
    // not to observe it running yet".
    await sleep(80);
    expect(order).toEqual(["A-start"]);

    releaseA.resolve();
    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(order).toEqual(["A-start", "A-end", "B-start"]);
  });

  it("reclaims a fake short lease (a lock file with no live heartbeat) once it goes stale, but refuses to before then", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    // Simulates a crashed holder: a lock file written directly, never
    // refreshed by any heartbeat -- exactly what a process that died
    // mid-edit would leave behind.
    await writeFile(lockPath, "99999:deadbeef\n" + new Date().toISOString() + "\n");

    // Still well within staleMs: must not be stolen.
    await expect(withExclusiveLock(lockPath, async () => "unreachable", { staleMs: 200, timeoutMs: 100, retryMs: 20 }))
      .rejects.toThrow(/Timed out waiting for a lock/);

    // Past staleMs: now reclaimable.
    await sleep(250);
    await expect(withExclusiveLock(lockPath, async () => "reclaimed", { staleMs: 200, timeoutMs: 2_000, retryMs: 20 }))
      .resolves.toBe("reclaimed");
  });

  it("never steals a live-but-slow holder's lock, even though its own fn() runs past staleMs -- the heartbeat keeps it fresh", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const order: string[] = [];
    const staleMs = 150;

    const slow = withExclusiveLock(lockPath, async () => {
      order.push("slow-start");
      await sleep(staleMs * 3); // well past staleMs on its own
      order.push("slow-end");
      return "slow";
    }, { staleMs, timeoutMs: 5_000, retryMs: 20 });

    await sleep(30);
    const waiter = withExclusiveLock(lockPath, async () => {
      order.push("waiter-start");
      return "waiter";
    }, { staleMs, timeoutMs: 5_000, retryMs: 20 });

    const [slowResult, waiterResult] = await Promise.all([slow, waiter]);
    expect(slowResult).toBe("slow");
    expect(waiterResult).toBe("waiter");
    // The waiter must never have run before the slow holder released --
    // if the naive age-only staleness check reclaimed it early, this order
    // would instead read waiter-start before slow-end.
    expect(order).toEqual(["slow-start", "slow-end", "waiter-start"]);
  }, 10_000);

  it("releases only its own lock: a lock a reclaimer already took over while fn() ran is never unlinked out from under them", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const holderDone = deferred<void>();

    const holder = withExclusiveLock(lockPath, async () => {
      await holderDone.promise;
      return "holder";
    }, { timeoutMs: 5_000 });

    await sleep(30); // let the holder actually create the lock
    // Simulate a reclaimer that has since taken over: a different token
    // written to the same path, as a real reclaim (rename-away, then a
    // fresh exclusive create) would leave behind.
    await writeFile(lockPath, "12345:stolen-token\n" + new Date().toISOString() + "\n");

    holderDone.resolve();
    await holder;

    // The "reclaimer's" lock must still be there -- release must have
    // refused to unlink a token that is no longer this call's own.
    const remaining = await readFile(lockPath, "utf8");
    expect(remaining).toContain("stolen-token");
  });

  it("cleans up its own lock file if creating it succeeds but writing or closing it fails", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const fsPromises = await import("node:fs/promises");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(handle) as object), handle, {
        writeFile: async () => { throw new Error("simulated disk full"); },
        close: () => handle.close(),
      }) as typeof handle;
    });

    await expect(withExclusiveLock(lockPath, async () => "unreachable")).rejects.toThrow("simulated disk full");

    // No half-written lock file left behind to wedge every future caller
    // for a full staleMs with no live holder to blame it on.
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports (never throws over) a release failure for a lock it still owns", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const mocked = await import("node:fs/promises");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(mocked.unlink).mockImplementationOnce(async () => { throw new Error("simulated EACCES on release"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(withExclusiveLock(lockPath, async () => "done")).resolves.toBe("done");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("failed to release lock");
    // The failed release left the lock file behind -- clean it up for real
    // so it cannot wedge a later test, and confirm it was in fact this
    // call's own lock (not some other leftover) that failed to unlink.
    expect(await readFile(lockPath, "utf8")).toContain(`${process.pid}:`);
    await actual.unlink(lockPath);
  });

  it("times out waiting for a genuinely busy lock rather than looping forever past timeoutMs", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const holderDone = deferred<void>();
    const holder = withExclusiveLock(lockPath, async () => { await holderDone.promise; return "holder"; }, { timeoutMs: 5_000 });
    await sleep(30);

    const started = Date.now();
    await expect(withExclusiveLock(lockPath, async () => "unreachable", { timeoutMs: 150, retryMs: 20 }))
      .rejects.toThrow(/Timed out waiting for a lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);

    holderDone.resolve();
    await expect(holder).resolves.toBe("holder");
  });
});
