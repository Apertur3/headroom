import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installNativeEngine, nativePlatformAssetName, platformAssetName, readEngineLock, verifiedEnginePath } from "../src/engine/codexbar/install.js";
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
    await expect(installNativeEngine()).resolves.toEqual({ installed: false, hint: "Native engine is unpinned; build locally with npm run engine:build." });
  });
});

describe("verifiedEnginePath re-verifies the cached engine on every call", () => {
  async function stageCachedEngine(home: string): Promise<{ binary: string }> {
    const lock = await readEngineLock();
    const wanted = platformAssetName(lock.tag);
    const locked = lock.assets[wanted];
    if (!locked?.sha256) throw new Error("test fixture assumes a pinned asset for this platform");
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
    const root = await mkdtemp(join(tmpdir(), "headroom-verified-engine-ok-")); temporary.push(root);
    const { binary } = await stageCachedEngine(root);
    const canonical = await import("node:fs/promises").then((fs) => fs.realpath(binary));
    await withHeadroomHome(root, async () => { await expect(verifiedEnginePath()).resolves.toBe(canonical); });
  });

  it("refuses a cached binary another local user (or this one) made group/world writable, even though its hash still matches the marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-verified-engine-writable-")); temporary.push(root);
    const { binary } = await stageCachedEngine(root);
    await chmod(binary, 0o777);
    await withHeadroomHome(root, async () => { await expect(verifiedEnginePath()).rejects.toThrow(/group or world writable/); });
  });

  it("refuses a cached binary whose bytes changed after verification, never trusting the marker's recorded hash alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-verified-engine-tampered-")); temporary.push(root);
    const { binary } = await stageCachedEngine(root);
    await writeFile(binary, "#!/bin/sh\necho tampered\n", { mode: 0o700 });
    await withHeadroomHome(root, async () => { await expect(verifiedEnginePath()).rejects.toThrow(/changed after verification/); });
  });

  it("never trusts a native engine marker whose asset.sha256 is null, even if a tampered marker matches it exactly", async () => {
    // The native section's release assets are committed unpinned
    // (sha256: null, status: "unpinned"); a marker crafted to match that
    // null sha256 must never be treated as a verified install.
    const root = await mkdtemp(join(tmpdir(), "headroom-native-unpinned-marker-")); temporary.push(root);
    const lock = await readEngineLock();
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
