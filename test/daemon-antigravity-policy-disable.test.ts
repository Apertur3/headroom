import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import { setProcIdentityDeniedForTest } from "../src/process-tree.js";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

/**
 * Proves that a policy-level `antigravity_keepalive = false`
 * must stop an EXISTING supervisor -- whether it is currently `running` or
 * merely has a scheduled restart pending after a crash -- exactly as
 * surely as an accounts.toml-level disable already does (see
 * test/daemon-antigravity-disabled.test.ts's own "restart scheduled" test,
 * which this file mirrors on the policy side). Before the fix,
 * the poll callback skipped maybeStartKeepalive() whenever a supervisor was
 * already `running`, so a policy change was never observed. A supervisor
 * with a restart pending must be reconciled too.
 */
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

async function withoutPs<T>(root: string, body: () => Promise<T>): Promise<T> {
  const bin = join(root, "no-ps-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ps"), "#!/bin/sh\necho 'ps: denied' >&2\nexit 1\n", { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  setProcIdentityDeniedForTest(true); // a host that denies ps denies /proc too
  try { return await body(); } finally { process.env.PATH = previous; setProcIdentityDeniedForTest(false); }
}

describe.skipIf(process.platform === "win32")("HeadroomDaemon: a policy-level disable stops an existing keepalive through the same serialized path an account-level disable uses", () => {
  it("stops a currently-running supervisor once policy.toml disables it, on the next attempt -- not just a future NEW one", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-policydisable-running-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withoutPs(root, async () => {
        try {
          try { await daemon.start(); }
          catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") { expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
            throw error;
          }
          const internal = daemon as unknown as {
            keepalive: { running: boolean; pid?: number } | undefined;
            poll(principal: string | undefined, forced: boolean): Promise<unknown>;
          };
          expect(internal.keepalive?.running).toBe(true);
          const agyPid = track(internal.keepalive?.pid, root) as number;
          track(Number(await waitForFile(infoFile)), root);

          // Disable via POLICY, not accounts -- the account itself stays
          // enabled throughout. The next real poll must reconcile the policy
          // even while the supervisor is currently running.
          await writeFile(join(root, "policy.toml"), "antigravity_keepalive = false\n", { mode: 0o600 });

          await internal.poll(undefined, true);

          await vi.waitFor(() => { expect(internal.keepalive).toBeUndefined(); }, { timeout: 3_000, interval: 20 });
          await waitUntilDead(agyPid);
          expect(alive(agyPid)).toBe(false);
        } finally {
          await daemon.stop();
        }
      });
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("stops a supervisor that has a restart scheduled (not currently `running`) once policy.toml disables it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-policydisable-restartpending-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations: [], failures: [] }) });
    try {
      await withoutPs(root, async () => {
        try {
          try { await daemon.start(); }
          catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") { expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
            throw error;
          }
          const internal = daemon as unknown as {
            keepalive: { running: boolean; pid?: number } | undefined;
            poll(principal: string | undefined, forced: boolean): Promise<unknown>;
          };
          const scriptPid = track(internal.keepalive?.pid, root) as number;
          track(Number(await waitForFile(infoFile)), root);

          // Externally crash script -- the keepalive is momentarily not
          // `running` (its own exit handler reaps the real orphan, confirms
          // it, then schedules a restart) but the supervisor object itself is
          // not gone, and that restart WILL eventually fire if nothing stops it.
          process.kill(scriptPid, "SIGKILL");
          await waitUntilDead(scriptPid);
          await vi.waitFor(() => {
            expect(internal.keepalive).toBeDefined();
            expect(internal.keepalive?.running).toBe(false);
          }, { timeout: 3_000, interval: 20 });

          // Disable via POLICY while in exactly this state. The account
          // itself stays enabled throughout.
          await writeFile(join(root, "policy.toml"), "antigravity_keepalive = false\n", { mode: 0o600 });
          await internal.poll(undefined, true);

          await vi.waitFor(() => { expect(internal.keepalive).toBeUndefined(); }, { timeout: 3_000, interval: 20 });
          // Give the (correctly cancelled) restart every chance to have fired
          // anyway if the fix did not actually take: no new agy shows up.
          await rm(infoFile, { force: true });
          await new Promise((resolve) => setTimeout(resolve, 300));
          await expect(readFile(infoFile, "utf8")).rejects.toThrow();
        } finally {
          await daemon.stop();
        }
      });
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);
});
