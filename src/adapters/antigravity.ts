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
import {
  antigravityLaneObservations, classifyAntigravityLanes,
  type AntigravityBucket, type AntigravityMeter, type AntigravityPayload, type AntigravityWindowMinutes,
} from "../antigravity-lanes.js";

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

/** Every lane failed with one reason: the classifier's `error` state, so a
 * whole-meter failure reads the same from the remote and the local path. */
export function failedAntigravityObservations(account: ProviderAccount, reason: string, now: string): Observation[] {
  return antigravityLaneObservations(classifyAntigravityLanes({ kind: "error", error: redact(reason) }), account.name, { now, source: SOURCE });
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
  return failedAntigravityObservations(account, "no daemon; Antigravity needs the daemon-kept agy: run headroom install-service", now.toISOString());
}

interface QuotaBucket { meter?: AntigravityMeter; minutes?: AntigravityWindowMinutes; remaining?: number; disabled?: boolean; resetsAt: string | null; }
function bucketFrom(value: unknown): QuotaBucket | undefined {
  if (!object(value)) return undefined;
  const remainingObject = object(field(value, "remaining")) ? field(value, "remaining") as ObjectValue : undefined;
  const remaining = number(field(value, "remainingFraction", "remaining_fraction")) ?? number(remainingObject && field(remainingObject, "remainingFraction", "remaining_fraction"));
  const words = ["modelId", "model_id", "bucketId", "bucket_id", "displayName", "display_name", "label", "description", "name"].map((name) => string(value[name]) ?? "").join(" ").toLowerCase();
  const meter = /gemini/.test(words) ? "gemini" : /claude|gpt/.test(words) ? "claude-gpt" : undefined;
  const explicitMinutes = number(field(value, "windowMinutes", "window_minutes", "minutes"));
  const minutes = explicitMinutes === 300 || explicitMinutes === 10_080 ? explicitMinutes : /weekly|week|7.?day/.test(words) ? 10_080 : /session|5.?hour|five.?hour/.test(words) ? 300 : undefined;
  const disabled = field(value, "disabled");
  return { meter, minutes, remaining: remaining === undefined ? undefined : Math.max(0, Math.min(1, remaining)), disabled: typeof disabled === "boolean" ? disabled : undefined, resetsAt: reset(field(value, "resetTime", "reset_time", "resetsAt", "resets_at")) };
}

function buckets(body: unknown): QuotaBucket[] {
  if (!object(body)) return [];
  const root = object(body.response) ? body.response : body;
  const direct = Array.isArray(root.buckets) ? root.buckets : [];
  const grouped = Array.isArray(root.groups) ? root.groups.flatMap((group) => object(group) && Array.isArray(group.buckets) ? group.buckets.map((bucket) => object(bucket) ? { ...bucket, displayName: bucket.displayName ?? group.displayName } : bucket) : []) : [];
  return [...direct, ...grouped].flatMap((bucket) => { const parsed = bucketFrom(bucket); return parsed ? [parsed] : []; });
}

/** The retrieveUserQuota body as a lane-classifier payload. A body without
 * any fraction is availability only, never usage; a disabled bucket's
 * fraction is never usage either. */
export function antigravityPayloadFromQuota(body: unknown, availabilityReason = "quota endpoint returned availability only"): AntigravityPayload {
  const parsed = buckets(body);
  if (!parsed.some((bucket) => bucket.remaining !== undefined)) return { kind: "availability_only", reason: availabilityReason };
  return {
    kind: "quota_summary",
    buckets: parsed.flatMap((bucket): AntigravityBucket[] => bucket.meter && bucket.minutes ? [{
      meter: bucket.meter, minutes: bucket.minutes, remaining: bucket.remaining ?? null,
      usageKnown: bucket.remaining !== undefined && bucket.disabled !== true, disabled: bucket.disabled ?? null, resetsAt: bucket.resetsAt,
    }] : []),
  };
}

/** Maps verified `retrieveUserQuota` buckets through the shared lane
 * classifier (antigravity-lanes.ts), the same one the daemon's local read
 * uses. A missing 5h bucket is an honest `not_enforced` gap (issue #55), never
 * an invented 100%; a 5h bucket without usage behind an exhausted weekly is
 * blocked; a missing weekly bucket is a failed read. */
export function observationsFromAntigravityQuota(body: unknown, account: ProviderAccount, at = new Date(), availabilityReason?: string): Observation[] {
  const classification = classifyAntigravityLanes(antigravityPayloadFromQuota(body, availabilityReason));
  return normalizeObservations(antigravityLaneObservations(classification, account.name, { now: at.toISOString(), source: SOURCE }));
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
    if (!projectId) return failedAntigravityObservations(account, NO_PROJECT_REASON, timestamp);
    const quota = await postUserQuota(fetcher, credentials.token, projectId, USER_AGENT);
    if (!quota.ok) throw await codeAssistHTTPError(quota);
    const body: unknown = await vendorJson(quota);
    const tier = parsed.reasonCode ? `; tier ${parsed.tierId ?? parsed.tierName ?? "unknown"} (${parsed.reasonCode})` : "";
    return observationsFromAntigravityQuota(body, account, now, redact(`quota endpoint returned availability only${tier}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "expired") return failedAntigravityObservations(account, "token expired; run: gemini", timestamp);
    if (message === "unavailable" || message === "invalid") return failedAntigravityObservations(account, "no Gemini CLI OAuth credentials; run: gemini", timestamp);
    // Keep a sanitized transport/adapter diagnostic. The prior generic label
    // hid actionable local daemon failures such as a missing agy binary.
    const reason = error instanceof CodeAssistHTTPError ? error.message : message ? redact(message).slice(0, 512) : "Antigravity usage unavailable";
    return failedAntigravityObservations(account, reason, timestamp);
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
