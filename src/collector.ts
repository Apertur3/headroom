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

/** One credential-backed collection pass. The daemon supplies serialization/rate limits. */
export async function pollAccounts(principal?: string): Promise<PollResult> {
  const accounts = (await readAccounts()).filter((account) => !principal || account.name === principal);
  const providerAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account));
  const localAccounts = accounts.filter(isLocalAccount);
  const observations: Observation[] = [];
  const failures: string[] = [];
  const tsAccounts = providerAccounts.filter((account) => account.adapter === "native-ts" && (account.vendor === "claude" || account.vendor === "codex" || account.vendor === "antigravity"));
  for (const account of tsAccounts) {
    const result = account.vendor === "claude" ? await observeClaude(account) : account.vendor === "codex" ? await observeCodex(account) : await observeAntigravity(account);
    observations.push(...result);
    const protectedFailure = result.find((item) => item.freshness === "failed" && /\(401|403|429\)/.test(item.reason ?? ""));
    if (protectedFailure) failures.push(`${account.name} source failed: ${protectedFailure.reason}`);
  }
  const engineAccounts = providerAccounts.filter((account) => account.adapter === "engine" || (account.vendor === "antigravity" && account.adapter === "native"));
  const native = process.platform === "win32" ? undefined : await nativeEnginePath();
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
    const meters = account.vendor === "antigravity" ? ["gemini", "claude-gpt"] : ["unknown"];
    observations.push(...meters.map((meter) => ({ principal_id: account.name, meter_id: `${account.name}:${meter}`, window: null, quantity: null, resets_at: null, observed_at: now, fetched_at: now, source: "engine:native", truth: "estimated" as const, freshness: "failed" as const, confidence: 0, adapter_version: "native-ts", upstream_schema_version: "v0.56.4", reason: process.platform === "win32" ? "engine not available on this platform" : "native engine unavailable" })));
  }
  observations.push(...await Promise.all(localAccounts.map(observeLocal)));
  // This is the shared boundary for native and fallback engines. Keep this
  // defensive normalization here as adapters may be added outside this module.
  return { observations: normalizeObservations(observations), failures };
}
