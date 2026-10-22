import { redact } from "../security.js";
import type { Observation, ProviderAccount } from "../types.js";
import { antigravityLaneObservations, classifyAntigravityLanes } from "../antigravity-lanes.js";

const SOURCE = "remote:antigravity";

/** Every lane failed with one reason: the classifier's `error` state, so a
 * whole-meter failure reads the same from the remote and the local path. */
export function failedAntigravityObservations(account: ProviderAccount, reason: string, now: string): Observation[] {
  return antigravityLaneObservations(classifyAntigravityLanes({ kind: "error", error: redact(reason) }), account.name, { now, source: SOURCE });
}

/**
 * Synthetic failed observations for a one-shot CLI/MCP read with no daemon
 * responding, naming the one actionable fix.
 */
export function noDaemonObservations(account: ProviderAccount, now = new Date()): Observation[] {
  return failedAntigravityObservations(account, "no daemon; Antigravity needs the daemon-kept agy: run headroom install-service", now.toISOString());
}
