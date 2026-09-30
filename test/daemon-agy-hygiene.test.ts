import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import type { PollOptions } from "../src/collector.js";
import { liveEngineGroupCount } from "../src/engine/group-run.js";
import { runNativeEngine } from "../src/engine/native/run.js";
import { isProcessGroupAlive } from "../src/process-tree.js";
import type { ProviderAccount } from "../src/types.js";
import { processesMentioning, writeCountingEngine, writeGrandchildEngine } from "./helpers/fake-engine.js";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

// The suite-wide setup mocks discovery to "nothing running"; this file needs
// to decide, per step, whether someone else's Antigravity server is reachable.
const external = vi.hoisted(() => ({ pids: [] as number[] }));
vi.mock("../src/antigravity-discovery.js", async (original) => ({
  ...await original<typeof import("../src/antigravity-discovery.js")>(),
  externalAntigravityServerPids: async () => external.pids,
}));

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => {
  external.pids = [];
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try { const text = (await readFile(path, "utf8")).trim(); if (text) return text; } catch { /* not yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitUntilDead(pid: number, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const accountsToml = (agyPath: string): string => [
  "[[accounts]]", 'name = "antigravity"', "enabled = true",
  'vendor = "antigravity"', 'location = "agy"', 'adapter = "native-ts"', `agy_path = "${agyPath}"`, "",
].join("\n");

type Internal = { keepalive: { running: boolean } | undefined; poll(principal: string | undefined, forced: boolean): Promise<unknown>; maybeStartKeepalive(accounts: unknown[], policy: unknown): Promise<void> };
// poll() is rate-limited per principal; the keepalive attempt it triggers is what these steps exercise.
const attempt = (daemon: HeadroomDaemon): Promise<void> => (daemon as unknown as Internal).maybeStartKeepalive([], {});

/** Starts a daemon, or reports false where the sandbox forbids AF_UNIX listen(2). */
async function startDaemon(daemon: HeadroomDaemon): Promise<boolean> {
  try { await daemon.start(); return true; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); return false; }
    throw error;
  }
}

describe.skipIf(process.platform === "win32")("daemon agy process hygiene", () => {
  it("does not start the keepalive while a server is reachable, starts it once none is, and stops it when one appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-external-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(fakeAgy), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    external.pids = [4_000_000]; // somebody else's IDE language server
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "headroom"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      if (!await startDaemon(daemon)) return;
      const internal = daemon as unknown as Internal;
      // attempt() settles only once the whole start decision has been made.
      await attempt(daemon);
      expect(internal.keepalive?.running).not.toBe(true);
      await expect(readFile(infoFile, "utf8")).rejects.toThrow();

      external.pids = [];
      await attempt(daemon);
      const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
      expect(internal.keepalive?.running).toBe(true);

      external.pids = [4_000_000];
      await attempt(daemon);
      await waitUntilDead(agyPid);
      expect(internal.keepalive).toBeUndefined();
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 30_000);

  it("a reachable external server (the IDE) is still read: only our own keepalive is suppressed", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-ide-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    await writeFile(join(root, "accounts.toml"), accountsToml(fakeAgy), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    external.pids = [4_000_000]; // somebody else's IDE language server
    const seen: PollOptions[] = [];
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "headroom"), poller: async (_principal, options) => { seen.push(options ?? {}); return { observations: [], failures: [] }; } });
    try {
      if (!await startDaemon(daemon)) return;
      const internal = daemon as unknown as Internal;
      await attempt(daemon);
      expect(internal.keepalive?.running).not.toBe(true);
      await expect(readFile(infoFile, "utf8")).rejects.toThrow();
      await internal.poll(undefined, true);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
      // The collector probes a local server only when this is set.
      expect(seen.every((options) => options.daemonOwnsAntigravity === true)).toBe(true);
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 30_000);

  it("stop() refuses a read queued behind the running one: no engine starts after the shutdown sweep", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-engine-race-")); temporary.push(root);
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    const queuedLog = join(root, "queued.log");
    const queuedEngine = await writeCountingEngine(root, queuedLog, 1);
    const account = (name: string): ProviderAccount => ({ name, vendor: "antigravity", location: "agy", adapter: "native" } as ProviderAccount);
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemon.create({ home: root, path: testSocketPath(root, "headroom"), poller: async () => ({ observations: [], failures: [] }) });
    let stopped = false; let enginePid: number | undefined;
    let running: Promise<string> = Promise.resolve(""); let queued: Promise<string> = Promise.resolve("");
    try {
      if (!await startDaemon(daemon)) return;
      running = runNativeEngine(engine, [account("one")], { timeoutMs: 25_000 }).then(() => "resolved", (error: Error) => error.message);
      track(Number(await waitForFile(grandchildPidFile)), root);
      enginePid = track(Number(await waitForFile(enginePidFile)), root) as number;
      // A read for other accounts waits its turn behind the running one.
      queued = runNativeEngine(queuedEngine, [account("two")], { timeoutMs: 25_000 }).then(() => "resolved", (error: Error) => error.message);
      stopped = true; await daemon.stop();
      expect(liveEngineGroupCount()).toBe(0);
      expect(await queued).toMatch(/shutting down/);
      await running;
      expect(await readFile(queuedLog, "utf8").catch(() => "")).toBe("");
      await vi.waitFor(() => expect(processesMentioning(root)).toEqual([]), { timeout: 5_000, interval: 20 });
      expect(isProcessGroupAlive(enginePid)).toBe(false);
    } finally {
      if (!stopped) await daemon.stop();
      await Promise.all([running, queued]);
      if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } }
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 30_000);

  it("stopping the daemon mid-read kills the engine's whole group: no engine or grandchild survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-engine-stop-")); temporary.push(root);
    const { engine, enginePidFile, grandchildPidFile } = await writeGrandchildEngine(root);
    const account = { name: "antigravity", vendor: "antigravity", location: "agy", adapter: "native" } as ProviderAccount;
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    let read: Promise<unknown> = Promise.resolve(); let stopped = false;
    const daemon = await HeadroomDaemon.create({
      home: root,
      path: testSocketPath(root, "headroom"),
      poller: async () => {
        read = runNativeEngine(engine, [account], { timeoutMs: 25_000 }).catch(() => undefined);
        await read;
        return { observations: [], failures: [] };
      },
    });
    let enginePid: number | undefined;
    try {
      if (!await startDaemon(daemon)) return;
      await writeFile(join(root, "accounts.toml"), accountsToml(engine), { mode: 0o600 });
      const polling = (daemon as unknown as Internal).poll(undefined, true).catch(() => undefined);
      track(Number(await waitForFile(grandchildPidFile)), root);
      enginePid = track(Number(await waitForFile(enginePidFile)), root) as number;
      stopped = true; await daemon.stop();
      await Promise.all([read, polling]);
      expect(isProcessGroupAlive(enginePid)).toBe(false);
      expect(processesMentioning(root)).toEqual([]);
    } finally {
      if (!stopped) await daemon.stop();
      if (enginePid) { try { process.kill(-enginePid, "SIGKILL"); } catch { /* gone */ } }
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 30_000);
});
