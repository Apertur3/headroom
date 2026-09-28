import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
      const state = JSON.parse(readFileSync(keepaliveStateFilePath(root), "utf8"));
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
    await expect(sweepPreviousKeepalive(root)).resolves.toEqual({ swept: [], unverified: [] });
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

describe.skipIf(process.platform === "win32")("sweepPreviousKeepalive: finding 2 -- unrecoverable orphans when ps is denied or state was never fully recorded", () => {
  it("(a) reaps an agy left behind by a daemon that died before recordState() ever ran, entirely without ps", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-sweep-provisional-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const crashed = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, restartDelay: () => 60_000,
    });
    try {
      await withoutPs(root, async () => {
        crashed.start();
        track(crashed.pid, root);
        const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
        await waitForFile(`${keepaliveStateFilePath(root)}.agy-pid`);
        // Without `ps`, recordState() can never get past its first ps call --
        // only the synchronous, provisional record survives, exactly as if
        // the daemon process had been killed moments after spawn.
        const provisional = JSON.parse(await readFile(keepaliveStateFilePath(root), "utf8"));
        expect(provisional.verified).toBe(false);
        expect(provisional.agyPid).toBeUndefined(); // recordState() never got this far
        expect(alive(agyPid)).toBe(true); // "the daemon" never called stop(): agy is abandoned, alive

        // A brand new daemon's startup sweep, still without ps -- the only
        // thing distinguishing this from the old (broken) behaviour: it must
        // not just shrug and let launch() delete the evidence.
        const result = await sweepPreviousKeepalive(root);

        // Either outcome closes the leak: ps-free evidence (process group
        // still alive + pid-file mtime matching the recorded launch time) was
        // strong enough here to reap it outright ...
        if (result.swept.includes(agyPid)) {
          await waitUntilDead(agyPid);
        } else {
          // ... or, at minimum, it was never silently discarded: it must be
          // reported so a fresh keepalive refuses to launch on top of it.
          expect(result.unverified).toContain(agyPid);
          expect(alive(agyPid)).toBe(true);
        }
      });
    } finally { await crashed.stop(); }
  }, 15_000);

  it("(b) repeated crash/restart cycles across daemon starts never leave more than one agy alive at once", async () => {
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
          const raw = JSON.parse(await readFile(keepaliveStateFilePath(root), "utf8"));
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

  it("(c) a stale .agy-pid file naming an unrelated live process is never signalled", async () => {
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
