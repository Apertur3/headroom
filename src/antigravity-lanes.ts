/**
 * The one Antigravity lane-state classifier. Both Antigravity sources feed it:
 * the daemon's local read (the native engine's observations of agy's quota
 * summary) and the remote retrieveUserQuota adapter. Each source only turns
 * its own payload into `AntigravityPayload`; every decision about what a lane
 * means is made here, so the two paths cannot drift apart again.
 *
 * agy does not always send four fresh lanes. The states it really sends:
 *
 * - `fresh`: the bucket carries a remaining fraction.
 * - `blocked_by_weekly`: the 5h bucket is disabled, carries no fraction, or is
 *   absent while the same group's weekly lane is exhausted. There is no usage
 *   to report and no capacity to spend until the weekly resets. Stored as
 *   `failed` (the contract's fail-closed value; `not_enforced` would tell 1.0
 *   consumers the lane is capless) with the reason "blocked: weekly exhausted
 *   until <reset>" and `metadata.lane_state`, never as an invented number.
 * - `loading`: the bucket is reported without usage and nothing explains it
 *   (for a weekly lane: the engine's readiness wait never saw it populate).
 * - `missing`: the vendor sent no bucket for the lane. A 5h lane goes idle
 *   this way (issue #55) and reads as `not_enforced`; a missing weekly lane
 *   is a failed read.
 * - `unavailable`: agy answered without a quota summary (availability-only,
 *   or per-model quotas with no 5h/weekly lanes).
 * - `error`: the whole meter failed; the source's own error text is kept.
 *
 * A read is complete when every expected lane is present and settled
 * (`fresh` or `blocked_by_weekly`). One lane in any other state never turns
 * the other lanes' readings into a failure.
 *
 * Pure: no I/O, no clock, no imports beyond types. Callers redact any vendor
 * text before it gets here.
 */
import type { Observation } from "./types.js";

export const ANTIGRAVITY_METERS = ["gemini", "claude-gpt"] as const;
export type AntigravityMeter = typeof ANTIGRAVITY_METERS[number];
export const ANTIGRAVITY_WINDOWS = [
  { name: "5h", minutes: 300, kind: "rolling" },
  { name: "weekly", minutes: 10_080, kind: "fixed" },
] as const;
export type AntigravityWindowMinutes = typeof ANTIGRAVITY_WINDOWS[number]["minutes"];

export type AntigravityLaneState = "fresh" | "blocked_by_weekly" | "loading" | "missing" | "unavailable" | "error";
/** What agy (or the engine) answered with, independent of any lane's state. */
export type AntigravityPayloadKind = "quota_summary" | "model_quota_fallback" | "availability_only" | "error";

export interface AntigravityBucket {
  meter: AntigravityMeter;
  minutes: AntigravityWindowMinutes;
  /** Remaining fraction, 0..1, when the vendor sent one. */
  remaining: number | null;
  /** False when the bucket was sent without usable usage (disabled, or no fraction). */
  usageKnown: boolean;
  disabled: boolean | null;
  resetsAt: string | null;
  /** The engine's placeholder for a lane its readiness wait never saw. */
  notReported?: boolean;
}

export type AntigravityPayload =
  | { kind: "quota_summary"; buckets: AntigravityBucket[] }
  /** `reason` replaces the default explanation (the remote adapter names the tier). */
  | { kind: "model_quota_fallback" | "availability_only"; reason?: string }
  | { kind: "error"; error: string };

export interface AntigravityLane {
  meter: AntigravityMeter;
  minutes: AntigravityWindowMinutes;
  state: AntigravityLaneState;
  /** Remaining fraction, only on a fresh lane. */
  remaining: number | null;
  resetsAt: string | null;
  reason: string | null;
  /** The weekly reset that unblocks a blocked_by_weekly lane. */
  blockedUntil: string | null;
}

export interface AntigravityClassification {
  payloadKind: AntigravityPayloadKind;
  lanes: AntigravityLane[];
  complete: boolean;
}

export const MISSING_FIVE_HOUR_REASON = "vendor sent no 5h bucket in this response";
export const MISSING_WEEKLY_REASON = "vendor returned no quota bucket for this window";
export const WEEKLY_LOADING_REASON = "quota summary not ready: weekly lane still loading";
const UNAVAILABLE_REASON: Record<"model_quota_fallback" | "availability_only", string> = {
  availability_only: "agy returned availability only; no quota summary yet",
  model_quota_fallback: "agy returned per-model quotas only; no 5h or weekly lanes",
};

export function blockedByWeeklyReason(resetsAt: string | null): string {
  return `blocked: weekly exhausted until ${resetsAt ?? "its reset (time not reported)"}`;
}

const SETTLED: ReadonlySet<AntigravityLaneState> = new Set(["fresh", "blocked_by_weekly"]);
export function isSettledLane(state: AntigravityLaneState): boolean { return SETTLED.has(state); }

function windowName(minutes: AntigravityWindowMinutes): string { return minutes === 300 ? "5h" : "weekly"; }

/** The most constrained bucket with usage wins, the same choice CodexBar's own
 * representative makes; a bucket without usage only counts when no bucket
 * for the lane carries any. */
function pick(buckets: AntigravityBucket[], meter: AntigravityMeter, minutes: AntigravityWindowMinutes): AntigravityBucket | undefined {
  const lane = buckets.filter((bucket) => bucket.meter === meter && bucket.minutes === minutes);
  const known = lane.filter((bucket) => bucket.usageKnown && bucket.remaining !== null)
    .sort((left, right) => (left.remaining as number) - (right.remaining as number));
  return known[0] ?? lane.find((bucket) => !bucket.notReported) ?? lane[0];
}

function lane(meter: AntigravityMeter, minutes: AntigravityWindowMinutes, state: AntigravityLaneState, reason: string | null, extra: Partial<AntigravityLane> = {}): AntigravityLane {
  return { meter, minutes, state, remaining: null, resetsAt: null, reason, blockedUntil: null, ...extra };
}

function classifySummaryLane(buckets: AntigravityBucket[], meter: AntigravityMeter, minutes: AntigravityWindowMinutes): AntigravityLane {
  const bucket = pick(buckets, meter, minutes);
  if (bucket?.usageKnown && bucket.remaining !== null) {
    return lane(meter, minutes, "fresh", null, { remaining: Math.max(0, Math.min(1, bucket.remaining)), resetsAt: bucket.resetsAt });
  }
  if (minutes === 300) {
    const weekly = pick(buckets, meter, 10_080);
    const weeklyExhausted = weekly?.usageKnown === true && weekly.remaining !== null && weekly.remaining <= 0;
    // Disabled, fraction-less or absent: with the weekly spent, the 5h lane
    // has nothing to report and nothing to spend until the weekly resets.
    if (weeklyExhausted && !bucket?.notReported) return lane(meter, minutes, "blocked_by_weekly", blockedByWeeklyReason(weekly.resetsAt), { blockedUntil: weekly.resetsAt });
  }
  if (!bucket) return minutes === 300 ? lane(meter, minutes, "missing", MISSING_FIVE_HOUR_REASON) : lane(meter, minutes, "missing", MISSING_WEEKLY_REASON);
  if (bucket.notReported) return lane(meter, minutes, "loading", minutes === 300 ? "quota summary not ready: 5h lane still loading" : WEEKLY_LOADING_REASON);
  const why = bucket.disabled ? "bucket disabled" : "no remaining fraction";
  return lane(meter, minutes, "loading", `vendor sent the ${windowName(minutes)} bucket without usage (${why})`);
}

export function classifyAntigravityLanes(payload: AntigravityPayload): AntigravityClassification {
  const lanes = ANTIGRAVITY_METERS.flatMap((meter) => ANTIGRAVITY_WINDOWS.map(({ minutes }) => {
    switch (payload.kind) {
      case "quota_summary": return classifySummaryLane(payload.buckets, meter, minutes);
      case "error": return lane(meter, minutes, "error", payload.error);
      default: return lane(meter, minutes, "unavailable", payload.reason ?? UNAVAILABLE_REASON[payload.kind]);
    }
  }));
  return { payloadKind: payload.kind, lanes, complete: lanes.every((item) => isSettledLane(item.state)) };
}

export interface LaneObservationOptions {
  now: string;
  source: string;
  adapterVersion?: string;
  upstreamSchemaVersion?: string;
  /** The source's own fresh row for a lane, kept as-is (it may carry a doubt
   * marker or timestamps the classifier must not rewrite). */
  freshRow?: (meter: AntigravityMeter, minutes: AntigravityWindowMinutes) => Observation | undefined;
}

/** One observation per expected lane, in ANTIGRAVITY_METERS x ANTIGRAVITY_WINDOWS order. */
export function antigravityLaneObservations(classification: AntigravityClassification, principal: string, options: LaneObservationOptions): Observation[] {
  return classification.lanes.map((item) => {
    const window = ANTIGRAVITY_WINDOWS.find((candidate) => candidate.minutes === item.minutes)!;
    const base = {
      principal_id: principal, meter_id: `${principal}:${item.meter}`, window: { kind: window.kind, minutes: window.minutes, enforcement: "hard" as const },
      observed_at: options.now, fetched_at: options.now, source: options.source,
      adapter_version: options.adapterVersion ?? "native-ts", upstream_schema_version: options.upstreamSchemaVersion ?? "v0.56.4",
    };
    if (item.state === "fresh") {
      const existing = options.freshRow?.(item.meter, item.minutes);
      if (existing) return existing;
      const used = Math.round(Math.max(0, Math.min(100, (1 - (item.remaining as number)) * 100)) * 1_000_000) / 1_000_000;
      return { ...base, quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" as const }, resets_at: item.resetsAt, truth: "official" as const, freshness: "fresh" as const, confidence: 1 };
    }
    // A blocked lane is `failed`, the contract's fail-closed value: 1.0
    // consumers read `not_enforced` as capless and would dispatch. The
    // additive metadata lets Headroom's own readers name the state.
    if (item.state === "blocked_by_weekly") {
      return { ...base, quantity: null, resets_at: null, truth: "official" as const, freshness: "failed" as const, confidence: 1, reason: item.reason, metadata: { lane_state: "blocked_by_weekly" as const, blocked_until: item.blockedUntil } };
    }
    if (item.state === "missing" && item.minutes === 300) {
      return { ...base, quantity: null, resets_at: null, truth: "official" as const, freshness: "not_enforced" as const, confidence: 1, reason: item.reason };
    }
    return { ...base, quantity: null, resets_at: null, truth: "estimated" as const, freshness: "failed" as const, confidence: 0, reason: item.reason };
  });
}

/** Facts the native engine attaches (additively) to each Antigravity row. */
export interface EngineLaneFacts {
  payload_kind?: string;
  /** "reported": the bucket was in agy's summary; "not_reported": the engine's placeholder for a lane it never saw. */
  bucket?: "reported" | "not_reported";
  usage_known?: boolean;
  disabled?: boolean | null;
}

type EngineRow = Observation & { lane?: EngineLaneFacts };

export interface EngineRead {
  payload: AntigravityPayload;
  /** The engine's own fresh row per lane, keyed `meter:minutes`. */
  fresh: Map<string, Observation>;
  /** Rows outside the four lanes (per-model fallback windows), passed through. */
  extra: Observation[];
}

const PAYLOAD_KINDS: ReadonlySet<string> = new Set(["quota_summary", "model_quota_fallback", "availability_only"]);

function stripFacts(row: EngineRow): Observation {
  if (!("lane" in row)) return row;
  const { lane: _facts, ...rest } = row;
  return rest;
}

function laneKey(meter: string, minutes: number): string { return `${meter}:${minutes}`; }

/**
 * Turns one principal's native-engine rows into a classifier payload. Rows
 * from an engine without lane facts still classify: a fresh windowed row is a
 * known bucket and a failed windowed row is the engine's not-ready placeholder.
 */
export function antigravityPayloadFromEngineRows(rows: Observation[], principal: string): EngineRead {
  const own = (rows as EngineRow[]).filter((row) => row.principal_id === principal);
  const fresh = new Map<string, Observation>();
  const wholeMeter = own.find((row) => row.freshness === "failed" && !row.window);
  if (wholeMeter) return { payload: { kind: "error", error: wholeMeter.reason ?? "native Antigravity read failed" }, fresh, extra: [] };
  if (!own.length) return { payload: { kind: "error", error: "native engine returned no Antigravity rows" }, fresh, extra: [] };
  const declared = own.map((row) => row.lane?.payload_kind).find((kind): kind is string => kind !== undefined && PAYLOAD_KINDS.has(kind));
  const isLane = (row: Observation): boolean => (row.window?.minutes === 300 || row.window?.minutes === 10_080)
    && ANTIGRAVITY_METERS.some((meter) => row.meter_id === `${principal}:${meter}`);
  const kind = declared ?? (own.some(isLane) ? "quota_summary" : "model_quota_fallback");
  if (kind === "availability_only") return { payload: { kind }, fresh, extra: [] };
  if (kind === "model_quota_fallback") return { payload: { kind }, fresh, extra: own.filter((row) => !isLane(row) && row.freshness === "fresh").map(stripFacts) };
  const buckets: AntigravityBucket[] = [];
  const extra: Observation[] = [];
  for (const row of own) {
    if (!isLane(row)) { extra.push(stripFacts(row)); continue; }
    const meter = row.meter_id.slice(principal.length + 1) as AntigravityMeter;
    const minutes = row.window!.minutes as AntigravityWindowMinutes;
    const facts = row.lane;
    if (row.freshness === "fresh" && row.quantity && facts?.usage_known !== false) {
      const remainingPercent = row.quantity.remaining ?? (100 - row.quantity.used);
      buckets.push({ meter, minutes, remaining: remainingPercent / 100, usageKnown: true, disabled: facts?.disabled ?? null, resetsAt: row.resets_at });
      const key = laneKey(meter, minutes);
      const previous = fresh.get(key);
      if (!previous || (previous.quantity?.used ?? 0) < row.quantity.used) fresh.set(key, stripFacts(row));
    } else if (facts?.bucket === "reported") {
      buckets.push({ meter, minutes, remaining: null, usageKnown: false, disabled: facts.disabled ?? null, resetsAt: null });
    } else {
      buckets.push({ meter, minutes, remaining: null, usageKnown: false, disabled: null, resetsAt: null, notReported: true });
    }
  }
  return { payload: { kind: "quota_summary", buckets }, fresh, extra };
}

/** The per-lane fresh row the engine sent, for antigravityLaneObservations. */
export function engineFreshRow(read: EngineRead): (meter: AntigravityMeter, minutes: AntigravityWindowMinutes) => Observation | undefined {
  return (meter, minutes) => read.fresh.get(laneKey(meter, minutes));
}
