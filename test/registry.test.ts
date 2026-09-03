import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountsToml, discoverAccounts } from "../src/registry.js";

describe("account discovery", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it("finds Codex and Claude homes for the native engine", async () => {
    root = await mkdtemp(join(tmpdir(), "tally-registry-"));
    await Promise.all([mkdir(join(root, ".codex")), mkdir(join(root, ".codex-work")), mkdir(join(root, ".claude"))]);
    const accounts = await discoverAccounts(root);
    expect(accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "codex-main", vendor: "codex", adapter: "native" }),
      expect.objectContaining({ name: "claude-main", vendor: "claude", adapter: "native" }),
    ]));
    expect(accountsToml(accounts)).toContain('adapter = "native"');
  });
});
