import { describe, expect, it } from "vitest";
import { nativePlatformAssetName, platformAssetName, readEngineLock } from "../src/engine/codexbar/install.js";

describe("engine asset selection", () => {
  it("uses release asset names that match CodexBar's platform convention", () => {
    expect(platformAssetName("v0.56.4", "darwin", "arm64")).toBe("CodexBarCLI-v0.56.4-macos-arm64.tar.gz");
    expect(platformAssetName("v0.56.4", "darwin", "x64")).toBe("CodexBarCLI-v0.56.4-macos-x86_64.tar.gz");
  });

  it("keeps Headroom native release assets explicitly unpinned until release signing is decided", async () => {
    const lock = await readEngineLock();
    expect(nativePlatformAssetName(lock, "darwin", "arm64")).toEqual({ name: "headroom-engine-0.1.0-macos-arm64.tar.gz", sha256: null, unpinned: true });
    expect(nativePlatformAssetName(lock, "linux", "arm64")).toEqual({ name: "headroom-engine-0.1.0-linux-aarch64.tar.gz", sha256: null, unpinned: true });
  });
});
