import { access, constants, lstat, readFile, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeObservations } from "../engine/observation.js";
import { allowedOutbound, redact } from "../security.js";
import { vendorJson } from "../limits.js";
import type { Observation, ProviderAccount } from "../types.js";

const TIMEOUT_MS = 10_000;
const SOURCE = "remote:antigravity";
const BASE_URL = "https://cloudcode-pa.googleapis.com";
const RETRIEVE_USER_QUOTA = `${BASE_URL}/v1internal:retrieveUserQuota`;
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const METERS = ["gemini", "claude-gpt"] as const;
const WINDOWS = [
  { name: "5h", minutes: 300, kind: "rolling" as const },
  { name: "weekly", minutes: 10_080, kind: "fixed" as const },
] as const;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

class AntigravityHTTPError extends Error {
  constructor(readonly status: number, detail?: string) { super(`HTTP ${status}${detail ? ` ${detail}` : ""}`); }
}

export interface GeminiOAuthClient { clientId: string; clientSecret: string; }
export interface AntigravityDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  credentialPaths?: () => string[];
  /** Test seam and explicit override for Gemini CLI's bundled OAuth client. */
  oauthClient?: () => Promise<GeminiOAuthClient | undefined>;
}

interface Credential { token: string; refreshToken?: string; projectId?: string; expired: boolean; }

async function secureRead(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("credentials unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("credentials have unsafe permissions");
  return readFile(path, "utf8");
}

/** Reads Gemini CLI's Google OAuth JSON, never agy's `{ auth_method, token }` session file. */
export function parseAntigravityCredential(payload: string, now = new Date()): Credential {
  try {
    const root: unknown = JSON.parse(payload);
    if (!object(root)) throw new Error("invalid");
    const token = string(root.access_token ?? root.accessToken);
    if (!token) throw new Error("invalid");
    const expiry = root.expiry_date ?? root.expiry ?? root.expiresAt ?? root.expires_at;
    const parsedExpiry = typeof expiry === "string" ? Date.parse(expiry) : number(expiry);
    const milliseconds = typeof parsedExpiry === "number" && parsedExpiry < 10_000_000_000 ? parsedExpiry * 1000 : parsedExpiry;
    return {
      token,
      refreshToken: string(root.refresh_token ?? root.refreshToken),
      projectId: string(root.project ?? root.project_id ?? root.projectId),
      expired: typeof milliseconds === "number" && Number.isFinite(milliseconds) && now.getTime() >= milliseconds,
    };
  } catch { throw new Error("Gemini CLI OAuth credentials invalid"); }
}

function defaultCredentialPaths(): string[] { return [join(homedir(), ".gemini", "oauth_creds.json")]; }

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" };
}

function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return METERS.flatMap((meter) => WINDOWS.map((window) => ({
    ...base(account, meter, now), window: { kind: window.kind, minutes: window.minutes, enforcement: "hard" as const }, quantity: null, resets_at: null,
    freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason),
  })));
}

/** The quota request is exactly `{ project?: string }`; Google's response buckets carry modelId, remainingFraction and resetTime. */
function requestBody(projectId?: string): string { return JSON.stringify(projectId ? { project: projectId } : {}); }
function requestHeaders(token: string): HeadersInit { return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" }; }

function field(value: ObjectValue, ...names: string[]): unknown { for (const name of names) if (name in value) return value[name]; return undefined; }

/** Google sometimes sends a useful Code Assist reason in an error envelope.
 * Preserve that operator-facing diagnostic while applying the normal secret and
 * email redaction before it can become an observation or event. */
function vendorErrorDetail(value: unknown): string | undefined {
  const root = object(value) && object(value.error) ? value.error : value;
  if (!object(root)) return undefined;
  const reasonCode = string(field(root, "reasonCode", "reason_code"))
    ?? (Array.isArray(root.details) ? root.details.flatMap((item) => object(item) ? [string(field(item, "reasonCode", "reason_code"))] : []).find(Boolean) : undefined);
  const message = string(root.message);
  if (!reasonCode && !message) return undefined;
  return redact(`${reasonCode ?? ""}${reasonCode && message ? ": " : ""}${message ?? ""}`).slice(0, 512);
}

async function antigravityHTTPError(response: Response): Promise<AntigravityHTTPError> {
  let detail: string | undefined;
  try { detail = vendorErrorDetail(await vendorJson(response)); } catch { /* status remains useful when a proxy sends malformed HTML */ }
  return new AntigravityHTTPError(response.status, detail);
}
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

async function credential(paths: string[], reader: (path: string, encoding: BufferEncoding) => Promise<string>, now: Date): Promise<Credential> {
  let unavailable = true;
  for (const path of paths) {
    try { unavailable = false; return parseAntigravityCredential(await reader(path, "utf8"), now); }
    catch { /* another credential path may be valid */ }
  }
  if (unavailable) throw new Error("unavailable");
  throw new Error("invalid");
}

function formBody(values: Record<string, string>): string { return new URLSearchParams(values).toString(); }

/** Finds the same Gemini CLI oauth2.js bundle locations documented by CodexBar, without persisting any extracted client data. */
export async function discoverGeminiOAuthClient(): Promise<GeminiOAuthClient | undefined> {
  const envClientId = string(process.env.GEMINI_OAUTH_CLIENT_ID);
  const envClientSecret = string(process.env.GEMINI_OAUTH_CLIENT_SECRET);
  if (envClientId && envClientSecret) return { clientId: envClientId, clientSecret: envClientSecret };
  const candidates = new Set<string>();
  const override = string(process.env.GEMINI_OAUTH2_JS_PATH);
  if (override) candidates.add(override);
  const binary = await geminiBinary();
  if (binary) for (const root of parents(dirname(binary), 8)) {
    candidates.add(join(root, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    candidates.add(join(root, "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    candidates.add(join(root, "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    candidates.add(join(root, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    candidates.add(join(root, "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    candidates.add(join(root, "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
  }
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    candidates.add(join(prefix, "opt", "gemini-cli", "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    candidates.add(join(prefix, "opt", "gemini-cli", "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    try { for (const version of await readdir(join(prefix, "Cellar", "gemini-cli"))) {
      candidates.add(join(prefix, "Cellar", "gemini-cli", version, "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
      candidates.add(join(prefix, "Cellar", "gemini-cli", version, "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    } } catch { /* not a Homebrew installation */ }
  }
  for (const path of candidates) try {
    const text = await readFile(path, "utf8");
    const clientId = /[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/.exec(text)?.[0];
    const clientSecret = /GOCSPX-[A-Za-z0-9_-]{28}/.exec(text)?.[0];
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch { /* continue through the documented candidates */ }
  return undefined;
}

async function geminiBinary(): Promise<string | undefined> {
  for (const path of (process.env.PATH ?? "").split(":").filter(Boolean).map((directory) => join(directory, "gemini"))) try {
    await access(path, constants.X_OK);
    return await realpath(path);
  } catch { /* continue */ }
  return undefined;
}
function parents(path: string, count: number): string[] { const output: string[] = []; let current = path; for (let index = 0; index < count; index += 1) { output.push(current); const parent = dirname(current); if (parent === current) break; current = parent; } return output; }

async function refresh(fetcher: typeof fetch, credentials: Credential, resolveClient: () => Promise<GeminiOAuthClient | undefined>): Promise<Credential> {
  if (!credentials.expired) return credentials;
  if (!credentials.refreshToken) throw new Error("expired");
  const client = await resolveClient();
  if (!client) throw new Error("Gemini CLI OAuth client unavailable");
  const response = await fetcher(new Request(allowedOutbound(GOOGLE_TOKEN_ENDPOINT).toString(), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }), signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw await antigravityHTTPError(response);
  const body: unknown = await vendorJson(response);
  if (!object(body) || !string(body.access_token)) throw new Error("Google OAuth refresh returned no access token");
  return { ...credentials, token: string(body.access_token)!, expired: false };
}

async function post(fetcher: typeof fetch, credential: Credential): Promise<Response> {
  return fetcher(new Request(allowedOutbound(RETRIEVE_USER_QUOTA).toString(), { method: "POST", headers: requestHeaders(credential.token), body: requestBody(credential.projectId), signal: AbortSignal.timeout(TIMEOUT_MS) }));
}

export async function observeAntigravity(account: ProviderAccount, dependencies: AntigravityDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const fetcher = dependencies.fetch ?? fetch;
    const stored = await credential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureRead, now);
    const credentials = await refresh(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient);
    const quota = await post(fetcher, credentials);
    if (!quota.ok) throw await antigravityHTTPError(quota);
    const body: unknown = await vendorJson(quota);
    if (!buckets(body).some((bucket) => bucket.remaining !== undefined)) return failed(account, "quota endpoint returned availability only", timestamp);
    return observationsFromAntigravityQuota(body, account, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "expired") return failed(account, "token expired; run: gemini", timestamp);
    if (message === "unavailable" || message === "invalid") return failed(account, "no Gemini CLI OAuth credentials; run: gemini", timestamp);
    // Keep a sanitized transport/adapter diagnostic. The prior generic label
    // hid actionable local daemon failures such as a missing agy binary.
    const reason = error instanceof AntigravityHTTPError ? error.message : message ? redact(message).slice(0, 512) : "Antigravity usage unavailable";
    return failed(account, reason, timestamp);
  }
}
