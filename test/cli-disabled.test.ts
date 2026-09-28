import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, runCli } from "../src/cli.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
  try { return await run(); } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

const DISABLED_ACCOUNTS_TOML = ['[[accounts]]', 'name = "claude-2"', 'enabled = false', 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ''].join("\n");

describe("disabled meter decisions", () => {
  it("fails closed by principal name: gate/run/can/route refuse (exit 2)", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    await writeFile(join(home, "routing.toml"), ['[consumes]', 'parked = ["claude-2:all"]', ''].join("\n"), { mode: 0o600 });
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    const errors: string[] = []; const err = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    try {
      await withHome(home, async () => {
        // These are dispatch/capacity decisions: refusing a disabled
        // principal is a normal "no", exit 2 -- the same code any other
        // refusal from these commands already uses.
        const calls = [
          ["gate", "--meter", "claude-2:all", "--need", "5h:1", "--owner", "test"],
          ["run", "--meter", "claude-2:all", "--need", "5h:1", "--owner", "test", "--", "true"],
          ["can", "parked", "--owner", "test"], ["route", "--class", "parked", "--owner", "test"],
        ];
        for (const argv of calls) expect(await main(argv)).toBe(2);
      });
    } finally { log.mockRestore(); err.mockRestore(); }
    const text = [...output, ...errors].join("\n");
    expect(text).toContain("principal claude-2 is disabled (enabled = false in accounts.toml)");
    expect(text).not.toContain("YES claude-2");
  });

  it("fails closed for lease start as an ordinary thrown error (exit 1)", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-writes-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const errors: string[] = []; const err = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    try {
      await withHome(home, async () => {
        // Neither command has its own "UNKNOWN reading" convention (they are
        // writes, not reads): a disabled refusal here is an ordinary thrown
        // error, caught by runCli exactly like any other CLI failure (exit
        // 1), not a one-off exit 2. main() itself does not catch -- runCli does.
        expect(await runCli(["lease", "start", "--meter", "claude-2:all", "--owner", "test"])).toBe(1);
      });
    } finally { err.mockRestore(); }
    expect(errors.join("\n")).toContain("principal claude-2 is disabled (enabled = false in accounts.toml)");
  });

  it("reports rate/plan/wait/fill as an UNKNOWN reading in each command's own shape, exit 0", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-unknown-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    try {
      await withHome(home, async () => {
        expect(await main(["rate", "--meter", "claude-2:all", "--json"])).toBe(0);
        expect(await main(["plan", "--meter", "claude-2:all", "--until", "reset", "--json"])).toBe(0);
        expect(await main(["wait", "--meter", "claude-2:all", "--until-reset"])).toBe(0);
        expect(await main(["fill", "--meter", "claude-2:all", "--until-reset", "--owner", "test", "--json"])).toBe(0);
      });
    } finally { log.mockRestore(); }
    // rate --json stays a bare RateLine[] array (never becomes an object).
    const rate = JSON.parse(output[0]) as Array<{ meter: string; reason?: string }>;
    expect(rate).toEqual([expect.objectContaining({ meter: "claude-2:all", reason: expect.stringContaining("disabled") })]);
    // plan --json keeps its documented { meter, error, notices } failure shape.
    const plan = JSON.parse(output[1]) as { meter: string; error?: string; notices?: string[] };
    expect(plan).toEqual(expect.objectContaining({ meter: "claude-2:all", error: expect.stringContaining("disabled"), notices: [] }));
    // wait has no --json; its own plain "UNKNOWN (...)" line, unchanged.
    expect(output[2]).toContain("claude-2:all  UNKNOWN (");
    expect(output[2]).toContain("disabled");
    // fill --json keeps its documented { meter, error, notices } failure shape.
    const fill = JSON.parse(output[3]) as { meter: string; error?: string; notices?: string[] };
    expect(fill).toEqual(expect.objectContaining({ meter: "claude-2:all", error: expect.stringContaining("disabled"), notices: [] }));
  });

  it("keeps disabled rows out of aggregate rate and credits, and refuses credit writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-aggregate-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try {
      const now = new Date();
      store.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(now.getTime() + 3_600_000).toISOString(), observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" });
      store.recordManualCredits("claude-2", 1, new Date(now.getTime() + 86_400_000).toISOString());
    } finally { store.close(); }
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    const errors: string[] = []; const err = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    try {
      await withHome(home, async () => {
        expect(await main(["rate", "--json"])).toBe(0);
        expect(await main(["credits", "--json"])).toBe(0);
        expect(await runCli(["credits", "set", "--principal", "claude-2", "--available", "1", "--expires", "2026-10-01"])).toBe(1);
        expect(await runCli(["credits", "clear", "--principal", "claude-2"])).toBe(1);
      });
    } finally { log.mockRestore(); err.mockRestore(); }
    expect(JSON.parse(output[0])).toEqual([]);
    expect(JSON.parse(output[1]).credits).toEqual([]);
    expect(errors.join("\n")).toContain("principal claude-2 is disabled");
  });

  it("keeps history readable for a disabled principal: it cannot create capacity", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-history-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try {
      store.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), source: "native:claude", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "test", upstream_schema_version: "test" });
    } finally { store.close(); }
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    try {
      await withHome(home, async () => { expect(await main(["history", "claude-2:all"])).toBe(0); });
    } finally { log.mockRestore(); }
    const rows = JSON.parse(output[0]) as Array<{ principal_id: string }>;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ principal_id: "claude-2" })]));
  });

  it("omits current disabled observations from status JSON and names the principal separately, though the row is still stored", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-cli-disabled-status-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), DISABLED_ACCOUNTS_TOML, { mode: 0o600 });
    // Disabled principals are never polled at all (collector.ts's own
    // isAccountEnabled filter), so without a real stored row this assertion
    // would pass whether or not the status filtering below does anything --
    // seed one so the test actually exercises it.
    const store = await HeadroomStore.open(home);
    try {
      store.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), source: "native:claude", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "test", upstream_schema_version: "test" });
    } finally { store.close(); }
    const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    try {
      await withHome(home, async () => { expect(await main(["status", "--json"])).toBe(0); });
    } finally { log.mockRestore(); }
    const result = JSON.parse(output[0]) as { observations: Array<{ principal_id: string }>; disabled_principals: string[] };
    expect(result.disabled_principals).toEqual(["claude-2"]);
    expect(result.observations).not.toEqual(expect.arrayContaining([expect.objectContaining({ principal_id: "claude-2" })]));
  });
});
