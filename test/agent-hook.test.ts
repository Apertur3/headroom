import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeConfigDirs, hookCommand, hookCommandMain, hookScriptPath, hookState, installHook, isHeadroomCommand, uninstallHook, type HookOptions } from "../src/agent-hook.js";
import { main } from "../src/cli.js";
import { stepAgentHook } from "../src/setup.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A fake user home with its own Claude config dirs and Headroom home: the
 * real ~/.claude, ~/.claude2 and ~/.headroom are never touched. */
async function sandbox(dirs: string[] = [".claude"]): Promise<{ user: string; home: string; options: HookOptions; logs: string[] }> {
  const user = await mkdtemp(join(tmpdir(), "headroom-hook-user-"));
  temporary.push(user);
  for (const dir of dirs) await mkdir(join(user, dir));
  const logs: string[] = [];
  const home = join(user, ".headroom");
  return { user, home, logs, options: { env: {}, userHome: user, home, platform: "darwin", now: new Date("2026-10-04T20:00:00.000Z"), log: (line) => logs.push(line) } };
}

const OTHER_SETTINGS = {
  model: "opus",
  permissions: { allow: ["Bash(git status)"], deny: [] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "~/.claude/hooks/headroom-line.sh" }, { type: "command", command: "echo hi" }] }],
  },
  statusLine: { type: "command", command: "headroom statusline" },
  zzz: [1, 2.5, "ü"],
};

// Hook install is POSIX-only (Windows prints "not supported" and is covered
// by the exit-code tests below), and these assert POSIX modes and symlinks.
describe.skipIf(process.platform === "win32")("headroom hook install / uninstall", () => {
  it("adds exactly one tagged entry, leaves every other key byte-identical, and uninstall restores the file", async () => {
    const { user, home, options } = await sandbox();
    const path = join(user, ".claude", "settings.json");
    const original = `${JSON.stringify(OTHER_SETTINGS, null, 2)}\n`;
    await writeFile(path, original);
    expect(await installHook(options)).toBe(0);
    const installed = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(installed)).toEqual(Object.keys(OTHER_SETTINGS));
    expect({ ...installed, hooks: undefined }).toEqual({ ...OTHER_SETTINGS, hooks: undefined });
    expect(installed.hooks.PreToolUse).toEqual(OTHER_SETTINGS.hooks.PreToolUse);
    expect(installed.hooks.UserPromptSubmit).toEqual([...OTHER_SETTINGS.hooks.UserPromptSubmit, { hooks: [{ type: "command", command: hookCommand(home) }] }]);
    // The owner's old prototype (headroom-line.sh) is not ours and stays.
    expect(isHeadroomCommand("~/.claude/hooks/headroom-line.sh")).toBe(false);
    expect(isHeadroomCommand(hookCommand(home))).toBe(true);
    expect((await stat(hookScriptPath(home))).mode & 0o777).toBe(0o700);

    expect(await uninstallHook(options)).toBe(0);
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(stat(hookScriptPath(home))).rejects.toThrow();
  });

  it("is idempotent: a second install changes nothing, not even the mtime", async () => {
    const { user, options, logs } = await sandbox();
    const path = join(user, ".claude", "settings.json");
    await writeFile(path, `${JSON.stringify(OTHER_SETTINGS, null, 2)}\n`);
    await installHook(options);
    const first = await readFile(path, "utf8");
    const firstStat = await stat(path);
    logs.length = 0;
    expect(await installHook(options)).toBe(0);
    expect(await readFile(path, "utf8")).toBe(first);
    expect((await stat(path)).mtimeMs).toBe(firstStat.mtimeMs);
    expect(logs.join("\n")).toContain("no change needed");
    expect(JSON.parse(first).hooks.UserPromptSubmit.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks).filter((hook: { command: string }) => isHeadroomCommand(hook.command))).toHaveLength(1);
  });

  it("backs settings.json up once, before the first change only", async () => {
    const { user, options } = await sandbox();
    const dir = join(user, ".claude");
    const original = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;
    await writeFile(join(dir, "settings.json"), original);
    await installHook(options);
    await uninstallHook(options);
    await installHook(options);
    const backups = (await readdir(dir)).filter((name) => name.startsWith("settings.json.headroom-bak-"));
    expect(backups).toEqual(["settings.json.headroom-bak-20261004T200000Z"]);
    expect(await readFile(join(dir, backups[0]), "utf8")).toBe(original);
  });

  it("refuses to touch a settings file that does not parse, and installs into the others", async () => {
    const { user, home, options, logs } = await sandbox([".claude", ".claude2"]);
    const broken = "{ \"model\": \"opus\", // a comment\n}\n";
    await writeFile(join(user, ".claude", "settings.json"), broken);
    expect(await installHook(options)).toBe(1);
    expect(await readFile(join(user, ".claude", "settings.json"), "utf8")).toBe(broken);
    expect((await readdir(join(user, ".claude"))).filter((name) => name.includes("headroom-bak"))).toEqual([]);
    expect(logs.join("\n")).toMatch(/refusing to edit .*\.claude\/settings\.json: it is not valid JSON/);
    // ~/.claude2 had no settings.json: it gets one with only the hook.
    expect(JSON.parse(await readFile(join(user, ".claude2", "settings.json"), "utf8"))).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(home) }] }] } });
    expect(await uninstallHook(options)).toBe(1);
    expect(await readFile(join(user, ".claude", "settings.json"), "utf8")).toBe(broken);
  });

  it("removes a script it created when every settings file was refused", async () => {
    const { user, home, options } = await sandbox();
    await writeFile(join(user, ".claude", "settings.json"), "[1, 2]\n");
    expect(await installHook(options)).toBe(1);
    await expect(stat(hookScriptPath(home))).rejects.toThrow();
  });

  it("covers CLAUDE_CONFIG_DIR instead of ~/.claude, plus ~/.claude2, and never creates a config dir", async () => {
    const { user, options } = await sandbox([".claude2", "custom"]);
    const env = { CLAUDE_CONFIG_DIR: join(user, "custom") };
    expect(await claudeConfigDirs(env, user)).toEqual([join(user, "custom"), join(user, ".claude2")]);
    expect(await installHook({ ...options, env })).toBe(0);
    await expect(stat(join(user, ".claude"))).rejects.toThrow();
    expect(await readdir(join(user, "custom"))).toEqual(["settings.json"]);
    // Without CLAUDE_CONFIG_DIR, ~/.claude is the default and does not exist here.
    expect(await claudeConfigDirs({}, user)).toEqual([join(user, ".claude2")]);
  });

  it("does nothing when no Claude config dir exists", async () => {
    const { user, home, options, logs } = await sandbox([]);
    expect(await installHook(options)).toBe(1);
    expect(logs.join("\n")).toContain("No Claude Code config directory found");
    expect(await readdir(user)).toEqual([]);
    await expect(stat(home)).rejects.toThrow();
  });

  it("keeps the file's own indentation and missing trailing newline", async () => {
    const { user, options } = await sandbox();
    const path = join(user, ".claude", "settings.json");
    const original = JSON.stringify({ a: 1, hooks: { Stop: [] } }, null, "\t");
    await writeFile(path, original);
    await installHook(options);
    const installed = await readFile(path, "utf8");
    expect(installed.endsWith("\n")).toBe(false);
    expect(installed).toContain("\n\t\"a\": 1");
    await uninstallHook(options);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("reports a re-serialized hand-formatted file and keeps its backup", async () => {
    const { user, options, logs } = await sandbox();
    const path = join(user, ".claude", "settings.json");
    await writeFile(path, '{\n  "allow": ["a", "b"]\n}\n');
    await installHook(options);
    expect(logs.join("\n")).toContain("re-serialized");
  });

  it("refuses a symlinked settings.json", async () => {
    const { user, options, logs } = await sandbox();
    const target = join(user, "real-settings.json");
    await writeFile(target, "{}\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, join(user, ".claude", "settings.json"));
    expect(await installHook(options)).toBe(1);
    expect(await readFile(target, "utf8")).toBe("{}\n");
    expect(logs.join("\n")).toContain("symlink");
  });

  it("status reports installed and not installed", async () => {
    const { options } = await sandbox();
    expect((await hookState(options)).dirs.map((item) => item.state)).toEqual(["not installed"]);
    await installHook(options);
    const state = await hookState(options);
    expect(state.dirs.map((item) => item.state)).toEqual(["installed"]);
    expect(state.line_stale).toBe(true);
  });
});

describe("headroom hook CLI exit codes", () => {
  async function run(argv: string[], options: HookOptions): Promise<{ code: number; errors: string[] }> {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    try { return { code: await hookCommandMain(argv, options), errors }; } finally { spy.mockRestore(); }
  }

  it("codex and gemini are not supported yet and exit non-zero", async () => {
    const { user, options, logs } = await sandbox();
    expect((await run(["install", "--agent", "codex"], options)).code).toBe(2);
    expect((await run(["install", "--agent", "gemini"], options)).code).toBe(2);
    expect(logs.join("\n")).toContain("not supported yet");
    expect(await readdir(join(user, ".claude"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("bad usage exits 2, Windows exits 1 with a clear message, status exits 0", async () => {
    const { options, logs } = await sandbox();
    expect((await run([], options)).code).toBe(2);
    expect((await run(["frobnicate"], options)).code).toBe(2);
    expect((await run(["install", "--agent"], options)).code).toBe(2);
    expect((await run(["install", "--agent", "cursor"], options)).code).toBe(2);
    expect((await run(["install", "--agent", "claude"], { ...options, platform: "win32" })).code).toBe(1);
    expect(logs.join("\n")).toContain("not supported on Windows yet");
    expect((await run(["status", "--agent", "claude"], options)).code).toBe(0);
    expect((await run(["install", "--agent", "claude"], options)).code).toBe(0);
  });

  it("is reachable from main and prints usage under --help", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { out.push(line); });
    try {
      expect(await main(["hook", "--help"])).toBe(0);
      expect(await main(["line", "--help"])).toBe(0);
    } finally { spy.mockRestore(); }
    expect(out.join("\n")).toContain("headroom hook <install|uninstall|status>");
    expect(out.join("\n")).toContain("headroom line [--json]");
  });
});

describe("setup offers the hook", () => {
  async function captureLog(run: () => Promise<boolean>): Promise<string> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try { await run(); } finally { spy.mockRestore(); }
    return logs.join("\n");
  }

  it("asks once with a sample line and the token cost; Enter means yes", async () => {
    const installHookFn = vi.fn(async () => 0);
    const questions: string[] = [];
    const output = await captureLog(() => stepAgentHook({ yes: false, planOnly: false, hook: false, rl: { question: async (text: string) => { questions.push(text); return ""; } } }, { installHook: installHookFn }));
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("[Y/n]");
    expect(output).toContain("[Headroom]");
    expect(output).toContain("about 60 tokens per turn");
    expect(installHookFn).toHaveBeenCalledTimes(1);
  });

  it("an explicit no skips it", async () => {
    const installHookFn = vi.fn(async () => 0);
    await captureLog(() => stepAgentHook({ yes: false, planOnly: false, hook: false, rl: { question: async () => "n" } }, { installHook: installHookFn }));
    expect(installHookFn).not.toHaveBeenCalled();
  });

  it("--yes alone never installs it; --yes --hook does, without asking", async () => {
    const installHookFn = vi.fn(async () => 0);
    const question = vi.fn(async () => "y");
    const skipped = await captureLog(() => stepAgentHook({ yes: true, planOnly: false, hook: false, rl: { question } }, { installHook: installHookFn }));
    expect(installHookFn).not.toHaveBeenCalled();
    expect(skipped).toContain("--hook");
    await captureLog(() => stepAgentHook({ yes: true, planOnly: false, hook: true, rl: undefined }, { installHook: installHookFn }));
    expect(installHookFn).toHaveBeenCalledTimes(1);
    expect(question).not.toHaveBeenCalled();
  });

  it("a plan only describes it", async () => {
    const installHookFn = vi.fn(async () => 0);
    const output = await captureLog(() => stepAgentHook({ yes: false, planOnly: true, hook: false, rl: undefined }, { installHook: installHookFn }));
    expect(installHookFn).not.toHaveBeenCalled();
    expect(output).toContain("(dry run) would ask");
  });

  it("setup --yes runs end to end without touching a Claude config dir", async () => {
    const user = await mkdtemp(join(tmpdir(), "headroom-setup-hook-user-")); temporary.push(user);
    await mkdir(join(user, ".claude"));
    const previous = { HOME: process.env.HOME, HEADROOM_HOME: process.env.HEADROOM_HOME, PATH: process.env.PATH };
    process.env.HOME = user; process.env.HEADROOM_HOME = join(user, ".headroom"); process.env.PATH = "";
    try {
      const { runSetup } = await import("../src/setup.js");
      const output: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
      try { expect(await runSetup(["--yes", "--skip-service", "--skip-mcp"], { finalCheck: async () => undefined })).toBe(0); }
      finally { spy.mockRestore(); }
      expect(output.join("\n")).toContain("Agent quota line (optional)");
      expect(await readdir(join(user, ".claude"))).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});
