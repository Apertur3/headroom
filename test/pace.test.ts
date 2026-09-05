import { describe, expect, it } from "vitest";
import { emptyInSeconds, leastSquaresBurnPerHour, sustainablePercentPerHour, withPaceInfo } from "../src/pace.js";
import type { Observation } from "../src/types.js";

describe("least-squares burn rate", () => {
  it("returns null with fewer than two samples", () => {
    expect(leastSquaresBurnPerHour([])).toBeNull();
    expect(leastSquaresBurnPerHour([{ at: 0, used: 10 }])).toBeNull();
  });

  it("returns null when every sample shares the same timestamp", () => {
    expect(leastSquaresBurnPerHour([{ at: 1000, used: 10 }, { at: 1000, used: 20 }])).toBeNull();
  });

  it("computes exact percent-per-hour on a straight line", () => {
    // 10% used at t=0, 20% used one hour later: exactly 10%/h.
    const hour = 3_600_000;
    const burn = leastSquaresBurnPerHour([{ at: 0, used: 10 }, { at: hour, used: 20 }]);
    expect(burn).toBeCloseTo(10, 6);
  });

  it("fits the best straight line through more than two points, not just the endpoints", () => {
    const hour = 3_600_000;
    // 0%, 10%, 22% at t=0,1h,2h: least-squares slope is 11%/h (not the naive
    // endpoint-only 11%/h either -- this is the real regression check).
    const burn = leastSquaresBurnPerHour([{ at: 0, used: 0 }, { at: hour, used: 10 }, { at: 2 * hour, used: 22 }]);
    expect(burn).toBeCloseTo(11, 6);
  });

  it("is negative for falling usage (a reset mid-lookback)", () => {
    const hour = 3_600_000;
    const burn = leastSquaresBurnPerHour([{ at: 0, used: 90 }, { at: hour, used: 10 }]);
    expect(burn).toBeLessThan(0);
  });
});

describe("empty-in projection", () => {
  it("is null when burn is unknown, zero, or negative", () => {
    expect(emptyInSeconds(50, null)).toBeNull();
    expect(emptyInSeconds(50, 0)).toBeNull();
    expect(emptyInSeconds(50, -5)).toBeNull();
  });

  it("projects seconds to 100% at a constant positive burn", () => {
    // 20% remaining (80% used) at 22%/h -> 20/22 hours -> exactly that many seconds.
    const seconds = emptyInSeconds(80, 22);
    expect(seconds).toBeCloseTo((20 / 22) * 3600, 3);
  });

  it("is zero, not negative, once usage has already reached 100%", () => {
    expect(emptyInSeconds(100, 10)).toBe(0);
    expect(emptyInSeconds(140, 10)).toBe(0);
  });
});

describe("sustainable pace", () => {
  it("is null with no reset time", () => {
    expect(sustainablePercentPerHour(50, null)).toBeNull();
  });

  it("is null once the reset has already passed", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    expect(sustainablePercentPerHour(50, "2026-09-03T11:00:00Z", now)).toBeNull();
  });

  it("divides remaining percent by hours until reset", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    // 45% remaining, 5 hours to reset -> 9%/h.
    expect(sustainablePercentPerHour(45, "2026-09-03T17:00:00Z", now)).toBeCloseTo(9, 6);
  });
});

describe("withPaceInfo", () => {
  function observation(overrides: Partial<Observation> = {}): Observation {
    return {
      principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 40, limit: 100, remaining: 60, unit: "percent" }, resets_at: "2026-09-03T17:00:00Z",
      observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh",
      confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
    };
  }

  it("attaches burn, empty-in and sustainable pace by meter+window key, leaving unmatched observations null", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const withBurn = observation();
    const withoutBurn = observation({ meter_id: "claude-main:fable" });
    const burn = new Map([["claude-main:all:300", { burn_percent_per_hour: 22, empty_in_seconds: 2880 }]]);
    const [first, second] = withPaceInfo([withBurn, withoutBurn], burn, now);
    expect(first).toMatchObject({ burn_percent_per_hour: 22, empty_in_seconds: 2880 });
    expect(first.sustainable_percent_per_hour).toBeCloseTo(60 / 5, 6);
    expect(second).toMatchObject({ burn_percent_per_hour: null, empty_in_seconds: null });
  });

  it("does not mutate the input observations", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const original = observation();
    withPaceInfo([original], new Map(), now);
    expect((original as Partial<Observation>).burn_percent_per_hour).toBeUndefined();
  });
});
