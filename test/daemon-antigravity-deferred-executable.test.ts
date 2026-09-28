import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

/**
 * Isolated from the other daemon tests on purpose: this file gates
 * paths.js's executablePath() so a real maybeStartKeepalive() call can be
 * held open, mid-await, after the fresh accounts/policy re-read earlier in the
 * function, but BEFORE the supervisor is ever constructed or started.
 * While the gate is held, the account is disabled for real (a genuine
 * accounts.toml rewrite through currentAccounts()); the point is proving
 * maybeStartKeepalive() re-checks freshness one more time after THIS
 * specific await settles, rather than trusting the snapshot it already
 * took before entering it.
 */
const gate = vi.hoisted(() => {
  let release: (() => void) | undefined;
  return {
    armed: false,
    hold(): Promise<void> { return new Promise<void>((resolve) => { release = resolve; }); },
    release(): void { release?.(); release = undefined; },
  };
});
vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...actual,
    executablePath: async (path: string, options?: { repoRoot?: string; development?: boolean }) => {
      if (gate.armed) { gate.armed = false; await gate.hold(); }
      return actual.executablePath(path, options);
    },
  };
});

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

const accountsToml = (enabled: boolean, agyPath: string): string => [
  "[[accounts]]", 'name = "antigravity"', `enabled = ${enabled}`,
  'vendor = "antigravity"', 'location = "agy"', 'adapter = "native-ts"', `agy_path = "${agyPath}"`, "",
].join("\n");

async function trackPidIfWritten(path: string, root: string, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 1) { track(pid, root); return; }
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform === "win32")("HeadroomDaemon: maybeStartKeepalive() re-checks freshness after executablePath()'s own await, not just before it", () => {
  it("never constructs or starts a supervisor when the account is disabled while executablePath() is still resolving", async () => {
    const { HeadroomDaemon } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-deferredexe-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    // Disabled at daemon start: start()'s own maybeStartKeepalive() call
    // must return immediately, before ever reaching executablePath(), so
    // the gate armed below applies only to the call this test drives.
    await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      try { await daemon.start(); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") { expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
        throw error;
      }
      const internal = daemon as unknown as {
        keepalive: { running: boolean } | undefined;
        currentAccounts(): Promise<unknown[]>;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      expect(internal.keepalive).toBeUndefined();

      // Real re-enable, exactly like a live accounts.toml edit.
      await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
      const enabledAccounts = await internal.currentAccounts();

      gate.armed = true;
      let resolved = false;
      const attempt = internal.maybeStartKeepalive(enabledAccounts, {}).then(() => { resolved = true; });

      // Give maybeStartKeepalive() time to walk its own fresh re-read,
      // find the (still enabled) account, and reach the gated
      // executablePath() call -- real filesystem work, not instant, so a
      // short real wait here is deterministic enough for the assertion
      // that follows to be meaningful.
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Disable for real WHILE executablePath() is held open.
      await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });

      // Release the gate: executablePath() now actually resolves.
      gate.release();
      await attempt;

      // If this assertion regresses and a fixture does start, register it
      // before failing so the process reaper can clean it up reliably.
      await trackPidIfWritten(infoFile, root);

      expect(resolved).toBe(true);
      // The fix: a fresh re-read AFTER executablePath()'s own await must
      // have seen the disable and refused to construct/start anything.
      expect(internal.keepalive).toBeUndefined();
    } finally {
      gate.release();
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("never constructs or starts a supervisor with an executable selected before its account path changed", async () => {
    const { HeadroomDaemon } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-deferredpath-")); temporary.push(root);
    const firstInfoFile = join(root, "agy-first-pid.txt");
    const secondInfoFile = join(root, "agy-second-pid.txt");
    const firstAgy = await writeFakeAgy(root, firstInfoFile);
    const secondAgy = await writeFakeAgy(root, secondInfoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(false, firstAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      try { await daemon.start(); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") { expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
        throw error;
      }
      const internal = daemon as unknown as {
        keepalive: { running: boolean } | undefined;
        currentAccounts(): Promise<unknown[]>;
        maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void>;
      };
      await writeFile(join(root, "accounts.toml"), accountsToml(true, firstAgy), { mode: 0o600 });
      const enabledAccounts = await internal.currentAccounts();

      gate.armed = true;
      const attempt = internal.maybeStartKeepalive(enabledAccounts, {});
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The selected account remains enabled, but its executable changes
      // while the old path is still being validated.
      await writeFile(join(root, "accounts.toml"), accountsToml(true, secondAgy), { mode: 0o600 });
      gate.release();
      await attempt;

      await trackPidIfWritten(firstInfoFile, root);
      await trackPidIfWritten(secondInfoFile, root);
      expect(internal.keepalive).toBeUndefined();
      await expect(readFile(firstInfoFile, "utf8")).rejects.toThrow();
      await expect(readFile(secondInfoFile, "utf8")).rejects.toThrow();
    } finally {
      gate.release();
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);
});
