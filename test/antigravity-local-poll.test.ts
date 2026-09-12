import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pollAccounts } from "../src/collector.js";
import { nativeEnginePath, runNativeEngine } from "../src/engine/native/run.js";

vi.mock("../src/engine/native/run.js", () => ({ nativeEnginePath: vi.fn(), runNativeEngine: vi.fn() }));
let root = "";
const previousHome = process.env.HEADROOM_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it("keeps every Antigravity window UNKNOWN when its reader is missing, even during remote backoff", async () => {
  root = await mkdtemp(join(tmpdir(), "headroom-agy-local-"));
  await writeFile(join(root, "accounts.toml"), '[[accounts]]\nname = "antigravity"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n', { mode: 0o600 });
  process.env.HEADROOM_HOME = root;
  vi.mocked(nativeEnginePath).mockResolvedValue(undefined);
  const network = vi.spyOn(globalThis, "fetch");
  for (const skipRemoteAntigravity of [false, true]) {
    const result = await pollAccounts(undefined, { daemonOwnsAntigravity: true, skipRemoteAntigravity, antigravityLoginState: "logged_in" });
    expect(result.observations).toHaveLength(4);
    expect(result.observations.every((row) => row.freshness === "failed" && row.quantity === null)).toBe(true);
    expect(result.observations[0].reason).toContain(process.platform !== "darwin" ? "not available on this platform" : "native reader missing");
    expect(result.antigravityLocal?.antigravity.outcome).toBe("failed");
  }
  expect(network).not.toHaveBeenCalled();
  expect(runNativeEngine).not.toHaveBeenCalled();
});
