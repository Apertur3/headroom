import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fillFor, gateFor, planFor, rateLines } from "../src/orchestrator-reads.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function open(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-orchestrator-reads-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

function fiveHour(used: number, fetchedAt: string, resetsAt: string, meterId = "claude-main:all"): Observation {
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function weekly(used: number, fetchedAt: string, resetsAt: string, meterId = "claude-main:all"): Observation {
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

describe("rateLines", () => {
  it("reports every window of a given meter, unknown-burn windows included", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(10, "2026-09-03T11:00:00Z", "2026-09-03T16:00:00Z"));
      store.insert(fiveHour(30, "2026-09-03T12:00:00Z", "2026-09-03T16:00:00Z"));
      store.insert(weekly(50, "2026-09-03T12:00:00Z", "2026-09-10T12:00:00Z"));
      const now = new Date("2026-09-03T12:00:00Z");
      const lines = rateLines(store, "claude-main:all", 60, now);
      expect(lines).toHaveLength(2);
      const fiveHourLine = lines.find((line) => line.window_minutes === 300)!;
      expect(fiveHourLine.burn_percent_per_hour).toBeCloseTo(20, 6);
      const weeklyLine = lines.find((line) => line.window_minutes === 10_080)!;
      expect(weeklyLine.burn_percent_per_hour).toBeNull(); // only one weekly sample
    } finally { store.close(); }
  });

  it("without a meter, reports only each meter's shortest window", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(10, "2026-09-03T12:00:00Z", "2026-09-03T16:00:00Z", "claude-main:all"));
      store.insert(weekly(20, "2026-09-03T12:00:00Z", "2026-09-10T12:00:00Z", "claude-main:all"));
      store.insert(fiveHour(5, "2026-09-03T12:00:00Z", "2026-09-03T16:00:00Z", "codex-main:main"));
      const lines = rateLines(store, undefined, 60, new Date("2026-09-03T12:00:00Z"));
      expect(lines.map((line) => `${line.meter}:${line.window_minutes}`).sort()).toEqual(["claude-main:all:300", "codex-main:main:300"]);
    } finally { store.close(); }
  });
});

describe("planFor", () => {
  it("errors clearly when the meter has no weekly window yet", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(10, "2026-09-03T12:00:00Z", "2026-09-03T16:00:00Z"));
      const result = planFor(store, "claude-main:all", 10, new Date("2026-09-03T12:00:00Z"));
      expect(result).toMatchObject({ meter: "claude-main:all", error: expect.stringContaining("no weekly window") });
    } finally { store.close(); }
  });

  it("uses the meter's own short-window duration for the plan's hours-per-window", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(0, "2026-09-03T12:00:00Z", "2026-09-03T16:00:00Z"));
      store.insert(weekly(40, "2026-09-03T12:00:00Z", "2026-09-04T12:00:00Z")); // 24h to reset
      const result = planFor(store, "claude-main:all", 10, new Date("2026-09-03T12:00:00Z"));
      if ("error" in result) throw new Error("expected a plan, not an error");
      expect(result.hours_per_window).toBe(5);
      expect(result.remaining_5h_windows).toBe(5); // ceil(24/5)
    } finally { store.close(); }
  });
});

describe("gateFor: plain reserve and plan-line checks", () => {
  it("allows a need that fits and refuses one that would cross the reserve", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(80, "2026-09-03T12:00:00Z", "2026-09-03T13:00:00Z"));
      const now = new Date("2026-09-03T12:00:00Z");
      expect(gateFor(store, [{ window: "5h", points: 5 }], "claude-main:all", 10, false, now)).toMatchObject({ allowed: true });
      expect(gateFor(store, [{ window: "5h", points: 15 }], "claude-main:all", 10, false, now)).toMatchObject({ allowed: false });
    } finally { store.close(); }
  });

  it("checks every meter when no --meter is given, failing closed on the first that does not fit", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(10, "2026-09-03T12:00:00Z", "2026-09-03T17:00:00Z", "claude-main:all"));
      store.insert(fiveHour(95, "2026-09-03T12:00:00Z", "2026-09-03T17:00:00Z", "codex-main:main"));
      const result = gateFor(store, [{ window: "5h", points: 1 }], undefined, 10, false, new Date("2026-09-03T12:00:00Z"));
      expect(result.allowed).toBe(false);
      expect(result.meters_checked).toContain("codex-main:main");
    } finally { store.close(); }
  });
});

describe("gateFor: even pacing (pro-rata line + burst)", () => {
  it("refuses a burst: twelve lanes spiking a window from 1% to 23% inside 10 minutes, far ahead of a 4 pts/h plan", async () => {
    const store = await open();
    const resetsAt = "2026-09-03T17:00:00Z"; // 5h window, plenty of time left
    store.insert(fiveHour(1, "2026-09-03T11:29:00Z", resetsAt));
    store.insert(fiveHour(15, "2026-09-03T11:50:00Z", resetsAt));
    store.insert(fiveHour(19, "2026-09-03T11:55:00Z", resetsAt));
    store.insert(fiveHour(23, "2026-09-03T12:00:00Z", resetsAt)); // now
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      // Planned share: 20 points for this 5h window -> plan rate 4 pts/h.
      const result = gateFor(store, [{ window: "5h", points: 2 }], "claude-main:all", 10, false, now, { owner: "orchestrator", planSharePercent: 20, pacing: "even" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("burst:");
      expect(result.reason).toMatch(/hold until \d{2}:\d{2}/);
    } finally { store.close(); }
  });

  it("passes an even, on-plan spend at the same plan rate", async () => {
    const store = await open();
    const resetsAt = "2026-09-03T17:00:00Z"; // window started at 12:00 (5h before 17:00)
    // A steady ~4%/h climb, exactly the plan rate, sampled every 10 minutes.
    store.insert(fiveHour(3.0, "2026-09-03T12:45:00Z", resetsAt));
    store.insert(fiveHour(3.67, "2026-09-03T12:55:00Z", resetsAt));
    store.insert(fiveHour(4.0, "2026-09-03T13:00:00Z", resetsAt)); // now: 1h into the window
    try {
      const now = new Date("2026-09-03T13:00:00Z");
      const result = gateFor(store, [{ window: "5h", points: 2 }], "claude-main:all", 10, false, now, { owner: "orchestrator", planSharePercent: 20, pacing: "even" });
      expect(result.allowed).toBe(true);
    } finally { store.close(); }
  });

  it("skips the pro-rata and burst checks entirely when policy.toml sets pacing to none", async () => {
    const store = await open();
    const resetsAt = "2026-09-03T17:00:00Z";
    store.insert(fiveHour(1, "2026-09-03T11:50:00Z", resetsAt));
    store.insert(fiveHour(23, "2026-09-03T12:00:00Z", resetsAt));
    try {
      const now = new Date("2026-09-03T12:00:00Z");
      // Same burst as the refusal test above, but pacing "none" -- the plain
      // reserve check still applies (and passes: 23+2=25 is well under 90).
      const result = gateFor(store, [{ window: "5h", points: 2 }], "claude-main:all", 10, false, now, { owner: "orchestrator", planSharePercent: 20, pacing: "none" });
      expect(result.allowed).toBe(true);
    } finally { store.close(); }
  });

  it("reports the caller's remaining lane count for a learned action class alongside an allowed gate", async () => {
    const store = await open();
    try {
      store.insert(fiveHour(60, "2026-09-03T12:00:00Z", "2026-09-03T17:00:00Z"));
      const now = new Date("2026-09-03T12:00:00Z");
      store.startLease("cadence", "claude-main:all", null, 60_000, null, now, "review");
      store.insert({ ...fiveHour(64, "2026-09-03T12:00:01Z", "2026-09-03T17:00:00Z") }); // +4 spent under the lease
      const result = gateFor(store, [{ window: "5h", points: 1 }], "claude-main:all", 10, false, new Date("2026-09-03T12:00:01Z"), { actionClass: "review", pacing: "none" });
      expect(result.allowed).toBe(true);
      expect(result.lanes_remaining_for_class).not.toBeUndefined();
    } finally { store.close(); }
  });
});

describe("fillFor: even pacing restricts the offer before the final stretch", () => {
  it("offers only the pro-rata allowance well before reset under even pacing", async () => {
    const store = await open();
    const resetsAt = "2026-09-03T17:00:00Z"; // 5h window starting at 12:00, now 1h in -> not the final 45 minutes
    store.insert(fiveHour(10, "2026-09-03T13:00:00Z", resetsAt));
    const now = new Date("2026-09-03T13:00:00Z");
    store.startLease("orchestrator", "claude-main:all", null, 3_600_000, null, now);
    try {
      const result = await fillFor(store, "claude-main:all", 2, 10, now, { owner: "orchestrator", planSharePercent: 20, pacing: "even" });
      if ("error" in result) throw new Error("expected a fill result");
      expect(result.allowance_basis).toBe("pro_rata");
      // 1h elapsed of a 5h window at a 20-point plan share -> line = 4 points,
      // no owner spend yet -> lanes bounded by ~4 points (minus margin), not 100-10.
      expect(result.lanes!.lanes).toBeLessThan(computeFullLanes());
      function computeFullLanes(): number { return Math.floor((100 - 10 - 5) / 2); }
    } finally { store.close(); }
  });

  it("offers the full remaining window in the last 45 minutes before reset even under even pacing", async () => {
    const store = await open();
    const resetsAt = "2026-09-03T16:40:00Z"; // 20 minutes away: inside the final 45-minute stretch
    store.insert(fiveHour(10, "2026-09-03T16:20:00Z", resetsAt));
    const now = new Date("2026-09-03T16:20:00Z");
    try {
      const result = await fillFor(store, "claude-main:all", 2, 10, now, { owner: "orchestrator", planSharePercent: 20, pacing: "even" });
      if ("error" in result) throw new Error("expected a fill result");
      expect(result.allowance_basis).toBe("full");
      expect(result.lanes!.lanes).toBe(Math.floor((100 - 10 - 5) / 2));
    } finally { store.close(); }
  });

  it("never restricts the offer when pacing is none", async () => {
    const store = await open();
    const resetsAt = "2026-09-03T17:00:00Z";
    store.insert(fiveHour(10, "2026-09-03T13:00:00Z", resetsAt));
    const now = new Date("2026-09-03T13:00:00Z");
    try {
      const result = await fillFor(store, "claude-main:all", 2, 10, now, { owner: "orchestrator", planSharePercent: 20, pacing: "none" });
      if ("error" in result) throw new Error("expected a fill result");
      expect(result.allowance_basis).toBe("full");
      expect(result.lanes!.lanes).toBe(Math.floor((100 - 10 - 5) / 2));
    } finally { store.close(); }
  });
});
