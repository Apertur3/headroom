import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { normalizeObservations, observationsFromReading } from "./engine/observation.js";
import { nativeEnginePath, runNativeEngine } from "./engine/native/run.js";
import { claudeGrantNeededObservations, observeClaude, type ClaudeGrantGate } from "./adapters/claude.js";
import { freshStatuslineSnapshot, observationsFromStatuslineSnapshot, statuslineSnapshotDirs } from "./adapters/claude-statusline.js";
import { readPolicy } from "./config.js";
import { observeCodex } from "./adapters/codex.js";
import { noDaemonObservations, observeAntigravity } from "./adapters/antigravity.js";
import { observeLocal } from "./engine/local.js";
import { readAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { isLocalAccount, type Observation, type ProviderAccount } from "./types.js";
import type { AgyLoginState } from "./antigravity-keepalive.js";

export interface PollResult {
  observations: Observation[];
  failures: string[];
  antigravityLocal?: Record<string, AntigravityLocalRead>;
  /** Per Claude principal: whether this poll actually attempted the probe, or
   * skipped it because a keychain_grants marker was already set. The
   * observations alone cannot answer this after the fact -- a real denial and
   * a gate-blocked skip render the identical failed reason on purpose -- so
   * every caller (daemon, CLI, MCP) audits from this field instead of
   * inferring an outcome from the observation source. Absent when no Claude
   * principal was polled. "skipped: statusline fresh" covers the zero-auth
   * statusline snapshot path (see adapters/claude-statusline.ts): the probe
   * was never attempted because a fresh-enough snapshot already answered
   * this principal. */
  claudeProbeOutcomes?: Record<string, "called" | "skipped: grant needed" | "skipped: statusline fresh">;
}
export interface PollOptions {
  /** Set only by the daemon while it owns a warmed `agy` PTY. */
  daemonOwnsAntigravity?: boolean;
  /** Remote quota failures are backed off independently from the warm local probe. */
  skipRemoteAntigravity?: boolean;
  /** Auth state sampled from the daemon-owned agy log, for actionable local failures. */
  antigravityLoginState?: AgyLoginState;
  /** Consulted before every Claude probe attempt so a principal denied or
   * timed out (or caught by a probe binary rebuild) is not retried until
   * `headroom keychain grant` clears it. Absent for callers that do not
   * track grant state (e.g. --shape diagnostics). */
  claudeGrant?: ClaudeGrantGate;
  /** Set only by the CLI's and MCP's no-daemon direct-read fallbacks (the
   * only callers that ever poll with no responding daemon at all -- the
   * daemon's own poll loop never sets this). Skips the deprecated remote
   * Antigravity fallback entirely in favor of one clear "start the daemon"
   * reason; see noDaemonObservations(). */
  noDaemon?: boolean;
}

export interface AntigravityLocalRead {
  outcome: "fresh" | "failed" | "empty" | "error";
  payload_kind: "quota_summary" | "placeholder" | "none" | "error";
  at: string;
}

/**
 * Matches a protected vendor status (401/403/429) in either the parenthesized
 * form every adapter using ProviderHTTPError produces ("... (429)") or
 * Google's own bare "HTTP 429" formatting (AntigravityHTTPError, and the
 * Gemini Code Assist fallback's own errors), so a backoff decision never
 * silently misses one vendor's status-code wording. Exported so daemon.ts's
 * scheduler-level backoff shares the exact same detection.
 */
export const PROTECTED_STATUS_PATTERN = /\((?:401|403|429)\)|\bHTTP (?:401|403|429)\b/;

/** A live vendor rate-limit response specifically (not the broader 401/403
 * territory PROTECTED_STATUS_PATTERN also covers): the one case a caller
 * currently serving a cached reading during backoff can name a real,
 * upcoming deadline for, rather than repeating the original attempt's
 * now-stale failure text. */
const RATE_LIMIT_STATUS_PATTERN = /\(429\)|\bHTTP 429\b/;

/** "rate limited by the vendor (429); backing off until HH:MM" -- local
 * time, matching cli.ts's/resets.ts's other short clock-time formatting. */
export function backoffReason(untilMs: number): string {
  return `rate limited by the vendor (429); backing off until ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(untilMs))}`;
}

/**
 * Rewrites the reason of a failed, currently-backed-off 429 observation to
 * name the real backoff deadline, so a caller serving a cached reading
 * during an active backoff window says when it will actually try again
 * instead of repeating whatever the original vendor error said (which only
 * gets staler the longer the backoff runs). `backoffUntil` resolves a
 * principal id to its current backoff deadline (epoch ms), or undefined/past
 * when that principal isn't currently backed off; a 401/403 failure (not a
 * rate limit) and any non-failed observation are returned unchanged.
 */
export function withBackoffReasons<T extends Observation>(observations: T[], backoffUntil: (principalId: string) => number | undefined, now = Date.now()): T[] {
  return observations.map((item) => {
    if (item.freshness !== "failed" || !item.reason || !RATE_LIMIT_STATUS_PATTERN.test(item.reason)) return item;
    const until = backoffUntil(item.principal_id);
    if (until === undefined || until <= now) return item;
    return { ...item, reason: backoffReason(until) };
  });
}

const ANTIGRAVITY_METERS = ["gemini", "claude-gpt"];
const ANTIGRAVITY_WINDOWS = [300, 10_080];

/** A local server is preferred only after its quota summary supplies every real lane. */
export function selectAntigravitySource(local: Observation[], remote: Observation[], principal: string): Observation[] {
  const expected = new Set(ANTIGRAVITY_METERS.flatMap((meter) => ANTIGRAVITY_WINDOWS.map((minutes) => `${principal}:${meter}:${minutes}`)));
  const real = local.filter((row) => row.principal_id === principal && row.source === "local:antigravity:warm" && row.freshness === "fresh" && row.quantity !== null && row.window?.minutes !== null);
  const available = new Set(real.map((row) => `${row.principal_id}:${row.meter_id.slice(principal.length + 1)}:${row.window?.minutes}`));
  return [...expected].every((key) => available.has(key)) ? local : remote;
}

/** One credential-backed collection pass. The daemon supplies serialization/rate limits. */
export async function pollAccounts(principal?: string, options: PollOptions = {}): Promise<PollResult> {
  const accounts = (await readAccounts()).filter((account) => !principal || account.name === principal);
  const providerAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account));
  const localAccounts = accounts.filter(isLocalAccount);
  const observations: Observation[] = [];
  const failures: string[] = [];
  // Claude always stays in the TypeScript adapter: on macOS it delegates the
  // credential read and request to the separately-granted Claude probe.
  const tsAccounts = providerAccounts.filter((account) => account.vendor === "claude" || (account.adapter === "native-ts" && account.vendor === "codex"));
  const claudeProbeOutcomes: Record<string, "called" | "skipped: grant needed" | "skipped: statusline fresh"> = {};
  const claudePrincipalsPresent = tsAccounts.some((account) => account.vendor === "claude");
  // Read once per poll, only when there is a Claude principal to check at
  // all: this is the sole reason the collector reads policy.toml.
  const statuslineDirs = claudePrincipalsPresent ? statuslineSnapshotDirs((await readPolicy()).statusline_snapshot_dirs) : [];
  for (const account of tsAccounts) {
    if (account.vendor === "claude") {
      // Tried before the grant gate below, and before ever touching the
      // probe: a fresh statusline snapshot answers this principal with no
      // Keychain access at all, so a principal the operator has never
      // granted (or one currently blocked pending a grant) still reads,
      // exactly the point of Ask 0 in the 2026-09-05 dogfood report.
      const snapshot = await freshStatuslineSnapshot(statuslineDirs, account, providerAccounts.filter((item) => item.vendor === "claude"), new Date());
      if (snapshot) {
        observations.push(...observationsFromStatuslineSnapshot(snapshot, account.name, new Date()));
        claudeProbeOutcomes[account.name] = "skipped: statusline fresh";
        continue;
      }
    }
    if (account.vendor === "claude" && options.claudeGrant?.needsGrant(account.name)) {
      observations.push(...claudeGrantNeededObservations(account));
      claudeProbeOutcomes[account.name] = "skipped: grant needed";
      continue;
    }
    if (account.vendor === "claude") claudeProbeOutcomes[account.name] = "called";
    // The pinned probe path (once one exists -- see store.ts's probePath()):
    // every poll uses exactly the binary this Headroom home was granted
    // under, never silently switching to a different candidate that happens
    // to resolve too (a repo checkout built alongside an existing global
    // install, for one).
    const result = account.vendor === "claude" ? await observeClaude(account, { probePath: options.claudeGrant?.probePath() }) : await observeCodex(account);
    observations.push(...result);
    if (account.vendor === "claude" && options.claudeGrant) {
      if (result.some((item) => item.freshness === "fresh")) options.claudeGrant.markProbeSucceeded();
      const denied = result.find((item) => item.freshness === "failed" && item.reason?.startsWith("Keychain grant needed;"));
      if (denied) options.claudeGrant.markGrantNeeded(account.name, denied.reason ?? "Keychain access denied or timed out");
    }
    const protectedFailure = result.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  // A one-shot CLI/MCP read is intentionally remote-only. The Swift local
  // probe is called exclusively by the daemon after it has started `agy`.
  const antigravityAccounts = providerAccounts.filter((account) => account.vendor === "antigravity");
  let localAntigravity = new Map<string, Observation[]>();
  const antigravityLocal: Record<string, AntigravityLocalRead> = {};
  const engineAccounts = providerAccounts.filter((account) => account.vendor !== "antigravity" && account.vendor !== "claude" && (account.adapter === "engine" || account.adapter === "native"));
  const native = process.platform === "win32" ? undefined : await nativeEnginePath();
  if (options.daemonOwnsAntigravity && native && antigravityAccounts.length) {
    try {
      const local = await runNativeEngine(native, antigravityAccounts);
      localAntigravity = new Map(antigravityAccounts.map((account) => [account.name, local.filter((row) => row.principal_id === account.name)]));
      for (const account of antigravityAccounts) {
        const rows = localAntigravity.get(account.name) ?? [];
        const complete = selectAntigravitySource(rows, [], account.name) === rows && rows.length > 0;
        if (!complete && options.antigravityLoginState && options.antigravityLoginState !== "unknown") {
          const reason = options.antigravityLoginState === "not_logged_in" ? "agy not logged in (run: agy)" : "agy logged in; quota summary not ready";
          localAntigravity.set(account.name, rows.map((row) => row.freshness === "failed" ? { ...row, reason } : row));
        }
        antigravityLocal[account.name] = { outcome: complete ? "fresh" : rows.length ? "failed" : "empty", payload_kind: complete ? "quota_summary" : rows.length ? "placeholder" : "none", at: new Date().toISOString() };
      }
    } catch (error) {
      failures.push(`native Antigravity local source failed: ${safeError(error)}`);
      for (const account of antigravityAccounts) antigravityLocal[account.name] = { outcome: "error", payload_kind: "error", at: new Date().toISOString() };
    }
  }
  for (const account of antigravityAccounts) {
    const local = localAntigravity.get(account.name) ?? [];
    // Do not spend a remote request after a complete local quota summary. Cold
    // local replies contain failed placeholder rows and therefore fall through.
    if (selectAntigravitySource(local, [], account.name) === local && local.length) {
      observations.push(...local);
    } else if (options.skipRemoteAntigravity) {
      // A remote failure must never suppress the next daemon-owned warm read.
      observations.push(...local);
    } else if (options.noDaemon) {
      observations.push(...noDaemonObservations(account));
    } else {
      const remote = await observeAntigravity(account);
      observations.push(...selectAntigravitySource(local, remote, account.name));
      const protectedFailure = remote.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
      if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
    }
  }
  if (native && engineAccounts.length) {
    try { observations.push(...await runNativeEngine(native, engineAccounts)); }
    catch (error) { failures.push(`native engine source failed: ${safeError(error)}`); }
  }
  let engine: string | undefined;
  for (const account of providerAccounts.filter((item) => item.adapter === "codexbar")) {
    if (account.adapter === "pending" || account.vendor !== "codex") { failures.push(`${account.name} source failed: native engine unavailable`); continue; }
    try {
      engine ??= await verifiedEnginePath();
      observations.push(...adaptCodexPayload((await runCodexBar(engine, account)).payload, account.name).flatMap(observationsFromReading));
    } catch (error) { failures.push(`${account.name} source failed: ${safeError(error)}`); }
  }
  for (const account of engineAccounts) if (!native) {
    const now = new Date().toISOString();
    const meters = ["unknown"];
    observations.push(...meters.map((meter) => ({ principal_id: account.name, meter_id: `${account.name}:${meter}`, window: null, quantity: null, resets_at: null, observed_at: now, fetched_at: now, source: "engine:native", truth: "estimated" as const, freshness: "failed" as const, confidence: 0, adapter_version: "native-ts", upstream_schema_version: "v0.56.4", reason: process.platform === "win32" ? "engine not available on this platform" : "native engine unavailable" })));
  }
  observations.push(...await Promise.all(localAccounts.map(observeLocal)));
  // This is the shared boundary for native and fallback engines. Keep this
  // defensive normalization here as adapters may be added outside this module.
  return { observations: normalizeObservations(observations), failures, ...(Object.keys(antigravityLocal).length ? { antigravityLocal } : {}), ...(Object.keys(claudeProbeOutcomes).length ? { claudeProbeOutcomes } : {}) };
}
