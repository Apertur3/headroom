import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProcessReaper, writeMortalShim } from "./helpers/mortal-process.js";
import { checkHostHealth, defaultHostGuardPolicy, readHostGuardPolicy, type HostGuardPolicy, type HostHealth } from "../src/host-health.js";
import { main } from "../src/cli.js";
import { HeadroomStore } from "../src/store.js";

// The exact pattern test/doctor-freshrun.test.ts uses to fake one export
// while keeping the rest of a module real (vi.mock calls are hoisted above
// every import in this file, so writing it here rather than first changes
// nothing): hostGuardRefusal/hostGuardWarning stay the genuine implementation
// (so this file also proves they compose correctly with cli.ts's call
// sites), only the two probing entry points are replaced -- neither `run`,
// `can` nor `gate` ever create real load or a real PTY to reach a given
// state.
vi.mock("../src/host-health.js", async (original) => ({
  ...await original<typeof import("../src/host-health.js")>(),
  checkHostHealth: vi.fn(),
  readHostGuardPolicy: vi.fn(),
}));

useProcessReaper();
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); vi.clearAllMocks(); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function newHome(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `headroom-hostguard-cli-${prefix}-`));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function health(overrides: Partial<HostHealth> = {}): HostHealth {
  return { state: "ok", reasons: [], load_ratio: 0.1, pty_used: 1, pty_max: 100, orphans: 0, ...overrides };
}

function policy(overrides: Partial<HostGuardPolicy> = {}): HostGuardPolicy {
  return { ...defaultHostGuardPolicy, ...overrides };
}

function mockHealthAndPolicy(healthValue: HostHealth, policyValue: HostGuardPolicy): void {
  vi.mocked(checkHostHealth).mockResolvedValue(healthValue);
  vi.mocked(readHostGuardPolicy).mockResolvedValue(policyValue);
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

function captureError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
  return { lines, restore: () => spy.mockRestore() };
}

/** A fresh, well-under-reserve reading on `claude-main:fable`, and
 * `pacing = "none"` so the default pro-rata/burst check (which would
 * otherwise refuse a fresh window's very first request) never fires --
 * `run`'s own quota gate allows the launch, and every test below wants the
 * ONLY variable to be host pressure, not an incidental quota refusal. */
async function seedRunHome(home: string): Promise<void> {
  await writeFile(join(home, "policy.toml"), 'pacing = "none"\n', { mode: 0o600 });
  const store = await HeadroomStore.open(home);
  try {
    const now = new Date();
    const fetchedAt = now.toISOString();
    store.insert({
      principal_id: "claude-main", meter_id: "claude-main:fable", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
      observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
      confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
    });
  } finally { store.close(); }
}

async function seedGateHome(home: string): Promise<void> {
  await writeFile(join(home, "routing.toml"), ["[consumes]", 'claude-fable = ["claude-main:all"]', ""].join("\n"), { mode: 0o600 });
  await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
  const store = await HeadroomStore.open(home);
  try {
    const now = new Date();
    const fetchedAt = now.toISOString();
    store.insert({
      principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
      observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
      confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
    });
  } finally { store.close(); }
}

describe("can/gate --json carry the additive host object", () => {
  it("can --json's host field is exactly what checkHostHealth reported", async () => {
    const home = await newHome("can");
    await seedGateHome(home);
    const reported = health({ state: "warn", reasons: ["1 orphaned agy/script process(es) found"], orphans: 1 });
    mockHealthAndPolicy(reported, policy());
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["can", "claude-fable", "--owner", "cadence", "--json"])); }
    finally { restore(); }
    const parsed = JSON.parse(logs[0]);
    expect(parsed.host).toEqual(reported);
    expect(parsed.allowed).toBe(true); // host pressure never turns an otherwise-allowed can into a refusal
  });

  it("gate --json's host field is exactly what checkHostHealth reported, even when host state is refuse", async () => {
    const home = await newHome("gate");
    await seedGateHome(home);
    const reported = health({ state: "refuse", reasons: ["load_ratio 5.00 exceeds host_guard.refuse_load_ratio (3)"], load_ratio: 5 });
    mockHealthAndPolicy(reported, policy());
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["gate", "--need", "5h:1", "--meter", "claude-main:all", "--owner", "cadence", "--json"])); }
    finally { restore(); }
    const parsed = JSON.parse(logs[0]);
    expect(parsed.host).toEqual(reported);
    expect(parsed.allowed).toBe(true); // gate never refuses on host pressure either
  });
});

describe("headroom run: host guard", () => {
  it("refuses (exit 2) before any lease starts when host state is refuse and mode is refuse", async () => {
    const home = await newHome("run-refuse");
    await writeFile(join(home, "accounts.toml"), "");
    const reported = health({ state: "refuse", reasons: ["load_ratio 5.00 exceeds host_guard.refuse_load_ratio (3)"], load_ratio: 5 });
    mockHealthAndPolicy(reported, policy({ mode: "refuse" }));
    const { lines, restore } = captureError();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--", "true"]));
    } finally { restore(); }
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("host_guard.refuse_load_ratio");
    const store = await HeadroomStore.open(home);
    try { expect(store.leases("claude-main:fable", true)).toEqual([]); }
    finally { store.close(); }
  });

  it("run --json's refusal carries host, gate: null, lease_id: null", async () => {
    const home = await newHome("run-refuse-json");
    await writeFile(join(home, "accounts.toml"), "");
    const reported = health({ state: "refuse", reasons: ["pty use 90% (90/100) exceeds host_guard.refuse_pty_percent (75%)"], pty_used: 90, pty_max: 100 });
    mockHealthAndPolicy(reported, policy({ mode: "refuse" }));
    const { logs, restore } = captureLog();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--json", "--", "true"]));
    } finally { restore(); }
    expect(code).toBe(2);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toMatchObject({ host: reported, gate: null, lease_id: null });
  });

  it("downgrades a refuse reading to a warning (and still launches) when mode is warn", async () => {
    const home = await newHome("run-warn-mode");
    await writeFile(join(home, "accounts.toml"), "");
    await seedRunHome(home);
    const reported = health({ state: "refuse", reasons: ["load_ratio 5.00 exceeds host_guard.refuse_load_ratio (3)"], load_ratio: 5 });
    mockHealthAndPolicy(reported, policy({ mode: "warn" }));
    const shim = await writeMortalShim(join(home, "..", "mortal-shim"), { lifetimeSeconds: 1 });
    const { lines, restore } = captureError();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--", shim]));
    } finally { restore(); }
    expect(code).toBe(0); // the mortal shim exits 0 on its own
    expect(lines.join("\n")).toContain("host guard warning");
    expect(lines.join("\n")).toContain("load_ratio 5.00");
  }, 10_000);

  it("does not refuse and does not warn when mode is off, even for a refuse-worthy reading", async () => {
    const home = await newHome("run-off-mode");
    await writeFile(join(home, "accounts.toml"), "");
    await seedRunHome(home);
    const reported = health({ state: "refuse", reasons: ["load_ratio 5.00 exceeds host_guard.refuse_load_ratio (3)"], load_ratio: 5 });
    mockHealthAndPolicy(reported, policy({ mode: "off" }));
    const shim = await writeMortalShim(join(home, "..", "mortal-shim-off"), { lifetimeSeconds: 1 });
    const { lines, restore } = captureError();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--", shim]));
    } finally { restore(); }
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("host guard");
  }, 10_000);

  it("launches normally and prints a warning on stderr for a warn reading", async () => {
    const home = await newHome("run-warn");
    await writeFile(join(home, "accounts.toml"), "");
    await seedRunHome(home);
    const reported = health({ state: "warn", reasons: ["1 orphaned agy/script process(es) found"], orphans: 1 });
    mockHealthAndPolicy(reported, policy({ mode: "refuse" }));
    const shim = await writeMortalShim(join(home, "..", "mortal-shim-warn"), { lifetimeSeconds: 1 });
    const { lines, restore } = captureError();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--", shim]));
    } finally { restore(); }
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("host guard warning");
    expect(lines.join("\n")).toContain("orphaned agy/script");
  }, 10_000);

  it("launches normally and prints nothing when host state is ok", async () => {
    const home = await newHome("run-ok");
    await writeFile(join(home, "accounts.toml"), "");
    await seedRunHome(home);
    mockHealthAndPolicy(health({ state: "ok" }), policy({ mode: "refuse" }));
    const shim = await writeMortalShim(join(home, "..", "mortal-shim-ok"), { lifetimeSeconds: 1 });
    const { lines, restore } = captureError();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--", shim]));
    } finally { restore(); }
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("host guard");
  }, 10_000);

  it("launches normally when host state is unknown -- unknown never refuses or warns", async () => {
    const home = await newHome("run-unknown");
    await writeFile(join(home, "accounts.toml"), "");
    await seedRunHome(home);
    mockHealthAndPolicy(health({ state: "unknown", reasons: ["no host pressure measurements available on this platform"], load_ratio: null, pty_used: null, pty_max: null, orphans: null }), policy({ mode: "refuse" }));
    const shim = await writeMortalShim(join(home, "..", "mortal-shim-unknown"), { lifetimeSeconds: 1 });
    const { lines, restore } = captureError();
    let code: number;
    try {
      code = await withHeadroomHome(home, () => main(["run", "--meter", "claude-main:fable", "--need", "5h:10", "--owner", "owner-a", "--", shim]));
    } finally { restore(); }
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("host guard");
  }, 10_000);
});
