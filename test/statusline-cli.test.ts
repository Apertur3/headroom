import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function withConfigDir<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = value;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
}

/** main(["statusline", ...]) reads real stdin via readStdinText()'s
 * event-listener promise; by the time the call expression returns, that
 * promise's executor has already run synchronously and attached its
 * listeners (the same pattern test/daemon-mcp.test.ts uses for serveMcp()'s
 * own stdin loop), so emitting right after starting the call is safe. */
async function runStatusline(argv: string[], stdin: string): Promise<{ code: number; stdout: string[] }> {
  const stdout: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(line); });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  try {
    const promise = main(["statusline", ...argv]);
    process.stdin.emit("data", stdin);
    process.stdin.emit("end");
    const code = await promise;
    return { code, stdout };
  } finally { logSpy.mockRestore(); writeSpy.mockRestore(); }
}

describe("headroom statusline", () => {
  it("writes <HEADROOM_HOME>/statusline/default.json (0600) and prints the compact bar, for the default profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-cli-")); temporary.push(root);
    const home = join(root, ".headroom");
    const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 37, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 17, resets_at: Math.floor(Date.now() / 1000) + 86_400 } } });
    await withHeadroomHome(home, () => withConfigDir(undefined, async () => {
      const { code, stdout } = await runStatusline([], payload);
      expect(code).toBe(0);
      expect(stdout.join("\n")).toMatch(/5h 37% ↻.*\| wk 17% ↻/);
      const written = JSON.parse(await readFile(join(home, "statusline", "default.json"), "utf8"));
      expect(written.five_hour.used_percent).toBe(37);
      const stat = await lstat(join(home, "statusline", "default.json"));
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    }));
  });

  it("names the snapshot after CLAUDE_CONFIG_DIR's basename for a non-default profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-cli-profile-")); temporary.push(root);
    const home = join(root, ".headroom");
    const configDir = join(root, ".claude2");
    const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: null }, seven_day: { used_percentage: 6, resets_at: null } } });
    await withHeadroomHome(home, () => withConfigDir(configDir, async () => {
      const { code } = await runStatusline([], payload);
      expect(code).toBe(0);
      const written = JSON.parse(await readFile(join(home, "statusline", ".claude2.json"), "utf8"));
      expect(written.five_hour.used_percent).toBe(5);
    }));
  });

  it("prints a bar even for empty or garbage stdin, and exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-cli-garbage-")); temporary.push(root);
    const home = join(root, ".headroom");
    await withHeadroomHome(home, async () => {
      const { code, stdout } = await runStatusline([], "not json at all");
      expect(code).toBe(0);
      expect(stdout.join("\n")).toContain("no rate limit data");
    });
  });

  it("--chain runs the given command with the same stdin and prints its output instead", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-cli-chain-")); temporary.push(root);
    const home = join(root, ".headroom");
    const echoScript = join(root, "echo-stdin.mjs");
    await writeFile(echoScript, [
      "let data = \"\";",
      "process.stdin.setEncoding(\"utf8\");",
      "process.stdin.on(\"data\", (chunk) => { data += chunk; });",
      "process.stdin.on(\"end\", () => process.stdout.write(`CHAINED:${data.length}`));",
    ].join("\n"));
    const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: null } } });
    await withHeadroomHome(home, async () => {
      const { code, stdout } = await runStatusline(["--chain", process.execPath, echoScript], payload);
      expect(code).toBe(0);
      expect(stdout.join("")).toBe(`CHAINED:${payload.length}`);
    });
  });
});
