import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

/**
 * Isolated from the other daemon tests on purpose: this file gates
 * paths.js's executablePath() so a real maybeStartKeepalive() call can be
 * held open, mid-await, at the exact point Sol's partial-item-2 finding
 * named -- AFTER the fresh accounts/policy re-read earlier in the
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
      await daemon.start();
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
});
