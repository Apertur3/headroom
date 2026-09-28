import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("MCP disabled status", () => {
  it("quota_rate without meter excludes disabled-only stored capacity and fails closed on malformed accounts", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-mcp-disabled-rate-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-parked"', 'enabled = false', 'vendor = "claude"', 'location = "/fixture/claude-parked"', 'adapter = "native-ts"', ''].join("\n"), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try {
      store.insert({ principal_id: "claude-parked", meter_id: "claude-parked:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" });
    } finally { store.close(); }
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    try {
      const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_rate", arguments: {} } });
      const response = await handleMcp(line, async () => undefined);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", lines: [] } } });

      await writeFile(join(home, "accounts.toml"), "not valid toml", { mode: 0o600 });
      await expect(handleMcp(line, async () => undefined)).resolves.toMatchObject({ error: { code: -32000 } });
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

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

  it("quota_lease_start on a disabled meter is an MCP tool error, not a { allowed: false } object", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-mcp-disabled-lease-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', "enabled = false", 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    try {
      const response = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_lease_start", arguments: { meter_id: "claude-2:all", owner: "test" } } }), async () => undefined);
      // A write, with no "UNKNOWN" convention of its own: this must be a
      // standard MCP tool error (same as any other daemon-side lease_start
      // rejection), never a bespoke { allowed: false } payload only this
      // one path would ever produce.
      expect(response).toMatchObject({ error: { code: -32000, message: expect.stringContaining("principal claude-2 is disabled") } });
      expect(response).not.toHaveProperty("result");
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

  it("quota_usage_paste for a disabled principal is an MCP tool error, not a { allowed: false } object", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-mcp-disabled-usagepaste-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', "enabled = false", 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    try {
      const response = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_usage_paste", arguments: { text: "Current session\n10% used" } } }), async () => undefined);
      expect(response).toMatchObject({ error: { code: -32000, message: expect.stringContaining("principal claude-2 is disabled") } });
      expect(response).not.toHaveProperty("result");
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
