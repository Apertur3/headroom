import type { Observation, Reading } from "../types.js";

/** Retained for backward compatibility with rows and events an earlier
 * release already wrote to disk (the append-only observations/events tables
 * can hold this exact reason from before the 2026-09 vendor-numbers
 * decision). Nothing in this module produces it anymore -- see
 * IDLE_WINDOW_REASON below for the case it used to cover. */
export const AVAILABILITY_ONLY_REASON = "availability-only payload; quota summary not served";

/**
 * A vendor-reported zero-use window whose reset is manufactured from the
 * fetch time and the window's own advertised duration is shaped exactly like
 * an availability response wearing a quota summary's clothes: it is also
 * exactly what a genuinely idle rolling window looks like, since a rolling
 * window with nothing spent in it recomputes its reset the same way on every
 * poll. Nothing here can tell the two apart from a single snapshot alone.
 *
 * This deliberately works on a complete principal snapshot, rather than an
 * individual row: a single idle window is unremarkable, while every window
 * the vendor reported sharing this synthetic-reset shape is the pattern
 * worth flagging.
 */
export function detectPlaceholder(observations: Observation[]): boolean {
  const windows = observations.filter((observation) => observation.window?.kind !== "state" && observation.freshness !== "not_enforced");
  return windows.length >= 2 && windows.every((observation) => {
    const used = observation.quantity?.used;
    const minutes = observation.window?.minutes;
    const fetched = new Date(observation.fetched_at).getTime();
    const reset = observation.resets_at ? new Date(observation.resets_at).getTime() : Number.NaN;
    return (used === 0 || used === null || used === undefined)
      && typeof minutes === "number" && Number.isFinite(minutes)
      && Number.isFinite(fetched) && Number.isFinite(reset)
      && Math.abs(reset - (fetched + minutes * 60_000)) <= 90_000;
  });
}

/**
 * The reason (and machine-readable flag -- see store.ts's exact-match use of
 * it, the same convention AVAILABILITY_ONLY_REASON established) set on a
 * detectPlaceholder-flagged reading. Per the repository owner's decision
 * (2026-09): Headroom shows the vendor's own numbers and annotates doubt
 * instead of replacing a truthful idle reading with UNKNOWN on a heuristic --
 * "why is it a placeholder? It's what Google reports? Even in the
 * Antigravity app I get 100%." The observation's quantity, resets_at and
 * freshness are left exactly as the vendor reported them; only truth and
 * confidence move to flag the doubt.
 */
export const IDLE_WINDOW_REASON = "vendor reports an idle window; reset equals fetch time plus window length, so this may be a placeholder";

/** Static prefix of idleContradictionReason()'s formatted text, so a caller
 * can recognize the reason without reconstructing the exact percentage. */
const IDLE_CONTRADICTION_PREFIX = "idle reading contradicts the previous fresh reading";

/** store.ts sets this reason when a store-held previous fresh reading for the
 * same meter and window, within the last 2 hours, reported real usage whose
 * reset has not yet passed -- the one case an idle reading is demoted rather
 * than merely flagged, since a vendor cannot legitimately go from spending to
 * idle without a reset in between. */
export function idleContradictionReason(previousUsedPercent: number): string {
  return `${IDLE_CONTRADICTION_PREFIX} (${Math.round(previousUsedPercent)}% used, reset not yet due)`;
}

/** True for a failed observation's reason that reflects Headroom's own
 * heuristic rather than a vendor-reported failure -- used to score the
 * resulting source_failed/source_recovered event as `inferred` at reduced
 * confidence instead of `vendor_reported`. Recognizes both the retired
 * AVAILABILITY_ONLY_REASON (for events already on disk) and the current
 * idle-contradiction reason. */
export function isInferredFailureReason(reason: string | null | undefined): boolean {
  return reason === AVAILABILITY_ONLY_REASON || (reason?.startsWith(IDLE_CONTRADICTION_PREFIX) ?? false);
}

/** Flag (never fail) a detectPlaceholder-shaped snapshot before it reaches
 * the append-only store: the vendor's quantity, resets_at and freshness stay
 * exactly as reported, downgraded to `estimated` truth at half confidence
 * with IDLE_WINDOW_REASON, so a caller shows the number with a doubt marker
 * instead of discarding it. The store (see HeadroomStore.insert) is the only
 * place that ever escalates this to a real `failed` reading, and only when
 * its own history contradicts it. */
export function normalizeObservations(observations: Observation[]): Observation[] {
  const byPrincipal = new Map<string, Observation[]>();
  for (const observation of observations) byPrincipal.set(observation.principal_id, [...(byPrincipal.get(observation.principal_id) ?? []), observation]);
  const placeholders = new Set([...byPrincipal.entries()]
    .filter(([, principalObservations]) => detectPlaceholder(principalObservations))
    .map(([principal]) => principal));
  return observations.map((observation) => placeholders.has(observation.principal_id)
    && observation.window?.kind !== "state" && observation.freshness !== "not_enforced"
    ? { ...observation, truth: "estimated", confidence: Math.round(observation.confidence * 0.5 * 100) / 100, reason: IDLE_WINDOW_REASON }
    : observation);
}

/** The upstream CLI adapter's v0.2 projection. It intentionally has the same meter IDs as native. */
export function observationsFromReading(reading: Reading): Observation[] {
  const windows = Object.values(reading.windows).flatMap((window) => window ? [window] : []);
  const observations: Observation[] = windows.map((window) => ({
    principal_id: reading.account,
    meter_id: `${reading.account}:${reading.pool}`,
    window: { kind: window.resets_at ? "fixed" : "rolling", minutes: window.window_minutes, enforcement: "hard" },
    quantity: { used: window.used_percent, limit: 100, remaining: Math.max(0, 100 - window.used_percent), unit: "percent" },
    resets_at: window.resets_at,
    observed_at: reading.sampled_at,
    fetched_at: reading.sampled_at,
    source: reading.source,
    truth: reading.truth,
    freshness: "fresh",
    confidence: reading.truth === "official" ? 1 : 0.7,
    adapter_version: "fallback",
    upstream_schema_version: "v0.56.4",
    metadata: { plan: reading.plan, free_resets_available: reading.extras.free_resets_available },
  }));
  if (reading.pool === "main" && !reading.windows.five_hour) {
    observations.push({
      principal_id: reading.account, meter_id: `${reading.account}:${reading.pool}`,
      window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: null, resets_at: null,
      observed_at: reading.sampled_at, fetched_at: reading.sampled_at, source: reading.source, truth: reading.truth,
      freshness: "not_enforced", confidence: 1, adapter_version: "fallback", upstream_schema_version: "v0.56.4",
      reason: "vendor returned no 5-hour window", metadata: { plan: reading.plan, free_resets_available: reading.extras.free_resets_available },
    });
  }
  if (reading.pool === "main" && !reading.windows.weekly) {
    observations.push({
      principal_id: reading.account, meter_id: `${reading.account}:${reading.pool}`,
      window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null,
      observed_at: reading.sampled_at, fetched_at: reading.sampled_at, source: reading.source, truth: "estimated",
      freshness: "failed", confidence: 0, adapter_version: "fallback", upstream_schema_version: "v0.56.4",
      reason: "vendor returned no weekly window", metadata: { plan: reading.plan, free_resets_available: reading.extras.free_resets_available },
    });
  }
  return normalizeObservations(observations);
}
