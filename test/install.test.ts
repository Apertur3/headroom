import { describe, expect, it } from "vitest";
import { platformAssetName } from "../src/engine/codexbar/install.js";

describe("engine asset selection", () => {
  it("uses release asset names that match CodexBar's platform convention", () => {
    expect(platformAssetName("v0.56.4", "darwin", "arm64")).toBe("CodexBarCLI-v0.56.4-macos-arm64.tar.gz");
    expect(platformAssetName("v0.56.4", "darwin", "x64")).toBe("CodexBarCLI-v0.56.4-macos-x86_64.tar.gz");
  });
});
