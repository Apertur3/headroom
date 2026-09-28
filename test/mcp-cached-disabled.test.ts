import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheCan, cacheRate } from "../src/mcp.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function seed(home: string): Promise<void> {
  await writeFile(join(home, "routing.toml"), ['local_preference = "prefer"', "[consumes]", 'review = ["codex-live:main"]', ""].join("\n"), { mode: 0o600 });
  await writeFile(join(home, "accounts.toml"), [
    "[[accounts]]", 'name = "codex-live"', 'vendor = "codex"', 'location = "/fixture/codex-live"', 'adapter = "native-ts"', "",
    "[[accounts]]", 'name = "codex-parked"', "enabled = false", 'vendor = "codex"', 'location = "/fixture/codex-parked"', 'adapter = "native-ts"', "",
    "[[accounts]]", 'name = "local-parked"', "enabled = false", 'kind = "local"', 'base_url = "http://pool.invalid"', 'adapter = "native"', "",
  ].join("\n"), { mode: 0o600 });
  const now = new Date();
  const store = await HeadroomStore.open(home);
  try {
    for (const principal of ["codex-live", "codex-parked"]) {
      store.insert({
        principal_id: principal, meter_id: `${principal}:main`, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
        quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(now.getTime() + 3_600_000).toISOString(), observed_at: now.toISOString(), fetched_at: now.toISOString(),
        source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
      });
    }
    store.insert({
      principal_id: "local-parked", meter_id: "local-parked:capacity", window: { kind: "state", minutes: null, enforcement: "soft" },
      quantity: { used: 0, limit: null, remaining: null, unit: "requests" }, resets_at: null, observed_at: now.toISOString(), fetched_at: now.toISOString(),
      source: "fixture", truth: "estimated", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
      metadata: { state: "UP", model_ids: [], running: 0, waiting: 0, cost_model: "marginal" },
    });
  } finally { store.close(); }
}

describe("MCP cached disabled-principal boundary", () => {
  it("does not route to a disabled local pool and returns the documented disabled rate line", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-mcp-cached-disabled-"));
    temporary.push(home);
    await seed(home);
    await withHome(home, async () => {
      const can = await cacheCan("review", false, "tester", null) as { source: string; daemon: string; decision: { meter: string } };
      expect(can).toMatchObject({ source: "cache", daemon: "unresponsive", decision: { meter: "codex-live:main" } });
      expect(can.decision.meter).not.toBe("local-parked:capacity");

      const rate = await cacheRate("codex-parked:main", 30, undefined, undefined) as { source: string; daemon: string; lines: Array<{ meter: string; reason?: string }> };
      expect(rate).toMatchObject({
        source: "cache", daemon: "unresponsive",
        lines: [expect.objectContaining({ meter: "codex-parked:main", reason: expect.stringContaining("disabled") })],
      });
    });
  });
});
