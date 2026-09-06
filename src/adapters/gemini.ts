import { join } from "node:path";
import { normalizeObservations } from "../engine/observation.js";
import { redact } from "../security.js";
import { vendorJson } from "../limits.js";
import {
  CodeAssistHTTPError, NO_PROJECT_REASON, asNumber, asObject, asString,
  codeAssistHTTPError, defaultCredentialPaths, discoverGeminiOAuthClient, field, loadCodeAssist,
  parseCodeAssist, postUserQuota, readCredential, refreshCredential, resetTimestamp,
  resolveProjectId, responseShape, secureRead,
  type CodeAssistDependencies, type GoogleCredential,
} from "./google-code-assist.js";
import type { Observation, ProviderAccount } from "../types.js";

/**
 * The Gemini CLI subscription (Gemini Code Assist quota), read through the
 * same Google Code Assist endpoints the Antigravity adapter uses -- see
 * google-code-assist.ts for the credential read, token refresh and request
 * plumbing both share. What differs here: the `ideType` this path announces
 * (`GEMINI_CLI`, the value the Gemini CLI's own client sends), the meters,
 * which follow whatever model families the quota buckets carry instead of
 * Antigravity's fixed pair, and the free-tier 403, which is a reported
 * failure rather than an error.
 */

const SOURCE = "remote:gemini";
/** Exactly the metadata the Gemini CLI sends on loadCodeAssist; the Antigravity
 * path announces `ANTIGRAVITY` instead, and that one field is what tells Google
 * which client's quota is being asked about. */
const CODE_ASSIST_METADATA = { ideType: "GEMINI_CLI", pluginType: "GEMINI" };
/** The account-wide meter, used for a bucket that names no model and for every
 * failed read (which has no buckets to name families from). Matches the Claude
 * adapter's `<principal>:all` convention. */
const ACCOUNT_METER = "all";
/**
 * Google answers the quota endpoint with 403 for an account whose tier is not
 * entitled to it (verified live on the free Code Assist tier through the
 * Antigravity path, which sees the same refusal). It is a real answer about
 * the account, not a transport error, so it becomes a `failed` reading with
 * this reason. The trailing status keeps it inside collector.ts's
 * PROTECTED_STATUS_PATTERN, so the shared backoff holds off the next attempt
 * instead of re-asking a question already answered.
 */
const TIER_DENIED_REASON = "quota endpoint not permitted for this account tier (403)";
const AVAILABILITY_ONLY_REASON = "quota endpoint returned availability only";

export type GeminiDependencies = CodeAssistDependencies;

/** The Gemini home this principal was discovered from (`~/.gemini`, or the
 * `.gemini` under a `GEMINI_CLI_HOME` override), holding the OAuth credential
 * the Gemini CLI itself writes. */
export function geminiCredentialPaths(location?: string): string[] {
  return location ? [join(location, "oauth_creds.json")] : defaultCredentialPaths();
}

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" };
}

/**
 * A failed read carries one account-wide row: the model families are only
 * known from a quota response that answered, so inventing per-family rows for
 * a read that never got one would report meters this account may not even
 * have. The window is null for the same reason -- an unanswered read knows no
 * window length.
 */
function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return [{
    ...base(account, ACCOUNT_METER, now), window: null, quantity: null, resets_at: null,
    freshness: "failed", truth: "estimated", confidence: 0, reason: redact(reason),
  }];
}

/** Model family as a meter suffix: the vendor's own model id, lowercased and
 * reduced to the characters a meter id uses. A bucket that names no model is
 * the account-wide meter. */
function familySlug(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const slug = raw.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || undefined;
}

/** Window hints Google may put on a bucket. Nothing here guesses a duration
 * from a reset time: a bucket that names no period gets a null window length,
 * which is honest and keeps it out of the idle-window placeholder heuristic. */
const WINDOW_WORDS: Array<{ pattern: RegExp; minutes: number; kind: "rolling" | "fixed" }> = [
  { pattern: /weekly|week|7.?day/, minutes: 10_080, kind: "fixed" },
  { pattern: /daily|day|24.?hour/, minutes: 1_440, kind: "fixed" },
  { pattern: /5.?hour|five.?hour|session/, minutes: 300, kind: "rolling" },
  { pattern: /hourly|per.?hour|1.?hour/, minutes: 60, kind: "rolling" },
];

interface QuotaBucket { family: string; minutes: number | null; kind: "rolling" | "fixed"; remaining?: number; resetsAt: string | null; }

function bucketFrom(value: unknown): QuotaBucket | undefined {
  if (!asObject(value)) return undefined;
  const remaining = asNumber(field(value, "remainingFraction", "remaining_fraction"));
  const family = familySlug(field(value, "modelId", "model_id", "bucketId", "bucket_id")) ?? ACCOUNT_METER;
  const words = ["modelId", "model_id", "bucketId", "bucket_id", "quotaId", "quota_id", "displayName", "display_name", "label", "description", "name", "period", "tokenType", "token_type"]
    .map((name) => asString(value[name]) ?? "").join(" ").toLowerCase();
  const explicitMinutes = asNumber(field(value, "windowMinutes", "window_minutes", "minutes"));
  const named = WINDOW_WORDS.find((entry) => entry.pattern.test(words));
  const minutes = explicitMinutes !== undefined && explicitMinutes > 0 ? explicitMinutes : named?.minutes ?? null;
  return {
    family,
    minutes,
    kind: named?.kind ?? "fixed",
    remaining: remaining === undefined ? undefined : Math.max(0, Math.min(1, remaining)),
    resetsAt: resetTimestamp(field(value, "resetTime", "reset_time", "resetsAt", "resets_at")),
  };
}

/** `{ buckets: [...] }` is the documented shape; a `response` envelope and
 * `groups[].buckets` are accepted the same way the Antigravity path accepts
 * them, since both come from the same service. */
export function geminiQuotaBuckets(body: unknown): QuotaBucket[] {
  if (!asObject(body)) return [];
  const root = asObject(body.response) ? body.response : body;
  const direct = Array.isArray(root.buckets) ? root.buckets : [];
  const grouped = Array.isArray(root.groups)
    ? root.groups.flatMap((group) => asObject(group) && Array.isArray(group.buckets)
      ? group.buckets.map((bucket) => asObject(bucket) ? { ...bucket, displayName: bucket.displayName ?? group.displayName } : bucket)
      : [])
    : [];
  return [...direct, ...grouped].flatMap((bucket) => { const parsed = bucketFrom(bucket); return parsed ? [parsed] : []; });
}

/**
 * One observation per model family and window the response actually carried,
 * `used` computed as `(1 - remainingFraction) * 100`. A family that reports
 * several buckets for the same window (Google splits input and output token
 * types) keeps the lowest remaining fraction, which is the one that will
 * actually stop the account. A bucket with no `remainingFraction` is
 * availability, not usage, and is dropped here -- observeGemini turns a
 * response with nothing but those into one failed reading.
 */
export function observationsFromGeminiQuota(body: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  const now = at.toISOString();
  const lowest = new Map<string, QuotaBucket>();
  for (const bucket of geminiQuotaBuckets(body)) {
    if (bucket.remaining === undefined) continue;
    const key = `${bucket.family}|${bucket.minutes ?? "none"}`;
    const held = lowest.get(key);
    if (!held || (held.remaining ?? 1) > bucket.remaining) lowest.set(key, bucket);
  }
  const output = [...lowest.values()]
    .sort((left, right) => left.family.localeCompare(right.family) || (left.minutes ?? 0) - (right.minutes ?? 0))
    .map((bucket) => {
      const used = Math.round(Math.max(0, Math.min(100, (1 - (bucket.remaining ?? 0)) * 100)) * 1_000_000) / 1_000_000;
      return {
        ...base(account, bucket.family, now),
        window: { kind: bucket.kind, minutes: bucket.minutes, enforcement: "hard" as const },
        quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" as const },
        resets_at: bucket.resetsAt,
        freshness: "fresh" as const,
      };
    });
  return normalizeObservations(output);
}

export async function observeGemini(account: ProviderAccount, dependencies: GeminiDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const fetcher = dependencies.fetch ?? fetch;
    const stored = await readCredential(dependencies.credentialPaths?.() ?? geminiCredentialPaths(account.location), dependencies.readFile ?? secureRead, now);
    const credentials = await refreshCredential(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient);
    const codeAssist = await loadCodeAssist(fetcher, credentials.token, CODE_ASSIST_METADATA);
    const projectId = resolveProjectId(credentials.projectId, codeAssist);
    // Headroom reads usage; it never provisions a Code Assist project or picks
    // a tier for the caller. There is no onboardUser call in this adapter.
    if (!projectId) return failed(account, NO_PROJECT_REASON, timestamp);
    const quota = await postUserQuota(fetcher, credentials.token, projectId);
    if (quota.status === 403) return failed(account, TIER_DENIED_REASON, timestamp);
    if (!quota.ok) throw await codeAssistHTTPError(quota);
    const body: unknown = await vendorJson(quota);
    const rows = observationsFromGeminiQuota(body, account, now);
    if (!rows.length) return failed(account, AVAILABILITY_ONLY_REASON, timestamp);
    return rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "expired") return failed(account, "token expired; run: gemini", timestamp);
    if (message === "unavailable" || message === "invalid") return failed(account, "no Gemini CLI OAuth credentials; run: gemini", timestamp);
    const reason = error instanceof CodeAssistHTTPError ? error.message : message ? redact(message).slice(0, 512) : "Gemini usage unavailable";
    return failed(account, reason, timestamp);
  }
}

/**
 * Key paths and value kinds for every response this sequence reads
 * (loadCodeAssist, retrieveUserQuota), plus loadCodeAssist's own tier and any
 * `ineligibleTiers[].reasonCode` it reported -- enough to see why a tier was
 * denied without guessing at Google's response shape. Values themselves are
 * never retained, and no onboardUser call exists here either.
 */
export async function geminiResponseShape(account: ProviderAccount, dependencies: GeminiDependencies = {}): Promise<Record<string, unknown>> {
  const now = dependencies.now?.() ?? new Date();
  const fetcher = dependencies.fetch ?? fetch;
  let stored: GoogleCredential;
  try { stored = await readCredential(dependencies.credentialPaths?.() ?? geminiCredentialPaths(account.location), dependencies.readFile ?? secureRead, now); }
  catch { throw new Error("no Gemini CLI OAuth credentials; run: gemini"); }
  let credentials: GoogleCredential;
  try { credentials = await refreshCredential(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient); }
  catch (error) { throw error instanceof Error && error.message === "expired" ? new Error("token expired; run: gemini") : error; }
  const codeAssist = await loadCodeAssist(fetcher, credentials.token, CODE_ASSIST_METADATA);
  const parsed = parseCodeAssist(codeAssist);
  const projectId = resolveProjectId(credentials.projectId, codeAssist);
  const result: Record<string, unknown> = {
    loadCodeAssist: { shape: responseShape(codeAssist), tier: parsed.tierId ?? parsed.tierName ?? null, reasonCode: parsed.reasonCode ?? null },
  };
  if (!projectId) {
    result.retrieveUserQuota = { error: NO_PROJECT_REASON };
    return result;
  }
  try {
    const quota = await postUserQuota(fetcher, credentials.token, projectId);
    if (quota.status === 403) throw new Error(TIER_DENIED_REASON);
    if (!quota.ok) throw await codeAssistHTTPError(quota);
    const body: unknown = await vendorJson(quota);
    result.retrieveUserQuota = { shape: responseShape(body), meters: observationsFromGeminiQuota(body, account, now).map((row) => row.meter_id) };
  } catch (error) {
    result.retrieveUserQuota = { error: error instanceof Error ? redact(error.message).slice(0, 512) : "retrieveUserQuota failed" };
  }
  return result;
}
