import { normalizeObservations } from "../engine/observation.js";
import { redact } from "../security.js";
import { vendorJson } from "../limits.js";
import {
  CodeAssistHTTPError, NO_PROJECT_REASON, asNumber as number, asObject as object, asString as string,
  codeAssistHTTPError, defaultCredentialPaths, discoverGeminiOAuthClient, field, loadCodeAssist,
  parseCodeAssist, postUserQuota, readCredential, refreshCredential, resetTimestamp as reset,
  resolveProjectId, responseShape as shape, secureRead,
  type CodeAssistDependencies, type GoogleCredential, type ObjectValue,
} from "./google-code-assist.js";
import type { Observation, ProviderAccount } from "../types.js";

/** The Gemini CLI OAuth read, token refresh, Code Assist calls and bundle scan
 * this adapter uses are shared verbatim with the Gemini CLI adapter; only the
 * `ideType` announced, the meters emitted and the bucket mapping below are
 * specific to Antigravity. */
export { discoverGeminiOAuthClient, discoverGeminiOAuthClientDetail, parseGoogleCredential as parseAntigravityCredential } from "./google-code-assist.js";
export type { GeminiOAuthClient } from "./google-code-assist.js";
export type AntigravityDependencies = CodeAssistDependencies;

const SOURCE = "remote:antigravity";
/** Same metadata CodexBar's Antigravity fetcher sends on every loadCodeAssist call. */
const CODE_ASSIST_METADATA = { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
/** The product token CodexBar's Antigravity fetcher sends; the Gemini CLI path sends none. */
const USER_AGENT = "antigravity";
const METERS = ["gemini", "claude-gpt"] as const;
const WINDOWS = [
  { name: "5h", minutes: 300, kind: "rolling" as const },
  { name: "weekly", minutes: 10_080, kind: "fixed" as const },
] as const;

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" };
}

function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return METERS.flatMap((meter) => WINDOWS.map((window) => ({
    ...base(account, meter, now), window: { kind: window.kind, minutes: window.minutes, enforcement: "hard" as const }, quantity: null, resets_at: null,
    freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason),
  })));
}

/**
 * Synthetic failed observations for a one-shot CLI/MCP read with no daemon
 * responding. Built without ever attempting the deprecated remote Google
 * OAuth fallback: on a fresh install the account was discovered from `agy`
 * on PATH, not a Gemini CLI OAuth credential file, so that fallback is
 * doomed anyway and would only surface a confusing "OAuth client
 * unavailable" error instead of the one actionable fix.
 */
export function noDaemonObservations(account: ProviderAccount, now = new Date()): Observation[] {
  return failed(account, "no daemon; Antigravity needs the daemon-kept agy: run headroom install-service", now.toISOString());
}

interface QuotaBucket { meter?: typeof METERS[number]; minutes?: number; remaining?: number; resetsAt: string | null; }
function bucketFrom(value: unknown): QuotaBucket | undefined {
  if (!object(value)) return undefined;
  const remainingObject = object(field(value, "remaining")) ? field(value, "remaining") as ObjectValue : undefined;
  const remaining = number(field(value, "remainingFraction", "remaining_fraction")) ?? number(remainingObject && field(remainingObject, "remainingFraction", "remaining_fraction"));
  const words = ["modelId", "model_id", "bucketId", "bucket_id", "displayName", "display_name", "label", "description", "name"].map((name) => string(value[name]) ?? "").join(" ").toLowerCase();
  const meter = /gemini/.test(words) ? "gemini" : /claude|gpt/.test(words) ? "claude-gpt" : undefined;
  const explicitMinutes = number(field(value, "windowMinutes", "window_minutes", "minutes"));
  const minutes = explicitMinutes === 300 || explicitMinutes === 10_080 ? explicitMinutes : /weekly|week|7.?day/.test(words) ? 10_080 : /session|5.?hour|five.?hour/.test(words) ? 300 : undefined;
  return { meter, minutes, remaining: remaining === undefined ? undefined : Math.max(0, Math.min(1, remaining)), resetsAt: reset(field(value, "resetTime", "reset_time", "resetsAt", "resets_at")) };
}

function buckets(body: unknown): QuotaBucket[] {
  if (!object(body)) return [];
  const root = object(body.response) ? body.response : body;
  const direct = Array.isArray(root.buckets) ? root.buckets : [];
  const grouped = Array.isArray(root.groups) ? root.groups.flatMap((group) => object(group) && Array.isArray(group.buckets) ? group.buckets.map((bucket) => object(bucket) ? { ...bucket, displayName: bucket.displayName ?? group.displayName } : bucket) : []) : [];
  return [...direct, ...grouped].flatMap((bucket) => { const parsed = bucketFrom(bucket); return parsed ? [parsed] : []; });
}

/** Maps verified `retrieveUserQuota` bucket fractions. A response without remainingFraction is availability-only, never usage. */
export function observationsFromAntigravityQuota(body: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  const now = at.toISOString();
  const candidates = buckets(body);
  const output: Observation[] = [];
  for (const meter of METERS) for (const window of WINDOWS) {
    const match = candidates.filter((candidate) => candidate.meter === meter && candidate.minutes === window.minutes && candidate.remaining !== undefined)
      .sort((left, right) => (left.remaining ?? 1) - (right.remaining ?? 1))[0];
    if (!match || match.remaining === undefined) {
      output.push({ ...base(account, meter, now), window: { kind: window.kind, minutes: window.minutes, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "vendor returned no quota bucket for this window" });
      continue;
    }
    const used = Math.round(Math.max(0, Math.min(100, (1 - match.remaining) * 100)) * 1_000_000) / 1_000_000;
    output.push({ ...base(account, meter, now), window: { kind: window.kind, minutes: window.minutes, enforcement: "hard" }, quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: match.resetsAt, freshness: "fresh" });
  }
  return normalizeObservations(output);
}

export async function observeAntigravity(account: ProviderAccount, dependencies: AntigravityDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const fetcher = dependencies.fetch ?? fetch;
    const stored = await readCredential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureRead, now);
    const credentials = await refreshCredential(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient);
    const codeAssist = await loadCodeAssist(fetcher, credentials.token, CODE_ASSIST_METADATA, USER_AGENT);
    const parsed = parseCodeAssist(codeAssist);
    const projectId = resolveProjectId(credentials.projectId, codeAssist);
    if (!projectId) return failed(account, NO_PROJECT_REASON, timestamp);
    const quota = await postUserQuota(fetcher, credentials.token, projectId, USER_AGENT);
    if (!quota.ok) throw await codeAssistHTTPError(quota);
    const body: unknown = await vendorJson(quota);
    if (!buckets(body).some((bucket) => bucket.remaining !== undefined)) {
      const tier = parsed.reasonCode ? `; tier ${parsed.tierId ?? parsed.tierName ?? "unknown"} (${parsed.reasonCode})` : "";
      return failed(account, `quota endpoint returned availability only${tier}`, timestamp);
    }
    return observationsFromAntigravityQuota(body, account, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "expired") return failed(account, "token expired; run: gemini", timestamp);
    if (message === "unavailable" || message === "invalid") return failed(account, "no Gemini CLI OAuth credentials; run: gemini", timestamp);
    // Keep a sanitized transport/adapter diagnostic. The prior generic label
    // hid actionable local daemon failures such as a missing agy binary.
    const reason = error instanceof CodeAssistHTTPError ? error.message : message ? redact(message).slice(0, 512) : "Antigravity usage unavailable";
    return failed(account, reason, timestamp);
  }
}

/**
 * Returns response key paths and value kinds for every request the remote
 * sequence makes (loadCodeAssist, retrieveUserQuota), plus the tier id/name
 * and any ineligible-tier reasonCode `loadCodeAssist` reported -- so a
 * maintainer can see why a tier was denied without guessing at Google's
 * response shape. Never retains response values beyond their kind, and never
 * calls onboardUser: see resolveProjectId.
 */
export async function antigravityResponseShape(account: ProviderAccount, dependencies: AntigravityDependencies = {}): Promise<Record<string, unknown>> {
  const now = dependencies.now?.() ?? new Date();
  const fetcher = dependencies.fetch ?? fetch;
  let stored: GoogleCredential;
  try { stored = await readCredential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureRead, now); }
  catch { throw new Error("no Gemini CLI OAuth credentials; run: gemini"); }
  let credentials: GoogleCredential;
  try { credentials = await refreshCredential(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient); }
  catch (error) { throw error instanceof Error && error.message === "expired" ? new Error("token expired; run: gemini") : error; }
  const codeAssist = await loadCodeAssist(fetcher, credentials.token, CODE_ASSIST_METADATA, USER_AGENT);
  const parsed = parseCodeAssist(codeAssist);
  const projectId = resolveProjectId(credentials.projectId, codeAssist);
  const result: Record<string, unknown> = {
    loadCodeAssist: { shape: shape(codeAssist), tier: parsed.tierId ?? parsed.tierName ?? null, reasonCode: parsed.reasonCode ?? null },
  };
  if (!projectId) {
    result.retrieveUserQuota = { error: NO_PROJECT_REASON };
    return result;
  }
  // A denied tier is exactly the case this diagnostic exists for: a
  // retrieveUserQuota failure (a 403 verified live against a free-tier
  // Antigravity account -- "The caller does not have permission", no
  // buckets ever returned) must not discard loadCodeAssist's own tier and
  // reasonCode above, the very thing that explains the denial.
  try {
    const quota = await postUserQuota(fetcher, credentials.token, projectId, USER_AGENT);
    if (!quota.ok) throw await codeAssistHTTPError(quota);
    result.retrieveUserQuota = { shape: shape(await vendorJson(quota)) };
  } catch (error) {
    result.retrieveUserQuota = { error: error instanceof Error ? redact(error.message).slice(0, 512) : "retrieveUserQuota failed" };
  }
  return result;
}
