import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkModelAvailability: vi.fn() }));
vi.mock("../src/model-catalog.js", () => ({ checkModelAvailability: mocks.checkModelAvailability }));

import { HeadroomDaemon } from "../src/daemon.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.checkModelAvailability.mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

const accountsToml = [
  "[[accounts]]", 'name = "codex-parked"', "enabled = false", 'vendor = "codex"', 'location = "/fixture/codex-parked"', 'adapter = "native-ts"', "",
  "[[accounts]]", 'name = "codex-live"', 'vendor = "codex"', 'location = "/fixture/codex-live"', 'adapter = "native-ts"', "",
].join("\n");

describe("daemon model catalog caller", () => {
  it("passes only enabled principals to the catalog boundary after a poll", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-daemon-model-catalog-"));
    temporary.push(home);
    await writeFile(join(home, "accounts.toml"), accountsToml, { mode: 0o600 });
    mocks.checkModelAvailability.mockResolvedValue(undefined);
    await withHome(home, async () => {
      const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
      const internal = daemon as unknown as { poll(principal: string | undefined, forced: boolean): Promise<unknown> };
      try {
        await internal.poll(undefined, true);
        expect(mocks.checkModelAvailability).toHaveBeenCalledTimes(1);
        // The Antigravity catalog opt-in follows policy.toml, which is absent here: off.
        expect(mocks.checkModelAvailability).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ name: "codex-live" })], { antigravityModelCatalog: false });
      } finally { await daemon.stop(); }
    });
  });
});
