// Quantile table builder: cycles from readings, draw samples from cycles,
// lease load, buckets, and the conditional lookup with back-off.

import {
  DEFAULT_FORECAST_CONFIG,
  HOUR_MS,
  MINUTE_MS,
  type Cycle,
  type DrawSample,
  type ForecastConfig,
  type IntensityMode,
  type LeaseCostStatistic,
  type LeaseRecord,
  type MeterReading,
} from "./types.js";

/** Inverse empirical CDF (type 1): the smallest sample x with F(x) >= p. Input must be sorted ascending. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError("quantile of an empty sample");
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const index = Math.ceil(p * sorted.length - 1e-9) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * True when a reading shows no active window: no reset time, or zero use with
 * a reset exactly one window ahead (a vendor that floats the reset while idle).
 */
export function isIdleReading(reading: MeterReading, windowMinutes: number, idleToleranceMs = DEFAULT_FORECAST_CONFIG.idleToleranceMs): boolean {
  if (reading.resetsAt === null) return true;
  if (reading.used > 0) return false;
  return Math.abs(reading.resetsAt - reading.at - windowMinutes * MINUTE_MS) <= idleToleranceMs;
}

/** Groups readings into windows by reset time. Idle readings and readings at or past their reset are dropped. */
export function segmentCycles(
  readings: readonly MeterReading[],
  windowMinutes: number,
  config: Pick<ForecastConfig, "cycleToleranceMs" | "idleToleranceMs"> = DEFAULT_FORECAST_CONFIG,
): Cycle[] {
  const sorted = [...readings].sort((a, b) => a.at - b.at);
  const cycles: Cycle[] = [];
  let current: Cycle | null = null;
  for (const reading of sorted) {
    if (isIdleReading(reading, windowMinutes, config.idleToleranceMs)) continue;
    const resetsAt = reading.resetsAt as number;
    if (reading.at >= resetsAt) continue;
    if (current !== null && Math.abs(resetsAt - current.resetsAt) <= config.cycleToleranceMs) {
      current.readings.push(reading);
      current.resetsAt = Math.max(current.resetsAt, resetsAt);
    } else {
      current = { resetsAt, windowMinutes, readings: [reading] };
      cycles.push(current);
    }
  }
  return cycles;
}

export interface ClassCosts {
  byClass: Map<string, number>;
  overall: number;
}

/**
 * Spent percent per action class (median by default, or mean) over leases that
 * ended at or before `asOf`. `overall` covers a class with no ended lease yet.
 */
export function classCosts(leases: readonly LeaseRecord[], asOf: number, statistic: LeaseCostStatistic = "median"): ClassCosts {
  const groups = new Map<string, number[]>();
  const all: number[] = [];
  for (const lease of leases) {
    if (lease.endedAt === null || lease.endedAt > asOf || lease.spentPercent === null) continue;
    const key = lease.actionClass ?? "";
    const list = groups.get(key) ?? [];
    list.push(lease.spentPercent);
    groups.set(key, list);
    all.push(lease.spentPercent);
  }
  const summarize = (values: number[]): number =>
    statistic === "mean" ? values.reduce((s, v) => s + v, 0) / values.length : (median(values) as number);
  const byClass = new Map<string, number>();
  for (const [key, list] of groups) byClass.set(key, summarize(list));
  return { byClass, overall: all.length ? summarize(all) : 0 };
}

/** Median spent percent per action class (the design's weighting). */
export function classMedianCosts(leases: readonly LeaseRecord[], asOf: number): ClassCosts {
  return classCosts(leases, asOf, "median");
}

/** Sum of class costs over leases running at `at` (started, not yet ended). */
export function activeLoad(leases: readonly LeaseRecord[], at: number, costs: ClassCosts): number {
  let load = 0;
  for (const lease of leases) {
    if (lease.startedAt > at) continue;
    if (lease.endedAt !== null && lease.endedAt <= at) continue;
    load += costs.byClass.get(lease.actionClass ?? "") ?? costs.overall;
  }
  return load;
}

export function hoursToResetBucket(msToReset: number, windowMinutes: number, buckets: number): number {
  const fraction = msToReset / (windowMinutes * MINUTE_MS);
  const bucket = Math.floor(fraction * buckets);
  return Math.min(buckets - 1, Math.max(0, bucket));
}

export function hourOfWeekBucket(at: number, blockHours: number, utcOffsetMinutes: number): number {
  const local = new Date(at + utcOffsetMinutes * MINUTE_MS);
  const day = local.getUTCDay();
  const weekend = day === 0 || day === 6 ? 1 : 0;
  const blocksPerDay = Math.ceil(24 / blockHours);
  return weekend * blocksPerDay + Math.floor(local.getUTCHours() / blockHours);
}

export function loadBucket(load: number, edges: readonly number[]): number {
  for (let i = 0; i < edges.length; i++) if (load <= edges[i]) return i;
  return edges.length;
}

/**
 * Current-window burn rate in percent per hour, from the window's readings up
 * to and including `latest`. "trailing60" uses the change since the last
 * reading at least 60 minutes old (or the window start at 0 percent);
 * "sinceStart" the average since the window started. Never negative.
 */
export function windowIntensity(history: readonly MeterReading[], latest: MeterReading, windowMinutes: number, mode: IntensityMode): number {
  if (mode === "none" || latest.resetsAt === null) return 0;
  const windowStart = latest.resetsAt - windowMinutes * MINUTE_MS;
  let anchor: { at: number; used: number } = { at: windowStart, used: 0 };
  if (mode === "trailing60") {
    const cutoff = latest.at - 60 * MINUTE_MS;
    for (const reading of history) if (reading.at <= cutoff && reading.at >= anchor.at) anchor = reading;
  }
  const hours = (latest.at - anchor.at) / HOUR_MS;
  return hours > 0 ? Math.max(0, (latest.used - anchor.used) / hours) : 0;
}

export function intensityBucket(history: readonly MeterReading[], latest: MeterReading, windowMinutes: number, config: Pick<ForecastConfig, "intensity" | "intensityEdges">): number {
  if (config.intensity === "none") return 0;
  return loadBucket(windowIntensity(history, latest, windowMinutes, config.intensity), config.intensityEdges);
}

export interface SampleOptions {
  /** Only windows that reset at or before this time are complete enough to train on. */
  asOf: number;
  /** Active-lease load at a moment (sum of class median costs). */
  loadAt: (at: number) => number;
}

/** Draw samples from every window that completed by `asOf`. */
export function buildSamples(cycles: readonly Cycle[], options: SampleOptions, config: ForecastConfig = DEFAULT_FORECAST_CONFIG): DrawSample[] {
  const samples: DrawSample[] = [];
  for (const cycle of cycles) {
    if (cycle.resetsAt > options.asOf) continue;
    const readings = cycle.readings;
    const suffixMax: number[] = new Array(readings.length);
    let running = -Infinity;
    for (let i = readings.length - 1; i >= 0; i--) {
      running = Math.max(running, readings[i].used);
      suffixMax[i] = running;
    }
    let lastKept = -Infinity;
    for (let i = 0; i < readings.length; i++) {
      const reading = readings[i];
      if (reading.at - lastKept < config.sampleStepMs) continue;
      lastKept = reading.at;
      const load = options.loadAt(reading.at);
      const intensity = config.intensity === "none" ? 0 : intensityBucket(readings.slice(0, i + 1), reading, cycle.windowMinutes, config);
      samples.push({
        cycleId: cycle.resetsAt,
        at: reading.at,
        used: reading.used,
        draw: Math.max(0, suffixMax[i] - reading.used),
        htrBucket: hoursToResetBucket(cycle.resetsAt - reading.at, cycle.windowMinutes, config.htrBuckets),
        howBucket: hourOfWeekBucket(reading.at, config.blockHours, config.utcOffsetMinutes),
        loadBucket: loadBucket(load, config.loadEdges),
        intensityBucket: intensity,
        load,
      });
    }
  }
  return samples;
}

export interface TableQuery {
  htrBucket: number;
  howBucket: number;
  loadBucket: number;
  /** Ignored unless the table was built with an intensity key. */
  intensityBucket?: number;
}

export interface TableMatch {
  samples: DrawSample[];
  cycles: number;
  level: string;
  keyedOnLoad: boolean;
}

interface Level {
  name: string;
  keyedOnLoad: boolean;
  /** Key with the hours-to-reset bucket given separately, so a level can widen to neighbours. */
  key: (q: TableQuery, htr: number) => string;
  widen: boolean;
}

function levelsFor(config: ForecastConfig): Level[] {
  const base: Level[] = [
    { name: "htr+how+load", keyedOnLoad: true, widen: false, key: (q, h) => `${h}|${q.howBucket}|${q.loadBucket}` },
    { name: "htr+load", keyedOnLoad: true, widen: false, key: (q, h) => `${h}|${q.loadBucket}` },
    { name: "htr+how", keyedOnLoad: false, widen: false, key: (q, h) => `${h}|${q.howBucket}` },
    { name: "htr", keyedOnLoad: false, widen: false, key: (_q, h) => `${h}` },
    { name: "htr+-1", keyedOnLoad: false, widen: true, key: (_q, h) => `${h}` },
  ];
  if (config.intensity === "none") return base;
  const withIntensity: Level[] = [
    { name: "int+htr+how+load", keyedOnLoad: true, widen: false, key: (q, h) => `${q.intensityBucket ?? 0}|${h}|${q.howBucket}|${q.loadBucket}` },
    { name: "int+htr+load", keyedOnLoad: true, widen: false, key: (q, h) => `${q.intensityBucket ?? 0}|${h}|${q.loadBucket}` },
    { name: "int+htr", keyedOnLoad: false, widen: false, key: (q, h) => `${q.intensityBucket ?? 0}|${h}` },
    { name: "int+htr+-1", keyedOnLoad: false, widen: true, key: (q, h) => `${q.intensityBucket ?? 0}|${h}` },
  ];
  return [...withIntensity, ...base];
}

/**
 * Conditional empirical table of draws. A lookup answers from the most
 * specific level with enough samples from enough windows, backing off from
 * hours-to-reset + hour-of-week + load to hours-to-reset alone, then to the
 * neighbouring hours-to-reset buckets. With the optional intensity key, the
 * same back-off runs first inside the current intensity bucket. Null means
 * too sparse at every level.
 */
export class QuantileTable {
  readonly size: number;
  readonly cycles: number;
  private readonly levels: Level[];
  private readonly maps: Map<string, DrawSample[]>[];
  private readonly config: ForecastConfig;

  constructor(samples: readonly DrawSample[], config: ForecastConfig = DEFAULT_FORECAST_CONFIG) {
    this.config = config;
    this.size = samples.length;
    this.cycles = new Set(samples.map((s) => s.cycleId)).size;
    this.levels = levelsFor(config);
    this.maps = this.levels.map((level) => {
      const map = new Map<string, DrawSample[]>();
      for (const sample of samples) {
        const key = level.key(sample, sample.htrBucket);
        const list = map.get(key) ?? [];
        list.push(sample);
        map.set(key, list);
      }
      return map;
    });
  }

  lookup(query: TableQuery): TableMatch | null {
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      const buckets = level.widen ? [query.htrBucket - 1, query.htrBucket, query.htrBucket + 1] : [query.htrBucket];
      const found: DrawSample[] = [];
      for (const htr of buckets) found.push(...(this.maps[i].get(level.key(query, htr)) ?? []));
      const match = this.accept(found, level.name, level.keyedOnLoad);
      if (match) return match;
    }
    return null;
  }

  private accept(samples: DrawSample[], level: string, keyedOnLoad: boolean): TableMatch | null {
    if (samples.length < this.config.minSamples) return null;
    const cycles = new Set(samples.map((s) => s.cycleId)).size;
    if (cycles < this.config.minCycles) return null;
    return { samples, cycles, level, keyedOnLoad };
  }
}
