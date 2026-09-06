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
import { observeGemini } from "./adapters/gemini.js";
import { observeGrok } from "./adapters/grok.js";
import { observeKimi } from "./adapters/kimi.js";
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

/** Called only once remote has already failed to answer: picks the
 * daemon-owned agy summary in preference to remote's own failed/estimated
 * rows, but only once agy's quota summary supplies every real lane -- a
 * partial warm read is worse than remote's own honest failure reason. */
export function selectAntigravitySource(local: Observation[], remote: Observation[], principal: string): Observation[] {
  const expected = new Set(ANTIGRAVITY_METERS.flatMap((meter) => ANTIGRAVITY_WINDOWS.map((minutes) => `${principal}:${meter}:${minutes}`)));
  const real = local.filter((row) => row.principal_id === principal && row.source === "local:antigravity:warm" && row.freshness === "fresh" && row.quantity !== null && row.window?.minutes !== null);
  const available = new Set(real.map((row) => `${row.principal_id}:${row.meter_id.slice(principal.length + 1)}:${row.window?.minutes}`));
  return [...expected].every((key) => available.has(key)) ? local : remote;
}

/** Explains, alongside remote's own failure reason, why the daemon-kept agy
 * couldn't rescue this read either -- so a failed Antigravity observation
 * always names both outcomes, never just the remote one. */
export function antigravityFallbackNote(daemonOwnsAntigravity: boolean, local: Observation[], loginState: AgyLoginState | undefined): string {
  if (!daemonOwnsAntigravity) return "agy keepalive not running";
  if (!local.length) return "agy warm read unavailable";
  if (loginState === "not_logged_in") return "agy not logged in";
  return "agy quota summary not ready";
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
    // The statusline snapshot is the zero-auth fallback, never the preferred
    // source: it carries only the 5h and weekly account-wide figures, while
    // the granted probe also returns every model-scoped bucket (Fable,
    // Routines). Skipping a granted probe whenever a snapshot was fresh left
    // the scoped meters stale for as long as the snapshot kept arriving.
    const claudeSnapshot = account.vendor === "claude"
      ? await freshStatuslineSnapshot(statuslineDirs, account, providerAccounts.filter((item) => item.vendor === "claude"), new Date())
      : undefined;
    if (account.vendor === "claude" && options.claudeGrant?.needsGrant(account.name)) {
      if (claudeSnapshot) {
        // A principal blocked pending a grant still reads its account-wide
        // figures from the snapshot; its scoped meters stay grant-needed.
        observations.push(...observationsFromStatuslineSnapshot(claudeSnapshot, account.name, new Date()));
        observations.push(...claudeGrantNeededObservations(account).filter((item) => !item.meter_id.endsWith(":all")));
        claudeProbeOutcomes[account.name] = "skipped: statusline fresh";
      } else {
        observations.push(...claudeGrantNeededObservations(account));
        claudeProbeOutcomes[account.name] = "skipped: grant needed";
      }
      continue;
    }
    if (account.vendor === "claude") claudeProbeOutcomes[account.name] = "called";
    // The pinned probe path (once one exists -- see store.ts's probePath()):
    // every poll uses exactly the binary this Headroom home was granted
    // under, never silently switching to a different candidate that happens
    // to resolve too (a repo checkout built alongside an existing global
    // install, for one).
    let result = account.vendor === "claude" ? await observeClaude(account, { probePath: options.claudeGrant?.probePath() }) : await observeCodex(account);
    if (claudeSnapshot && !result.some((item) => item.freshness === "fresh")) {
      // The probe failed this poll (transport, backoff, a denied dialog): the
      // snapshot still answers the account-wide windows; the probe's own
      // failure rows stay for every meter the snapshot does not carry.
      const fromSnapshot = observationsFromStatuslineSnapshot(claudeSnapshot, account.name, new Date());
      const covered = new Set(fromSnapshot.map((item) => `${item.meter_id}|${item.window?.minutes ?? "none"}`));
      result = [...fromSnapshot, ...result.filter((item) => !covered.has(`${item.meter_id}|${item.window?.minutes ?? "none"}`))];
    }
    observations.push(...result);
    if (account.vendor === "claude" && options.claudeGrant) {
      if (result.some((item) => item.freshness === "fresh")) options.claudeGrant.markProbeSucceeded();
      const denied = result.find((item) => item.freshness === "failed" && item.reason?.startsWith("Keychain grant needed;"));
      if (denied) options.claudeGrant.markGrantNeeded(account.name, denied.reason ?? "Keychain access denied or timed out");
    }
    const protectedFailure = result.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  // Grok reads its own token file and calls the CLI chat proxy directly, so
  // it needs neither a grant gate nor a warm local process.
  for (const account of providerAccounts.filter((item) => item.vendor === "grok")) {
    const result = await observeGrok(account);
    observations.push(...result);
    const protectedFailure = result.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  // Kimi reads the operator's own token file and calls the subscription
  // gateway directly; the optional Moonshot credits meter rides along.
  for (const account of providerAccounts.filter((item) => item.vendor === "kimi")) {
    const result = await observeKimi(account);
    observations.push(...result);
    const protectedFailure = result.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  // The Gemini CLI subscription reads its own Code Assist quota over the same
  // Google endpoints Antigravity uses, but with no local process behind it: it
  // is a plain remote read, with no daemon or warm probe involved.
  for (const account of providerAccounts.filter((item) => item.vendor === "gemini")) {
    const result = await observeGemini(account);
    observations.push(...result);
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
    if (options.noDaemon) { observations.push(...noDaemonObservations(account)); continue; }
    if (options.skipRemoteAntigravity) {
      // A remote failure must never suppress the next daemon-owned warm read.
      observations.push(...local);
      continue;
    }
    // Remote is the primary source: agy's warm local summary is a fallback
    // for when the remote quota endpoint can't answer at all (the free-tier
    // availability-only response, a 403, or a transport failure), not the
    // default path. A poll that gets real remote buckets never needs a
    // running agy at all.
    const remote = await observeAntigravity(account);
    const remoteReal = remote.length > 0 && remote.every((item) => item.freshness === "fresh");
    const protectedFailure = remote.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
    if (remoteReal) { observations.push(...remote); continue; }
    const chosen = selectAntigravitySource(local, remote, account.name);
    if (chosen === remote) {
      // Local didn't rescue this read either: name why, alongside remote's
      // own reason, so a failed observation never explains only one side.
      const note = antigravityFallbackNote(options.daemonOwnsAntigravity === true, local, options.antigravityLoginState);
      observations.push(...chosen.map((item) => item.freshness === "failed" && item.reason ? { ...item, reason: `${item.reason}; ${note}` } : item));
    } else {
      observations.push(...chosen);
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
