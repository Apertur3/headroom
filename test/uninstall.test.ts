import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { accountsToml } from "../src/registry.js";
import { servicePath } from "../src/service.js";
import { runUninstall, type UninstallOverrides } from "../src/uninstall.js";
import type { ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function captureLog<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { logs.push(line); });
  try { return { result: await run(), logs }; }
  finally { spy.mockRestore(); errorSpy.mockRestore(); }
}

/** Every non-dry-run test overrides both `claudeOnPath` and `runClaudeMcpRemove`
 * (and `runServiceStop` whenever a service file is present) so none of them
 * ever spawns the real `claude` binary or touches launchd/systemd/Task
 * Scheduler on this machine -- only `which`/`where claude` (a harmless PATH
 * read) is ever allowed to run for real, and only in the dry-run tests below. */
const noOverrides: UninstallOverrides = {};
// These tests assert the POSIX form of the printed commands; on a Windows runner the
// default platform would print the PowerShell form (covered by its own tests).
const posix: UninstallOverrides = { platform: "linux" };
// The POSIX form single-quotes a path with characters outside the shell-safe set,
// such as the backslashes of a Windows runner's temp directory.
const posixQuote = (value: string): string => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
// No daemon answers and no wait really sleeps: on a Windows runner the stop-and-wait sequence
// (#136) runs for these tests too, and must never dial a real pipe or slow the suite.
const noDaemon: UninstallOverrides = { probeDaemon: async () => false, requestShutdown: async () => "absent", sleep: async () => {} };
const WINDOWS_END = 'schtasks /End /TN "Headroom Daemon"';
const WINDOWS_DELETE = 'schtasks /Delete /TN "Headroom Daemon" /F';

async function makeTempHomes(): Promise<{ fakeHome: string; headroomHome: string }> {
  const fakeHome = await mkdtemp(join(tmpdir(), "headroom-uninstall-userhome-"));
  const headroomHome = await mkdtemp(join(tmpdir(), "headroom-uninstall-home-"));
  temporary.push(fakeHome, headroomHome);
  return { fakeHome, headroomHome };
}

async function writeClaudeAccount(fakeHome: string, headroomHome: string, options: { profileDirName?: string; registered: boolean; /** Replaces the default user-scope config when set. */ config?: unknown }): Promise<ProviderAccount> {
  const location = options.profileDirName ? join(fakeHome, options.profileDirName) : join(fakeHome, ".claude");
  await mkdir(location, { recursive: true });
  const account: ProviderAccount = { name: options.profileDirName ? options.profileDirName.replace(/^\./, "") : "claude-main", vendor: "claude", location, adapter: "native-ts" };
  await mkdir(headroomHome, { recursive: true });
  // Written to the literal headroomHome path rather than through
  // accountsPath() (which reads HEADROOM_HOME from process.env): this helper
  // runs before withEnv() has set that variable for the calling test.
  await writeFile(join(headroomHome, "accounts.toml"), accountsToml([account]), { mode: 0o600 });
  // claudeConfigJsonPath(): the default profile's .claude.json sits beside
  // ~/.claude, not inside it; a non-default profile's sits inside its own dir.
  const configJsonPath = options.profileDirName ? join(location, ".claude.json") : join(fakeHome, ".claude.json");
  if (options.config !== undefined) await writeFile(configJsonPath, JSON.stringify(options.config));
  else if (options.registered) await writeFile(configJsonPath, JSON.stringify({ mcpServers: { headroom: { command: "headroom", args: ["mcp"] } } }));
  return account;
}

describe("headroom uninstall argument validation", () => {
  it("rejects an unknown flag", async () => {
    await expect(runUninstall(["--bogus"])).rejects.toThrow(/Usage: headroom uninstall/);
  });
});

describe("headroom uninstall: nothing installed", () => {
  it("reports nothing to do at every step, prints the npm line, and exits 0", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], noOverrides));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Step 1: stop and remove the background service");
    expect(output).toContain("nothing to do");
    expect(output).toContain("no accounts.toml; nothing to remove");
    expect(output).toContain("skipped; pass --home");
    expect(output).toContain("npm uninstall -g headroomd");
    expect(output).toContain("Uninstall finished.");
  });
});

describe("headroom uninstall step order", () => {
  it("always runs stop-service, then mcp removal, then the home question, then the npm line, in that order", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--dry-run"], noOverrides));
      logs = captured.logs;
    });
    const output = logs.join("\n");
    const indices = ["Step 1: stop and remove the background service", "Step 2: remove the Claude Code MCP registration", "Step 3: delete the Headroom home directory", "Step 4: uninstall the npm package"].map((needle) => output.indexOf(needle));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("headroom uninstall --dry-run", () => {
  it("describes stopping and removing an installed service without touching it", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const path = servicePath(process.platform, fakeHome, { ...process.env, HEADROOM_HOME: headroomHome });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake service file");
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--dry-run"], noOverrides));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("(dry run) would stop it:");
    expect(output).toContain(`(dry run) would remove ${path}`);
    expect(await fileExists(path)).toBe(true);
  });

  it("describes the MCP removal for a registered profile without running it", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const account = await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true });
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--dry-run"], posix));
      logs = captured.logs;
    });
    const output = logs.join("\n");
    expect(output).toContain(`(dry run) would run for ${account.name} (user scope): CLAUDE_CONFIG_DIR=${posixQuote(account.location)} claude mcp remove --scope user headroom`);
  });

  it("never deletes the home directory, even with --home", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeFile(join(headroomHome, "accounts.toml"), "");
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--home", "--dry-run"], noOverrides));
      logs = captured.logs;
    });
    expect(logs.join("\n")).toContain(`(dry run) would ask to delete ${headroomHome}`);
    expect(await fileExists(headroomHome)).toBe(true);
  });
});

describe("headroom uninstall: background service", () => {
  it("stops it with service.ts's own command and removes the file", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const path = servicePath(process.platform, fakeHome, { ...process.env, HEADROOM_HOME: headroomHome });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake service file");
    const runServiceStop = vi.fn(async (_command: string) => 0);
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { ...noDaemon, claudeOnPath: async () => false, runServiceStop }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    // Windows ends the task first (#136); every other platform runs the one stop command.
    expect(runServiceStop).toHaveBeenCalledTimes(process.platform === "win32" ? 2 : 1);
    expect(logs.join("\n")).toContain(`removed ${path}`);
    expect(await fileExists(path)).toBe(false);
  });

  it("still removes the file when the stop command itself fails (already stopped is the common case)", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const path = servicePath(process.platform, fakeHome, { ...process.env, HEADROOM_HOME: headroomHome });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake service file");
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { ...noDaemon, claudeOnPath: async () => false, runServiceStop: async () => 1 }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("stop command exited 1");
    expect(await fileExists(path)).toBe(false);
  });
});

describe("headroom uninstall: Claude Code MCP registration", () => {
  it("removes it for a registered non-default profile, setting CLAUDE_CONFIG_DIR", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const account = await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    expect(runClaudeMcpRemove).toHaveBeenCalledTimes(1);
    expect(runClaudeMcpRemove.mock.calls[0][0]).toMatchObject({ CLAUDE_CONFIG_DIR: account.location });
    expect(logs.join("\n")).toContain(`removed for ${account.name}`);
  });

  it("removes a user-scope entry with --scope user and no directory", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      await runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove });
    });
    expect(runClaudeMcpRemove.mock.calls.map((call) => [call[1], call[2]])).toEqual([["user", undefined]]);
  });

  it("finds an entry a plain `claude mcp add` left at local scope and removes it with --scope local from the directory it is bound to", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const bound = join(fakeHome, "some-project");
    await mkdir(bound, { recursive: true });
    // Two project entries: one with headroom next to an unrelated server, one with only an unrelated server.
    const config = { projects: {
      [bound]: { mcpServers: { headroom: { command: "headroom", args: ["mcp"] }, other: { command: "other" } } },
      [join(fakeHome, "elsewhere")]: { mcpServers: { other: { command: "other" } } },
    }, mcpServers: { other: { command: "other" } } };
    await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true, config });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      logs = (await captureLog(() => runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove }))).logs;
    });
    // Exactly one removal, for the one directory that holds a headroom entry; the unrelated servers are never named.
    expect(runClaudeMcpRemove.mock.calls.map((call) => [call[1], call[2]])).toEqual([["local", bound]]);
    expect(logs.join("\n")).toContain(`local scope, ${bound}`);
  });

  it("removes both a user-scope and a local-scope entry when a profile has both", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const bound = join(fakeHome, "some-project");
    await mkdir(bound, { recursive: true });
    const config = { mcpServers: { headroom: { command: "headroom" } }, projects: { [bound]: { mcpServers: { headroom: { command: "headroom" } } } } };
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true, config });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      await runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove });
    });
    expect(runClaudeMcpRemove.mock.calls.map((call) => [call[1], call[2]])).toEqual([["user", undefined], ["local", bound]]);
  });

  it("removes it for the default profile without setting CLAUDE_CONFIG_DIR", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      await runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove });
    });
    expect(runClaudeMcpRemove).toHaveBeenCalledTimes(1);
    expect(runClaudeMcpRemove.mock.calls[0][0].CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("skips an unregistered profile entirely", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: false });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove }));
      logs = captured.logs;
    });
    expect(runClaudeMcpRemove).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("not registered for any configured Claude profile");
  });

  it("prints the command instead of running it when `claude` is not on PATH", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const account = await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { ...posix, claudeOnPath: async () => false, runClaudeMcpRemove }));
      logs = captured.logs;
    });
    expect(runClaudeMcpRemove).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`run this yourself for ${account.name} (user scope): CLAUDE_CONFIG_DIR=${posixQuote(account.location)} claude mcp remove --scope user headroom`);
  });

  it("exits 1 when `claude mcp remove` itself fails", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true });
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove: async () => 1 }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("Uninstall finished with errors.");
  });
});

/** #136: on Windows, schtasks /Delete leaves the running daemon alive and it keeps headroom.db
 * open, and schtasks /End does not stop it either (it ends only the task's cmd.exe wrapper). So
 * uninstall asks the daemon to shut down over its pipe, waits for it to go, ends the task as a
 * backup, and only then deletes the task and the home. The shutdown request, the scheduler
 * (runServiceStop) and the daemon probe are mocked; process.kill is spied on to prove nothing is
 * ever killed (a Windows process's identity cannot be verified). */
describe("headroom uninstall on Windows: stop the daemon before deleting the home", () => {
  async function windowsSetup(): Promise<{ fakeHome: string; headroomHome: string; env: Record<string, string> }> {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeFile(join(headroomHome, "headroom.db"), "fake database");
    return { fakeHome, headroomHome, env: { HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" } };
  }
  /** Written where servicePath("win32") points. On a POSIX runner win32 paths are backslash-joined,
   * so this is a stray file in the cwd (as in service-start.test.ts); afterEach removes it. */
  async function writeWindowsTask(headroomHome: string): Promise<string> {
    const path = servicePath("win32", "unused", { HEADROOM_HOME: headroomHome });
    temporary.push(path);
    await writeFile(path, "fake task xml");
    return path;
  }

  it("asks the daemon to shut down, waits for it to exit, ends the task as a backup, then deletes the task, then the home", async () => {
    const { headroomHome, env } = await windowsSetup();
    const events: string[] = [];
    let homeExistedAtDelete: boolean | undefined;
    const runServiceStop = vi.fn(async (command: string) => {
      events.push(command);
      if (command === WINDOWS_DELETE) homeExistedAtDelete = await fileExists(headroomHome);
      return 0;
    });
    let answers = 2; // still up for two probes after the shutdown request, then gone
    const probeDaemon = async () => { events.push("probe"); return answers-- > 0; };
    const requestShutdown = vi.fn(async () => { events.push("shutdown"); return "accepted" as const; });
    const kill = vi.spyOn(process, "kill");
    let code = -1;
    let logs: string[] = [];
    try {
      await withEnv(env, async () => {
        await writeWindowsTask(headroomHome);
        const captured = await captureLog(() => runUninstall(["--home", "--yes"], { ...posix, servicePlatform: "win32", claudeOnPath: async () => false, runServiceStop, probeDaemon, requestShutdown, sleep: async () => { events.push("sleep"); } }));
        code = captured.result;
        logs = captured.logs;
      });
    } finally { kill.mockRestore(); }
    expect(code).toBe(0);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(runServiceStop.mock.calls.map(([command]) => command)).toEqual([WINDOWS_END, WINDOWS_DELETE]);
    const shutdown = events.indexOf("shutdown");
    const end = events.indexOf(WINDOWS_END);
    const remove = events.indexOf(WINDOWS_DELETE);
    // Order: shutdown request, then the wait (two answers and three consecutive misses), then the
    // backup /End, then /Delete; the home goes last (it still existed at /Delete).
    expect(shutdown).toBe(0);
    expect(events.slice(shutdown + 1, end).filter((event) => event === "probe")).toHaveLength(5);
    expect(end).toBeLessThan(remove);
    expect(events.slice(end + 1, remove)).toEqual([]);
    expect(homeExistedAtDelete).toBe(true);
    expect(await fileExists(headroomHome)).toBe(false);
    temporary.splice(temporary.indexOf(headroomHome), 1);
    expect(logs.join("\n")).toContain("the daemon is not running");
    expect(logs.join("\n")).toContain(`deleted ${headroomHome}`);
    expect(kill).not.toHaveBeenCalled();
  });

  it("exits non-zero with a clear message and keeps the home when the daemon will not stop, killing nothing", async () => {
    const { headroomHome, env } = await windowsSetup();
    const runServiceStop = vi.fn(async (_command: string) => 0);
    const kill = vi.spyOn(process, "kill");
    let code = -1;
    let logs: string[] = [];
    try {
      await withEnv(env, async () => {
        await writeWindowsTask(headroomHome);
        const captured = await captureLog(() => runUninstall(["--home", "--yes"], { ...posix, servicePlatform: "win32", claudeOnPath: async () => false, runServiceStop, probeDaemon: async () => true, requestShutdown: async () => "accepted", sleep: async () => {}, stopWaitMs: 0 }));
        code = captured.result;
        logs = captured.logs;
      });
    } finally { kill.mockRestore(); }
    expect(code).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("the Headroom daemon is still running 0s after it was asked to stop: it accepted the shutdown request but kept answering");
    expect(output).toContain("cannot verify a Windows process's identity, so it does not kill it");
    expect(output).toContain(`not deleted: the daemon is still running (see step 1); ${headroomHome} was left in place`);
    expect(output).toContain("Uninstall finished with errors.");
    expect(await fileExists(join(headroomHome, "headroom.db"))).toBe(true);
    // Only the scheduler's own end and delete ran: no taskkill, no signal to any pid.
    expect(runServiceStop.mock.calls.map(([command]) => command)).toEqual([WINDOWS_END, WINDOWS_DELETE]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to /End and the bounded wait for an older daemon without the shutdown request, and says so when it survives", async () => {
    const { headroomHome, env } = await windowsSetup();
    const events: string[] = [];
    const runServiceStop = vi.fn(async (command: string) => { events.push(command); return 0; });
    const probeDaemon = async () => { events.push("probe"); return true; };
    const kill = vi.spyOn(process, "kill");
    let code = -1;
    let logs: string[] = [];
    try {
      await withEnv(env, async () => {
        await writeWindowsTask(headroomHome);
        const captured = await captureLog(() => runUninstall(["--home", "--yes"], { ...posix, servicePlatform: "win32", claudeOnPath: async () => false, runServiceStop, probeDaemon, requestShutdown: async () => "unsupported", sleep: async () => {}, stopWaitMs: 0 }));
        code = captured.result;
        logs = captured.logs;
      });
    } finally { kill.mockRestore(); }
    expect(code).toBe(1);
    // No pointless wait before /End: an older daemon will not stop on its own.
    expect(events[0]).toBe(WINDOWS_END);
    expect(logs.join("\n")).toContain("it is from a version without the shutdown request, and schtasks /End did not stop it");
    expect(await fileExists(join(headroomHome, "headroom.db"))).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses to delete the home while a daemon started outside the service still answers", async () => {
    const { headroomHome, env } = await windowsSetup();
    const kill = vi.spyOn(process, "kill");
    let code = -1;
    let logs: string[] = [];
    try {
      await withEnv(env, async () => {
        const captured = await captureLog(() => runUninstall(["--home", "--yes"], { ...posix, servicePlatform: "win32", claudeOnPath: async () => false, probeDaemon: async () => true, sleep: async () => {} }));
        code = captured.result;
        logs = captured.logs;
      });
    } finally { kill.mockRestore(); }
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("not deleted: a Headroom daemon for this home is still running");
    expect(await fileExists(join(headroomHome, "headroom.db"))).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("describes the end-and-wait step in a dry run without running anything", async () => {
    const { headroomHome, env } = await windowsSetup();
    const runServiceStop = vi.fn(async (_command: string) => 0);
    const probeDaemon = vi.fn(async () => false);
    const requestShutdown = vi.fn(async () => "absent" as const);
    let logs: string[] = [];
    await withEnv(env, async () => {
      await writeWindowsTask(headroomHome);
      logs = (await captureLog(() => runUninstall(["--dry-run", "--home"], { ...posix, servicePlatform: "win32", claudeOnPath: async () => false, runServiceStop, probeDaemon, requestShutdown }))).logs;
    });
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`would ask the daemon to shut down, wait up to 10s for it to exit, then end the task (${WINDOWS_END})`);
    expect(runServiceStop).not.toHaveBeenCalled();
    expect(probeDaemon).not.toHaveBeenCalled();
  });
});

describe("headroom uninstall --home", () => {
  it("does nothing without --yes when there is no TTY to ask (vitest's own stdin is never a TTY)", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeFile(join(headroomHome, "accounts.toml"), "");
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--home"], noOverrides));
      logs = captured.logs;
    });
    expect(logs.join("\n")).toContain("skipped; not deleted");
    expect(await fileExists(headroomHome)).toBe(true);
  });

  it("deletes the home directory with --home --yes, including accounts.toml", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeFile(join(headroomHome, "accounts.toml"), "");
    await writeFile(join(headroomHome, "headroom.db"), "fake database");
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--home", "--yes"], noDaemon));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(`deleted ${headroomHome}`);
    expect(await fileExists(headroomHome)).toBe(false);
    temporary.splice(temporary.indexOf(headroomHome), 1); // already gone; nothing left for afterEach to clean
  });

  it("notes on macOS that the Keychain grant marker lives inside the home and the probe binary's own ACL does not", async () => {
    if (process.platform !== "darwin") return;
    const { fakeHome, headroomHome } = await makeTempHomes();
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall(["--home", "--yes"], noOverrides));
      logs = captured.logs;
    });
    expect(logs.join("\n")).toContain("Keychain grant marker lives inside this directory");
  });
});

describe("headroom uninstall dispatch", () => {
  it("headroom uninstall --dry-run is wired up through main()", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => main(["uninstall", "--dry-run"]));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Headroom uninstall (dry run; nothing will change)");
    expect(await readdir(headroomHome)).toEqual([]);
  });
});

describe("headroom uninstall: removal environment and vanished directories", () => {
  it("passes an absolute CLAUDE_CONFIG_DIR even when the profile location is relative", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const bound = join(fakeHome, "proj");
    await mkdir(bound, { recursive: true });
    const config = { projects: { [bound]: { mcpServers: { headroom: { command: "headroom" } } } } };
    const account = await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true, config });
    // Rewrite accounts.toml with a location relative to the current directory.
    const relativeLocation = relative(process.cwd(), account.location);
    await writeFile(join(headroomHome, "accounts.toml"), accountsToml([{ ...account, location: relativeLocation }]), { mode: 0o600 });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      await runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove });
    });
    expect(runClaudeMcpRemove).toHaveBeenCalledTimes(1);
    expect(runClaudeMcpRemove.mock.calls[0][0].CLAUDE_CONFIG_DIR).toBe(account.location);
  });

  it("does not let an inherited CLAUDE_CONFIG_DIR redirect the default profile's removal", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "", CLAUDE_CONFIG_DIR: "/somewhere/else" }, async () => {
      await runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove });
    });
    expect(runClaudeMcpRemove).toHaveBeenCalledTimes(1);
    expect(runClaudeMcpRemove.mock.calls[0][0].CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("prints a default-profile retry command that unsets an inherited CLAUDE_CONFIG_DIR", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true });
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "", CLAUDE_CONFIG_DIR: "/somewhere/else" }, async () => {
      logs = (await captureLog(() => runUninstall(["--dry-run"], posix))).logs;
    });
    expect(logs.join("\n")).toContain("env -u CLAUDE_CONFIG_DIR claude mcp remove --scope user headroom");
  });

  it("prints a PowerShell retry command on win32 and keeps env -u on POSIX", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true });
    const run = async (platform: NodeJS.Platform) => {
      let logs: string[] = [];
      await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
        logs = (await captureLog(() => runUninstall(["--dry-run"], { ...noOverrides, platform }))).logs;
      });
      return logs.join("\n");
    };
    const win = await run("win32");
    expect(win).toContain("Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; claude mcp remove --scope user headroom");
    expect(win).not.toContain("env -u");
    const posix = await run("linux");
    expect(posix).toContain("env -u CLAUDE_CONFIG_DIR claude mcp remove --scope user headroom");
    expect(posix).not.toContain("Remove-Item");
  });

  it("on win32 only runs a local-scope removal once Set-Location into the bound directory succeeded", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const bound = join(fakeHome, "proj");
    await mkdir(bound, { recursive: true });
    const config = { projects: { [bound]: { mcpServers: { headroom: { command: "headroom" } } } } };
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true, config });
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      logs = (await captureLog(() => runUninstall(["--dry-run"], { ...noOverrides, platform: "win32" }))).logs;
    });
    const output = logs.join("\n");
    expect(output).toContain(`if (Set-Location -LiteralPath '${bound}' -PassThru -ErrorAction SilentlyContinue) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; claude mcp remove --scope local headroom }`);
    expect(output).not.toContain(`Set-Location '${bound}';`);
  });

  it("quotes the directory in the printed mkdir command for a path with a space", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const gone = join(fakeHome, "deleted worktree");
    const config = { projects: { [gone]: { mcpServers: { headroom: { command: "headroom" } } } } };
    await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true, config });
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      logs = (await captureLog(() => runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove: vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0) }))).logs;
    });
    expect(logs.join("\n")).toContain(`mkdir -p '${gone}'`);
  });

  it("does not spawn for a local-scope entry whose directory is gone, and says how to remove it", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    const gone = join(fakeHome, "deleted-worktree");
    const config = { projects: { [gone]: { mcpServers: { headroom: { command: "headroom" } } } } };
    await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: true, config });
    const runClaudeMcpRemove = vi.fn(async (_env: NodeJS.ProcessEnv, _scope: "user" | "local", _cwd?: string) => 0);
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      logs = (await captureLog(() => runUninstall([], { ...posix, claudeOnPath: async () => true, runClaudeMcpRemove }))).logs;
    });
    expect(runClaudeMcpRemove).not.toHaveBeenCalled();
    const output = logs.join("\n");
    expect(output).toContain("no longer exists");
    const quoted = posixQuote(gone);
    expect(output).toContain(`mkdir -p ${quoted}`);
    expect(output).not.toContain(`(cd ${quoted}`);
  });
});
