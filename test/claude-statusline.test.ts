import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatStatuslineBar, freshStatuslineSnapshot, latestStatuslineSnapshot, observationsFromStatuslineSnapshot,
  parseStatuslineSnapshot, snapshotFromStatuslinePayload, statuslineProfile, statuslineSnapshotDirs,
} from "../src/adapters/claude-statusline.js";
import type { ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// statuslineProfile()'s default-vs-named split (matchAccount's own call, with
// no home override) always resolves against the REAL homedir(), the same way
// production code does -- so these fixtures use it too, rather than a
// fictional "/Users/test" that would silently compute the wrong profile.
const claudeMain: ProviderAccount = { name: "claude-main", vendor: "claude", location: join(homedir(), ".claude"), adapter: "native-ts" };
const claude2: ProviderAccount = { name: "claude-2", vendor: "claude", location: join(homedir(), ".claude2"), adapter: "native-ts" };

describe("statuslineProfile", () => {
  it("is 'default' for the default ~/.claude profile, and the basename for any other", () => {
    expect(statuslineProfile("/Users/test/.claude", "/Users/test")).toBe("default");
    expect(statuslineProfile("/Users/test/.claude2", "/Users/test")).toBe(".claude2");
  });
});

describe("statuslineSnapshotDirs", () => {
  it("defaults to <home>/statusline when policy.toml configures nothing", () => {
    expect(statuslineSnapshotDirs([], "/Users/test/.headroom")).toEqual(["/Users/test/.headroom/statusline"]);
  });
  it("uses the configured list verbatim when non-empty", () => {
    expect(statuslineSnapshotDirs(["/Users/test/collector/state"], "/Users/test/.headroom")).toEqual(["/Users/test/collector/state"]);
  });
});

describe("snapshotFromStatuslinePayload", () => {
  it("reads Claude Code's rate_limits.five_hour/seven_day with used_percentage, epoch resets_at", () => {
    const payload = { rate_limits: { five_hour: { used_percentage: 37, resets_at: 1_788_635_940 }, seven_day: { used_percentage: 17, resets_at: 1_788_696_000 } } };
    const snapshot = snapshotFromStatuslinePayload(payload, "default", new Date(1_788_631_403 * 1000));
    expect(snapshot).toEqual({
      profile: "default", observed_at: 1_788_631_403,
      five_hour: { used_percent: 37, resets_at: 1_788_635_940 },
      seven_day: { used_percent: 17, resets_at: 1_788_696_000 },
      extra: {},
    });
  });

  it("captures any other rate_limits key into extra, for a future model-scoped bucket", () => {
    const payload = { rate_limits: { five_hour: { used_percentage: 3, resets_at: 100 }, seven_day: { used_percentage: 4, resets_at: 200 }, fable: { used_percentage: 92, resets_at: 300, is_active: false } } };
    const snapshot = snapshotFromStatuslinePayload(payload, "default", new Date(0));
    expect(snapshot?.extra).toEqual({ fable: { used_percent: 92, resets_at: 300, is_active: false } });
  });

  it("returns undefined for a payload with no rate_limits object, or one with no usable bucket", () => {
    expect(snapshotFromStatuslinePayload({ model: "sonnet" }, "default", new Date(0))).toBeUndefined();
    expect(snapshotFromStatuslinePayload({ rate_limits: {} }, "default", new Date(0))).toBeUndefined();
    expect(snapshotFromStatuslinePayload(undefined, "default", new Date(0))).toBeUndefined();
    expect(snapshotFromStatuslinePayload("not an object", "default", new Date(0))).toBeUndefined();
  });
});

describe("parseStatuslineSnapshot", () => {
  it("reads headroom's own shape (profile + used_percent)", () => {
    const raw = JSON.stringify({ profile: "default", observed_at: 100, five_hour: { used_percent: 10, resets_at: 200 }, seven_day: { used_percent: 20, resets_at: 300 }, extra: {} });
    expect(parseStatuslineSnapshot(raw)).toEqual({ profile: "default", observed_at: 100, five_hour: { used_percent: 10, resets_at: 200 }, seven_day: { used_percent: 20, resets_at: 300 }, extra: {} });
  });

  it("reads an existing collector's real on-disk shape (alias + used_pct, no extra)", () => {
    // The exact shape at ~/Projects/<collector>/state/main.json.
    const raw = JSON.stringify({ alias: "main", observed_at: 1_788_631_403, model: "Fable 5.1", cwd: "/Users/test", context_window_used_pct: 90, five_hour: { used_pct: 44, resets_at: 1_788_643_800 }, seven_day: { used_pct: 56.000000001, resets_at: 1_788_696_000 }, source: "statusline" });
    const snapshot = parseStatuslineSnapshot(raw);
    expect(snapshot?.alias).toBe("main");
    expect(snapshot?.observed_at).toBe(1_788_631_403);
    expect(snapshot?.five_hour).toEqual({ used_percent: 44, resets_at: 1_788_643_800 });
    expect(snapshot?.seven_day?.used_percent).toBeCloseTo(56, 5);
    expect(snapshot?.extra).toEqual({});
  });

  it("returns undefined for unparseable JSON, a non-object, or a missing observed_at", () => {
    expect(parseStatuslineSnapshot("not json")).toBeUndefined();
    expect(parseStatuslineSnapshot("[1,2,3]")).toBeUndefined();
    expect(parseStatuslineSnapshot(JSON.stringify({ five_hour: { used_percent: 1, resets_at: 1 } }))).toBeUndefined();
  });

  it("returns undefined when every bucket is unreadable", () => {
    expect(parseStatuslineSnapshot(JSON.stringify({ profile: "default", observed_at: 1, five_hour: {}, seven_day: null }))).toBeUndefined();
  });
});

describe("observationsFromStatuslineSnapshot", () => {
  const snapshot = { profile: "default", observed_at: 1_000, five_hour: { used_percent: 37, resets_at: 1_300 }, seven_day: { used_percent: 17, resets_at: 2_000 }, extra: {} };

  it("emits fresh <principal>:all observations for five_hour (300m) and seven_day (10080m) within the fresh window", () => {
    const rows = observationsFromStatuslineSnapshot(snapshot, "claude-main", new Date(1_000_000 + 5 * 60_000));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 300, kind: "fixed", enforcement: "hard" }), quantity: expect.objectContaining({ used: 37 }), freshness: "fresh", truth: "official", source: "native:claude-statusline" }),
      expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 10_080 }), quantity: expect.objectContaining({ used: 17 }), freshness: "fresh" }),
    ]));
  });

  it("marks the reading stale once the snapshot is older than 10 minutes, still returning the data", () => {
    const rows = observationsFromStatuslineSnapshot(snapshot, "claude-main", new Date(1_000_000 + 11 * 60_000));
    expect(rows.every((row) => row.freshness === "stale")).toBe(true);
  });

  it("maps an extra scoped bucket to <principal>:fable, soft-enforced and vendor_active:false when the vendor flags it inactive but it still carries a percent", () => {
    const withFable = { ...snapshot, extra: { fable: { used_percent: 92, resets_at: 5_000, is_active: false } } };
    const rows = observationsFromStatuslineSnapshot(withFable, "claude-main", new Date(1_000_000));
    const fable = rows.find((row) => row.meter_id === "claude-main:fable");
    expect(fable).toMatchObject({
      quantity: { used: 92, limit: 100, remaining: 8, unit: "percent" },
      window: expect.objectContaining({ enforcement: "soft" }),
      reason: "vendor flags this limit inactive; shown because it carries a cap",
      metadata: { vendor_active: false },
    });
  });

  it("maps a routines-named extra bucket to <principal>:routines and any other name to a slug", () => {
    const withExtras = { ...snapshot, extra: { seven_day_routines: { used_percent: 5, resets_at: 1 }, "Sonnet 5": { used_percent: 8, resets_at: 1 } } };
    const rows = observationsFromStatuslineSnapshot(withExtras, "claude-main", new Date(1_000_000));
    expect(rows.some((row) => row.meter_id === "claude-main:routines")).toBe(true);
    expect(rows.some((row) => row.meter_id === "claude-main:sonnet-5")).toBe(true);
  });
});

describe("latestStatuslineSnapshot / freshStatuslineSnapshot", () => {
  it("matches headroom's own shape by profile derived from account.location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "headroom-statusline-")); temporary.push(dir);
    await writeFile(join(dir, "default.json"), JSON.stringify({ profile: "default", observed_at: Math.floor(Date.now() / 1000), five_hour: { used_percent: 1, resets_at: null }, seven_day: null, extra: {} }));
    const snapshot = await latestStatuslineSnapshot([dir], claudeMain, [claudeMain, claude2]);
    expect(snapshot?.profile).toBe("default");
    const fresh = await freshStatuslineSnapshot([dir], claudeMain, [claudeMain, claude2], new Date());
    expect(fresh).toBeDefined();
    const noneForClaude2 = await freshStatuslineSnapshot([dir], claude2, [claudeMain, claude2], new Date());
    expect(noneForClaude2).toBeUndefined();
  });

  it("matches the external collector shape's alias 'main' to the default profile with zero configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "headroom-statusline-fc-")); temporary.push(dir);
    await writeFile(join(dir, "main.json"), JSON.stringify({ alias: "main", observed_at: Math.floor(Date.now() / 1000), five_hour: { used_pct: 44, resets_at: 0 }, seven_day: { used_pct: 56, resets_at: 0 } }));
    const fresh = await freshStatuslineSnapshot([dir], claudeMain, [claudeMain, claude2], new Date());
    expect(fresh?.alias).toBe("main");
    expect(fresh?.five_hour).toEqual({ used_percent: 44, resets_at: 0 });
  });

  it("matches an explicit accounts.toml alias over the 'main' convention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "headroom-statusline-alias-")); temporary.push(dir);
    await writeFile(join(dir, "claude2.json"), JSON.stringify({ alias: "claude2", observed_at: Math.floor(Date.now() / 1000), five_hour: { used_pct: 12, resets_at: 0 }, seven_day: { used_pct: 34, resets_at: 0 } }));
    const aliasedClaude2: ProviderAccount = { ...claude2, alias: "claude2" };
    const fresh = await freshStatuslineSnapshot([dir], aliasedClaude2, [claudeMain, aliasedClaude2], new Date());
    expect(fresh?.five_hour?.used_percent).toBe(12);
    const noneForMain = await freshStatuslineSnapshot([dir], claudeMain, [claudeMain, aliasedClaude2], new Date());
    expect(noneForMain).toBeUndefined();
  });

  it("returns undefined for a missing directory, an empty directory, and an unparseable file, none of them fatal", async () => {
    const missing = join(tmpdir(), "headroom-statusline-does-not-exist");
    await expect(latestStatuslineSnapshot([missing], claudeMain, [claudeMain])).resolves.toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "headroom-statusline-empty-")); temporary.push(dir);
    await expect(latestStatuslineSnapshot([dir], claudeMain, [claudeMain])).resolves.toBeUndefined();
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "default.json"), "not json");
    await expect(latestStatuslineSnapshot([dir], claudeMain, [claudeMain])).resolves.toBeUndefined();
  });

  it("picks the freshest snapshot when the same principal is matched across two directories", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "headroom-statusline-a-")); temporary.push(dirA);
    const dirB = await mkdtemp(join(tmpdir(), "headroom-statusline-b-")); temporary.push(dirB);
    await writeFile(join(dirA, "default.json"), JSON.stringify({ profile: "default", observed_at: 100, five_hour: { used_percent: 1, resets_at: null }, seven_day: null, extra: {} }));
    await writeFile(join(dirB, "default.json"), JSON.stringify({ profile: "default", observed_at: 200, five_hour: { used_percent: 2, resets_at: null }, seven_day: null, extra: {} }));
    const snapshot = await latestStatuslineSnapshot([dirA, dirB], claudeMain, [claudeMain]);
    expect(snapshot?.observed_at).toBe(200);
  });
});

describe("formatStatuslineBar", () => {
  it("formats 5h and weekly with a same-day HH:MM and a future weekday HH:MM", () => {
    const now = new Date("2026-09-05T12:00:00");
    const snapshot = { profile: "default", observed_at: Math.floor(now.getTime() / 1000), five_hour: { used_percent: 37, resets_at: Math.floor(new Date("2026-09-05T13:19:00").getTime() / 1000) }, seven_day: { used_percent: 17, resets_at: Math.floor(new Date("2026-09-06T14:00:00").getTime() / 1000) }, extra: {} };
    const bar = formatStatuslineBar(snapshot, now);
    expect(bar).toMatch(/^5h 37% ↻\d\d:\d\d \| wk 17% ↻[A-Za-z]{3} \d\d:\d\d$/);
  });

  it("never prints an empty line, even with no snapshot at all", () => {
    expect(formatStatuslineBar(undefined)).toContain("no rate limit data");
  });
});
