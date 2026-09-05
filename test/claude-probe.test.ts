import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProbeVerificationError, verifiedPackagedProbe } from "../src/adapters/claude.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function packagedProbe(root: string, contents = "#!/bin/sh\necho probe\n"): Promise<string> {
  const directory = join(root, "bin", "probe", "darwin");
  await mkdir(directory, { recursive: true });
  const binaryPath = join(directory, "headroom-claude-probe");
  await writeFile(binaryPath, contents, { mode: 0o755 });
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

describe("verifiedPackagedProbe", () => {
  it("returns undefined -- not an error -- when bin/probe/darwin does not exist at all (a source checkout before packing)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-absent-")); temporary.push(root);
    await expect(verifiedPackagedProbe(root)).resolves.toBeUndefined();
  });

  it("resolves the binary when its SHA-256 matches the recorded file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-ok-")); temporary.push(root);
    const binaryPath = await packagedProbe(root);
    const hash = createHash("sha256").update(await readFile(binaryPath)).digest("hex");
    await writeFile(join(root, "bin", "probe", "darwin", "SHA256"), `${hash}\n`);
    await expect(verifiedPackagedProbe(root)).resolves.toBe(await realpath(binaryPath));
  });

  it("accepts the common `sha256sum`-style record with a trailing filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-shafmt-")); temporary.push(root);
    const binaryPath = await packagedProbe(root);
    const hash = createHash("sha256").update(await readFile(binaryPath)).digest("hex");
    await writeFile(join(root, "bin", "probe", "darwin", "SHA256"), `${hash}  headroom-claude-probe\n`);
    await expect(verifiedPackagedProbe(root)).resolves.toBe(await realpath(binaryPath));
  });

  it("throws ProbeVerificationError, not a silent fallback, when the SHA-256 record is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-noshafile-")); temporary.push(root);
    await packagedProbe(root);
    await expect(verifiedPackagedProbe(root)).rejects.toBeInstanceOf(ProbeVerificationError);
    await expect(verifiedPackagedProbe(root)).rejects.toThrow(/SHA-256 record missing/);
  });

  it("throws ProbeVerificationError when the recorded hash does not match the binary (tampered or corrupted)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-mismatch-")); temporary.push(root);
    await packagedProbe(root);
    await writeFile(join(root, "bin", "probe", "darwin", "SHA256"), `${"0".repeat(64)}\n`);
    await expect(verifiedPackagedProbe(root)).rejects.toBeInstanceOf(ProbeVerificationError);
    await expect(verifiedPackagedProbe(root)).rejects.toThrow(/SHA-256 verification failed/);
  });

  it("throws ProbeVerificationError for an empty SHA-256 record, never treating it as a match", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-emptysha-")); temporary.push(root);
    await packagedProbe(root);
    await writeFile(join(root, "bin", "probe", "darwin", "SHA256"), "");
    await expect(verifiedPackagedProbe(root)).rejects.toBeInstanceOf(ProbeVerificationError);
  });
});
