import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor, InvalidKeepaliveEvidenceError, keepaliveLaunchAgyPidFilePath, keepaliveLaunchStateFilePath, keepaliveStateFilePath, sweepPreviousKeepalive } from "../src/antigravity-keepalive.js";
import { killTree, processSignature, setProcIdentityDeniedForTest } from "../src/process-tree.js";
import { alive, track, useProcessReaper, writeFakeAgy, writeMortalShim } from "./helpers/mortal-process.js";

const groupKillCalls = vi.hoisted(() => [] as Array<{ pid: number; options: { groupOnly?: boolean } | undefined }>);
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, uptime: () => 60 * 60 };
});
vi.mock("../src/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-tree.js")>();
  return {
    ...actual,
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

function launchStatePath(root: string, supervisor: AgyKeepaliveSupervisor): string {
  if (!supervisor.launchId) throw new Error("supervisor did not create a launch id");
  return keepaliveLaunchStateFilePath(root, supervisor.launchId);
}

function launchPidPath(root: string, supervisor: AgyKeepaliveSupervisor): string {
  if (!supervisor.launchId) throw new Error("supervisor did not create a launch id");
  return keepaliveLaunchAgyPidFilePath(root, supervisor.launchId);
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
        await expect(readFile(launchStatePath(root, supervisor), "utf8")).resolves.toBeTruthy();
      }, { timeout: 3_000, interval: 20 });

      await supervisor.stop();

      await expect(readFile(launchStatePath(root, supervisor), "utf8")).rejects.toThrow();
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("with the pid file gone, clears a launch's evidence only after the agy pid its own state recorded is confirmed dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-missingpid-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100 });
    try {
      supervisor.start();
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      track(supervisor.pid, root);
      await waitForFile(launchPidPath(root, supervisor));
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8")).agyPid).toBe(agyPid);
      }, { timeout: 3_000, interval: 20 });
      const statePath = launchStatePath(root, supervisor);
      await rm(launchPidPath(root, supervisor), { force: true });

      await supervisor.stop();

      await waitUntilDead(agyPid);
      await expect(readFile(statePath, "utf8")).rejects.toThrow();
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("keeps a launch's evidence when neither its pid file nor its state ever recorded agy", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-noagy-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100 });
    try {
      supervisor.start();
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      track(supervisor.pid, root);
      await waitForFile(launchPidPath(root, supervisor));
      const statePath = launchStatePath(root, supervisor);
      await vi.waitFor(async () => { expect(JSON.parse(await readFile(statePath, "utf8")).agyPid).toBe(agyPid); }, { timeout: 3_000, interval: 20 });
      // Strip what the state learned about agy, then lose the pid file: from
      // stop()'s point of view nothing ever recorded agy.
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      for (const key of ["agyPid", "agyCommand", "agyStartedAt"]) delete state[key];
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
      await rm(launchPidPath(root, supervisor), { force: true });

      await supervisor.stop();

      await waitUntilDead(agyPid); // killTree's own walk still reaches it
      await expect(readFile(statePath, "utf8")).resolves.toBeTruthy();
    } finally { await supervisor.stop(); }
  }, 15_000);
});

/** Runs `body` with a `ps` on PATH that always fails and /proc identity
 * reads refused, the way a sandbox that denies the process table behaves,
 * then restores both. */
async function withoutPs<T>(root: string, body: () => Promise<T>): Promise<T> {
  const bin = join(root, "no-ps-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ps"), "#!/bin/sh\necho 'ps: denied' >&2\nexit 1\n", { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  setProcIdentityDeniedForTest(true);
  try { return await body(); } finally { process.env.PATH = previous; setProcIdentityDeniedForTest(false); }
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
      expect(Number(await waitForFile(launchPidPath(root, supervisor)))).toBe(agyPid);
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
        await waitForFile(launchPidPath(root, supervisor));

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
        await waitForFile(launchPidPath(root, supervisor));

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
        await waitForFile(launchPidPath(root, supervisor));
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
    await mkdir(`${keepaliveStateFilePath(root)}.agy-pid`); // legacy migration evidence must block the daemon sweep
    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
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
      // Pretend the pid file names a recycled pid owned by someone else. It is
      // written BEFORE script dies: after the exit, the orphan reaper races to
      // reconcile and delete this launch directory, so a late write either
      // hit a missing directory or landed after the evidence was already gone.
      // With conflicting evidence the reaper fails closed and leaves agy to the
      // afterEach reaper; the property under test is only that the stranger lives.
      await vi.waitFor(async () => { expect(JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8")).agyPid).toBe(agyPid); }, { timeout: 5_000, interval: 20 });
      await writeFile(launchPidPath(root, supervisor), String(strangerPid));
      process.kill(scriptPid, "SIGKILL");
      await waitUntilDead(scriptPid, 10_000);

      await supervisor.stop(); // script is already gone: nothing proves the pid, so nothing is signalled

      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);

  /** Starts a launch, waits until its state has learned agy, then rolls the
   * state back to the provisional record it holds before recordState()
   * finishes: the window in which script can exit on a slow host. */
  async function launchWithEarlyState(root: string, infoFile: string, fakeAgy: string) {
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 60_000,
    });
    supervisor.start();
    const scriptPid = track(supervisor.pid, root) as number;
    const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
    const statePath = launchStatePath(root, supervisor);
    await vi.waitFor(async () => { expect(JSON.parse(await readFile(statePath, "utf8")).agyPid).toBe(agyPid); }, { timeout: 5_000, interval: 20 });
    const { agyPid: _pid, agyCommand: _command, agyStartedAt: _startedAt, ...early } = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify(early));
    return { supervisor, scriptPid, agyPid };
  }

  it("reaps agy when script exits before the state has learned agy's pid, identifying it by ps", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-early-exit-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { supervisor, scriptPid, agyPid } = await launchWithEarlyState(root, infoFile, fakeAgy);
    try {
      process.kill(scriptPid, "SIGKILL");
      await waitUntilDead(agyPid);
      expect(groupKillCalls).toContainEqual({ pid: agyPid, options: { groupOnly: true } });
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("never signals a pid-file pid that runs a different command, even before the state has learned agy", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-early-stranger-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
    const strangerPid = track(stranger.pid, root) as number;
    const { supervisor, scriptPid } = await launchWithEarlyState(root, infoFile, fakeAgy);
    try {
      await writeFile(launchPidPath(root, supervisor), String(strangerPid));
      process.kill(scriptPid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(groupKillCalls.map((call) => call.pid)).not.toContain(strangerPid);
      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("never signals a pid-file pid that runs agy but started after the pid file was written (a recycled pid)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-early-recycled-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { supervisor, scriptPid } = await launchWithEarlyState(root, infoFile, fakeAgy);
    try {
      const pidPath = launchPidPath(root, supervisor);
      const writtenAtMs = (await stat(pidPath)).mtimeMs;
      // Start the look-alike well after the pid file's write, clear of ps's
      // whole-second resolution.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, writtenAtMs + 2_000 - Date.now())));
      const recycled = spawn(fakeAgy, [], { stdio: "ignore", detached: true });
      const recycledPid = track(recycled.pid, root) as number;
      await writeFile(pidPath, String(recycledPid));
      await utimes(pidPath, new Date(writtenAtMs), new Date(writtenAtMs));
      process.kill(scriptPid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(groupKillCalls.map((call) => call.pid)).not.toContain(recycledPid);
      expect(alive(recycledPid)).toBe(true);
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
        state = JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8"));
        expect(state.agyPid).toBe(agyPid);
      }, { timeout: 3_000, interval: 20 });

      expect(state.scriptPid).toBe(scriptPid);
      expect(typeof state.scriptCommand).toBe("string");
      expect(typeof state.agyCommand).toBe("string");
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("records a provisional, unverified state synchronously at spawn -- before recordState()'s first ps call could possibly have answered", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-provisional-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root);
      // Read synchronously, in the very same tick start() returned in --
      // nothing asynchronous (a `ps` call, a timer, a microtask) has had a
      // chance to run yet, so this can only be what launch() itself wrote,
      // synchronously, before spawn() even returned control here.
      const state = JSON.parse(readFileSync(launchStatePath(root, supervisor), "utf8"));
      expect(state.verified).toBe(false);
      expect(state.scriptCommand).toBe("");
      expect(state.scriptStartedAt).toBe("");
      expect(state.scriptPid).toBe(scriptPid);
      expect(typeof state.launchedAt).toBe("string");
      track(Number(await waitForFile(infoFile)), root);
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
        const raw = JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8"));
        expect(raw.agyPid).toBe(agyPid);
      }, { timeout: 3_000, interval: 20 });
      expect(alive(scriptPid as number)).toBe(true);
      expect(alive(agyPid)).toBe(true);

      const result = await sweepPreviousKeepalive(root);

      expect(result.swept.slice().sort((a, b) => a - b)).toEqual([scriptPid, agyPid].sort((a, b) => (a as number) - (b as number)));
      await waitUntilDead(scriptPid as number);
      await waitUntilDead(agyPid);
      await expect(readFile(launchStatePath(root, supervisor), "utf8")).rejects.toThrow(); // state cleared after sweeping
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("does nothing when no state file exists (first ever start, or an already-clean stop)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-empty-"));
    temporary.push(root);
    await expect(sweepPreviousKeepalive(root)).resolves.toEqual({ swept: [], unverified: [] });
  });

  it("sweeps a legacy shared state file only after its recorded pid is confirmed dead", async () => {
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
      await expect(readFile(keepaliveStateFilePath(root), "utf8")).rejects.toThrow();
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

describe.skipIf(process.platform === "win32")("sweepPreviousKeepalive: recovering an agy left behind by a daemon that never finished recording it", () => {
  it("reaps, and confirms dead, an agy left behind by a daemon that died before recordState() ever ran, entirely without ps", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-provisional-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const crashed = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 60_000,
    });
    try {
      await withoutPs(root, async () => {
        crashed.start();
        const scriptPid = track(crashed.pid, root) as number;
        const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
        await waitForFile(launchPidPath(root, crashed));
        // Without `ps`, recordState() can never get past its first ps call --
        // only the synchronous, provisional record survives, exactly as if
        // the daemon process had been killed moments after spawn.
        const provisional = JSON.parse(await readFile(launchStatePath(root, crashed), "utf8"));
        expect(provisional.verified).toBe(false);
        expect(provisional.agyPid).toBeUndefined(); // recordState() never got this far
        expect(alive(agyPid)).toBe(true); // "the daemon" never called stop(): agy is abandoned, alive

        // A brand new daemon's startup sweep, still without ps -- the only
        // thing distinguishing this from the old (broken) behaviour: it must
        // not just shrug and let launch() delete the evidence. For a fresh,
        // internally-consistent fixture like this one, the ps-free tier must
        // actually reap agy outright -- not merely tolerate leaving it
        // unverified, which would let a broken tier still pass this test.
        groupKillCalls.splice(0);
        const result = await sweepPreviousKeepalive(root);

        expect(result.swept).toEqual([agyPid]);
        // The state is ps-free: the original group leader can already have
        // exited while descendants keep its group alive, so the fallback
        // must never also signal a bare pid that could have been recycled.
        expect(groupKillCalls).toContainEqual({ pid: agyPid, options: { groupOnly: true } });
        expect(groupKillCalls.every((call) => call.options?.groupOnly === true)).toBe(true);
        // scriptPid itself is a SEPARATE candidate with no ps-free evidence
        // of its own (only agy's pid file exists) -- it is correctly, not
        // spuriously, `unverified` here; this is not the tier under test.
        expect(result.unverified).toEqual([scriptPid]);
        await waitUntilDead(agyPid);
      });
    } finally { await crashed.stop(); }
  }, 15_000);

  it("never lets repeated crash/restart cycles across daemon starts leave more than one agy alive at once", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-repeated-crash-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const agyPids: number[] = [];
    try {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        // Stands in for the next daemon's startup sweep, before it decides
        // whether to launch its own keepalive.
        await sweepPreviousKeepalive(root);
        if (cycle > 0) await waitUntilDead(agyPids[cycle - 1]); // no accumulation across cycles
        await rm(infoFile, { force: true });
        const supervisor = new AgyKeepaliveSupervisor({
          binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 60_000,
        });
        supervisor.start();
        track(supervisor.pid, root);
        const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
        agyPids.push(agyPid);
        await vi.waitFor(async () => {
          const raw = JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8"));
          expect(raw.agyPid).toBe(agyPid);
        }, { timeout: 3_000, interval: 20 });
        // "Crash": nobody calls supervisor.stop() -- script and agy are
        // abandoned alive, exactly like an unclean daemon exit, for the next
        // cycle's sweep to find.
      }
      // The next daemon start after the last crash.
      await sweepPreviousKeepalive(root);
      await Promise.all(agyPids.map((pid) => waitUntilDead(pid)));
      expect(agyPids.every((pid) => !alive(pid))).toBe(true);
    } finally { for (const pid of agyPids) if (alive(pid)) await killTree(pid, { graceMs: 100 }); }
  }, 30_000);

  it("never signals a stale .agy-pid file naming an unrelated live process", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-stranger-")); temporary.push(root);
    const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
    const strangerPid = track(stranger.pid, root) as number;
    // No JSON state at all -- only a leftover pid file, the one artifact a
    // crash-before-any-record-at-all (or a corrupted/lost state file) could
    // leave, naming a pid the OS has since handed to something else entirely
    // (a live, unrelated process, for a deterministic test).
    await writeFile(`${keepaliveStateFilePath(root)}.agy-pid`, String(strangerPid), { mode: 0o600 });

    const result = await sweepPreviousKeepalive(root);

    expect(result.swept).toEqual([]);
    expect(result.unverified).toEqual([strangerPid]); // alive, but never provably ours: reported, not touched
    expect(alive(strangerPid)).toBe(true);
  }, 10_000);
});

describe.skipIf(process.platform === "win32")("sweepPreviousKeepalive: ps-free identity evidence is bounded in both directions", () => {
  it("never verifies a .agy-pid file whose mtime is long AFTER the recorded launch time (no upper bound regression)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-futuremtime-")); temporary.push(root);
    // A real, live, detached (so its own process-group leader) process
    // stands in for "the pid the .agy-pid file names, still alive" -- the
    // one piece of ps-free evidence isProcessGroupAlive can genuinely see.
    const stray = spawn(await writeMortalShim(join(root, "stray")), [], { stdio: "ignore", detached: true });
    const strayPid = track(stray.pid, root) as number;
    const launchedAt = new Date(Date.now() - 60_000).toISOString(); // a minute ago
    await writeFile(keepaliveStateFilePath(root), JSON.stringify({
      // scriptPid deliberately distinct from strayPid: this test is only
      // about the pid the .agy-pid file itself names (added as its own
      // candidate below), not about a scriptPid/agyPid match.
      scriptPid: strayPid + 100000, scriptCommand: "", scriptStartedAt: "",
      launchedAt, recordedAt: new Date().toISOString(), verified: false,
      launchId: "11111111-1111-4111-8111-111111111111",
    }), { mode: 0o600 });
    const pidFilePath = `${keepaliveStateFilePath(root)}.agy-pid`;
    await writeFile(pidFilePath, String(strayPid), { mode: 0o600 });
    // Backdate the pid file's mtime to well AFTER launchedAt -- as if it were
    // actually written by some later, unrelated event, not the launch
    // `launchedAt` describes. The old (buggy) check only had a lower bound
    // (mtime >= launchedAt - tolerance) and so had no upper bound at all;
    // this is exactly the case it would have wrongly accepted.
    const farAfter = new Date(Date.parse(launchedAt) + 10 * 60_000); // ten minutes after
    await utimes(pidFilePath, farAfter, farAfter);

    const result = await sweepPreviousKeepalive(root);

    expect(result.swept).not.toContain(strayPid);
    expect(result.unverified).toContain(strayPid); // alive, but the mtime doesn't match this launch
    expect(alive(strayPid)).toBe(true);
  }, 10_000);

  it("never verifies old-but-internally-consistent evidence -- a detached stranger that happens to reuse the recorded pid is never signalled", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-staleevidence-")); temporary.push(root);
    // A REAL, live, detached (its own process-group leader) process stands
    // in for a completely unrelated process the OS has since recycled this
    // exact pid to. The recorded evidence is internally self-consistent --
    // the pid file's mtime matches launchedAt exactly -- which is the one
    // thing the mtime-bound check above verifies; an age bound is what has
    // to reject this in spite of that, since that consistency alone never
    // expires and would otherwise still pass it however long ago the
    // original launch happened.
    const stranger = spawn(await writeMortalShim(join(root, "old-stranger")), [], { stdio: "ignore", detached: true });
    const strangerPid = track(stranger.pid, root) as number;
    const oldLaunchedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    await writeFile(keepaliveStateFilePath(root), JSON.stringify({
      scriptPid: strangerPid + 100000, scriptCommand: "", scriptStartedAt: "",
      launchedAt: oldLaunchedAt, recordedAt: oldLaunchedAt, verified: false,
      launchId: "22222222-2222-4222-8222-222222222222",
    }), { mode: 0o600 });
    const pidFilePath = `${keepaliveStateFilePath(root)}.agy-pid`;
    await writeFile(pidFilePath, String(strangerPid), { mode: 0o600 });
    const oldTime = new Date(Date.parse(oldLaunchedAt));
    await utimes(pidFilePath, oldTime, oldTime); // mtime matches launchedAt exactly

    const result = await sweepPreviousKeepalive(root);

    expect(result.swept).not.toContain(strangerPid);
    expect(result.unverified).toContain(strangerPid); // alive, but the evidence is too old to trust
    expect(alive(strangerPid)).toBe(true);
  }, 10_000);

  it("never verifies evidence whose recorded launch time is implausibly in the future", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-futurelaunch-")); temporary.push(root);
    // A REAL, live, detached process stands in for the pid the .agy-pid file
    // names. Its mtime is made to match the (future) launchedAt exactly --
    // internally self-consistent, the one thing the mtime-bound check
    // verifies -- so only an explicit "not implausibly in the future" check
    // can reject it: without one, `now - launchedAtMs` goes negative and is
    // trivially <= the (positive) max-age bound, for ANY future timestamp.
    const stranger = spawn(await writeMortalShim(join(root, "future-stranger")), [], { stdio: "ignore", detached: true });
    const strangerPid = track(stranger.pid, root) as number;
    const futureLaunchedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes from now
    await writeFile(keepaliveStateFilePath(root), JSON.stringify({
      scriptPid: strangerPid + 100000, scriptCommand: "", scriptStartedAt: "",
      launchedAt: futureLaunchedAt, recordedAt: futureLaunchedAt, verified: false,
      launchId: "33333333-3333-4333-8333-333333333333",
    }), { mode: 0o600 });
    const pidFilePath = `${keepaliveStateFilePath(root)}.agy-pid`;
    await writeFile(pidFilePath, String(strangerPid), { mode: 0o600 });
    const futureTime = new Date(Date.parse(futureLaunchedAt));
    await utimes(pidFilePath, futureTime, futureTime); // mtime matches launchedAt exactly

    const result = await sweepPreviousKeepalive(root);

    expect(result.swept).not.toContain(strangerPid);
    expect(result.unverified).toContain(strangerPid); // alive, but the launch time is implausible
    expect(alive(strangerPid)).toBe(true);
  }, 10_000);
});

describe.skipIf(process.platform === "win32")("sweepPreviousKeepalive: a kill that fails or cannot be confirmed is never trusted as reaped", () => {
  it("a signalling failure (kill throwing) does not reject the whole sweep -- the pid is reported unverified, never trusted as swept", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-killthrows-")); temporary.push(root);
    const infoFile = join(root, "pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
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
        scriptPid: pid, scriptCommand: signature.command, scriptStartedAt: signature.startedAt,
        recordedAt: new Date().toISOString(),
      }), { mode: 0o600 });

      const result = await sweepPreviousKeepalive(root, {
        killTree: async () => { throw new Error("EPERM (simulated): not permitted to signal this pid"); },
      });

      expect(result.swept).toEqual([]);
      expect(result.unverified).toEqual([pid]); // never counted as reaped when signalling itself failed
      expect(alive(pid)).toBe(true); // never actually touched
    } finally { if (alive(pid)) await killTree(pid, { graceMs: 100 }); }
  }, 15_000);

  it("keeps the evidence files and reports unverified when a signalled pid cannot be confirmed dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-unconfirmed-")); temporary.push(root);
    const infoFile = join(root, "pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
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
        scriptPid: pid, scriptCommand: signature.command, scriptStartedAt: signature.startedAt,
        recordedAt: new Date().toISOString(),
      }), { mode: 0o600 });

      // A killTree that "succeeds" without touching the process at all --
      // standing in, deterministically, for a real SIGKILL that has been
      // sent but not yet taken effect by the time this returns (SIGKILL is
      // asynchronous: the kernel still has to schedule and reap it).
      const result = await sweepPreviousKeepalive(root, { killTree: async () => { /* no-op: still "exiting" */ } });

      expect(result.swept).toEqual([]);
      expect(result.unverified).toEqual([pid]);
      expect(alive(pid)).toBe(true);
      // The evidence must survive so a LATER sweep can still finish the job
      // -- discarding it here, before confirmation, would be exactly the bug.
      await expect(readFile(keepaliveStateFilePath(root), "utf8")).resolves.toBeTruthy();
    } finally { if (alive(pid)) await killTree(pid, { graceMs: 100 }); }
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor: a superseded launch's write never overwrites a newer one", () => {
  it("recordState() never overwrites a newer launch's record with a stale (superseded-generation) one", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-generation-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100 });
    const internal = supervisor as unknown as {
      launchGeneration: number;
      child: unknown;
      recordState(child: unknown, generation: number, launchId: string): Promise<void>;
    };
    try {
      supervisor.start();
      track(Number(await waitForFile(infoFile)), root);
      track(supervisor.pid, root);
      // Let the real, current launch's own recordState() finish and write
      // its verified record first, so there is a known-good baseline to
      // protect against being clobbered.
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8"));
        expect(state.verified).toBe(true);
      }, { timeout: 3_000, interval: 20 });
      const goodState = await readFile(launchStatePath(root, supervisor), "utf8");

      // Simulate a newer launch having since started (bumping the
      // generation) -- exactly what a crash+restart does -- without an
      // actual restart, so the race window is deterministic rather than
      // timing-dependent.
      const staleGeneration = internal.launchGeneration;
      internal.launchGeneration += 1;

      // Directly invoke recordState() again, standing in for that OLD
      // launch's own (delayed) call finally resolving after a newer launch
      // has already taken over -- exactly the race this generation check
      // exists to close. The launchId passed here is irrelevant: the
      // generation mismatch alone must already refuse the write.
      await internal.recordState(internal.child, staleGeneration, "stale-launch-id");

      // The stale call must never have overwritten anything.
      await expect(readFile(launchStatePath(root, supervisor), "utf8")).resolves.toBe(goodState);
    } finally { await supervisor.stop(); }
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("sweepPreviousKeepalive: evidence that cannot be read is never treated as evidence that nothing is there", () => {
  it("rejects (does not silently report a clean sweep) when the state file exists but is not valid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-corrupt-state-")); temporary.push(root);
    await writeFile(keepaliveStateFilePath(root), "{ this is not json", { mode: 0o600 });

    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
  });

  it("rejects when the state file exists but does not match the recorded shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-wrongshape-")); temporary.push(root);
    await writeFile(keepaliveStateFilePath(root), JSON.stringify({ hello: "world" }), { mode: 0o600 });

    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
  });

  it("rejects when the .agy-pid file exists but does not contain a plain pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-badpidfile-")); temporary.push(root);
    await writeFile(`${keepaliveStateFilePath(root)}.agy-pid`, "not-a-pid\n", { mode: 0o600 });

    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
  });

  it("accepts only the launch wrapper's optional trailing newline in pid evidence, in both readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-pid-newline-")); temporary.push(root);
    const launchId = "11111111-1111-4111-8111-111111111111";
    const pidFilePath = keepaliveLaunchAgyPidFilePath(root, launchId);
    const supervisor = new AgyKeepaliveSupervisor({ home: root });
    const internal = supervisor as unknown as { configureLaunchDirectory(launchId: string): void; readAgyPidDetailed(): { kind: "found"; pid: number } | { kind: "absent" } | { kind: "invalid" } };
    internal.configureLaunchDirectory(launchId);

    // A pid that is certainly not running: a process that has already exited.
    // (A fixed number such as 123 can be a live system process on a CI runner.)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid as number;
    await writeFile(pidFilePath, `${deadPid}\n`, { mode: 0o600 });
    expect(internal.readAgyPidDetailed()).toEqual({ kind: "found", pid: deadPid });
    await expect(sweepPreviousKeepalive(root)).resolves.toEqual({ swept: [], unverified: [] });

    for (const noncanonical of ["2e3", "123.0", "1 23", "+123", "0123", " 123", "123 ", "123\n\n", "123\r\n"]) {
      const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-noncanonicalpid-")); temporary.push(root);
      const launchId = "11111111-1111-4111-8111-111111111111";
      const pidFilePath = keepaliveLaunchAgyPidFilePath(root, launchId);
      const supervisor = new AgyKeepaliveSupervisor({ home: root });
      const internal = supervisor as unknown as { configureLaunchDirectory(launchId: string): void; readAgyPidDetailed(): { kind: "found"; pid: number } | { kind: "absent" } | { kind: "invalid" } };
      internal.configureLaunchDirectory(launchId);
      await writeFile(pidFilePath, noncanonical, { mode: 0o600 });

      expect(internal.readAgyPidDetailed()).toEqual({ kind: "invalid" });
      await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
    }
  });

  it("rejects partial, impossible, or noncanonical current metadata instead of clearing it as legacy evidence", async () => {
    const current: Record<string, unknown> = {
      scriptPid: 12345,
      scriptCommand: "",
      scriptStartedAt: "",
      recordedAt: new Date().toISOString(),
      launchedAt: new Date().toISOString(),
      verified: false,
      launchId: "44444444-4444-4444-8444-444444444444",
    };
    const missingLaunchId = { ...current }; delete missingLaunchId.launchId;
    const missingLaunchedAt = { ...current }; delete missingLaunchedAt.launchedAt;
    const missingVerified = { ...current }; delete missingVerified.verified;
    const malformed = [
      { ...current, recordedAt: "not-a-timestamp" },
      { ...current, launchedAt: "not-a-timestamp" },
      { ...current, recordedAt: "2026-02-31T12:00:00Z" },
      { ...current, launchedAt: "2026-02-31T12:00:00Z" },
      { ...current, launchId: "not-a-uuid" },
      { ...current, unexpected: true },
      { ...current, scriptCommand: "/usr/bin/script" },
      { ...current, agyPid: 12346, agyCommand: "agy", agyStartedAt: "known-start" },
      { ...current, verified: true },
      {
        ...current, verified: true, scriptCommand: "/usr/bin/script", scriptStartedAt: "Mon Jan 1 00:00:00 2000",
        agyPid: 12346, agyCommand: "", agyStartedAt: "",
      },
      missingLaunchId,
      missingLaunchedAt,
      missingVerified,
    ];
    for (const state of malformed) {
      const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-malformed-metadata-")); temporary.push(root);
      const raw = JSON.stringify(state);
      const statePath = keepaliveStateFilePath(root);
      await writeFile(statePath, raw, { mode: 0o600 });

      await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
      await expect(readFile(statePath, "utf8")).resolves.toBe(raw);
    }
  });

  it("rejects when the .agy-pid file is a symlink rather than a plain regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-symlinkpidfile-")); temporary.push(root);
    const elsewhere = join(root, "elsewhere");
    await writeFile(elsewhere, "123", { mode: 0o600 });
    await symlink(elsewhere, `${keepaliveStateFilePath(root)}.agy-pid`);

    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
  });

  it("still returns a clean, empty sweep when nothing is there at all (ENOENT stays absent, not invalid)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-genuinely-empty-")); temporary.push(root);

    await expect(sweepPreviousKeepalive(root)).resolves.toEqual({ swept: [], unverified: [] });
  });

  it("rejects a state file whose agy* tuple is only partially present, rather than silently dropping the pieces that showed up", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-partialtuple-")); temporary.push(root);
    await writeFile(keepaliveStateFilePath(root), JSON.stringify({
      scriptPid: 12345, scriptCommand: "/usr/bin/script", scriptStartedAt: "Mon Jan 1 00:00:00 2000",
      recordedAt: new Date().toISOString(), verified: true,
      agyPid: 12346, // agyCommand and agyStartedAt are missing -- a corrupt, partial write
    }), { mode: 0o600 });

    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
  });

  it("rejects a scriptPid that is not a plain positive integer (NaN, a float, zero, or negative)", async () => {
    for (const badPid of [Number.NaN, 1.5, 0, -5]) {
      const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-badscriptpid-")); temporary.push(root);
      await writeFile(keepaliveStateFilePath(root), JSON.stringify({
        scriptPid: badPid, scriptCommand: "/usr/bin/script", scriptStartedAt: "Mon Jan 1 00:00:00 2000",
        recordedAt: new Date().toISOString(), verified: true,
      }), { mode: 0o600 });

      await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
    }
  });

  it("rejects a pid (in either the state file or the .agy-pid file) that is absurdly out of the plausible pid range", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-outofrangepid-")); temporary.push(root);
    await writeFile(`${keepaliveStateFilePath(root)}.agy-pid`, "99999999999", { mode: 0o600 }); // far beyond any real pid_max

    await expect(sweepPreviousKeepalive(root)).rejects.toBeInstanceOf(InvalidKeepaliveEvidenceError);
  });
});

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor.stop(): never acts on evidence a different launch has since claimed", () => {
  it("two supervisors sharing a home never read or signal each other's launch directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-crossinstance-")); temporary.push(root);
    const infoFileA = join(root, "agy-a.txt");
    const infoFileB = join(root, "agy-b.txt");
    const fakeAgyA = await writeMortalShim(join(root, "agy-a"), { pidFile: infoFileA, ignoreTerm: true });
    const fakeAgyB = await writeMortalShim(join(root, "agy-b"), { pidFile: infoFileB, ignoreTerm: true });
    const supervisorA = new AgyKeepaliveSupervisor({ binary: fakeAgyA, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100 });
    const supervisorB = new AgyKeepaliveSupervisor({ binary: fakeAgyB, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100 });
    try {
      supervisorA.start();
      const scriptPidA = track(supervisorA.pid, root) as number;
      const agyPidA = track(Number(await waitForFile(infoFileA)), root) as number;
      await waitForFile(launchPidPath(root, supervisorA));
      supervisorB.start();
      track(supervisorB.pid, root);
      track(Number(await waitForFile(infoFileB)), root);
      const bPidPath = launchPidPath(root, supervisorB);
      await waitForFile(bPidPath);

      // Corrupt only B's directory with a live stranger. A's stop must have
      // no path through which it can even read this replacement, let alone
      // signal it.
      const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
      const strangerPid = track(stranger.pid, root) as number;
      await writeFile(bPidPath, String(strangerPid), { mode: 0o600 });

      await supervisorA.stop();

      await waitUntilDead(scriptPidA);
      await waitUntilDead(agyPidA);
      expect(alive(strangerPid)).toBe(true);
      await expect(readFile(bPidPath, "utf8")).resolves.toBe(String(strangerPid));
    } finally { await supervisorA.stop(); await supervisorB.stop(); }
  }, 15_000);

  it("treats a missing state file as NOT proof of ownership -- a stranger named only in a surviving .agy-pid file is never signalled", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-missingstate-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({ binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100 });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      await waitForFile(launchPidPath(root, supervisor));

      // Delete the JSON state (the only thing that carries this launch's
      // own launchId) but leave the pid file in place, pointed at an
      // unrelated, real, live process -- exactly what "missing state, but
      // a pid file survives" looks like.
      await rm(launchStatePath(root, supervisor), { force: true });
      const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
      const strangerPid = track(stranger.pid, root) as number;
      await writeFile(launchPidPath(root, supervisor), String(strangerPid), { mode: 0o600 });

      await supervisor.stop();

      // supervisor's own script+agy still die for real, via killTree's ps
      // walk of ITS OWN scriptPid -- unaffected by any of this.
      await waitUntilDead(scriptPid);
      await waitUntilDead(agyPid);
      // The stranger named only by the surviving (now state-less) pid file
      // is never signalled: a missing state file proves nothing, and is
      // never treated as if it proved ownership.
      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor: the unexpected-exit path never restarts on the strength of a missing or malformed pid file", () => {
  it("a pid file missing at exit time is retried (bounded) before a restart is ever allowed, not permitted immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-missingpid-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    const spawnTimes: number[] = [];
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnTimes.push(Date.now());
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 30, pidDiscoveryAttempts: 5, restartDelay: () => 0,
      spawn: spyingSpawn,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      const pidFilePath = launchPidPath(root, supervisor);
      await waitForFile(pidFilePath);
      expect(spawnTimes.length).toBe(1);

      // Remove the pid file right before killing script, so the exit
      // handler finds nothing when it first looks -- "missing at exit
      // time", not corrupted.
      await rm(pidFilePath, { force: true });
      process.kill(scriptPid, "SIGKILL");

      // Must not restart on the very first (missing) read.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(spawnTimes.length).toBe(1);

      // But must eventually restart once the bounded discovery window (5 *
      // 30ms = 150ms) genuinely never finds anything.
      await vi.waitFor(() => { expect(spawnTimes.length).toBe(2); }, { timeout: 3_000, interval: 20 });
      expect(spawnTimes[1] - spawnTimes[0]).toBeGreaterThanOrEqual(140); // waited out the discovery window, not raced past it
      track(supervisor.pid, root);
      track(Number(await waitForFile(infoFile)), root);
      void agyPid; // the original orphan (its pid file vanished before anything could reap it) is left for the reaper to clean up -- this test's own artificial corruption, not a production path
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("a recorded agyPid without a pid file keeps restart blocked until state reconciliation can prove it gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-statepid-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 20, restartDelay: () => 0, spawn: spyingSpawn,
    });
    try {
      await withoutPs(root, async () => {
        supervisor.start();
        const scriptPid = track(supervisor.pid, root) as number;
        const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
        const statePath = launchStatePath(root, supervisor);
        const provisional = JSON.parse(await readFile(statePath, "utf8"));
        // This is the state-only shape a crash can leave after the wrapper
        // pid file disappears. With ps denied it cannot identify the live
        // group, so it must remain pending rather than spawn over it.
        await writeFile(statePath, JSON.stringify({
          ...provisional, verified: true, scriptCommand: "script", scriptStartedAt: "known-start",
          agyPid, agyCommand: "agy", agyStartedAt: "known-start",
        }), { mode: 0o600 });
        await rm(launchPidPath(root, supervisor), { force: true });

        process.kill(scriptPid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(spawnCount).toBe(1);
        expect(alive(agyPid)).toBe(true);
      });
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("rechecks its own directory at timer fire and keeps the restart pending when evidence becomes invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-restart-invalid-delay-")); temporary.push(root);
    const calls: string[] = [];
    const supervisor = new AgyKeepaliveSupervisor({
      binary: "/bin/false", home: root, restartDelay: () => 80,
      spawn: ((command: string) => { calls.push(command); throw new Error("simulated spawn failure"); }) as never,
    });
    try {
      supervisor.start();
      const launchId = supervisor.launchId!;
      await writeFile(keepaliveLaunchStateFilePath(root, launchId), "{ invalid during delay", { mode: 0o600 });

      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(calls).toHaveLength(1);
      await expect(readFile(keepaliveLaunchStateFilePath(root, launchId), "utf8")).resolves.toBe("{ invalid during delay");
    } finally { await supervisor.stop(); }
  });

  it("a malformed pid file at exit time is retried indefinitely and never permits a restart on its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-malformedpid-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 30,
      spawn: spyingSpawn,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      track(Number(await waitForFile(infoFile)), root);
      const pidFilePath = launchPidPath(root, supervisor);
      await waitForFile(pidFilePath);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8")).agyPid).toBeDefined();
      }, { timeout: 3_000, interval: 20 });
      expect(spawnCount).toBe(1);

      // Corrupt the evidence right before killing script -- something DID
      // write to this path, unlike the "missing" case above, and that must
      // never be treated the same as "nothing here, safe to restart".
      await writeFile(pidFilePath, "not-a-pid", { mode: 0o600 });
      process.kill(scriptPid, "SIGKILL");

      // Several retry/backoff cycles' worth of time: must never restart.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnCount).toBe(1);
      // The invalid evidence itself is left exactly as it was -- never
      // silently "resolved" by treating it as absence.
      await expect(readFile(pidFilePath, "utf8")).resolves.toBe("not-a-pid");
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("a .agy-pid file that becomes a symlink at exit time is never followed -- its target's pid is never signalled, and no restart is permitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-symlinkpid-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 30,
      spawn: spyingSpawn,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      track(Number(await waitForFile(infoFile)), root);
      const pidFilePath = launchPidPath(root, supervisor);
      await waitForFile(pidFilePath);
      expect(spawnCount).toBe(1);

      // A real, live, unrelated stranger process stands in for whatever a
      // symlink might get pointed at. Replace the real pid file with a
      // symlink naming it, right before killing script -- if this were
      // ever followed, the stranger would be read as agy's own pid.
      const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
      const strangerPid = track(stranger.pid, root) as number;
      const strangerPidFile = join(root, "stranger-pid.txt");
      await writeFile(strangerPidFile, String(strangerPid), { mode: 0o600 });
      await rm(pidFilePath, { force: true });
      await symlink(strangerPidFile, pidFilePath);
      process.kill(scriptPid, "SIGKILL");

      // Several retry/backoff cycles' worth of time: must never restart,
      // and the stranger must never be touched.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnCount).toBe(1);
      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("a .agy-pid file containing a noncanonical number (scientific notation) at exit time is never accepted as a plain pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-noncanonicalpid-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 30,
      spawn: spyingSpawn,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      track(Number(await waitForFile(infoFile)), root);
      const pidFilePath = launchPidPath(root, supervisor);
      await waitForFile(pidFilePath);
      expect(spawnCount).toBe(1);

      // "2e3" reads as the number 2000 to a loose `Number(...)` parse, but
      // is not what this file's own wrapper (a bare `echo $$`) could ever
      // produce -- treated as invalid, exactly like "not-a-pid" above, not
      // silently reinterpreted as pid 2000.
      await writeFile(pidFilePath, "2e3", { mode: 0o600 });
      process.kill(scriptPid, "SIGKILL");

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnCount).toBe(1);
      await expect(readFile(pidFilePath, "utf8")).resolves.toBe("2e3");
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("never signals or restarts when its own state and pid evidence conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-superseded-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 30,
      spawn: spyingSpawn,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      track(Number(await waitForFile(infoFile)), root);
      const pidFilePath = launchPidPath(root, supervisor);
      await waitForFile(pidFilePath);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8")).agyPid).toBeDefined();
      }, { timeout: 3_000, interval: 20 });
      expect(spawnCount).toBe(1);

      // A replacement in this launch's own pid file conflicts with the agy
      // tuple already recorded in state. It is invalid evidence, never a
      // reason to signal the stranger or start over it.
      const stranger = spawn(await writeMortalShim(join(root, "stranger")), [], { stdio: "ignore", detached: true });
      const strangerPid = track(stranger.pid, root) as number;
      await writeFile(pidFilePath, String(strangerPid), { mode: 0o600 });
      process.kill(scriptPid, "SIGKILL");

      // Several retry/backoff cycles' worth of time: must never restart or
      // touch the stranger.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnCount).toBe(1);
      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);

  it("never signals or restarts when its own JSON state is corrupt, even though the pid file alone looks valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-exit-corruptstate-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const { spawn: realSpawn } = await import("node:child_process");
    let spawnCount = 0;
    const spyingSpawn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      spawnCount += 1;
      return realSpawn(command, args, options);
    }) as never;
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 30,
      spawn: spyingSpawn,
    });
    try {
      supervisor.start();
      const scriptPid = track(supervisor.pid, root) as number;
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      const pidFilePath = launchPidPath(root, supervisor);
      await waitForFile(pidFilePath);
      // recordState() writes the verified record asynchronously (ps-bound).
      // Barrier: corrupt only after that final write has landed, or a slow
      // runner lets it overwrite the corruption with valid state.
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(launchStatePath(root, supervisor), "utf8"))).toMatchObject({ verified: true, agyPid: expect.any(Number) });
      }, { timeout: 5_000, interval: 20 });
      expect(spawnCount).toBe(1);

      // Corrupt the JSON state right before killing script -- the pid file
      // alone, read in isolation, still names a genuine, currently-live,
      // correct pid.
      await writeFile(launchStatePath(root, supervisor), "{ not valid json", { mode: 0o600 });
      process.kill(scriptPid, "SIGKILL");

      // Several retry/backoff cycles' worth of time: must never restart,
      // and the real (still legitimately this launch's own) agy must never
      // be signalled either -- ownership could not be confirmed, so
      // nothing is assumed safe on the strength of the pid file alone.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnCount).toBe(1);
      expect(alive(agyPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 15_000);
});
