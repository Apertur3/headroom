import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

const groupKillCalls = vi.hoisted(() => [] as Array<{ pid: number; options: { groupOnly?: boolean } | undefined }>);

/**
 * Isolated from antigravity-keepalive-sweep.test.ts on purpose: this file
 * mocks process-tree.js's isProcessGroupAlive to make it always report "still
 * alive", which is otherwise indistinguishable from a real hang -- real
 * SIGKILL cannot be blocked or ignored, so there is no way to make a genuine
 * process fail to disappear within stop()'s confirm window using only real
 * processes and real signals. The mock affects only the CONFIRMATION check;
 * the actual kill signals stop() sends are untouched and real, so the agy
 * this test starts genuinely dies -- the point is proving stop() does not
 * *trust* that it died without independently confirming it, using a real
 * process (tracked via mortal-process.ts, never left running) throughout.
 */
vi.mock("../src/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-tree.js")>();
  return {
    ...actual,
    isProcessGroupAlive: () => true,
    killProcessGroup: (pid: number, options?: { groupOnly?: boolean }) => {
      groupKillCalls.push({ pid, options });
      actual.killProcessGroup(pid, options);
    },
  };
});

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => {
  groupKillCalls.splice(0);
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor: confirming a kill worked before trusting or acting on it", () => {
  it("stop() does not clear the recorded state when the confirmation check keeps reporting the target alive after signalling", async () => {
    const { AgyKeepaliveSupervisor, keepaliveStateFilePath } = await import("../src/antigravity-keepalive.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-unconfirmed-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100,
    });
    supervisor.start();
    const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
    track(supervisor.pid, root);

    await supervisor.stop();

    // The real kill signals were sent for real and agy really did exit --
    // isProcessGroupAlive is only mocked, the actual process is not immune
    // to SIGKILL -- but stop() was told (via the mock) that it could never
    // confirm that, so it must not have discarded the evidence.
    expect(alive(agyPid)).toBe(false);
    await expect(readFile(keepaliveStateFilePath(root), "utf8")).resolves.toBeTruthy();
  }, 15_000);

  it("the unexpected-exit path retries reaping, rather than scheduling a restart, when it cannot confirm the kill worked", async () => {
    const { spawn: realSpawn } = await import("node:child_process");
    const { AgyKeepaliveSupervisor, keepaliveStateFilePath } = await import("../src/antigravity-keepalive.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-unconfirmed-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100,
      spawn: spyingSpawn, restartDelay: () => 0, // would restart almost instantly if this path let it
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`);
      expect(spawnCount).toBe(1);

      process.kill(scriptPid, "SIGKILL"); // triggers the unexpected-exit path

      // Long enough for at least one full confirm-timeout window (the
      // mocked isProcessGroupAlive never lets it succeed) plus margin: if
      // this path were, incorrectly, scheduling a restart before confirming
      // anything, a second spawn would show up almost immediately.
      await new Promise((resolve) => setTimeout(resolve, 1_300));

      expect(spawnCount).toBe(1); // no restart while the kill remains unconfirmed
      expect(groupKillCalls).toContainEqual({ pid: agyPid, options: { groupOnly: true } });
      // The evidence a kill was attempted at all is what a later sweep needs
      // -- and it survives, exactly because no restart ran ahead of it.
      await expect(readFile(`${keepaliveStateFilePath(root)}.agy-pid`, "utf8")).resolves.toBeTruthy();
      // The real agy did in fact die for real (SIGKILL cannot be blocked) --
      // only the mocked confirmation lied about it.
      await waitUntilDead(agyPid);
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("start() refuses to launch a replacement while the unexpected-exit path's reap is still unresolved", async () => {
    const { spawn: realSpawn } = await import("node:child_process");
    const { AgyKeepaliveSupervisor, keepaliveStateFilePath } = await import("../src/antigravity-keepalive.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-reaping-guard-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100,
      spawn: spyingSpawn, restartDelay: () => 0,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`);
      expect(spawnCount).toBe(1);

      // Triggers the unexpected-exit path; isProcessGroupAlive is mocked, so
      // its reap can never confirm the kill worked and keeps retrying.
      process.kill(scriptPid, "SIGKILL");

      // A moment for the exit handler to actually start: `running` goes
      // false as soon as `this.child` is cleared -- exactly the state a
      // concurrent poll cycle (elsewhere in the daemon) would observe.
      await vi.waitFor(() => { expect(supervisor.running).toBe(false); }, { timeout: 2_000, interval: 10 });
      expect(supervisor.pid).toBeUndefined();

      // A concurrent caller seeing `running === false` right now (e.g. the
      // daemon's own scheduled poll, via maybeStartKeepalive) must not be
      // able to launch a replacement on top of the still-unresolved orphan.
      supervisor.start();
      supervisor.start();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(spawnCount).toBe(1); // start() refused every time, exactly as `reaping` demands

      await waitUntilDead(agyPid); // the real kill still worked; only confirmation was mocked
    } finally { await supervisor.stop(); }
  }, 15_000);
});
