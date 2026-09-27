import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
  try { return await run(); } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("disabled meter decisions", () => {
  it("fails closed by principal name for explicit meter commands, and can/route classes", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', 'enabled = false', 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ''].join("\n"), { mode: 0o600 });
    await writeFile(join(home, "routing.toml"), ['[consumes]', 'parked = ["claude-2:all"]', ''].join("\n"), { mode: 0o600 });
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    try {
      await withHome(home, async () => {
        const calls = [
          ["history", "claude-2:all"], ["rate", "--meter", "claude-2:all"], ["plan", "--meter", "claude-2:all", "--until", "reset"],
          ["gate", "--meter", "claude-2:all", "--need", "5h:1", "--owner", "test"], ["wait", "--meter", "claude-2:all", "--until-reset"],
          ["fill", "--meter", "claude-2:all", "--until-reset", "--owner", "test"], ["lease", "start", "--meter", "claude-2:all", "--owner", "test"],
          ["run", "--meter", "claude-2:all", "--need", "5h:1", "--owner", "test", "--", "true"], ["can", "parked", "--owner", "test"], ["route", "--class", "parked", "--owner", "test"],
        ];
        for (const argv of calls) expect(await main(argv)).toBe(2);
      });
    } finally { log.mockRestore(); }
    const text = output.join("\n");
    expect(text).toContain("principal claude-2 is disabled (enabled = false in accounts.toml)");
    expect(text).not.toContain("YES claude-2");
  });

  it("omits historical disabled observations from status JSON and names the principal separately", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-status-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', 'enabled = false', 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ''].join("\n"), { mode: 0o600 });
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    try {
      await withHome(home, async () => { expect(await main(["status", "--json"])).toBe(0); });
    } finally { log.mockRestore(); }
    const result = JSON.parse(output[0]) as { observations: Array<{ principal_id: string }>; disabled_principals: string[] };
    expect(result.disabled_principals).toEqual(["claude-2"]);
    expect(result.observations).not.toEqual(expect.arrayContaining([expect.objectContaining({ principal_id: "claude-2" })]));
  });
});
