import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

/**
 * Isolated from the other daemon tests on purpose: this file gates
 * process-tree.js's isProcessGroupAlive so it can hold a REAL stop() call's
 * own confirm-wait step open for a controlled, deterministic window, then
 * release it -- rather than substituting a timer that only stands in for a
 * stop() being in flight. While the gate is open, every check lies "still
 * alive"; once released, it delegates to the real implementation. The
 * actual kill signals stop() sends are untouched and real throughout: only
 * the "is it dead yet" confirmation oracle is gated, so the agy this test
 * starts genuinely dies (for real, via SIGKILL) well before the gate is
 * ever released -- the point is proving maybeStartKeepalive() actually
 * waits for that confirmation step to finish, not that the kill itself is
 * fake.
 */
const gate = vi.hoisted(() => ({ open: true }));
vi.mock("../src/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-tree.js")>();
  return { ...actual, isProcessGroupAlive: (pid: number) => (gate.open ? true : actual.isProcessGroupAlive(pid)) };
});

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim()) return text.trim();
    } catch { /* not written yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const accountsToml = (enabled: boolean, agyPath: string): string => [
  "[[accounts]]", 'name = "antigravity"', `enabled = ${enabled}`,
  'vendor = "antigravity"', 'location = "agy"', 'adapter = "native-ts"', `agy_path = "${agyPath}"`, "",
].join("\n");

describe.skipIf(process.platform === "win32")("HeadroomDaemon: maybeStartKeepalive() waits for a real stop() held open by a gated confirmation check", () => {
  it("leaves a justified non-running supervisor to finish its own reap/restart lifecycle", async () => {
    const { HeadroomDaemon } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-existing-reap-")); temporary.push(root);
    await writeFile(join(root, "accounts.toml"), accountsToml(true, "/not-used"), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const reapingSupervisor = { running: false, managingLifecycle: true, start: vi.fn(), stop: vi.fn(async () => undefined) };
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "headroom"), poller: async () => ({ observations: [], failures: [] }), keepalive: reapingSupervisor as never });
    try {
      const internal = daemon as unknown as {
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
        sweepStaleKeepalive(): Promise<void>;
      };
      const sweep = vi.fn(async () => undefined);
      internal.sweepStaleKeepalive = sweep;

      await internal.maybeStartKeepalive([], {});

      expect(sweep).not.toHaveBeenCalled();
      expect(reapingSupervisor.start).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });

  it("serializes concurrent reconciliation before either caller can sweep a newly started supervisor", async () => {
    const { HeadroomDaemon } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-singleflight-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    let releaseSweep: (() => void) | undefined;
    const heldSweep = new Promise<void>((resolve) => { releaseSweep = resolve; });
    const attempts: Promise<void>[] = [];
    try {
      gate.open = false;
      const internal = daemon as unknown as {
        keepalive: { running: boolean; pid?: number } | undefined;
        sweepStaleKeepalive(): Promise<void>;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      const realSweep = internal.sweepStaleKeepalive.bind(daemon);
      let sweepCalls = 0;
      internal.sweepStaleKeepalive = async () => {
        sweepCalls += 1;
        if (sweepCalls === 1) await heldSweep;
        await realSweep();
      };

      attempts.push(internal.maybeStartKeepalive([], {}));
      expect(sweepCalls).toBe(1);
      attempts.push(internal.maybeStartKeepalive([], {}));
      expect(sweepCalls).toBe(1);

      releaseSweep?.();
      await Promise.all(attempts);
      await vi.waitFor(() => { expect(internal.keepalive?.running).toBe(true); }, { timeout: 3_000, interval: 20 });
      track(internal.keepalive?.pid, root);
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(alive(agyPid)).toBe(true);
    } finally {
      releaseSweep?.();
      await Promise.allSettled(attempts);
      track((daemon as unknown as { keepalive: { pid?: number } | undefined }).keepalive?.pid, root);
      const maybeAgyPid = Number(await readFile(infoFile, "utf8").catch(() => "0"));
      if (maybeAgyPid) track(maybeAgyPid, root);
      await daemon.stop();
      gate.open = false;
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("blocks while the gate is open, and proceeds (to a genuinely new supervisor) only once it is released", async () => {
    const { HeadroomDaemon } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-gatedstop-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      try { await daemon.start(); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
        throw error;
      }
      const internal = daemon as unknown as {
        keepalive: { running: boolean } | undefined;
        keepaliveStopPending: Promise<void> | undefined;
        currentAccounts(): Promise<unknown>;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      const firstKeepalive = internal.keepalive;
      const firstAgyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(firstKeepalive).toBeDefined();

      // Real disable: currentAccounts() fires the real stop() and tracks it
      // via keepaliveStopPending WITHOUT awaiting it. killTree's own
      // SIGTERM+grace+SIGKILL-escalation phase runs for real (the fake agy
      // ignores SIGTERM, so it genuinely dies only once that escalates) --
      // it is ONLY the follow-up confirmation step (waitUntilGroupGone,
      // polling the gated isProcessGroupAlive) that this test controls.
      gate.open = true;
      await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();
      expect(internal.keepalive).toBeUndefined(); // dropped synchronously, before the real stop() settles
      expect(internal.keepaliveStopPending).toBeDefined();
      await rm(infoFile, { force: true });

      // Re-enable immediately, while that real stop() is held open by the
      // gate: maybeStartKeepalive() must block on it, not race past it.
      await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
      let resolved = false;
      const attempt = internal.maybeStartKeepalive([], {}).then(() => { resolved = true; });

      // A real, held-open window: while the gate stays open, this must
      // never resolve, however long we wait.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(resolved).toBe(false);
      expect(internal.keepalive).toBeUndefined();

      // Release the gate: the real stop()'s own confirm-poll loop (already
      // running, checking every 25ms) picks up the truth on its very next
      // tick -- the SIGKILL it sent earlier was real, so agy is in fact
      // already dead -- and the call this test has been awaiting finally
      // proceeds.
      gate.open = false;
      await attempt;

      expect(resolved).toBe(true);
      expect(internal.keepalive?.running).toBe(true);
      expect(internal.keepalive).not.toBe(firstKeepalive); // a genuinely different supervisor, not the stopped one
      await waitUntilDead(firstAgyPid); // the real kill worked all along; only its confirmation was gated
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(alive(agyPid)).toBe(true);
    } finally {
      gate.open = false;
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);
});
