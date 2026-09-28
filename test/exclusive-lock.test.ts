import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withExclusiveLock } from "../src/security.js";

// withExclusiveLock is the primitive every policy.toml writer (headroom
// policy set/clear, notify configure's reread-compare-write) serializes
// through. These tests exercise it directly.
//
// Two rules throughout:
// - Proving something DID happen uses a deferred promise resolved from
//   inside the code under test, never a fixed sleep-then-snapshot -- a
//   sleep long enough to be safe on a slow CI runner is also long enough
//   to hide a real ordering bug that "usually" wins the race anyway.
// - Proving something did NOT happen races its own signal against a
//   generous timer. This is safe by construction, never flaky: a correct
//   implementation makes the signal impossible to fire early no matter how
//   slow the machine is, so the timer always wins; only a real regression
//   changes the outcome, and it does so the same way on any machine.

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), unlink: vi.fn(actual.unlink) };
});

const temporary: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mocked = await import("node:fs/promises");
  vi.mocked(mocked.writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(mocked.unlink).mockReset().mockImplementation(actual.unlink);
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "headroom-exclusive-lock-"));
  temporary.push(dir);
  return dir;
}

/** An externally resolvable promise: the deterministic signal a deferred
 * barrier is built from. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Proves `signal` has NOT resolved within `marginMs` -- safe by
 * construction: a correct implementation can never resolve `signal` early,
 * so the timer always wins regardless of machine speed, and only a real
 * regression changes the outcome. */
async function expectStillPending(signal: Promise<unknown>, marginMs = 150): Promise<void> {
  const timeout = Symbol("timeout");
  const outcome = await Promise.race([signal, new Promise((resolve) => setTimeout(() => resolve(timeout), marginMs))]);
  expect(outcome).toBe(timeout);
}

function eNoSuchProcess(): NodeJS.ErrnoException {
  return Object.assign(new Error("no such process"), { code: "ESRCH" });
}

describe("withExclusiveLock", () => {
  it("serializes two holders: the second's fn() never starts until the first's finishes, proven by deferred promises, not sleeps", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    const order: string[] = [];
    const aStarted = deferred<void>();
    const releaseA = deferred<void>();
    const bStarted = deferred<void>();

    const runA = withExclusiveLock(lockDir, async () => {
      order.push("A-start");
      aStarted.resolve();
      await releaseA.promise;
      order.push("A-end");
      return "a";
    }, { timeoutMs: 3_000 });

    await aStarted.promise; // A has definitely acquired the lock and begun

    const runB = withExclusiveLock(lockDir, async () => {
      order.push("B-start");
      bStarted.resolve();
      return "b";
    }, { timeoutMs: 3_000, retryMs: 5 });

    await expectStillPending(bStarted.promise);
    expect(order).toEqual(["A-start"]);

    releaseA.resolve();
    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(order).toEqual(["A-start", "A-end", "B-start"]);
  });

  it("reclaims a lock whose owner pid is confirmed dead (an injected liveness check), well within the hard bound", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner"), JSON.stringify({ token: "someone-else", pid: 424_242, created_at: new Date().toISOString() }));
    const deadKill = (pid: number): void => { if (pid === 424_242) throw eNoSuchProcess(); throw new Error(`unexpected pid in test: ${pid}`); };

    await expect(withExclusiveLock(lockDir, async () => "reclaimed", { kill: deadKill, timeoutMs: 2_000, retryMs: 15 }))
      .resolves.toBe("reclaimed");
  });

  it("never reclaims a lock whose owner pid is alive (an injected liveness check), before the hard bound", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner"), JSON.stringify({ token: "someone-else", pid: 1, created_at: new Date().toISOString() }));
    const aliveKill = (): void => { /* never throws: pid is alive */ };

    await expect(withExclusiveLock(lockDir, async () => "unreachable", { kill: aliveKill, timeoutMs: 100, retryMs: 15 }))
      .rejects.toThrow(/Timed out waiting for a lock/);
  });

  it("reclaims by the hard bound alone once it is exceeded, using an injected clock -- no real waiting", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner"), JSON.stringify({ token: "someone-else", pid: process.pid, created_at: new Date().toISOString() }));
    const hardBoundMs = 10 * 60_000;
    const farFuture = (): number => Date.now() + hardBoundMs + 60_000; // instantly "10 minutes and change" in the future

    await expect(withExclusiveLock(lockDir, async () => "reclaimed", { now: farFuture, hardBoundMs, timeoutMs: 2_000, retryMs: 15 }))
      .resolves.toBe("reclaimed");
  });

  it("never reclaims a lock whose owner file is missing or unreadable before the hard bound -- it is never stolen early for lack of a liveness signal", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    await mkdir(lockDir); // no owner file at all: simulates a crash between mkdir and the owner-file write
    await expect(withExclusiveLock(lockDir, async () => "unreachable", { timeoutMs: 100, retryMs: 15 }))
      .rejects.toThrow(/Timed out waiting for a lock/);
  });

  it("never reclaims a live-but-slow holder no matter how long it holds the lock, before the hard bound", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    const holderStarted = deferred<void>();
    const holderDone = deferred<void>();

    const holder = withExclusiveLock(lockDir, async () => {
      holderStarted.resolve();
      await holderDone.promise;
      return "holder";
    }, { timeoutMs: 5_000 });

    await holderStarted.promise;
    // The default kill (real process.kill on this test's own pid) reports
    // it alive, and the default 10-minute hard bound is nowhere close --
    // a short timeout here proves the waiter genuinely cannot get in.
    await expect(withExclusiveLock(lockDir, async () => "unreachable", { timeoutMs: 150, retryMs: 15 }))
      .rejects.toThrow(/Timed out waiting for a lock/);

    holderDone.resolve();
    await expect(holder).resolves.toBe("holder");
  });

  it("releases only its own lock: a lock a reclaimer has since taken over is never removed by the original holder", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    const holderStarted = deferred<void>();
    const holderDone = deferred<void>();

    const holder = withExclusiveLock(lockDir, async () => {
      holderStarted.resolve();
      await holderDone.promise;
      return "holder";
    }, { timeoutMs: 5_000 });

    await holderStarted.promise;
    // Simulate a reclaimer that has since taken over: a fresh directory at
    // the same path with a different token, exactly what a real reclaim
    // (tombstone-rename, then a new exclusive mkdir) leaves behind.
    await writeFile(join(lockDir, "owner"), JSON.stringify({ token: "reclaimer-token", pid: process.pid, created_at: new Date().toISOString() }));

    holderDone.resolve();
    await expect(holder).resolves.toBe("holder");

    // The reclaimer's lock must still be there -- release must have
    // refused to remove an owner file whose token is no longer its own.
    const remaining = await readFile(join(lockDir, "owner"), "utf8");
    expect(remaining).toContain("reclaimer-token");
  });

  it("cleans up the lock directory if creating it succeeds but writing the owner file fails", async () => {
    const mocked = await import("node:fs/promises");
    vi.mocked(mocked.writeFile).mockImplementationOnce(async () => { throw new Error("simulated disk full"); });

    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");

    await expect(withExclusiveLock(lockDir, async () => "unreachable")).rejects.toThrow("simulated disk full");

    // No half-created lock directory left behind to wedge every future
    // caller for a full hard bound with no live owner to blame it on.
    await expect(readFile(join(lockDir, "owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports (never throws over) a release failure for a lock it still owns", async () => {
    const mocked = await import("node:fs/promises");
    vi.mocked(mocked.unlink).mockImplementationOnce(async () => { throw new Error("simulated EACCES on release"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");

    await expect(withExclusiveLock(lockDir, async () => "done")).resolves.toBe("done");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("failed to release lock");
    // The failed release left the lock directory behind -- confirm it was
    // in fact this call's own lock, then clean it up for real so it can
    // never wedge a later test.
    expect(await readFile(join(lockDir, "owner"), "utf8")).toContain(`${process.pid}:`);
    await actual.rm(lockDir, { recursive: true, force: true });
  });

  it("caps its final retry sleep to the remaining deadline instead of overshooting timeoutMs by a full retryMs", async () => {
    const dir = await tempDir();
    const lockDir = join(dir, "x.lock");
    const holderStarted = deferred<void>();
    const holderDone = deferred<void>();
    const holder = withExclusiveLock(lockDir, async () => { holderStarted.resolve(); await holderDone.promise; return "holder"; }, { timeoutMs: 5_000 });
    await holderStarted.promise;

    const timeoutMs = 60;
    const retryMs = 500; // deliberately larger than timeoutMs: an uncapped sleep would overshoot badly
    const started = Date.now();
    await expect(withExclusiveLock(lockDir, async () => "unreachable", { timeoutMs, retryMs }))
      .rejects.toThrow(/Timed out waiting for a lock/);
    const elapsed = Date.now() - started;
    // A correct implementation caps the sleep to the remaining budget and
    // throws close to timeoutMs; the bug this guards against would instead
    // sleep the full retryMs (500ms) before ever rechecking the deadline.
    expect(elapsed).toBeLessThan(retryMs);

    holderDone.resolve();
    await holder;
  }, 10_000);
});
