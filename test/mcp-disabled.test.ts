import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("MCP disabled status", () => {
  it("omits a parked principal's stored rows and names it in quota_status", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-mcp-disabled-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', "enabled = false", 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    // Disabled principals are never polled at all (collector.ts's own
    // isAccountEnabled filter), so without a real stored row here this
    // assertion would pass whether or not the status filtering below
    // actually does anything -- seed one so the test exercises it.
    const seedStore = await HeadroomStore.open(home);
    try {
      seedStore.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), source: "native:claude", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "test", upstream_schema_version: "test" });
    } finally { seedStore.close(); }
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    try {
      const response = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_status", arguments: {} } }), async () => undefined);
      const content = response?.result as { structuredContent: { observations: Array<{ principal_id: string }>; disabled_principals: string[] } };
      expect(content.structuredContent.disabled_principals).toEqual(["claude-2"]);
      expect(content.structuredContent.observations).not.toContainEqual(expect.objectContaining({ principal_id: "claude-2" }));
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
