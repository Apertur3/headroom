// Scoring for probabilistic and interval forecasts.

export interface Scored {
  p: number;
  /** 1 when the event happened, else 0. */
  y: 0 | 1;
}

export function brierScore(items: readonly Scored[]): number | null {
  if (items.length === 0) return null;
  return items.reduce((sum, { p, y }) => sum + (p - y) ** 2, 0) / items.length;
}

/** 1 - model/reference: positive when the model is better. Null when the reference is 0 or missing. */
export function skill(model: number | null, reference: number | null): number | null {
  if (model === null || reference === null || reference === 0) return null;
  return 1 - model / reference;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number | null;
  observed: number | null;
}

export function reliabilityTable(items: readonly Scored[], edges: readonly number[] = [0, 0.05, 0.2, 0.5, 0.8, 1]): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const last = i === edges.length - 2;
    const inBin = items.filter(({ p }) => p >= lo && (last ? p <= hi : p < hi));
    const n = inBin.length;
    bins.push({
      lo,
      hi,
      n,
      meanP: n ? inBin.reduce((s, x) => s + x.p, 0) / n : null,
      observed: n ? inBin.reduce((s, x) => s + x.y, 0) / n : null,
    });
  }
  return bins;
}

export interface IntervalCase {
  lo: number;
  hi: number;
  actual: number;
}

export function intervalStats(cases: readonly IntervalCase[]): { n: number; coverage: number | null; meanWidth: number | null } {
  if (cases.length === 0) return { n: 0, coverage: null, meanWidth: null };
  const eps = 1e-9;
  const inside = cases.filter((c) => c.actual >= c.lo - eps && c.actual <= c.hi + eps).length;
  return { n: cases.length, coverage: inside / cases.length, meanWidth: cases.reduce((s, c) => s + (c.hi - c.lo), 0) / cases.length };
}

export interface DecisionStats {
  n: number;
  events: number;
  nonEvents: number;
  /** Said go (P < threshold) and the meter hit. */
  falseGo: number;
  /** Said stop (P >= threshold) and the meter did not hit. */
  blockedUseful: number;
  falseGoRate: number | null;
  blockedUsefulRate: number | null;
}

export function decisionStats(items: readonly Scored[], threshold = 0.5): DecisionStats {
  const events = items.filter((x) => x.y === 1).length;
  const nonEvents = items.length - events;
  const falseGo = items.filter((x) => x.y === 1 && x.p < threshold).length;
  const blockedUseful = items.filter((x) => x.y === 0 && x.p >= threshold).length;
  return {
    n: items.length,
    events,
    nonEvents,
    falseGo,
    blockedUseful,
    falseGoRate: events ? falseGo / events : null,
    blockedUsefulRate: nonEvents ? blockedUseful / nonEvents : null,
  };
}

export function meanAbsoluteError(pairs: readonly { predicted: number; actual: number }[]): number | null {
  if (pairs.length === 0) return null;
  return pairs.reduce((s, x) => s + Math.abs(x.predicted - x.actual), 0) / pairs.length;
}
