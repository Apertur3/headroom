import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_HELP, COMMAND_LIST, helpText, isAccountsMissingError, main, noKeychainItemMessage } from "../src/cli.js";
import { accountsPath } from "../src/registry.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

describe("headroom with no registry", () => {
  it("classifies the fresh-install ENOENT on accounts.toml, and only that exact error", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-noaccounts-"));
    temporary.push(home);
    await withEnv({ HEADROOM_HOME: home }, async () => {
      await expect(main([])).rejects.toSatisfy((error: unknown) => isAccountsMissingError(error));
    });
    // A missing file elsewhere, or a real accounts.toml that is simply
    // invalid, must never be misclassified as "no registry yet".
    expect(isAccountsMissingError(new Error("boom"))).toBe(false);
    const wrongPath = Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/somewhere/else/accounts.toml" });
    expect(isAccountsMissingError(wrongPath)).toBe(false);
    const rightPath = Object.assign(new Error("ENOENT"), { code: "ENOENT", path: accountsPath() });
    expect(isAccountsMissingError(rightPath)).toBe(true);
  });
});

describe("headroom accounts discover", () => {
  it("prints the write confirmation and seeds policy/routing from examples/, documenting the action classes", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "headroom-userhome-"));
    const headroomHome = await mkdtemp(join(tmpdir(), "headroom-target-"));
    temporary.push(fakeHome, headroomHome);
    await mkdir(join(fakeHome, ".claude"));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      // PATH cleared so a real `agy` binary elsewhere on this machine never
      // adds an unplanned Antigravity account and changes the expected count.
      // USERPROFILE alongside HOME: node:os's homedir() reads USERPROFILE on
      // Windows and ignores HOME entirely, so discoverAccounts()'s default
      // homedir() lookup would otherwise fall through to the real runner
      // profile (finding no .claude dir, and reporting 0 accounts instead
      // of the 1 this test seeds).
      await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome, PATH: "" }, async () => {
        const code = await main(["accounts", "discover"]);
        expect(code).toBe(0);
      });
    } finally { spy.mockRestore(); }
    expect(logs.some((line) => line === `Wrote ${join(headroomHome, "accounts.toml")} (1 account). Next: headroom doctor`)).toBe(true);
    expect(logs.some((line) => line.includes("Seeded") && line.includes("policy.toml"))).toBe(true);
    const routingLine = logs.find((line) => line.includes("routing.toml"));
    expect(routingLine).toBeDefined();
    expect(routingLine).toContain("claude-fable");
    expect(routingLine).toContain("codex-build");
    expect(routingLine).toContain("gemini-bulk");
    // The files this session claims to have written are actually there.
    await expect(readFile(join(headroomHome, "accounts.toml"), "utf8")).resolves.toContain("claude-main");
    await expect(readFile(join(headroomHome, "policy.toml"), "utf8")).resolves.toContain("freeze_reserve_pct");
    await expect(readFile(join(headroomHome, "routing.toml"), "utf8")).resolves.toContain("claude-fable");
  });
});

describe("headroom --help / help", () => {
  it("lists every documented command once, with its own summary", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      expect(await main(["--help"])).toBe(0);
      expect(await main(["help"])).toBe(0);
    } finally { spy.mockRestore(); }
    for (const output of [logs[0], logs[logs.length - 1]]) void output; // both invocations logged something
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const text = helpText();
    for (const [name] of COMMAND_LIST) expect(text).toContain(name);
    for (const name of ["can", "doctor", "lease", "logs", "install-service"]) expect(COMMAND_LIST.some(([entry]) => entry === name || entry.startsWith(`${name} `))).toBe(true);
  });

  it("prints one command's usage for `headroom <command> --help` without running the command", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      // `can` with no action class would normally throw "Usage: ..."; --help
      // must short-circuit before that argument validation ever runs.
      expect(await main(["can", "--help"])).toBe(0);
      expect(await main(["lease", "--help"])).toBe(0);
    } finally { spy.mockRestore(); }
    expect(logs).toContain(COMMAND_HELP.can);
    expect(logs).toContain(COMMAND_HELP.lease);
  });
});

describe("keychain grant message for a config dir with no Claude login", () => {
  it("names the exact fix, not the probe's generic wording", () => {
    expect(noKeychainItemMessage("/Users/test/.claude2")).toBe(
      "no Claude login for /Users/test/.claude2; run: CLAUDE_CONFIG_DIR=/Users/test/.claude2 claude, or remove this principal from accounts.toml",
    );
  });
});

describe("headroom install-service --dry-run", () => {
  it("prints the full unit/plist/task text it would write, not just the path and load command", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-install-dryrun-"));
    temporary.push(home);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      await withEnv({ HEADROOM_HOME: home }, async () => {
        const code = await main(["install-service", "--dry-run"]);
        expect(code).toBe(0);
      });
    } finally { spy.mockRestore(); }
    const output = logs.join("\n");
    expect(output).toContain("would write");
    expect(output).toContain("To load it:");
    // The service file body itself, not just the two summary lines --
    // whichever platform this test runs on.
    const hasUnixUnitBody = output.includes("[Unit]") || output.includes("<key>Label</key><string>com.headroom.daemon</string>");
    const hasWindowsTaskBody = output.includes("<Task version=\"1.4\"");
    expect(hasUnixUnitBody || hasWindowsTaskBody).toBe(true);
  });
});
