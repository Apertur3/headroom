import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function makeTempHomes(): Promise<{ fakeHome: string; headroomHome: string }> {
  const fakeHome = await mkdtemp(join(tmpdir(), "headroom-uninstall-userhome-"));
  const headroomHome = await mkdtemp(join(tmpdir(), "headroom-uninstall-home-"));
  temporary.push(fakeHome, headroomHome);
  return { fakeHome, headroomHome };
}

async function writeClaudeAccount(fakeHome: string, headroomHome: string, options: { profileDirName?: string; registered: boolean }): Promise<ProviderAccount> {
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
  if (options.registered) await writeFile(configJsonPath, JSON.stringify({ mcpServers: { headroom: { command: "headroom", args: ["mcp"] } } }));
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
      const captured = await captureLog(() => runUninstall(["--dry-run"], noOverrides));
      logs = captured.logs;
    });
    const output = logs.join("\n");
    expect(output).toContain(`(dry run) would run for ${account.name}: CLAUDE_CONFIG_DIR=${account.location} claude mcp remove headroom`);
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
    const runServiceStop = vi.fn(async () => 0);
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { claudeOnPath: async () => false, runServiceStop }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    expect(runServiceStop).toHaveBeenCalledTimes(1);
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
      const captured = await captureLog(() => runUninstall([], { claudeOnPath: async () => false, runServiceStop: async () => 1 }));
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
    const runClaudeMcpRemove = vi.fn(async () => 0);
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

  it("removes it for the default profile without setting CLAUDE_CONFIG_DIR", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { registered: true });
    const runClaudeMcpRemove = vi.fn(async () => 0);
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      await runUninstall([], { claudeOnPath: async () => true, runClaudeMcpRemove });
    });
    expect(runClaudeMcpRemove).toHaveBeenCalledTimes(1);
    expect(runClaudeMcpRemove.mock.calls[0][0].CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("skips an unregistered profile entirely", async () => {
    const { fakeHome, headroomHome } = await makeTempHomes();
    await writeClaudeAccount(fakeHome, headroomHome, { profileDirName: ".claude2", registered: false });
    const runClaudeMcpRemove = vi.fn(async () => 0);
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
    const runClaudeMcpRemove = vi.fn(async () => 0);
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runUninstall([], { claudeOnPath: async () => false, runClaudeMcpRemove }));
      logs = captured.logs;
    });
    expect(runClaudeMcpRemove).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`run this yourself for ${account.name}: CLAUDE_CONFIG_DIR=${account.location} claude mcp remove headroom`);
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
      const captured = await captureLog(() => runUninstall(["--home", "--yes"], noOverrides));
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
