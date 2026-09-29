/**
 * Loads `observe --record` files from test/fixtures/antigravity/ and turns one
 * recorded principal into what each Antigravity path actually receives: the
 * native engine's observation rows (the local path) or a retrieveUserQuota
 * body (the remote path). engineRowsFromRecord mirrors
 * HeadroomEngine.antigravityWindows; engine/Tests/HeadroomEngineTests/
 * AntigravityLaneFactsTests.swift checks the engine side against the same
 * recorded fixture.
 */
import { readFile } from "node:fs/promises";
import type { AntigravityMeter } from "../../src/antigravity-lanes.js";
import type { Observation } from "../../src/types.js";

export interface RecordBucket {
  bucket_id: string; group: string; name: string; disabled: boolean;
  remaining_fraction: number | null; usage_known: boolean; reset_time: string | null; reset_description: string | null;
}
export interface RecordModel { label: string; model_id: string; remaining_fraction: number | null; reset_time: string | null }
export interface RecordPrincipal {
  principal: string; vendor: string; payload_kind: string; source: "local" | "remote" | null; account: string;
  buckets: RecordBucket[]; model_quotas: RecordModel[]; error: string | null; extraction_errors: string[];
}
export interface RecordFile { schema: number; recorded_at: string; principals: RecordPrincipal[]; _comment?: string }

export async function loadRecord(name: string): Promise<RecordFile> {
  return JSON.parse(await readFile(new URL(`../fixtures/antigravity/${name}`, import.meta.url), "utf8")) as RecordFile;
}

/** CodexBarCore's own text for each recorder error code (AntigravityStatusProbeError). */
export const ENGINE_ERROR_TEXT: Record<string, string> = {
  timed_out: "Antigravity quota request timed out.",
  not_running: "Antigravity language server not detected. Launch Antigravity and retry.",
  authentication_required: "Antigravity CLI is signed out. Run agy in a terminal to sign in, then retry.",
  api_error: "Antigravity API error",
};

function bucketLane(bucketId: string): { meter: AntigravityMeter; minutes: 300 | 10_080 } | undefined {
  const meter: AntigravityMeter | undefined = bucketId.startsWith("gemini") ? "gemini" : /^(3p|cg)-/.test(bucketId) ? "claude-gpt" : undefined;
  const minutes = bucketId.endsWith("-5h") ? 300 : bucketId.endsWith("-weekly") ? 10_080 : undefined;
  return meter && minutes ? { meter, minutes } : undefined;
}

function row(principal: string, meter: string, minutes: number | null, now: string, extra: Partial<Observation> & { lane?: unknown }): Observation {
  return {
    principal_id: principal, meter_id: `${principal}:${meter}`,
    window: { kind: minutes === 10_080 ? "fixed" : "rolling", minutes, enforcement: "hard" },
    quantity: null, resets_at: null, observed_at: now, fetched_at: now, source: "local:antigravity:warm",
    truth: "official", freshness: "fresh", confidence: 1, adapter_version: "0.1.0", upstream_schema_version: "v0.56.4", ...extra,
  } as Observation;
}

/** The rows the native engine emits for this recorded answer. */
export function engineRowsFromRecord(record: RecordPrincipal, principal: string, now: string): Observation[] {
  if (record.error) {
    return (["gemini", "claude-gpt"] as const).map((meter) => ({
      ...row(principal, meter, null, now, {}), window: null, source: "engine:native", truth: "estimated" as const, freshness: "failed" as const, confidence: 0,
      reason: ENGINE_ERROR_TEXT[record.error!] ?? "Antigravity quota read failed",
    }));
  }
  const kind = record.payload_kind;
  const output: Observation[] = [];
  if (kind !== "quota_summary") {
    // Per-model representatives with no 5h/weekly identity. CodexBarCore
    // reads a missing fraction as 0% remaining: the engine tags that as
    // usage-unknown rather than passing it off as usage.
    for (const meter of ["gemini", "claude-gpt"] as const) {
      output.push(row(principal, meter, null, now, { quantity: { used: 100, limit: 100, remaining: 0, unit: "percent" }, lane: { payload_kind: kind, bucket: "reported", usage_known: kind !== "availability_only" } }));
    }
  }
  for (const bucket of record.buckets) {
    const lane = bucketLane(bucket.bucket_id);
    if (!lane) continue;
    if (bucket.usage_known && bucket.remaining_fraction !== null) {
      const remaining = Math.max(0, Math.min(100, bucket.remaining_fraction * 100));
      output.push(row(principal, lane.meter, lane.minutes, now, {
        quantity: { used: 100 - remaining, limit: 100, remaining, unit: "percent" }, resets_at: bucket.reset_time,
        lane: { payload_kind: kind, bucket: "reported", usage_known: true, disabled: bucket.disabled },
      }));
    } else {
      output.push(row(principal, lane.meter, lane.minutes, now, {
        truth: "estimated", freshness: "failed", confidence: 0, reason: `vendor sent this bucket without usage (${bucket.disabled ? "bucket disabled" : "no remaining fraction"})`,
        lane: { payload_kind: kind, bucket: "reported", usage_known: false, disabled: bucket.disabled },
      }));
    }
  }
  const weekly = new Set(record.buckets.map((bucket) => bucketLane(bucket.bucket_id)).filter((lane) => lane?.minutes === 10_080).map((lane) => lane!.meter));
  for (const meter of ["claude-gpt", "gemini"] as const) {
    if (weekly.has(meter)) continue;
    output.push(row(principal, meter, 10_080, now, {
      truth: "estimated", freshness: "failed", confidence: 0, reason: "quota summary not ready",
      lane: { payload_kind: kind, bucket: "not_reported", usage_known: false },
    }));
  }
  return output;
}

/** The same recorded answer as a retrieveUserQuota body for the remote adapter. */
export function remoteBodyFromRecord(record: RecordPrincipal): unknown {
  if (record.payload_kind !== "quota_summary") {
    return { models: Object.fromEntries(record.model_quotas.map((model) => [model.model_id, { quotaInfo: model.remaining_fraction === null ? {} : { remainingFraction: model.remaining_fraction } }])) };
  }
  return {
    buckets: record.buckets.flatMap((bucket) => {
      const lane = bucketLane(bucket.bucket_id);
      if (!lane) return [];
      return [{
        modelId: `${lane.meter}-${lane.minutes === 300 ? "5-hour" : "weekly"}`, disabled: bucket.disabled, resetTime: bucket.reset_time,
        ...(bucket.remaining_fraction === null ? {} : { remainingFraction: bucket.remaining_fraction }),
      }];
    }),
  };
}
