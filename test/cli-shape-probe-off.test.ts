import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ claudeResponseShape: vi.fn() }));
vi.mock("../src/adapters/claude.js", async (original) => ({ ...await original<typeof import("../src/adapters/claude.js")>(), claudeResponseShape: probe.claudeResponseShape }));
const { runCli } = await import("../src/cli.js");

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); probe.claudeResponseShape.mockReset(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("--shape refuses a Claude principal while claude_probe is off and never reaches the probe", async () => {
  const home = await mkdtemp(join(tmpdir(), "headroom-shape-off-")); temporary.push(home);
  await writeFile(join(home, "accounts.toml"), '[[accounts]]\nname = "claude-main"\nvendor = "claude"\nlocation = "/fixture/.claude"\nadapter = "native-ts"\n', { mode: 0o600 });
  const errors: string[] = []; vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(String(line)); });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("network must not be called"); });
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
  try {
    expect(await runCli(["--principal", "claude-main", "--shape"])).not.toBe(0);
    await writeFile(join(home, "policy.toml"), "claude_probe = false\n", { mode: 0o600 });
    expect(await runCli(["--principal", "claude-main", "--shape"])).not.toBe(0);
  } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  expect(probe.claudeResponseShape).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(errors.join("\n")).toContain("claude_probe = true");
});
