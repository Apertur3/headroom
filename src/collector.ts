import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { normalizeObservations, observationsFromReading } from "./engine/observation.js";
import { NATIVE_ENGINE_TIMEOUT_MS, nativeEnginePath, runNativeEngine } from "./engine/native/run.js";
import { observeClaudeUsage, type ClaudeUsageDependencies } from "./adapters/claude-usage.js";
import { claudeGrantNeededObservations, claudeProbeOffObservations, isClaudeProbeDenialReason, observeClaude, type ClaudeGrantGate } from "./adapters/claude.js";
import { freshStatuslineSnapshot, latestStatuslineSnapshot, observationsFromStatuslineSnapshot, statuslineSnapshotDirs } from "./adapters/claude-statusline.js";
import { readPolicy } from "./config.js";
import { observeCodex } from "./adapters/codex.js";
import { failedAntigravityObservations, noDaemonObservations } from "./adapters/antigravity.js";
import {
  antigravityLaneObservations, antigravityModelCatalog, antigravityPayloadFromEngineRows, classifyAntigravityLanes, engineFreshRow, isSettledLane,
  type AntigravityClassification, type AntigravityLaneState, type AntigravityPayloadKind, type EngineRead,
} from "./antigravity-lanes.js";
import { retiredGeminiObservations } from "./adapters/gemini.js";
import { observeGrok } from "./adapters/grok.js";
import { observeKimi } from "./adapters/kimi.js";
import { observeLocal } from "./engine/local.js";
import { readAccounts } from "./registry.js";
import { redact, safeError } from "./security.js";
import { isAccountEnabled, isLocalAccount, type Observation, type ProviderAccount } from "./types.js";
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
  claudeProbeOutcomes?: Record<string, "called" | "skipped: grant needed" | "skipped: statusline fresh" | "skipped: claude_probe off" | "skipped: claude usage">;
}
export interface PollOptions {
  /** Overrides the platform's native-engine availability for controlled callers. */
  nativeEngineAvailable?: boolean;
  /** Set only by the daemon, while a local Antigravity server may be probed:
   * its own warmed `agy` PTY, or a server it discovered but did not start
   * (the IDE's language server, the user's agy). */
  daemonOwnsAntigravity?: boolean;
  /** Auth state sampled from the daemon-owned agy log, for actionable local failures. */
  antigravityLoginState?: AgyLoginState;
  /** Consulted before every Claude probe attempt so a principal denied or
   * timed out (or caught by a probe binary rebuild) is not retried until
   * `headroom keychain grant` clears it. Absent for callers that do not
   * track grant state (e.g. --shape diagnostics). */
  claudeGrant?: ClaudeGrantGate;
  /** Test seam for the `claude -p "/usage"` runner (adapters/claude-usage.ts). */
  claudeUsage?: ClaudeUsageDependencies;
  /** Set only by the CLI's and MCP's no-daemon direct-read fallbacks (the
   * only callers that ever poll with no responding daemon at all -- the
   * daemon's own poll loop never sets this). Skips the deprecated remote
   * Antigravity fallback entirely in favor of one clear "start the daemon"
   * reason; see noDaemonObservations(). */
  noDaemon?: boolean;
}

export interface AntigravityLocalRead {
  /** `fresh`: every expected lane settled (fresh or blocked_by_weekly).
   * `partial`: some lanes settled, others not. `failed`: none settled.
   * `empty`: the engine returned no rows. `error`: the engine call threw. */
  outcome: "fresh" | "partial" | "failed" | "empty" | "error";
  /** What agy answered with (antigravity-lanes.ts), or `none` for no rows. */
  payload_kind: AntigravityPayloadKind | "none";
  /** Each expected lane's state, keyed "gemini 5h", "claude-gpt weekly", ... */
  lanes?: Record<string, AntigravityLaneState>;
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

const LOCAL_ANTIGRAVITY_SOURCE = "local:antigravity:warm";

interface ClassifiedLocalRead { rows: Observation[]; read: EngineRead; classification: AntigravityClassification }

/** One principal's native-engine rows through the shared lane classifier
 * (antigravity-lanes.ts): one row per expected lane, each in its own state,
 * plus any per-model fallback rows the engine sent alongside. */
function classifyLocalAntigravity(rows: Observation[], principal: string): ClassifiedLocalRead {
  const read = antigravityPayloadFromEngineRows(rows, principal);
  // The engine already redacts its error text; redact again at this boundary.
  const payload = read.payload.kind === "error" ? { ...read.payload, error: redact(read.payload.error) } : read.payload;
  return { rows: rows.filter((row) => row.principal_id === principal), read: { ...read, payload }, classification: classifyAntigravityLanes(payload) };
}

function localLaneRows(classified: ClassifiedLocalRead, principal: string, now: string): Observation[] {
  const catalog = classified.classification.complete ? antigravityModelCatalog(classified.rows) : undefined;
  // Synthesized blocked lanes belong to the engine snapshot, not this poll.
  const readAt = classified.rows.reduce((earliest, row) => Date.parse(row.fetched_at) < Date.parse(earliest) ? row.fetched_at : earliest, classified.rows[0]?.fetched_at ?? now);
  return [...antigravityLaneObservations(classified.classification, principal, { now: readAt, source: LOCAL_ANTIGRAVITY_SOURCE, adapterVersion: "0.1.0", freshRow: engineFreshRow(classified.read) }), ...classified.read.extra]
    .map((row) => {
      if (catalog) return { ...row, metadata: { ...row.metadata, model_catalog: catalog } };
      if (!row.metadata?.model_catalog) return row;
      const { model_catalog: _catalog, ...metadata } = row.metadata;
      return { ...row, metadata };
    });
}

function localReadSummary(classified: ClassifiedLocalRead, at: string): AntigravityLocalRead {
  const { classification } = classified;
  const settled = classification.lanes.filter((lane) => isSettledLane(lane.state)).length;
  const empty = classified.rows.length === 0;
  return {
    outcome: empty ? "empty" : classification.complete ? "fresh" : settled > 0 ? "partial" : "failed",
    payload_kind: empty ? "none" : classification.payloadKind,
    lanes: Object.fromEntries(classification.lanes.map((lane) => [`${lane.meter} ${lane.minutes === 300 ? "5h" : "weekly"}`, lane.state])),
    at,
  };
}

/** One credential-backed collection pass. The daemon supplies serialization/rate limits. */
export async function pollAccounts(principal?: string, options: PollOptions = {}): Promise<PollResult> {
  // Disabled is an opt-out before *any* adapter-specific preparation. In
  // particular this must happen before Claude policy/statusline setup and
  // before an Antigravity warm read or local-pool probe can touch a source.
  const accounts = (await readAccounts()).filter((account) => isAccountEnabled(account) && (!principal || account.name === principal));
  const providerAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account));
  const localAccounts = accounts.filter(isLocalAccount);
  const observations: Observation[] = [];
  const failures: string[] = [];
  // Claude always stays in the TypeScript adapter: on macOS it delegates the
  // credential read and request to the separately-granted Claude probe.
  const tsAccounts = providerAccounts.filter((account) => account.vendor === "claude" || (account.adapter === "native-ts" && account.vendor === "codex"));
  const claudeProbeOutcomes: Record<string, "called" | "skipped: grant needed" | "skipped: statusline fresh" | "skipped: claude_probe off" | "skipped: claude usage"> = {};
  const claudePrincipalsPresent = tsAccounts.some((account) => account.vendor === "claude");
  // Read once per poll, only when there is a Claude principal to check at
  // all: this is the sole reason the collector reads policy.toml.
  const claudePolicy = claudePrincipalsPresent ? await readPolicy() : undefined;
  const statuslineDirs = claudePolicy ? statuslineSnapshotDirs(claudePolicy.statusline_snapshot_dirs) : [];
  for (const account of tsAccounts) {
    // Claude read order, every poll: a fresh statusline snapshot (5h and weekly),
    // Claude Code's own `/usage` (at most every 10 minutes per profile, run
    // whatever the snapshot, and the only source of scoped meters such as
    // Fable), then the token probe as a last resort, only when claude_probe is
    // on and the account would otherwise have no fresh reading.
    const claudeAccounts = providerAccounts.filter((item) => item.vendor === "claude");
    if (account.vendor === "claude") {
      const snapshot = await freshStatuslineSnapshot(statuslineDirs, account, claudeAccounts, new Date());
      const usage = await observeClaudeUsage(account, options.claudeUsage);
      const usageError = "error" in usage ? usage.error : "throttled" in usage ? usage.throttled.error : undefined;
      const fromSnapshot = snapshot ? observationsFromStatuslineSnapshot(snapshot, account.name, new Date()) : [];
      if (snapshot || !usageError) {
        // Account-wide windows come from the snapshot (live); /usage adds what it does not carry.
        const covered = new Set(fromSnapshot.map((item) => `${item.meter_id}|${item.window?.minutes ?? "none"}`));
        const rows = "rows" in usage ? usage.rows.filter((item) => !covered.has(`${item.meter_id}|${item.window?.minutes ?? "none"}`)) : [];
        // Throttled after a good run: keep the last reading; only an old snapshot can add rows.
        const old = snapshot || "rows" in usage ? undefined : await latestStatuslineSnapshot(statuslineDirs, account, claudeAccounts, new Date());
        observations.push(...fromSnapshot, ...rows, ...(old ? observationsFromStatuslineSnapshot(old, account.name, new Date()) : []));
        claudeProbeOutcomes[account.name] = snapshot ? "skipped: statusline fresh" : "skipped: claude usage";
        continue;
      }
      if (claudePolicy?.claude_probe !== true) {
        const latest = await latestStatuslineSnapshot(statuslineDirs, account, claudeAccounts, new Date());
        observations.push(...(latest ? observationsFromStatuslineSnapshot(latest, account.name, new Date()) : claudeProbeOffObservations(account, new Date(), usageError)));
        claudeProbeOutcomes[account.name] = "skipped: claude_probe off";
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
      // Only an explicit probe denial gates a principal (claude.ts's
      // isClaudeProbeDenialReason). The probe reads the credential through
      // the Apple security tool, which the Keychain item's access list
      // admits, so a readable credential cannot produce a denial and no poll
      // can mark a working principal as needing anything.
      const denied = result.find((item) => item.freshness === "failed" && isClaudeProbeDenialReason(item.reason));
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
  // Preserve old account IDs as UNKNOWN with migration guidance, without polling.
  for (const account of providerAccounts.filter((item) => item.vendor === "gemini")) {
    const result = retiredGeminiObservations(account);
    observations.push(...result);
    const protectedFailure = result.find((item) => item.freshness === "failed" && PROTECTED_STATUS_PATTERN.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  // A one-shot CLI/MCP read requires a daemon for Antigravity. The Swift local
  // probe is called exclusively by the daemon after it has started `agy`.
  const antigravityAccounts = providerAccounts.filter((account) => account.vendor === "antigravity");
  const localAntigravity = new Map<string, Observation[]>();
  const antigravityLocal: Record<string, AntigravityLocalRead> = {};
  const engineAccounts = providerAccounts.filter((account) => account.vendor !== "antigravity" && account.vendor !== "claude" && (account.adapter === "engine" || account.adapter === "native"));
  let nativeFailure: string | undefined;
  const nativeEngineAvailable = options.nativeEngineAvailable ?? process.platform !== "win32";
  const native = !nativeEngineAvailable ? undefined : await nativeEnginePath().catch((error: unknown) => {
    nativeFailure = safeError(error);
    return undefined;
  });
  if (options.daemonOwnsAntigravity && native && antigravityAccounts.length) {
    try {
      // The retry shares the native reader's normal single-attempt budget.
      // A slow first read therefore leaves only its unused time to the retry,
      // never turning one daemon poll into two 90-second process waits.
      const antigravityDeadline = Date.now() + NATIVE_ENGINE_TIMEOUT_MS;
      const readAntigravity = (accounts: ProviderAccount[]): Promise<Observation[]> => {
        const timeoutMs = antigravityDeadline - Date.now();
        if (timeoutMs <= 0) return Promise.reject(new Error("native Antigravity read exceeded its poll budget"));
        return runNativeEngine(native, accounts, { timeoutMs });
      };
      const local = await readAntigravity(antigravityAccounts);
      const classified = new Map(antigravityAccounts.map((account) => [account.name, classifyLocalAntigravity(local, account.name)]));
      const incomplete = antigravityAccounts.filter((account) => !classified.get(account.name)!.classification.complete);
      // agy's local quota-summary endpoint routinely needs a moment past the
      // engine's own readiness wait to populate every lane, especially while
      // the machine is busy; a real outage stays incomplete on the retry too,
      // but this clears the common transient miss before it ever becomes a
      // source_failed/source_recovered flap. One retry, still inside this
      // same poll, so a genuinely down agy costs one extra native-engine call
      // per poll rather than a silent extra failure/recovery cycle.
      if (incomplete.length) {
        try {
          const retried = await readAntigravity(incomplete);
          for (const account of incomplete) {
            const again = classifyLocalAntigravity(retried, account.name);
            // A partial retry is not an authoritative replacement: it could
            // erase this attempt's whole-meter failure and expose cached
            // fresh capacity for a lane the retry did not answer. Only a
            // complete classification wins; otherwise retain the first read.
            if (again.classification.complete) classified.set(account.name, again);
          }
        } catch { /* keep the first attempt's rows; handled below as usual */ }
      }
      const at = new Date().toISOString();
      for (const account of antigravityAccounts) {
        const read = classified.get(account.name)!;
        antigravityLocal[account.name] = localReadSummary(read, at);
        if (!read.rows.length) continue; // handled below with the reader's own reason
        let rows = localLaneRows(read, account.name, at);
        // The engine's own failure text stays. A known logged-out agy is the
        // actionable part, so it is appended, never substituted.
        if (!read.classification.complete && options.antigravityLoginState === "not_logged_in") {
          rows = rows.map((row) => row.freshness === "failed" ? { ...row, reason: `${row.reason ?? "agy local quota read failed"}; agy not logged in (run: agy)` } : row);
        }
        localAntigravity.set(account.name, rows);
      }
    } catch (error) {
      failures.push(`native Antigravity local source failed: ${safeError(error)}`);
      for (const account of antigravityAccounts) antigravityLocal[account.name] = { outcome: "error", payload_kind: "error", at: new Date().toISOString() };
    }
  }
  for (const account of antigravityAccounts) {
    const local = localAntigravity.get(account.name) ?? [];
    if (options.noDaemon) { observations.push(...noDaemonObservations(account)); continue; }
    // Consumer quotas come from agy's own local summary. Never fall back
    // to Gemini CLI OAuth: Google retired consumer access in June 2026.
    if (local.length) { observations.push(...local); continue; }
    const reason = nativeFailure ?? (process.platform !== "darwin" && !native ? "Antigravity local quota reader is not available on this platform; use macOS"
      : !native ? "Antigravity native reader missing; reinstall headroomd"
      : !options.daemonOwnsAntigravity ? "agy keepalive not running; enable antigravity_keepalive and run: agy"
      : "agy local quota read failed; check headroom doctor and headroom logs");
    observations.push(...failedAntigravityObservations(account, reason, new Date().toISOString()).map((row) => ({ ...row, source: "local:antigravity:warm" })));
    antigravityLocal[account.name] ??= { outcome: "failed", payload_kind: "none", at: new Date().toISOString() };
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
