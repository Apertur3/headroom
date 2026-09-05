import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";
import { launchEnvironment, routeFor } from "../src/orchestrator-reads.js";
import { defaultPolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation, ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

const claudeMainLocation = join(homedir(), ".claude"); // the real default profile
const claude2Location = join(homedir(), ".claude2");

// In grace (elapsed well under 10% of a 300-minute window): FREEZE is
// checked before grace, so this still reports FREEZE once used crosses the
// default 90% reserve threshold, and NORMAL otherwise -- a deterministic
// pace state independent of the straight-line surplus math.
function meter(principal: string, meterName: string, used: number, fetchedAt: string): Observation {
  return {
    principal_id: principal, meter_id: `${principal}:${meterName}`, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: new Date(Date.parse(fetchedAt) + 295 * 60_000).toISOString(),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

async function seedRoutingHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-route-")); temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:all", "claude-main:fable", "claude-2:all", "claude-2:fable"]\n', { mode: 0o600 });
  await writeFile(join(home, "accounts.toml"), [
    "[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', `location = ${JSON.stringify(claudeMainLocation)}`, 'adapter = "native-ts"', "",
    "[[accounts]]", 'name = "claude-2"', 'vendor = "claude"', `location = ${JSON.stringify(claude2Location)}`, 'adapter = "native-ts"', "",
  ].join("\n"), { mode: 0o600 });
  const now = new Date().toISOString();
  const store = await HeadroomStore.open(home);
  store.insert(meter("claude-main", "all", 92, now)); // FREEZE: near its reserve
  store.insert(meter("claude-main", "fable", 50, now));
  store.insert(meter("claude-2", "all", 20, now)); // far more headroom
  store.insert(meter("claude-2", "fable", 10, now));
  store.close();
  return home;
}

describe("launchEnvironment", () => {
  it("is empty for a vendor's own default profile, and sets the right variable for a non-default one", () => {
    const mainAccount: ProviderAccount = { name: "claude-main", vendor: "claude", location: claudeMainLocation, adapter: "native-ts" };
    const two: ProviderAccount = { name: "claude-2", vendor: "claude", location: claude2Location, adapter: "native-ts" };
    const codex: ProviderAccount = { name: "codex-2", vendor: "codex", location: join(homedir(), ".codex2"), adapter: "native-ts" };
    expect(launchEnvironment(mainAccount)).toEqual({});
    expect(launchEnvironment(two)).toEqual({ CLAUDE_CONFIG_DIR: claude2Location });
    expect(launchEnvironment(codex)).toEqual({ CODEX_HOME: join(homedir(), ".codex2") });
  });
});

describe("routeFor", () => {
  it("picks the principal with the most remaining headroom on its own tightest window among those that fit", async () => {
    const home = await seedRoutingHome();
    const accounts: ProviderAccount[] = [
      { name: "claude-main", vendor: "claude", location: claudeMainLocation, adapter: "native-ts" },
      { name: "claude-2", vendor: "claude", location: claude2Location, adapter: "native-ts" },
    ];
    const store = await HeadroomStore.open(home);
    try {
      const result = routeFor(store, ["claude-main:all", "claude-main:fable", "claude-2:all", "claude-2:fable"], accounts, defaultPolicy, false, new Date());
      expect(result.principal).toBe("claude-2");
      expect(result.environment).toEqual({ CLAUDE_CONFIG_DIR: claude2Location });
      const mainCandidate = result.candidates.find((item) => item.principal === "claude-main");
      expect(mainCandidate?.state).toBe("FREEZE");
      const two = result.candidates.find((item) => item.principal === "claude-2");
      expect(two?.remaining_percent).toBe(80);
    } finally { store.close(); }
  });

  it("returns no principal (never throws) when every candidate is frozen or conserving", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-route-none-")); temporary.push(root);
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const store = await HeadroomStore.open(home);
    try {
      const now = new Date().toISOString();
      store.insert(meter("claude-main", "all", 95, now));
      const result = routeFor(store, ["claude-main:all"], [{ name: "claude-main", vendor: "claude", location: claudeMainLocation, adapter: "native-ts" }], defaultPolicy, false, new Date());
      expect(result.principal).toBeNull();
      expect(result.candidates[0].state).toBe("FREEZE");
    } finally { store.close(); }
  });
});

describe("headroom route (CLI)", () => {
  it("prints the winning principal and its launch environment, exit 0", async () => {
    const home = await seedRoutingHome();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      await withHeadroomHome(home, async () => {
        const code = await main(["route", "--class", "claude-fable", "--owner", "orchestrator"]);
        expect(code).toBe(0);
      });
    } finally { spy.mockRestore(); }
    expect(logs.join("\n")).toContain(`claude-2 CLAUDE_CONFIG_DIR=${claude2Location}`);
  });

  it("--json reports every candidate, and exit 2 when routing.toml is missing", async () => {
    const home = await seedRoutingHome();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["route", "--class", "claude-fable", "--owner", "orchestrator", "--json"])).toBe(0);
      });
    } finally { spy.mockRestore(); }
    const result = JSON.parse(logs[0]);
    expect(result.principal).toBe("claude-2");
    expect(result.candidates).toHaveLength(2);

    const root2 = await mkdtemp(join(tmpdir(), "headroom-route-norouting-")); temporary.push(root2);
    const home2 = join(root2, ".headroom");
    await mkdir(home2, { recursive: true, mode: 0o700 });
    await withHeadroomHome(home2, async () => {
      await expect(main(["route", "--class", "claude-fable", "--owner", "x"])).rejects.toThrow("No routing.toml configured");
    });
  });
});

describe("quota_route (MCP, direct only)", () => {
  it("returns the same decision as the CLI, tagged source: direct", async () => {
    const home = await seedRoutingHome();
    await withHeadroomHome(home, async () => {
      const reply = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_route","arguments":{"action_class":"claude-fable","owner":"orchestrator"}}}');
      const structured = (reply as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      expect(structured.source).toBe("direct");
      expect(structured.principal).toBe("claude-2");
      expect(structured.environment).toEqual({ CLAUDE_CONFIG_DIR: claude2Location });
    });
  });
});
