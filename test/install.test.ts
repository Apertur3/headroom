import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installNativeEngine, nativePlatformAssetName, platformAssetName, readEngineLock, verifiedEnginePath, type EngineLock } from "../src/engine/codexbar/install.js";
import { nativeEnginePath } from "../src/engine/native/run.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("engine asset selection", () => {
  it("uses release asset names that match CodexBar's platform convention", () => {
    expect(platformAssetName("v0.56.4", "darwin", "arm64")).toBe("CodexBarCLI-v0.56.4-macos-arm64.tar.gz");
    expect(platformAssetName("v0.56.4", "darwin", "x64")).toBe("CodexBarCLI-v0.56.4-macos-x86_64.tar.gz");
  });

  it("keeps Headroom native release assets explicitly unpinned until release signing is decided", async () => {
    const lock = await readEngineLock();
    expect(nativePlatformAssetName(lock, "darwin", "arm64")).toMatchObject({ name: "headroom-engine-0.1.0-macos-arm64.tar.gz", sha256: null, status: "unpinned" });
    expect(nativePlatformAssetName(lock, "linux", "arm64")).toMatchObject({ name: "headroom-engine-0.1.0-linux-aarch64.tar.gz", sha256: null, status: "unpinned" });
    // The comment field explains why: unpinned assets are never downloaded or executed.
    expect(nativePlatformAssetName(lock, "darwin", "arm64").comment).toMatch(/never (be )?downloaded or executed/);
  });

  it("refuses to install a native engine release asset whose lock entry is status: unpinned", async () => {
    // engine.lock.json's committed native section has no pinned platform yet;
    // installNativeEngine() must refuse before ever fetching release bytes.
    const expected = process.platform === "win32"
      // The native (Swift/CodexBarCore) engine has no release target for
      // Windows at all (macOS and Linux only); installNativeEngine() reports
      // that explicitly instead of throwing, the same graceful shape as the
      // "still unpinned" case below.
      ? { installed: false, hint: "Native engine has no release asset for this platform; build locally with npm run engine:build." }
      : { installed: false, hint: "Native engine is unpinned; build locally with npm run engine:build." };
    await expect(installNativeEngine()).resolves.toEqual(expected);
  });
});

describe("verifiedEnginePath re-verifies the cached engine on every call", () => {
  const HEADROOM_ENGINE_LOCK = "HEADROOM_ENGINE_LOCK";

  /**
   * CodexBarCLI (the optional external engine binary these tests cache and
   * re-verify) ships for macOS and Linux only -- there is no Windows release
   * at all, so platformAssetName() has no naming convention to fabricate a
   * pin for. There is nothing for these tests to exercise on that platform.
   */
  function skipOnUnsupportedPlatform(name: string): boolean {
    if (process.platform !== "win32") return false;
    process.stderr.write(`SKIP ${name}: CodexBarCLI has no Windows release asset to pin\n`);
    return true;
  }

  /**
   * verifiedEnginePath() always reads engine.lock.json's own, committed pin
   * for the platform it runs on -- and only macOS arm64's CodexBarCLI asset
   * is actually pinned there today (see engine.lock.json). These tests
   * exercise the cache re-verification logic itself, not which platforms
   * happen to be pinned yet, so they point HEADROOM_ENGINE_LOCK at a
   * throwaway lock file with a fabricated pin for whatever (supported)
   * platform is actually running the suite.
   */
  async function withSyntheticLock<T>(home: string, run: (lock: EngineLock) => Promise<T>): Promise<T> {
    const tag = "v0.0.0-test";
    const wanted = platformAssetName(tag);
    const lock: EngineLock = {
      tag,
      repository: "example/example",
      releaseAssets: [wanted],
      assets: { [wanted]: { name: wanted, sha256: "f".repeat(64), url: `https://example.invalid/${wanted}` } },
    };
    const lockFile = join(home, "engine.lock.test.json");
    await writeFile(lockFile, JSON.stringify(lock), { mode: 0o600 });
    const previous = process.env[HEADROOM_ENGINE_LOCK];
    process.env[HEADROOM_ENGINE_LOCK] = lockFile;
    try { return await run(lock); }
    finally { if (previous === undefined) delete process.env[HEADROOM_ENGINE_LOCK]; else process.env[HEADROOM_ENGINE_LOCK] = previous; }
  }

  async function stageCachedEngine(home: string, lock: EngineLock): Promise<{ binary: string }> {
    const wanted = platformAssetName(lock.tag);
    const locked = lock.assets[wanted];
    const root = join(home, "engine", lock.tag);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const binary = join(root, "codexbar");
    await writeFile(binary, "#!/bin/sh\necho fake\n", { mode: 0o700 });
    const binarySha256 = createHash("sha256").update(await import("node:fs/promises").then((fs) => fs.readFile(binary))).digest("hex");
    await writeFile(join(root, ".headroom-engine.json"), JSON.stringify({ tag: lock.tag, asset: wanted, sha256: locked.sha256, binarySha256 }), { mode: 0o600 });
    return { binary };
  }

  async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try { return await run(); }
    finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  }

  it("accepts a correctly owned, non-writable-by-others cached binary that matches its marker", async () => {
    if (skipOnUnsupportedPlatform("accepts a correctly owned cached binary")) return;
    const root = await mkdtemp(join(tmpdir(), "headroom-verified-engine-ok-")); temporary.push(root);
    await withSyntheticLock(root, async (lock) => {
      const { binary } = await stageCachedEngine(root, lock);
      const canonical = await import("node:fs/promises").then((fs) => fs.realpath(binary));
      await withHeadroomHome(root, async () => { await expect(verifiedEnginePath()).resolves.toBe(canonical); });
    });
  });

  it("refuses a cached binary another local user (or this one) made group/world writable, even though its hash still matches the marker", async () => {
    if (skipOnUnsupportedPlatform("refuses a group/world writable cached binary")) return;
    const root = await mkdtemp(join(tmpdir(), "headroom-verified-engine-writable-")); temporary.push(root);
    await withSyntheticLock(root, async (lock) => {
      const { binary } = await stageCachedEngine(root, lock);
      await chmod(binary, 0o777);
      await withHeadroomHome(root, async () => { await expect(verifiedEnginePath()).rejects.toThrow(/group or world writable/); });
    });
  });

  it("refuses a cached binary whose bytes changed after verification, never trusting the marker's recorded hash alone", async () => {
    if (skipOnUnsupportedPlatform("refuses a tampered cached binary")) return;
    const root = await mkdtemp(join(tmpdir(), "headroom-verified-engine-tampered-")); temporary.push(root);
    await withSyntheticLock(root, async (lock) => {
      const { binary } = await stageCachedEngine(root, lock);
      await writeFile(binary, "#!/bin/sh\necho tampered\n", { mode: 0o700 });
      await withHeadroomHome(root, async () => { await expect(verifiedEnginePath()).rejects.toThrow(/changed after verification/); });
    });
  });

  it("never trusts a native engine marker whose asset.sha256 is null, even if a tampered marker matches it exactly", async () => {
    // The native section's release assets are committed unpinned
    // (sha256: null, status: "unpinned"); a marker crafted to match that
    // null sha256 must never be treated as a verified install.
    const lock = await readEngineLock();
    if (process.platform === "win32") {
      // The native engine has no release target for Windows at all yet --
      // nativePlatformAssetName() refuses before any marker is even
      // consulted, so there is nothing to plant a marker for.
      expect(() => nativePlatformAssetName(lock)).toThrow(/No CodexBarCLI release asset/);
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "headroom-native-unpinned-marker-")); temporary.push(root);
    const asset = nativePlatformAssetName(lock);
    expect(asset.sha256).toBeNull();
    const binaryName = lock.native!.binary;
    const nativeRoot = join(root, "engine", "native");
    await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
    const binary = join(nativeRoot, binaryName);
    await writeFile(binary, "#!/bin/sh\necho planted\n", { mode: 0o700 });
    const binarySha256 = createHash("sha256").update(await import("node:fs/promises").then((fs) => fs.readFile(binary))).digest("hex");
    await writeFile(join(nativeRoot, ".headroom-native-engine.json"), JSON.stringify({ tag: lock.native!.tag, asset: asset.name, sha256: null, binarySha256 }), { mode: 0o600 });
    await withHeadroomHome(root, async () => {
      const result = await nativeEnginePath();
      expect(result).not.toBe(binary);
    });
  });
});
