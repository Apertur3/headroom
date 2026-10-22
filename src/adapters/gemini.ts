import type { Observation, ProviderAccount } from "../types.js";

/** Compatibility for old accounts.toml entries; no credential read or network call. */
export const GEMINI_RETIRED_REASON = "Gemini CLI consumer access ended on 2026-06-18; Headroom no longer polls this provider. Use Antigravity (agy) and remove this legacy account from accounts.toml";
export function retiredGeminiObservations(account: ProviderAccount, now = new Date()): Observation[] {
  const at = now.toISOString();
  return [{
    principal_id: account.name, meter_id: `${account.name}:all`, observed_at: at, fetched_at: at, source: "remote:gemini", truth: "estimated", confidence: 0,
    adapter_version: "native-ts", upstream_schema_version: "v0.56.4", window: null, quantity: null, resets_at: null, freshness: "failed", reason: GEMINI_RETIRED_REASON,
  }];
}
