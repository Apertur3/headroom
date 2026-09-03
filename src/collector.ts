import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { observationsFromReading } from "./engine/observation.js";
import { nativeEnginePath, runNativeEngine } from "./engine/native/run.js";
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
  const native = await nativeEnginePath();
  if (native) {
    try { observations.push(...await runNativeEngine(native, providerAccounts)); }
    catch (error) { failures.push(`native engine source failed: ${safeError(error)}`); }
  }
  let engine: string | undefined;
  for (const account of native ? [] : providerAccounts) {
    if (account.adapter === "pending" || account.vendor !== "codex") { failures.push(`${account.name} source failed: native engine unavailable`); continue; }
    try {
      engine ??= await verifiedEnginePath();
      observations.push(...adaptCodexPayload((await runCodexBar(engine, account)).payload, account.name).flatMap(observationsFromReading));
    } catch (error) { failures.push(`${account.name} source failed: ${safeError(error)}`); }
  }
  const now = new Date().toISOString();
  for (const account of localAccounts) observations.push({
    principal_id: account.name, meter_id: `${account.name}:capacity`, window: null, quantity: null,
    resets_at: null, observed_at: now, fetched_at: now, source: "engine:local", truth: "estimated",
    freshness: "failed", confidence: 0, adapter_version: "pending", upstream_schema_version: "pending", reason: "adapter pending",
  });
  return { observations, failures };
}
