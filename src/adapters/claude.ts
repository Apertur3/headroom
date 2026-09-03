import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { redact } from "../security.js";
import type { Observation, ProviderAccount } from "../types.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;
const SOURCE = "native:claude";

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

export class ProviderHTTPError extends Error {
  constructor(readonly status: number, provider: string) { super(`${provider} usage request failed (${status})`); }
}

export interface ClaudeDependencies {
  platform?: NodeJS.Platform;
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  keychain?: (service: string) => Promise<string>;
}

export function claudeServiceName(configDir: string, home = homedir()): string {
  const directory = resolve(configDir);
  if (directory === resolve(home, ".claude")) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`;
}

async function readCredentialFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("credentials unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("credentials have unsafe permissions");
  return readFile(path, "utf8");
}

async function keychainPayload(service: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-a", userInfo().username, "-s", service, "-w"], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
    return stdout;
  } catch { throw new Error("OAuth credentials unavailable"); }
}

interface Credential { token: string; expired: boolean; }
export function parseClaudeCredential(payload: string, now = new Date()): Credential {
  try {
    const root: unknown = JSON.parse(payload);
    const oauth = isObject(root) && isObject(root.claudeAiOauth) ? root.claudeAiOauth : undefined;
    const token = oauth && typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
    const expiresAt = oauth && finiteNumber(oauth.expiresAt);
    if (!token || expiresAt === undefined) throw new Error("invalid");
    return { token, expired: now.getTime() >= expiresAt };
  } catch { throw new Error("OAuth credentials invalid"); }
}

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" };
}

function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return ["all", "fable", "routines"].map((meter) => ({ ...base(account, meter, now), window: null, quantity: null, resets_at: null, freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason) }));
}

function window(account: ProviderAccount, meter: string, raw: unknown, minutes: number, now: string): Observation | undefined {
  if (!isObject(raw)) return undefined;
  const used = finiteNumber(raw.utilization) ?? finiteNumber(raw.percent);
  if (used === undefined) return undefined;
  const value = Math.min(100, Math.max(0, used));
  const resets = iso(raw.resets_at);
  return { ...base(account, meter, now), window: { kind: resets ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: { used: value, limit: 100, remaining: Math.max(0, 100 - value), unit: "percent" }, resets_at: resets, freshness: "fresh" };
}

function scoped(account: ProviderAccount, meter: string, candidate: unknown, now: string): Observation {
  if (isObject(candidate) && candidate.is_active === false) return { ...base(account, meter, now), window: { kind: "rolling", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "not_enforced", reason: "vendor marks scoped limit inactive" };
  return window(account, meter, candidate, 10_080, now) ?? { ...base(account, meter, now), window: { kind: "rolling", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "not_enforced", reason: "no scoped limit in response" };
}

/** Parse Claude's OAuth usage body without retaining the credential or response body. */
export function observationsFromClaudeUsage(body: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  if (!isObject(body)) throw new Error("Claude usage response invalid");
  const now = at.toISOString();
  const output = [window(account, "all", body.five_hour, 300, now), window(account, "all", body.seven_day, 10_080, now)].filter((item): item is Observation => Boolean(item));
  let fable: unknown;
  let routines: unknown;
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith("seven_day_")) continue;
    const valid = isObject(value) && (finiteNumber(value.utilization) !== undefined || finiteNumber(value.percent) !== undefined);
    if (lower.includes("fable") && fable === undefined && valid) fable = value;
    if ((lower.includes("routine") || lower.includes("cowork")) && routines === undefined && valid) routines = value;
  }
  if (Array.isArray(body.limits)) for (const limit of body.limits) {
    if (!isObject(limit) || !String(limit.kind ?? "").toLowerCase().includes("scoped")) continue;
    // Match the Swift reader: an active but malformed scoped entry is ignored;
    // it must not displace a valid legacy seven_day_* window.
    if (limit.is_active !== false && finiteNumber(limit.utilization) === undefined && finiteNumber(limit.percent) === undefined) continue;
    const scope = isObject(limit.scope) ? limit.scope : undefined;
    const model = scope && isObject(scope.model) ? scope.model : undefined;
    const name = String(model?.display_name ?? model?.name ?? "").toLowerCase();
    if (name.includes("fable")) { if (!isObject(fable) || limit.is_active !== false) fable = limit; }
    else if (!isObject(routines) || limit.is_active !== false) routines = limit;
  }
  output.push(scoped(account, "fable", fable, now), scoped(account, "routines", routines, now));
  if (!output.some((item) => item.meter_id === `${account.name}:all`)) throw new Error("Claude usage response had no primary windows");
  return output;
}

export async function observeClaude(account: ProviderAccount, dependencies: ClaudeDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const payload = dependencies.platform === "darwin" || (!dependencies.platform && process.platform === "darwin")
      ? await (dependencies.keychain ?? keychainPayload)(claudeServiceName(account.location))
      : await (dependencies.readFile ?? readCredentialFile)(resolve(account.location, ".credentials.json"), "utf8");
    const credential = parseClaudeCredential(payload, now);
    if (credential.expired) return failed(account, "expired, run claude to refresh", timestamp);
    const request = new Request("https://api.anthropic.com/api/oauth/usage", { method: "GET", headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const response = await (dependencies.fetch ?? fetch)(request);
    if (!response.ok) throw new ProviderHTTPError(response.status, "Claude");
    return observationsFromClaudeUsage(await response.json(), account, now);
  } catch (error) {
    return failed(account, error instanceof ProviderHTTPError ? error.message : "Claude usage unavailable", timestamp);
  }
}
