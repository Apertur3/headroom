import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { accountsPath } from "../src/registry.js";
import { isYes, runSetup, stepNotifications } from "../src/setup.js";

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
    expect(output).toContain("Step 5: final check");
    // Nothing changed: no accounts.toml, no policy/routing seed.
    expect(accountsExists).toBe(false);
    expect(await fileExists(join(headroomHome, "policy.toml"))).toBe(false);
    // a plan must never open (and so create) the Headroom home
    // database, perform a Keychain lookup, or poll a vendor -- the doctor
    // and final-check steps must describe that work, not run it.
    expect(await readdir(headroomHome)).toEqual([]);
    expect(output).toContain("(dry run) would run: headroom doctor");
    expect(output).toContain("(dry run) would run: headroom doctor and headroom observe");
  });
});

describe("headroom setup --dry-run", () => {
  it("produces the full five-step plan against an empty temporary home and writes nothing", async () => {
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
    for (const step of ["Step 1: discover accounts", "Step 2: run doctor", "Step 3: install the background service", "Step 4: register the MCP server", "Step 5: final check"]) {
      expect(output).toContain(step);
    }
    // The Keychain grant step is gone entirely: nothing is granted any more,
    // because the probe reads the credential through the Apple security tool
    // the item already admits.
    expect(output).not.toContain("grant Keychain access");
    expect(output).not.toContain("headroom keychain grant");
    if (process.platform === "darwin") expect(output).toContain("no Keychain dialog to answer");
    expect(output).toContain("Setup finished.");
    expect(accountsExists).toBe(false);
    expect(await fileExists(join(headroomHome, "Library", "LaunchAgents", "com.headroom.daemon.plist"))).toBe(false);
    // an empty temporary home must stay empty after a dry run --
    // no headroom.db, no logs/ directory, nothing at all.
    expect(await readdir(headroomHome)).toEqual([]);
  });
});

describe("headroom setup: empty-answer confirmation defaults to No", () => {
  it("treats Enter, blank, and anything but an explicit y/yes as No, matching the [y/N] prompt", () => {
    expect(isYes("")).toBe(false);
    expect(isYes("   ")).toBe(false);
    expect(isYes("n")).toBe(false);
    expect(isYes("no")).toBe(false);
    expect(isYes("maybe")).toBe(false);
    expect(isYes("y")).toBe(true);
    expect(isYes("Y")).toBe(true);
    expect(isYes("yes")).toBe(true);
    expect(isYes("YES")).toBe(true);
    expect(isYes("  y  ")).toBe(true);
  });
});

describe("headroom setup --yes", () => {
  it("never asks about Keychain access, and never prints a grant command, for a principal an older build would have sent to one", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "headroom-setup-userhome-"));
    const headroomHome = await mkdtemp(join(tmpdir(), "headroom-setup-home-"));
    temporary.push(fakeHome, headroomHome);
    // A non-default Claude config dir name, exactly like the existing keychain
    // tests use, so credentialCheck's darwin path (a harmless, read-only
    // `security find-generic-password` lookup) uses a hashed service name
    // that can never collide with the real Keychain item for this machine's
    // own ~/.claude login.
    await mkdir(join(fakeHome, ".claude-setup-test"), { recursive: true });
    const claudeOnPath = vi.fn(async () => false);
    let code = -1;
    let logs: string[] = [];
    await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
      const captured = await captureLog(() => runSetup(["--yes", "--skip-service", "--skip-mcp"], { claudeOnPath }));
      code = captured.result;
      logs = captured.logs;
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).not.toContain("headroom keychain grant");
    expect(output).not.toContain("Keychain access granted");
    expect(output).not.toContain("credential readable, no dialog needed");
    if (process.platform === "darwin") expect(output).toContain("no Keychain dialog to answer");
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


describe("setup notifications step", () => {
  it("offers the shared picker after an explicit yes and shares its question function", async () => {
    const questions: string[] = [];
    const rl = { question: async (question: string) => { questions.push(question); return "y"; } };
    let configured = false;
    await captureLog(() => stepNotifications({ yes: false, planOnly: false, rl }, {
      configureNotify: async (ask) => { configured = true; expect(await ask("Channels? ")).toBe("y"); return 0; },
    }));
    expect(configured).toBe(true);
    expect(questions).toEqual(["Notifications? [y/N] ", "Channels? "]);
  });

  it("skips on Enter, --yes and plan mode and names the command for later", async () => {
    for (const flags of [{ yes: false, planOnly: false }, { yes: true, planOnly: false }, { yes: false, planOnly: true }]) {
      const question = vi.fn(async () => "");
      const configureNotify = vi.fn(async () => 0);
      const { logs } = await captureLog(() => stepNotifications({ ...flags, rl: { question } }, { configureNotify }));
      expect(configureNotify).not.toHaveBeenCalled();
      expect(logs.join("\n")).toContain("headroom notify configure");
      expect(question).toHaveBeenCalledTimes(flags.yes || flags.planOnly ? 0 : 1);
    }
  });
});
