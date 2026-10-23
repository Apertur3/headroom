// Backtest of the live overrun warning on a `headroom export` file.
//
//   npm run build
//   node dist/overrun/backtest.js <export.json> [--train-days 7] [--json]
//
// Each lease is replayed poll by poll against one window of its meter (the
// 5-hour window when it has readings, else the weekly one), with only the
// readings that existed at that moment. Ground truth is the window's movement
// from the last reading before the lease to the first reading after it ends.
// That is only the lease's own spend when no other lease ran on the same
// meter at the same time, so only those ISOLATED leases are scored; the rest
// are counted as unattributable. Thresholds are chosen on the first
// `--train-days` days and reported on the rest.
//
// Output is aggregate only: accounts are letters, meters are numbers, and
// no account, meter, owner or lease id is printed.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateOverrun } from "./monitor.js";
import { spendPath } from "./spend.js";
import { DEFAULT_OVERRUN_CONFIG, MINUTE_MS, type OverrunConfig, type OverrunReading, type OverrunRule, type OverrunState } from "./types.js";

const DAY_MS = 24 * 60 * MINUTE_MS;

export interface ExportObservation {
  meter_id: string;
  principal_id?: string | null;
  window: { kind: string; minutes: number | null } | null;
  quantity: { used: number; unit?: string | null } | null;
  resets_at: string | null;
  observed_at: string;
  freshness?: string | null;
}

export interface ExportLease {
  meter_id: string;
  action_class: string | null;
  started_at: string;
  ended_at: string | null;
  expected_percent: number | null;
  spent_percent: number | null;
}

export interface ExportFile {
  range?: { since?: string | null; until?: string | null } | null;
  observations: ExportObservation[];
  leases?: ExportLease[] | null;
}

/** Watched windows in order of preference. */
export const WINDOW_PREFERENCE = ["fixed:300", "rolling:300", "fixed:10080"] as const;

export interface MeterSeries {
  meterId: string;
  account: string;
  meterNumber: number;
  windows: Map<string, OverrunReading[]>;
}

/** Per lease meter, readings per window. A failed poll without a window counts as a failed reading on every window of that meter. */
export function meterSeries(data: ExportFile): MeterSeries[] {
  const leaseMeters = [...new Set((data.leases ?? []).map((l) => l.meter_id))];
  const wanted = new Set(leaseMeters);
  const windowed = new Map<string, Map<string, OverrunReading[]>>();
  const windowless = new Map<string, OverrunReading[]>();
  const principal = new Map<string, string>();
  for (const o of data.observations) {
    if (!wanted.has(o.meter_id)) continue;
    if (o.principal_id && !principal.has(o.meter_id)) principal.set(o.meter_id, o.principal_id);
    const at = Date.parse(o.observed_at);
    if (!Number.isFinite(at)) continue;
    const unit = o.quantity?.unit ?? null;
    if (unit !== null && unit !== "percent") continue;
    const fresh = (o.freshness ?? "fresh") === "fresh" && o.quantity !== null && unit === "percent";
    const reading: OverrunReading = { at, used: fresh ? (o.quantity as { used: number }).used : null, fresh, resetsAt: o.resets_at ? Date.parse(o.resets_at) : null };
    if (!o.window) {
      if (!fresh) {
        const list = windowless.get(o.meter_id) ?? [];
        list.push(reading);
        windowless.set(o.meter_id, list);
      }
      continue;
    }
    if (o.window.minutes === null) continue;
    const key = `${o.window.kind}:${o.window.minutes}`;
    let byWindow = windowed.get(o.meter_id);
    if (!byWindow) windowed.set(o.meter_id, (byWindow = new Map()));
    const list = byWindow.get(key) ?? [];
    list.push(reading);
    byWindow.set(key, list);
  }
  const accounts = new Map<string, string>();
  return leaseMeters.map((meterId, index) => {
    const who = principal.get(meterId);
    if (who && !accounts.has(who)) accounts.set(who, String.fromCharCode(65 + accounts.size));
    const windows = new Map<string, OverrunReading[]>();
    for (const [key, readings] of windowed.get(meterId) ?? []) {
      windows.set(key, [...readings, ...(windowless.get(meterId) ?? [])].sort((a, b) => a.at - b.at));
    }
    return { meterId, account: who ? (accounts.get(who) as string) : "without readings", meterNumber: index + 1, windows };
  });
}

/** 1 for a window that reports whole percents, else the smallest step seen (capped at 1), from readings before `until` only. */
export function inferResolution(readings: readonly OverrunReading[], until: number): number {
  const values = readings.filter((r) => r.fresh && r.used !== null && r.at < until).map((r) => r.used as number);
  if (values.every((v) => Number.isInteger(v))) return 1;
  let step = 1;
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i] - values[i - 1]);
    if (d > 1e-9 && d < step) step = d;
  }
  return step;
}

export interface LeaseCase {
  account: string;
  meterNumber: number;
  window: string | null;
  resolution: number;
  actionClass: string | null;
  startedAt: number;
  endedAt: number;
  reservation: number | null;
  exportSpent: number | null;
  isolated: boolean;
  /** Ground-truth final spend on the watched window, or null when the readings cannot tell. */
  final: number | null;
  /** Fresh readings strictly inside the lease (the polls a live monitor would see). */
  inLeasePolls: number;
  /** Some poll inside the lease showed spend at or below 3 points: an in-time warning was possible at all. */
  inTimePossible: boolean;
  /**
   * Isolated over the whole measurement span (last reading before the lease
   * to the first after it), and the lease covers at least half that span.
   * Ground truth is cleanest here.
   */
  strict: boolean;
  readings: OverrunReading[];
}

function overlaps(a: { startedAt: number; endedAt: number }, b: { startedAt: number; endedAt: number }): boolean {
  return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

export const IN_TIME_POINTS = 3;

function measurementSpan(readings: readonly OverrunReading[], startedAt: number, endedAt: number, config: OverrunConfig): [number, number] {
  let from = startedAt;
  for (const r of readings) if (r.fresh && r.used !== null && r.at <= startedAt) from = r.at;
  const after = readings.find((r) => r.fresh && r.used !== null && r.at >= endedAt && r.at - endedAt <= config.maxReadingAgeMinutes * MINUTE_MS);
  return [from, after ? after.at : endedAt];
}

/** The movement of the watched window from the baseline to the first fresh reading at or after the lease ended. */
export function finalSpend(readings: readonly OverrunReading[], startedAt: number, endedAt: number, config: OverrunConfig): number | null {
  const after = readings.find((r) => r.fresh && r.used !== null && r.at >= endedAt && r.at - endedAt <= config.maxReadingAgeMinutes * MINUTE_MS);
  const path = spendPath(readings, startedAt, after ? after.at : endedAt, config);
  return path.ok ? path.points[path.points.length - 1].spent : null;
}

export function buildCases(data: ExportFile, trainUntil: number, config: OverrunConfig = DEFAULT_OVERRUN_CONFIG): LeaseCase[] {
  const series = new Map(meterSeries(data).map((s) => [s.meterId, s]));
  const leases = (data.leases ?? [])
    .filter((l) => l.ended_at)
    .map((l) => ({ raw: l, startedAt: Date.parse(l.started_at), endedAt: Date.parse(l.ended_at as string) }))
    .filter((l) => Number.isFinite(l.startedAt) && Number.isFinite(l.endedAt) && l.endedAt >= l.startedAt);
  const byMeter = new Map<string, typeof leases>();
  for (const l of leases) {
    const list = byMeter.get(l.raw.meter_id) ?? [];
    list.push(l);
    byMeter.set(l.raw.meter_id, list);
  }
  const cases: LeaseCase[] = [];
  for (const l of leases) {
    const s = series.get(l.raw.meter_id);
    const isolated = !(byMeter.get(l.raw.meter_id) ?? []).some((o) => o !== l && overlaps(o, l));
    let window: string | null = null;
    let readings: OverrunReading[] = [];
    let resolution = 1;
    let final: number | null = null;
    for (const key of WINDOW_PREFERENCE) {
      const candidate = s?.windows.get(key);
      if (!candidate) continue;
      const res = inferResolution(candidate, trainUntil);
      const f = finalSpend(candidate, l.startedAt, l.endedAt, { ...config, resolution: res });
      if (f === null) continue;
      window = key;
      readings = candidate;
      resolution = res;
      final = f;
      break;
    }
    const inLease = readings.filter((r) => r.fresh && r.at > l.startedAt && r.at <= l.endedAt);
    const cfg = { ...config, resolution };
    const inTimePossible = inLease.some((r) => {
      const path = spendPath(readings, l.startedAt, r.at, cfg);
      return path.ok && path.points[path.points.length - 1].spent <= IN_TIME_POINTS;
    });
    let strict = false;
    if (isolated && window) {
      const [from, to] = measurementSpan(readings, l.startedAt, l.endedAt, cfg);
      strict = !(byMeter.get(l.raw.meter_id) ?? []).some((o) => o !== l && overlaps(o, { startedAt: from, endedAt: to })) && l.endedAt - l.startedAt >= 0.5 * (to - from);
    }
    cases.push({
      account: s?.account ?? "?",
      meterNumber: s?.meterNumber ?? 0,
      window,
      resolution,
      actionClass: l.raw.action_class,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      reservation: typeof l.raw.expected_percent === "number" ? l.raw.expected_percent : null,
      exportSpent: typeof l.raw.spent_percent === "number" ? l.raw.spent_percent : null,
      isolated,
      final,
      inLeasePolls: inLease.length,
      inTimePossible,
      strict,
      readings,
    });
  }
  return cases.sort((a, b) => a.startedAt - b.startedAt);
}

/** p75 of isolated, known finals of the same class that ended before `at`. */
export function classStats(cases: readonly LeaseCase[], actionClass: string | null, at: number): { p75: number | null; n: number } {
  if (!actionClass) return { p75: null, n: 0 };
  const finals = cases.filter((c) => c.isolated && c.final !== null && c.actionClass === actionClass && c.endedAt < at).map((c) => c.final as number).sort((a, b) => a - b);
  if (!finals.length) return { p75: null, n: 0 };
  return { p75: finals[Math.min(finals.length - 1, Math.floor(0.75 * finals.length))], n: finals.length };
}

export interface ReplayWarning {
  rule: OverrunRule | "naive";
  at: number;
  spent: number;
}

export interface Replay {
  warnings: ReplayWarning[];
  unknownPolls: number;
  polls: number;
}

/** Replays one lease poll by poll. The naive baseline warns when spend exceeds the reservation. */
export function replayLease(c: LeaseCase, config: OverrunConfig, klass: { p75: number | null; n: number }): Replay {
  const cfg = { ...config, resolution: c.resolution };
  const lease = { leaseId: "lease", startedAt: c.startedAt, reservationPercent: c.reservation, classP75: klass.p75, classSamples: klass.n };
  let state: OverrunState | null = null;
  const warnings: ReplayWarning[] = [];
  let unknownPolls = 0;
  let polls = 0;
  let naive = false;
  for (const r of c.readings) {
    if (r.at <= c.startedAt || r.at > c.endedAt) continue;
    polls++;
    const result = evaluateOverrun(lease, c.readings, r.at, state, cfg);
    state = result.state;
    if (result.status === "unknown") { unknownPolls++; continue; }
    for (const w of result.newWarnings) warnings.push({ rule: w.rule, at: w.at, spent: w.evidence.spent });
    if (!naive && c.reservation !== null && (result.spent as number) > c.reservation) {
      naive = true;
      warnings.push({ rule: "naive", at: r.at, spent: result.spent as number });
    }
  }
  return { warnings, unknownPolls, polls };
}

export interface Scores {
  /** Leases the method warned on at least once. */
  warnedLeases: number;
  /** Rule-level warnings (a lease can carry one per rule). */
  warnings: number;
  warningsPerDay: number;
  big: number;
  bigWarned: number;
  bigWarnedInTime: number;
  shareInTime: number | null;
  /** Percent of the job's final spend still ahead at the first warning, per warned big job. */
  leadTimes: number[];
  leadTimeMedian: number | null;
  precision5: number | null;
  precision2: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function score(scored: { c: LeaseCase; w: ReplayWarning[] }[], days: number, bigAt = 5, inTimeAt = IN_TIME_POINTS): Scores {
  let warnedLeases = 0, warnings = 0, big = 0, bigWarned = 0, bigWarnedInTime = 0, warned5 = 0, warned2 = 0;
  const leadTimes: number[] = [];
  for (const { c, w } of scored) {
    const final = c.final as number;
    const isBig = final >= bigAt;
    if (isBig) big++;
    if (!w.length) continue;
    warnedLeases++;
    warnings += w.length;
    if (final >= bigAt) warned5++;
    if (final >= 2) warned2++;
    if (isBig) {
      bigWarned++;
      const first = w.reduce((a, b) => (b.at < a.at ? b : a));
      if (first.spent <= inTimeAt) bigWarnedInTime++;
      leadTimes.push(Math.max(0, (100 * (final - first.spent)) / final));
    }
  }
  return {
    warnedLeases,
    warnings,
    warningsPerDay: days > 0 ? warnings / days : 0,
    big,
    bigWarned,
    bigWarnedInTime,
    shareInTime: big ? bigWarnedInTime / big : null,
    leadTimes: leadTimes.sort((a, b) => a - b),
    leadTimeMedian: median(leadTimes),
    precision5: warnedLeases ? warned5 / warnedLeases : null,
    precision2: warnedLeases ? warned2 / warnedLeases : null,
  };
}

export type Method = "rules" | "spend" | "rate" | "class" | "naive";
const METHODS: Method[] = ["rules", "spend", "rate", "class", "naive"];

function pick(method: Method, w: ReplayWarning[]): ReplayWarning[] {
  if (method === "rules") return w.filter((x) => x.rule !== "naive");
  return w.filter((x) => x.rule === method);
}

export interface SplitResult {
  leases: number;
  isolated: number;
  isolatedKnown: number;
  unknownTruth: number;
  unattributable: number;
  reach2: number;
  reach5: number;
  reach5NoInLeasePoll: number;
  /** Jobs reaching 5 that had a poll inside the lease at or below 3 points: the ceiling for any poll-based rule. */
  reach5InTimePossible: number;
  byMethod: Record<Method, Scores>;
  /** Warnings the rules would issue on non-isolated leases: volume only, not scored. */
  unattributableWarnings: number;
}

export function evaluateSplit(all: readonly LeaseCase[], cases: readonly LeaseCase[], days: number, config: OverrunConfig, strictOnly = false): SplitResult {
  const scoredCases = cases.filter((c) => c.isolated && c.final !== null && (!strictOnly || c.strict));
  const replays = scoredCases.map((c) => ({ c, w: replayLease(c, config, classStats(all, c.actionClass, c.startedAt)).warnings }));
  const byMethod = {} as Record<Method, Scores>;
  for (const m of METHODS) byMethod[m] = score(replays.map(({ c, w }) => ({ c, w: pick(m, w) })), days);
  let unattributableWarnings = 0;
  for (const c of cases.filter((x) => !x.isolated && x.window)) {
    unattributableWarnings += pick("rules", replayLease(c, config, classStats(all, c.actionClass, c.startedAt)).warnings).length;
  }
  return {
    leases: cases.length,
    isolated: cases.filter((c) => c.isolated).length,
    isolatedKnown: scoredCases.length,
    unknownTruth: cases.filter((c) => c.isolated && c.final === null).length,
    unattributable: cases.filter((c) => !c.isolated).length,
    reach2: scoredCases.filter((c) => (c.final as number) >= 2).length,
    reach5: scoredCases.filter((c) => (c.final as number) >= 5).length,
    reach5NoInLeasePoll: scoredCases.filter((c) => (c.final as number) >= 5 && c.inLeasePolls === 0).length,
    reach5InTimePossible: scoredCases.filter((c) => (c.final as number) >= 5 && c.inTimePossible).length,
    byMethod,
    unattributableWarnings,
  };
}

export interface GridPoint {
  consecutivePolls: number;
  ratePoints: number;
  horizonMinutes: number;
}

export const GRID: GridPoint[] = [1, 2].flatMap((consecutivePolls) => [3, 4, 5].flatMap((ratePoints) => [5, 10].map((horizonMinutes) => ({ consecutivePolls, ratePoints, horizonMinutes }))));

/** The grid point with the best in-time share on the training split; ties go to higher precision at 2 points, then fewer warnings. */
export function chooseOnTrain(all: readonly LeaseCase[], train: readonly LeaseCase[], days: number, base: OverrunConfig): { point: GridPoint; result: SplitResult } {
  let best: { point: GridPoint; result: SplitResult } | null = null;
  for (const point of GRID) {
    const result = evaluateSplit(all, train, days, { ...base, ...point });
    const s = result.byMethod.rules;
    if (!best) { best = { point, result }; continue; }
    const b = best.result.byMethod.rules;
    const key = (x: Scores) => [x.shareInTime ?? -1, x.precision2 ?? -1, -x.warnings];
    const [k1, k2] = [key(s), key(b)];
    if (k1[0] > k2[0] || (k1[0] === k2[0] && (k1[1] > k2[1] || (k1[1] === k2[1] && k1[2] > k2[2])))) best = { point, result };
  }
  return best as { point: GridPoint; result: SplitResult };
}

function leaseMinutes(cases: readonly LeaseCase[]): BacktestReport["leaseMinutes"] {
  const d = cases.map((c) => (c.endedAt - c.startedAt) / MINUTE_MS).sort((a, b) => a - b);
  if (!d.length) return { p50: null, p90: null, shareWithTwoPolls: null };
  return { p50: d[Math.floor(0.5 * d.length)], p90: d[Math.floor(0.9 * d.length)], shareWithTwoPolls: cases.filter((c) => c.inLeasePolls >= 2).length / cases.length };
}

export interface BacktestReport {
  trainDays: number;
  testDays: number;
  windowsUsed: Record<string, number>;
  accounts: Record<string, { leases: number; isolated: number; reach5: number }>;
  exportVsReconstructed: { n: number; differByMoreThan1: number; medianExport: number | null; medianReconstructed: number | null };
  design: { train: SplitResult; test: SplitResult };
  /** Design thresholds scored on strictly isolated leases only. */
  strict: { train: SplitResult; test: SplitResult };
  leaseMinutes: { p50: number | null; p90: number | null; shareWithTwoPolls: number | null };
  tuned: { point: GridPoint; train: SplitResult; test: SplitResult };
}

export function runBacktest(data: ExportFile, trainDays = 7, config: OverrunConfig = DEFAULT_OVERRUN_CONFIG): BacktestReport {
  const leases = data.leases ?? [];
  const since = data.range?.since ? Date.parse(data.range.since) : Math.min(...leases.map((l) => Date.parse(l.started_at)));
  const until = data.range?.until ? Date.parse(data.range.until) : Math.max(...leases.map((l) => Date.parse(l.ended_at ?? l.started_at)));
  const trainUntil = since + trainDays * DAY_MS;
  const testDays = (until - trainUntil) / DAY_MS;
  const all = buildCases(data, trainUntil, config);
  const train = all.filter((c) => c.startedAt < trainUntil);
  const test = all.filter((c) => c.startedAt >= trainUntil);
  const windowsUsed: Record<string, number> = {};
  for (const c of all) windowsUsed[c.window ?? "none"] = (windowsUsed[c.window ?? "none"] ?? 0) + 1;
  const accounts: BacktestReport["accounts"] = {};
  for (const c of all) {
    const a = (accounts[`account ${c.account}`] ??= { leases: 0, isolated: 0, reach5: 0 });
    a.leases++;
    if (c.isolated) a.isolated++;
    if (c.isolated && c.final !== null && c.final >= 5) a.reach5++;
  }
  const known = all.filter((c) => c.isolated && c.final !== null && c.exportSpent !== null);
  const exportVsReconstructed = {
    n: known.length,
    differByMoreThan1: known.filter((c) => Math.abs((c.exportSpent as number) - (c.final as number)) > 1).length,
    medianExport: median(known.map((c) => c.exportSpent as number)),
    medianReconstructed: median(known.map((c) => c.final as number)),
  };
  const tuned = chooseOnTrain(all, train, trainDays, config);
  return {
    trainDays,
    testDays,
    windowsUsed,
    accounts,
    exportVsReconstructed,
    design: { train: evaluateSplit(all, train, trainDays, config), test: evaluateSplit(all, test, testDays, config) },
    strict: { train: evaluateSplit(all, train, trainDays, config, true), test: evaluateSplit(all, test, testDays, config, true) },
    leaseMinutes: leaseMinutes(all.filter((c) => c.isolated && c.final !== null)),
    tuned: { point: tuned.point, train: tuned.result, test: evaluateSplit(all, test, testDays, { ...config, ...tuned.point }) },
  };
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

function describe(label: string, r: SplitResult): string[] {
  const lines = [
    `${label}: ${r.leases} leases, ${r.isolated} isolated (${r.isolatedKnown} with known truth, ${r.unknownTruth} UNKNOWN), ${r.unattributable} unattributable`,
    `  isolated reaching >=2: ${r.reach2}, >=5: ${r.reach5} (${r.reach5NoInLeasePoll} had no poll inside the lease; ${r.reach5InTimePossible} had a poll at <=3 points, the ceiling for any poll-based rule)`,
  ];
  for (const m of METHODS) {
    const s = r.byMethod[m];
    lines.push(`  ${m.padEnd(6)} warned ${s.warnedLeases} leases (${s.warnings} warnings, ${s.warningsPerDay.toFixed(2)}/day); >=5 jobs warned ${s.bigWarned}/${s.big}, in time ${s.bigWarnedInTime}/${s.big} (${pct(s.shareInTime)}); lead median ${s.leadTimeMedian === null ? "n/a" : `${Math.round(s.leadTimeMedian)}%`}; precision >=5 ${pct(s.precision5)}, >=2 ${pct(s.precision2)}`);
  }
  lines.push(`  unattributable leases: rules would warn ${r.unattributableWarnings} times (volume only, not scored)`);
  return lines;
}

export function formatReport(r: BacktestReport): string {
  return [
    `Overrun warning backtest: train ${r.trainDays} days, test ${r.testDays.toFixed(1)} days`,
    `Watched windows: ${Object.entries(r.windowsUsed).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `Accounts: ${Object.entries(r.accounts).map(([k, v]) => `${k} ${v.leases} leases, ${v.isolated} isolated, ${v.reach5} reach 5`).join("; ")}`,
    `Isolated lease length: median ${r.leaseMinutes.p50?.toFixed(1)} min, p90 ${r.leaseMinutes.p90?.toFixed(1)} min; ${pct(r.leaseMinutes.shareWithTwoPolls)} saw two or more polls`,
    `Export spent_percent vs reconstructed (isolated): ${r.exportVsReconstructed.differByMoreThan1}/${r.exportVsReconstructed.n} differ by more than 1 point; medians ${r.exportVsReconstructed.medianExport?.toFixed(2)} vs ${r.exportVsReconstructed.medianReconstructed?.toFixed(2)}`,
    "",
    "Design thresholds (2 x reservation or 2 points; 5 points in 5 minutes, 2 polls):",
    ...describe("train", r.design.train),
    ...describe("test", r.design.test),
    "",
    "Design thresholds, strictly isolated leases only:",
    ...describe("train", r.strict.train),
    ...describe("test", r.strict.test),
    "",
    `Tuned on train: ${r.tuned.point.consecutivePolls} poll(s), ${r.tuned.point.ratePoints} points within ${r.tuned.point.horizonMinutes} minutes`,
    ...describe("train", r.tuned.train),
    ...describe("test", r.tuned.test),
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node dist/overrun/backtest.js <export.json> [--train-days 7] [--json]");
    process.exit(2);
  }
  const daysAt = args.indexOf("--train-days");
  const trainDays = daysAt >= 0 ? Number(args[daysAt + 1]) : 7;
  const report = runBacktest(JSON.parse(readFileSync(file, "utf8")) as ExportFile, trainDays);
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
}
