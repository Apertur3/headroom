import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomDaemon, socketPath } from "../src/daemon.js";
import { doctorChecks } from "../src/doctor.js";
import { useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

// Somebody else's Antigravity server (the IDE's language_server) is reachable,
// so discovery suppresses Headroom's own keepalive.
const external = vi.hoisted(() => ({ pids: [] as number[] }));
vi.mock("../src/antigravity-discovery.js", async (original) => ({
  ...await original<typeof import("../src/antigravity-discovery.js")>(),
  externalAntigravityServerPids: async () => external.pids,
}));

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => {
  external.pids = [];
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function keepaliveCheck(pids: number[]): Promise<{ level: string; detail: string; fix: string } | undefined> {
  const root = await mkdtemp(join(tmpdir(), "headroom-doctor-agy-ext-")); temporary.push(root);
  const fakeAgy = await writeFakeAgy(root, join(root, "agy-pid.txt"));
  await writeFile(join(root, "accounts.toml"), ["[[accounts]]", 'name = "antigravity"', "enabled = true", 'vendor = "antigravity"', 'location = "agy"', 'adapter = "native-ts"', `agy_path = "${fakeAgy}"`, ""].join("\n"), { mode: 0o600 });
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
  external.pids = pids;
  const daemon = await HeadroomDaemon.create({ home: root, path: socketPath(root), poller: async () => ({ observations: [], failures: [] }) });
  try {
    try { await daemon.start(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); return undefined; }
      throw error;
    }
    return (await doctorChecks()).find((item) => item.check === "Antigravity keepalive");
  } finally {
    await daemon.stop();
    if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
  }
}

describe.skipIf(process.platform === "win32")("doctor: Antigravity keepalive with an external server", () => {
  it("reports OK, not a WARN, when the running Antigravity app serves the reads", async () => {
    const check = await keepaliveCheck([4_000_000]);
    if (!check) return; // sandbox forbids AF_UNIX listen(2)
    expect(check).toMatchObject({ level: "OK", detail: "reads served by the running Antigravity app; keepalive not needed" });
    expect(check.detail).not.toContain("is not running");
  }, 30_000);
});
