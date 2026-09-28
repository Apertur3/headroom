import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountsPath, accountsToml, discoverAccounts, readAccounts, setAccountEnabled, writeDiscoveredAccounts } from "../src/registry.js";

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

  it("does not overwrite a discovered entry's disabled flag, but does refresh its location", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-discovery-disabled-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      await writeFile(accountsPath(), ['[[accounts]]', 'name = "claude-main"', 'enabled = false', 'vendor = "claude"', 'location = "~/.claude"', 'adapter = "native-ts"', ''].join("\n"));
      await writeDiscoveredAccounts([{ name: "claude-main", vendor: "claude", location: "/replacement/.claude", adapter: "native-ts" }]);
      // enabled: false survives rediscovery, but location is replaced with
      // whatever the fresh scan found -- a suffix-only match (`/\.claude$/`)
      // would pass even if the stale "~/.claude" location had leaked through,
      // so this asserts the exact discovered path.
      await expect(readAccounts()).resolves.toEqual([expect.objectContaining({ name: "claude-main", enabled: false, location: "/replacement/.claude" })]);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

  it("drops a provider account rediscovery no longer finds, and keeps local accounts untouched", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-discovery-drop-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      await writeFile(accountsPath(), ['[[accounts]]', 'name = "claude-main"', 'vendor = "claude"', 'location = "~/.claude"', 'adapter = "native-ts"', '', '[[accounts]]', 'name = "codex-main"', 'vendor = "codex"', 'location = "~/.codex"', 'adapter = "native-ts"', '', '[[accounts]]', 'name = "local-vllm"', 'kind = "local"', 'base_url = "http://localhost:8000"', 'adapter = "native"', ''].join("\n"));
      // Rediscovery only finds claude-main this time -- codex-main's config
      // dir is gone. It must be dropped, not remain forever polled; the
      // manually configured local account is untouched either way.
      await writeDiscoveredAccounts([{ name: "claude-main", vendor: "claude", location: "~/.claude", adapter: "native-ts" }]);
      const accounts = await readAccounts();
      expect(accounts.find((account) => account.name === "codex-main")).toBeUndefined();
      expect(accounts.find((account) => account.name === "claude-main")).toBeDefined();
      expect(accounts.find((account) => account.name === "local-vllm")).toMatchObject({ kind: "local", base_url: "http://localhost:8000" });
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});

describe("accounts.toml writes: atomic, 0600, symlink-safe", () => {
  let root = "";
  afterEach(async () => { if (root) { await chmod(root, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); } });

  const source = ['[[accounts]]', 'name = "claude-main"', 'vendor = "claude"', 'location = "~/.claude"', 'adapter = "native-ts"', ''].join("\n");

  it.skipIf(process.platform === "win32")("corrects a pre-existing permissive mode instead of leaving it untouched", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-mode-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      await writeFile(accountsPath(), source, { mode: 0o644 }); // simulates an older Headroom's, or an operator's own, permissive file
      expect((await stat(accountsPath())).mode & 0o777).toBe(0o644);
      await setAccountEnabled("claude-main", false);
      expect((await stat(accountsPath())).mode & 0o777).toBe(0o600);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked accounts.toml and never writes through it", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-symlink-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      const realTarget = join(root, "elsewhere.toml");
      // Valid accounts.toml content (rather than an arbitrary fixture
      // string): both setAccountEnabled's line-based lookup and
      // writeDiscoveredAccounts's full readAccounts() parse must find and
      // process the entry successfully before ever reaching the write --
      // the refusal below has to come from the symlink check, not an
      // unrelated read/parse failure.
      const targetContent = source;
      await writeFile(realTarget, targetContent);
      await symlink(realTarget, accountsPath());
      await expect(setAccountEnabled("claude-main", false)).rejects.toThrow(/symlink/);
      // The link target's content must never have been written through.
      expect(await readFile(realTarget, "utf8")).toBe(targetContent);
      await expect(writeDiscoveredAccounts([{ name: "claude-main", vendor: "claude", location: "~/.claude", adapter: "native-ts" }])).rejects.toThrow(/symlink/);
      expect(await readFile(realTarget, "utf8")).toBe(targetContent);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

  it.skipIf(process.platform === "win32")("leaves the original file byte-for-byte intact when the write is interrupted before rename", async () => {
    root = await mkdtemp(join(tmpdir(), "headroom-registry-interrupted-"));
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    try {
      await writeFile(accountsPath(), source, { mode: 0o600 });
      // Read-only, executable directory: setAccountEnabled can still read the
      // existing file, but writeFileAtomic's temp file can no longer be
      // created there, so the failure lands before anything about the
      // original file's own content or mode is ever touched -- never mid
      // truncate, since the atomic writer only ever replaces the file with
      // rename() once a complete replacement already exists on disk.
      await chmod(root, 0o500);
      await expect(setAccountEnabled("claude-main", false)).rejects.toThrow();
      await chmod(root, 0o700);
      expect(await readFile(accountsPath(), "utf8")).toBe(source);
      expect((await stat(accountsPath())).mode & 0o777).toBe(0o600);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
