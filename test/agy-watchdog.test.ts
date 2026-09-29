import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor, keepaliveLaunchStateFilePath } from "../src/antigravity-keepalive.js";
import { AGY_WATCHDOG_INBOX_SESSION, runAgyWatchdog } from "../src/agy-watchdog.js";
import { externalAntigravityServerPids, isAntigravityServerCommand } from "../src/antigravity-discovery.js";
import { parsePolicy } from "../src/policy.js";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix)); temporary.push(root); return root;
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

/** A real keepalive launch (fake agy under script) whose ps-verified state is on disk. */
async function startLaunch(root: string, infoFile: string): Promise<{ supervisor: AgyKeepaliveSupervisor; agyPid: number; scriptPid: number }> {
  const binary = await writeFakeAgy(root, infoFile);
  const supervisor = new AgyKeepaliveSupervisor({ binary, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 200, restartDelay: () => 30_000 });
  supervisor.start();
  const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
  const scriptPid = track(supervisor.pid, root) as number;
  await vi.waitFor(async () => {
    const state = JSON.parse(await readFile(keepaliveLaunchStateFilePath(root, supervisor.launchId as string), "utf8")) as { verified?: boolean; agyPid?: number };
    expect(state.verified).toBe(true);
    expect(state.agyPid).toBe(agyPid);
  }, { timeout: 5_000, interval: 20 });
  return { supervisor, agyPid, scriptPid };
}

async function inboxTexts(root: string): Promise<string[]> {
  const directory = join(root, "inbox", AGY_WATCHDOG_INBOX_SESSION);
  const files = await readdir(directory).catch(() => [] as string[]);
  return Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
}

describe.skipIf(process.platform === "win32")("agy age watchdog", () => {
  it("kills an over-age Headroom-started fake agy by group and reports pid, age and binary path to the log and inbox", async () => {
    const root = await fixture("headroom-wd-kill-");
    const { supervisor, agyPid, scriptPid } = await startLaunch(root, join(root, "agy-pid.txt"));
    const logged: string[] = [];
    try {
      // Not exempt: this launch stands in for one a previous daemon left behind.
      const killed = await runAgyWatchdog({ home: root, maxAgeMs: 0, log: async (message) => { logged.push(message); } });
      expect(killed.map((item) => item.pid)).toContain(agyPid);
      await waitUntilDead(agyPid);
      await waitUntilDead(scriptPid);
      expect(logged.join("\n")).toContain(`pid ${agyPid}`);
      const inbox = (await inboxTexts(root)).join("\n");
      expect(inbox).toContain(`pid ${agyPid}`);
      expect(inbox).toMatch(/age \d+m\d+s, \/\S+\)/); // age, then the ps command name only, no arguments
    } finally { await supervisor.stop(); }
  }, 20_000);

  it("leaves a same-named agy that Headroom did not start", async () => {
    const root = await fixture("headroom-wd-stranger-");
    const strangerRoot = await fixture("headroom-wd-stranger-own-");
    const { supervisor, agyPid } = await startLaunch(root, join(root, "agy-pid.txt"));
    const strangerInfo = join(strangerRoot, "agy-pid.txt");
    const strangerBinary = await writeFakeAgy(strangerRoot, strangerInfo);
    const stranger = spawn(strangerBinary, [], { stdio: "ignore", detached: true });
    track(stranger.pid, strangerRoot);
    try {
      const strangerPid = track(Number(await waitForFile(strangerInfo)), strangerRoot) as number;
      const killed = await runAgyWatchdog({ home: root, maxAgeMs: 0, log: async () => undefined });
      expect(killed.map((item) => item.pid)).toContain(agyPid);
      expect(killed.map((item) => item.pid)).not.toContain(strangerPid);
      await waitUntilDead(agyPid);
      expect(alive(strangerPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 20_000);

  it("exempts the daemon-owned keepalive by its launch identity", async () => {
    const root = await fixture("headroom-wd-exempt-");
    const { supervisor, agyPid, scriptPid } = await startLaunch(root, join(root, "agy-pid.txt"));
    try {
      const killed = await runAgyWatchdog({ home: root, maxAgeMs: 0, exemptLaunchId: supervisor.launchId, log: async () => undefined });
      expect(killed).toEqual([]);
      expect(alive(agyPid)).toBe(true);
      expect(alive(scriptPid)).toBe(true);
      expect(await inboxTexts(root)).toEqual([]);
    } finally { await supervisor.stop(); }
  }, 20_000);

  it("leaves a launch younger than the limit alone", async () => {
    const root = await fixture("headroom-wd-young-");
    const { supervisor, agyPid } = await startLaunch(root, join(root, "agy-pid.txt"));
    try {
      const killed = await runAgyWatchdog({ home: root, maxAgeMs: 10 * 60_000, log: async () => undefined });
      expect(killed).toEqual([]);
      expect(alive(agyPid)).toBe(true);
    } finally { await supervisor.stop(); }
  }, 20_000);
});

describe("agy_max_age_minutes policy key", () => {
  it("defaults to 10, parses, and rejects nonsense", () => {
    expect(parsePolicy("").agy_max_age_minutes).toBe(10);
    expect(parsePolicy("agy_max_age_minutes = 25\n").agy_max_age_minutes).toBe(25);
    expect(() => parsePolicy("agy_max_age_minutes = 0\n")).toThrow(/Invalid Headroom policy/);
    expect(() => parsePolicy('agy_max_age_minutes = "soon"\n')).toThrow(/Invalid Headroom policy/);
  });
});

describe("Antigravity server discovery", () => {
  it("recognises the IDE language server and the agy CLI, not unrelated processes", () => {
    expect(isAntigravityServerCommand("/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token abc")).toBe(true);
    expect(isAntigravityServerCommand("/Users/you/.local/bin/agy")).toBe(true);
    expect(isAntigravityServerCommand("/usr/bin/vim notes.txt")).toBe(false);
    expect(isAntigravityServerCommand("/usr/bin/language_server_other --flag")).toBe(false);
  });

  it("ignores Headroom's own tree but reports someone else's server", async () => {
    const list = async () => [
      { pid: 10, ppid: 1, command: "/usr/bin/script -q /dev/null /bin/sh -c x agy" },
      { pid: 11, ppid: 10, command: "/home/you/bin/agy" },
      { pid: 20, ppid: 1, command: "/Applications/Antigravity.app/Contents/x/language_server_macos --csrf_token t" },
    ];
    expect(await externalAntigravityServerPids({ list, ownedRoots: [10] })).toEqual([20]);
    expect(await externalAntigravityServerPids({ list, ownedRoots: [10, 20] })).toEqual([]);
  });
});
