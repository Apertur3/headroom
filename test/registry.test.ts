import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountsPath, accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "../src/registry.js";

describe("account discovery", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it("finds Codex and Claude homes for the native engine", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-"));
    await Promise.all([mkdir(join(root, ".codex")), mkdir(join(root, ".codex-work")), mkdir(join(root, ".claude"))]);
    const accounts = await discoverAccounts(root, { PATH: "" });
    expect(accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "codex-main", vendor: "codex", adapter: "native-ts" }),
      expect.objectContaining({ name: "claude-main", vendor: "claude", adapter: "native-ts" }),
    ]));
    expect(accountsToml(accounts)).toContain('adapter = "native-ts"');
  });

  it("discovers Antigravity from its Gemini installation and renders local rows", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-"));
    await mkdir(join(root, ".gemini"));
    await mkdir(join(root, ".gemini", "antigravity-cli"));
    const accounts = await discoverAccounts(root, { PATH: "" });
    expect(accounts).toContainEqual(expect.objectContaining({ name: "antigravity", vendor: "antigravity", adapter: "native-ts" }));
    expect(accountsToml([{ name: "gpu-box", kind: "local", base_url: "http://192.0.2.20:8000", adapter: "native" }])).toContain('adapter = "native"');
    expect(accountsToml([{ name: "antigravity", vendor: "antigravity", location: "agy", adapter: "native-ts", agy_path: "~/.local/bin/agy" }])).toContain('agy_path = "~/.local/bin/agy"');
  });
});

describe("disabled accounts", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("parses and serializes enabled = false while an absent value remains enabled", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-disabled-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      await writeFile(accountsPath(), ['[[accounts]]', 'name = "claude-2"', 'enabled = false', 'vendor = "claude"', 'location = "~/.claude2"', 'adapter = "native-ts"', '', '[[accounts]]', 'name = "codex-main"', 'vendor = "codex"', 'location = "~/.codex"', 'adapter = "native-ts"', ''].join("\n"));
      const accounts = await readAccounts();
      expect(accounts.find((account) => account.name === "claude-2")).toMatchObject({ enabled: false });
      expect(accounts.find((account) => account.name === "codex-main")?.enabled).toBeUndefined();
      expect(accountsToml(accounts)).toContain("enabled = false");
      expect(accountsToml(accounts)).not.toContain("enabled = true");
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

  it("does not overwrite a discovered entry's disabled flag", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-discovery-disabled-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      await writeFile(accountsPath(), ['[[accounts]]', 'name = "claude-main"', 'enabled = false', 'vendor = "claude"', 'location = "~/.claude"', 'adapter = "native-ts"', ''].join("\n"));
      await writeDiscoveredAccounts([{ name: "claude-main", vendor: "claude", location: "/replacement/.claude", adapter: "native-ts" }]);
      await expect(readAccounts()).resolves.toEqual([expect.objectContaining({ name: "claude-main", enabled: false, location: expect.stringMatching(/\.claude$/) })]);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
