import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { installEngine, installNativeEngine } from "../src/engine/codexbar/install.js";

vi.mock("../src/engine/native/run.js", async (original) => ({
  ...await original<typeof import("../src/engine/native/run.js")>(),
  nativeEnginePath: vi.fn(async () => "/fixture/bin/engine/darwin/headroom-engine"),
}));
vi.mock("../src/engine/codexbar/install.js", async (original) => ({
  ...await original<typeof import("../src/engine/codexbar/install.js")>(),
  installEngine: vi.fn(async () => ({ firstPin: false, tag: "fixture", path: "/fixture/codexbar", sha256: "f".repeat(64) })),
  installNativeEngine: vi.fn(),
}));
let root = "";
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["codexbar", "native-ts"])("preserves optional upstream installation for adapter %s", async (adapter) => {
  root = await mkdtemp(join(tmpdir(), "headroom-engine-install-command-"));
  vi.stubEnv("HEADROOM_HOME", root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await writeFile(join(root, "accounts.toml"), `[[accounts]]\nname = "codex-main"\nvendor = "codex"\nlocation = "unused"\nadapter = "${adapter}"\n`, { mode: 0o600 });
  expect(await main(["engine", "install"])).toBe(0);
  expect(installNativeEngine).not.toHaveBeenCalled();
  expect(installEngine).toHaveBeenCalledTimes(adapter === "codexbar" ? 1 : 0);
});
