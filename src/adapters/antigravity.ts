import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeObservations } from "../engine/observation.js";
import { allowedOutbound, redact } from "../security.js";
import { ProviderHTTPError } from "./claude.js";
import type { Observation, ProviderAccount } from "../types.js";

const TIMEOUT_MS = 10_000;
const SOURCE = "native:antigravity";
const BASE_URL = "https://cloudcode-pa.googleapis.com";
const RETRIEVE_USER_QUOTA = `${BASE_URL}/v1internal:retrieveUserQuota`;
const FETCH_AVAILABLE_MODELS = `${BASE_URL}/v1internal:fetchAvailableModels`;
const METERS = ["gemini", "claude-gpt"] as const;
const WINDOWS = [
  { name: "5h", minutes: 300, kind: "rolling" as const },
  { name: "weekly", minutes: 10_080, kind: "fixed" as const },
] as const;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export interface AntigravityDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  credentialPaths?: () => string[];
}

interface Credential { token: string; projectId?: string; expired: boolean; }

async function secureRead(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("credentials unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("credentials have unsafe permissions");
  return readFile(path, "utf8");
}

/** `agy` and Gemini CLI both persist JSON OAuth records; no protobuf/base64 format is used by these stores. */
export function parseAntigravityCredential(payload: string, now = new Date()): Credential {
  try {
    const root: unknown = JSON.parse(payload);
    if (!object(root)) throw new Error("invalid");
    // agy nests its token, while Gemini CLI writes the OAuth fields at the top level.
    const tokenRecord = object(root.token) ? root.token : root;
    const token = string(tokenRecord.access_token ?? tokenRecord.accessToken);
    if (!token) throw new Error("invalid");
    const expiry = tokenRecord.expiry ?? tokenRecord.expiry_date ?? tokenRecord.expiresAt ?? tokenRecord.expires_at;
    const parsedExpiry = typeof expiry === "string" ? Date.parse(expiry) : number(expiry);
    const milliseconds = typeof parsedExpiry === "number" && parsedExpiry < 10_000_000_000 ? parsedExpiry * 1000 : parsedExpiry;
    return {
      token,
      projectId: string(tokenRecord.project ?? tokenRecord.project_id ?? tokenRecord.projectId) ?? string(root.project ?? root.project_id ?? root.projectId),
      expired: typeof milliseconds === "number" && Number.isFinite(milliseconds) && now.getTime() >= milliseconds,
    };
  } catch { throw new Error("Antigravity OAuth credentials invalid"); }
}

function defaultCredentialPaths(): string[] {
  const gemini = join(homedir(), ".gemini");
  return [join(gemini, "antigravity-cli", "antigravity-oauth-token"), join(gemini, "oauth_creds.json")];
}

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" };
}

function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return METERS.flatMap((meter) => WINDOWS.map((window) => ({
    ...base(account, meter, now), window: { kind: window.kind, minutes: window.minutes, enforcement: "hard" as const }, quantity: null, resets_at: null,
    freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason),
  })));
}

function requestBody(projectId?: string): string { return JSON.stringify(projectId ? { project: projectId } : {}); }
function requestHeaders(token: string): HeadersInit {
  // These are the complete v0.56.4 remote-fetcher headers. It sends no x-goog-api-client header.
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" };
}

function field(value: ObjectValue, ...names: string[]): unknown { for (const name of names) if (name in value) return value[name]; return undefined; }
function reset(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const epoch = number(value);
  if (epoch === undefined || epoch <= 0) return null;
  return new Date(epoch < 10_000_000_000 ? epoch * 1000 : epoch).toISOString();
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

/** Maps verified `retrieveUserQuota` bucket fractions. `fetchAvailableModels` is deliberately not a capacity source. */
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

async function credential(paths: string[], reader: (path: string, encoding: BufferEncoding) => Promise<string>, now: Date): Promise<Credential> {
  let unavailable = true;
  for (const path of paths) {
    try {
      unavailable = false;
      const candidate = parseAntigravityCredential(await reader(path, "utf8"), now);
      if (candidate.expired) throw new Error("expired");
      return candidate;
    } catch (error) {
      if (error instanceof Error && error.message === "expired") throw error;
    }
  }
  if (unavailable) throw new Error("unavailable");
  throw new Error("invalid");
}

async function post(fetcher: typeof fetch, endpoint: string, credential: Credential): Promise<Response> {
  return fetcher(new Request(allowedOutbound(endpoint).toString(), { method: "POST", headers: requestHeaders(credential.token), body: requestBody(credential.projectId), signal: AbortSignal.timeout(TIMEOUT_MS) }));
}

export async function observeAntigravity(account: ProviderAccount, dependencies: AntigravityDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const credentials = await credential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureRead, now);
    const fetcher = dependencies.fetch ?? fetch;
    const quota = await post(fetcher, RETRIEVE_USER_QUOTA, credentials);
    if (quota.ok) {
      const body: unknown = await quota.json();
      if (buckets(body).some((bucket) => bucket.remaining !== undefined)) return observationsFromAntigravityQuota(body, account, now);
    } else if (quota.status !== 403) {
      throw new ProviderHTTPError(quota.status, "Antigravity quota");
    }
    // Availability proves only that the account can use models. It must never become a zero-use quota reading.
    const availability = await post(fetcher, FETCH_AVAILABLE_MODELS, credentials);
    if (!availability.ok) throw new ProviderHTTPError(availability.status, "Antigravity models");
    await availability.json();
    return failed(account, "quota endpoint returned availability only", timestamp);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "expired") return failed(account, "token expired; run: agy", timestamp);
    if (message === "unavailable" || message === "invalid") return failed(account, "no credentials; run: agy", timestamp);
    const reason = error instanceof ProviderHTTPError ? error.message : "Antigravity usage unavailable";
    return failed(account, reason, timestamp);
  }
}
