import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepaliveStateFilePath } from "../src/antigravity-keepalive.js";
import { HeadroomDaemon } from "../src/daemon.js";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

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

describe.skipIf(process.platform === "win32")("Antigravity keepalive respects the disabled flag", () => {
  it("never launches for a disabled account, and stops an already-running one once accounts.toml disables it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-disabled-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    // Start disabled: a daemon reading a disabled Antigravity account at
    // startup must never launch its keepalive at all.
    await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      try { await daemon.start(); }
      catch (error: unknown) {
        // The hosted sandbox forbids AF_UNIX listen(2); local/macOS CI runs
        // the round-trip below. Treat only that environmental restriction as
        // skipped, matching this project's other daemon socket tests.
        if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
        throw error;
      }
      const internal = daemon as unknown as {
        keepalive: { running: boolean; pid?: number } | undefined;
        currentAccounts(): Promise<unknown>;
      };
      // Give any (wrongly) started keepalive a moment to actually spawn.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(internal.keepalive?.running).not.toBe(true);
      await expect(readFile(infoFile, "utf8")).rejects.toThrow();

      // Enable it: the next accounts.toml reload must start the keepalive.
      await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();
      // currentAccounts() only reschedules polling; the keepalive itself is
      // (re)started from a completed poll cycle (schedulePrincipal -> poll),
      // same as production. Force one now instead of waiting on the timer.
      await (daemon as unknown as { poll(principal: string | undefined, forced: boolean): Promise<unknown> }).poll(undefined, true);
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(alive(agyPid)).toBe(true);
      expect(internal.keepalive?.running).toBe(true);

      // Disable it again while the daemon (and the keepalive) is running:
      // the existing supervisor must stop, and its agy process must die.
      await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();
      await waitUntilDead(agyPid);
      expect(internal.keepalive?.running).not.toBe(true);
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("maybeStartKeepalive() waits for a still-in-flight keepalive stop, and the supervisor it then starts is a genuinely different instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-stopgate-")); temporary.push(root);
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
        keepalive: { running: boolean; stop(): Promise<void> } | undefined;
        keepaliveStopPending: Promise<void> | undefined;
        currentAccounts(): Promise<unknown>;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      // daemon.start() already launched a real keepalive from accounts.toml
      // (enabled from the start). Disable it through the REAL path
      // (currentAccounts(), not a direct .stop() call) so `this.keepalive`
      // is genuinely nulled the same way production does it -- a direct
      // .stop() call leaves the daemon's own field pointing at the same
      // (now-stopped) instance, which maybeStartKeepalive()'s `??=` would
      // then just restart in place rather than replacing, defeating the
      // identity check below for reasons unrelated to what it exists to
      // prove.
      const firstKeepalive = internal.keepalive;
      const firstAgyPid = track(Number(await waitForFile(infoFile)), root) as number;
      await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();
      await waitUntilDead(firstAgyPid);
      await vi.waitFor(() => { expect(internal.keepalive).toBeUndefined(); }, { timeout: 3_000, interval: 20 });
      await rm(infoFile, { force: true });

      // Stands in for a previous keepalive's stop() still in flight -- see
      // currentAccounts()'s disable branch, which assigns exactly this kind
      // of promise without waiting for it itself. A quick disable-then-
      // re-enable must not let a new supervisor start while that stop()
      // might still be reading or writing the same shared home/state-file
      // paths (see keepaliveStopPending's own doc comment).
      const stopStartedAt = Date.now();
      internal.keepaliveStopPending = new Promise<void>((resolve) => setTimeout(resolve, 300));

      const accounts = [{ name: "antigravity", enabled: true, vendor: "antigravity", location: "agy", adapter: "native-ts", agy_path: fakeAgy }];
      await internal.maybeStartKeepalive(accounts, { antigravity_keepalive: true });

      // Must have waited out the pending stop, not raced past it.
      expect(Date.now() - stopStartedAt).toBeGreaterThanOrEqual(280);
      expect(internal.keepalive?.running).toBe(true);
      expect(internal.keepalive).not.toBe(firstKeepalive); // a genuinely different supervisor, not the stopped one
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(alive(agyPid)).toBe(true);
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("stop() waits for a pending keepalive stop before closing the server and store", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-shutdowngate-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      try { await daemon.start(); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
        throw error;
      }
      const internal = daemon as unknown as { keepaliveStopPending: Promise<void> | undefined };
      // Stands in for a disable cycle's own keepalive.stop() still in
      // flight when SIGTERM arrives -- shutdown must not proceed (closing
      // the server and store) while a maybeStartKeepalive() elsewhere could
      // still be waiting on this SAME promise and resume afterward.
      const startedAt = Date.now();
      internal.keepaliveStopPending = new Promise<void>((resolve) => setTimeout(resolve, 250));

      await daemon.stop();

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(230);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("maybeStartKeepalive() never spawns once the daemon has begun stopping while it was waiting on a pending keepalive stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-stopraces-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
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
        stopping: boolean;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      internal.keepaliveStopPending = new Promise<void>((resolve) => setTimeout(resolve, 100));
      // Simulate real shutdown beginning WHILE maybeStartKeepalive() is
      // waiting on that same promise -- exactly what a SIGTERM racing a
      // disable/re-enable poll looks like from this call's own perspective.
      setTimeout(() => { internal.stopping = true; }, 20);

      const accounts = [{ name: "antigravity", enabled: true, vendor: "antigravity", location: "agy", adapter: "native-ts", agy_path: fakeAgy }];
      await internal.maybeStartKeepalive(accounts, { antigravity_keepalive: true });

      expect(internal.keepalive?.running).not.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(readFile(infoFile, "utf8")).rejects.toThrow(); // never spawned after shutdown began
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("disabling Antigravity stops a supervisor that has a restart scheduled, not only one that is currently `running`", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-reapingdisable-")); temporary.push(root);
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
        keepalive: { running: boolean; pid?: number } | undefined;
        currentAccounts(): Promise<unknown>;
      };
      const scriptPid = track(internal.keepalive?.pid, root) as number;
      track(Number(await waitForFile(infoFile)), root);

      // Externally crash script -- the keepalive is momentarily not
      // `running` (its own exit handler reaps the real orphan, confirms it,
      // then schedules a restart) but the supervisor object itself is not
      // gone, and (real agy, real ps, no corruption here) that restart WILL
      // eventually fire if nothing stops it.
      process.kill(scriptPid, "SIGKILL");
      await waitUntilDead(scriptPid);
      await vi.waitFor(() => {
        expect(internal.keepalive).toBeDefined();
        expect(internal.keepalive?.running).toBe(false);
      }, { timeout: 3_000, interval: 20 });

      // Disable while in exactly this state. The OLD guard
      // (`this.keepalive?.running`) would have skipped this entirely,
      // leaving the scheduled restart free to relaunch later regardless of
      // Antigravity now being disabled.
      await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();

      await vi.waitFor(() => { expect(internal.keepalive).toBeUndefined(); }, { timeout: 3_000, interval: 20 });
      // Give the (correctly cancelled) restart every chance to have fired
      // anyway if the fix did not actually take: no new agy shows up.
      await rm(infoFile, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readFile(infoFile, "utf8")).rejects.toThrow();
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("a real disable/re-enable cycle re-sweeps retained evidence before ever starting a new supervisor, and only starts a genuinely different one once it resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-retained-")); temporary.push(root);
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
        keepalive: { running: boolean; pid?: number } | undefined;
        currentAccounts(): Promise<unknown>;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      const enabledAccounts = [{ name: "antigravity", enabled: true, vendor: "antigravity", location: "agy", adapter: "native-ts", agy_path: fakeAgy }];
      const firstKeepalive = internal.keepalive;
      expect(firstKeepalive).toBeDefined();
      const scriptPid = track(firstKeepalive?.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      const pidFilePath = `${keepaliveStateFilePath(root)}.agy-pid`;
      await waitForFile(pidFilePath);

      // Kill script externally and immediately corrupt the pid file
      // evidence, racing the exit handler: its own reap can never resolve
      // malformed evidence (reapOrphanedAgyThenRestart's "invalid" case),
      // so it retries forever and the supervisor never restarts on its own.
      process.kill(scriptPid, "SIGKILL");
      await writeFile(pidFilePath, "not-a-pid", { mode: 0o600 });
      await waitUntilDead(scriptPid);

      // Disable while the supervisor is stuck retrying: it is stopped by
      // existence, not `.running` -- but its own stop() cannot confirm
      // anything either (child already exited; see stop()'s "everLaunched"
      // branch), so the corrupted evidence survives.
      await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();
      await vi.waitFor(() => { expect(internal.keepalive).toBeUndefined(); }, { timeout: 3_000, interval: 20 });
      await expect(readFile(pidFilePath, "utf8")).resolves.toBe("not-a-pid"); // retained, not cleared

      // Re-enable while that retained, unreadable evidence is still there:
      // the pre-launch sweep must re-read it FRESH (not trust an earlier
      // successful sweep from daemon startup) and reject it -- deferring,
      // never starting a new supervisor on top of a possibly-live orphan
      // this attempt never actually got to look at.
      await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
      await internal.currentAccounts();
      await internal.maybeStartKeepalive(enabledAccounts, { antigravity_keepalive: true });
      expect(internal.keepalive).toBeUndefined(); // still deferred: the retained evidence was never resolved

      // Resolve it (what an operator, or `headroom doctor`, would do) and
      // re-enable again: NOW a genuinely new supervisor must start.
      await rm(pidFilePath, { force: true });
      await rm(keepaliveStateFilePath(root), { force: true });
      await rm(infoFile, { force: true });
      await internal.maybeStartKeepalive(enabledAccounts, { antigravity_keepalive: true });
      const secondAgyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(internal.keepalive).toBeDefined();
      expect(internal.keepalive).not.toBe(firstKeepalive); // a genuinely different supervisor instance
      expect(alive(secondAgyPid)).toBe(true);
      void agyPid; // the original orphan (its evidence deliberately destroyed by this test) is left for the reaper to clean up
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 20_000);
});
