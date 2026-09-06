import { access, constants, lstat, readFile, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { outboundFetch, redact } from "../security.js";
import { vendorJson } from "../limits.js";

/**
 * Everything the Antigravity and Gemini CLI adapters share: both read the
 * same Gemini CLI Google OAuth credential file, refresh it against the same
 * Google token endpoint with the same OAuth client extracted from the
 * installed gemini-cli bundle, and call the same two Code Assist endpoints on
 * `cloudcode-pa.googleapis.com`. Only the `metadata.ideType` they announce,
 * the meters they emit, and how they read the quota buckets differ, so those
 * stay in the two adapter files.
 */

export const CODE_ASSIST_TIMEOUT_MS = 10_000;
const BASE_URL = "https://cloudcode-pa.googleapis.com";
export const RETRIEVE_USER_QUOTA = `${BASE_URL}/v1internal:retrieveUserQuota`;
export const LOAD_CODE_ASSIST = `${BASE_URL}/v1internal:loadCodeAssist`;
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Headroom reads usage; it must never provision a remote Code Assist project
 * or select a billing tier on the caller's behalf. When neither the stored
 * credential nor loadCodeAssist names a project, this is the one reason
 * surfaced -- never an onboardUser call. */
export const NO_PROJECT_REASON = "no Code Assist project; finish setup in the Gemini CLI";

export type ObjectValue = Record<string, unknown>;
export const asObject = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
export const asString = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
export const asNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
export function field(value: ObjectValue, ...names: string[]): unknown { for (const name of names) if (name in value) return value[name]; return undefined; }

export class CodeAssistHTTPError extends Error {
  constructor(readonly status: number, detail?: string) { super(`HTTP ${status}${detail ? ` ${detail}` : ""}`); }
}

export interface GeminiOAuthClient { clientId: string; clientSecret: string; }

/** The credential fields both adapters need out of Gemini CLI's OAuth JSON. */
export interface GoogleCredential { token: string; refreshToken?: string; projectId?: string; expired: boolean; }

/** Dependency seams shared by both adapters: every one of them exists so a
 * test never touches a real credential file, a real bundle, or the network. */
export interface CodeAssistDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  credentialPaths?: () => string[];
  /** Test seam and explicit override for Gemini CLI's bundled OAuth client. */
  oauthClient?: () => Promise<GeminiOAuthClient | undefined>;
}

export async function secureRead(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("credentials unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("credentials have unsafe permissions");
  return readFile(path, "utf8");
}

/** Reads Gemini CLI's Google OAuth JSON, never agy's `{ auth_method, token }` session file. */
export function parseGoogleCredential(payload: string, now = new Date()): GoogleCredential {
  try {
    const root: unknown = JSON.parse(payload);
    if (!asObject(root)) throw new Error("invalid");
    const token = asString(root.access_token ?? root.accessToken);
    if (!token) throw new Error("invalid");
    const expiry = root.expiry_date ?? root.expiry ?? root.expiresAt ?? root.expires_at;
    const parsedExpiry = typeof expiry === "string" ? Date.parse(expiry) : asNumber(expiry);
    const milliseconds = typeof parsedExpiry === "number" && parsedExpiry < 10_000_000_000 ? parsedExpiry * 1000 : parsedExpiry;
    return {
      token,
      refreshToken: asString(root.refresh_token ?? root.refreshToken),
      projectId: asString(root.project ?? root.project_id ?? root.projectId),
      expired: typeof milliseconds === "number" && Number.isFinite(milliseconds) && now.getTime() >= milliseconds,
    };
  } catch { throw new Error("Gemini CLI OAuth credentials invalid"); }
}

/** The Gemini CLI writes its OAuth credentials here on every platform. */
export function geminiCredentialPath(home = homedir()): string { return join(home, ".gemini", "oauth_creds.json"); }
export function defaultCredentialPaths(): string[] { return [geminiCredentialPath()]; }

export async function readCredential(paths: string[], reader: (path: string, encoding: BufferEncoding) => Promise<string>, now: Date): Promise<GoogleCredential> {
  let unavailable = true;
  for (const path of paths) {
    try { unavailable = false; return parseGoogleCredential(await reader(path, "utf8"), now); }
    catch { /* another credential path may be valid */ }
  }
  if (unavailable) throw new Error("unavailable");
  throw new Error("invalid");
}

/** Google sometimes sends a useful Code Assist reason in an error envelope.
 * Preserve that operator-facing diagnostic while applying the normal secret and
 * email redaction before it can become an observation or event. */
export function vendorErrorDetail(value: unknown): string | undefined {
  const root = asObject(value) && asObject(value.error) ? value.error : value;
  if (!asObject(root)) return undefined;
  const reasonCode = asString(field(root, "reasonCode", "reason_code"))
    ?? (Array.isArray(root.details) ? root.details.flatMap((item) => asObject(item) ? [asString(field(item, "reasonCode", "reason_code"))] : []).find(Boolean) : undefined);
  const message = asString(root.message);
  if (!reasonCode && !message) return undefined;
  return redact(`${reasonCode ?? ""}${reasonCode && message ? ": " : ""}${message ?? ""}`).slice(0, 512);
}

export async function codeAssistHTTPError(response: Response): Promise<CodeAssistHTTPError> {
  let detail: string | undefined;
  try { detail = vendorErrorDetail(await vendorJson(response)); } catch { /* status remains useful when a proxy sends malformed HTML */ }
  return new CodeAssistHTTPError(response.status, detail);
}

/** A vendor reset expressed either as an ISO string or as epoch seconds/milliseconds. */
export function resetTimestamp(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const epoch = asNumber(value);
  if (epoch === undefined || epoch <= 0) return null;
  return new Date(epoch < 10_000_000_000 ? epoch * 1000 : epoch).toISOString();
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

/** every candidate/chunk file this discovery reads is charged
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
  const envClientId = asString(process.env.GEMINI_OAUTH_CLIENT_ID);
  const envClientSecret = asString(process.env.GEMINI_OAUTH_CLIENT_SECRET);
  if (envClientId && envClientSecret) return { client: { clientId: envClientId, clientSecret: envClientSecret }, layout: "GEMINI_OAUTH_CLIENT_ID/SECRET environment override" };
  const budget: OAuthScanBudget = { bytesLeft: OAUTH_SCAN_MAX_BYTES, filesLeft: OAUTH_SCAN_MAX_FILES };
  const override = asString(process.env.GEMINI_OAUTH2_JS_PATH);
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

/** Refreshes an expired access token in memory. Nothing is ever written back
 * to the credential file: the refreshed token lives only for this read. */
export async function refreshCredential(fetcher: typeof fetch, credentials: GoogleCredential, resolveClient: () => Promise<GeminiOAuthClient | undefined>): Promise<GoogleCredential> {
  if (!credentials.expired) return credentials;
  if (!credentials.refreshToken) throw new Error("expired");
  const client = await resolveClient();
  if (!client) throw new Error("Gemini CLI OAuth client unavailable");
  const response = await outboundFetch(fetcher, new Request(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }), signal: AbortSignal.timeout(CODE_ASSIST_TIMEOUT_MS),
  }));
  if (!response.ok) throw await codeAssistHTTPError(response);
  const body: unknown = await vendorJson(response);
  if (!asObject(body) || !asString(body.access_token)) throw new Error("Google OAuth refresh returned no access token");
  return { ...credentials, token: asString(body.access_token)!, expired: false };
}

/** `loadCodeAssist`'s `cloudaicompanionProject` comes back either as a bare
 * project id string or as an object carrying `id`/`projectId` -- CodexBar's
 * own decoder (`ProjectReference`) accepts both, so this does too. */
function projectIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") return asString(value);
  if (asObject(value)) return asString(field(value, "id", "projectId", "project_id"));
  return undefined;
}

export interface CodeAssistParsed { projectId?: string; tierId?: string; tierName?: string; reasonCode?: string; }

/** Reads `loadCodeAssist`'s project id, current tier, and (when Google
 * denies the consumer tier) the `ineligibleTiers[].reasonCode` that explains
 * why -- the same field CodexBar's Gemini provider reads for its
 * UNSUPPORTED_CLIENT migration signal. */
export function parseCodeAssist(body: unknown): CodeAssistParsed {
  if (!asObject(body)) return {};
  const projectId = projectIdFrom(field(body, "cloudaicompanionProject"));
  const currentTier = asObject(field(body, "currentTier")) ? field(body, "currentTier") as ObjectValue : undefined;
  const ineligible = Array.isArray(body.ineligibleTiers) ? body.ineligibleTiers : [];
  const reasonCode = ineligible.flatMap((item) => asObject(item) ? [asString(field(item, "reasonCode", "reason_code"))] : []).find(Boolean);
  return { projectId, tierId: asString(currentTier?.id), tierName: asString(currentTier?.name), reasonCode };
}

/** The `Authorization`/`Content-Type` pair both Code Assist calls need. The
 * optional user agent is the one request header the two adapters differ on:
 * the Antigravity path announces itself as `antigravity`, the Gemini CLI
 * path sends no product token at all, exactly like the clients they mirror. */
export function requestHeaders(token: string, userAgent?: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(userAgent ? { "User-Agent": userAgent } : {}) };
}

/** The quota request is exactly `{ project?: string }`; Google's response buckets carry modelId, remainingFraction and resetTime. */
export function quotaRequestBody(projectId?: string): string { return JSON.stringify(projectId ? { project: projectId } : {}); }

export async function loadCodeAssist(fetcher: typeof fetch, token: string, metadata: Record<string, string>, userAgent?: string): Promise<unknown> {
  const response = await outboundFetch(fetcher, new Request(LOAD_CODE_ASSIST, {
    method: "POST", headers: requestHeaders(token, userAgent), body: JSON.stringify({ metadata }), signal: AbortSignal.timeout(CODE_ASSIST_TIMEOUT_MS),
  }));
  if (!response.ok) throw await codeAssistHTTPError(response);
  return vendorJson(response);
}

export async function postUserQuota(fetcher: typeof fetch, token: string, projectId: string | undefined, userAgent?: string): Promise<Response> {
  return outboundFetch(fetcher, new Request(RETRIEVE_USER_QUOTA, { method: "POST", headers: requestHeaders(token, userAgent), body: quotaRequestBody(projectId), signal: AbortSignal.timeout(CODE_ASSIST_TIMEOUT_MS) }));
}

/**
 * The project id `retrieveUserQuota` needs: a project id already on the
 * stored credential wins outright, otherwise `loadCodeAssist`'s own
 * `cloudaicompanionProject`. Headroom never provisions a Code
 * Assist project or picks a billing tier on the caller's behalf -- there is
 * no `onboardUser` call anywhere in either adapter. When neither source names
 * a project, the caller has not finished Code Assist setup in the vendor's
 * own CLI and must be told so, not silently onboarded.
 */
export function resolveProjectId(storedProjectId: string | undefined, initial: unknown): string | undefined {
  return storedProjectId ?? parseCodeAssist(initial).projectId;
}

/** Response key paths and value kinds, for the `--shape` diagnostics. Never
 * retains a response value beyond its kind. */
export function responseShape(value: unknown, path = "$"): Array<{ path: string; kind: string }> {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const output = [{ path, kind }];
  if (asObject(value)) for (const [key, child] of Object.entries(value)) output.push(...responseShape(child, `${path}.${key}`));
  else if (Array.isArray(value) && value[0] !== undefined) output.push(...responseShape(value[0], `${path}[]`));
  return output;
}
