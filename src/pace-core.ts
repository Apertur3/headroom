// GENERATED from packages/policy/src/core.ts by scripts/sync-pace-core.mjs; do not edit
/** Full precision: minutes below an hour, hours+minutes below two days, days+hours beyond that. */
export function formatResetsIn(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export interface PaceCoreInput {
  used: number;
  limit: number;
  windowMinutes: number;
  resetsAt: string | null | undefined;
  fetchedAtMs: number;
  emptyInSeconds: number | null | undefined;
  burnPercentPerHour: number | null | undefined;
  stalenessMinutes: number;
  freezeReservePct: number;
  graceFraction: number;
}

export function paceCore(
  input: PaceCoreInput,
  now: Date,
  staleReason: (ageMinutes: number) => string = (ageMinutes) => `stale ${ageMinutes}m`,
): { state: "HARVEST" | "NORMAL" | "CONSERVE" | "FREEZE" | "UNKNOWN"; reason: string } {
  const { fetchedAtMs: fetched, used } = input;
  if (!Number.isFinite(fetched)) return { state: "UNKNOWN", reason: "invalid fetch time" };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - fetched) / 60_000));
  if (now.getTime() - fetched > input.stalenessMinutes * 60_000) return { state: "UNKNOWN", reason: staleReason(ageMinutes) };
  if (used >= 100 - input.freezeReservePct) return { state: "FREEZE", reason: "reserve reached" };
  const reset = input.resetsAt ? new Date(input.resetsAt).getTime() : Number.NaN;
  if (!Number.isFinite(reset)) return { state: "UNKNOWN", reason: "reset unknown" };
  const duration = input.windowMinutes * 60_000;
  // For fixed windows this is exactly resets_at - duration; rolling windows use
  // the same inferred start, which is the only vendor-independent anchor we have.
  const start = reset - duration;
  const elapsedFraction = Math.min(1, Math.max(0, (now.getTime() - start) / duration));
  // A window burning fast enough to run dry before its own reset is CONSERVE
  // regardless of the straight-line surplus below: the straight-line rule
  // only looks at usage-to-date against elapsed time, so it can still read
  // NORMAL or even HARVEST one poll before a fast, recent burn empties the
  // window early. Grace still holds off this projection unless the window
  // would stall within 30 minutes -- an opening burst that is about to run
  // out right away is not what grace exists to protect.
  const resetsInSeconds = Math.max(0, (reset - now.getTime()) / 1000);
  const emptyIn = input.emptyInSeconds ?? null;
  const projectingStall = emptyIn !== null && emptyIn < resetsInSeconds;
  const inGrace = elapsedFraction < input.graceFraction;
  if (inGrace && !(projectingStall && emptyIn! < 1800)) return { state: "NORMAL", reason: "grace period" };
  if (projectingStall) {
    const burn = input.burnPercentPerHour ?? 0;
    return { state: "CONSERVE", reason: `burning ${Math.round(burn)}%/h, empty in ${formatResetsIn(emptyIn!)}, reset in ${formatResetsIn(resetsInSeconds)}` };
  }
  const surplus = (1 - used / input.limit) - (1 - elapsedFraction);
  if (surplus > 0.10) return { state: "HARVEST", reason: "ahead of pace" };
  if (surplus < -0.10) return { state: "CONSERVE", reason: "behind pace" };
  return { state: "NORMAL", reason: "on pace" };
}
