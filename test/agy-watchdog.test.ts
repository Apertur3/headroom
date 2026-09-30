import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor, keepaliveLaunchStateFilePath } from "../src/antigravity-keepalive.js";
import { AGY_WATCHDOG_INBOX_SESSION, runAgyWatchdog } from "../src/agy-watchdog.js";
import * as discovery from "../src/antigravity-discovery.js";
import { parsePolicy } from "../src/policy.js";
import type { ExecFile } from "../src/process-tree.js";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

const { externalAntigravityServerPids, isAntigravityServerCommand } = discovery;
/** Added with the executable-only matching fix; read lazily so its absence
 * fails only the test that needs it. */
const parseProcessListing = (comm: string, args: string) => (discovery as unknown as { parseProcessListing: typeof discovery.parseProcessListing }).parseProcessListing(comm, args);

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
      // Age, then the recorded command only, one token, no arguments: a path
      // on macOS (/bin/sh for this script), the process name (agy) on Linux.
      expect(inbox).toMatch(process.platform === "darwin" ? /age \d+m\d+s, \/[^\s,()]+\)/ : /age \d+m\d+s, agy\)/);
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

type FakeRow = { command: string; startedAt: () => string; ppid?: number; pgid?: number; etime?: string };

/** A fake `ps` that knows only the fabricated pids in `table`. `startedAt` is
 * read at call time, so a test can recycle a pid between two queries. */
function fakePs(table: Map<number, FakeRow>, onEtime?: () => void): ExecFile {
  return (async (_file: string, args: readonly string[]) => {
    if (args[0] === "-Ao" || args[0] === "-wwAo") return { stdout: "", stderr: "" };
    const pid = Number(args[args.indexOf("-p") + 1]);
    const row = table.get(pid);
    if (!row) throw Object.assign(new Error("no such process"), { code: 1 });
    const fields = String(args[args.indexOf("-o") + 1]).split(",").map((field) => field.replace(/=$/, ""));
    const value = (field: string): string => {
      if (field === "comm") return row.command;
      if (field === "lstart") return row.startedAt();
      if (field === "etime") { onEtime?.(); return row.etime ?? "01:00:00"; }
      if (field === "ppid") return String(row.ppid ?? 1);
      if (field === "pgid") return String(row.pgid ?? pid);
      throw new Error(`unexpected ps field ${field}`);
    };
    return { stdout: `${fields.map(value).join(" ")}\n`, stderr: "" };
  }) as unknown as ExecFile;
}

describe.skipIf(process.platform === "win32")("agy watchdog: pid reuse", () => {
  it("never signals a recorded pid that was recycled after it was verified", async () => {
    const root = await fixture("headroom-wd-reuse-");
    const launchId = "0b5c1d6e-2f3a-4b7c-8d9e-0a1b2c3d4e5f";
    const agyPid = 4_000_001; const scriptPid = 4_000_002;
    await mkdir(join(root, "keepalive", launchId), { recursive: true, mode: 0o700 });
    const recordedAt = new Date().toISOString();
    await writeFile(join(root, "keepalive", launchId, "state.json"), JSON.stringify({
      scriptPid, scriptCommand: "/usr/bin/script", scriptStartedAt: "Mon Sep 28 10:00:00 2026",
      agyPid, agyCommand: "/fake/bin/agy", agyStartedAt: "Mon Sep 28 10:00:01 2026",
      recordedAt, launchId, launchedAt: recordedAt, verified: true,
    }), { mode: 0o600 });
    // Both processes verify and are over age. The moment the watchdog has read
    // both ages, the kernel hands both pids to strangers (new start times).
    let etimeQueries = 0;
    const recycled = (): boolean => etimeQueries >= 2;
    const table = new Map<number, FakeRow>([
      [agyPid, { command: "/fake/bin/agy", startedAt: () => recycled() ? "Tue Sep 29 09:00:00 2026" : "Mon Sep 28 10:00:01 2026", ppid: scriptPid }],
      [scriptPid, { command: "/usr/bin/script", startedAt: () => recycled() ? "Tue Sep 29 09:00:02 2026" : "Mon Sep 28 10:00:00 2026" }],
    ]);
    const execImpl = fakePs(table, () => { etimeQueries += 1; });
    const signalled: Array<[number, string | number | undefined]> = [];
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
      if (Math.abs(target) === agyPid || Math.abs(target) === scriptPid) {
        signalled.push([target, signal]);
        return true; // the strangers are alive; nothing is ever delivered
      }
      return realKill(target, signal as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      const killed = await runAgyWatchdog({ home: root, maxAgeMs: 60_000, execImpl, engineGroups: () => [], log: async () => undefined });
      expect(etimeQueries).toBeGreaterThanOrEqual(2);
      expect(killed).toEqual([]);
      expect(signalled.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 20_000);
});

describe("Antigravity server discovery: the executable decides, never an argument", () => {
  it("an editor or pager naming an agy path or an antigravity-cli directory is not a server", () => {
    expect(isAntigravityServerCommand("/usr/bin/vim /Users/you/.local/bin/agy")).toBe(false);
    expect(isAntigravityServerCommand("tail -f /tmp/antigravity-cli/log")).toBe(false);
    expect(isAntigravityServerCommand("/usr/bin/less /Applications/Antigravity.app/Contents/x/language_server_macos --csrf_token t")).toBe(false);
    expect(isAntigravityServerCommand("/bin/cat /opt/tools/language_server_x --app_data_dir antigravity")).toBe(false);
  });

  it("still recognises the servers the probe reads", () => {
    expect(isAntigravityServerCommand("/Users/you/.local/bin/agy")).toBe(true);
    expect(isAntigravityServerCommand("/Users/you/.local/bin/agy --some-flag")).toBe(true);
    expect(isAntigravityServerCommand("/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token abc")).toBe(true);
    expect(isAntigravityServerCommand("/opt/ls/language_server_linux_x64 --app_data_dir antigravity --csrf_token t")).toBe(true);
    expect(isAntigravityServerCommand("/Users/you/.gemini/antigravity-cli/bin/antigravity-cli serve")).toBe(true);
  });

  it("discovery ignores processes whose arguments merely mention agy or antigravity-cli", async () => {
    const list = async () => [
      { pid: 30, ppid: 1, command: "vim /Users/you/.local/bin/agy", executable: "/usr/bin/vim" },
      { pid: 31, ppid: 1, command: "tail -f /tmp/antigravity-cli/log", executable: "/usr/bin/tail" },
      { pid: 32, ppid: 1, command: "/Users/you/.local/bin/agy", executable: "/Users/you/.local/bin/agy" },
      // A path with a space: the listing supplies the executable separately.
      { pid: 33, ppid: 1, command: "/Applications/Antigravity IDE.app/Contents/x/language_server_macos --csrf_token t", executable: "/Applications/Antigravity IDE.app/Contents/x/language_server_macos" },
    ];
    expect(await externalAntigravityServerPids({ list })).toEqual([32, 33]);
  });

  it("parses the joined ps listings into executable and arguments", () => {
    const rows = parseProcessListing(
      "  30     1 /usr/bin/vim\n  33     1 /Applications/Antigravity IDE.app/Contents/x/language_server_macos\n  40     1 language_server\n",
      "  30 vim /Users/you/.local/bin/agy\n  33 /Applications/Antigravity IDE.app/Contents/x/language_server_macos --csrf_token t\n  40 /usr/share/antigravity/bin/language_server_linux_x64 --csrf_token t\n",
    );
    expect(rows).toEqual([
      { pid: 30, ppid: 1, executable: "/usr/bin/vim", command: "vim /Users/you/.local/bin/agy" },
      { pid: 33, ppid: 1, executable: "/Applications/Antigravity IDE.app/Contents/x/language_server_macos", command: "/Applications/Antigravity IDE.app/Contents/x/language_server_macos --csrf_token t" },
      // procps truncates comm to 15 characters; the argv[0] it prefixes wins.
      { pid: 40, ppid: 1, executable: "/usr/share/antigravity/bin/language_server_linux_x64", command: "/usr/share/antigravity/bin/language_server_linux_x64 --csrf_token t" },
    ]);
    expect(rows.filter((row) => isAntigravityServerCommand(row.command, row.executable)).map((row) => row.pid)).toEqual([33, 40]);
  });
});
