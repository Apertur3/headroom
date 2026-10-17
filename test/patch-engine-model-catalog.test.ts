/** Synthetic Swift source anchors and fake tools; no dependency fetch or live data. */
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { patchSource } from "../scripts/patch-engine-model-catalog.mjs";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const source = `
    public let modelQuotas: [AntigravityModelQuota]
        source: AntigravityModelQuotaSource = .remote)
        self.modelQuotas = modelQuotas
        source: AntigravityModelQuotaSource = .local)
    {
        self.modelQuotas = []
AntigravityStatusSnapshot(
                accountPlan: accountPlan,
                source: self.source)
AntigravityStatusSnapshot(
            modelQuotas: self.modelQuotas,
            accountEmail: accountEmail,
            accountPlan: accountPlan,
            source: self.source)
AntigravityStatusSnapshot(
            accountPlan: planName,
            source: .local)
AntigravityStatusSnapshot(modelQuotas: models, accountEmail: nil, accountPlan: nil, source: .local)
`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "headroom-patch-")); temporary.push(root);
  const checkout = join(root, "scratch", "checkouts", "codexbar");
  const dir = join(checkout, "Sources", "CodexBarCore", "Providers", "Antigravity");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "AntigravityStatusProbe.swift");
  await writeFile(file, source);
  // Other known construction paths intentionally have no full model list.
  await writeFile(join(dir, "AntigravityQuotaSummaryParser.swift"), "AntigravityStatusSnapshot(\n");
  await writeFile(join(dir, "AntigravityRemoteUsageFetcher.swift"), "AntigravityStatusSnapshot(\n");
  return { root, checkout, dir, file };
}
const script = resolve("scripts/patch-engine-model-catalog.mjs");

it("F6 patch rejects anchor drift and unexpected construction paths, including after patching", () => {
  expect(() => patchSource(source.replace("accountPlan: planName", "accountPlan: otherPlan"))).toThrow(/patch/i);
  expect(() => patchSource(source + "\nAntigravityStatusSnapshot(modelQuotas: [])")).toThrow(/construction|snapshot/i);
  const patched = patchSource(source);
  expect(patchSource(patched)).toBe(patched);
  expect(() => patchSource(patched + "\nAntigravityStatusSnapshot(modelQuotas: [])")).toThrow(/construction|snapshot/i);
});
it("F6 patch atomically replaces a read-only file and preserves its mode", async () => {
  const { root, checkout, dir, file } = await fixture();
  const originalLink = join(root, "original.swift");
  await chmod(file, 0o444); await link(file, originalLink);
  await exec(process.execPath, [script, checkout]);
  expect(await readFile(originalLink, "utf8")).toBe(source);
  expect(await readFile(file, "utf8")).toContain("modelCatalog: modelConfigs");
  expect((await stat(file)).mode & 0o777).toBe(0o444);
  expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  await exec(process.execPath, [script, checkout]);
});
it("F6 patch rejects a new snapshot construction in another source file before writing", async () => {
  const { checkout, dir, file } = await fixture();
  await writeFile(join(dir, "NewPath.swift"), "AntigravityStatusSnapshot(modelQuotas: [])");
  await expect(exec(process.execPath, [script, checkout])).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(source);
});
it("F6 preparation restores the dependency before resolving and stops on reset failure", async () => {
  const { root } = await fixture();
  const bin = join(root, "tools"); await mkdir(bin);
  const log = join(root, "calls");
  for (const tool of ["git", "swift", "node"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$PATCH_TEST_LOG"\nif [ '${tool}' = git ] && [ "$PATCH_TEST_FAIL_RESET" = 1 ]; then exit 7; fi\n`);
    await chmod(join(bin, tool), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PATCH_TEST_LOG: log, PATCH_TEST_FAIL_RESET: "0" };
  const prepare = resolve("scripts/prepare-engine.sh");
  await exec("bash", [prepare, join(root, "scratch")], { env });
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["git", "swift", "node"]);
  await writeFile(log, "");
  await expect(exec("bash", [prepare, join(root, "scratch")], { env: { ...env, PATCH_TEST_FAIL_RESET: "1" } })).rejects.toThrow();
  expect((await readFile(log, "utf8")).trim()).toBe("git");
});
