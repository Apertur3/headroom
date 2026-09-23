/**
 * `headroom rates`: runs the points-per-token learner (rate-learner.ts) over
 * `headroom.db`'s meter history and `usage.db`'s imported token counts,
 * persists each model's fit as a new row in `usage_rate_fits` when the
 * observation window has moved since the last stored fit, records a
 * `rate_changed` event when the new fit drifts from the previous one, and
 * prints the result.
 *
 * Local-only, like `headroom usage import`/`import-status`: no vendor fetch,
 * no daemon RPC (the underlying data already lives in two local SQLite
 * files this process opens directly).
 */
import { HeadroomStore } from "./store.js";
import { UsageStore, type RateFitRow, type RateEventRow, RATE_TOKEN_CLASSES } from "./usage-store.js";
import {
  attributeIntervals, buildMeterIntervals, detectDrift, fitModelRate, groupSamplesByModel,
  MIN_FIT_SAMPLES, type FitOutcome, type MeterObservationPoint, type UsageIdentityPoint,
} from "./rate-learner.js";
import { withContract } from "./json-contract.js";
import { labelForMinutes } from "./status-view.js";

export const RATES_HELP = "Usage: headroom rates [--meter <meter_id>] [--model <slug>] [--principal <id>] [--since 30d] [--json] [--agent]";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sinceIso(value: string | undefined, fallback = "30d"): string {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? fallback);
  if (!match) throw new Error("--since must be like 15m, 24h, or 30d");
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - Number(match[1]) * multiplier).toISOString();
}

/** A fixed note carried on every `--json`/`--agent` output, the same way
 * usage-import.ts stamps its own coverage markers: `coverage` on one rate
 * row is a share of that row's own sample deltas, never a claim about the
 * account's real total usage -- see rate-learner.ts's module doc. */
export const RATES_BIAS_NOTE =
  "coverage is the share of this model's attributable, single-model meter movement that imported token counts explain; other, un-imported usage on the same account and window also moves this meter and is folded into background_points_per_interval, not attributed to any model";

interface MeterWindow {
  principalId: string;
  meterId: string;
  windowMinutes: number;
}

/** One row per (meter_id, window) this build currently has a *percent*
 * reading for -- the only quantity unit the percent-delta math applies to.
 * Windowless meters (`window: null`) and non-percent quantities (tokens,
 * requests, credits -- local pools) are not eligible for this learner. Reads
 * only the currently-tracked windows (`latestPerWindow`'s own scope), so a
 * meter/window this build has stopped polling entirely is not offered here
 * even if `usage.db` still has old token records for it. */
function eligibleMeterWindows(store: HeadroomStore, meterId: string | undefined): MeterWindow[] {
  const latest = store.latestPerWindow(meterId);
  const seen = new Set<string>();
  const result: MeterWindow[] = [];
  for (const observation of latest) {
    if (observation.quantity?.unit !== "percent") continue;
    if (observation.window?.kind === "state" || observation.window?.kind === "count") continue;
    const windowMinutes = observation.window?.minutes;
    if (!windowMinutes) continue;
    const key = `${observation.meter_id} ${windowMinutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ principalId: observation.principal_id, meterId: observation.meter_id, windowMinutes });
  }
  return result;
}

export interface ComputedRate {
  meterId: string;
  principalId: string;
  windowMinutes: number;
  model: string;
  outcome: FitOutcome;
  /** The fit now on record for this (meter, principal, model) after this
   * run -- either a fit persisted just now, or the most recent one from an
   * earlier run when this run's own window has nothing new (or too little
   * data) to add. `undefined` only when neither exists. */
  stored: RateFitRow | undefined;
  /** Set only when this run itself detected and persisted a `rate_changed`
   * event; use `lastChangedAt` for the durable "when did this last change"
   * figure regardless of which run detected it. */
  driftEvent: RateEventRow | undefined;
  lastChangedAt: string | null;
  isNewFit: boolean;
}

/**
 * Computes (and persists, where the observation window has moved) a rate
 * fit for every eligible (meter, principal, model) this account currently
 * has percent-meter history and imported Claude token counts for, optionally
 * narrowed by `meterId`/`model`/`principalAlias`.
 */
export function computeRates(
  headroomStore: HeadroomStore,
  usageStore: UsageStore,
  options: { meterId?: string; model?: string; principalAlias?: string; sinceIsoValue: string },
): ComputedRate[] {
  const sinceMs = Date.parse(options.sinceIsoValue);
  const meterWindows = eligibleMeterWindows(headroomStore, options.meterId)
    .filter((mw) => options.principalAlias === undefined || mw.principalId === options.principalAlias);
  const results: ComputedRate[] = [];

  for (const mw of meterWindows) {
    const principalKeyHash = usageStore.hashAlias("principal", mw.principalId);
    const meterKeyHash = usageStore.hashAlias("meter", `${mw.meterId}:${mw.windowMinutes}`);

    const rawHistory = headroomStore.history(mw.meterId, options.sinceIsoValue)
      .filter((observation) => observation.quantity?.unit === "percent" && observation.window?.minutes === mw.windowMinutes);
    const points: MeterObservationPoint[] = rawHistory.map((observation) => ({
      usedPercent: observation.quantity?.used ?? null,
      fetchedAtMs: Date.parse(observation.fetched_at),
    }));
    const resetTimestampsMs = headroomStore.events(options.sinceIsoValue)
      .filter((event) => event.meter_id === mw.meterId && (event.kind === "reset_seen" || event.kind === "free_reset_used"))
      .map((event) => Date.parse(event.created_at));
    const intervals = buildMeterIntervals(points, resetTimestampsMs);

    const identities: UsageIdentityPoint[] = usageStore.claudeUsageRows({ principalKeyHash, sinceMs }).map((row) => ({
      model: row.model,
      observedAtMs: row.observedAtMs,
      tokens: { fresh_input: row.freshInput, cache_read: row.cacheRead, cache_write: row.cacheWrite, output: row.output },
    }));
    const samples = attributeIntervals(intervals, identities);
    const byModel = groupSamplesByModel(samples);
    const modelsToFit = options.model ? [options.model] : [...byModel.keys()];

    for (const model of modelsToFit) {
      const modelSamples = byModel.get(model) ?? [];
      const outcome: FitOutcome = modelSamples.length
        ? fitModelRate(modelSamples)
        : { status: "insufficient_data", model, sampleCount: 0, minSamples: MIN_FIT_SAMPLES };

      const existing = usageStore.rateFitHistory(meterKeyHash, principalKeyHash, model, 1)[0];
      let stored = existing;
      let driftEvent: RateEventRow | undefined;
      let isNewFit = false;

      if (outcome.status === "fit") {
        const windowToMs = outcome.fit.windowToMs;
        const hasNewObservations = !existing || Date.parse(existing.windowTo) < windowToMs;
        if (hasNewObservations) {
          const newRow = usageStore.putRateFit({
            meterKey: meterKeyHash,
            principalKey: principalKeyHash,
            model,
            windowMinutes: mw.windowMinutes,
            sampleCount: outcome.fit.sampleCount,
            ratePerMillion: outcome.fit.ratePerMillion,
            rateBackgroundPerInterval: outcome.fit.rateBackgroundPerInterval,
            coverage: outcome.fit.coverage,
            rSquared: outcome.fit.rSquared,
            windowFrom: new Date(outcome.fit.windowFromMs).toISOString(),
            windowTo: new Date(windowToMs).toISOString(),
          });
          isNewFit = true;
          if (existing) {
            const drift = detectDrift(existing, newRow);
            if (drift) {
              driftEvent = usageStore.putRateEvent({
                kind: "rate_changed", meterKey: meterKeyHash, principalKey: principalKeyHash, model,
                priorFitId: existing.id, newFitId: newRow.id, changedClass: drift.changedClass, relativeChange: drift.relativeChange,
              });
            }
          }
          stored = newRow;
        }
      }

      const lastChangedAt = driftEvent?.createdAt ?? usageStore.latestRateEvent(meterKeyHash, principalKeyHash, model)?.createdAt ?? null;
      results.push({ meterId: mw.meterId, principalId: mw.principalId, windowMinutes: mw.windowMinutes, model, outcome, stored, driftEvent, lastChangedAt, isNewFit });
    }
  }
  return results.sort((a, b) =>
    a.meterId.localeCompare(b.meterId) || a.windowMinutes - b.windowMinutes || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Fixed field order, space-separated `key=value` tokens, no colour, no
 * prose -- the same dense-line convention `usage import-status`'s
 * `totalHumanLine` already uses, and the one status-view.ts documents as
 * what a pipe, a redirect, or an agent shell gets. Used for both the default
 * and `--agent`/`--plain` forms: this output is inherently tabular for
 * either audience, so there is no separate "pretty" renderer to keep in
 * sync. */
function denseLine(item: ComputedRate): string {
  const parts = [
    `meter=${item.meterId}`,
    `window=${labelForMinutes(item.windowMinutes)}`,
    `model=${item.model}`,
  ];
  if (!item.stored) {
    const sampleCount = item.outcome.status === "insufficient_data" ? item.outcome.sampleCount : 0;
    parts.push("status=insufficient_data", `samples=${sampleCount}`, `minSamples=${MIN_FIT_SAMPLES}`);
    return parts.join(" ");
  }
  const rate = item.stored.ratePerMillion;
  parts.push(
    "status=fit",
    `samples=${item.stored.sampleCount}`,
    ...RATE_TOKEN_CLASSES.map((tokenClass) => `${tokenClass}=${rate[tokenClass].toFixed(3)}`),
    `background=${item.stored.rateBackgroundPerInterval.toFixed(4)}`,
    `coverage=${item.stored.coverage.toFixed(2)}`,
    `r2=${item.stored.rSquared.toFixed(2)}`,
    `lastFit=${item.stored.createdAt}`,
    `lastChanged=${item.lastChangedAt ?? "never"}`,
  );
  return parts.join(" ");
}

/** Exported so mcp.ts's `quota_rates` tool renders the exact same JSON shape
 * as `headroom rates --json`'s `rates` array entries -- one contract, one
 * place it is built. */
export function rateRowToJson(item: ComputedRate): Record<string, unknown> {
  const base = {
    meter_id: item.meterId,
    principal_id: item.principalId,
    window_minutes: item.windowMinutes,
    model: item.model,
  };
  if (!item.stored) {
    const sampleCount = item.outcome.status === "insufficient_data" ? item.outcome.sampleCount : 0;
    return { ...base, status: "insufficient_data", sample_count: sampleCount, min_samples: MIN_FIT_SAMPLES };
  }
  return {
    ...base,
    status: "fit",
    sample_count: item.stored.sampleCount,
    min_samples: MIN_FIT_SAMPLES,
    rate_per_million_tokens: item.stored.ratePerMillion,
    background_points_per_interval: item.stored.rateBackgroundPerInterval,
    coverage: item.stored.coverage,
    r_squared: item.stored.rSquared,
    window_from: item.stored.windowFrom,
    window_to: item.stored.windowTo,
    last_fit_at: item.stored.createdAt,
    last_changed_at: item.lastChangedAt,
  };
}

export async function ratesCommand(argv: string[]): Promise<number> {
  const asJson = argv.includes("--json");
  const agent = argv.includes("--agent") || argv.includes("--plain");
  const meterId = option(argv, "--meter");
  const model = option(argv, "--model");
  const principalAlias = option(argv, "--principal");
  const sinceIsoValue = sinceIso(option(argv, "--since"));
  void agent; // the dense form is unconditional -- see denseLine's own doc

  let headroomStore: HeadroomStore | undefined;
  let usageStore: UsageStore | undefined;
  try {
    headroomStore = await HeadroomStore.open();
    // create: false, matching `usage import-status`: a read (and possibly a
    // fit, itself only ever additive to an existing database) must never
    // bring usage.db into existence just because someone ran `headroom
    // rates` before ever running `headroom usage import`.
    usageStore = await UsageStore.open({ create: false });
    if (!usageStore) {
      if (asJson) console.log(JSON.stringify(withContract({ rates: [], since: sinceIsoValue, bias_note: RATES_BIAS_NOTE })));
      else console.log("no usage data imported yet (headroom usage import has not been run)");
      return 0;
    }

    const items = computeRates(headroomStore, usageStore, { meterId, model, principalAlias, sinceIsoValue });
    headroomStore.audit("cli", "rates", meterId ?? null, "ok");

    if (asJson) {
      console.log(JSON.stringify(withContract({ rates: items.map(rateRowToJson), since: sinceIsoValue, bias_note: RATES_BIAS_NOTE })));
      return 0;
    }
    if (!items.length) {
      console.log(meterId ? `no percent meter found for ${meterId}` : "no percent meters tracked yet");
      return 0;
    }
    for (const item of items) console.log(denseLine(item));
    console.log(`(${RATES_BIAS_NOTE})`);
    return 0;
  } finally {
    usageStore?.close();
    headroomStore?.close();
  }
}
