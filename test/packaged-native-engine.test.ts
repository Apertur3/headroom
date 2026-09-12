import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeEngineVerificationError, verifiedPackagedNativeEngine } from "../src/engine/native/run.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const roots: string[] = [];
afterEach(async () => { vi.mocked(lstat).mockReset(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); vi.mocked(lstat).mockImplementation(actual.lstat); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "headroom-native-package-")); roots.push(root);
  const directory = join(root, "bin", "engine", "darwin");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const binary = join(directory, "headroom-engine");
  const digest = join(directory, "SHA256");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(binary, 0o755);
  await writeFile(digest, createHash("sha256").update(await readFile(binary)).digest("hex") + "\n");
  return { root, directory, binary, digest };
}

describe.skipIf(process.platform === "win32")("packaged native reader trust boundary", () => {
  it("accepts safely root-owned global package files", async () => {
    const { root, binary } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(lstat).mockImplementation((async (path: Parameters<typeof lstat>[0]) => {
      const info = await actual.lstat(path);
      info.uid = 0;
      return info;
    }) as typeof lstat);
    expect(await verifiedPackagedNativeEngine(root, "darwin")).toBe(await realpath(binary));
  });

  it("rechecks the package digest on every resolution and rejects changed bytes", async () => {
    const { root, binary } = await fixture();
    expect(await verifiedPackagedNativeEngine(root, "darwin")).toBe(await realpath(binary));
    await writeFile(binary, "#!/bin/sh\necho replaced\n", { mode: 0o755 });
    await expect(verifiedPackagedNativeEngine(root, "darwin")).rejects.toThrow(NativeEngineVerificationError);
  });

  it("refuses an incomplete packaged reader instead of treating it as absent", async () => {
    const { root, binary, digest } = await fixture();
    await rm(digest);
    await expect(verifiedPackagedNativeEngine(root, "darwin")).rejects.toThrow(/reinstall headroomd/);
    await rm(binary);
    await expect(verifiedPackagedNativeEngine(root, "darwin")).rejects.toThrow(NativeEngineVerificationError);
  });

  it("refuses symlinked binary and digest files even when their bytes match", async () => {
    for (const target of ["binary", "digest"] as const) {
      const files = await fixture();
      const outside = join(files.root, "outside");
      await writeFile(outside, await readFile(files[target]), { mode: 0o755 });
      await rm(files[target]);
      await symlink(outside, files[target]);
      await expect(verifiedPackagedNativeEngine(files.root, "darwin")).rejects.toThrow(NativeEngineVerificationError);
    }
  });

  it("rejects writable package directories and non-executable reader files", async () => {
    const { root, binary, directory } = await fixture();
    await chmod(directory, 0o777);
    await expect(verifiedPackagedNativeEngine(root, "darwin")).rejects.toThrow(NativeEngineVerificationError);
    await chmod(directory, 0o755);
    await chmod(binary, 0o644);
    await expect(verifiedPackagedNativeEngine(root, "darwin")).rejects.toThrow(NativeEngineVerificationError);
  });
});

it("does not select a Mach-O reader on Linux or Windows", async () => {
  const { root } = await fixture();
  expect(await verifiedPackagedNativeEngine(root, "linux")).toBeUndefined();
  expect(await verifiedPackagedNativeEngine(root, "win32")).toBeUndefined();
});
