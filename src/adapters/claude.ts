import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { outboundFetch, redact } from "../security.js";
import { assertVendorResponseLimits, vendorJson } from "../limits.js";
import { credentialPath } from "../paths.js";
import { executablePath } from "../paths.js";
import { nativeEnginePath } from "../engine/native/run.js";
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
  /** Test seam only. Production macOS reads credentials exclusively in the probe. */
  keychain?: (service: string) => Promise<string>;
  probe?: (configDir: string) => Promise<string>;
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

export class ClaudeProbeError extends Error {
  constructor(readonly kind: "missing" | "denied" | "timeout" | "unavailable", message: string) { super(message); }
}

/** The single wording for "this principal cannot be probed again until the
 * operator runs the grant command", shared by the daemon's synthetic
 * failure, the collector's gate, and doctor's FAIL line, so all three stay
 * in sync by construction rather than by convention. */
export function claudeGrantNeededReason(principalId: string): string {
  return `Keychain grant needed; run: headroom keychain grant --principal ${principalId}`;
}

async function claudeProbe(configDir: string): Promise<string> {
  const helper = await keychainHelper();
  if (!helper) throw new ClaudeProbeError("unavailable", "Claude probe not built; run npm run engine:build");
  try {
    const { stdout } = await execFileAsync(helper, ["--config-dir", resolve(configDir)], { timeout: TIMEOUT_MS + 2_000, maxBuffer: 1024 * 1024 + 1024, windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
    const value: unknown = JSON.parse(stdout);
    assertVendorResponseLimits(value);
    return stdout;
  } catch (error: unknown) {
    const result = error as { stderr?: string; code?: number | string };
    const stderr = result.stderr ?? "";
    if (stderr.includes("HEADROOM_PROBE_KEYCHAIN_DENIED")) throw new ClaudeProbeError("denied", "Keychain access denied");
    if (stderr.includes("HEADROOM_PROBE_TIMEOUT") || (error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new ClaudeProbeError("timeout", "Keychain access timed out");
    if (stderr.includes("HEADROOM_PROBE_EXPIRED")) throw new ClaudeProbeError("missing", `token expired; run: claude`);
    if (stderr.includes("HEADROOM_PROBE_NO_CREDENTIALS")) throw new ClaudeProbeError("missing", "no credentials in Keychain for this config dir");
    throw new ClaudeProbeError("missing", "no credentials in Keychain for this config dir");
  }
}

/** Interactive CLI entry point; its sole prompt is owned by the signed probe. */
export async function grantClaudeKeychainAccess(configDir: string): Promise<void> {
  await claudeProbe(configDir);
}

async function keychainHelper(): Promise<string | undefined> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const native = await nativeEnginePath();
  const candidates = [native ? join(dirname(native), "headroom-claude-probe") : "", join(root, "engine", ".build", "release", "headroom-claude-probe")];
  for (const candidate of candidates) try { return await executablePath(candidate, { repoRoot: root, development: true }); } catch { /* next candidate */ }
  return undefined;
}

/** sha256 of the resolved Claude probe binary, or undefined when none is
 * built/installed. Used only to detect a rebuild (see syncClaudeGrantState). */
export async function probeBinaryHash(): Promise<string | undefined> {
  const helper = await keychainHelper();
  if (!helper) return undefined;
  return createHash("sha256").update(await readFile(helper)).digest("hex");
}

export interface ClaudeGrantStore {
  keychainGrantNeeded(principalId: string): boolean;
  setKeychainGrantNeeded(principalId: string, reason: string): void;
  probeBinaryHash(): string | undefined;
  setProbeBinaryHash(hash: string): void;
}

/** Gate consulted by the collector before every Claude probe attempt. */
export interface ClaudeGrantGate {
  needsGrant(principalId: string): boolean;
  markGrantNeeded(principalId: string, reason: string): void;
}

export function claudeGrantGate(store: ClaudeGrantStore): ClaudeGrantGate {
  return {
    needsGrant: (id) => store.keychainGrantNeeded(id),
    markGrantNeeded: (id, reason) => store.setKeychainGrantNeeded(id, reason),
  };
}

/**
 * Compares the probe binary's current hash against the one last recorded in
 * the store. A change from a previously-recorded hash (a rebuild, e.g. after
 * `npm run engine:build`) marks every given Claude principal as needing a
 * fresh grant, so the daemon's next poll skips the probe (via the gate above)
 * instead of popping one Keychain dialog per principal per poll; the operator
 * then sees exactly one dialog per principal, only when they run
 * `headroom keychain grant`. The first-ever hash recorded is not a rebuild.
 */
export async function syncClaudeGrantState(
  store: ClaudeGrantStore,
  claudePrincipalIds: string[],
  dependencies: { platform?: NodeJS.Platform; hash?: () => Promise<string | undefined> } = {},
): Promise<boolean> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin" || !claudePrincipalIds.length) return false;
  const hash = await (dependencies.hash ?? probeBinaryHash)();
  if (!hash) return false;
  const previous = store.probeBinaryHash();
  store.setProbeBinaryHash(hash);
  if (previous === undefined || previous === hash) return false;
  for (const id of claudePrincipalIds) store.setKeychainGrantNeeded(id, "probe binary rebuilt");
  return true;
}

interface Credential { token: string; expired: boolean; }

function claudeCommand(account: ProviderAccount): string {
  const directory = resolve(account.location);
  return directory === resolve(homedir(), ".claude") ? "run: claude" : `run: CLAUDE_CONFIG_DIR=${directory} claude`;
}

function shape(value: unknown, path = "$"): Array<{ path: string; kind: string }> {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const output = [{ path, kind }];
  if (isObject(value)) for (const [key, child] of Object.entries(value)) output.push(...shape(child, `${path}.${key}`));
  else if (Array.isArray(value) && value[0] !== undefined) output.push(...shape(value[0], `${path}[]`));
  return output;
}
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

/** Synthetic failed observations for a principal the grant gate is blocking,
 * built without ever attempting the probe (and so never popping a dialog). */
export function claudeGrantNeededObservations(account: ProviderAccount, now = new Date()): Observation[] {
  return failed(account, claudeGrantNeededReason(account.name), now.toISOString());
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

/** Returns response key paths and value kinds without retaining response values. */
export async function claudeResponseShape(account: ProviderAccount, dependencies: ClaudeDependencies = {}): Promise<Array<{ path: string; kind: string }>> {
  const now = dependencies.now?.() ?? new Date();
  const darwin = dependencies.platform === "darwin" || (!dependencies.platform && process.platform === "darwin");
  if (darwin && !dependencies.keychain) return shape(JSON.parse(await (dependencies.probe ?? claudeProbe)(account.location)));
  let payload: string;
  try {
    payload = darwin
      ? await dependencies.keychain!(claudeServiceName(account.location))
      : await (dependencies.readFile ?? readCredentialFile)(credentialPath("claude", resolve(account.location)), "utf8");
  } catch { throw new Error(`${darwin ? "no credentials in Keychain for this config dir" : "no credentials for this config dir"}; ${claudeCommand(account)}`); }
  let credential: Credential;
  try { credential = parseClaudeCredential(payload, now); }
  catch { throw new Error(`credentials invalid; ${claudeCommand(account)}`); }
  if (credential.expired) throw new Error(`token expired; ${claudeCommand(account)}`);
  const response = await outboundFetch(dependencies.fetch ?? fetch, new Request("https://api.anthropic.com/api/oauth/usage", { method: "GET", headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
  if (!response.ok) throw new ProviderHTTPError(response.status, "Claude");
  return shape(await vendorJson(response));
}

export async function observeClaude(account: ProviderAccount, dependencies: ClaudeDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  const darwin = dependencies.platform === "darwin" || (!dependencies.platform && process.platform === "darwin");
  let credentialLoaded = false;
  try {
    if (darwin && !dependencies.keychain) return observationsFromClaudeUsage(JSON.parse(await (dependencies.probe ?? claudeProbe)(account.location)), account, now);
    const payload = darwin
      ? await dependencies.keychain!(claudeServiceName(account.location))
      : await (dependencies.readFile ?? readCredentialFile)(credentialPath("claude", resolve(account.location)), "utf8");
    credentialLoaded = true;
    const credential = parseClaudeCredential(payload, now);
    if (credential.expired) return failed(account, `token expired; ${claudeCommand(account)}`, timestamp);
    const request = new Request("https://api.anthropic.com/api/oauth/usage", { method: "GET", headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const response = await outboundFetch(dependencies.fetch ?? fetch, request);
    if (!response.ok) throw new ProviderHTTPError(response.status, "Claude");
    return observationsFromClaudeUsage(await vendorJson(response), account, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = error instanceof ProviderHTTPError ? error.message
      : error instanceof ClaudeProbeError && error.message.startsWith("token expired") ? `token expired; ${claudeCommand(account)}`
      : error instanceof ClaudeProbeError && (error.kind === "denied" || error.kind === "timeout") ? claudeGrantNeededReason(account.name)
      : error instanceof ClaudeProbeError ? error.message
      : error instanceof Error && error.message.startsWith("vendor response") ? error.message
      : darwin && !credentialLoaded ? `no credentials in Keychain for this config dir; ${claudeCommand(account)}`
      : /no credentials in Keychain/.test(message) ? `no credentials in Keychain for this config dir; ${claudeCommand(account)}`
        : /credentials unavailable|credentials invalid|unsafe permissions/.test(message) ? `no credentials for this config dir; ${claudeCommand(account)}`
          : "Claude usage unavailable";
    return failed(account, reason, timestamp);
  }
}
