// Types for the live overrun warning (#146 phase 1b).
//
// The unit is percent of one vendor window, the only number vendors expose.
// The monitor watches one window of the lease's meter and works out how much
// of it the lease has used since it started. It warns; it never kills.

export const MINUTE_MS = 60_000;

/** One poll of the watched window. `fresh: false` covers stale and failed polls. */
export interface OverrunReading {
  at: number;
  /** Percent used of the window, or null when the poll carried no number. */
  used: number | null;
  fresh: boolean;
  /** When the window resets, if the vendor said. Used to tell a reset from noise. */
  resetsAt?: number | null;
}

export interface OverrunLease {
  leaseId: string;
  startedAt: number;
  /** The lease's reservation in percent (expected_percent), or null when it had none. */
  reservationPercent: number | null;
  /** p75 of what finished leases of this action class spent, for the optional class rule. */
  classP75?: number | null;
  /** How many finished leases the p75 rests on. */
  classSamples?: number;
}

export interface OverrunConfig {
  /** Reading resolution in percent points; 1 for vendors that report whole percents. */
  resolution: number;
  /** Rule (a): warn when the lower bound of spend exceeds max(reservationMultiple x reservation, floorPoints). */
  reservationMultiple: number;
  floorPoints: number;
  /** Rule (b): warn when spend + horizonMinutes x rate exceeds ratePoints for consecutivePolls polls in a row. */
  rateWindowMinutes: number;
  horizonMinutes: number;
  ratePoints: number;
  consecutivePolls: number;
  /** The rate needs at least this much time between its two readings, and no more than maxRateSpanMinutes. */
  minRateSpanMinutes: number;
  maxRateSpanMinutes: number;
  /** Fail closed: the newest reading must be fresh and no older than this. */
  maxReadingAgeMinutes: number;
  /** Fail closed: the spend baseline must be a fresh reading no older than this before the lease started. */
  maxBaselineAgeMinutes: number;
  /** A drop counts as a window reset only when resets_at moved forward by at least this much. */
  resetShiftMinutes: number;
  /** Rule (c), optional: spend lower bound above classMultiple x class p75 while the window has under remainingMultiple x spend left. */
  classRule: boolean;
  classMultiple: number;
  remainingMultiple: number;
  classMinSamples: number;
}

export const DEFAULT_OVERRUN_CONFIG: OverrunConfig = {
  resolution: 1,
  reservationMultiple: 2,
  floorPoints: 2,
  rateWindowMinutes: 5,
  horizonMinutes: 5,
  ratePoints: 5,
  consecutivePolls: 2,
  minRateSpanMinutes: 2,
  maxRateSpanMinutes: 15,
  maxReadingAgeMinutes: 15,
  maxBaselineAgeMinutes: 15,
  resetShiftMinutes: 10,
  classRule: true,
  classMultiple: 2,
  remainingMultiple: 3,
  classMinSamples: 5,
};

export type OverrunRule = "spend" | "rate" | "class";

export interface OverrunWarning {
  rule: OverrunRule;
  leaseId: string;
  /** Time of the reading the warning rests on. */
  at: number;
  /** Human-readable, with the evidence. */
  message: string;
  evidence: {
    spent: number;
    spentLower: number;
    used: number;
    ratePerMinute: number | null;
    threshold: number;
  };
}

/** Per-lease memory. Plain data, so a caller can persist it between polls. */
export interface OverrunState {
  leaseId: string;
  fired: OverrunRule[];
  /** Time of the newest reading already counted toward the rate streak. */
  lastPollAt: number | null;
  rateStreak: number;
}

export interface OverrunResult {
  /** "unknown" when the readings cannot support a number; then no warning is issued. */
  status: "ok" | "warned" | "unknown";
  /** Why the result is UNKNOWN, otherwise null. */
  reason: string | null;
  spent: number | null;
  spentLower: number | null;
  ratePerMinute: number | null;
  used: number | null;
  /** Warnings first issued by this call. Empty on a repeat call with the same readings. */
  newWarnings: OverrunWarning[];
  state: OverrunState;
}
