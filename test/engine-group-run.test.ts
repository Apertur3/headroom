import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killEngineGroupsNow, liveEngineGroupCount, runInGroup, terminateEngineGroups } from "../src/engine/group-run.js";
import { runNativeEngine } from "../src/engine/native/run.js";
import { isProcessGroupAlive } from "../src/process-tree.js";
import type { ProviderAccount } from "../src/types.js";
import { processesMentioning, writeCountingEngine, writeGrandchildEngine } from "./helpers/fake-engine.js";
import { track, useProcessReaper } from "./helpers/mortal-process.js";

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix)); temporary.push(root); return root;
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try { const text = (await readFile(path, "utf8")).trim(); if (text) return text; } catch { /* not yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Track both pids for the reaper, then wait for the recorded grandchild. */
async function trackTree(root: string, enginePidFile: string, grandchildPidFile: string): Promise<{ enginePid: number; grandchildPid: number }> {
  const grandchildPid = track(Number(await waitForFile(grandchildPidFile, 7_000)), root) as number;
  const enginePid = track(Number(await waitForFile(enginePidFile)), root) as number;
  return { enginePid, grandchildPid };
}

function expectNoSurvivors(root: string, enginePid: number): void {
  expect(isProcessGroupAlive(enginePid)).toBe(false);
  expect(processesMentioning(root)).toEqual([]);
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
      expectNoSurvivors(root, enginePid);
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
      expectNoSurvivors(root, enginePid);
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
      expectNoSurvivors(root, enginePid);
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
      expect(processesMentioning(root)).toEqual([]);
      expect(isProcessGroupAlive(engineFilePid)).toBe(false);
    } finally { if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } } }
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
