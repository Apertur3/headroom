// Walk-forward backtest of the forecaster against the baselines on a
// `headroom export` file. Chronological, no look-ahead: at each step the
// table holds only windows that had reset by then, lease costs come only from
// leases that had ended, and the current lease load only from leases running
// at that moment.
//
//   npm run build
//   node dist/forecast/backtest.js <export.json> [--init-days 7] [--step-min 30]
//        [--utc-offset 0] [--thresholds 100,80,50] [--config '{"minSamples":30}'] [--json]
//
// Output is aggregate only: meters are labelled "account A 5h" and so on,
// never by account or meter id.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { straightLineBurn, trailingRate, type PointForecast } from "./baselines.js";
import { forecast } from "./forecaster.js";
import { brierScore, decisionStats, intervalStats, meanAbsoluteError, reliabilityTable, skill, type DecisionStats, type IntervalCase, type ReliabilityBin, type Scored } from "./metrics.js";
import { activeLoad, buildSamples, classCosts, isIdleReading, QuantileTable, segmentCycles } from "./table.js";
import { DEFAULT_FORECAST_CONFIG, MINUTE_MS, type Cycle, type ForecastConfig, type LeaseRecord, type MeterReading } from "./types.js";

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
  spent_percent: number | null;
}

export interface ExportFile {
  range?: { since?: string | null; until?: string | null } | null;
  observations: ExportObservation[];
  leases?: ExportLease[] | null;
}

export interface Series {
  label: string;
  meterId: string;
  windowMinutes: number;
  readings: MeterReading[];
}

/** Fresh percent readings per (meter, window length), labelled by account letter in order of first appearance. */
export function seriesFromExport(data: ExportFile, windows: readonly number[] = [300, 10080]): Series[] {
  const byKey = new Map<string, { meterId: string; principal: string; windowMinutes: number; readings: MeterReading[]; first: number }>();
  for (const o of data.observations) {
    if (!o.quantity || !o.window || o.window.minutes === null || !windows.includes(o.window.minutes)) continue;
    if (o.freshness && o.freshness !== "fresh") continue;
    if (o.quantity.unit && o.quantity.unit !== "percent") continue;
    const at = Date.parse(o.observed_at);
    const key = `${o.meter_id}\u0000${o.window.minutes}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { meterId: o.meter_id, principal: o.principal_id ?? o.meter_id, windowMinutes: o.window.minutes, readings: [], first: at };
      byKey.set(key, entry);
    }
    entry.first = Math.min(entry.first, at);
    entry.readings.push({ at, used: o.quantity.used, resetsAt: o.resets_at ? Date.parse(o.resets_at) : null, kind: o.window.kind });
  }
  const entries = [...byKey.values()].sort((a, b) => a.first - b.first || a.windowMinutes - b.windowMinutes);
  const accounts = new Map<string, string>();
  const metersPerAccount = new Map<string, string[]>();
  for (const e of entries) {
    if (!accounts.has(e.principal)) accounts.set(e.principal, String.fromCharCode(65 + accounts.size));
    const meters = metersPerAccount.get(e.principal) ?? [];
    if (!meters.includes(e.meterId)) meters.push(e.meterId);
    metersPerAccount.set(e.principal, meters);
  }
  return entries.map((e) => {
    const meters = metersPerAccount.get(e.principal) as string[];
    const meterPart = meters.length > 1 ? ` meter ${meters.indexOf(e.meterId) + 1}` : "";
    const windowPart = e.windowMinutes % 1440 === 0 ? `${e.windowMinutes / 1440 === 7 ? "weekly" : `${e.windowMinutes / 1440}d`}` : `${e.windowMinutes / 60}h`;
    return {
      label: `account ${accounts.get(e.principal)}${meterPart} ${windowPart}`,
      meterId: e.meterId,
      windowMinutes: e.windowMinutes,
      readings: e.readings.sort((a, b) => a.at - b.at),
    };
  });
}

export function leasesFromExport(data: ExportFile, meterId: string): LeaseRecord[] {
  return (data.leases ?? [])
    .filter((l) => l.meter_id === meterId)
    .map((l) => ({
      actionClass: l.action_class,
      startedAt: Date.parse(l.started_at),
      endedAt: l.ended_at ? Date.parse(l.ended_at) : null,
      spentPercent: typeof l.spent_percent === "number" ? l.spent_percent : null,
    }));
}

export interface BacktestOptions {
  start: number;
  end: number;
  stepMs: number;
  thresholds: number[];
  config: ForecastConfig;
}

type Method = "forecaster" | "straightLine" | "trailing15" | "trailing60" | "climatology";
const METHODS: Method[] = ["forecaster", "straightLine", "trailing15", "trailing60", "climatology"];

export interface ThresholdResult {
  threshold: number;
  /** Scored steps (forecaster answered; meter below the threshold at forecast time). */
  n: number;
  /** Steps whose window went on to reach the threshold, and the distinct windows behind them. */
  events: number;
  eventCycles: number;
  brier: Record<Method, number | null>;
  /** 1 - forecaster / baseline. */
  improvement: Record<Exclude<Method, "forecaster">, number | null>;
  reliability: ReliabilityBin[];
  decisions: Record<Exclude<Method, "climatology">, DecisionStats>;
}

export interface SeriesResult {
  label: string;
  windowMinutes: number;
  provisional: boolean;
  steps: number;
  /** Steps with a running window whose reset falls inside the data. */
  activeSteps: number;
  cyclesInEval: number;
  unknown: Record<string, number>;
  stale: number;
  /** Steps where data was stale but the forecaster still returned a number. Must be 0. */
  staleApprovals: number;
  forecasterAnswered: number;
  thresholds: ThresholdResult[];
  remaining: {
    n: number;
    coverage50: number | null;
    width50: number | null;
    coverage90: number | null;
    width90: number | null;
    mae: Record<Exclude<Method, "climatology">, number | null>;
  };
  levels: Record<string, number>;
}

interface Step {
  cycle: Cycle;
  used: number;
  maxAfter: number;
  pHit: Map<number, number>;
  interval50: [number, number];
  interval90: [number, number];
  medianRemaining: number;
  baselines: { straightLine: PointForecast; trailing15: PointForecast; trailing60: PointForecast };
  climatology: Map<number, number>;
}

export function runSeries(series: Series, leases: readonly LeaseRecord[], options: BacktestOptions): SeriesResult {
  const { config } = options;
  const cycles = segmentCycles(series.readings, series.windowMinutes, config);
  const cycleOf = new Map<MeterReading, Cycle>();
  for (const cycle of cycles) for (const r of cycle.readings) cycleOf.set(r, cycle);
  const readings = series.readings;
  const unknown: Record<string, number> = {};
  const levels: Record<string, number> = {};
  const steps: Step[] = [];
  let stale = 0;
  let staleApprovals = 0;
  let stepCount = 0;
  let activeSteps = 0;
  let answered = 0;
  const evalCycles = new Set<Cycle>();

  let index = -1;
  let built = -1;
  let table: QuantileTable | null = null;
  let costs = classCosts([], 0);
  let climateSamples: { used: number; draw: number }[] = [];

  for (let now = options.start; now <= options.end; now += options.stepMs) {
    stepCount++;
    while (index + 1 < readings.length && readings[index + 1].at <= now) index++;
    const latest = index >= 0 ? readings[index] : null;

    const completed = cycles.filter((c) => c.resetsAt <= now).length;
    if (completed !== built) {
      built = completed;
      costs = classCosts(leases, now, config.leaseCost);
      const samples = buildSamples(cycles, { asOf: now, loadAt: (at) => activeLoad(leases, at, costs) }, config);
      table = samples.length ? new QuantileTable(samples, config) : null;
      climateSamples = samples;
    }
    const load = activeLoad(leases, now, costs);
    const kind = latest?.kind ?? "fixed";
    const current = latest ? cycleOf.get(latest) : undefined;
    const windowHistory = current && latest ? current.readings.filter((r) => r.at <= latest.at) : undefined;
    const results = options.thresholds.map((threshold) =>
      forecast({ now, window: { kind, minutes: series.windowMinutes }, latest, windowHistory, table, activeLoad: load, config: { ...config, threshold } }),
    );
    const first = results[0];
    const isStale = latest === null ? false : now - latest.at > config.staleAfterMs;
    if (isStale) {
      stale++;
      if (first.status === "ok") staleApprovals++;
    }

    const cycle = latest ? cycleOf.get(latest) : undefined;
    const running = latest !== null && !isStale && cycle !== undefined && !isIdleReading(latest, series.windowMinutes, config.idleToleranceMs) && cycle.resetsAt > now;
    if (!running || cycle === undefined || latest === null) {
      if (first.status === "unknown") unknown[first.reason] = (unknown[first.reason] ?? 0) + 1;
      continue;
    }
    if (cycle.resetsAt > options.end) continue; // outcome not observed: censored
    activeSteps++;
    evalCycles.add(cycle);
    if (first.status !== "ok") {
      unknown[first.reason] = (unknown[first.reason] ?? 0) + 1;
      continue;
    }
    answered++;
    levels[first.level] = (levels[first.level] ?? 0) + 1;

    const history = cycle.readings.filter((r) => r.at <= now);
    let maxAfter = latest.used;
    for (const r of cycle.readings) if (r.at > now) maxAfter = Math.max(maxAfter, r.used);
    const climatology = new Map<number, number>();
    const pHit = new Map<number, number>();
    options.thresholds.forEach((threshold, i) => {
      const r = results[i];
      pHit.set(threshold, r.status === "ok" ? r.pHit : NaN);
      climatology.set(threshold, climateSamples.filter((s) => s.used + s.draw >= threshold).length / climateSamples.length);
    });
    steps.push({
      cycle,
      used: latest.used,
      maxAfter,
      pHit,
      interval50: [first.remaining.p25, first.remaining.p75],
      interval90: [first.remaining.p05, first.remaining.p95],
      medianRemaining: first.remaining.p50,
      baselines: {
        straightLine: straightLineBurn(latest, series.windowMinutes) as PointForecast,
        trailing15: trailingRate(history, latest, series.windowMinutes, 15) as PointForecast,
        trailing60: trailingRate(history, latest, series.windowMinutes, 60) as PointForecast,
      },
      climatology,
    });
  }

  const thresholds = options.thresholds.map((threshold): ThresholdResult => {
    const scoredSteps = steps.filter((s) => s.used < threshold);
    const y = (s: Step): 0 | 1 => (s.maxAfter >= threshold ? 1 : 0);
    const projected = (b: PointForecast): number => (b.projectedAtReset >= threshold ? 1 : 0);
    const items: Record<Method, Scored[]> = {
      forecaster: scoredSteps.map((s) => ({ p: s.pHit.get(threshold) as number, y: y(s) })),
      straightLine: scoredSteps.map((s) => ({ p: projected(s.baselines.straightLine), y: y(s) })),
      trailing15: scoredSteps.map((s) => ({ p: projected(s.baselines.trailing15), y: y(s) })),
      trailing60: scoredSteps.map((s) => ({ p: projected(s.baselines.trailing60), y: y(s) })),
      climatology: scoredSteps.map((s) => ({ p: s.climatology.get(threshold) as number, y: y(s) })),
    };
    const brier = Object.fromEntries(METHODS.map((m) => [m, brierScore(items[m])])) as Record<Method, number | null>;
    const eventSteps = scoredSteps.filter((s) => y(s) === 1);
    return {
      threshold,
      n: scoredSteps.length,
      events: eventSteps.length,
      eventCycles: new Set(eventSteps.map((s) => s.cycle)).size,
      brier,
      improvement: {
        straightLine: skill(brier.forecaster, brier.straightLine),
        trailing15: skill(brier.forecaster, brier.trailing15),
        trailing60: skill(brier.forecaster, brier.trailing60),
        climatology: skill(brier.forecaster, brier.climatology),
      },
      reliability: reliabilityTable(items.forecaster),
      decisions: {
        forecaster: decisionStats(items.forecaster),
        straightLine: decisionStats(items.straightLine),
        trailing15: decisionStats(items.trailing15),
        trailing60: decisionStats(items.trailing60),
      },
    };
  });

  const actual = (s: Step): number => s.maxAfter - s.used;
  const i50: IntervalCase[] = steps.map((s) => ({ lo: s.interval50[0], hi: s.interval50[1], actual: actual(s) }));
  const i90: IntervalCase[] = steps.map((s) => ({ lo: s.interval90[0], hi: s.interval90[1], actual: actual(s) }));
  const s50 = intervalStats(i50);
  const s90 = intervalStats(i90);
  return {
    label: series.label,
    windowMinutes: series.windowMinutes,
    provisional: series.windowMinutes >= 1440,
    steps: stepCount,
    activeSteps,
    cyclesInEval: evalCycles.size,
    unknown,
    stale,
    staleApprovals,
    forecasterAnswered: answered,
    thresholds,
    remaining: {
      n: steps.length,
      coverage50: s50.coverage,
      width50: s50.meanWidth,
      coverage90: s90.coverage,
      width90: s90.meanWidth,
      mae: {
        forecaster: meanAbsoluteError(steps.map((s) => ({ predicted: s.medianRemaining, actual: actual(s) }))),
        straightLine: meanAbsoluteError(steps.map((s) => ({ predicted: s.baselines.straightLine.remaining, actual: actual(s) }))),
        trailing15: meanAbsoluteError(steps.map((s) => ({ predicted: s.baselines.trailing15.remaining, actual: actual(s) }))),
        trailing60: meanAbsoluteError(steps.map((s) => ({ predicted: s.baselines.trailing60.remaining, actual: actual(s) }))),
      },
    },
    levels,
  };
}

export interface RunOptions {
  initDays: number;
  /** Evaluate up to this many days after the data start; default: to the end of the data. */
  evalDays?: number;
  stepMinutes: number;
  thresholds: number[];
  config?: Partial<ForecastConfig>;
  windows?: number[];
}

export function runBacktest(data: ExportFile, options: RunOptions): { start: string; end: string; series: SeriesResult[] } {
  const config: ForecastConfig = { ...DEFAULT_FORECAST_CONFIG, ...options.config };
  const all = data.observations.map((o) => Date.parse(o.observed_at)).filter((t) => Number.isFinite(t));
  const dataStart = data.range?.since ? Date.parse(data.range.since) : Math.min(...all);
  const dataEnd = data.range?.until ? Date.parse(data.range.until) : Math.max(...all);
  const start = dataStart + options.initDays * DAY_MS;
  const end = options.evalDays === undefined ? dataEnd : Math.min(dataEnd, dataStart + options.evalDays * DAY_MS);
  const series = seriesFromExport(data, options.windows).map((s) =>
    runSeries(s, leasesFromExport(data, s.meterId), { start, end, stepMs: options.stepMinutes * MINUTE_MS, thresholds: options.thresholds, config }),
  );
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), series };
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, digits = 4): string => (x === null ? "n/a" : x.toFixed(digits));

export function formatReport(report: { start: string; end: string; series: SeriesResult[] }): string {
  const lines: string[] = [`Walk-forward backtest ${report.start} .. ${report.end}`];
  for (const s of report.series) {
    lines.push("", `== ${s.label}${s.provisional ? " (provisional)" : ""}: ${s.cyclesInEval} windows, ${s.activeSteps} active steps, forecaster answered ${s.forecasterAnswered}, stale ${s.stale}, stale approvals ${s.staleApprovals}`);
    lines.push(`   unknown: ${JSON.stringify(s.unknown)}  levels: ${JSON.stringify(s.levels)}`);
    for (const t of s.thresholds) {
      lines.push(
        `   reach ${t.threshold}: n=${t.n} events=${t.events} (in ${t.eventCycles} windows)  Brier F=${num(t.brier.forecaster)} SL=${num(t.brier.straightLine)} T15=${num(t.brier.trailing15)} T60=${num(t.brier.trailing60)} clim=${num(t.brier.climatology)}`,
        `     improvement vs SL ${pct(t.improvement.straightLine)}, T15 ${pct(t.improvement.trailing15)}, T60 ${pct(t.improvement.trailing60)}, clim ${pct(t.improvement.climatology)}`,
        `     at P>=0.5: F falseGo ${t.decisions.forecaster.falseGo}/${t.events} blocked ${t.decisions.forecaster.blockedUseful}/${t.n - t.events}; SL ${t.decisions.straightLine.falseGo}/${t.decisions.straightLine.blockedUseful}; T15 ${t.decisions.trailing15.falseGo}/${t.decisions.trailing15.blockedUseful}; T60 ${t.decisions.trailing60.falseGo}/${t.decisions.trailing60.blockedUseful}`,
      );
    }
    const r = s.remaining;
    lines.push(
      `   remaining: n=${r.n} cov50=${pct(r.coverage50)} w50=${num(r.width50, 1)} cov90=${pct(r.coverage90)} w90=${num(r.width90, 1)}  MAE F=${num(r.mae.forecaster, 2)} SL=${num(r.mae.straightLine, 2)} T15=${num(r.mae.trailing15, 2)} T60=${num(r.mae.trailing60, 2)}`,
    );
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): { file: string; json: boolean; options: RunOptions } {
  const options: RunOptions = { initDays: 7, stepMinutes: 30, thresholds: [100, 80, 50] };
  let file = "";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => argv[++i] ?? "";
    if (arg === "--init-days") options.initDays = Number(next());
    else if (arg === "--eval-days") options.evalDays = Number(next());
    else if (arg === "--step-min") options.stepMinutes = Number(next());
    else if (arg === "--thresholds") options.thresholds = next().split(",").map(Number);
    else if (arg === "--utc-offset") options.config = { ...options.config, utcOffsetMinutes: Number(next()) };
    else if (arg === "--config") options.config = { ...options.config, ...(JSON.parse(next()) as Partial<ForecastConfig>) };
    else if (arg === "--windows") options.windows = next().split(",").map(Number);
    else if (arg === "--json") json = true;
    else file = arg;
  }
  if (!file) throw new Error("usage: backtest.js <export.json> [--init-days 7] [--eval-days N] [--step-min 30] [--thresholds 100,80,50] [--utc-offset 0] [--config JSON] [--json]");
  return { file, json, options };
}

function main(): void {
  const { file, json, options } = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(file, "utf8")) as ExportFile;
  const report = runBacktest(data, options);
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
