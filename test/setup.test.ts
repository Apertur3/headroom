import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { accountsPath } from "../src/registry.js";
import { runSetup } from "../src/setup.js";

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
  try { return { result: await run(), logs }; }
  finally { spy.mockRestore(); }
}

describe("headroom setup, non-interactive (vitest's own stdin is never a TTY)", () => {
  it("with no flags at all, narrates the full plan, asks nothing, and changes nothing", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "headroom-setup-userhome-"));
    const headroomHome = await mkdtemp(join(tmpdir(), "headroom-setup-home-"));
    temporary.push(fakeHome, headroomHome);
    let code = -1;
    let logs: string[] = [];
    let accountsExists = true;
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => main(["setup"]));
      code = captured.result;
      logs = captured.logs;
      accountsExists = await fileExists(accountsPath());
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("nothing will change");
    expect(output).toContain("Step 1: discover accounts");
    expect(output).toContain("Step 6: final check");
    // Nothing changed: no accounts.toml, no policy/routing seed.
    expect(accountsExists).toBe(false);
    expect(await fileExists(join(headroomHome, "policy.toml"))).toBe(false);
  });
});

describe("headroom setup --dry-run", () => {
  it("produces the full six-step plan against an empty temporary home and writes nothing", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "headroom-setup-userhome-"));
    const headroomHome = await mkdtemp(join(tmpdir(), "headroom-setup-home-"));
    temporary.push(fakeHome, headroomHome);
    let code = -1;
    let logs: string[] = [];
    let accountsExists = true;
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => main(["setup", "--dry-run"]));
      code = captured.result;
      logs = captured.logs;
      accountsExists = await fileExists(accountsPath());
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    for (const step of ["Step 1: discover accounts", "Step 2: run doctor", "Step 3: grant Keychain access", "Step 4: install the background service", "Step 5: register the MCP server", "Step 6: final check"]) {
      expect(output).toContain(step);
    }
    expect(output).toContain("Setup finished.");
    expect(accountsExists).toBe(false);
    expect(await fileExists(join(headroomHome, "Library", "LaunchAgents", "com.headroom.daemon.plist"))).toBe(false);
  });
});

describe("headroom setup --yes", () => {
  it("never runs the Keychain grant, even for a principal that needs one, and prints the command instead", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "headroom-setup-userhome-"));
    const headroomHome = await mkdtemp(join(tmpdir(), "headroom-setup-home-"));
    temporary.push(fakeHome, headroomHome);
    // A non-default Claude config dir name, exactly like the existing keychain
    // tests use, so credentialCheck's darwin path (a harmless, read-only
    // `security find-generic-password` lookup) uses a hashed service name
    // that can never collide with the real Keychain item for this machine's
    // own ~/.claude login.
    await mkdir(join(fakeHome, ".claude-setup-test"), { recursive: true });
    const keychainGrant = vi.fn(async () => 0);
    const claudeOnPath = vi.fn(async () => false);
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runSetup(["--yes", "--skip-service", "--skip-mcp"], { keychainGrant, claudeOnPath }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    expect(keychainGrant).not.toHaveBeenCalled();
    const output = logs.join("\n");
    expect(output).not.toContain("Keychain access granted");
    if (process.platform === "darwin") {
      // The account discovered above has no real Keychain item under this
      // hashed service name, so doctor reports it needs a grant, and setup's
      // own --yes rule must print the fix command rather than run it.
      expect(output).toMatch(/run this yourself: headroom keychain grant --principal \S+/);
    } else {
      expect(output).toContain("skipped; not macOS");
    }
  });
});

describe("headroom setup --skip-service --skip-mcp", () => {
  it("skips both steps outright, distinct from the dry-run plan wording", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "headroom-setup-userhome-"));
    const headroomHome = await mkdtemp(join(tmpdir(), "headroom-setup-home-"));
    temporary.push(fakeHome, headroomHome);
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => main(["setup", "--skip-service", "--skip-mcp"]));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("skipped via --skip-service");
    expect(output).toContain("skipped via --skip-mcp");
    // The service/MCP steps' own dry-run narration never runs at all once
    // skipped -- distinct from --dry-run, which still describes them.
    expect(output).not.toContain("com.headroom.daemon.plist");
    expect(output).not.toContain("would offer to run this now");
    expect(output).not.toContain("claude mcp add headroom -- headroom mcp");
    expect(await fileExists(join(headroomHome, "Library", "LaunchAgents", "com.headroom.daemon.plist"))).toBe(false);
  });
});

describe("headroom setup argument validation", () => {
  it("rejects an unknown flag", async () => {
    await expect(runSetup(["--bogus"])).rejects.toThrow(/Usage: headroom setup/);
  });
});
