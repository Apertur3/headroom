import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { normalizeObservations, observationsFromReading } from "./engine/observation.js";
import { nativeEnginePath, runNativeEngine } from "./engine/native/run.js";
import { observeClaude } from "./adapters/claude.js";
import { observeCodex } from "./adapters/codex.js";
import { observeAntigravity } from "./adapters/antigravity.js";
import { observeLocal } from "./engine/local.js";
import { readAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { isLocalAccount, type Observation, type ProviderAccount } from "./types.js";

export interface PollResult { observations: Observation[]; failures: string[]; }
export interface PollOptions {
  /** Set only by the daemon while it owns a warmed `agy` PTY. */
  daemonOwnsAntigravity?: boolean;
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
    const result = account.vendor === "claude" ? await observeClaude(account) : await observeCodex(account);
    observations.push(...result);
    const protectedFailure = result.find((item) => item.freshness === "failed" && /\(401|403|429\)/.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  // A one-shot CLI/MCP read is intentionally remote-only. The Swift local
  // probe is called exclusively by the daemon after it has started `agy`.
  const antigravityAccounts = providerAccounts.filter((account) => account.vendor === "antigravity");
  let localAntigravity = new Map<string, Observation[]>();
  const engineAccounts = providerAccounts.filter((account) => account.vendor !== "antigravity" && account.vendor !== "claude" && (account.adapter === "engine" || account.adapter === "native"));
  const native = process.platform === "win32" ? undefined : await nativeEnginePath();
  if (options.daemonOwnsAntigravity && native && antigravityAccounts.length) {
    try {
      const local = await runNativeEngine(native, antigravityAccounts);
      localAntigravity = new Map(antigravityAccounts.map((account) => [account.name, local.filter((row) => row.principal_id === account.name)]));
    } catch (error) { failures.push(`native Antigravity local source failed: ${safeError(error)}`); }
  }
  for (const account of antigravityAccounts) {
    const local = localAntigravity.get(account.name) ?? [];
    // Do not spend a remote request after a complete local quota summary. Cold
    // local replies contain failed placeholder rows and therefore fall through.
    if (selectAntigravitySource(local, [], account.name) === local && local.length) {
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
  return { observations: normalizeObservations(observations), failures };
}
