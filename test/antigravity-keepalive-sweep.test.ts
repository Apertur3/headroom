import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor, keepaliveStateFilePath, sweepPreviousKeepalive } from "../src/antigravity-keepalive.js";
import { killTree, processSignature } from "../src/process-tree.js";
import { alive, track, useProcessReaper, writeFakeAgy, writeMortalShim } from "./helpers/mortal-process.js";

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor.stop() (real process tree)", () => {
  it("kills the whole owned tree, including a PTY-session-leader agy that ignores SIGHUP/SIGTERM -- no descendant survives stop()", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);

    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, killGraceMs: 200, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100,
    });
    try {
      supervisor.start();
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      const scriptPid = track(supervisor.pid, root);
      expect(scriptPid).toBeDefined();
      expect(agyPid).not.toBe(scriptPid); // agy is a distinct process, not script itself
      expect(alive(agyPid)).toBe(true);

      await supervisor.stop();

      expect(supervisor.running).toBe(false);
      await waitUntilDead(scriptPid as number);
      await waitUntilDead(agyPid); // the orphan issue #56 leaked -- now reaped
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("clears its recorded state file on a clean stop, so a later sweep finds nothing to do", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-state-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    try {
      supervisor.start();
      track(Number(await waitForFile(infoFile)), root); track(supervisor.pid, root);
      await vi.waitFor(async () => {
        await expect(readFile(keepaliveStateFilePath(root), "utf8")).resolves.toBeTruthy();
      }, { timeout: 3_000, interval: 20 });

      await supervisor.stop();

      await expect(readFile(keepaliveStateFilePath(root), "utf8")).rejects.toThrow();
    } finally { await supervisor.stop(); }
  }, 15_000);
});

/** Runs `body` with a `ps` on PATH that always fails, the way a sandbox that
 * denies the process table behaves, then restores PATH. */
async function withoutPs<T>(root: string, body: () => Promise<T>): Promise<T> {
  const bin = join(root, "no-ps-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ps"), "#!/bin/sh\necho 'ps: denied' >&2\nexit 1\n", { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try { return await body(); } finally { process.env.PATH = previous; }
}

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor never leaves agy behind (product paths)", () => {
  it("learns agy's pid from the launch wrapper, without ps", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-pidfile-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    try {
      supervisor.start();
      track(supervisor.pid, root);
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      // exec keeps the wrapper's pid, so the file the supervisor reads holds agy's own pid
      expect(Number(await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`))).toBe(agyPid);
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("stop() reaps agy when ps is denied from launch through stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-nops-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, killGraceMs: 100, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    try {
      await withoutPs(root, async () => {
        supervisor.start();
        track(supervisor.pid, root);
        const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
        await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`);

        await supervisor.stop();

        await waitUntilDead(agyPid);
      });
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("reaps agy when script dies on its own, before any restart, with ps denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-scriptdied-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 60_000,
    });
    try {
      await withoutPs(root, async () => {
        supervisor.start();
        const scriptPid = track(supervisor.pid, root) as number;
        const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
        await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`);

        process.kill(scriptPid, "SIGKILL"); // external kill of script only: agy is orphaned

        await waitUntilDead(scriptPid);
        await waitUntilDead(agyPid);
      });
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("stop() immediately after start() still reaps agy, with ps denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-quickstop-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, killGraceMs: 100 });
    try {
      await withoutPs(root, async () => {
        supervisor.start();
        track(supervisor.pid, root);
        await supervisor.stop(); // races the wrapper's pid file on purpose
        const agyPid = track(Number(await waitForFile(infoFile).catch(() => "0")), root) as number;
        if (agyPid) await waitUntilDead(agyPid);
      });
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("restarts only after the orphaned agy of a dead script is gone, with ps denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-restart-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const launches: { oldAgyAlive: boolean | undefined }[] = [];
    let firstAgy: number | undefined;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      launches.push({ oldAgyAlive: firstAgy === undefined ? undefined : alive(firstAgy) });
      return spawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, spawn: spyingSpawn, restartDelay: () => 0 });
    try {
      await withoutPs(root, async () => {
        supervisor.start();
        const scriptPid = track(supervisor.pid, root) as number;
        firstAgy = track(Number(await waitForFile(infoFile)), root) as number;
        await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`);
        await rm(infoFile);

        process.kill(scriptPid, "SIGKILL");

        await vi.waitFor(() => expect(launches.length).toBe(2), { timeout: 5_000, interval: 20 });
        track(supervisor.pid, root);
        track(Number(await waitForFile(infoFile)), root);
        expect(launches[1].oldAgyAlive).toBe(false); // reaped before the second launch began
      });
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("refuses to launch while a stale pid file cannot be removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stuckpid-")); temporary.push(root);
    await mkdir(`${keepaliveStateFilePath(root)}.agy-pid`); // a directory: unlink fails with something other than ENOENT
    const spawnCalls: string[] = [];
    const supervisor = new AgyKeepaliveSupervisor({
      binary: "/bin/false", home: root, restartDelay: () => 60_000,
      spawn: ((command: string) => { spawnCalls.push(command); throw new Error("must not spawn"); }) as never,
    });
    try {
      supervisor.start();
      expect(spawnCalls).toEqual([]);
      expect(supervisor.running).toBe(false);
    } finally { await supervisor.stop(); }
  });

  it("never signals a pid it cannot prove is agy (stale pid file after script is gone)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stranger-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
    const strangerPid = track(stranger.pid, root) as number;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 60_000,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      process.kill(scriptPid, "SIGKILL");
      await waitUntilDead(agyPid); // the exit handler reaped the real agy
      // Pretend the pid file now names a recycled pid owned by someone else.
      await writeFile(`${keepaliveStateFilePath(root)}.agy-pid`, String(strangerPid));

      await supervisor.stop(); // script is already gone: nothing proves the pid, so nothing is signalled

      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor: records state for the next daemon start to sweep", () => {
  it("records both script's and agy's pid, command, and start time while running", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-record-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    try {
      supervisor.start();
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      const scriptPid = track(supervisor.pid, root);

      let state: { scriptPid?: number; agyPid?: number; scriptCommand?: string; agyCommand?: string } = {};
      await vi.waitFor(async () => {
        state = JSON.parse(await readFile(keepaliveStateFilePath(root), "utf8"));
        expect(state.agyPid).toBe(agyPid);
      }, { timeout: 3_000, interval: 20 });

      expect(state.scriptPid).toBe(scriptPid);
      expect(typeof state.scriptCommand).toBe("string");
      expect(typeof state.agyCommand).toBe("string");
    } finally { await supervisor.stop(); }
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("sweepPreviousKeepalive", () => {
  it("reaps a previous daemon's leftover script+agy tree end to end, using only the state file it recorded before an unclean exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-e2e-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    let scriptPid: number | undefined;
    let agyPid: number | undefined;
    try {
      supervisor.start();
      agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      scriptPid = track(supervisor.pid, root);
      // Simulate a crash: the daemon process is gone without ever calling
      // stop(), so both processes are still alive and never signalled --
      // only the state file launch() already wrote survives.
      await vi.waitFor(async () => {
        const raw = JSON.parse(await readFile(keepaliveStateFilePath(root), "utf8"));
        expect(raw.agyPid).toBe(agyPid);
      }, { timeout: 3_000, interval: 20 });
      expect(alive(scriptPid as number)).toBe(true);
      expect(alive(agyPid)).toBe(true);

      const result = await sweepPreviousKeepalive(root);

      expect(result.swept.slice().sort((a, b) => a - b)).toEqual([scriptPid, agyPid].sort((a, b) => (a as number) - (b as number)));
      await waitUntilDead(scriptPid as number);
      await waitUntilDead(agyPid);
      await expect(readFile(keepaliveStateFilePath(root), "utf8")).rejects.toThrow(); // state cleared after sweeping
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("does nothing when no state file exists (first ever start, or an already-clean stop)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-empty-"));
    temporary.push(root);
    await expect(sweepPreviousKeepalive(root)).resolves.toEqual({ swept: [] });
  });

  it("sweeps a lone recorded pid whose live signature still matches exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-lone-")); temporary.push(root);
    const infoFile = join(root, "pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn } = await import("node:child_process");
    const child = spawn(fakeAgy, [], { stdio: "ignore", detached: true });
    const pid = track(child.pid, root) as number;
    try {
      await waitForFile(infoFile);
      const signature = await vi.waitFor(async () => {
        const value = await processSignature(pid);
        expect(value).toBeDefined();
        return value!;
      }, { timeout: 3_000, interval: 20 });
      await writeFile(keepaliveStateFilePath(root), JSON.stringify({
        scriptPid: pid, scriptCommand: signature.command, scriptStartedAt: signature.startedAt, recordedAt: new Date().toISOString(),
      }), { mode: 0o600 });

      const result = await sweepPreviousKeepalive(root);

      expect(result.swept).toEqual([pid]);
      await waitUntilDead(pid);
    } finally { if (alive(pid)) await killTree(pid, { graceMs: 100 }); }
  }, 15_000);

  it("never touches a pid whose live command or start time no longer matches what was recorded (pid-reuse safety)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-mismatch-")); temporary.push(root);
    // process.pid (this test runner itself) is guaranteed alive, but is
    // deliberately recorded here as if it were something else entirely --
    // exactly what a stale record pointing at a pid the OS has since
    // recycled would look like.
    await writeFile(keepaliveStateFilePath(root), JSON.stringify({
      scriptPid: process.pid,
      scriptCommand: "/usr/bin/script",
      scriptStartedAt: "Mon Jan  1 00:00:00 2000",
      recordedAt: new Date().toISOString(),
    }), { mode: 0o600 });

    const killed: number[] = [];
    const result = await sweepPreviousKeepalive(root, { killTree: async (pid) => { killed.push(pid); } });

    expect(killed).toEqual([]);
    expect(result.swept).toEqual([]);
    expect(alive(process.pid)).toBe(true);
  });
});
