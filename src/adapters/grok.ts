import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { outboundFetch, readBoundedRegularFile, redact } from "../security.js";
import { vendorJson } from "../limits.js";
import { ProviderHTTPError } from "./claude.js";
import type { Observation, ProviderAccount } from "../types.js";

const TIMEOUT_MS = 10_000;
/** The plan name is optional enrichment, so it never delays the usage read. */
const SETTINGS_TIMEOUT_MS = 2_000;
const SOURCE = "native:grok";
/** Both endpoints live on the Grok CLI's own chat proxy, the only host this
 * adapter ever contacts and the only one it adds to the outbound allowlist. */
export const GROK_BILLING_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const GROK_SETTINGS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/settings";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const child = (parent: ObjectValue | undefined, key: string): ObjectValue | undefined => parent && object(parent[key]) ? parent[key] : undefined;

export interface GrokDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
}

/**
 * `grok login` writes its token to `<GROK_HOME or ~/.grok>/auth.json`. An
 * account's `location` may name that file directly or the directory holding
 * it, so an operator who points at either spelling gets the same principal.
 */
export function grokAuthPath(location?: string, home = homedir()): string {
  const target = location?.trim() || join(home, ".grok");
  return basename(target) === "auth.json" ? target : join(target, "auth.json");
}

/** The directory form of the same location, for the login hint below. */
function grokHomeDirectory(location?: string, home = homedir()): string {
  const path = grokAuthPath(location, home);
  return resolve(path.slice(0, path.length - "auth.json".length) || ".");
}

/** Names the exact recovery command, including the GROK_HOME a non-default
 * location needs, the way the Codex adapter names its own CODEX_HOME form. */
export function grokLoginCommand(account: ProviderAccount, home = homedir()): string {
  const directory = grokHomeDirectory(account.location, home);
  return directory === resolve(join(home, ".grok")) ? "run: grok login" : `run: GROK_HOME=${directory} grok login`;
}

/** The token is read into memory only: never logged, never written anywhere,
 * and never returned from this module. The file itself must be a regular
 * file owned by this user, so another account cannot substitute a symlink,
 * a FIFO, or its own credential file. */
async function secureRead(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Grok auth unavailable");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Grok auth unavailable");
  return readBoundedRegularFile(path);
}

/** Top-level OIDC scope `grok login` writes for a SuperGrok subscriber. */
const OIDC_SCOPE_PREFIX = "https://auth.x.ai::";
/** The sign-in scope older `grok login` releases wrote instead. */
const LEGACY_SESSION_SCOPE = "https://accounts.x.ai/sign-in";

export interface GrokCredential { token: string; expired: boolean; }

function isoDate(value: unknown): string | null {
  const raw = string(value);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

/**
 * `auth.json` is a map keyed by scope URL. The OIDC entry wins, with the
 * legacy sign-in entry as a fallback; an entry carrying no usable `key` is
 * skipped entirely so a stale record cannot shadow a healthy one.
 */
export function parseGrokCredential(payload: string, now = new Date()): GrokCredential {
  let root: unknown;
  try { root = JSON.parse(payload); } catch { throw new Error("Grok auth invalid"); }
  if (!object(root)) throw new Error("Grok auth invalid");
  let oidc: ObjectValue | undefined;
  let legacy: ObjectValue | undefined;
  for (const [scope, value] of Object.entries(root)) {
    if (!object(value) || !string(value.key)) continue;
    if (scope.startsWith(OIDC_SCOPE_PREFIX)) oidc = value;
    else if (scope === LEGACY_SESSION_SCOPE || scope.includes("/sign-in")) legacy = value;
  }
  const entry = oidc ?? legacy;
  const token = entry && string(entry.key);
  if (!entry || !token) throw new Error("Grok auth invalid");
  const expires = isoDate(entry.expires_at);
  return { token, expired: expires !== null && now.getTime() >= Date.parse(expires) };
}

/** xAI's consumer plan labels, normalized to the two names the vendor shows. */
export function grokPlanName(raw: unknown): string | null {
  const value = string(raw);
  if (!value) return null;
  const token = value.toLowerCase().replace(/[^a-z]/g, "");
  if (token === "supergrokheavy" || token === "heavy") return "SuperGrok Heavy";
  if (token === "supergrok") return "SuperGrok";
  return value;
}

/** Cadence tokens the credits payload uses when it names a period type. */
const PERIOD_MINUTES: Record<string, number> = { USAGE_PERIOD_TYPE_DAILY: 1440, USAGE_PERIOD_TYPE_WEEKLY: 10_080 };

/** Window length, measured from the period the vendor published rather than
 * inferred from the time left until reset: a monthly period read near its
 * end would otherwise be misreported as a weekly one. */
export function grokWindowMinutes(period: ObjectValue | undefined): number | null {
  const start = isoDate(period?.start);
  const end = isoDate(period?.end);
  if (start && end) {
    const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
    if (minutes > 0) return minutes;
  }
  const type = string(period?.type);
  return type && PERIOD_MINUTES[type] !== undefined ? PERIOD_MINUTES[type] : null;
}

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "grok-cli-proxy-v1" };
}

function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return ["main", "credits"].map((meter) => ({ ...base(account, meter, now), window: null, quantity: null, resets_at: null, freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason) }));
}

/**
 * Maps the CLI proxy's `/v1/billing?format=credits` body, plus the optional
 * `/v1/settings` body that carries only the plan name, onto Headroom meters:
 *
 * - `<principal>:main` is the subscription allowance as a percent, read from
 *   `config.creditUsagePercent` and falling back to the on-demand pool's own
 *   used/cap ratio. Its window length and reset come from the published
 *   billing period, never from a guess.
 * - `<principal>:credits` is the on-demand balance the same payload reports
 *   as an amount rather than a window. It is informational, the same `count`
 *   shape the Codex adapter gives its reset credits, so pace states never
 *   treat a money balance as a rate limit.
 *
 * Neither endpoint publishes a per-model bucket, so no `<principal>:<slug>`
 * meter is emitted; one belongs here the day the vendor exposes it.
 */
export function observationsFromGrokBilling(billing: unknown, settings: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  const config = child(object(billing) ? billing : undefined, "config");
  if (!object(billing) || !config) throw new Error("Grok billing response invalid");
  const now = at.toISOString();
  const plan = grokPlanName(object(settings) ? settings.subscription_tier_display : undefined)
    ?? grokPlanName(config.subscriptionTier) ?? grokPlanName(billing.subscriptionTier);
  const metadata = plan ? { plan } : {};
  const period = child(config, "currentPeriod");
  const resets = isoDate(period?.end) ?? isoDate(config.billingPeriodEnd);
  const minutes = grokWindowMinutes(period);
  const cap = number(child(config, "onDemandCap")?.val);
  const spent = number(child(config, "onDemandUsed")?.val);
  const percent = number(config.creditUsagePercent) ?? (cap !== undefined && cap > 0 && spent !== undefined ? spent / cap * 100 : undefined);
  const output: Observation[] = [];
  if (percent === undefined) {
    // A period with no usage figure is an answered request with nothing to
    // report, not a reading of zero. The vendor's own client shows no bar.
    output.push({ ...base(account, "main", now), window: null, quantity: null, resets_at: resets, freshness: "failed", truth: "estimated", confidence: 0, reason: "vendor returned no usage percentage", metadata });
  } else {
    const value = Math.min(100, Math.max(0, percent));
    output.push({ ...base(account, "main", now), window: { kind: resets ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: { used: value, limit: 100, remaining: Math.max(0, 100 - value), unit: "percent" }, resets_at: resets, freshness: "fresh", metadata });
  }
  if (cap !== undefined && spent !== undefined) {
    output.push({ ...base(account, "credits", now), window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: spent, limit: cap, remaining: Math.max(0, cap - spent), unit: "credits" }, resets_at: resets, freshness: "fresh", metadata });
  }
  return output;
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "x-xai-token-auth": "xai-grok-cli", Accept: "application/json", "User-Agent": "headroom" };
}

/** The plan name is enrichment: a settings call that fails, times out, or
 * omits the field drops the overlay instead of failing the usage read. */
async function readSettings(doFetch: typeof fetch, token: string): Promise<unknown> {
  try {
    const response = await outboundFetch(doFetch, new Request(GROK_SETTINGS_ENDPOINT, { headers: headers(token), signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS) }));
    return response.ok ? await vendorJson(response) : undefined;
  } catch { return undefined; }
}

export async function observeGrok(account: ProviderAccount, dependencies: GrokDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  try {
    const path = grokAuthPath(account.location);
    const credential = parseGrokCredential(await (dependencies.readFile ?? secureRead)(path), now);
    if (credential.expired) return failed(account, `token expired; ${grokLoginCommand(account)}`, timestamp);
    const doFetch = dependencies.fetch ?? fetch;
    const billing = await outboundFetch(doFetch, new Request(GROK_BILLING_ENDPOINT, { headers: headers(credential.token), signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!billing.ok) throw new ProviderHTTPError(billing.status, "Grok");
    const body = await vendorJson(billing);
    return observationsFromGrokBilling(body, await readSettings(doFetch, credential.token), account, now);
  } catch (error) {
    // A 401 is a token the vendor no longer accepts: name the login command
    // instead of a bare status. 403 and 429 keep the parenthesized status
    // the collector's protected-status backoff matches on, so a principal
    // the vendor is actively refusing is not polled again immediately.
    const reason = error instanceof ProviderHTTPError && error.status === 401 ? `Grok rejected the token; ${grokLoginCommand(account)}`
      : error instanceof ProviderHTTPError && error.status === 403 ? `Grok rejected the token (403); ${grokLoginCommand(account)}`
      : error instanceof ProviderHTTPError ? error.message
      : error instanceof Error && error.message.startsWith("vendor response") ? error.message
      : error instanceof Error && /auth unavailable|auth invalid/.test(error.message) ? `no credentials for this config dir; ${grokLoginCommand(account)}`
      : error instanceof Error && error.message === "Grok billing response invalid" ? error.message
      : "Grok usage unavailable";
    return failed(account, reason, timestamp);
  }
}
