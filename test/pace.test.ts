import { describe, expect, it } from "vitest";
import { effectiveFreshness, emptyInSeconds, leastSquaresBurnPerHour, sustainablePercentPerHour, withLastKnown, withPaceInfo, withStatusInfo } from "../src/pace.js";
import type { LastKnownReading, Observation } from "../src/types.js";

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

describe("withLastKnown", () => {
  function observation(overrides: Partial<Observation> = {}): Observation {
    return {
      principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 40, limit: 100, remaining: 60, unit: "percent" }, resets_at: "2026-09-03T17:00:00Z",
      observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh",
      confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
    };
  }

  const reading: LastKnownReading = { used_percent: 41, resets_at: "2026-09-03T05:00:00Z", observed_at: "2026-09-03T00:05:00Z", age_seconds: 3900 };

  it("attaches last_known only to a failed or stale observation, by meter+window key", () => {
    const map = new Map([["claude-main:all:300", reading]]);
    const [failed, stale, fresh] = withLastKnown(
      [observation({ freshness: "failed", quantity: null }), observation({ freshness: "stale" }), observation()],
      map,
    );
    expect(failed.last_known).toEqual(reading);
    expect(stale.last_known).toEqual(reading);
    expect(fresh.last_known).toBeNull();
  });

  it("is null when the map has nothing for this meter and window", () => {
    const [item] = withLastKnown([observation({ freshness: "failed", quantity: null })], new Map());
    expect(item.last_known).toBeNull();
  });

  it("does not mutate the input observations", () => {
    const original = observation({ freshness: "failed", quantity: null });
    withLastKnown([original], new Map([["claude-main:all:300", reading]]));
    expect((original as Partial<Observation>).last_known).toBeUndefined();
  });

  it("looks a windowless failure up by meter:none, since the failure speaks for the whole meter and not one window of it", () => {
    const borrowed: LastKnownReading = { used_percent: 41, resets_at: "2026-09-10T00:00:00Z", observed_at: "2026-09-03T00:05:00Z", age_seconds: 21_600, window_minutes: 10_080 };
    const map = new Map([["claude-main:all:none", borrowed]]);
    const [failed] = withLastKnown([observation({ window: null, quantity: null, freshness: "failed" })], map);
    expect(failed.last_known).toEqual(borrowed);
  });

  it("is null for a windowless failure when the map has nothing under meter:none", () => {
    const map = new Map([["claude-main:all:300", reading]]);
    const [failed] = withLastKnown([observation({ window: null, quantity: null, freshness: "failed" })], map);
    expect(failed.last_known).toBeNull();
  });
});

describe("effectiveFreshness", () => {
  function observation(overrides: Partial<Observation> = {}): Observation {
    return {
      principal_id: "codex-main", meter_id: "codex-main:spark", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
      quantity: { used: 40, limit: 100, remaining: 60, unit: "percent" }, resets_at: "2026-09-10T12:00:00Z",
      observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh",
      confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
    };
  }

  const now = new Date("2026-09-03T12:00:00Z");

  it("keeps a fresh row inside the policy staleness window unchanged", () => {
    const row = observation({ fetched_at: "2026-09-03T11:46:00Z" });
    expect(effectiveFreshness(row, 15, now)).toEqual({ freshness: "fresh", reason: undefined });
  });

  it("serves an old fresh row as stale and preserves its held-window explanation", () => {
    const row = observation({
      fetched_at: "2026-09-03T10:00:00Z", metadata: { vendor_window_held: true }, reason: "new window unconfirmed, holding",
    });
    expect(effectiveFreshness(row, 15, now)).toEqual({
      freshness: "stale", reason: "last accepted reading 2h ago; new window unconfirmed, holding",
    });
  });

  it("serves a held row (recent, well inside the staleness window) as stale immediately -- never capacity", () => {
    // Inside stalenessMinutes there is no age story to tell yet, so the
    // reason passes through unchanged; a renderer that wants held-specific
    // wording (browser-report, dashboard, status-view) builds it straight
    // from the metadata flags instead of this field.
    const row = observation({
      fetched_at: "2026-09-03T11:59:00Z", metadata: { vendor_window_held: true }, reason: "new window unconfirmed, holding",
    });
    expect(effectiveFreshness(row, 15, now)).toEqual({
      freshness: "stale", reason: "new window unconfirmed, holding",
    });
  });

  it("serves a vendor_inconsistent row as stale immediately too", () => {
    const row = observation({ fetched_at: "2026-09-03T11:59:00Z", metadata: { vendor_inconsistent: true } });
    expect(effectiveFreshness(row, 15, now).freshness).toBe("stale");
  });

  it("passes through stored stale, failed and not_enforced rows", () => {
    for (const freshness of ["stale", "failed", "not_enforced"] as const) {
      const row = observation({ freshness, reason: `${freshness} reason`, fetched_at: "2026-08-01T12:00:00Z" });
      expect(effectiveFreshness(row, 1, now)).toEqual({ freshness, reason: `${freshness} reason` });
    }
  });

  it("matches policy's non-age-gated state and count rows", () => {
    const old = "2026-08-01T12:00:00Z";
    const state = observation({ window: { kind: "state", minutes: null, enforcement: "hard" }, fetched_at: old, metadata: { state: "UP" } });
    const count = observation({ window: { kind: "count", minutes: null, enforcement: "soft" }, fetched_at: old });
    expect(effectiveFreshness(state, 1, now)).toEqual({ freshness: "fresh", reason: undefined });
    expect(effectiveFreshness(count, 1, now)).toEqual({ freshness: "fresh", reason: undefined });
  });

  it("serves an invalid fetched_at as stale rather than fresh", () => {
    expect(effectiveFreshness(observation({ fetched_at: "not a timestamp" }), 15, now)).toEqual({ freshness: "stale", reason: "invalid fetch time" });
  });

  it("uses the supplied staleness_minutes and attaches last_known after a fresh row ages out", () => {
    const row = observation({ fetched_at: "2026-09-03T11:50:00Z" });
    expect(effectiveFreshness(row, 15, now).freshness).toBe("fresh");
    const known: LastKnownReading = { used_percent: 39, resets_at: row.resets_at, observed_at: "2026-09-03T11:49:00Z", age_seconds: 660 };
    const [served] = withStatusInfo([row], new Map(), new Map([["codex-main:spark:10080", known]]), 5, now);
    expect(served).toMatchObject({ freshness: "stale", last_known: known });
  });

  it("marks the complete response enrichment instant", () => {
    const [served] = withStatusInfo([observation()], new Map(), new Map(), 15, now);
    expect(served.status_enriched_at).toBe(now.toISOString());
  });
});
