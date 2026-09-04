import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { normalizeObservations, observationsFromReading } from "./engine/observation.js";
import { nativeEnginePath, runNativeEngine } from "./engine/native/run.js";
import { claudeGrantNeededObservations, observeClaude, type ClaudeGrantGate } from "./adapters/claude.js";
import { observeCodex } from "./adapters/codex.js";
import { observeAntigravity } from "./adapters/antigravity.js";
import { observeLocal } from "./engine/local.js";
import { readAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { isLocalAccount, type Observation, type ProviderAccount } from "./types.js";
import type { AgyLoginState } from "./antigravity-keepalive.js";

export interface PollResult {
  observations: Observation[];
  failures: string[];
  antigravityLocal?: Record<string, AntigravityLocalRead>;
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
}

export interface AntigravityLocalRead {
  outcome: "fresh" | "failed" | "empty" | "error";
  payload_kind: "quota_summary" | "placeholder" | "none" | "error";
  at: string;
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
  for (const account of tsAccounts) {
    if (account.vendor === "claude" && options.claudeGrant?.needsGrant(account.name)) {
      observations.push(...claudeGrantNeededObservations(account));
      continue;
    }
    const result = account.vendor === "claude" ? await observeClaude(account) : await observeCodex(account);
    observations.push(...result);
    if (account.vendor === "claude" && options.claudeGrant) {
      const denied = result.find((item) => item.freshness === "failed" && item.reason?.startsWith("Keychain grant needed;"));
      if (denied) options.claudeGrant.markGrantNeeded(account.name, denied.reason ?? "Keychain access denied or timed out");
    }
    const protectedFailure = result.find((item) => item.freshness === "failed" && /\(401|403|429\)/.test(item.reason ?? ""));
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
    } else {
      const remote = await observeAntigravity(account);
      observations.push(...selectAntigravitySource(local, remote, account.name));
      const protectedFailure = remote.find((item) => item.freshness === "failed" && /\(401|403|429\)/.test(item.reason ?? ""));
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
  return { observations: normalizeObservations(observations), failures, ...(Object.keys(antigravityLocal).length ? { antigravityLocal } : {}) };
}
