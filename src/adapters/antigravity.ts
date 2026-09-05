import { access, constants, lstat, readFile, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { normalizeObservations } from "../engine/observation.js";
import { outboundFetch, redact } from "../security.js";
import { vendorJson } from "../limits.js";
import type { Observation, ProviderAccount } from "../types.js";

const TIMEOUT_MS = 10_000;
const SOURCE = "remote:antigravity";
const BASE_URL = "https://cloudcode-pa.googleapis.com";
const RETRIEVE_USER_QUOTA = `${BASE_URL}/v1internal:retrieveUserQuota`;
const LOAD_CODE_ASSIST = `${BASE_URL}/v1internal:loadCodeAssist`;
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Same metadata CodexBar's Antigravity fetcher sends on every loadCodeAssist call. */
const CODE_ASSIST_METADATA = { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
/** Astra F11: Headroom reads usage; it must never provision a remote Code
 * Assist project or select a billing tier on the caller's behalf. When
 * neither the stored credential nor loadCodeAssist names a project, this is
 * the one reason surfaced -- never an onboardUser call. */
const NO_PROJECT_REASON = "no Code Assist project; finish setup in the Gemini CLI";
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

/** Prefers the named `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` constants Google
 * ships the Gemini CLI source with (unambiguous even when a bundle also
 * contains an unrelated Google client id elsewhere in the same file), and
 * falls back to the bare id/secret shape for a bundle that keeps the values
 * but not the names. */
function extractOAuthClient(text: string): GeminiOAuthClient | undefined {
  const namedId = /(?:const|let|var)\s+OAUTH_CLIENT_ID\s*=\s*["']([\w.-]+)["']/.exec(text)?.[1];
  const namedSecret = /(?:const|let|var)\s+OAUTH_CLIENT_SECRET\s*=\s*["']([\w-]+)["']/.exec(text)?.[1];
  if (namedId && namedSecret) return { clientId: namedId, clientSecret: namedSecret };
  const clientId = /[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/.exec(text)?.[0];
  const clientSecret = /GOCSPX-[A-Za-z0-9_-]{28}/.exec(text)?.[0];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Astra F12: every candidate/chunk file this discovery reads is charged
 * against one shared budget for the whole attempt, so a symlink farm, a
 * PATH-derived ancestry with many siblings, or a huge/adversarial bundle can
 * cost at most this much work before discovery gives up -- never the whole
 * bundle, however large. */
const OAUTH_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const OAUTH_SCAN_MAX_FILES = 200;
interface OAuthScanBudget { bytesLeft: number; filesLeft: number; }

/** Regular files only (lstat, never a symlink or other special file), and
 * only while both the byte and file budget allow it. Returns undefined --
 * treated as unavailable by every caller -- for anything else, including a
 * single candidate too large to fit the remaining byte budget. */
async function readBoundedCandidate(path: string, budget: OAuthScanBudget): Promise<string | undefined> {
  if (budget.filesLeft <= 0 || budget.bytesLeft <= 0) return undefined;
  let info;
  try { info = await lstat(path); } catch { return undefined; }
  if (!info.isFile() || info.size > budget.bytesLeft) return undefined;
  budget.filesLeft -= 1;
  budget.bytesLeft -= info.size;
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

/** Last-resort fallback for a Homebrew-published gemini-cli install: its
 * `bundle/gemini.js` is only a ~5 KB bootstrap that dynamically imports the
 * real code from content-hashed sibling files (`bundle/chunk-<hash>.js`), so
 * none of the fixed candidate paths below ever match it. Scans every .js
 * file directly in the bundle directory (sorted, for a deterministic match)
 * until one contains the OAuth client, or until the shared scan budget runs out. */
async function scanDirectoryForOAuthClient(dir: string, budget: OAuthScanBudget): Promise<GeminiOAuthClient | undefined> {
  let names: string[];
  try { names = (await readdir(dir)).filter((name) => name.endsWith(".js")).sort(); }
  catch { return undefined; }
  for (const name of names) {
    if (budget.filesLeft <= 0 || budget.bytesLeft <= 0) return undefined;
    const text = await readBoundedCandidate(join(dir, name), budget);
    if (text === undefined) continue;
    const found = extractOAuthClient(text);
    if (found) return found;
  }
  return undefined;
}

/** Finds the same Gemini CLI oauth2.js bundle locations documented by
 * CodexBar, without persisting any extracted client data. `layout` names
 * which resolution path matched, for `headroom doctor` to report -- never
 * the client id/secret themselves. */
export async function discoverGeminiOAuthClientDetail(): Promise<{ client: GeminiOAuthClient; layout: string } | undefined> {
  const envClientId = string(process.env.GEMINI_OAUTH_CLIENT_ID);
  const envClientSecret = string(process.env.GEMINI_OAUTH_CLIENT_SECRET);
  if (envClientId && envClientSecret) return { client: { clientId: envClientId, clientSecret: envClientSecret }, layout: "GEMINI_OAUTH_CLIENT_ID/SECRET environment override" };
  const budget: OAuthScanBudget = { bytesLeft: OAUTH_SCAN_MAX_BYTES, filesLeft: OAUTH_SCAN_MAX_FILES };
  const override = string(process.env.GEMINI_OAUTH2_JS_PATH);
  if (override) {
    const text = await readBoundedCandidate(override, budget);
    const found = text === undefined ? undefined : extractOAuthClient(text);
    if (found) return { client: found, layout: `GEMINI_OAUTH2_JS_PATH (${override})` };
  }
  const fileCandidates = new Set<string>();
  const dirCandidates = new Set<string>();
  const binary = await geminiBinary();
  if (binary) for (const root of parents(dirname(binary), 8)) {
    fileCandidates.add(join(root, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    fileCandidates.add(join(root, "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    fileCandidates.add(join(root, "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    fileCandidates.add(join(root, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    fileCandidates.add(join(root, "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    fileCandidates.add(join(root, "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    dirCandidates.add(join(root, "node_modules", "@google", "gemini-cli", "bundle"));
    dirCandidates.add(join(root, "lib", "node_modules", "@google", "gemini-cli", "bundle"));
    dirCandidates.add(join(root, "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle"));
  }
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    fileCandidates.add(join(prefix, "opt", "gemini-cli", "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
    fileCandidates.add(join(prefix, "opt", "gemini-cli", "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
    dirCandidates.add(join(prefix, "opt", "gemini-cli", "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle"));
    try { for (const version of await readdir(join(prefix, "Cellar", "gemini-cli"))) {
      fileCandidates.add(join(prefix, "Cellar", "gemini-cli", version, "libexec", "lib", "node_modules", "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"));
      fileCandidates.add(join(prefix, "Cellar", "gemini-cli", version, "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"));
      dirCandidates.add(join(prefix, "Cellar", "gemini-cli", version, "libexec", "lib", "node_modules", "@google", "gemini-cli", "bundle"));
    } } catch { /* not a Homebrew installation */ }
  }
  for (const path of fileCandidates) {
    const text = await readBoundedCandidate(path, budget);
    const found = text === undefined ? undefined : extractOAuthClient(text);
    if (found) return { client: found, layout: path };
  }
  for (const dir of dirCandidates) {
    const found = await scanDirectoryForOAuthClient(dir, budget);
    if (found) return { client: found, layout: `${dir} (chunk scan)` };
  }
  return undefined;
}

export async function discoverGeminiOAuthClient(): Promise<GeminiOAuthClient | undefined> {
  return (await discoverGeminiOAuthClientDetail())?.client;
}

async function geminiBinary(): Promise<string | undefined> {
  // `delimiter` (not a hardcoded ":") because a Windows PATH entry's own
  // drive letter ("C:\...") already contains a colon -- splitting on ":"
  // there tears "C:\Users\...\bin" into "C" and "\Users\...\bin".
  for (const path of (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "gemini"))) try {
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
  const response = await outboundFetch(fetcher, new Request(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }), signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw await antigravityHTTPError(response);
  const body: unknown = await vendorJson(response);
  if (!object(body) || !string(body.access_token)) throw new Error("Google OAuth refresh returned no access token");
  return { ...credentials, token: string(body.access_token)!, expired: false };
}

/** `loadCodeAssist`'s `cloudaicompanionProject` comes back either as a bare
 * project id string or as an object carrying `id`/`projectId` -- CodexBar's
 * own decoder (`ProjectReference`) accepts both, so this does too. */
function projectIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") return string(value);
  if (object(value)) return string(field(value, "id", "projectId", "project_id"));
  return undefined;
}

interface CodeAssistParsed { projectId?: string; tierId?: string; tierName?: string; reasonCode?: string; }

/** Reads `loadCodeAssist`'s project id, current tier, and (when Google
 * denies the consumer tier) the `ineligibleTiers[].reasonCode` that explains
 * why -- the same field CodexBar's Gemini provider reads for its
 * UNSUPPORTED_CLIENT migration signal. */
function parseCodeAssist(body: unknown): CodeAssistParsed {
  if (!object(body)) return {};
  const projectId = projectIdFrom(field(body, "cloudaicompanionProject"));
  const currentTier = object(field(body, "currentTier")) ? field(body, "currentTier") as ObjectValue : undefined;
  const ineligible = Array.isArray(body.ineligibleTiers) ? body.ineligibleTiers : [];
  const reasonCode = ineligible.flatMap((item) => object(item) ? [string(field(item, "reasonCode", "reason_code"))] : []).find(Boolean);
  return { projectId, tierId: string(currentTier?.id), tierName: string(currentTier?.name), reasonCode };
}

async function loadCodeAssist(fetcher: typeof fetch, token: string): Promise<unknown> {
  const response = await outboundFetch(fetcher, new Request(LOAD_CODE_ASSIST, {
    method: "POST", headers: requestHeaders(token), body: JSON.stringify({ metadata: CODE_ASSIST_METADATA }), signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw await antigravityHTTPError(response);
  return vendorJson(response);
}

/**
 * The project id `retrieveUserQuota` needs: a project id already on the
 * stored credential wins outright, otherwise `loadCodeAssist`'s own
 * `cloudaicompanionProject`. Astra F11: Headroom never provisions a Code
 * Assist project or picks a billing tier on the caller's behalf -- there is
 * no `onboardUser` call anywhere in this adapter. When neither source names
 * a project, the caller has not finished Code Assist setup in the vendor's
 * own CLI and must be told so, not silently onboarded.
 */
function resolveProjectId(storedProjectId: string | undefined, initial: unknown): string | undefined {
  return storedProjectId ?? parseCodeAssist(initial).projectId;
}

async function post(fetcher: typeof fetch, token: string, projectId: string | undefined): Promise<Response> {
  return outboundFetch(fetcher, new Request(RETRIEVE_USER_QUOTA, { method: "POST", headers: requestHeaders(token), body: requestBody(projectId), signal: AbortSignal.timeout(TIMEOUT_MS) }));
}

export async function observeAntigravity(account: ProviderAccount, dependencies: AntigravityDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const fetcher = dependencies.fetch ?? fetch;
    const stored = await credential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureRead, now);
    const credentials = await refresh(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient);
    const codeAssist = await loadCodeAssist(fetcher, credentials.token);
    const parsed = parseCodeAssist(codeAssist);
    const projectId = resolveProjectId(credentials.projectId, codeAssist);
    if (!projectId) return failed(account, NO_PROJECT_REASON, timestamp);
    const quota = await post(fetcher, credentials.token, projectId);
    if (!quota.ok) throw await antigravityHTTPError(quota);
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
    const reason = error instanceof AntigravityHTTPError ? error.message : message ? redact(message).slice(0, 512) : "Antigravity usage unavailable";
    return failed(account, reason, timestamp);
  }
}

function shape(value: unknown, path = "$"): Array<{ path: string; kind: string }> {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const output = [{ path, kind }];
  if (object(value)) for (const [key, child] of Object.entries(value)) output.push(...shape(child, `${path}.${key}`));
  else if (Array.isArray(value) && value[0] !== undefined) output.push(...shape(value[0], `${path}[]`));
  return output;
}

/**
 * Returns response key paths and value kinds for every request the remote
 * sequence makes (loadCodeAssist, retrieveUserQuota), plus the tier id/name
 * and any ineligible-tier reasonCode `loadCodeAssist` reported -- so a
 * maintainer can see why a tier was denied without guessing at Google's
 * response shape. Never retains response values beyond their kind, and never
 * calls onboardUser: see resolveProjectId (Astra F11).
 */
export async function antigravityResponseShape(account: ProviderAccount, dependencies: AntigravityDependencies = {}): Promise<Record<string, unknown>> {
  const now = dependencies.now?.() ?? new Date();
  const fetcher = dependencies.fetch ?? fetch;
  let stored: Credential;
  try { stored = await credential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureRead, now); }
  catch { throw new Error("no Gemini CLI OAuth credentials; run: gemini"); }
  let credentials: Credential;
  try { credentials = await refresh(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient); }
  catch (error) { throw error instanceof Error && error.message === "expired" ? new Error("token expired; run: gemini") : error; }
  const codeAssist = await loadCodeAssist(fetcher, credentials.token);
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
    const quota = await post(fetcher, credentials.token, projectId);
    if (!quota.ok) throw await antigravityHTTPError(quota);
    result.retrieveUserQuota = { shape: shape(await vendorJson(quota)) };
  } catch (error) {
    result.retrieveUserQuota = { error: error instanceof Error ? redact(error.message).slice(0, 512) : "retrieveUserQuota failed" };
  }
  return result;
}
