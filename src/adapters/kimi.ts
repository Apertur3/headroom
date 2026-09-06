import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { vendorJson } from "../limits.js";
import { expandHome } from "../paths.js";
import { outboundFetch, readBoundedRegularFile, redact } from "../security.js";
import { ProviderHTTPError } from "./claude.js";
import type { Observation, ProviderAccount } from "../types.js";

/**
 * Kimi (Moonshot's Kimi app and CLI).
 *
 * Two credential sources, in this order of preference:
 *
 * 1. The Kimi Code CLI's own OAuth credential at
 *    `~/.kimi-code/credentials/kimi-code.json` (`KIMI_CODE_HOME` when the
 *    operator moved that home), read against `api.kimi.com/coding/v1/usages`.
 *    This is a real credential file the CLI wrote for itself, so there is
 *    nothing for the operator to copy by hand. Headroom reads it and never
 *    writes it, and it never uses the refresh token: an expired access token
 *    is a failed reading naming `kimi login`, not a silent re-auth against a
 *    credential another tool owns.
 * 2. A token file the operator writes themselves (`location` in accounts.toml,
 *    default `~/.kimi/auth.token`, 0600, containing only the token), read
 *    against the same Connect-style gateway the Kimi Code console calls. The
 *    official desktop app keeps that token in a Chromium cookie database, and
 *    reading another application's cookie store is outside this project's
 *    threat model, so Headroom never touches it; the operator pastes the token
 *    instead.
 *
 * Either credential is held in memory for the duration of one poll and is
 * never logged, stored, or written anywhere.
 */

const TIMEOUT_MS = 10_000;
const SOURCE = "native:kimi";
const CREDITS_SOURCE = "native:kimi:moonshot";
const SCHEMA_VERSION = "v0.56.4";
const GATEWAY = "https://www.kimi.com/apiv2";
const USAGES_URL = `${GATEWAY}/kimi.gateway.billing.v1.BillingService/GetUsages`;
const SUBSCRIPTION_STATS_URL = `${GATEWAY}/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`;
const SUBSCRIPTION_URL = `${GATEWAY}/kimi.gateway.membership.v2.MembershipService/GetSubscription`;
const MOONSHOT_BALANCE_URL = "https://api.moonshot.ai/v1/users/me/balance";
/** The endpoint the Kimi Code CLI's own credential is good for. */
const CODE_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
/** The vendor's own documented 7-day allowance period, used only when the
 * response carries no window of its own for the allowance bucket. */
const WEEKLY_MINUTES = 7 * 24 * 60;
const TOKEN_MAX_BYTES = 8 * 1024;
/** Meters a healthy read always produces, so a failure never leaves one of
 * them silently stale. `code-7d` and `credits` are conditional by design. */
const SUBSCRIPTION_METERS = ["main", "total"];
/** The CLI endpoint reports the plan allowance and its rate-limit windows and
 * nothing else, so `main` is the only meter that read ever produces. */
const CODE_METERS = ["main"];
const LOGIN_STEP = "sign in at https://www.kimi.com/code/console and copy the kimi-auth token";
/** The Kimi Code CLI's own login command, which is the only thing that can
 * replace an expired CLI credential: Headroom does not refresh it. */
const CLI_LOGIN_STEP = "run: kimi login";
/** The one identity header the Kimi Code CLI sends that says nothing about the
 * operator's machine. Headroom deliberately leaves out the CLI's hostname, OS
 * version and device-id headers: that is telemetry about this machine, and the
 * device id would mean creating a file inside another tool's home. */
const CLI_PLATFORM = "kimi_code_cli";
/** A credential that expires within the minute is treated as already expired,
 * so a poll cannot spend a request on a token that dies in flight. */
const CLI_EXPIRY_GRACE_MS = 60_000;
const CREDENTIAL_MAX_BYTES = 16 * 1024;
export const KIMI_TOKEN_FILENAME = "auth.token";
export const KIMI_CLI_CREDENTIAL_FILENAME = "kimi-code.json";
export const MOONSHOT_KEY_FILENAME = "moonshot.key";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The gateway returns proto int64 counters as JSON strings; accept either. */
function integer(value: unknown): number | undefined {
  const raw = typeof value === "string" ? Number(value.trim()) : number(value);
  return raw !== undefined && Number.isFinite(raw) && Number.isInteger(raw) ? raw : undefined;
}

function date(value: unknown): string | null {
  const seconds = number(value);
  if (seconds !== undefined && seconds > 0) return new Date(seconds * 1000).toISOString();
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export interface KimiDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  /** Only used to resolve the default token path when the account carries no
   * explicit `location`; tests point it at a fake home. */
  home?: string;
}

/** `location` is the credential file itself, not a config directory: either
 * the Kimi Code CLI credential or the manual token file. */
export function kimiTokenPath(location?: string, home = homedir()): string {
  return location || join(home, ".kimi", KIMI_TOKEN_FILENAME);
}

/** The Kimi Code CLI writes its OAuth credential under its own home, which is
 * `KIMI_CODE_HOME` when the operator moved it and `~/.kimi-code` otherwise. */
export function kimiCliCredentialPath(home = homedir(), environment: NodeJS.ProcessEnv = process.env): string {
  const codeHome = environment.KIMI_CODE_HOME ? expandHome(environment.KIMI_CODE_HOME) : join(home, ".kimi-code");
  return join(codeHome, "credentials", KIMI_CLI_CREDENTIAL_FILENAME);
}

/** Which of the two sources a principal's `location` names. The CLI writes one
 * file under one name, so the file name is the whole test; a manual token file
 * is anything else. */
export function isKimiCliCredential(path: string): boolean {
  return basename(path) === KIMI_CLI_CREDENTIAL_FILENAME;
}

/** The optional second location: the Moonshot platform API key, in a file
 * beside the subscription token. Its presence is the only opt-in. */
export function kimiCreditsPath(tokenPath: string): string {
  return join(dirname(tokenPath), MOONSHOT_KEY_FILENAME);
}

/**
 * A credential file must be a regular file owned by this user and readable by
 * nobody else. Bounded to 8 KiB before it is ever opened, and required to
 * hold the bare token and nothing else, so a stray config file or an exported
 * cookie jar is refused rather than sent to the vendor.
 */
async function assertPrivateFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} is owned by another user`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`${label} is readable by group or other`);
}

export async function readKimiToken(path: string): Promise<string> {
  await assertPrivateFile(path, "Kimi token file");
  const token = (await readBoundedRegularFile(path, TOKEN_MAX_BYTES)).trim();
  if (!token || /\s/.test(token)) throw new Error("Kimi token file must contain only the token");
  return token;
}

export interface KimiCliCredential {
  token: string;
  /** Epoch milliseconds, when the credential says so. */
  expires_at?: number;
}

/** The CLI credential's own expiry, normalized to milliseconds. The file
 * records epoch seconds; a value large enough to already be milliseconds is
 * taken as such rather than pushed three thousand years into the future. */
function expiryMilliseconds(value: unknown): number | undefined {
  const raw = typeof value === "string" ? Number(value.trim()) : number(value);
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw > 1e11 ? raw : raw * 1000;
}

/**
 * The Kimi Code CLI's credential, held to the same bar as the manual token
 * file: a regular file this user owns, readable by nobody else, bounded before
 * it is ever opened. Only the access token and the expiry are taken; the
 * refresh token is deliberately not returned, because Headroom never refreshes
 * a credential another tool owns.
 */
export async function readKimiCliCredential(path: string): Promise<KimiCliCredential> {
  await assertPrivateFile(path, "Kimi CLI credential file");
  const text = await readBoundedRegularFile(path, CREDENTIAL_MAX_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Kimi CLI credential file is not valid JSON"); }
  if (!object(parsed)) throw new Error("Kimi CLI credential file is not valid JSON");
  const token = string(parsed.access_token);
  if (!token || /\s/.test(token)) throw new Error("Kimi CLI credential file has no access token");
  const expiry = expiryMilliseconds(parsed.expires_at);
  return expiry === undefined ? { token } : { token, expires_at: expiry };
}

/** An access token whose recorded expiry has passed (or passes within the
 * grace window) cannot authorize anything, and Headroom will not trade the
 * refresh token for a new one. A credential that records no expiry at all is
 * not called expired here: the vendor decides, and a 401 then names the same
 * login command. */
export function kimiCliCredentialExpired(credential: KimiCliCredential, now = new Date()): boolean {
  if (credential.expires_at === undefined) return kimiTokenExpired(credential.token, now);
  return credential.expires_at <= now.getTime() + CLI_EXPIRY_GRACE_MS || kimiTokenExpired(credential.token, now);
}

/** A JWT whose own `exp` has passed cannot authorize anything; failing here
 * spends no vendor request and names the fix instead of a bare 401. */
export function kimiTokenExpired(token: string, now = new Date()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"));
    const expiry = object(claims) ? number(claims.exp) : undefined;
    return expiry !== undefined && expiry * 1000 <= now.getTime();
  } catch { return false; }
}

function base(account: ProviderAccount, meter: string, now: string, source = SOURCE): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: SCHEMA_VERSION };
}

function failed(account: ProviderAccount, reason: string, now: string, meters: string[] = SUBSCRIPTION_METERS, source = SOURCE): Observation[] {
  return meters.map((meter) => ({ ...base(account, meter, now, source), window: null, quantity: null, resets_at: null, freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason) }));
}

function percentQuantity(percent: number): Observation["quantity"] {
  const value = Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
  return { used: value, limit: 100, remaining: Math.round((100 - value) * 100) / 100, unit: "percent" };
}

interface Counts { used: number; limit: number; percent: number }

/** `used` is authoritative and may exceed the limit during overage; a
 * `remaining` fallback only counts when it describes a valid balance. A
 * bucket with neither is not a zero reading, it is an unknown one. */
function counts(detail: unknown): Counts | undefined {
  if (!object(detail)) return undefined;
  const limit = integer(detail.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const used = integer(detail.used);
  if (used !== undefined && used >= 0) return { used, limit, percent: (used / limit) * 100 };
  const remaining = integer(detail.remaining);
  if (remaining !== undefined && remaining >= 0 && remaining <= limit) return { used: limit - remaining, limit, percent: ((limit - remaining) / limit) * 100 };
  return undefined;
}

function resetOf(detail: unknown): string | null {
  if (!object(detail)) return null;
  return date(detail.resetTime) ?? date(detail.resetAt) ?? date(detail.reset_time) ?? date(detail.reset_at);
}

/** `{ duration, timeUnit }` as the gateway spells it. An unknown unit yields
 * no window at all rather than a guessed one. */
export function kimiWindowMinutes(window: unknown): number | undefined {
  if (!object(window)) return undefined;
  const duration = integer(window.duration);
  if (duration === undefined || duration <= 0) return undefined;
  const multiplier = window.timeUnit === "TIME_UNIT_MINUTE" ? 1 : window.timeUnit === "TIME_UNIT_HOUR" ? 60 : window.timeUnit === "TIME_UNIT_DAY" ? 24 * 60 : undefined;
  if (multiplier === undefined) return undefined;
  const minutes = duration * multiplier;
  return Number.isSafeInteger(minutes) ? minutes : undefined;
}

/** Plan title from GetSubscription, which the console shows verbatim. Only an
 * active subscription names a plan; anything else stays unknown. */
export function kimiPlanName(subscription: unknown): string | undefined {
  if (!object(subscription) || !object(subscription.subscription)) return undefined;
  const active = subscription.subscription;
  if (active.active !== true || string(active.status) !== "SUBSCRIPTION_STATUS_ACTIVE") return undefined;
  return object(active.goods) ? string(active.goods.title) : undefined;
}

/**
 * The membership 7-day Code ratio and the FEATURE_CODING allowance report the
 * same underlying quota through two endpoints. Suppress the duplicate only on
 * positive evidence that they are the same lane.
 */
function duplicatesAllowance(percent: number, reset: string | null, allowancePercent: number | undefined, allowanceReset: string | null): boolean {
  if (allowancePercent === undefined || Math.abs(percent - allowancePercent) > 1) return false;
  if (!reset || !allowanceReset) return false;
  return Math.abs(Date.parse(reset) - Date.parse(allowanceReset)) <= 5 * 60_000;
}

/** One percent bucket as an observation: fresh when the vendor gave usable
 * counters, and an explicit failure carrying the same window when it did not,
 * so an unreadable bucket is never shown as 0% used. */
function bucketRow(account: ProviderAccount, meter: string, bucket: Counts | undefined, minutes: number | null, reset: string | null, now: string, missingReason: string): Observation {
  const window = { kind: reset ? "fixed" as const : "rolling" as const, minutes, enforcement: "hard" as const };
  return bucket
    ? { ...base(account, meter, now), window, quantity: percentQuantity(bucket.percent), resets_at: reset, freshness: "fresh" }
    : { ...base(account, meter, now), window, quantity: null, resets_at: reset, freshness: "failed", truth: "estimated", confidence: 0, reason: missingReason };
}

function tagger(plan: string | undefined): (observation: Observation) => Observation {
  return (observation) => plan ? { ...observation, metadata: { plan } } : observation;
}

/** Plan titles from the CLI response's own membership level, using the
 * official V1 goods catalog. An unknown level, or a catalog version this
 * adapter has not seen, keeps the vendor's own spelling rather than a guess. */
const CODE_PLAN_TITLES: Record<string, string> = { LEVEL_FREE: "Adagio", LEVEL_TRIAL: "Andante", LEVEL_BASIC: "Moderato", LEVEL_INTERMEDIATE: "Allegretto", LEVEL_ADVANCED: "Allegro" };

export function kimiCodePlanName(body: unknown): string | undefined {
  if (!object(body) || !object(body.user) || !object(body.user.membership)) return undefined;
  const level = string(body.user.membership.level);
  if (!level || level === "LEVEL_UNSPECIFIED") return undefined;
  const version = body.version === undefined ? undefined : string(body.version);
  if (body.version !== undefined && version !== "GOODS_VERSION_V1") return level;
  return CODE_PLAN_TITLES[level] ?? level;
}

/** A meter id segment for a bucket the response names for itself. */
function slug(value: string): string | undefined {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return cleaned || undefined;
}

/**
 * Maps one `api.kimi.com/coding/v1/usages` body (the Kimi Code CLI credential's
 * own endpoint) onto the same meters the gateway path emits:
 *
 * - `<principal>:main` carries the plan allowance plus every rate-limit window
 *   the response declares, the way Codex's `main` carries both of its windows.
 * - A bucket the response names for itself lands on `<principal>:<slug>`
 *   instead, so a future named lane gets its own meter rather than being
 *   quietly merged into `main`.
 *
 * This endpoint reports no shared subscription pool and no membership 7-day
 * ratio, so this path emits neither meter; those stay on the gateway path.
 */
export function observationsFromKimiCodeUsage(body: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  if (!object(body) || !object(body.usage)) throw new Error("Kimi usage response invalid");
  const now = at.toISOString();
  const tagged = tagger(kimiCodePlanName(body));
  const allowance = counts(body.usage);
  const allowanceReset = resetOf(body.usage);
  // The allowance bucket carries no window of its own here either, so it keeps
  // the vendor's documented 7-day allowance period.
  const allowanceMinutes = kimiWindowMinutes(body.usage.window) ?? WEEKLY_MINUTES;
  const output: Observation[] = [tagged(bucketRow(account, "main", allowance, allowanceMinutes, allowanceReset, now, "vendor returned no usable allowance counters"))];

  if (Array.isArray(body.limits)) for (const entry of body.limits) {
    if (!object(entry)) continue;
    const rate = counts(entry.detail);
    const minutes = kimiWindowMinutes(entry.window);
    const named = slug(string(entry.scope) ?? string(entry.name) ?? string(entry.id) ?? "");
    // A bucket with no usable counters, no window in the response, or (on the
    // shared `main` lane) the allowance's own window length would be a guess
    // or a duplicate.
    if (!rate || minutes === undefined || (!named && minutes === allowanceMinutes)) continue;
    const reset = resetOf(entry.detail);
    output.push(tagged({ ...base(account, named ?? "main", now), window: { kind: reset ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: percentQuantity(rate.percent), resets_at: reset, freshness: "fresh" }));
  }
  return output;
}

/**
 * Maps one GetUsages body (plus the two optional membership bodies) onto
 * Headroom meters:
 *
 * - `<principal>:main` carries the FEATURE_CODING allowance window and every
 *   rate-limit window the same response declares, exactly as Codex's `main`
 *   carries both its 5-hour and weekly windows.
 * - `<principal>:total` is the shared subscription pool (`amountUsedRatio`),
 *   which spans every feature, not just Code.
 * - `<principal>:code-7d` is the membership 7-day Code ratio, emitted only
 *   when it genuinely diverges from the allowance above.
 */
export function observationsFromKimiUsage(usage: unknown, stats: unknown, subscription: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  if (!object(usage) || !Array.isArray(usage.usages)) throw new Error("Kimi usage response invalid");
  const coding = usage.usages.find((entry) => object(entry) && string(entry.scope) === "FEATURE_CODING");
  if (!object(coding)) throw new Error("Kimi usage response has no FEATURE_CODING scope");
  const now = at.toISOString();
  const tagged = tagger(kimiPlanName(subscription));
  const output: Observation[] = [];

  const allowance = counts(coding.detail);
  const allowanceReset = resetOf(coding.detail);
  const allowanceMinutes = kimiWindowMinutes(coding.window) ?? WEEKLY_MINUTES;
  output.push(tagged(bucketRow(account, "main", allowance, allowanceMinutes, allowanceReset, now, "vendor returned no usable allowance counters")));

  if (Array.isArray(coding.limits)) for (const entry of coding.limits) {
    if (!object(entry)) continue;
    const rate = counts(entry.detail);
    const minutes = kimiWindowMinutes(entry.window);
    // A rate-limit bucket with no window in the response, no usable counters,
    // or the allowance's own window length would be a guess or a duplicate.
    if (!rate || minutes === undefined || minutes === allowanceMinutes) continue;
    const reset = resetOf(entry.detail);
    output.push(tagged({ ...base(account, "main", now), window: { kind: reset ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: percentQuantity(rate.percent), resets_at: reset, freshness: "fresh" }));
  }

  const balance = object(stats) ? stats.subscriptionBalance : undefined;
  const pool = object(balance) && (balance.feature === undefined || balance.feature === "FEATURE_OMNI") && (balance.type === undefined || balance.type === "SUBSCRIPTION") ? number(balance.amountUsedRatio) : undefined;
  const poolReset = object(balance) ? date(balance.expireTime) : null;
  output.push(tagged(pool !== undefined
    // The pool's own period length is not in the response, so the window
    // carries the vendor's expiry and no invented duration.
    ? { ...base(account, "total", now), window: { kind: poolReset ? "fixed" : "rolling", minutes: null, enforcement: "hard" }, quantity: percentQuantity(pool * 100), resets_at: poolReset, freshness: "fresh" }
    : { ...base(account, "total", now), window: null, quantity: null, resets_at: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "vendor returned no subscription balance" }));

  const codeWeekly = object(stats) ? stats.ratelimitCode7d : undefined;
  const codeRatio = object(codeWeekly) && codeWeekly.enabled !== false ? number(codeWeekly.ratio) : undefined;
  if (codeRatio !== undefined) {
    const reset = object(codeWeekly) ? date(codeWeekly.resetTime) : null;
    if (!duplicatesAllowance(codeRatio * 100, reset, allowance ? Math.min(100, Math.max(0, allowance.percent)) : undefined, allowanceReset)) {
      output.push(tagged({ ...base(account, "code-7d", now), window: { kind: reset ? "fixed" : "rolling", minutes: WEEKLY_MINUTES, enforcement: "hard" }, quantity: percentQuantity(codeRatio * 100), resets_at: reset, freshness: "fresh" }));
    }
  }
  return output;
}

/** Moonshot platform balance: informational only, never a gate. */
export function observationFromMoonshotBalance(body: unknown, account: ProviderAccount, at = new Date()): Observation {
  const now = at.toISOString();
  const available = object(body) && object(body.data) ? number(body.data.available_balance) : undefined;
  if (!object(body) || number(body.code) !== 0 || body.status !== true || available === undefined) {
    return { ...base(account, "credits", now, CREDITS_SOURCE), window: null, quantity: null, resets_at: null, freshness: "failed", truth: "estimated", confidence: 0, reason: "Moonshot balance response reported an error" };
  }
  return { ...base(account, "credits", now, CREDITS_SOURCE), window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: available, unit: "credits" }, resets_at: null, freshness: "fresh" };
}

function gatewayRequest(url: string, token: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      // The gateway authenticates the web session on its own `kimi-auth`
      // cookie name. This is the token Headroom already holds, sent under the
      // name the endpoint expects; no browser cookie store is ever read.
      Cookie: `kimi-auth=${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "connect-protocol-version": "1",
      Origin: "https://www.kimi.com",
      Referer: "https://www.kimi.com/code/console",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Membership enrichment is best effort: a failure there costs the plan name
 * or the pool meter, never the allowance read. */
async function optionalJson(doFetch: typeof fetch, request: Request): Promise<unknown> {
  try {
    const response = await outboundFetch(doFetch, request);
    return response.ok ? await vendorJson(response) : undefined;
  } catch { return undefined; }
}

function tokenReason(error: unknown, path: string): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return `no Kimi token file (${path}); ${LOGIN_STEP} into that file (chmod 600)`;
  const detail = error instanceof Error ? error.message : "Kimi token unavailable";
  return `${detail}; ${LOGIN_STEP} into ${path} (chmod 600)`;
}

function cliCredentialReason(error: unknown, path: string): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return `no Kimi CLI credential (${path}); ${CLI_LOGIN_STEP}`;
  const detail = error instanceof Error ? error.message : "Kimi CLI credential unavailable";
  return `${detail} (${path}); chmod 600 that file, or ${CLI_LOGIN_STEP}`;
}

function cliUsageReason(error: unknown): string {
  if (error instanceof ProviderHTTPError && (error.status === 401 || error.status === 403)) return `Kimi rejected the CLI credential (${error.status}); ${CLI_LOGIN_STEP}`;
  if (error instanceof ProviderHTTPError) return error.message;
  if (error instanceof Error && (error.message.startsWith("vendor response") || error.message.startsWith("Kimi ") || error.message === "redirect refused" || error.message === "Outbound host is not allowed")) return error.message;
  return "Kimi usage unavailable";
}

function usageReason(error: unknown, path: string): string {
  if (error instanceof ProviderHTTPError && (error.status === 401 || error.status === 403)) return `Kimi rejected the token (${error.status}); ${LOGIN_STEP} and refresh ${path}`;
  if (error instanceof ProviderHTTPError) return error.message;
  if (error instanceof Error && (error.message.startsWith("vendor response") || error.message.startsWith("Kimi ") || error.message === "redirect refused" || error.message === "Outbound host is not allowed")) return error.message;
  return "Kimi usage unavailable";
}

/** The optional Moonshot key sits beside the credential Headroom reads. The
 * documented default location beside the manual token file is also accepted,
 * so a principal that moves to the CLI credential does not silently lose an
 * already configured credits meter. */
async function moonshotKeyPath(credentialPath: string, home?: string): Promise<string | undefined> {
  const candidates = [kimiCreditsPath(credentialPath)];
  if (isKimiCliCredential(credentialPath)) candidates.push(kimiCreditsPath(kimiTokenPath(undefined, home ?? homedir())));
  for (const candidate of [...new Set(candidates)]) {
    try { await lstat(candidate); return candidate; } catch { /* not configured here */ }
  }
  return undefined;
}

async function observeMoonshotCredits(account: ProviderAccount, path: string, doFetch: typeof fetch, at: Date): Promise<Observation[]> {
  const now = at.toISOString();
  let key: string;
  try { key = await readKimiToken(path); }
  catch (error) { return failed(account, `${error instanceof Error ? error.message.replace("token file", "credits key file") : "Moonshot key unavailable"} (${path})`, now, ["credits"], CREDITS_SOURCE); }
  try {
    const response = await outboundFetch(doFetch, new Request(MOONSHOT_BALANCE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!response.ok) throw new ProviderHTTPError(response.status, "Moonshot balance");
    return [observationFromMoonshotBalance(await vendorJson(response), account, at)];
  } catch (error) {
    const reason = error instanceof ProviderHTTPError && (error.status === 401 || error.status === 403) ? `Moonshot rejected the API key (${error.status}); replace it in ${path}`
      : error instanceof ProviderHTTPError ? error.message
      : error instanceof Error && error.message.startsWith("vendor response") ? error.message : "Moonshot balance unavailable";
    return failed(account, reason, now, ["credits"], CREDITS_SOURCE);
  }
}

/**
 * The preferred path: the Kimi Code CLI's own credential against the CLI's own
 * usages endpoint. The access token is used as it stands and the credential
 * file is only ever read -- an expired token is a failed reading naming the
 * CLI's login command, never a refresh against a credential another tool owns.
 */
async function observeKimiCodeCli(account: ProviderAccount, path: string, doFetch: typeof fetch, at: Date): Promise<Observation[]> {
  const timestamp = at.toISOString();
  let credential: KimiCliCredential;
  try { credential = await readKimiCliCredential(path); }
  catch (error) { return failed(account, cliCredentialReason(error, path), timestamp, CODE_METERS); }
  if (kimiCliCredentialExpired(credential, at)) return failed(account, `Kimi CLI credential expired; ${CLI_LOGIN_STEP} (Headroom never refreshes it)`, timestamp, CODE_METERS);
  try {
    const response = await outboundFetch(doFetch, new Request(CODE_USAGES_URL, {
      headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "x-msh-platform": CLI_PLATFORM },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    if (!response.ok) throw new ProviderHTTPError(response.status, "Kimi");
    return observationsFromKimiCodeUsage(await vendorJson(response), account, at);
  } catch (error) {
    return failed(account, cliUsageReason(error), timestamp, CODE_METERS);
  }
}

async function observeKimiGateway(account: ProviderAccount, path: string, doFetch: typeof fetch, now: Date): Promise<Observation[]> {
  const timestamp = now.toISOString();
  let token: string;
  try { token = await readKimiToken(path); }
  catch (error) { return failed(account, tokenReason(error, path), timestamp); }
  if (kimiTokenExpired(token, now)) return failed(account, `Kimi token expired; ${LOGIN_STEP} and refresh ${path}`, timestamp);
  const output: Observation[] = [];
  try {
    const [usageResponse, stats, subscription] = await Promise.all([
      outboundFetch(doFetch, gatewayRequest(USAGES_URL, token, { scope: ["FEATURE_CODING"] })),
      optionalJson(doFetch, gatewayRequest(SUBSCRIPTION_STATS_URL, token, {})),
      optionalJson(doFetch, gatewayRequest(SUBSCRIPTION_URL, token, {})),
    ]);
    if (!usageResponse.ok) throw new ProviderHTTPError(usageResponse.status, "Kimi");
    output.push(...observationsFromKimiUsage(await vendorJson(usageResponse), stats, subscription, account, now));
  } catch (error) {
    output.push(...failed(account, usageReason(error, path), timestamp));
  }
  return output;
}

export async function observeKimi(account: ProviderAccount, dependencies: KimiDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const path = kimiTokenPath(account.location, dependencies.home);
  const doFetch = dependencies.fetch ?? fetch;
  const output = isKimiCliCredential(path)
    ? await observeKimiCodeCli(account, path, doFetch, now)
    : await observeKimiGateway(account, path, doFetch, now);
  const creditsKey = await moonshotKeyPath(path, dependencies.home);
  if (creditsKey) output.push(...await observeMoonshotCredits(account, creditsKey, doFetch, now));
  return output;
}
