/** Shared facts about reset credits. They are deliberately separate from
 * policy: credits are informational until `plan` turns a reported reset into
 * an advisory capacity calculation, and never open a normal `can` decision. */
import { freshnessGate } from "./policy.js";
import type { Observation } from "./types.js";

export type BankedCreditSource = "vendor" | "manual";

export function isCreditsObservation(observation: Pick<Observation, "window" | "quantity">): boolean {
  return observation.window?.kind === "count" && observation.quantity?.unit === "credits";
}

/** A money balance can have the same count/credits shape as a banked reset.
 * Only the reset-specific vendor field or an operator's manual entry makes
 * that count eligible for reset planning. */
export function isBankedResetObservation(observation: Pick<Observation, "window" | "quantity" | "source" | "metadata">): boolean {
  return isCreditsObservation(observation) && (observation.source === "manual" || observation.metadata?.manual === true || typeof observation.metadata?.free_resets_available === "number");
}

/** Manual entries remain an operator fact until they lapse, are cleared, or
 * are superseded. Vendor reset counts, by contrast, are capacity only while
 * a current, unheld vendor observation supports them. */
export function isCurrentBankedResetObservation(observation: Observation | undefined, staleMinutes: number, now = new Date()): observation is Observation {
  if (!observation || !isBankedResetObservation(observation)) return false;
  if (observation.source === "manual") return true;
  // Unlike a quota window, a `not_enforced` count does not attest to a
  // spendable reset balance. Vendor banked capacity must be an actual fresh
  // observation before the ordinary age gate can admit it.
  if (observation.freshness !== "fresh") return false;
  if (observation.metadata?.vendor_window_held || observation.metadata?.vendor_inconsistent) return false;
  return freshnessGate(observation, staleMinutes, now).ok;
}

export function creditSource(observation: Pick<Observation, "source">): BankedCreditSource {
  return observation.source === "manual" ? "manual" : "vendor";
}

/** An expiry is a fact recorded by the vendor or operator. It is never
 * rewritten after the fact; readers simply stop treating its count as usable. */
export function creditsLapsed(observation: Pick<Observation, "resets_at">, now = new Date()): boolean {
  const expires = observation.resets_at ? Date.parse(observation.resets_at) : Number.NaN;
  return Number.isFinite(expires) && now.getTime() >= expires;
}

export function usableCredits(observation: Pick<Observation, "quantity" | "resets_at"> | undefined, now = new Date()): number {
  if (!observation || creditsLapsed(observation, now)) return 0;
  return Math.max(0, observation.quantity?.unit === "credits" ? observation.quantity.remaining ?? 0 : 0);
}

/** Date-only values are UTC calendar dates at midnight. Keeping them in UTC
 * makes the stored instant, expiry boundary, and status day agree everywhere. */
export function parseCreditExpiry(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return parsed.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  throw new Error("--expires must be YYYY-MM-DD or an ISO instant");
}

/** Status JSON is enriched at read time, just like reset countdowns. The raw
 * observation remains the audit record and is not mutated when it lapses. */
export function withCreditsLapsed<T extends Observation>(observations: T[], now = new Date()): T[] {
  return observations.map((observation) => isCreditsObservation(observation) && creditsLapsed(observation, now)
    ? { ...observation, credits_lapsed: true }
    : observation);
}
