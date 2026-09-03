import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountsToml, discoverAccounts } from "../src/registry.js";

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
    expect(accountsToml([{ name: "gpu-box", kind: "local", base_url: "http://10.0.0.20:8000", adapter: "native" }])).toContain('adapter = "native"');
  });
});
