// Types for the percent-first forecaster (#146, phase 1a).
//
// Everything here is percent of a meter's limit. A "draw" is the percent a
// meter consumed from one moment until its window reset; the forecaster
// predicts the draw for the current window from the draws of past windows at
// a similar point in their life.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** One usable meter reading (a fresh percent observation). */
export interface MeterReading {
  /** Epoch ms the reading was observed. */
  at: number;
  /** Percent used, 0..100. */
  used: number;
  /** Epoch ms the current window resets, or null when the vendor reports none. */
  resetsAt: number | null;
  /** Window kind as the vendor reported it on this reading ("fixed", "rolling", ...). */
  kind?: string;
}

/** One window of a meter, from its first non-idle reading to its reset. */
export interface Cycle {
  /** Latest reset time reported inside the cycle (vendors jitter by a minute). */
  resetsAt: number;
  windowMinutes: number;
  /** Non-idle readings inside the window, ascending by `at`. */
  readings: MeterReading[];
}

/** A lease as the forecaster needs it. Only fields known at `startedAt`/`endedAt`. */
export interface LeaseRecord {
  actionClass: string | null;
  startedAt: number;
  /** Null while the lease is still running. */
  endedAt: number | null;
  /** Percent the lease spent, known once it ended; null when not recorded. */
  spentPercent: number | null;
}

/** One training sample: what a past window drew from a given moment until its reset. */
export interface DrawSample {
  /** Identifies the window the sample came from (its reset time). */
  cycleId: number;
  at: number;
  used: number;
  /** Max percent used from `at` until the reset, minus `used`; never negative. */
  draw: number;
  htrBucket: number;
  howBucket: number;
  loadBucket: number;
  /** Current-window intensity bucket (0 when the intensity key is off). */
  intensityBucket: number;
  /** Sum of class costs of the leases active at `at`. */
  load: number;
}

export type ShiftMode = "unkeyed" | "always" | "never";
export type LeaseCostStatistic = "median" | "mean";
export type IntensityMode = "none" | "trailing60" | "sinceStart";

export interface ForecastConfig {
  /** Percent that counts as "hit". 100 is the limit; lower values give a stricter derived event. */
  threshold: number;
  /** Hours-to-reset buckets per window (equal slices of the window length). */
  htrBuckets: number;
  /** Hour-of-week bucket size in hours; weekdays and weekends are separate. */
  blockHours: number;
  /** Local time offset used for the hour-of-week bucket. */
  utcOffsetMinutes: number;
  /** Upper edges of the active-load buckets, in percent points (load 0 is its own bucket). */
  loadEdges: number[];
  /** A table cell answers only with at least this many samples ... */
  minSamples: number;
  /** ... drawn from at least this many distinct windows. */
  minCycles: number;
  /** The latest reading must be at most this old, or the answer is UNKNOWN. */
  staleAfterMs: number;
  /**
   * When to add the sum of class p50 of active leases to every draw:
   * "unkeyed" only when the matched table level ignores load (default),
   * "always", or "never".
   */
  shiftMode: ShiftMode;
  /** Per-class lease cost: the design's median (default) or the mean. */
  leaseCost: LeaseCostStatistic;
  /**
   * Optional extra key on the current window's burn rate (percent per hour):
   * "none" (the design, default), the last 60 minutes, or since the window started.
   */
  intensity: IntensityMode;
  /** Upper edges of the intensity buckets, percent per hour (0 is its own bucket). */
  intensityEdges: number[];
  /** Training samples inside one window are at least this far apart. */
  sampleStepMs: number;
  /** Readings whose reset times differ by at most this much belong to one window. */
  cycleToleranceMs: number;
  /** A zero reading whose reset is window-length away (within this) is an idle meter. */
  idleToleranceMs: number;
}

export const DEFAULT_FORECAST_CONFIG: ForecastConfig = {
  threshold: 100,
  htrBuckets: 10,
  blockHours: 6,
  utcOffsetMinutes: 0,
  loadEdges: [0, 2, 5],
  minSamples: 30,
  minCycles: 5,
  staleAfterMs: 20 * MINUTE_MS,
  shiftMode: "unkeyed",
  leaseCost: "median",
  intensity: "none",
  intensityEdges: [0, 3, 10],
  sampleStepMs: 10 * MINUTE_MS,
  cycleToleranceMs: 15 * MINUTE_MS,
  idleToleranceMs: 2 * MINUTE_MS,
};

export type UnknownReason =
  | "no_data"
  | "stale"
  | "rolling_no_history"
  | "no_active_window"
  | "past_reset"
  | "too_sparse";

export interface ForecastUnknown {
  status: "unknown";
  reason: UnknownReason;
  detail: string;
}

export interface ForecastOk {
  status: "ok";
  threshold: number;
  /** Share of matched samples whose draw takes the meter to `threshold` before the reset. */
  pHit: number;
  used: number;
  hoursToReset: number;
  /** Mean percent at reset over the matched samples (clamped to 0..100). */
  expectedAtReset: number;
  /** Percent at reset, 25th to 75th percentile. */
  interval50: [number, number];
  /** Percent at reset, 5th to 95th percentile. */
  interval90: [number, number];
  /** Remaining consumption until the reset (percent points). */
  remaining: { p05: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  samples: number;
  cycles: number;
  /** Which table level answered ("htr+how+load", ..., "htr+-1"). */
  level: string;
  /** Percent points added to every draw for the active leases. */
  shift: number;
}

export type Forecast = ForecastOk | ForecastUnknown;
