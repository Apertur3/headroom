import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMeters, main } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";
import { defaultPolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function seededHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-cli-pacing-"));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/** ISO timestamp `offsetMs` from the real current time -- these CLI/MCP
 * commands read the real system clock internally (like `status`/`can`
 * already do), so fixtures are anchored to Date.now() rather than a fixed
 * date, staying valid however long a session has been running. */
function at(offsetMs: number): string { return new Date(Date.now() + offsetMs).toISOString(); }

function fiveHour(used: number, fetchedAtOffsetMs: number, resetsAtOffsetMs: number, meterId = "claude-main:all"): Observation {
  const fetchedAt = at(fetchedAtOffsetMs);
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: at(resetsAtOffsetMs),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function weekly(used: number, fetchedAtOffsetMs: number, resetsAtOffsetMs: number, meterId = "claude-main:all"): Observation {
  const fetchedAt = at(fetchedAtOffsetMs);
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: at(resetsAtOffsetMs),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("headroom cost", () => {
  it("prints the learned median/IQR/sample-count for a class, and reports plainly when there is none yet", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.startLease("cadence", "codex-main:main", null, HOUR, null, new Date(), "review");
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["cost", "review", "--json"])).toBe(0);
        expect(await main(["cost", "nonexistent"])).toBe(0);
      });
    } finally { restore(); }
    expect(JSON.parse(logs[0])).toEqual([expect.objectContaining({ action_class: "review", sample_count: 1, median_percent: 0 })]);
    expect(logs[1]).toContain("no learned cost for nonexistent");
  });
});

describe("headroom rate", () => {
  it("reports the burn and a stall projection for a meter with two recent fresh samples", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(10, -20 * 60_000, 5 * HOUR));
    store.insert(fiveHour(70, 0, 5 * HOUR));
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["rate", "--meter", "claude-main:all", "--json"])).toBe(0);
      });
    } finally { restore(); }
    const lines = JSON.parse(logs[0]);
    expect(lines).toEqual([expect.objectContaining({ meter: "claude-main:all", window_minutes: 300 })]);
    expect(lines[0].burn_percent_per_hour).toBeCloseTo(180, 0);
  });
});

describe("status line pace segment formatting", () => {
  it("shows a sub-1%/h rate with one decimal instead of rounding it away to 0", () => {
    const observation: Observation = { ...fiveHour(10, 0, 5 * HOUR), burn_percent_per_hour: 0.05, sustainable_percent_per_hour: 0.2 } as Observation;
    const [line] = formatMeters([observation], defaultPolicy);
    expect(line).toContain("burn 0.1%/h, ok 0.2%/h");
  });

  it("omits the burn segment entirely (not 'burn 0%/h') when burn is null", () => {
    const observation: Observation = { ...fiveHour(10, 0, 5 * HOUR), burn_percent_per_hour: null, sustainable_percent_per_hour: null } as Observation;
    const [line] = formatMeters([observation], defaultPolicy);
    expect(line).not.toContain("burn");
  });

  it("still rounds an ordinary whole-number rate the old way", () => {
    const observation: Observation = { ...fiveHour(10, 0, 5 * HOUR), burn_percent_per_hour: 22.4, sustainable_percent_per_hour: 9.6 } as Observation;
    const [line] = formatMeters([observation], defaultPolicy);
    expect(line).toContain("burn 22%/h, ok 10%/h");
  });
});

describe("headroom plan", () => {
  it("prints points per remaining 5h window and the plan line, in --json too", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(0, 0, 5 * HOUR));
    store.insert(weekly(40, 0, 24 * HOUR)); // 24h to reset
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["plan", "--meter", "claude-main:all", "--until", "reset", "--reserve", "10", "--json"])).toBe(0);
      });
    } finally { restore(); }
    const result = JSON.parse(logs[0]);
    expect(result).toMatchObject({ meter: "claude-main:all", weekly_remaining_percent: 60, reserve_percent: 10, remaining_5h_windows: 5 });
    expect(result.points_per_5h_window).toBeCloseTo(10, 6);
  });
});

describe("headroom gate", () => {
  it("exits 0 when the request fits and 2 with a named reason when it would cross the reserve", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(80, 0, HOUR));
    store.close();
    await withHeadroomHome(home, async () => {
      expect(await main(["gate", "--need", "5h:5", "--meter", "claude-main:all", "--owner", "x"])).toBe(0);
      expect(await main(["gate", "--need", "5h:15", "--meter", "claude-main:all", "--owner", "x"])).toBe(2);
    });
  });

  it("requires --meter or --class", async () => {
    const home = await seededHome();
    await withHeadroomHome(home, async () => {
      await expect(main(["gate", "--need", "5h:5", "--owner", "x"])).rejects.toThrow("--meter <meter_id> | --class <action-class>");
    });
  });
});

describe("headroom wait", () => {
  it("exits 0 immediately once the stored resets_at has already passed", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(10, -HOUR, -30 * 60_000)); // resets_at 30 minutes in the past
    store.close();
    await withHeadroomHome(home, async () => {
      expect(await main(["wait", "--meter", "claude-main:all", "--until-reset", "--max", "1m"])).toBe(0);
    });
  });

  it("exits 1 when the meter has no windowed reading to wait on", async () => {
    const home = await seededHome();
    await withHeadroomHome(home, async () => {
      expect(await main(["wait", "--meter", "claude-main:all", "--until-reset"])).toBe(1);
    });
  });

  it("accepts a seconds --max like 5s (not just m/h/d)", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(10, -HOUR, -30 * 60_000)); // resets_at already in the past
    store.close();
    await withHeadroomHome(home, async () => {
      expect(await main(["wait", "--meter", "claude-main:all", "--until-reset", "--max", "5s"])).toBe(0);
    });
  });

  it("rejects a malformed --max before ever reading the store", async () => {
    // waitForReset's own "timeout" outcome (and its exit-3 mapping) is
    // covered directly in pacing.test.ts with an injected fake clock, which
    // exercises the real timing logic without a slow real-time CLI wait;
    // this checks the CLI's --max parsing fails closed on bad input.
    const home = await seededHome();
    await withHeadroomHome(home, async () => {
      await expect(main(["wait", "--meter", "claude-main:all", "--until-reset", "--max", "soon"])).rejects.toThrow("--max must be like");
      // no store was ever opened by main() here (the above error throws before any HeadroomStore.open call in wait()).
    });
  });
});

describe("headroom fill", () => {
  it("exits 0 with a positive lane count, and 2 once the weekly reserve is already spent", async () => {
    // pacing "none": this test is about the plain lane-count/weekly-reserve
    // rule, not the even-pacing pro-rata restriction (covered separately in
    // orchestrator-reads.test.ts).
    const home = await seededHome();
    await writeFile(join(home, "policy.toml"), 'pacing = "none"\n', { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(85, 0, 5 * HOUR));
    store.insert(weekly(20, 0, 7 * DAY));
    store.close();
    await withHeadroomHome(home, async () => {
      expect(await main(["fill", "--meter", "claude-main:all", "--until-reset", "--lane-cost", "2", "--owner", "x"])).toBe(0);
    });

    const home2 = await seededHome();
    await writeFile(join(home2, "policy.toml"), 'pacing = "none"\n', { mode: 0o600 });
    const store2 = await HeadroomStore.open(home2);
    store2.insert(fiveHour(20, 0, 5 * HOUR));
    store2.insert(weekly(90, 0, 7 * DAY)); // at the default 10% reserve
    store2.close();
    await withHeadroomHome(home2, async () => {
      expect(await main(["fill", "--meter", "claude-main:all", "--until-reset", "--lane-cost", "2", "--owner", "x"])).toBe(2);
    });
  });
});

describe("live shape: codex-main:main with 5h not_enforced, weekly fresh (reported live-fail repro)", () => {
  // Copied field-for-field from a real `headroom --principal codex-main --json`
  // dump (per the maintainer's live report): exactly one enforced observation
  // for codex-main:main (the weekly window, fresh at 83%) plus a vendor-
  // confirmed not_enforced 5h row with no quantity at all. Only fetched_at/
  // resets_at are shifted to `at()` offsets so the fixture never goes stale;
  // every other field, including the exact quantity and window shapes, is
  // verbatim.
  function seedCodexMainFixture(store: HeadroomStore): void {
    store.insert({
      principal_id: "codex-main", meter_id: "codex-main:main",
      window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: null, resets_at: null,
      observed_at: at(0), fetched_at: at(0), source: "native:codex", truth: "official",
      freshness: "not_enforced", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4",
      reason: "no 5-hour window from endpoint or session logs",
    });
    store.insert({
      principal_id: "codex-main", meter_id: "codex-main:main",
      window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
      quantity: { used: 83, limit: 100, remaining: 17, unit: "percent" }, resets_at: at(5 * DAY + 8 * 60_000),
      observed_at: at(0), fetched_at: at(0), source: "native:codex", truth: "official",
      freshness: "fresh", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4",
    });
  }

  it("plan resolves the weekly window instead of 'no weekly window for codex-main:main'", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    seedCodexMainFixture(store);
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["plan", "--meter", "codex-main:main", "--until", "reset", "--reserve", "10", "--json"])).toBe(0);
      });
    } finally { restore(); }
    const result = JSON.parse(logs[0]);
    expect(result).toMatchObject({ meter: "codex-main:main", weekly_remaining_percent: 17, reserve_percent: 10 });
  });

  it("gate evaluates the wk need against the real 83% used instead of 'wk usage unknown'", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    seedCodexMainFixture(store);
    store.close();
    await withHeadroomHome(home, async () => {
      expect(await main(["gate", "--meter", "codex-main:main", "--need", "wk:3", "--owner", "headroom"])).toBe(0);
      // 83 + 15 = 98, over the 90% ceiling (100 - 10% reserve): must refuse on
      // the real weekly number, not silently pass a stale/unknown one.
      expect(await main(["gate", "--meter", "codex-main:main", "--need", "wk:15", "--owner", "headroom"])).toBe(2);
    });
  });

  it("fill uses the weekly window (not a 0%-remaining phantom 5h reading) and reports which window it used", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    seedCodexMainFixture(store);
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["fill", "--meter", "codex-main:main", "--until-reset", "--lane-cost", "2", "--owner", "headroom", "--json"])).toBe(0);
      });
    } finally { restore(); }
    const result = JSON.parse(logs[0]);
    expect(result.window_used).toBe("wk");
    expect(result.used_weekly_percent).toBe(83);
    // Weekly budget = 100 - 83 - 10(reserve) = 7; at 2 pts/lane -> 3 lanes.
    // The old bug reported "5h window has only 0.0% left" and 0 lanes.
    expect(result.lanes).toMatchObject({ lanes: 3 });
  });
});

describe("live shape: codex-main:main with no stored 5h row at all, alternating fresh/stale weekly", () => {
  // The real live defect, confirmed against a copy of the maintainer's actual
  // headroom.db: this account polls through the native Swift engine, which
  // never stores a 5h row at all (not even a not_enforced placeholder) --
  // only ~674 weekly rows exist, all window {kind:"fixed",minutes:10080}.
  // A buggy source re-inserted the same old (07:31) stale weekly reading on
  // every poll alongside the endpoint's own genuinely fresh one. Both
  // defects together (a selection rule that could be led to a non-fresh row,
  // and no stored 5h window at all leaving no genuine second window to
  // resolve `long` against) made plan/gate/status miss the real 83% usage.
  function seedAlternatingWeekly(store: HeadroomStore): void {
    const weekly = (offsetMs: number, freshness: "fresh" | "stale", used: number, metadata?: Observation["metadata"]) => ({
      principal_id: "codex-main", meter_id: "codex-main:main",
      window: { kind: "fixed" as const, minutes: 10_080, enforcement: "hard" as const },
      quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" as const }, resets_at: at(5 * DAY + 8 * 60_000),
      observed_at: at(offsetMs), fetched_at: at(offsetMs), source: freshness === "fresh" ? "native:codex" : "native:codex:session-log",
      truth: "official" as const, freshness, confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4",
      ...(metadata ? { metadata } : {}),
    });
    store.insert(weekly(-6 * HOUR, "fresh", 80));
    store.insert(weekly(-5 * HOUR - 29 * 60_000, "stale", 83));
    store.insert(weekly(0, "fresh", 83, { plan: "prolite", free_resets_available: 2 }));
    store.insert(weekly(-5 * HOUR - 29 * 60_000, "stale", 83));
  }

  it("plan resolves the weekly window from the fresh reading, not the repeatedly re-inserted stale one", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    seedAlternatingWeekly(store);
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["plan", "--meter", "codex-main:main", "--until", "reset", "--reserve", "10", "--json"])).toBe(0);
      });
    } finally { restore(); }
    const result = JSON.parse(logs[0]);
    expect(result).toMatchObject({ meter: "codex-main:main", weekly_remaining_percent: 17 });
  });

  it("gate evaluates the wk need against the real 83%, not 'wk usage unknown'", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    seedAlternatingWeekly(store);
    store.close();
    await withHeadroomHome(home, async () => {
      expect(await main(["gate", "--meter", "codex-main:main", "--need", "wk:3", "--owner", "headroom"])).toBe(0);
      expect(await main(["gate", "--meter", "codex-main:main", "--need", "wk:15", "--owner", "headroom"])).toBe(2);
    });
  });

  it("status shows the fresh 83% weekly line, not UNKNOWN or a missing window", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    seedAlternatingWeekly(store);
    const lines = formatMeters(store.latestPerWindow("codex-main:main"), defaultPolicy);
    store.close();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("wk 83%");
  });
});

describe("headroom can: learned cost and --lease", () => {
  it("reports the learned median as the expected cost with no --expect, and --lease records a new lease under the action class", async () => {
    const home = await seededHome();
    await writeFile(join(home, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:all"]\n', { mode: 0o600 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    // Two prior "claude-fable" leases, each on its own throwaway meter so
    // neither lease's active window can capture the other's delta, each
    // with an isolated 4-point spend to learn a clean median. `can`'s own
    // decision is evaluated against claude-main:all separately below.
    for (const [index, meterId] of ["claude-main:practice-1", "claude-main:practice-2"].entries()) {
      const startedAt = new Date(Date.now() + index * 1000);
      store.startLease("cadence", meterId, null, HOUR, null, startedAt, "claude-fable");
      store.insert(fiveHour(0, startedAt.getTime() - Date.now(), 5 * HOUR, meterId));
      store.insert(fiveHour(4, startedAt.getTime() - Date.now() + 500, 5 * HOUR, meterId));
    }
    store.insert(fiveHour(10, 0, 5 * HOUR)); // claude-main:all: what `can` actually decides against
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        const code = await main(["can", "claude-fable", "--owner", "cadence", "--lease", "--json"]);
        expect(code).toBe(0);
        const result = JSON.parse(logs[0]);
        expect(result.cost).toMatchObject({ source: "learned", expected_percent: 4, sample_count: 2 });
        expect(result.leased_id).toBeTruthy();
      });
    } finally { restore(); }

    const after = await HeadroomStore.open(home);
    try {
      const leases = after.leases("claude-main:all", true, new Date(Date.now() + 60_000));
      expect(leases.some((lease) => lease.owner === "cadence" && lease.action_class === "claude-fable" && lease.expected_percent === 4)).toBe(true);
    } finally { after.close(); }
  });

  it("uses an explicit --expect over the learned median", async () => {
    const home = await seededHome();
    await writeFile(join(home, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:all"]\n', { mode: 0o600 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(10, 0, 5 * HOUR));
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["can", "claude-fable", "--owner", "cadence", "--expect", "12", "--json"])).toBe(0);
        expect(JSON.parse(logs[0]).cost).toMatchObject({ source: "given", expected_percent: 12, confidence: "high" });
      });
    } finally { restore(); }
  });
});

describe("MCP quota_cost / quota_rate / quota_plan / quota_gate / quota_wait (direct, no daemon)", () => {
  const noDaemon = async () => undefined;

  it("quota_cost returns the learned summary", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.startLease("cadence", "codex-main:main", null, HOUR, null, new Date(), "review");
    store.close();
    await withHeadroomHome(home, async () => {
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_cost","arguments":{"action_class":"review"}}}', noDaemon);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", items: [expect.objectContaining({ action_class: "review", sample_count: 1 })] } } });
    });
  });

  it("quota_rate returns burn lines for a meter", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(10, -20 * 60_000, 5 * HOUR));
    store.insert(fiveHour(70, 0, 5 * HOUR));
    store.close();
    await withHeadroomHome(home, async () => {
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_rate","arguments":{"meter":"claude-main:all"}}}', noDaemon);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", lines: [expect.objectContaining({ meter: "claude-main:all" })] } } });
      const lines = (response as { result: { structuredContent: { lines: Array<{ burn_percent_per_hour: number | null }> } } }).result.structuredContent.lines;
      expect(lines[0].burn_percent_per_hour).toBeCloseTo(180, 0);
    });
  });

  it("quota_plan returns the points per window and the plan line", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(0, 0, 5 * HOUR));
    store.insert(weekly(40, 0, 24 * HOUR));
    store.close();
    await withHeadroomHome(home, async () => {
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_plan","arguments":{"meter":"claude-main:all","reserve_percent":10}}}', noDaemon);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", meter: "claude-main:all", remaining_5h_windows: 5 } } });
    });
  });

  it("quota_gate refuses a need that would cross the reserve", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour(80, 0, HOUR));
    store.close();
    await withHeadroomHome(home, async () => {
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_gate","arguments":{"needs":["5h:15"],"meter":"claude-main:all"}}}', noDaemon);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", allowed: false } } });
    });
  });

  it("quota_wait returns immediately with the reset time and a suggested sleep, never blocking", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    const resetsAt = at(5 * HOUR);
    store.insert({ ...fiveHour(10, 0, 0), resets_at: resetsAt });
    store.close();
    await withHeadroomHome(home, async () => {
      const start = Date.now();
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_wait","arguments":{"meter":"claude-main:all"}}}', noDaemon);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(response).toMatchObject({ result: { structuredContent: { source: "direct", meter: "claude-main:all" } } });
      const content = (response as { result: { structuredContent: { resets_at: string; suggested_sleep_seconds: number } } }).result.structuredContent;
      expect(content.resets_at).toBe(resetsAt);
      expect(content.suggested_sleep_seconds).toBeGreaterThan(0);
      expect(content.suggested_sleep_seconds).toBeLessThanOrEqual(3600);
    });
  });
});
