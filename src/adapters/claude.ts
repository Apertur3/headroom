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
  let helper: string | undefined;
  try { helper = await keychainHelper(); }
  catch (error) { throw new ClaudeProbeError("unavailable", error instanceof Error ? error.message : "Claude probe unavailable"); }
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
    if (stderr.includes("HEADROOM_PROBE_EXPIRED")) throw new ClaudeProbeError("missing", `token expired; ${claudeCommandForDirectory(configDir)}`);
    // Parenthesized status code, matching ProviderHTTPError's own format:
    // collector.ts's and daemon.ts's shared backoff detection looks for this
    // exact shape, so a probe-side 403/429 backs off the same way a direct
    // fetch's would, instead of being silently discarded. The wording itself
    // is the same actionable "rejected the token" fix observeClaude() uses
    // for a live 401/403 over the direct-fetch path.
    if (stderr.includes("HEADROOM_PROBE_FORBIDDEN")) throw new ClaudeProbeError("missing", `Claude rejected the token (403); ${claudeCommandForDirectory(configDir)}`);
    if (stderr.includes("HEADROOM_PROBE_RATE_LIMITED")) throw new ClaudeProbeError("missing", "Claude usage request failed (429)");
    if (stderr.includes("HEADROOM_PROBE_NO_CREDENTIALS")) throw new ClaudeProbeError("missing", "no credentials in Keychain for this config dir");
    throw new ClaudeProbeError("missing", "no credentials in Keychain for this config dir");
  }
}

/** Interactive CLI entry point; its sole prompt is owned by the signed probe. */
export async function grantClaudeKeychainAccess(configDir: string): Promise<void> {
  await claudeProbe(configDir);
}

/** Thrown only when a packaged probe (bin/probe/darwin) is physically present
 * but fails SHA-256 verification: a real integrity problem the caller must
 * surface, distinct from "not built yet" (which silently falls through to
 * the next candidate, or ultimately to probeBinaryHash()/claudeProbe()'s own
 * "not built" message). */
export class ProbeVerificationError extends Error {}

/** Verifies bin/probe/darwin/headroom-claude-probe against its sibling SHA256
 * file (written by scripts/build-probe.sh). Returns undefined -- never
 * throws for "not packaged here" -- when the directory or binary is simply
 * absent, e.g. a source checkout before packing, or any non-darwin platform. */
export async function verifiedPackagedProbe(root: string): Promise<string | undefined> {
  const directory = join(root, "bin", "probe", "darwin");
  const binaryPath = join(directory, "headroom-claude-probe");
  const shaPath = join(directory, "SHA256");
  try { await lstat(binaryPath); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const verified = await executablePath(binaryPath);
  let recorded: string;
  try { recorded = (await readFile(shaPath, "utf8")).trim().split(/\s+/)[0] ?? ""; }
  catch { throw new ProbeVerificationError(`Claude probe SHA-256 record missing (${shaPath}); reinstall headroomd`); }
  const actual = createHash("sha256").update(await readFile(verified)).digest("hex");
  if (!recorded || actual !== recorded) throw new ProbeVerificationError("Claude probe SHA-256 verification failed; reinstall headroomd");
  return verified;
}

/**
 * Resolution order: HEADROOM_PROBE_PATH (a development override, never
 * SHA-256 verified -- the operator named it explicitly), the packaged macOS
 * probe shipped in the npm tarball (bin/probe/darwin, SHA-256 verified
 * against every use), then a repo dev build (engine/.build/release, the
 * output of `npm run engine:build`, confined to this repository checkout).
 * A verification failure on the packaged probe propagates as
 * ProbeVerificationError instead of silently falling through, so a
 * tampered or corrupted install never quietly downgrades to "not built".
 */
async function keychainHelper(): Promise<string | undefined> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const override = process.env.HEADROOM_PROBE_PATH;
  if (override) { try { return await executablePath(override); } catch { return undefined; } }
  if (process.platform === "darwin") {
    const packaged = await verifiedPackagedProbe(root);
    if (packaged) return packaged;
  }
  const candidate = join(root, "engine", ".build", "release", "headroom-claude-probe");
  try { return await executablePath(candidate, { repoRoot: root, development: true }); } catch { /* not a repo dev build either */ }
  return undefined;
}

/** sha256 of the resolved Claude probe binary, or undefined when none is
 * built/installed or the packaged probe fails verification. Used only to
 * detect a rebuild (see syncClaudeGrantState); a verification failure here
 * must never crash a background caller like doctor or an ordinary poll, so
 * it is treated the same as "no probe available". */
export async function probeBinaryHash(): Promise<string | undefined> {
  let helper: string | undefined;
  try { helper = await keychainHelper(); } catch { return undefined; }
  if (!helper) return undefined;
  return createHash("sha256").update(await readFile(helper)).digest("hex");
}

export interface ClaudeGrantStore {
  keychainGrantNeeded(principalId: string): boolean;
  setKeychainGrantNeeded(principalId: string, reason: string): void;
  probeBinaryHash(): string | undefined;
  setProbeBinaryHash(hash: string): void;
  /** The most recent probe binary hash that actually proved itself: either an
   * explicit `headroom keychain grant` succeeded under it, or a poll got a
   * real vendor response through it. Distinct from probeBinaryHash, which is
   * only "the hash last seen", so a fresh install (no probeBinaryHash yet)
   * can still be recognized as already-trusted after a restore/reinstall of
   * the same binary. */
  probeGrantedHash(): string | undefined;
  setProbeGrantedHash(hash: string): void;
}

/** Gate consulted by the collector before every Claude probe attempt. */
export interface ClaudeGrantGate {
  needsGrant(principalId: string): boolean;
  markGrantNeeded(principalId: string, reason: string): void;
  /** Called once a probe attempt for the current binary hash actually
   * returns a real vendor response, so that hash is recorded as known-good
   * and never treated as an unproven first run again. */
  markProbeSucceeded(): void;
}

export function claudeGrantGate(store: ClaudeGrantStore): ClaudeGrantGate {
  return {
    needsGrant: (id) => store.keychainGrantNeeded(id),
    markGrantNeeded: (id, reason) => store.setKeychainGrantNeeded(id, reason),
    markProbeSucceeded: () => { const hash = store.probeBinaryHash(); if (hash) store.setProbeGrantedHash(hash); },
  };
}

/**
 * Compares the probe binary's current hash against the one last recorded in
 * the store. Every given Claude principal is marked as needing a fresh grant
 * whenever the current hash has not already proven itself (store.probeGrantedHash()):
 * a rebuild (a hash change, e.g. after `npm run engine:build`) marks them, and
 * so does a genuinely first-ever run (no probeBinaryHash recorded yet) with no
 * prior successful grant or probe under this exact binary -- a fresh install
 * or a freshly rebuilt probe must only ever pop its first Keychain dialog
 * through `headroom keychain grant`, never from a background daemon poll.
 * Once this exact hash has succeeded once (grantClaudeKeychainAccess or a
 * successful poll both call ClaudeGrantGate.markProbeSucceeded), further syncs
 * under the same hash -- including a store that lost its probeBinaryHash but
 * kept probeGrantedHash, e.g. a restore -- are not marked again.
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
  if (previous === hash) return false; // unchanged since the last sync; already resolved either way
  if (store.probeGrantedHash() === hash) return false; // this exact binary already proved itself
  const reason = previous === undefined ? "no successful probe recorded for this binary" : "probe binary rebuilt";
  for (const id of claudePrincipalIds) store.setKeychainGrantNeeded(id, reason);
  return true;
}

interface Credential { token: string; expired: boolean; }

function claudeCommandForDirectory(configDir: string): string {
  const directory = resolve(configDir);
  return directory === resolve(homedir(), ".claude") ? "run: claude" : `run: CLAUDE_CONFIG_DIR=${directory} claude`;
}

function claudeCommand(account: ProviderAccount): string { return claudeCommandForDirectory(account.location); }

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
    // A live 401/403 (a well-formed token the vendor rejected outright) is
    // just as actionable as a locally detected "no credentials" -- name the
    // exact fix instead of the bare "Claude usage request failed (401)",
    // which told the operator nothing to do about it.
    const reason = error instanceof ProviderHTTPError && (error.status === 401 || error.status === 403) ? `Claude rejected the token (${error.status}); ${claudeCommand(account)}`
      : error instanceof ProviderHTTPError ? error.message
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
