// The live overrun warning (#146 phase 1b). Pure: give it the lease, the
// watched window's readings and the state from the previous call; it returns
// the new state and any warning issued for the first time.
//
// Rules, each fires at most once per lease:
//   spend  lower bound of spend (spend minus the reading resolution) exceeds
//          max(2 x reservation, 2 points).
//   rate   spend + 5 minutes x the last 5 minutes' rate exceeds 5 points on
//          two consecutive polls. A continued-rate warning, not a forecast
//          of the job's final size.
//   class  (optional) spend lower bound above 2 x the action class p75 while
//          the window has under 3 x spend left.
// Fail closed: a stale, failed or missing reading, or no baseline before the
// lease started, gives status UNKNOWN and no warning.

import { recentRate, spendPath } from "./spend.js";
import { DEFAULT_OVERRUN_CONFIG, type OverrunConfig, type OverrunLease, type OverrunReading, type OverrunResult, type OverrunRule, type OverrunState, type OverrunWarning } from "./types.js";

export function initialOverrunState(leaseId: string): OverrunState {
  return { leaseId, fired: [], lastPollAt: null, rateStreak: 0 };
}

function fmt(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function evaluateOverrun(
  lease: OverrunLease,
  readings: readonly OverrunReading[],
  now: number,
  previous: OverrunState | null = null,
  config: OverrunConfig = DEFAULT_OVERRUN_CONFIG,
): OverrunResult {
  const prior = previous && previous.leaseId === lease.leaseId ? previous : initialOverrunState(lease.leaseId);
  const state: OverrunState = { leaseId: lease.leaseId, fired: [...prior.fired], lastPollAt: prior.lastPollAt, rateStreak: prior.rateStreak };

  const path = spendPath(readings, lease.startedAt, now, config);
  if (!path.ok) {
    // A gap breaks the consecutive-poll streak; nothing else changes.
    state.rateStreak = 0;
    return { status: "unknown", reason: `UNKNOWN: ${path.reason}`, spent: null, spentLower: null, ratePerMinute: null, used: null, newWarnings: [], state };
  }

  const latest = path.points[path.points.length - 1];
  const spent = latest.spent;
  const spentLower = Math.max(0, spent - config.resolution);
  const rate = recentRate(path.points, config);
  const newWarnings: OverrunWarning[] = [];
  const evidenceBase = { spent, spentLower, used: latest.used, ratePerMinute: rate };
  const fire = (rule: OverrunRule, threshold: number, message: string) => {
    if (state.fired.includes(rule)) return;
    state.fired.push(rule);
    newWarnings.push({ rule, leaseId: lease.leaseId, at: latest.at, message, evidence: { ...evidenceBase, threshold } });
  };

  // Rule (a): spend against the reservation.
  const reservation = lease.reservationPercent;
  const spendThreshold = Math.max(config.reservationMultiple * (reservation ?? 0), config.floorPoints);
  if (spentLower > spendThreshold) {
    const against = reservation == null
      ? `no reservation, so the floor of ${fmt(config.floorPoints)} points applies`
      : `reservation ${fmt(reservation)}, threshold max(${fmt(config.reservationMultiple)} x ${fmt(reservation)}, ${fmt(config.floorPoints)}) = ${fmt(spendThreshold)}`;
    fire("spend", spendThreshold, `Overrun: lease ${lease.leaseId} has spent at least ${fmt(spentLower)} points of this window (reading says ${fmt(spent)}, resolution ${fmt(config.resolution)}); ${against}.`);
  }

  // Rule (b): continued rate, counted once per new poll.
  const newPoll = state.lastPollAt === null || latest.at > state.lastPollAt;
  if (newPoll && latest.at > lease.startedAt) {
    state.lastPollAt = latest.at;
    const continued = rate === null ? null : spent + config.horizonMinutes * rate;
    state.rateStreak = continued !== null && continued > config.ratePoints ? state.rateStreak + 1 : 0;
    if (continued !== null && state.rateStreak >= config.consecutivePolls) {
      fire("rate", config.ratePoints, `Continued-rate warning (not a forecast of the final size): lease ${lease.leaseId} has spent ${fmt(spent)} points; at the last ${fmt(config.rateWindowMinutes)} minutes' rate of ${fmt(rate as number)} points per minute it would pass ${fmt(config.ratePoints)} points within ${fmt(config.horizonMinutes)} minutes (${fmt(continued)}), on ${state.rateStreak} polls in a row.`);
    }
  }

  // Rule (c), optional: well past the class's usual size, near the limit.
  if (config.classRule && lease.classP75 != null && (lease.classSamples ?? 0) >= config.classMinSamples && spent > 0) {
    const classThreshold = config.classMultiple * lease.classP75;
    const left = 100 - latest.used;
    if (spentLower > classThreshold && left < config.remainingMultiple * spent) {
      fire("class", classThreshold, `Overrun: lease ${lease.leaseId} has spent at least ${fmt(spentLower)} points, above ${fmt(config.classMultiple)} x its class p75 of ${fmt(lease.classP75)} (from ${lease.classSamples} leases), and the window has only ${fmt(left)} points left, under ${fmt(config.remainingMultiple)} x its spend.`);
    }
  }

  return {
    status: state.fired.length ? "warned" : "ok",
    reason: null,
    spent,
    spentLower,
    ratePerMinute: rate,
    used: latest.used,
    newWarnings,
    state,
  };
}
