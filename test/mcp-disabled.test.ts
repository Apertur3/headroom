import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("MCP disabled status", () => {
  it("omits a parked principal's stored rows and names it in quota_status", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-mcp-disabled-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', "enabled = false", 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    try {
      const response = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_status", arguments: {} } }), async () => undefined);
      const content = response?.result as { structuredContent: { observations: Array<{ principal_id: string }>; disabled_principals: string[] } };
      expect(content.structuredContent.disabled_principals).toEqual(["claude-2"]);
      expect(content.structuredContent.observations).not.toContainEqual(expect.objectContaining({ principal_id: "claude-2" }));
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
