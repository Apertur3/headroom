import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { credentialPath, vendorHome } from "../paths.js";
import { redact } from "../security.js";
import { ProviderHTTPError } from "./claude.js";
import type { Observation, ProviderAccount } from "../types.js";

const TIMEOUT_MS = 10_000;
const SOURCE = "native:codex";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export interface CodexDependencies { now?: () => Date; fetch?: typeof fetch; readFile?: (path: string, encoding: BufferEncoding) => Promise<string>; }
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
function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> { return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" }; }
function failed(account: ProviderAccount, reason: string, now: string): Observation[] { return ["main", "spark", "credits"].map((meter) => ({ ...base(account, meter, now), window: null, quantity: null, resets_at: null, freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason) })); }
function date(seconds: unknown): string | null { const value = number(seconds); return value && value > 0 ? new Date(value * 1000).toISOString() : null; }
function rate(account: ProviderAccount, meter: string, raw: unknown, fallback: number, now: string): Observation | undefined {
  if (!object(raw)) return undefined;
  const used = number(raw.used_percent); if (used === undefined) return undefined;
  const minutes = Math.floor((number(raw.limit_window_seconds) ?? fallback * 60) / 60) || fallback;
  const reset = date(raw.reset_at);
  const value = Math.min(100, Math.max(0, used));
  return { ...base(account, meter, now), window: { kind: reset ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: { used: value, limit: 100, remaining: Math.max(0, 100 - value), unit: "percent" }, resets_at: reset, freshness: "fresh" };
}
/** Parse the `wham/usage` body and optional reset-credit body from CodexBar's v0.56.4 contract. */
export function observationsFromCodexUsage(usage: unknown, credits: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  if (!object(usage) || !object(usage.rate_limit)) throw new Error("Codex usage response invalid");
  const now = at.toISOString(); const rateLimit = usage.rate_limit;
  const plan = string(usage.plan_type);
  const metadata = { ...(plan ? { plan } : {}), ...(object(credits) && number(credits.available_count) !== undefined ? { free_resets_available: number(credits.available_count)! } : {}) };
  const tagged = (observation: Observation): Observation => ({ ...observation, metadata });
  const output: Observation[] = [];
  const primary = rate(account, "main", rateLimit.primary_window, 300, now);
  output.push(primary ? tagged(primary) : tagged({ ...base(account, "main", now), window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "not_enforced", reason: "vendor returned no 5-hour window" }));
  const weekly = rate(account, "main", rateLimit.secondary_window, 10_080, now);
  output.push(tagged(weekly ?? { ...base(account, "main", now), window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "vendor returned no weekly window" }));
  if (Array.isArray(usage.additional_rate_limits)) for (const entry of usage.additional_rate_limits) {
    if (!object(entry) || !String(entry.limit_name ?? entry.metered_feature ?? "").toLowerCase().includes("spark") || !object(entry.rate_limit)) continue;
    const five = rate(account, "spark", entry.rate_limit.primary_window, 300, now); const week = rate(account, "spark", entry.rate_limit.secondary_window, 10_080, now);
    if (five) output.push(tagged(five)); if (week) output.push(tagged(week));
  }
  if (object(credits) && number(credits.available_count) !== undefined) {
    const available = number(credits.available_count)!;
    const expiries = (Array.isArray(credits.credits) ? credits.credits : []).flatMap((credit) => object(credit) && string(credit.status) === "available" && typeof credit.expires_at === "string" ? [credit.expires_at] : []).sort();
    output.push(tagged({ ...base(account, "credits", now), window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: available, unit: "credits" }, resets_at: expiries[0] ?? null, freshness: "fresh" }));
  }
  return output;
}
function headers(token: string, accountId: string | undefined, credit = false): HeadersInit { return { Authorization: `Bearer ${token}`, "User-Agent": "CodexBar", Accept: "application/json", ...(accountId ? { [credit ? "ChatGPT-Account-ID" : "ChatGPT-Account-Id"]: accountId } : {}), ...(credit ? { "OpenAI-Beta": "codex-1", originator: "Codex Desktop" } : {}) }; }
export async function observeCodex(account: ProviderAccount, dependencies: CodexDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date(); const timestamp = now.toISOString();
  try {
    const path = credentialPath("codex", resolve(account.location || vendorHome("codex")));
    const credential = parseCodexCredential(await (dependencies.readFile ?? secureRead)(path, "utf8"), now);
    if (credential.expired) return failed(account, "expired, run codex login", timestamp);
    const doFetch = dependencies.fetch ?? fetch;
    const [usageResponse, creditResponse] = await Promise.all([
      doFetch(new Request("https://chatgpt.com/backend-api/wham/usage", { headers: headers(credential.token, credential.accountId), signal: AbortSignal.timeout(TIMEOUT_MS) })),
      doFetch(new Request("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", { headers: headers(credential.token, credential.accountId, true), signal: AbortSignal.timeout(TIMEOUT_MS) })),
    ]);
    if (!usageResponse.ok) throw new ProviderHTTPError(usageResponse.status, "Codex");
    if (!creditResponse.ok) throw new ProviderHTTPError(creditResponse.status, "Codex credits");
    return observationsFromCodexUsage(await usageResponse.json(), await creditResponse.json(), account, now);
  } catch (error) { return failed(account, error instanceof ProviderHTTPError ? error.message : "Codex usage unavailable", timestamp); }
}
