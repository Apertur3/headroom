import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMeters, main } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";
import { fillFor, gateFor, routeFor } from "../src/orchestrator-reads.js";
import { defaultPolicy, parsePolicy, reserveFor, type Policy } from "../src/policy.js";
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

const claudeMainLocation = join(homedir(), ".claude");
const claude2Location = join(homedir(), ".claude2");

function at(offsetMs: number): string { return new Date(Date.now() + offsetMs).toISOString(); }

function window5h(meterId: string, used: number, principal = meterId.split(":")[0]): Observation {
  const fetchedAt = at(0);
  return {
    principal_id: principal, meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: at(295 * 60_000),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function weekly(meterId: string, used: number, principal = meterId.split(":")[0]): Observation {
  const fetchedAt = at(0);
  return {
    principal_id: principal, meter_id: meterId, window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: at(3 * 86_400_000),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

/** A temporary Headroom home with the given policy body, a one-class routing
 * table over `claude-main:fable`, two Claude accounts, and whatever
 * observations the test needs. Never touches the real ~/.headroom. */
async function seedHome(policyBody: string, observations: Observation[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-reserve-")); temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "policy.toml"), policyBody, { mode: 0o600 });
  await writeFile(join(home, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:fable"]\n', { mode: 0o600 });
  await writeFile(join(home, "accounts.toml"), [
    "[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', `location = ${JSON.stringify(claudeMainLocation)}`, 'adapter = "native-ts"', "",
    "[[accounts]]", 'name = "claude-2"', 'vendor = "claude"', `location = ${JSON.stringify(claude2Location)}`, 'adapter = "native-ts"', "",
  ].join("\n"), { mode: 0o600 });
  const store = await HeadroomStore.open(home);
  for (const observation of observations) store.insert(observation);
  store.close();
  return home;
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

const accounts: ProviderAccount[] = [
  { name: "claude-main", vendor: "claude", location: claudeMainLocation, adapter: "native-ts" },
  { name: "claude-2", vendor: "claude", location: claude2Location, adapter: "native-ts" },
];

/** Isolates the reserve from even pacing's pro-rata and burst rules, which
 * have their own tests: `pacing = "none"` leaves the reserve as the only
 * thing standing between a need and the plain window ceiling. */
const RESERVE_POLICY = 'pacing = "none"\n[reserve]\n"claude-main:fable" = 10\n';

describe("policy [reserve] parsing", () => {
  it("reads a per-meter table and the '*' default, and falls back to 0 with neither", () => {
    const policy = parsePolicy([
      "freeze_reserve_pct = 10",
      "[reserve]",
      '"claude-main:fable" = 10',
      '"claude-main:all" = 5',
      '"*" = 2',
    ].join("\n"));
    expect(policy.reserve).toEqual({ "claude-main:fable": 10, "claude-main:all": 5, "*": 2 });
    expect(reserveFor(policy.reserve, "claude-main:fable")).toBe(10);
    expect(reserveFor(policy.reserve, "claude-main:all")).toBe(5);
    expect(reserveFor(policy.reserve, "codex-main:main")).toBe(2); // the default key
    expect(reserveFor({}, "codex-main:main")).toBe(0);
    expect(defaultPolicy.reserve).toEqual({});
  });

  it("keeps the table scoped to its own section and tolerates comments", () => {
    const policy = parsePolicy([
      "[reserve]",
      '"claude-main:fable" = 10  # the orchestrator\'s own meter',
      "[principal.claude-main]",
      "interval_minutes = 5",
    ].join("\n"));
    expect(policy.reserve).toEqual({ "claude-main:fable": 10 });
    expect(policy.principal_intervals).toEqual({ "claude-main": 5 });
  });

  it("rejects an out-of-range or unparseable entry, the policy error the doctor reports", () => {
    expect(() => parsePolicy('[reserve]\n"claude-main:fable" = 91\n')).toThrow("Invalid Headroom policy");
    expect(() => parsePolicy('[reserve]\n"claude-main:fable" = -1\n')).toThrow("Invalid Headroom policy");
    expect(() => parsePolicy('[reserve]\nclaude-main:fable = 10\n')).toThrow("Invalid Headroom policy");
    expect(() => parsePolicy('[reserve]\n"claude-main:fable" = "ten"\n')).toThrow("Invalid Headroom policy");
    expect(parsePolicy('[reserve]\n"claude-main:fable" = 90\n').reserve).toEqual({ "claude-main:fable": 90 });
  });
});

describe("gate against a reserve", () => {
  it("allows a need that lands exactly on the reserve boundary and refuses the next point, naming the reserve", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 85)]);
    const store = await HeadroomStore.open(home);
    try {
      const reserves = { "claude-main:fable": 10 };
      const onTheLine = gateFor(store, [{ window: "5h", points: 5 }], "claude-main:fable", 0, false, new Date(), { owner: "orchestrator", pacing: "none", reserves });
      expect(onTheLine.allowed).toBe(true);

      const overTheLine = gateFor(store, [{ window: "5h", points: 6 }], "claude-main:fable", 0, false, new Date(), { owner: "orchestrator", pacing: "none", reserves });
      expect(overTheLine.allowed).toBe(false);
      expect(overTheLine.reason).toContain("would use the 10% reserve on claude-main:fable");
    } finally { store.close(); }
  });

  it("applies the larger of the policy reserve and the caller's own --reserve value", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 85)]);
    const store = await HeadroomStore.open(home);
    try {
      // A 20% per-call reserve is stricter than the meter's 10% floor, so it
      // is the one that binds; the refusal keeps the plain ceiling wording.
      const result = gateFor(store, [{ window: "5h", points: 1 }], "claude-main:fable", 20, false, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "claude-main:fable": 10 } });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("20% reserve");
    } finally { store.close(); }
  });

  it("refuses through the CLI with exit 2 and the reserve named in the line", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 85)]);
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["gate", "--need", "5h:6", "--meter", "claude-main:fable", "--owner", "orchestrator"])).toBe(2);
      });
    } finally { restore(); }
    expect(logs.join("\n")).toContain("would use the 10% reserve on claude-main:fable");
  });
});

describe("fill above a reserve", () => {
  it("counts only the lanes that fit above the protected floor", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 60)]);
    await withHeadroomHome(home, async () => {
      const store = await HeadroomStore.open(home);
      try {
        const withoutReserve = await fillFor(store, "claude-main:fable", 10, 10, new Date(), { owner: "orchestrator", pacing: "none" });
        expect("lanes" in withoutReserve && withoutReserve.lanes?.lanes).toBe(3);

        const withReserve = await fillFor(store, "claude-main:fable", 10, 10, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "claude-main:fable": 10 } });
        expect("lanes" in withReserve && withReserve.lanes?.lanes).toBe(2);
      } finally { store.close(); }
    });
  });
});

describe("route around a reserve", () => {
  it("ranks with the reserve removed, so a nominally roomier principal loses", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 70), window5h("claude-2:fable", 75)]);
    const store = await HeadroomStore.open(home);
    try {
      const policy: Policy = { ...defaultPolicy, reserve: { "claude-main:fable": 10 } };
      const bare = routeFor(store, ["claude-main:fable", "claude-2:fable"], accounts, defaultPolicy, false, new Date(), "orchestrator");
      expect(bare.principal).toBe("claude-main"); // 30% remaining beats 25%

      const reserved = routeFor(store, ["claude-main:fable", "claude-2:fable"], accounts, policy, false, new Date(), "orchestrator");
      expect(reserved.principal).toBe("claude-2"); // 30% - 10% reserve = 20%, below claude-2's 25%
      expect(reserved.candidates.find((item) => item.principal === "claude-main")?.remaining_percent).toBe(20);
    } finally { store.close(); }
  });

  it("skips a meter whose usable remaining is entirely inside its reserve", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 80)]);
    const store = await HeadroomStore.open(home);
    try {
      const policy: Policy = { ...defaultPolicy, reserve: { "claude-main:fable": 20 } };
      const result = routeFor(store, ["claude-main:fable"], accounts, policy, false, new Date(), "orchestrator");
      expect(result.principal).toBeNull();
      expect(result.candidates[0].remaining_percent).toBe(0);
      // The pace state itself is untouched: the reserve is a decision floor,
      // not a pace rule.
      expect(result.candidates[0].state).toBe("NORMAL");
    } finally { store.close(); }
  });
});

describe("can against a reserve", () => {
  it("answers NO when the expected cost would cross into the reserve", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 85)]);
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        // 15% remaining, 10% reserved, so 5% is spendable: a 3% action fits.
        expect(await main(["can", "claude-fable", "--owner", "orchestrator", "--expect", "3"])).toBe(0);
        // An 8% action does not, even though the meter itself is NORMAL.
        expect(await main(["can", "claude-fable", "--owner", "orchestrator", "--expect", "8"])).toBe(2);
      });
    } finally { restore(); }
    expect(logs[0]).toContain("YES claude-main:fable");
    expect(logs.join("\n")).toContain("would use the 10% reserve on claude-main:fable");
  });
});

describe("status line", () => {
  it("shows the reserve after a window's numbers only for a meter that has one", () => {
    const policy: Policy = { ...defaultPolicy, reserve: { "claude-main:fable": 10 } };
    const lines = formatMeters([weekly("claude-main:fable", 85), weekly("claude-main:all", 40)], policy);
    expect(lines.find((line) => line.startsWith("claude-main:fable"))).toContain("wk 85% (reserve 10%)");
    expect(lines.find((line) => line.startsWith("claude-main:all"))).toContain("wk 40% ↻");
    expect(lines.join("\n")).not.toContain("40% (reserve");
  });
});

describe("MCP twins pass the reserve through", () => {
  it("quota_gate refuses, quota_fill counts above the floor, quota_route skips, quota_can says no", async () => {
    const home = await seedHome(RESERVE_POLICY, [window5h("claude-main:fable", 85), weekly("claude-main:fable", 20)]);
    await withHeadroomHome(home, async () => {
      const structured = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
        return (reply as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      };

      const gate = await structured("quota_gate", { needs: ["5h:6"], meter: "claude-main:fable", owner: "orchestrator" });
      expect(gate.allowed).toBe(false);
      expect(String(gate.reason)).toContain("would use the 10% reserve on claude-main:fable");

      const fill = await structured("quota_fill", { meter: "claude-main:fable", lane_cost_percent: 2, owner: "orchestrator" });
      // 15% remaining, minus the 10% reserve and the 5% safety margin, is 0.
      expect((fill.lanes as { lanes: number }).lanes).toBe(0);

      const route = await structured("quota_route", { action_class: "claude-fable", owner: "orchestrator" });
      expect(route.principal).toBe("claude-main");
      expect(String(route.reason)).toContain("after the 10% reserve");

      const can = await structured("quota_can", { action_class: "claude-fable", owner: "orchestrator", expect_percent: 8 });
      expect((can.decision as { allowed: boolean }).allowed).toBe(false);
      expect(String((can.decision as { reason: string }).reason)).toContain("would use the 10% reserve on claude-main:fable");
    });
  });
});
