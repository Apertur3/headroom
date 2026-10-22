import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "hooks", "quota-line.sh");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function sandbox(): Promise<{ user: string; home: string; config: string; bin: string; run: () => string }> {
  const user = await mkdtemp(join(tmpdir(), "headroom-plugin-"));
  temporary.push(user);
  const home = join(user, "quota");
  const config = join(user, "config");
  const bin = join(user, "bin");
  await Promise.all([home, config, bin].map((path) => mkdir(path)));
  // Only the hook's system utilities are available, regardless of installed CLIs.
  for (const command of ["date", "stat", "uname", "grep"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(found.status).toBe(0);
    await symlink(found.stdout.trim(), join(bin, command));
  }
  const run = (): string => {
    const result = spawnSync("/bin/sh", [script], {
      encoding: "utf8", env: { HOME: user, CLAUDE_CONFIG_DIR: config, HEADROOM_HOME: home, PATH: bin },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  };
  return { user, home, config, bin, run };
}

describe.skipIf(process.platform === "win32")("plugin quota line", () => {
  it("prints only the first cached line once, with its age", async () => {
    const { home, run } = await sandbox();
    await writeFile(join(home, "line.txt"), "Claude 5h 20% NORMAL\nignored second line\n");
    expect(run()).toMatch(/^Claude 5h 20% NORMAL \(as of \d+s ago\)\n$/);
  });

  it.each(["config", ".claude"])("defers to an installed hook in %s", async (dir) => {
    const { user, home, run } = await sandbox();
    await mkdir(join(user, dir), { recursive: true });
    await writeFile(join(user, dir, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "sh hooks/claude-line.sh" }] }] } }));
    await writeFile(join(home, "line.txt"), "Claude 5h 20% NORMAL\n");
    expect(run()).toBe("");
  });

  it("explains installation when both the cached line and headroom are absent", async () => {
    const { run } = await sandbox();
    expect(run()).toBe("[Headroom] plugin needs headroomd: npm install -g headroomd, then headroom setup (https://github.com/Apertur3/headroom#install)\n");
  });

  it("is silent before the daemon writes a line when headroom is installed", async () => {
    const { bin, run } = await sandbox();
    const executable = join(bin, "headroom");
    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    await chmod(executable, 0o755);
    expect(run()).toBe("");
  });
});

describe("plugin and registry versions", () => {
  it("keeps all published metadata in sync with the npm package", async () => {
    const [pkg, plugin, marketplace, server] = await Promise.all([
      "package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "server.json",
    ].map(async (path) => JSON.parse(await readFile(join(root, path), "utf8"))));
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.plugins[0].version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(pkg.mcpName).toBe(server.name);
  });
});
