import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { credentialPath, vendorHome } from "../paths.js";
import { outboundFetch, redact } from "../security.js";
import { vendorJson } from "../limits.js";
import { ProviderHTTPError } from "./claude.js";
import type { Observation, ProviderAccount } from "../types.js";

const TIMEOUT_MS = 10_000;
const SOURCE = "native:codex";
const SESSION_SOURCE = "native:codex:session-log";
const STALE_AFTER_MS = 15 * 60_000;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export interface CodexRateLimitEvent { timestamp: string; primary?: unknown; secondary?: unknown; }
export interface CodexDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  readRateLimitEvents?: (home: string) => Promise<CodexRateLimitEvent[]>;
}
async function secureRead(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Codex auth unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Codex auth has unsafe permissions");
  return readFile(path, "utf8");
}
function jwtClaim(token: string, claim: string): unknown {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try { return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"))[claim]; } catch { return undefined; }
}
interface Credential { token: string; accountId?: string; expired: boolean; }
export function parseCodexCredential(payload: string, now = new Date()): Credential {
  try {
    const root: unknown = JSON.parse(payload);
    const tokens = object(root) && object(root.tokens) ? root.tokens : undefined;
    const token = tokens && string(tokens.access_token ?? tokens.accessToken);
    if (!token) throw new Error("invalid");
    const accountId = string(tokens?.account_id ?? tokens?.accountId) ?? string(jwtClaim(token, "chatgpt_account_id"));
    const expires = number(tokens?.expires_at ?? tokens?.expiresAt ?? tokens?.expires) ?? number(jwtClaim(token, "exp"));
    const milliseconds = expires !== undefined && expires < 10_000_000_000 ? expires * 1000 : expires;
    return { token, accountId, expired: milliseconds !== undefined && now.getTime() >= milliseconds };
  } catch { throw new Error("Codex auth invalid"); }
}
function base(account: ProviderAccount, meter: string, now: string, source = SOURCE): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> { return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" }; }
function failed(account: ProviderAccount, reason: string, now: string): Observation[] { return ["main", "spark", "credits"].map((meter) => ({ ...base(account, meter, now), window: null, quantity: null, resets_at: null, freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason) })); }
function date(value: unknown): string | null {
  const seconds = number(value);
  if (seconds !== undefined && seconds > 0) return new Date(seconds * 1000).toISOString();
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function rate(account: ProviderAccount, meter: string, raw: unknown, fallback: number, now: string, source = SOURCE, freshness: Observation["freshness"] = "fresh"): Observation | undefined {
  if (!object(raw)) return undefined;
  const used = number(raw.used_percent); if (used === undefined) return undefined;
  const minutes = Math.floor((number(raw.limit_window_seconds) ?? (number(raw.window_minutes) ?? fallback) * 60) / 60) || fallback;
  const reset = date(raw.reset_at ?? raw.resets_at) ?? (() => { const seconds = number(raw.resets_in_seconds); return seconds === undefined ? null : new Date(Date.parse(now) + seconds * 1000).toISOString(); })();
  const value = Math.min(100, Math.max(0, used));
  return { ...base(account, meter, now, source), window: { kind: reset ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: { used: value, limit: 100, remaining: Math.max(0, 100 - value), unit: "percent" }, resets_at: reset, freshness };
}
/** Parse the `wham/usage` body and optional reset-credit body from CodexBar's v0.56.4 contract. */
export function observationsFromCodexUsage(usage: unknown, credits: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  if (!object(usage) || !object(usage.rate_limit)) throw new Error("Codex usage response invalid");
  const now = at.toISOString(); const rateLimit = usage.rate_limit;
  const plan = string(usage.plan_type);
  const metadata = { ...(plan ? { plan } : {}), ...(object(credits) && number(credits.available_count) !== undefined ? { free_resets_available: number(credits.available_count)! } : {}) };
  const tagged = (observation: Observation): Observation => ({ ...observation, metadata });
  const output: Observation[] = [];
  const primary = rate(account, "main", rateLimit.primary_window ?? rateLimit.primary, 300, now);
  output.push(primary ? tagged(primary) : tagged({ ...base(account, "main", now), window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "not_enforced", reason: "no 5-hour window from endpoint or session logs" }));
  const weekly = rate(account, "main", rateLimit.secondary_window ?? rateLimit.secondary, 10_080, now);
  output.push(tagged(weekly ?? { ...base(account, "main", now), window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "vendor returned no weekly window" }));
  if (Array.isArray(usage.additional_rate_limits)) for (const entry of usage.additional_rate_limits) {
    if (!object(entry) || !String(entry.limit_name ?? entry.metered_feature ?? "").toLowerCase().includes("spark") || !object(entry.rate_limit)) continue;
    const five = rate(account, "spark", entry.rate_limit.primary_window ?? entry.rate_limit.primary, 300, now); const week = rate(account, "spark", entry.rate_limit.secondary_window ?? entry.rate_limit.secondary, 10_080, now);
    if (five) output.push(tagged(five)); if (week) output.push(tagged(week));
  }
  if (object(credits) && number(credits.available_count) !== undefined) {
    const available = number(credits.available_count)!;
    const expiries = (Array.isArray(credits.credits) ? credits.credits : []).flatMap((credit) => object(credit) && string(credit.status) === "available" && typeof credit.expires_at === "string" ? [credit.expires_at] : []).sort();
    output.push(tagged({ ...base(account, "credits", now), window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: available, unit: "credits" }, resets_at: expiries[0] ?? null, freshness: "fresh" }));
  }
  return output;
}

function rateLimitEventsFromText(text: string): CodexRateLimitEvent[] {
  const output: CodexRateLimitEvent[] = [];
  for (const line of text.split("\n")) {
    try {
      const event: unknown = JSON.parse(line);
      if (!object(event) || !object(event.payload) || !object(event.payload.rate_limits)) continue;
      const timestamp = string(event.timestamp);
      if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
      const limits = event.payload.rate_limits;
      const sessionWindow = (raw: unknown): unknown => {
        if (!object(raw)) return raw;
        const seconds = number(raw.resets_in_seconds);
        if (seconds === undefined || raw.reset_at !== undefined || raw.resets_at !== undefined) return raw;
        return { ...raw, resets_at: Math.floor(Date.parse(timestamp) / 1000) + seconds };
      };
      output.push({ timestamp, primary: sessionWindow(limits.primary), secondary: sessionWindow(limits.secondary) });
    } catch { /* A partial session line is not a rate-limit event. */ }
  }
  return output;
}

async function rateLimitLogFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    const output: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) output.push(...await rateLimitLogFiles(path));
      else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".log"))) output.push(path);
    }
    return output;
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Reads only structured rate-limit events; prompt and response text is ignored. */
export async function readCodexRateLimitEvents(home: string): Promise<CodexRateLimitEvent[]> {
  const candidates = await rateLimitLogFiles(join(home, "sessions"));
  const files = (await Promise.all(candidates.map(async (path) => {
    try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink() ? { path, mtime: info.mtimeMs } : undefined; }
    catch { return undefined; }
  }))).filter((item): item is { path: string; mtime: number } => Boolean(item)).sort((a, b) => b.mtime - a.mtime).slice(0, 20).map((item) => item.path);
  const output: CodexRateLimitEvent[] = [];
  for (const path of files) {
    try {
      output.push(...rateLimitEventsFromText(await readFile(path, "utf8")));
    } catch { /* A rotated or unreadable log cannot make a fresh endpoint fail. */ }
  }
  return output;
}

export function observationsFromCodexRateLimitEvents(events: CodexRateLimitEvent[], account: ProviderAccount, now = new Date()): Observation[] {
  const latest = [...events].filter((event) => Number.isFinite(Date.parse(event.timestamp))).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (!latest) return [];
  const timestamp = new Date(latest.timestamp).toISOString();
  const freshness: Observation["freshness"] = now.getTime() - Date.parse(timestamp) > STALE_AFTER_MS ? "stale" : "fresh";
  return [rate(account, "main", latest.primary, 300, timestamp, SESSION_SOURCE, freshness), rate(account, "main", latest.secondary, 10_080, timestamp, SESSION_SOURCE, freshness)].filter((item): item is Observation => Boolean(item));
}

function mergeSessionFallback(endpoint: Observation[], session: Observation[]): Observation[] {
  const sessionByMinutes = new Map(session.map((item) => [item.window?.minutes, item]));
  return endpoint.map((item) => item.meter_id.endsWith(":main") && (item.window?.minutes === 300 || item.window?.minutes === 10_080) && (item.freshness === "not_enforced" || item.freshness === "failed")
    ? sessionByMinutes.get(item.window.minutes) ?? item
    : item);
}

function codexLoginCommand(account: ProviderAccount): string {
  const home = resolve(account.location || vendorHome("codex"));
  return home === resolve(vendorHome("codex")) ? "run: codex login" : `run: CODEX_HOME=${home} codex login`;
}

function shape(value: unknown, path = "$"): Array<{ path: string; kind: string }> {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const output = [{ path, kind }];
  if (object(value)) for (const [key, child] of Object.entries(value)) output.push(...shape(child, `${path}.${key}`));
  else if (Array.isArray(value) && value[0] !== undefined) output.push(...shape(value[0], `${path}[]`));
  return output;
}

function headerShape(response: Response): Array<{ path: string; kind: string }> {
  return [...response.headers.keys()].sort().map((name) => ({ path: `$.headers.${name}`, kind: "string" }));
}

/** Returns response key paths and value kinds without retaining response values. */
export async function codexResponseShape(account: ProviderAccount, dependencies: CodexDependencies = {}): Promise<Record<string, Array<{ path: string; kind: string }>>> {
  const now = dependencies.now?.() ?? new Date();
  const path = credentialPath("codex", resolve(account.location || vendorHome("codex")));
  let credential: Credential;
  try { credential = parseCodexCredential(await (dependencies.readFile ?? secureRead)(path, "utf8"), now); }
  catch { throw new Error(`no credentials for this config dir; ${codexLoginCommand(account)}`); }
  if (credential.expired) throw new Error(`token expired; ${codexLoginCommand(account)}`);
  const doFetch = dependencies.fetch ?? fetch;
  const [usage, credits] = await Promise.all([
    outboundFetch(doFetch, new Request("https://chatgpt.com/backend-api/wham/usage", { headers: headers(credential.token, credential.accountId), signal: AbortSignal.timeout(TIMEOUT_MS) })),
    outboundFetch(doFetch, new Request("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", { headers: headers(credential.token, credential.accountId, true), signal: AbortSignal.timeout(TIMEOUT_MS) })),
  ]);
  if (!usage.ok) throw new ProviderHTTPError(usage.status, "Codex");
  if (!credits.ok) throw new ProviderHTTPError(credits.status, "Codex credits");
  return { usage: shape(await vendorJson(usage)), usage_headers: headerShape(usage), reset_credits: shape(await vendorJson(credits)), reset_credits_headers: headerShape(credits) };
}
function headers(token: string, accountId: string | undefined, credit = false): HeadersInit { return { Authorization: `Bearer ${token}`, "User-Agent": "CodexBar", Accept: "application/json", ...(accountId ? { [credit ? "ChatGPT-Account-ID" : "ChatGPT-Account-Id"]: accountId } : {}), ...(credit ? { "OpenAI-Beta": "codex-1", originator: "Codex Desktop" } : {}) }; }
export async function observeCodex(account: ProviderAccount, dependencies: CodexDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date(); const timestamp = now.toISOString();
  try {
    const path = credentialPath("codex", resolve(account.location || vendorHome("codex")));
    const credential = parseCodexCredential(await (dependencies.readFile ?? secureRead)(path, "utf8"), now);
    if (credential.expired) return failed(account, `token expired; ${codexLoginCommand(account)}`, timestamp);
    const doFetch = dependencies.fetch ?? fetch;
    const [usageResponse, creditResponse] = await Promise.all([
      outboundFetch(doFetch, new Request("https://chatgpt.com/backend-api/wham/usage", { headers: headers(credential.token, credential.accountId), signal: AbortSignal.timeout(TIMEOUT_MS) })),
      outboundFetch(doFetch, new Request("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", { headers: headers(credential.token, credential.accountId, true), signal: AbortSignal.timeout(TIMEOUT_MS) })),
    ]);
    if (!usageResponse.ok) throw new ProviderHTTPError(usageResponse.status, "Codex");
    if (!creditResponse.ok) throw new ProviderHTTPError(creditResponse.status, "Codex credits");
    const endpoint = observationsFromCodexUsage(await vendorJson(usageResponse), await vendorJson(creditResponse), account, now);
    const events = await (dependencies.readRateLimitEvents ?? readCodexRateLimitEvents)(resolve(account.location || vendorHome("codex")));
    return mergeSessionFallback(endpoint, observationsFromCodexRateLimitEvents(events, account, now));
  } catch (error) {
    // A live 401/403 (a well-formed token the vendor rejected outright) is
    // just as actionable as a locally detected "no credentials" -- name the
    // exact fix instead of the bare "Codex usage request failed (401)",
    // which told the operator nothing to do about it.
    const reason = error instanceof ProviderHTTPError && (error.status === 401 || error.status === 403) ? `Codex rejected the token (${error.status}); ${codexLoginCommand(account)}`
      : error instanceof ProviderHTTPError ? error.message
      : error instanceof Error && error.message.startsWith("vendor response") ? error.message : error instanceof Error && /auth unavailable|auth invalid|unsafe permissions/.test(error.message) ? `no credentials for this config dir; ${codexLoginCommand(account)}` : "Codex usage unavailable";
    return failed(account, reason, timestamp);
  }
}
