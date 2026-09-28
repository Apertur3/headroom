import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("maybeStartKeepalive() waits for a still-in-flight keepalive stop before constructing a new supervisor", async () => {
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
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      // daemon.start() already launched a real keepalive from accounts.toml
      // (enabled from the start): stop it for real first, so `this.keepalive`
      // is genuinely undefined/not-running going into the actual assertion
      // below -- otherwise maybeStartKeepalive()'s very first guard
      // (`this.keepalive?.running`) would return before ever reaching the
      // keepaliveStopPending check this test exists to exercise.
      const firstAgyPid = track(Number(await waitForFile(infoFile)), root) as number;
      await internal.keepalive?.stop();
      await waitUntilDead(firstAgyPid);
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
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(alive(agyPid)).toBe(true);
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);
});
