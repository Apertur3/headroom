import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentLine } from "../src/agent-line.js";
import { main } from "../src/cli.js";
import { gateFor } from "../src/orchestrator-reads.js";
import { canConsume, defaultPolicy } from "../src/policy.js";
import { formatMeters, renderStatus } from "../src/status-view.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const base = {
  observed_at: NOW.toISOString(), fetched_at: NOW.toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1,
  adapter_version: "test", upstream_schema_version: "test",
} as const;

function fable(used: number, extra: Partial<Observation> = {}): Observation {
  return {
    ...base, principal_id: "claude-main", meter_id: "claude-main:fable", window: { kind: "fixed", minutes: 10_080, enforcement: "soft" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2026-10-23T12:00:00.000Z",
    reason: "separate weekly limit, unconfirmed: shown for visibility only", metadata: { vendor_active: false, unconfirmed: true }, ...extra,
  } as Observation;
}

function weekly(used: number): Observation {
  return { ...fable(used), meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, reason: undefined, metadata: undefined } as Observation;
}

const REFUSAL = "claude-main:fable is visibility-only (unconfirmed); check claude-main:all instead";

async function home(rows: Observation[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-soft-"));
  temporary.push(root);
  await writeFile(join(root, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/synthetic/claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
  await writeFile(join(root, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:fable"]\n', { mode: 0o600 });
  const store = await HeadroomStore.open(root);
  const real = new Date();
  try {
    for (const row of rows) {
      const span = row.window?.minutes === 300 ? 2 * 3_600_000 : 5 * 86_400_000;
      store.insert({ ...row, observed_at: real.toISOString(), fetched_at: real.toISOString(), resets_at: new Date(real.getTime() + span).toISOString() });
    }
  } finally { store.close(); }
  return root;
}

async function run(root: string, argv: string[]): Promise<{ code: number; out: string }> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = root;
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => { logged.push(String(message)); });
  const errors = vi.spyOn(console, "error").mockImplementation((message?: unknown) => { logged.push(String(message)); });
  try { return { code: await main(argv), out: logged.join("\n") }; }
  finally { spy.mockRestore(); errors.mockRestore(); if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

const fiveHour = (): Observation => ({ ...weekly(30), window: { kind: "rolling", minutes: 300, enforcement: "hard" } });

describe("a visibility-only meter (soft + unconfirmed)", () => {
  it("canConsume refuses it, even with allowUnknown", () => {
    for (const allowUnknown of [false, true]) {
      const decision = canConsume(["claude-main:fable"], new Map([["claude-main:fable", [fable(10)]]]), defaultPolicy, allowUnknown, NOW);
      expect(decision).toMatchObject({ allowed: false, state: "UNKNOWN", reason: REFUSAL });
    }
  });

  it("targeted can, gate and run refuse it, with --allow-unknown too, and create no lease", async () => {
    const root = await home([fable(10), weekly(30), fiveHour()]);
    for (const extra of [[], ["--allow-unknown"]]) {
      const can = await run(root, ["can", "claude-fable", "--owner", "x", "--json", ...extra]);
      expect(can.code).toBe(2);
      expect(can.out).toContain(REFUSAL);
      expect((await run(root, ["gate", "--need", "wk:5", "--meter", "claude-main:fable", "--owner", "x", ...extra])).code).toBe(2);
      expect((await run(root, ["run", "--meter", "claude-main:fable", "--need", "wk:5", "--owner", "x", ...extra, "--", process.execPath, "-e", "process.exit(0)"])).code).not.toBe(0);
    }
    const lease = await run(root, ["can", "claude-fable", "--owner", "x", "--lease", "--expect", "5", "--json"]);
    expect(lease.code).toBe(2);
    const store = await HeadroomStore.open(root);
    try { expect(store.leases(undefined, true)).toEqual([]); } finally { store.close(); }
  });

  it("a global gate ignores it", async () => {
    const root = await home([fable(99), weekly(30), fiveHour()]);
    const store = await HeadroomStore.open(root);
    try {
      const result = gateFor(store, [{ window: "wk", points: 5 }], undefined, 10, false, new Date());
      expect(result.allowed).toBe(true);
      expect(result.meters_checked).toEqual(["claude-main:all"]);
    } finally { store.close(); }
  });

  it("route and plan do not treat it as capacity", async () => {
    const root = await home([fable(10), weekly(30), fiveHour()]);
    const route = await run(root, ["route", "--class", "claude-fable", "--owner", "x", "--allow-unknown", "--json"]);
    expect(route.code).toBe(2);
    expect(route.out).not.toMatch(/"remaining_percent":\s*90/);
    const plan = await run(root, ["plan", "--meter", "claude-main:fable", "--until", "reset"]); expect(plan.out).toMatch(/no .*window|unknown/i);
  });

  it("status and line show it with no pace state", () => {
    const rows = [weekly(10), fable(41)];
    const plain = formatMeters(rows, defaultPolicy, undefined, undefined, undefined, NOW).find((line) => line.startsWith("claude-main:fable"))!;
    expect(plain).toContain("wk 41% (unconfirmed)");
    expect(plain).not.toMatch(/HARVEST|NORMAL|CONSERVE|FREEZE/);
    expect(renderStatus({ observations: rows, policy: defaultPolicy, now: NOW }, { form: "grouped", color: false } as never).join("\n")).toContain("(unconfirmed)");
    const line = buildAgentLine(rows, defaultPolicy, ["claude-main"], NOW);
    expect(line.line).toContain("claude-main:fable wk 41% (unconfirmed)");
    expect(line.accounts.every((account) => account.meter !== "claude-main:fable")).toBe(true);
  });

  it("other soft windows behave as before", () => {
    const plainSoft = fable(99, { metadata: undefined });
    const decision = canConsume(["claude-main:fable"], new Map([["claude-main:fable", [plainSoft]]]), defaultPolicy, false, NOW);
    expect(decision.state).toBe("FREEZE");
    const hardUnconfirmed = fable(99, { window: { kind: "fixed", minutes: 10_080, enforcement: "hard" } });
    expect(canConsume(["claude-main:fable"], new Map([["claude-main:fable", [hardUnconfirmed]]]), defaultPolicy, false, NOW).state).toBe("FREEZE");
  });
});
