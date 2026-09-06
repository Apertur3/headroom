import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pollAccounts } from "../src/collector.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function accountsHome(root: string, location: string): Promise<string> {
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "accounts.toml"), [
    "[[accounts]]",
    'name = "claude-main"',
    'vendor = "claude"',
    `location = ${JSON.stringify(location)}`,
    'adapter = "native-ts"',
    "",
  ].join("\n"), { mode: 0o600 });
  return home;
}

describe("pollAccounts: statusline snapshot as a zero-auth Claude source", () => {
  it("answers the account-wide windows from a fresh snapshot while the grant is pending, without touching the probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-poll-")); temporary.push(root);
    const location = "/nonexistent/.claude-statusline-test";
    const home = await accountsHome(root, location);
    const statuslineDir = join(home, "statusline");
    await mkdir(statuslineDir, { recursive: true });
    await writeFile(join(statuslineDir, ".claude-statusline-test.json"), JSON.stringify({
      profile: ".claude-statusline-test", observed_at: Math.floor(Date.now() / 1000),
      five_hour: { used_percent: 12, resets_at: null }, seven_day: { used_percent: 34, resets_at: null }, extra: {},
    }));
    await withHeadroomHome(home, async () => {
      const result = await pollAccounts(undefined, {
        claudeGrant: {
          needsGrant: () => true,
          markGrantNeeded: () => { throw new Error("must not be called: the probe was never attempted"); },
          markProbeSucceeded: () => { throw new Error("must not be called: the probe was never attempted"); },
        },
      });
      const rows = result.observations.filter((item) => item.principal_id === "claude-main");
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 12 }), source: "native:claude-statusline", freshness: "fresh" }),
        expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 10_080 }), quantity: expect.objectContaining({ used: 34 }) }),
      ]));
      // The snapshot carries no model-scoped buckets: those stay grant-needed.
      expect(rows.some((item) => item.meter_id !== "claude-main:all" && item.freshness === "failed" && /grant/i.test(item.reason ?? ""))).toBe(true);
      expect(result.claudeProbeOutcomes).toEqual({ "claude-main": "skipped: statusline fresh" });
    });
  });

  it("attempts the granted probe even when a snapshot is fresh, and falls back to the snapshot for the account-wide windows when the probe fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-granted-")); temporary.push(root);
    const location = "/nonexistent/.claude-statusline-test";
    const home = await accountsHome(root, location);
    const statuslineDir = join(home, "statusline");
    await mkdir(statuslineDir, { recursive: true });
    await writeFile(join(statuslineDir, ".claude-statusline-test.json"), JSON.stringify({
      profile: ".claude-statusline-test", observed_at: Math.floor(Date.now() / 1000),
      five_hour: { used_percent: 12, resets_at: null }, seven_day: { used_percent: 34, resets_at: null }, extra: {},
    }));
    await withHeadroomHome(home, async () => {
      const result = await pollAccounts(undefined, {
        claudeGrant: { needsGrant: () => false, markGrantNeeded: () => {}, markProbeSucceeded: () => {}, probePath: () => undefined },
      });
      expect(result.claudeProbeOutcomes).toEqual({ "claude-main": "called" });
      const rows = result.observations.filter((item) => item.principal_id === "claude-main");
      // The probe cannot read a nonexistent config dir, so the account-wide
      // windows come from the snapshot; every other row is the probe's own failure.
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 12 }), source: "native:claude-statusline", freshness: "fresh" }),
      ]));
      expect(rows.filter((item) => item.meter_id === "claude-main:all" && item.window?.minutes === 300)).toHaveLength(1);
    });
  });

  it("falls through to the grant gate (and the probe) when the snapshot is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-stale-")); temporary.push(root);
    const location = "/nonexistent/.claude-stale-test";
    const home = await accountsHome(root, location);
    const statuslineDir = join(home, "statusline");
    await mkdir(statuslineDir, { recursive: true });
    const staleAt = Math.floor(Date.now() / 1000) - 3600; // 1h old, well past the 10-minute fresh window
    await writeFile(join(statuslineDir, ".claude-stale-test.json"), JSON.stringify({
      profile: ".claude-stale-test", observed_at: staleAt,
      five_hour: { used_percent: 12, resets_at: null }, seven_day: { used_percent: 34, resets_at: null }, extra: {},
    }));
    await withHeadroomHome(home, async () => {
      let gateConsulted = false;
      const result = await pollAccounts(undefined, {
        claudeGrant: {
          needsGrant: () => { gateConsulted = true; return true; }, // block the probe too: only the gating behavior is under test here
          markGrantNeeded: () => undefined,
          markProbeSucceeded: () => undefined,
        },
      });
      expect(gateConsulted).toBe(true);
      expect(result.claudeProbeOutcomes).toEqual({ "claude-main": "skipped: grant needed" });
    });
  });

  it("falls through when there is no snapshot at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-statusline-none-")); temporary.push(root);
    const home = await accountsHome(root, "/nonexistent/.claude-no-snapshot");
    await withHeadroomHome(home, async () => {
      let gateConsulted = false;
      const result = await pollAccounts(undefined, {
        claudeGrant: { needsGrant: () => { gateConsulted = true; return true; }, markGrantNeeded: () => undefined, markProbeSucceeded: () => undefined },
      });
      expect(gateConsulted).toBe(true);
      expect(result.claudeProbeOutcomes).toEqual({ "claude-main": "skipped: grant needed" });
    });
  });
});
