/**
 * The points-per-token rate learner (issue #53, items 2-3): fits, per
 * principal meter and model, how many meter points a million tokens of each
 * class costs, by regressing the meter's own observed percent deltas against
 * `headroom usage import`'s already-persisted token counts for the same
 * interval -- and tracks how that fit drifts over time.
 *
 * Every function here is pure and filesystem-free: the CLI layer
 * (rates-cli.ts) is the only place that reads `headroom.db`/`usage.db` and
 * calls these with plain data, which is what makes the reset-straddling,
 * insufficient-data and drift-detection rules independently testable without
 * a database.
 *
 * ## Why this only fits Claude rows
 *
 * The four token classes here (`fresh_input`, `cache_read`, `cache_write`,
 * `output`) are usage-events.ts's Claude vocabulary
 * (`input_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`/
 * `output_tokens`). Codex's counter vocabulary
 * (`cached_input`/`cache_write`/`reasoning`/`total`, see
 * codex-usage-events.ts) does not line up with it cleanly enough to reuse
 * without an unstated assumption about which Codex counter plays which
 * Claude-shaped role -- `cached_input` is not obviously "cache read" in the
 * same pricing sense, and Codex's `total` and `reasoning` have no Claude
 * analogue at all. Fitting Codex rates with an honest, separate class
 * vocabulary is future work; see usage-prediction.md.
 *
 * ## Why coverage is a real limitation, not a caveat
 *
 * A meter's percent reading moves for every request on that account and
 * window, not only the ones an operator has imported into `usage.db` (see
 * usage-prediction.md's own "coverage" markers on `usage import`). This
 * module never assumes imported usage is the whole story: every fit
 * includes a non-negative background/intercept term absorbing whatever
 * percent movement the four imported token classes cannot explain, and
 * `coverage` reports the explained share -- see `fitModelRate`'s doc for the
 * exact definition. A model's fitted per-token rates can still be biased
 * upward if un-imported usage happens to correlate with imported usage
 * within the same interval (e.g. both come from the same account being
 * busy at the same time); this module has no way to detect or correct that,
 * and `usage-prediction.md` says so.
 */
import { nnls } from "./rate-nnls.js";
import { RATE_TOKEN_CLASSES, type RateTokenClass } from "./usage-store.js";

export { RATE_TOKEN_CLASSES };
export type { RateTokenClass };

/** Below this many attributable sample intervals, a fit is refused outright
 * (`{ status: "insufficient_data" }`) rather than reported with an
 * unqualified number: five token-class-plus-background coefficients need at
 * least that many independent constraints to be identified at all, and a
 * handful more margin keeps a bare-minimum fit from reading as confident. */
export const MIN_FIT_SAMPLES = 8;

/** A fitted rate is trusted for drift comparison only once its own r-squared
 * clears this bar; below it, a fit swings too easily on ordinary sampling
 * noise (a quiet week, a handful of very large intervals) for a rate
 * difference to mean the underlying price actually changed. */
export const DRIFT_MIN_R_SQUARED = 0.5;

/** A newer fit's rate for some token class must move at least this much,
 * relative to the larger of the two fits' rates for that class, to be
 * reported as `rate_changed` -- ordinary sample-to-sample refitting noise on
 * real (not synthetic) usage data is expected to be well under this. */
export const DRIFT_RELATIVE_THRESHOLD = 0.25;

const PER_MILLION = 1_000_000;

export interface TokenTotals {
  fresh_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

function emptyTotals(): TokenTotals {
  return { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0 };
}

// ---------------------------------------------------------------------------
// Meter intervals
// ---------------------------------------------------------------------------

export interface MeterObservationPoint {
  /** `null` when the observation carried no percent (e.g. a failed or
   * not_enforced read) -- excluded from every interval it would touch. */
  usedPercent: number | null;
  fetchedAtMs: number;
}

export interface MeterInterval {
  fromMs: number;
  toMs: number;
  deltaPercent: number;
}

/**
 * Turns one meter's observation history into consecutive same-window
 * intervals with their percent delta, excluding:
 *
 * - either endpoint carrying no percent (nothing to difference),
 * - a negative delta -- the meter can only go up between two observations of
 *   the *same* window unless it reset in between (mirrors `isUsageReset` in
 *   store.ts, which uses the same "the number went down" signal),
 * - an interval a known reset timestamp falls inside (`resetTimestampsMs`,
 *   ordinarily each meter's `reset_seen`/`free_reset_used` event times):
 *   caught even when the raw numbers happen to look like ordinary growth,
 *   e.g. a reset immediately followed by enough same-poll usage to net
 *   non-negative.
 *
 * `points` need not arrive sorted; this sorts by `fetchedAtMs` first so a
 * caller's own SQL ordering is never load-bearing.
 */
export function buildMeterIntervals(points: readonly MeterObservationPoint[], resetTimestampsMs: readonly number[]): MeterInterval[] {
  const sorted = [...points].sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  const intervals: MeterInterval[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.usedPercent === null || current.usedPercent === null) continue;
    const deltaPercent = current.usedPercent - previous.usedPercent;
    if (deltaPercent < 0) continue;
    const straddlesReset = resetTimestampsMs.some((resetMs) => resetMs > previous.fetchedAtMs && resetMs <= current.fetchedAtMs);
    if (straddlesReset) continue;
    intervals.push({ fromMs: previous.fetchedAtMs, toMs: current.fetchedAtMs, deltaPercent });
  }
  return intervals;
}

// ---------------------------------------------------------------------------
// Attribution: which model's imported usage explains which interval
// ---------------------------------------------------------------------------

export interface UsageIdentityPoint {
  model: string;
  observedAtMs: number;
  tokens: TokenTotals;
}

export interface AttributedSample {
  fromMs: number;
  toMs: number;
  deltaPercent: number;
  model: string;
  tokens: TokenTotals;
}

/**
 * For each interval, sums imported per-request token records observed in
 * `(fromMs, toMs]` (the same half-open convention `buildMeterIntervals` uses
 * for a reset timestamp), grouped by model.
 *
 * An interval becomes a sample only when exactly one model produced
 * imported tokens in it. A mixed-model interval is dropped from *every*
 * model's fit rather than split by some assumed ratio -- there is no
 * evidence in a meter's own percent reading for how to divide one interval's
 * movement between two models. An interval with no imported tokens at all is
 * dropped too (nothing to regress there). Both kinds of drop are why
 * `coverage`/the sample count can be well below the interval count even on
 * an account with plenty of imported usage; see the module doc.
 */
export function attributeIntervals(intervals: readonly MeterInterval[], identities: readonly UsageIdentityPoint[]): AttributedSample[] {
  const samples: AttributedSample[] = [];
  for (const interval of intervals) {
    const byModel = new Map<string, TokenTotals>();
    for (const identity of identities) {
      if (identity.observedAtMs <= interval.fromMs || identity.observedAtMs > interval.toMs) continue;
      const totals = byModel.get(identity.model) ?? emptyTotals();
      totals.fresh_input += identity.tokens.fresh_input;
      totals.cache_read += identity.tokens.cache_read;
      totals.cache_write += identity.tokens.cache_write;
      totals.output += identity.tokens.output;
      byModel.set(identity.model, totals);
    }
    if (byModel.size !== 1) continue;
    const [[model, tokens]] = byModel;
    if (tokens.fresh_input === 0 && tokens.cache_read === 0 && tokens.cache_write === 0 && tokens.output === 0) continue;
    samples.push({ fromMs: interval.fromMs, toMs: interval.toMs, deltaPercent: interval.deltaPercent, model, tokens });
  }
  return samples;
}

/** Splits a mixed-model sample list into one array per model, sorted so
 * `fitModelRate`'s own `windowFromMs`/`windowToMs` come out chronological. */
export function groupSamplesByModel(samples: readonly AttributedSample[]): Map<string, AttributedSample[]> {
  const groups = new Map<string, AttributedSample[]>();
  for (const sample of samples) {
    const list = groups.get(sample.model) ?? [];
    list.push(sample);
    groups.set(sample.model, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.fromMs - b.fromMs);
  return groups;
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export interface RateFit {
  model: string;
  sampleCount: number;
  /** Points per 1,000,000 tokens of each class. */
  ratePerMillion: TokenTotals;
  /** Points per interval attributed to everything *other* than the four
   * imported token classes (other lanes, other machines, un-imported files
   * on the same account and window). Not per-token. */
  rateBackgroundPerInterval: number;
  /** Share (0..1) of the fit's total sample delta explained by the four
   * token-class terms; `1 - coverage` is (proportionally) the background
   * term's share. See the module doc for the bias this cannot correct. */
  coverage: number;
  /** Coefficient of determination against the fit's own samples, 0..1. */
  rSquared: number;
  windowFromMs: number;
  windowToMs: number;
}

export type FitOutcome =
  | { status: "fit"; fit: RateFit }
  | { status: "insufficient_data"; model: string; sampleCount: number; minSamples: number };

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Fits one model's rate from its (already model-filtered, chronologically
 * sorted) samples via non-negative least squares over five non-negative
 * columns: the four token classes plus a constant "background" column of
 * 1s. The background column is what makes `coverage` meaningful: with it
 * present, the feasible NNLS solution "all class rates zero, background =
 * mean(deltaPercent)" is always reachable (every sample delta is >= 0 after
 * `buildMeterIntervals`'s own filtering, so that mean is >= 0), which is
 * exactly the "explain nothing, worse than that is impossible" floor --
 * `rSquared` is therefore guaranteed non-negative, never a value that would
 * read as "this fit is actively wrong".
 *
 * Refuses below `MIN_FIT_SAMPLES` rather than returning a fit built on too
 * few constraints to identify five coefficients with any confidence.
 */
export function fitModelRate(samples: readonly AttributedSample[]): FitOutcome {
  if (samples.length === 0) return { status: "insufficient_data", model: "", sampleCount: 0, minSamples: MIN_FIT_SAMPLES };
  const model = samples[0].model;
  if (samples.length < MIN_FIT_SAMPLES) return { status: "insufficient_data", model, sampleCount: samples.length, minSamples: MIN_FIT_SAMPLES };

  const ordered = [...samples].sort((a, b) => a.fromMs - b.fromMs);
  const a = ordered.map((sample) => [sample.tokens.fresh_input, sample.tokens.cache_read, sample.tokens.cache_write, sample.tokens.output, 1]);
  const b = ordered.map((sample) => sample.deltaPercent);
  const { coefficients } = nnls(a, b);
  const [freshInput, cacheRead, cacheWrite, output, background] = coefficients;

  const totalDelta = b.reduce((sum, value) => sum + value, 0);
  const explained = ordered.reduce((sum, sample) =>
    sum + freshInput * sample.tokens.fresh_input + cacheRead * sample.tokens.cache_read + cacheWrite * sample.tokens.cache_write + output * sample.tokens.output, 0);
  const coverage = totalDelta > 0 ? clampUnitInterval(explained / totalDelta) : 0;

  const meanDelta = totalDelta / b.length;
  const totalSumSquares = b.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0);
  const predicted = ordered.map((sample) =>
    freshInput * sample.tokens.fresh_input + cacheRead * sample.tokens.cache_read + cacheWrite * sample.tokens.cache_write + output * sample.tokens.output + background);
  const residualSumSquares = b.reduce((sum, value, i) => sum + (value - predicted[i]) ** 2, 0);
  const rSquared = totalSumSquares > 0 ? clampUnitInterval(1 - residualSumSquares / totalSumSquares) : 0;

  return {
    status: "fit",
    fit: {
      model,
      sampleCount: ordered.length,
      ratePerMillion: {
        fresh_input: freshInput * PER_MILLION,
        cache_read: cacheRead * PER_MILLION,
        cache_write: cacheWrite * PER_MILLION,
        output: output * PER_MILLION,
      },
      rateBackgroundPerInterval: background,
      coverage,
      rSquared,
      windowFromMs: ordered[0].fromMs,
      windowToMs: ordered[ordered.length - 1].toMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface DriftResult {
  changedClass: RateTokenClass;
  relativeChange: number;
}

/**
 * Compares two fits for the same (meter, principal, model) and reports the
 * largest relative per-class rate change, if any class moved by at least
 * `DRIFT_RELATIVE_THRESHOLD` and both fits clear `DRIFT_MIN_R_SQUARED`.
 * `undefined` means "no reportable drift" -- either every class is stable, or
 * one of the two fits is not confident enough to trust the comparison at
 * all (a low-r-squared fit swinging back toward a prior rate is not
 * evidence the underlying price changed back).
 */
export function detectDrift(prior: Pick<RateFit, "ratePerMillion" | "rSquared">, next: Pick<RateFit, "ratePerMillion" | "rSquared">): DriftResult | undefined {
  if (prior.rSquared < DRIFT_MIN_R_SQUARED || next.rSquared < DRIFT_MIN_R_SQUARED) return undefined;
  let worst: DriftResult | undefined;
  for (const tokenClass of RATE_TOKEN_CLASSES) {
    const before = prior.ratePerMillion[tokenClass];
    const after = next.ratePerMillion[tokenClass];
    const denominator = Math.max(before, after, 1e-9);
    const relativeChange = Math.abs(after - before) / denominator;
    if (relativeChange >= DRIFT_RELATIVE_THRESHOLD && (!worst || relativeChange > worst.relativeChange)) worst = { changedClass: tokenClass, relativeChange };
  }
  return worst;
}
