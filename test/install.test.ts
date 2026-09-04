import { describe, expect, it } from "vitest";
import { installNativeEngine, nativePlatformAssetName, platformAssetName, readEngineLock } from "../src/engine/codexbar/install.js";

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
