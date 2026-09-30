import { execFileSync, spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as nodeModule from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as groupRun from "../src/engine/group-run.js";
import { runNativeEngine } from "../src/engine/native/run.js";
import { isProcessGroupAlive } from "../src/process-tree.js";
import type { ProviderAccount } from "../src/types.js";
import { processesMentioning, writeCountingEngine, writeGrandchildEngine } from "./helpers/fake-engine.js";
import { track, useProcessReaper, writeMortalShim } from "./helpers/mortal-process.js";

const { killEngineGroupsNow, liveEngineGroupCount, liveEngineGroupPids, runInGroup, terminateEngineGroups } = groupRun;
/** Test seam added with the pid-reuse fix; absent before it. */
const setSeams = (groupRun as unknown as { setGroupRunSeamsForTest?: (seams?: Record<string, unknown>) => void }).setGroupRunSeamsForTest;

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => {
  setSeams?.(undefined);
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix)); temporary.push(root); return root;
}

/** Polls `probe` until it returns a value (not undefined), bounded. Every wait
 * in this file is for an event -- a marker file, a process exit -- never a
 * fixed sleep that hopes the event happened. */
async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function waitForFile(path: string): Promise<string> {
  return waitFor(`marker ${path}`, async () => {
    try { const text = (await readFile(path, "utf8")).trim(); return text || undefined; } catch { return undefined; }
  });
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Track both pids for the reaper once their marker files exist. */
async function trackTree(root: string, enginePidFile: string, grandchildPidFile: string): Promise<{ enginePid: number; grandchildPid: number }> {
  const grandchildPid = track(Number(await waitForFile(grandchildPidFile)), root) as number;
  const enginePid = track(Number(await waitForFile(enginePidFile)), root) as number;
  return { enginePid, grandchildPid };
}

/** Waits (bounded) until the group and every process carrying the fixture
 * marker have exited: a SIGKILLed process can take a moment to leave `ps`. */
async function expectNoSurvivors(root: string, enginePid: number): Promise<void> {
  await waitFor("the engine group to exit", () => (isProcessGroupAlive(enginePid) ? undefined : true));
  await waitFor(`no process mentioning ${root}`, () => (processesMentioning(root).length ? undefined : true));
}

const account = (name: string): ProviderAccount => ({ name, vendor: "antigravity", location: "agy", adapter: "native" } as ProviderAccount);

describe.skipIf(process.platform === "win32")("engine reads run in their own process group", () => {
  it("a timeout kills the whole group: the engine, and a TERM-ignoring grandchild it spawned", async () => {
    const root = await fixture("headroom-engine-timeout-");
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    let enginePid: number | undefined;
    try {
      const read = runInGroup(engine, [], { timeoutMs: 8_000, maxBuffer: 1024, graceMs: 300 });
      const settled = read.then(() => "resolved", (error: Error) => error.message);
      ({ enginePid } = await trackTree(root, enginePidFile, grandchildPidFile));
      expect(liveEngineGroupCount()).toBe(1);
      expect(await settled).toMatch(/timed out/);
      expect(liveEngineGroupCount()).toBe(0);
      await expectNoSurvivors(root, enginePid);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
  }, 30_000);

  it("stopping the daemon (terminateEngineGroups) mid-read leaves nothing behind", async () => {
    const root = await fixture("headroom-engine-stop-");
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    let enginePid: number | undefined;
    try {
      const read = runInGroup(engine, [], { timeoutMs: 20_000, maxBuffer: 1024, graceMs: 300 });
      const settled = read.then(() => "resolved", () => "rejected");
      ({ enginePid } = await trackTree(root, enginePidFile, grandchildPidFile));
      await terminateEngineGroups(300);
      await settled;
      expect(liveEngineGroupCount()).toBe(0);
      await expectNoSurvivors(root, enginePid);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
  }, 30_000);

  it("the synchronous process-exit reaper kills a live group", async () => {
    const root = await fixture("headroom-engine-exit-");
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    let enginePid: number | undefined;
    try {
      const read = runInGroup(engine, [], { timeoutMs: 20_000, maxBuffer: 1024, graceMs: 300 });
      const settled = read.then(() => "resolved", () => "rejected");
      ({ enginePid } = await trackTree(root, enginePidFile, grandchildPidFile));
      killEngineGroupsNow();
      await settled;
      await expectNoSurvivors(root, enginePid);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
  }, 30_000);

  it("a read that succeeds still reaps a grandchild left in the group", async () => {
    const root = await fixture("headroom-engine-orphan-");
    // The parent script backgrounds the TERM-ignoring shim, then exits 0 at once.
    const { engine: parentWithGrandchild, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    let enginePid: number | undefined;
    try {
      const read = runInGroup("/bin/sh", ["-c", `'${parentWithGrandchild}' >/dev/null 2>&1 & while [ ! -s '${grandchildPidFile}' ]; do sleep 0.05; done; echo '[]'`], { timeoutMs: 15_000, maxBuffer: 1024, graceMs: 300 });
      const result = await read.catch((error: Error) => error);
      expect(result).toMatchObject({ stdout: "[]\n" });
      const engineFilePid = track(Number(await waitForFile(enginePidFile)), root) as number;
      track(Number(await waitForFile(grandchildPidFile)), root);
      enginePid = engineFilePid;
      // The group leader here is the outer sh, not the recorded engine pid: the
      // whole tree must be gone by marker, and the recorded pids dead.
      await expectNoSurvivors(root, engineFilePid);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("engine groups are only ever signalled while provably Headroom's", () => {
  it("after the leader is reaped, a recycled pid is never signalled, bare or as a group", async () => {
    const root = await fixture("headroom-engine-reuse-");
    const holderPidFile = join(root, "holder.pid");
    // Holds the engine's stdout open, so the read cannot settle on 'close'
    // while the leader is already gone.
    // Ignores TERM, so the post-exit sweep is still waiting to escalate to
    // SIGKILL when the pid changes hands below.
    const holder = await writeMortalShim(join(root, "holder"), { pidFile: holderPidFile, ignoreTerm: true, lifetimeSeconds: 20 });
    // The leader exits as soon as the holder has recorded its pid.
    const read = runInGroup("/bin/sh", ["-c", `'${holder}' & while [ ! -s '${holderPidFile}' ]; do sleep 0.05; done; exit 0`], { timeoutMs: 15_000, maxBuffer: 1024, graceMs: 300 });
    const leader = liveEngineGroupPids()[0];
    expect(typeof leader).toBe("number");
    const settled = read.then(() => "resolved", (error: Error) => error.message);
    try {
      // The reaper (useProcessReaper) kills the holder by verified command line.
      track(Number(await waitForFile(holderPidFile)), root);
      // Event: the leader has exited and been reaped (its pid is free).
      await waitFor("the engine leader to be reaped", () => (pidExists(leader) ? undefined : true));
      // From here the kernel may hand `leader` to a stranger: simulate exactly
      // that. A process now holds the pid; nothing may be sent to it or to a
      // group of that id. Signal 0 probes to the group are answered for real.
      const signalled: Array<[number, string | number | undefined]> = [];
      const realKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
        if (target === leader) { if (signal === 0 || signal === undefined) return true; signalled.push([target, signal]); return true; }
        if (target === -leader && signal !== 0) { signalled.push([target, signal]); return true; }
        return realKill(target, signal as NodeJS.Signals);
      }) as typeof process.kill);
      killEngineGroupsNow();
      await terminateEngineGroups(300);
      await settled;
      expect(signalled).toEqual([]);
      vi.restoreAllMocks();
      expect(liveEngineGroupCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await settled;
    }
  }, 30_000);

  it("a live leader whose start time no longer matches is never signalled", async () => {
    const root = await fixture("headroom-engine-identity-");
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    let enginePid: number | undefined;
    try {
      const read = runInGroup(engine, [], { timeoutMs: 20_000, maxBuffer: 1024, graceMs: 300 });
      const settled = read.then(() => "resolved", () => "rejected");
      ({ enginePid } = await trackTree(root, enginePidFile, grandchildPidFile));
      const leader = liveEngineGroupPids()[0];
      // The process table now reports another process (different start time)
      // under the leader's pid.
      setSeams?.({ lookup: async () => ({ command: "/usr/bin/stranger", startedAt: "Thu Jan  1 00:00:00 1970" }), lookupSync: () => ({ command: "/usr/bin/stranger", startedAt: "Thu Jan  1 00:00:00 1970" }) });
      const signalled: Array<[number, string | number | undefined]> = [];
      const realKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
        if (Math.abs(target) === leader && signal !== 0) signalled.push([target, signal]);
        return realKill(target, signal as NodeJS.Signals);
      }) as typeof process.kill);
      await terminateEngineGroups(300);
      killEngineGroupsNow();
      expect(signalled).toEqual([]);
      expect(isProcessGroupAlive(leader)).toBe(true);
      // Identity restored: the real table again. Now it is reaped normally.
      vi.restoreAllMocks();
      setSeams?.(undefined);
      await terminateEngineGroups(300);
      await settled;
      await expectNoSurvivors(root, enginePid);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
  }, 30_000);

  it("a group that is already gone (ESRCH) is never retried as a bare pid", async () => {
    const root = await fixture("headroom-engine-esrch-");
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    let enginePid: number | undefined;
    try {
      const read = runInGroup(engine, [], { timeoutMs: 20_000, maxBuffer: 1024, graceMs: 300 });
      const settled = read.then(() => "resolved", () => "rejected");
      ({ enginePid } = await trackTree(root, enginePidFile, grandchildPidFile));
      const leader = liveEngineGroupPids()[0];
      const bare: Array<string | number | undefined> = [];
      const realKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
        if (target === -leader && signal !== 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        if (target === leader && signal !== 0) { bare.push(signal); return true; }
        return realKill(target, signal as NodeJS.Signals);
      }) as typeof process.kill);
      killEngineGroupsNow();
      expect(bare).toEqual([]);
      vi.restoreAllMocks();
      await terminateEngineGroups(300);
      await settled;
      await expectNoSurvivors(root, enginePid);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
  }, 30_000);
});

const canRunTypeScriptChild = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === "function"
  && Boolean((process.features as { typescript?: unknown }).typescript);

describe.skipIf(process.platform === "win32" || !canRunTypeScriptChild)("Ctrl-C on a direct (non-daemon) read", () => {
  it("SIGINT kills the engine group, then the process still dies by SIGINT", async () => {
    const root = await fixture("headroom-engine-sigint-");
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    const script = join(root, "direct-read.mjs");
    // Resolves the sources' `./x.js` specifiers to the `.ts` files beside them.
    await writeFile(script, [
      'import { registerHooks } from "node:module";',
      "registerHooks({ resolve(specifier, context, next) {",
      "  try { return next(specifier, context); }",
      '  catch (error) { if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context); throw error; }',
      "} });",
      'import { writeSync } from "node:fs";',
      "const { runInGroup, setGroupRunSeamsForTest } = await import(process.argv[2]);",
      "const tree = await import(process.argv[4]);",
      // Diagnostics only: the real lookups and signals, each written to stderr
      // synchronously (a signal handler re-raises before an async write lands).
      "const note = (...parts) => writeSync(2, parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' ') + '\\n');",
      "setGroupRunSeamsForTest({",
      "  lookup: async (pid) => { const value = await tree.processSignature(pid); note('lookup', pid, value ?? null); return value; },",
      "  lookupSync: (pid) => { const value = tree.processSignatureSync(pid); note('lookupSync', pid, value ?? null, 'ownGroup', tree.ownProcessGroup() ?? null); return value; },",
      "  signal: (target, signal) => { try { process.kill(target, signal); if (signal) note('signal', target, signal, 'sent'); } catch (error) { if (signal) note('signal', target, signal, error.code); throw error; } },",
      "});",
      "runInGroup(process.argv[3], [], { timeoutMs: 25000, maxBuffer: 1024 }).catch(() => undefined);",
      "note('spawned', 'SIGINT listeners', process.listenerCount('SIGINT'));",
    ].join("\n") + "\n");
    const groupRunUrl = pathToFileURL(resolve(import.meta.dirname, "../src/engine/group-run.ts")).href;
    const processTreeUrl = pathToFileURL(resolve(import.meta.dirname, "../src/process-tree.ts")).href;
    const child = spawn(process.execPath, ["--no-warnings", script, groupRunUrl, engine, processTreeUrl], { stdio: ["ignore", "ignore", "pipe"] });
    track(child.pid, root);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const exited = new Promise<NodeJS.Signals | number | null>((done) => child.once("exit", (code, signal) => done(signal ?? code)));
    let enginePid: number | undefined;
    try {
      ({ enginePid } = await trackTree(root, enginePidFile, grandchildPidFile));
      child.kill("SIGINT");
      const outcome = await Promise.race([exited, new Promise((done) => setTimeout(() => done("still running"), 10_000))]);
      expect(outcome, stderr).toBe("SIGINT");
      try { await expectNoSurvivors(root, enginePid); }
      catch (error) {
        const table = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        const group = table.split("\n").filter((line) => line.includes(root) || new RegExp(`^\\s*\\d+\\s+\\d+\\s+${enginePid}\\s`).test(line)).join("\n");
        throw new Error(`${(error as Error).message}\nchild stderr:\n${stderr}\nstill running:\n${group}`);
      }
    } finally {
      child.kill("SIGKILL");
      if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } }
    }
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("native engine reads are globally single-flight", () => {
  it("two concurrent reads for the same accounts share one engine run", async () => {
    const root = await fixture("headroom-engine-single-");
    const log = join(root, "runs.log");
    const engine = await writeCountingEngine(root, log, 1);
    const [first, second] = await Promise.all([
      runNativeEngine(engine, [account("antigravity")], { timeoutMs: 15_000 }),
      runNativeEngine(engine, [account("antigravity")], { timeoutMs: 15_000 }),
    ]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["start", "end"]);
    expect(processesMentioning(root)).toEqual([]);
  }, 30_000);

  it("reads for different accounts never overlap: the second waits for the first", async () => {
    const root = await fixture("headroom-engine-serial-");
    const log = join(root, "runs.log");
    const engine = await writeCountingEngine(root, log, 1);
    await Promise.all([
      runNativeEngine(engine, [account("one")], { timeoutMs: 15_000 }),
      runNativeEngine(engine, [account("two")], { timeoutMs: 15_000 }),
    ]);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["start", "end", "start", "end"]);
    expect(processesMentioning(root)).toEqual([]);
  }, 30_000);

  it("a waiter gives up when the read ahead of it outlasts its own timeout", async () => {
    const root = await fixture("headroom-engine-wait-");
    const log = join(root, "runs.log");
    const engine = await writeCountingEngine(root, log, 2);
    const running = runNativeEngine(engine, [account("one")], { timeoutMs: 15_000 });
    await expect(runNativeEngine(engine, [account("two")], { timeoutMs: 300 })).rejects.toThrow(/busy/);
    await running;
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["start", "end"]);
  }, 30_000);
});
