import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Observation, ProviderAccount } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  checkModelAvailability: vi.fn(),
  pollAccounts: vi.fn(),
  readAccounts: vi.fn(),
  daemonRequest: vi.fn(),
}));

vi.mock("../src/model-catalog.js", () => ({ checkModelAvailability: mocks.checkModelAvailability }));
vi.mock("../src/collector.js", () => ({ pollAccounts: mocks.pollAccounts }));
vi.mock("../src/registry.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/registry.js")>(), readAccounts: mocks.readAccounts }));
vi.mock("../src/daemon.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/daemon.js")>(), daemonRequest: mocks.daemonRequest }));

import { main } from "../src/cli.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.checkModelAvailability.mockReset();
  mocks.pollAccounts.mockReset();
  mocks.readAccounts.mockReset();
  mocks.daemonRequest.mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("direct status model catalog check", () => {
  it("prints quota output before waiting for an independent catalog-store lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-direct-catalog-"));
    temporary.push(root);
    const account: ProviderAccount = { name: "codex-main", vendor: "codex", location: join(root, ".codex"), adapter: "native-ts" };
    const at = "2026-09-23T12:00:00.000Z";
    const observation: Observation = {
      principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 10, remaining: 90, limit: 100, unit: "percent" }, resets_at: "2026-09-23T17:00:00.000Z",
      observed_at: at, fetched_at: at, source: "fixture", truth: "official", freshness: "fresh", confidence: 1,
      adapter_version: "fixture", upstream_schema_version: "fixture",
    };
    let release: (() => void) | undefined;
    mocks.daemonRequest.mockResolvedValue({ status: "unavailable" });
    mocks.readAccounts.mockResolvedValue([account]);
    mocks.pollAccounts.mockResolvedValue({ observations: [observation], failures: [], claudeProbeOutcomes: {} });
    mocks.checkModelAvailability.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    await withHeadroomHome(join(root, ".headroom"), async () => {
      const logs: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
      try {
        const running = main(["--json"]);
        await vi.waitFor(() => expect(mocks.checkModelAvailability).toHaveBeenCalledTimes(1));
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]).observations).toHaveLength(1);
        release?.();
        expect(await running).toBe(0);
      } finally { log.mockRestore(); }
    });
  });
});
