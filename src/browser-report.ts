import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gatherDashboard, type DashboardModel } from "./dashboard.js";
import { paceDecision, reserveFor } from "./policy.js";
import { formatResetsIn, resetsIn } from "./resets.js";
import { redact, writeFileAtomic } from "./security.js";
import { formatReset, label, planDowngradeLine } from "./status-view.js";
import { type HeadroomEvent, type Lease, type Observation, type PaceState } from "./types.js";

export const IDLE_WINDOW_REASON = "vendor reports an idle window; reset equals fetch time plus window length, so this may be a placeholder";

/** Safely escape strings for HTML text and attributes to prevent XSS. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Safely serialize JSON into an inline <script> tag.
 * Replaces <, >, &, and Unicode line/paragraph separators so the script
 * tag cannot be prematurely terminated (e.g. by </script> or <!--).
 */
export function safeJsonSerialize(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Compare two vendor reset timestamps with 60-second tolerance.
 * Vendors often serialize the same scheduled instant with millisecond clock jitter.
 */
export function sameReset(
  left: string | number | null | undefined,
  right: string | number | null | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftTime = typeof left === "number" ? left : Date.parse(left);
  const rightTime = typeof right === "number" ? right : Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 60_000;
}

/** Concise allowlisted summary for failure reasons avoiding private path leaks. */
export function sanitizeFailureReason(reason: string | null | undefined): string {
  if (!reason) return "Reading unavailable; run headroom doctor";
  const clean = redact(reason);
  if (/grant|keychain|credential/i.test(clean)) return "Credential access required";
  if (/stale/i.test(clean)) return "Reading is stale";
  if (/unresponsive|timeout|hang/i.test(clean)) return "Provider request timed out";
  if (/401|403|unauthorized|forbidden/i.test(clean)) return "Authentication failed";
  if (/429|rate limit/i.test(clean)) return "Rate limit backoff";
  if (/inconsistent/i.test(clean)) return "Vendor readings inconsistent, holding";
  if (/held|unconfirmed/i.test(clean)) return "New window unconfirmed, holding";
  if (/idle/i.test(clean)) return "Idle window placeholder";
  if (/not enforced/i.test(clean)) return "Limit not enforced";
  if (/network|econnrefused|fetch failed/i.test(clean)) return "Connection failed";
  if (/cached read failed/i.test(clean)) return "Cached read unavailable";
  return "Reading unavailable; run headroom doctor";
}

/**
 * Format a percent value for human display: max 1 decimal, strip .0 (e.g. 92.4, 20).
 * Prevents floating point garbage like 92.38459999999999%.
 */
export function formatHumanPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
}

export interface ProcessedPoint {
  at: number;
  observed_at: string;
  resets_at: string | null;
  reset: number;
  used: number;
  remaining: number;
  freshness: Observation["freshness"];
  confidence: number;
  invalid?: boolean;
}

export interface ProcessedWindow {
  principal_id: string;
  meter_id: string;
  meter_name: string;
  window_label: string;
  window_kind: "rolling" | "fixed" | "count" | "state";
  window_minutes: number | null;
  enforcement: "hard" | "soft";
  decision_state: PaceState;
  decision_reason: string;
  freshness: Observation["freshness"];
  quantity: Observation["quantity"];
  used_percent: number | null;
  remaining_percent: number | null;
  resets_at: string | null;
  observed_at: string;
  fetched_at: string;
  burn_rate: number | null;
  sustainable_rate: number | null;
  reserve_percent: number;
  is_local: boolean;
  is_credits: boolean;
  is_not_enforced: boolean;
  is_unknown: boolean;
  last_known?: Observation["last_known"];
  current_points: ProcessedPoint[];
  current_segments: ProcessedPoint[][];
  insufficient_data: boolean;
  insufficient_data_reason?: string;
  events: HeadroomEvent[];
  metadata?: Observation["metadata"];
  raw_reason?: string | null;
}

export interface BrowserReportOptions {
  generatedAt?: Date;
}

export interface WriteBrowserReportOptions {
  force?: boolean;
  cwd?: string;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function formatClock(date: string | number | Date): string {
  const value = new Date(date);
  return Number.isFinite(value.getTime())
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value)
    : "?";
}

function formatShortDate(date: string | number | Date): string {
  const value = new Date(date);
  return Number.isFinite(value.getTime())
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(value)
    : "?";
}

function formatReportDateTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "?";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** Determine whether a reading qualifies as a live, valid quota sample. */
export function isLiveValidSample(reading: Observation): boolean {
  if (reading.freshness !== "fresh") return false;
  if (reading.quantity?.unit !== "percent") return false;
  if (reading.quantity.used === null || !Number.isFinite(reading.quantity.used)) return false;
  if (reading.metadata?.vendor_inconsistent) return false;
  if (reading.metadata?.vendor_window_held) return false;
  if (reading.metadata?.exhausted_ignored) return false;
  if (reading.truth === "estimated" && (reading.reason === IDLE_WINDOW_REASON || (reading.reason && reading.reason.includes("idle window")))) return false;
  return true;
}

/**
 * Split points into continuous polyline segments.
 * Splits on used decreases (quota resets/corrections), reset mismatches,
 * time gaps exceeding 15 minutes, or invalid/failed/held barrier observations.
 */
export function splitSegments(points: ProcessedPoint[], maxGapMs = 15 * 60_000): ProcessedPoint[][] {
  if (!points.length) return [];
  const segments: ProcessedPoint[][] = [];
  let currentSegment: ProcessedPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];

    if (curr.invalid) {
      if (currentSegment.length) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      continue;
    }

    if (currentSegment.length === 0) {
      currentSegment.push(curr);
      continue;
    }

    const prev = currentSegment[currentSegment.length - 1];
    const gap = curr.at - prev.at;

    const usedDecreased = curr.used < prev.used;
    const resetMismatch = !sameReset(curr.reset, prev.reset);
    const gapExceeded = gap > maxGapMs || gap < 0;

    if (usedDecreased || resetMismatch || gapExceeded) {
      segments.push(currentSegment);
      currentSegment = [curr];
    } else {
      currentSegment.push(curr);
    }
  }
  if (currentSegment.length) {
    segments.push(currentSegment);
  }
  return segments;
}

/** Extract and process points for one meter window from history and live state. */
export function processWindow(row: Observation, model: DashboardModel, now: Date): ProcessedWindow {
  const is_local = row.window?.kind === "state" || row.metadata?.state !== undefined;
  const is_credits = row.quantity?.unit === "credits" || row.window?.kind === "count";
  const decision = paceDecision(row, model.policy, now);

  const is_held_or_untrustworthy = Boolean(
    row.metadata?.vendor_window_held ||
    row.metadata?.vendor_inconsistent ||
    row.metadata?.exhausted_ignored ||
    (row.truth === "estimated" && (row.reason === IDLE_WINDOW_REASON || (row.reason && row.reason.includes("idle window"))))
  );

  const is_not_enforced = decision.state === "NOT_ENFORCED" || row.freshness === "not_enforced";
  const is_unknown = decision.state === "UNKNOWN" || row.freshness === "failed" || row.freshness === "stale" || is_held_or_untrustworthy;
  const reserve_percent = (row.window?.enforcement ?? "hard") === "hard"
    ? Math.max(model.policy.freeze_reserve_pct, reserveFor(model.policy.reserve, row.meter_id))
    : reserveFor(model.policy.reserve, row.meter_id);

  const meter_name = row.meter_id.startsWith(`${row.principal_id}:`)
    ? row.meter_id.slice(row.principal_id.length + 1)
    : row.meter_id;

  const window_label = label(row);
  const window_kind = row.window?.kind ?? "rolling";
  const window_minutes = row.window?.minutes ?? null;
  const enforcement = row.window?.enforcement ?? "hard";

  const rawPoints = new Map<number, ProcessedPoint>();
  const historyReadings = [...(model.history?.[row.meter_id] ?? []), row];

  const currentResetMs = row.resets_at ? Date.parse(row.resets_at) : Number.NaN;
  const windowStartMs = Number.isFinite(currentResetMs) && window_minutes
    ? currentResetMs - window_minutes * 60_000
    : Number.NaN;

  for (const item of historyReadings) {
    if (item.principal_id !== row.principal_id || item.meter_id !== row.meter_id) continue;

    const at = Date.parse(item.observed_at);
    if (!Number.isFinite(at) || at > now.getTime()) continue;
    if (Number.isFinite(windowStartMs) && at < windowStartMs) continue;

    const isLive = isLiveValidSample(item);

    if (isLive) {
      if (item.window?.minutes !== row.window?.minutes) continue;
      if (item.window?.enforcement !== "hard") continue;

      if (Number.isFinite(currentResetMs)) {
        if (item.resets_at && !sameReset(item.resets_at, currentResetMs)) continue;
      }

      const reset = Number.isFinite(currentResetMs) ? currentResetMs : (Date.parse(item.resets_at ?? "") || 0);
      const used = clamp(item.quantity!.used);
      const remaining = clamp(100 - used);

      rawPoints.set(at, {
        at,
        observed_at: item.observed_at,
        resets_at: item.resets_at,
        reset,
        used,
        remaining,
        freshness: item.freshness,
        confidence: item.confidence,
        invalid: false,
      });
    } else {
      const isMatchingWindow = item.window?.minutes === row.window?.minutes;
      const isWindowless = item.window == null || item.window.minutes == null;
      if (!isMatchingWindow && !isWindowless) continue;

      if (Number.isFinite(currentResetMs)) {
        if (item.resets_at && !sameReset(item.resets_at, currentResetMs)) continue;
      }

      const reset = Number.isFinite(currentResetMs) ? currentResetMs : (Date.parse(item.resets_at ?? "") || 0);

      rawPoints.set(at, {
        at,
        observed_at: item.observed_at,
        resets_at: item.resets_at,
        reset,
        used: 0,
        remaining: 0,
        freshness: item.freshness,
        confidence: item.confidence,
        invalid: true,
      });
    }
  }

  const allTimelinePoints = [...rawPoints.values()].sort((a, b) => a.at - b.at);
  const currentPoints = allTimelinePoints.filter((p) => !p.invalid);

  const insufficient_data = currentPoints.length < 2;
  let insufficient_data_reason: string | undefined;

  if (insufficient_data) {
    if (currentPoints.length === 0) {
      insufficient_data_reason = "No recorded readings in this period yet.";
    } else {
      insufficient_data_reason = `Collecting current period: 1 observation recorded so far (${formatHumanPercent(currentPoints[0].remaining)}% remaining). Burndown curve requires at least 2 readings.`;
    }
  }

  const current_segments = splitSegments(allTimelinePoints, 15 * 60_000);

  const resetEvents = (model.graphEvents ?? model.events ?? []).filter((event) => {
    if (event.corrected_by) return false;
    if (event.kind !== "reset_seen" && !event.kind.startsWith("free_reset_")) return false;
    if (event.metadata?.window_minutes != null && event.metadata.window_minutes !== window_minutes) return false;
    return event.meter_id ? event.meter_id === row.meter_id : event.principal_id === row.principal_id;
  });

  const used_percent = !is_unknown && row.quantity?.unit === "percent" && Number.isFinite(row.quantity.used)
    ? clamp(row.quantity.used)
    : null;

  const remaining_percent = used_percent !== null ? clamp(100 - used_percent) : null;

  return {
    principal_id: row.principal_id,
    meter_id: row.meter_id,
    meter_name,
    window_label,
    window_kind,
    window_minutes,
    enforcement,
    decision_state: is_held_or_untrustworthy ? "UNKNOWN" : decision.state,
    decision_reason: is_held_or_untrustworthy
      ? (row.metadata?.vendor_window_held ? "New window unconfirmed, holding" : row.metadata?.vendor_inconsistent ? "Vendor readings inconsistent, holding" : "Reading untrustworthy, holding")
      : decision.reason,
    freshness: row.freshness,
    quantity: row.quantity,
    used_percent,
    remaining_percent,
    resets_at: row.resets_at,
    observed_at: row.observed_at,
    fetched_at: row.fetched_at,
    burn_rate: row.burn_percent_per_hour ?? null,
    sustainable_rate: row.sustainable_percent_per_hour ?? null,
    reserve_percent,
    is_local,
    is_credits,
    is_not_enforced,
    is_unknown,
    last_known: row.last_known,
    current_points: currentPoints,
    current_segments,
    insufficient_data,
    insufficient_data_reason,
    events: resetEvents,
    metadata: row.metadata,
    raw_reason: row.reason,
  };
}

const STATE_PRIORITY: Record<PaceState, number> = {
  FREEZE: 5,
  DOWN: 5,
  CONSERVE: 4,
  BUSY: 4,
  NORMAL: 3,
  HARVEST: 2,
  UP: 2,
  UNKNOWN: 1,
  NOT_ENFORCED: 0,
};

function tightestPaceState(states: PaceState[]): PaceState {
  if (!states.length) return "UNKNOWN";
  return states.reduce((prev, curr) => (STATE_PRIORITY[curr] > STATE_PRIORITY[prev] ? curr : prev), states[0]);
}

/**
 * Determine the default selected meter and window for the detail panel.
 * Default selects trustworthy CURRENT-period >= 2 points, preferring 5h, else fresh >= 1, else first.
 */
export function determineDefaultSelection(
  processedWindows: ProcessedWindow[]
): { meter_id: string; window_minutes: number | null } | null {
  const subscriptionWindows = processedWindows.filter((pw) => !pw.is_local && !pw.is_credits);
  if (!subscriptionWindows.length) {
    if (!processedWindows.length) return null;
    return { meter_id: processedWindows[0].meter_id, window_minutes: processedWindows[0].window_minutes };
  }

  // 1. Trustworthy CURRENT-period >= 2 points, prefer 5h
  const candidatesWith2Points = subscriptionWindows.filter(
    (pw) => !pw.is_unknown && pw.current_points.length >= 2
  );
  if (candidatesWith2Points.length) {
    const pref5h = candidatesWith2Points.find((pw) => pw.window_minutes === 300);
    if (pref5h) return { meter_id: pref5h.meter_id, window_minutes: pref5h.window_minutes };
    const prefWeekly = candidatesWith2Points.find((pw) => pw.window_minutes === 10080);
    if (prefWeekly) return { meter_id: prefWeekly.meter_id, window_minutes: prefWeekly.window_minutes };
    return { meter_id: candidatesWith2Points[0].meter_id, window_minutes: candidatesWith2Points[0].window_minutes };
  }

  // 2. Fresh >= 1 point, prefer 5h
  const candidatesWith1Point = subscriptionWindows.filter(
    (pw) => !pw.is_unknown && pw.freshness === "fresh" && pw.current_points.length >= 1
  );
  if (candidatesWith1Point.length) {
    const pref5h = candidatesWith1Point.find((pw) => pw.window_minutes === 300);
    if (pref5h) return { meter_id: pref5h.meter_id, window_minutes: pref5h.window_minutes };
    return { meter_id: candidatesWith1Point[0].meter_id, window_minutes: candidatesWith1Point[0].window_minutes };
  }

  // 3. First subscription window
  return { meter_id: subscriptionWindows[0].meter_id, window_minutes: subscriptionWindows[0].window_minutes };
}

/** Render SVG for the remaining-capacity chart. */
export function renderRemainingCapacityChartSvg(pw: ProcessedWindow, now: Date): string {
  const points = pw.current_points;
  const segments = pw.current_segments;
  const resetMs = Date.parse(pw.resets_at ?? "");

  const svgWidth = 800;
  const svgHeight = 320;
  const margin = { top: 30, right: 40, bottom: 40, left: 60 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;

  const startMs = pw.window_minutes && Number.isFinite(resetMs)
    ? resetMs - pw.window_minutes * 60_000
    : (points[0]?.at ?? now.getTime() - 3_600_000);

  const duration = Number.isFinite(resetMs) && resetMs > startMs ? resetMs - startMs : 3_600_000;

  const xForTime = (time: number): number => {
    const fraction = clamp((time - startMs) / duration, 0, 1);
    return margin.left + fraction * plotWidth;
  };

  const yForRemaining = (rem: number): number => {
    const fraction = clamp(rem / 100, 0, 1);
    return margin.top + (1 - fraction) * plotHeight;
  };

  const lines: string[] = [];
  lines.push(`<svg viewBox="0 0 ${svgWidth} ${svgHeight}" class="chart-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Remaining capacity burndown chart for ${escapeHtml(pw.meter_id)}">`);
  lines.push(`  <rect width="100%" height="100%" fill="transparent" />`);

  // Y-axis label explicit: "Remaining capacity"
  lines.push(`  <text x="14" y="${margin.top - 12}" class="axis-title">Remaining capacity (%)</text>`);

  // Y-axis grid lines and labels (100%, 75%, 50%, 25%, 0%)
  const yTicks = [100, 75, 50, 25, 0];
  for (const rem of yTicks) {
    const y = yForRemaining(rem);
    lines.push(`  <line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${(margin.left + plotWidth).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--grid-line)" stroke-width="1" />`);
    lines.push(`  <text x="${(margin.left - 10).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis-label">${rem}%</text>`);
  }

  // Reserve floor zone and line (if configured)
  if (pw.reserve_percent > 0) {
    const yRes = yForRemaining(pw.reserve_percent);
    const yZero = yForRemaining(0);
    const h = yZero - yRes;
    lines.push(`  <rect x="${margin.left}" y="${yRes.toFixed(1)}" width="${plotWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--reserve-fill)" />`);
    lines.push(`  <line x1="${margin.left}" y1="${yRes.toFixed(1)}" x2="${(margin.left + plotWidth).toFixed(1)}" y2="${yRes.toFixed(1)}" stroke="var(--reserve-line)" stroke-dasharray="6,4" stroke-width="1.5" />`);
    lines.push(`  <text x="${(margin.left + plotWidth - 8).toFixed(1)}" y="${(yRes - 6).toFixed(1)}" text-anchor="end" class="reserve-label">Reserve floor (${formatHumanPercent(pw.reserve_percent)}%)</text>`);
  }

  // Straight-line Pacing Guide (not predicted usage)
  const yTop = yForRemaining(100);
  const yBottom = yForRemaining(0);
  lines.push(`  <line x1="${margin.left}" y1="${yTop.toFixed(1)}" x2="${(margin.left + plotWidth).toFixed(1)}" y2="${yBottom.toFixed(1)}" stroke="var(--guide-line)" stroke-dasharray="4,4" stroke-width="1.5" />`);
  lines.push(`  <text x="${(margin.left + 10).toFixed(1)}" y="${(yTop + 16).toFixed(1)}" class="guide-label">Straight-line guide</text>`);

  // Current Time ("Now") vertical line (if within window range)
  const nowMs = now.getTime();
  if (Number.isFinite(resetMs) && nowMs >= startMs && nowMs <= resetMs) {
    const xNow = xForTime(nowMs);
    lines.push(`  <line x1="${xNow.toFixed(1)}" y1="${margin.top}" x2="${xNow.toFixed(1)}" y2="${(margin.top + plotHeight).toFixed(1)}" stroke="var(--now-line)" stroke-dasharray="3,3" stroke-width="1.5" />`);
    lines.push(`  <text x="${xNow.toFixed(1)}" y="${(margin.top - 8).toFixed(1)}" text-anchor="middle" class="now-label">Now (${escapeHtml(formatClock(now))})</text>`);
  }

  // Axes lines
  lines.push(`  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${(margin.top + plotHeight).toFixed(1)}" stroke="var(--axis-line)" stroke-width="1.5" />`);
  lines.push(`  <line x1="${margin.left}" y1="${(margin.top + plotHeight).toFixed(1)}" x2="${(margin.left + plotWidth).toFixed(1)}" y2="${(margin.top + plotHeight).toFixed(1)}" stroke="var(--axis-line)" stroke-width="1.5" />`);

  // X-axis time ticks
  if (Number.isFinite(resetMs)) {
    const xTicks = [
      { at: startMs, label: `${formatShortDate(startMs)} Start`, align: "start" },
      { at: startMs + duration * 0.25, label: formatShortDate(startMs + duration * 0.25), align: "middle" },
      { at: startMs + duration * 0.50, label: formatShortDate(startMs + duration * 0.50), align: "middle" },
      { at: startMs + duration * 0.75, label: formatShortDate(startMs + duration * 0.75), align: "middle" },
      { at: resetMs, label: `${formatShortDate(resetMs)} Reset`, align: "end" },
    ];

    for (const tick of xTicks) {
      const x = xForTime(tick.at);
      lines.push(`  <line x1="${x.toFixed(1)}" y1="${(margin.top + plotHeight).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(margin.top + plotHeight + 5).toFixed(1)}" stroke="var(--axis-line)" stroke-width="1" />`);
      lines.push(`  <text x="${x.toFixed(1)}" y="${(margin.top + plotHeight + 18).toFixed(1)}" text-anchor="${tick.align}" class="axis-label">${escapeHtml(tick.label)}</text>`);
    }
  }

  // Deduplicate and plot real reset/free-reset event markers only
  interface PlottedMarker {
    x: number;
    glyph: string;
    color: string;
    title: string;
  }
  const markers: PlottedMarker[] = [];

  for (const event of pw.events) {
    const at = Date.parse(event.created_at);
    if (at >= startMs && (!Number.isFinite(resetMs) || at <= resetMs)) {
      const xEv = xForTime(at);
      const isUnscheduled = event.kind === "reset_seen" && event.metadata?.unscheduled;
      const isFreeReset = event.kind.startsWith("free_reset_");
      const glyph = isFreeReset ? "F" : isUnscheduled ? "!" : "R";
      const color = isUnscheduled ? "var(--badge-conserve-text)" : isFreeReset ? "var(--badge-harvest-text)" : "var(--primary)";
      const title = `${event.kind}${event.metadata?.unscheduled ? " (unscheduled)" : ""}\nTime: ${event.created_at}\nConfidence: ${Math.round(event.confidence * 100)}%`;

      const existing = markers.find((m) => Math.abs(m.x - xEv) < 15);
      if (existing) {
        existing.glyph = "*";
        existing.title += `\n---\n${title}`;
      } else {
        markers.push({ x: xEv, glyph, color, title });
      }
    }
  }

  for (const m of markers) {
    lines.push(`  <g class="event-marker">`);
    lines.push(`    <line x1="${m.x.toFixed(1)}" y1="${margin.top}" x2="${m.x.toFixed(1)}" y2="${(margin.top + plotHeight).toFixed(1)}" stroke="${m.color}" stroke-dasharray="2,2" stroke-width="1" opacity="0.6" />`);
    lines.push(`    <circle cx="${m.x.toFixed(1)}" cy="${(margin.top + 10).toFixed(1)}" r="7" fill="${m.color}" />`);
    lines.push(`    <text x="${m.x.toFixed(1)}" y="${(margin.top + 14).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold">${m.glyph}</text>`);
    lines.push(`    <title>${escapeHtml(m.title)}</title>`);
    lines.push(`  </g>`);
  }

  // Draw data segments
  if (points.length >= 2) {
    for (const segment of segments) {
      if (segment.length < 2) continue;
      let d = `M ${xForTime(segment[0].at).toFixed(1)} ${yForRemaining(segment[0].remaining).toFixed(1)}`;
      for (let i = 1; i < segment.length; i++) {
        d += ` L ${xForTime(segment[i].at).toFixed(1)} ${yForRemaining(segment[i].remaining).toFixed(1)}`;
      }
      lines.push(`  <path d="${d}" fill="none" stroke="var(--line-stroke)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`);
    }

    // Sample dots with hover data and keyboard focus semantics
    for (const p of points) {
      const cx = xForTime(p.at);
      const cy = yForRemaining(p.remaining);
      const formattedRem = formatHumanPercent(p.remaining);
      const formattedUsed = formatHumanPercent(p.used);
      lines.push(`  <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" class="sample-dot"`);
      lines.push(`    tabindex="0" role="img" aria-label="${formattedRem}% remaining at ${escapeHtml(p.observed_at)}"`);
      lines.push(`    data-meter="${escapeHtml(pw.meter_id)}"`);
      lines.push(`    data-observed="${escapeHtml(p.observed_at)}"`);
      lines.push(`    data-remaining="${formattedRem}"`);
      lines.push(`    data-used="${formattedUsed}"`);
      lines.push(`    data-reset="${escapeHtml(p.resets_at ?? "")}"`);
      lines.push(`    data-freshness="${escapeHtml(p.freshness)}"`);
      lines.push(`    data-confidence="${Math.round(p.confidence * 100)}%">`);
      lines.push(`    <title>Observed: ${escapeHtml(p.observed_at)}&#10;Remaining: ${formattedRem}% (Used: ${formattedUsed}%)&#10;Resets: ${escapeHtml(p.resets_at ?? "")}&#10;Freshness: ${escapeHtml(p.freshness)}</title>`);
      lines.push(`  </circle>`);
    }
  } else if (points.length === 1) {
    const p = points[0];
    const cx = xForTime(p.at);
    const cy = yForRemaining(p.remaining);
    const formattedRem = formatHumanPercent(p.remaining);
    lines.push(`  <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" class="sample-dot"`);
    lines.push(`    tabindex="0" role="img" aria-label="${formattedRem}% remaining at ${escapeHtml(p.observed_at)}"`);
    lines.push(`    data-meter="${escapeHtml(pw.meter_id)}"`);
    lines.push(`    data-observed="${escapeHtml(p.observed_at)}"`);
    lines.push(`    data-remaining="${formattedRem}"`);
    lines.push(`    data-used="${formatHumanPercent(p.used)}">`);
    lines.push(`    <title>1 sample: ${formattedRem}% remaining at ${escapeHtml(p.observed_at)}</title>`);
    lines.push(`  </circle>`);
    lines.push(`  <text x="${(svgWidth / 2).toFixed(1)}" y="${(svgHeight / 2).toFixed(1)}" text-anchor="middle" class="insufficient-text">${escapeHtml(pw.insufficient_data_reason ?? "Collecting readings")}</text>`);
  } else {
    lines.push(`  <text x="${(svgWidth / 2).toFixed(1)}" y="${(svgHeight / 2).toFixed(1)}" text-anchor="middle" class="insufficient-text">${escapeHtml(pw.insufficient_data_reason ?? "No recorded readings in this period yet.")}</text>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

/** Render a panel for a local inference pool. */
function renderLocalPoolPanel(pw: ProcessedWindow): string {
  const state = pw.metadata?.state ?? "DOWN";
  const stateClass = state === "UP" ? "harvest" : state === "BUSY" ? "conserve" : "freeze";
  const models = pw.metadata?.model_ids?.join(", ") || "none specified";
  const running = pw.metadata?.running ?? pw.quantity?.used ?? 0;
  const waiting = pw.metadata?.waiting ?? 0;
  const costModel = pw.metadata?.cost_model ?? "marginal";

  return `
    <div class="secondary-metric-card">
      <div class="local-header">
        <div class="local-title">
          <h4>${escapeHtml(pw.meter_id)}</h4>
          <span class="badge ${stateClass}">● ${escapeHtml(state)}</span>
        </div>
        <div class="local-subtitle muted">Local Pool Concurrency · Cost Model: ${escapeHtml(costModel)}</div>
      </div>
      <div class="metric-mini-grid">
        <div class="mini-metric">
          <div class="mini-label muted">Active Models</div>
          <div class="mini-val mono">${escapeHtml(models)}</div>
        </div>
        <div class="mini-metric">
          <div class="mini-label muted">Running Requests</div>
          <div class="mini-val mono">${escapeHtml(running)}</div>
        </div>
        <div class="mini-metric">
          <div class="mini-label muted">Waiting Queue Depth</div>
          <div class="mini-val mono">${escapeHtml(waiting)}</div>
        </div>
      </div>
      <div class="pool-note muted">
        Local pools provide concurrency and queue-depth sensing for local engines (vLLM, llama.cpp).
        They do not enforce percent quota windows.
      </div>
    </div>
  `;
}

/** Render a panel for credit counts. */
function renderCreditsPanel(pw: ProcessedWindow): string {
  const remaining = pw.quantity?.remaining ?? pw.quantity?.used ?? "?";
  const limit = pw.quantity?.limit ?? "?";
  const expiry = pw.resets_at ? formatReset(pw.resets_at) : "No expiration";

  return `
    <div class="secondary-metric-card">
      <div class="local-header">
        <div class="local-title">
          <h4>${escapeHtml(pw.meter_id)}</h4>
          <span class="badge normal">CREDITS</span>
        </div>
        <div class="local-subtitle muted">Informational credit balance · Soft enforcement</div>
      </div>
      <div class="metric-mini-grid">
        <div class="mini-metric">
          <div class="mini-label muted">Available Balance</div>
          <div class="mini-val mono">${escapeHtml(remaining)} credits</div>
        </div>
        <div class="mini-metric">
          <div class="mini-label muted">Allocation Limit</div>
          <div class="mini-val mono">${escapeHtml(limit)}</div>
        </div>
        <div class="mini-metric">
          <div class="mini-label muted">Expiration Target</div>
          <div class="mini-val mono">${escapeHtml(expiry)}</div>
        </div>
      </div>
      <div class="pool-note muted">
        Credits are informational counts and do not constrain <code>headroom can</code> dispatches.
      </div>
    </div>
  `;
}

/** Render one window cell in the subscription overview table. */
function renderOverviewWindowCell(pw: ProcessedWindow | undefined, now: Date): string {
  if (!pw) return `<span class="muted">—</span>`;
  if (pw.is_not_enforced) return `<span class="muted">Not enforced</span>`;

  if (pw.is_unknown) {
    const isHeld = Boolean(pw.metadata?.vendor_window_held || pw.metadata?.vendor_inconsistent);
    const tag = isHeld ? "HELD" : "UNKNOWN";
    const reason = sanitizeFailureReason(pw.raw_reason ?? pw.decision_reason);
    return `
      <div class="cell-block">
        <div class="cell-status-row">
          <span class="badge unknown">${escapeHtml(tag)}</span>
          <span class="cell-reason muted" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>
        </div>
      </div>
    `;
  }

  const usedVal = pw.used_percent !== null ? pw.used_percent : 0;
  const remVal = pw.remaining_percent !== null ? pw.remaining_percent : 100;
  const secondsToReset = pw.resets_at ? resetsIn(pw.resets_at, now).resets_in_seconds : null;
  const displayReset = secondsToReset !== null ? formatResetsIn(secondsToReset) : "?";

  // Color bar by usage level
  const barClass = usedVal > 90 ? "danger" : usedVal > 70 ? "warning" : "healthy";

  return `
    <div class="cell-block">
      <div class="bar-track">
        <div class="bar-fill ${barClass}" style="width: ${usedVal}%;"></div>
      </div>
      <div class="cell-numbers">
        <span class="pct mono"><strong>${formatHumanPercent(usedVal)}%</strong> used</span>
        <span class="rem-pct muted mono">(${formatHumanPercent(remVal)}% rem)</span>
        <span class="reset-time muted mono">resets in ${escapeHtml(displayReset)}</span>
      </div>
    </div>
  `;
}

/** Pure renderer that converts a DashboardModel to a standalone HTML snapshot. */
export function renderBrowserReport(model: DashboardModel, options: BrowserReportOptions = {}): string {
  const now = options.generatedAt ?? model.now ?? new Date();
  const observations = model.observations ?? [];
  const processedWindows = observations.map((row) => processWindow(row, model, now));

  // Determine latest observation / fetch timestamps safely
  const observedTimes = observations
    .map((o) => Date.parse(o.observed_at))
    .filter(Number.isFinite);
  const fetchedTimes = observations
    .map((o) => Date.parse(o.fetched_at))
    .filter(Number.isFinite);

  const latestObserved = observedTimes.length ? new Date(Math.max(...observedTimes)) : now;
  const latestFetched = fetchedTimes.length ? new Date(Math.max(...fetchedTimes)) : now;
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - latestFetched.getTime()) / 1000));
  const freshnessSource = model.direct
    ? "direct read"
    : `daemon fresh ${ageSeconds}s ago`;

  // Monitored accounts
  const accounts = [...new Set(observations.map((o) => o.principal_id))].sort();

  // Active leases
  const activeLeases = (model.leases ?? []).filter(
    (l) => !l.ended_at && Date.parse(l.expires_at) > now.getTime()
  );

  // Next reset must filter fresh trustworthy percent/future reset, ignoring held/inconsistent/idle/exhausted-ignored
  const trustworthyWithReset = observations.filter(
    (o) => isLiveValidSample(o) && o.resets_at && Date.parse(o.resets_at) > now.getTime()
  );
  trustworthyWithReset.sort((a, b) => Date.parse(a.resets_at!) - Date.parse(b.resets_at!));
  const nextResetRow = trustworthyWithReset[0];

  const nextResetText = nextResetRow
    ? `${nextResetRow.principal_id} (${label(nextResetRow)}) in ${formatResetsIn(Math.max(0, Math.floor((Date.parse(nextResetRow.resets_at!) - now.getTime()) / 1000)))}`
    : "None scheduled";

  // Actionable notices (plan downgrades, unscheduled capacity appeared)
  const actionableNotices: string[] = [
    ...(model.planDowngraded ?? []).map((d) => planDowngradeLine(d)),
    ...(model.notices ?? []).filter((n) => /capacity appeared|downgrade/i.test(n)),
  ];

  // Held / stale notices collapsed into details
  const heldNotices: string[] = [
    ...(model.notices ?? []).filter((n) => !/capacity appeared|downgrade/i.test(n)),
  ];
  for (const pw of processedWindows) {
    if (pw.metadata?.vendor_window_held) {
      heldNotices.push(`${pw.meter_id}: new window unconfirmed, holding`);
    } else if (pw.metadata?.vendor_inconsistent) {
      heldNotices.push(`${pw.meter_id}: vendor readings inconsistent, holding`);
    }
  }

  // Split into subscription meters vs secondary (local pools & credits)
  const subscriptionWindows = processedWindows.filter((pw) => !pw.is_local && !pw.is_credits);
  const secondaryWindows = processedWindows.filter((pw) => pw.is_local || pw.is_credits);

  // Group subscription windows by meter_id
  const subscriptionMeterMap = new Map<string, ProcessedWindow[]>();
  for (const pw of subscriptionWindows) {
    const list = subscriptionMeterMap.get(pw.meter_id) ?? [];
    list.push(pw);
    subscriptionMeterMap.set(pw.meter_id, list);
  }

  interface SubscriptionOverviewRow {
    meter_id: string;
    principal_id: string;
    window5h?: ProcessedWindow;
    windowWeekly?: ProcessedWindow;
    windows: ProcessedWindow[];
    tightestState: PaceState;
    hasIssue: boolean;
    issueReason?: string;
  }

  const subscriptionOverviewRows: SubscriptionOverviewRow[] = [...subscriptionMeterMap.entries()].map(([meter_id, wins]) => {
    const principal_id = wins[0].principal_id;
    const window5h = wins.find((w) => w.window_minutes === 300);
    const windowWeekly = wins.find((w) => w.window_minutes && w.window_minutes >= 1440);
    const tightestState = tightestPaceState(wins.map((w) => w.decision_state));
    const issueWin = wins.find((w) => w.is_unknown || w.metadata?.vendor_window_held || w.metadata?.vendor_inconsistent || w.freshness === "failed");
    const hasIssue = Boolean(issueWin);
    const issueReason = issueWin ? sanitizeFailureReason(issueWin.raw_reason ?? issueWin.decision_reason) : undefined;

    return {
      meter_id,
      principal_id,
      window5h,
      windowWeekly,
      windows: wins,
      tightestState,
      hasIssue,
      issueReason,
    };
  });

  // Determine default selected meter and window
  const defaultSelection = determineDefaultSelection(processedWindows) ?? {
    meter_id: subscriptionOverviewRows[0]?.meter_id ?? (processedWindows[0]?.meter_id || ""),
    window_minutes: subscriptionOverviewRows[0]?.window5h?.window_minutes ?? (processedWindows[0]?.window_minutes || null),
  };

  const defaultMeterPrincipal = subscriptionOverviewRows.find((r) => r.meter_id === defaultSelection.meter_id)?.principal_id ?? (processedWindows[0]?.principal_id || "");

  // Safe serialized JSON payload
  const serializedData = safeJsonSerialize({
    version: model.version,
    generated_at: now.toISOString(),
    latest_observed: latestObserved.toISOString(),
    latest_fetched: latestFetched.toISOString(),
    direct: model.direct,
    accounts,
    active_leases_count: activeLeases.length,
    windows_count: observations.length,
    default_meter: defaultSelection.meter_id,
    default_window_minutes: defaultSelection.window_minutes,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Headroom — Subscription capacity</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --card-border-hover: #cbd5e1;
      --row-selected-bg: #eff6ff;
      --row-selected-border: #3b82f6;
      --text-primary: #0f172a;
      --text-secondary: #334155;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-bg: #eff6ff;
      --line-stroke: #2563eb;
      --reserve-line: #ef4444;
      --reserve-fill: rgba(239, 68, 68, 0.08);
      --guide-line: #64748b;
      --now-line: #6366f1;
      --grid-line: #f1f5f9;
      --axis-line: #cbd5e1;
      --bar-healthy: #10b981;
      --bar-warning: #f59e0b;
      --bar-danger: #ef4444;
      --badge-harvest-bg: #dcfce7;
      --badge-harvest-text: #166534;
      --badge-normal-bg: #e0f2fe;
      --badge-normal-text: #075985;
      --badge-conserve-bg: #fef3c7;
      --badge-conserve-text: #92400e;
      --badge-freeze-bg: #fee2e2;
      --badge-freeze-text: #991b1b;
      --badge-unknown-bg: #f1f5f9;
      --badge-unknown-text: #475569;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -1px rgba(0, 0, 0, 0.04);
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #090d16;
        --card-bg: #111827;
        --card-border: #1f2937;
        --card-border-hover: #374151;
        --row-selected-bg: #0f2347;
        --row-selected-border: #38bdf8;
        --text-primary: #f9fafb;
        --text-secondary: #cbd5e1;
        --text-muted: #94a3b8;
        --primary: #38bdf8;
        --primary-hover: #0ea5e9;
        --primary-bg: #0c2d48;
        --line-stroke: #38bdf8;
        --reserve-line: #f87171;
        --reserve-fill: rgba(248, 113, 113, 0.12);
        --guide-line: #64748b;
        --now-line: #818cf8;
        --grid-line: #1e293b;
        --axis-line: #334155;
        --bar-healthy: #34d399;
        --bar-warning: #fbbf24;
        --bar-danger: #f87171;
        --badge-harvest-bg: #064e3b;
        --badge-harvest-text: #6ee7b7;
        --badge-normal-bg: #0c4a6e;
        --badge-normal-text: #7dd3fc;
        --badge-conserve-bg: #451a03;
        --badge-conserve-text: #fcd34d;
        --badge-freeze-bg: #450a0a;
        --badge-freeze-text: #fca5a5;
        --badge-unknown-bg: #1e293b;
        --badge-unknown-text: #cbd5e1;
        --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
        --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
      }
    }

    :root[data-theme="dark"] {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f2937;
      --card-border-hover: #374151;
      --row-selected-bg: #0f2347;
      --row-selected-border: #38bdf8;
      --text-primary: #f9fafb;
      --text-secondary: #cbd5e1;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --primary-bg: #0c2d48;
      --line-stroke: #38bdf8;
      --reserve-line: #f87171;
      --reserve-fill: rgba(248, 113, 113, 0.12);
      --guide-line: #64748b;
      --now-line: #818cf8;
      --grid-line: #1e293b;
      --axis-line: #334155;
      --bar-healthy: #34d399;
      --bar-warning: #fbbf24;
      --bar-danger: #f87171;
      --badge-harvest-bg: #064e3b;
      --badge-harvest-text: #6ee7b7;
      --badge-normal-bg: #0c4a6e;
      --badge-normal-text: #7dd3fc;
      --badge-conserve-bg: #451a03;
      --badge-conserve-text: #fcd34d;
      --badge-freeze-bg: #450a0a;
      --badge-freeze-text: #fca5a5;
      --badge-unknown-bg: #1e293b;
      --badge-unknown-text: #cbd5e1;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
    }

    :root[data-theme="light"] {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --card-border-hover: #cbd5e1;
      --row-selected-bg: #eff6ff;
      --row-selected-border: #3b82f6;
      --text-primary: #0f172a;
      --text-secondary: #334155;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-bg: #eff6ff;
      --line-stroke: #2563eb;
      --reserve-line: #ef4444;
      --reserve-fill: rgba(239, 68, 68, 0.08);
      --guide-line: #64748b;
      --now-line: #6366f1;
      --grid-line: #f1f5f9;
      --axis-line: #cbd5e1;
      --bar-healthy: #10b981;
      --bar-warning: #f59e0b;
      --bar-danger: #ef4444;
      --badge-harvest-bg: #dcfce7;
      --badge-harvest-text: #166534;
      --badge-normal-bg: #e0f2fe;
      --badge-normal-text: #075985;
      --badge-conserve-bg: #fef3c7;
      --badge-conserve-text: #92400e;
      --badge-freeze-bg: #fee2e2;
      --badge-freeze-text: #991b1b;
      --badge-unknown-bg: #f1f5f9;
      --badge-unknown-text: #475569;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.5;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 1100px;
      margin: 0 auto;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 12px;
    }

    h1 {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.3px;
    }

    h1 .subtitle {
      font-weight: 400;
      color: var(--text-muted);
      font-size: 16px;
    }

    .header-meta {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 3px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .meta-sep { color: var(--card-border); }

    .code, .mono {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }

    .muted { color: var(--text-muted); }

    .theme-btn {
      background: var(--card-bg);
      color: var(--text-primary);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      box-shadow: var(--shadow-sm);
    }

    .theme-btn:hover {
      background: var(--primary-bg);
      border-color: var(--primary);
    }

    .actionable-alert {
      background: var(--badge-conserve-bg);
      color: var(--badge-conserve-text);
      border: 1px solid var(--badge-conserve-text);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 13px;
      font-weight: 500;
    }

    /* Main Overview Card & Table */
    .overview-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 24px;
      overflow: hidden;
    }

    .overview-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .overview-header h2 {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .overview-summary {
      font-size: 13px;
      color: var(--text-muted);
    }

    .table-container {
      width: 100%;
      overflow-x: auto;
    }

    .meter-overview-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }

    .meter-overview-table th {
      background: var(--bg);
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--card-border);
    }

    .meter-row {
      cursor: pointer;
      border-bottom: 1px solid var(--card-border);
      transition: background-color 0.12s ease;
      outline: none;
    }

    .meter-row:hover {
      background-color: var(--primary-bg);
    }

    .meter-row:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: -2px;
    }

    .meter-row.selected {
      background-color: var(--row-selected-bg);
      box-shadow: inset 3px 0 0 var(--row-selected-border);
    }

    .meter-row td {
      padding: 12px 14px;
      vertical-align: middle;
    }

    .meter-title strong {
      font-size: 14px;
      color: var(--text-primary);
    }

    .meter-account {
      font-size: 12px;
      margin-top: 1px;
    }

    .row-alert-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 11px;
    }

    .bar-track {
      background: var(--card-border);
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 4px;
      min-width: 140px;
    }

    .bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.2s ease;
    }

    .bar-fill.healthy { background: var(--bar-healthy); }
    .bar-fill.warning { background: var(--bar-warning); }
    .bar-fill.danger { background: var(--bar-danger); }

    .cell-numbers {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-size: 12px;
      flex-wrap: wrap;
    }

    .cell-status-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .cell-reason {
      font-size: 12px;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }

    .badge.harvest { background: var(--badge-harvest-bg); color: var(--badge-harvest-text); }
    .badge.normal { background: var(--badge-normal-bg); color: var(--badge-normal-text); }
    .badge.conserve { background: var(--badge-conserve-bg); color: var(--badge-conserve-text); }
    .badge.freeze { background: var(--badge-freeze-bg); color: var(--badge-freeze-text); }
    .badge.unknown { background: var(--badge-unknown-bg); color: var(--badge-unknown-text); }

    /* Selected Meter Detail & Chart Panel */
    .detail-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 24px;
      overflow: hidden;
    }

    .detail-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    .detail-headline h3 {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .window-tabs {
      display: flex;
      gap: 6px;
    }

    .window-tab {
      background: var(--bg);
      color: var(--text-secondary);
      border: 1px solid var(--card-border);
      border-radius: 5px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .window-tab:hover {
      background: var(--primary-bg);
      color: var(--primary);
      border-color: var(--primary);
    }

    .window-tab.active {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
      font-weight: 600;
    }

    .chart-panel {
      padding: 16px 20px;
    }

    .panel-meta-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      background: var(--bg);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
    }

    .meta-item {
      display: flex;
      flex-direction: column;
    }

    .meta-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 2px;
    }

    .meta-val {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .chart-container {
      position: relative;
      width: 100%;
      overflow-x: auto;
    }

    .chart-svg {
      width: 100%;
      max-width: 880px;
      height: auto;
      display: block;
      margin: 0 auto;
    }

    .axis-title {
      font-size: 11px;
      font-weight: 600;
      fill: var(--text-muted);
      font-family: system-ui, sans-serif;
    }

    .axis-label {
      font-size: 10px;
      fill: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }

    .reserve-label {
      font-size: 10px;
      font-weight: 600;
      fill: var(--reserve-line);
      font-family: system-ui, sans-serif;
    }

    .guide-label {
      font-size: 10px;
      fill: var(--guide-line);
      font-family: system-ui, sans-serif;
    }

    .now-label {
      font-size: 10px;
      font-weight: 600;
      fill: var(--now-line);
      font-family: system-ui, sans-serif;
    }

    .insufficient-text {
      font-size: 13px;
      font-weight: 500;
      fill: var(--text-muted);
      font-family: system-ui, sans-serif;
    }

    .sample-dot {
      fill: var(--line-stroke);
      stroke: var(--card-bg);
      stroke-width: 1.5;
      cursor: pointer;
      outline: none;
    }

    .sample-dot:hover, .sample-dot:focus {
      r: 6.5;
      stroke-width: 2.5;
    }

    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 16px;
      margin-top: 14px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .legend-indicator {
      width: 14px;
      height: 3px;
      border-radius: 2px;
    }

    .legend-indicator.actual { background: var(--line-stroke); }
    .legend-indicator.reserve { background: var(--reserve-line); border-top: 1px dashed var(--reserve-line); }
    .legend-indicator.guide { background: var(--guide-line); border-top: 1px dotted var(--guide-line); }
    .legend-indicator.now { background: var(--now-line); }

    .chart-tooltip {
      position: absolute;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease-out;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      box-shadow: var(--shadow-md);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--text-primary);
      z-index: 100;
      white-space: nowrap;
    }

    /* Secondary Lower Section for Local Pools & Credits */
    .secondary-section {
      margin-top: 24px;
      margin-bottom: 24px;
    }

    .secondary-heading {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }

    .secondary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
    }

    .secondary-metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px 16px;
      box-shadow: var(--shadow-sm);
    }

    .local-header { margin-bottom: 12px; }
    .local-title { display: flex; align-items: center; justify-content: space-between; }
    .local-title h4 { font-size: 14px; font-weight: 600; }
    .local-subtitle { font-size: 12px; margin-top: 2px; }

    .metric-mini-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 10px;
    }

    .mini-metric {
      background: var(--bg);
      border-radius: 5px;
      padding: 8px 10px;
    }

    .mini-label { font-size: 10px; font-weight: 600; text-transform: uppercase; margin-bottom: 2px; }
    .mini-val { font-size: 13px; font-weight: 600; color: var(--text-primary); }

    .pool-note { font-size: 11px; line-height: 1.4; }

    /* Collapsible diagnostics */
    details.diagnostics-details, details.notices-details {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 20px;
      box-shadow: var(--shadow-sm);
      font-size: 13px;
    }

    details summary {
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      color: var(--text-primary);
    }

    .diagnostics-content {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      margin-top: 8px;
      font-size: 12px;
    }

    .data-table th {
      background: var(--bg);
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--card-border);
    }

    .data-table td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--card-border);
      color: var(--text-secondary);
    }

    footer {
      margin-top: 30px;
      padding-top: 14px;
      border-top: 1px solid var(--card-border);
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
    }

    @media (max-width: 768px) {
      .meter-overview-table thead { display: none; }
      .meter-overview-table, .meter-overview-table tbody, .meter-overview-table tr, .meter-overview-table td {
        display: block;
        width: 100%;
      }
      .meter-row {
        margin-bottom: 8px;
        border: 1px solid var(--card-border);
        border-radius: 6px;
        padding: 8px;
      }
      .meter-row td {
        border-bottom: none;
        padding: 4px 6px;
      }
      .state-cell { text-align: left !important; margin-top: 4px; }
      .mini-metric-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Headroom <span class="subtitle">— Subscription capacity</span></h1>
        <div class="header-meta">
          <span>Local snapshot generated <time title="${escapeHtml(now.toISOString())}" class="mono">${escapeHtml(formatReportDateTime(now))}</time></span>
          <span class="meta-sep">·</span>
          <span>${escapeHtml(freshnessSource)}</span>
          <span class="meta-sep">·</span>
          <span class="mono">v${escapeHtml(model.version)}</span>
        </div>
      </div>
      <div>
        <button id="theme-toggle" class="theme-btn" aria-label="Toggle visual theme">Theme: Auto</button>
      </div>
    </header>

    ${actionableNotices.length ? `
    <div class="actionable-alert">
      ${actionableNotices.map((n) => `<div>• ${escapeHtml(redact(n))}</div>`).join("")}
    </div>
    ` : ""}

    <!-- Main Overview Table -->
    <div class="overview-card">
      <div class="overview-header">
        <h2>Subscription Meters</h2>
        <div class="overview-summary">
          <span>Next scheduled reset: <strong>${escapeHtml(nextResetText)}</strong></span>
          ${activeLeases.length ? ` · <span>${activeLeases.length} active lease${activeLeases.length === 1 ? "" : "s"}</span>` : ""}
        </div>
      </div>
      <div class="table-container">
        ${subscriptionOverviewRows.length ? `
        <table class="meter-overview-table" role="grid" aria-label="Subscription Meters Overview">
          <thead>
            <tr>
              <th scope="col" style="width: 28%;">Meter / Account</th>
              <th scope="col" style="width: 32%;">5-Hour Window</th>
              <th scope="col" style="width: 32%;">Weekly Window</th>
              <th scope="col" style="width: 8%; text-align: center;">State</th>
            </tr>
          </thead>
          <tbody>
            ${subscriptionOverviewRows.map((row) => {
              const isSelected = row.meter_id === defaultSelection.meter_id;
              const safeMeterKey = row.meter_id.replace(/[^a-zA-Z0-9_-]/g, "_");
              const tightestStateClass = row.tightestState.toLowerCase();

              return `
              <tr class="meter-row ${isSelected ? "selected" : ""}"
                  id="row-${safeMeterKey}"
                  data-meter="${escapeHtml(row.meter_id)}"
                  tabindex="0"
                  role="row"
                  aria-selected="${isSelected ? "true" : "false"}">
                <td class="meter-name-cell">
                  <div class="meter-title"><strong>${escapeHtml(row.meter_id)}</strong></div>
                  <div class="meter-account muted">${escapeHtml(row.principal_id)}</div>
                  ${row.hasIssue && row.issueReason ? `
                    <div class="row-alert-badge">
                      <span class="badge unknown">HELD / ISSUE</span>
                      <span class="muted cell-reason" title="${escapeHtml(row.issueReason)}">${escapeHtml(row.issueReason)}</span>
                    </div>
                  ` : ""}
                </td>
                <td class="window-cell">
                  ${renderOverviewWindowCell(row.window5h, now)}
                </td>
                <td class="window-cell">
                  ${renderOverviewWindowCell(row.windowWeekly, now)}
                </td>
                <td class="state-cell" style="text-align: center;">
                  <span class="badge ${tightestStateClass}">● ${escapeHtml(row.tightestState)}</span>
                </td>
              </tr>
              `;
            }).join("")}
          </tbody>
        </table>
        ` : `
        <div style="padding: 20px; text-align: center;" class="muted">
          No subscription meters recorded.
        </div>
        `}
      </div>
    </div>

    <!-- Selected Meter Detail & Burndown Chart -->
    ${subscriptionOverviewRows.length ? `
    <div class="detail-card" id="meter-detail-section">
      <div class="detail-header">
        <div class="detail-headline">
          <h3 id="selected-meter-heading">${escapeHtml(defaultSelection.meter_id)}</h3>
          <span class="muted" style="font-size: 13px;">Remaining capacity burndown</span>
        </div>
        <div class="window-tabs" id="window-tabs-container" role="tablist" aria-label="Window Tabs">
          ${subscriptionOverviewRows.flatMap((r) => r.windows.map((w) => {
            const isSelectedMeter = r.meter_id === defaultSelection.meter_id;
            const isSelectedWindow = isSelectedMeter && (w.window_minutes === defaultSelection.window_minutes || (defaultSelection.window_minutes === null && w.window_minutes === null));
            const tabLabel = w.window_minutes === 300 ? "5-Hour" : w.window_minutes && w.window_minutes >= 1440 ? "Weekly" : w.window_label;

            return `
            <button class="window-tab ${isSelectedWindow ? "active" : ""}"
                    data-meter="${escapeHtml(r.meter_id)}"
                    data-minutes="${w.window_minutes ?? ""}"
                    role="tab"
                    aria-selected="${isSelectedWindow ? "true" : "false"}"
                    style="display: ${isSelectedMeter ? "inline-block" : "none"};">
              ${escapeHtml(tabLabel)}
            </button>
            `;
          })).join("")}
        </div>
      </div>

      <div class="panels-container">
        ${subscriptionWindows.map((pw) => {
          const isSelected = pw.meter_id === defaultSelection.meter_id && (pw.window_minutes === defaultSelection.window_minutes || (defaultSelection.window_minutes === null && pw.window_minutes === null));
          const safeMeterKey = pw.meter_id.replace(/[^a-zA-Z0-9_-]/g, "_");
          const panelId = `panel-${safeMeterKey}-${pw.window_minutes ?? "custom"}`;
          const secondsToReset = pw.resets_at ? resetsIn(pw.resets_at, now).resets_in_seconds : null;
          const displayReset = secondsToReset !== null ? formatResetsIn(secondsToReset) : "?";

          return `
          <div class="chart-panel" id="${panelId}" style="display: ${isSelected ? "block" : "none"};">
            <div class="panel-meta-bar">
              <div class="meta-item">
                <span class="meta-label">Remaining</span>
                <span class="meta-val mono">
                  ${pw.remaining_percent !== null ? `${formatHumanPercent(pw.remaining_percent)}%` : "UNKNOWN"}
                </span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Used</span>
                <span class="meta-val mono">
                  ${pw.used_percent !== null ? `${formatHumanPercent(pw.used_percent)}%` : "UNKNOWN"}
                </span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Resets In</span>
                <span class="meta-val mono">${escapeHtml(displayReset)}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Burn Rate</span>
                <span class="meta-val mono">${pw.burn_rate !== null ? `${formatHumanPercent(pw.burn_rate)}%/h` : "—"}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Reserve Floor</span>
                <span class="meta-val mono">${pw.reserve_percent > 0 ? `${formatHumanPercent(pw.reserve_percent)}%` : "0%"}</span>
              </div>
            </div>

            ${pw.is_unknown ? `
            <div class="actionable-alert" style="background: var(--badge-unknown-bg); color: var(--badge-unknown-text); border-color: var(--badge-unknown-text); margin-bottom: 14px;">
              <div><strong>Observation ${escapeHtml(pw.freshness)}:</strong> ${escapeHtml(sanitizeFailureReason(pw.raw_reason ?? pw.decision_reason))}</div>
              ${pw.last_known ? `<div>Last known reading: ${formatHumanPercent(pw.last_known.used_percent)}% at ${escapeHtml(formatShortDate(pw.last_known.observed_at))}</div>` : ""}
            </div>
            ` : ""}

            <div class="chart-container">
              ${renderRemainingCapacityChartSvg(pw, now)}
            </div>

            <div class="chart-legend">
              <div class="legend-item">
                <span class="legend-indicator actual"></span>
                <span>Recorded remaining</span>
              </div>
              <div class="legend-item">
                <span class="legend-indicator guide"></span>
                <span>Straight-line guide <span class="muted" style="font-size: 11px;">(not predicted usage)</span></span>
              </div>
              <div class="legend-item">
                <span class="legend-indicator now"></span>
                <span>Now</span>
              </div>
              ${pw.reserve_percent > 0 ? `
              <div class="legend-item">
                <span class="legend-indicator reserve"></span>
                <span>Reserve floor (${formatHumanPercent(pw.reserve_percent)}%)</span>
              </div>
              ` : ""}
            </div>
          </div>
          `;
        }).join("")}
      </div>
    </div>
    ` : ""}

    <!-- Secondary Section: Local Pools & Credits -->
    ${secondaryWindows.length ? `
    <section class="secondary-section">
      <div class="secondary-heading">Local Pools &amp; Credits</div>
      <div class="secondary-grid">
        ${secondaryWindows.map((pw) => pw.is_local ? renderLocalPoolPanel(pw) : renderCreditsPanel(pw)).join("")}
      </div>
    </section>
    ` : ""}

    <!-- Collapsed Operational Details & Events -->
    <details class="diagnostics-details">
      <summary>
        Diagnostics, Leases &amp; Events (${activeLeases.length} active leases, ${(model.events ?? []).length} events)
      </summary>
      <div class="diagnostics-content">
        ${heldNotices.length ? `
        <div style="font-size: 12px; padding: 8px 12px; background: var(--bg); border-radius: 6px;">
          <strong style="color: var(--text-primary);">Operational Notices (${heldNotices.length}):</strong>
          ${heldNotices.map((n) => `<div class="muted">• ${escapeHtml(redact(n))}</div>`).join("")}
        </div>
        ` : ""}

        <div>
          <strong style="color: var(--text-primary);">Active Leases</strong>
          ${activeLeases.length ? `
          <table class="data-table">
            <thead>
              <tr><th>Owner</th><th>Meter</th><th>Held %</th><th>Spent %</th><th>Expires In</th><th>Note</th></tr>
            </thead>
            <tbody>
              ${activeLeases.map((l) => {
                const secondsLeft = Math.max(0, Math.floor((Date.parse(l.expires_at) - now.getTime()) / 1000));
                return `
                <tr>
                  <td><strong>${escapeHtml(l.owner)}</strong></td>
                  <td class="mono">${escapeHtml(l.meter_id)}</td>
                  <td class="mono">${l.expected_percent !== null ? `${formatHumanPercent(l.expected_percent)}%` : "—"}</td>
                  <td class="mono">${formatHumanPercent(l.spent_percent)}%</td>
                  <td class="mono">${escapeHtml(formatResetsIn(secondsLeft))}</td>
                  <td>${escapeHtml(redact(l.note ?? "—"))}</td>
                </tr>
                `;
              }).join("")}
            </tbody>
          </table>
          ` : `<div class="muted" style="margin-top: 4px;">No active leases.</div>`}
        </div>

        <div>
          <strong style="color: var(--text-primary);">Recent Events</strong>
          ${(model.events ?? []).length ? `
          <table class="data-table">
            <thead>
              <tr><th>Time</th><th>Target</th><th>Kind</th><th>Origin</th><th>Confidence</th><th>Details</th></tr>
            </thead>
            <tbody>
              ${[...(model.events ?? [])].slice(-8).reverse().map((ev) => `
              <tr>
                <td class="mono">${escapeHtml(formatShortDate(ev.created_at))} ${escapeHtml(formatClock(ev.created_at))}</td>
                <td class="mono">${escapeHtml(ev.meter_id ?? ev.principal_id ?? "—")}</td>
                <td><span class="badge ${ev.kind.includes("reset") ? "harvest" : "normal"}">${escapeHtml(ev.kind)}</span></td>
                <td>${escapeHtml(ev.origin)}</td>
                <td class="mono">${Math.round(ev.confidence * 100)}%</td>
                <td>${escapeHtml(redact(ev.reason ?? (ev.metadata?.unscheduled ? "Unscheduled reset" : "—")))}</td>
              </tr>
              `).join("")}
            </tbody>
          </table>
          ` : `<div class="muted" style="margin-top: 4px;">No events recorded.</div>`}
        </div>
      </div>
    </details>

    <!-- Tooltip Element -->
    <div id="chart-tooltip" class="chart-tooltip">
      <div id="tt-title" style="font-weight: 600; margin-bottom: 3px;"></div>
      <div>Observed: <span id="tt-observed" class="mono"></span></div>
      <div>Remaining: <strong id="tt-remaining" class="mono"></strong> (Used: <span id="tt-used" class="mono"></span>)</div>
      <div>Resets: <span id="tt-reset" class="mono"></span></div>
      <div>Freshness: <span id="tt-freshness"></span></div>
    </div>

    <footer>
      <div>Local snapshot · No external requests</div>
    </footer>
  </div>

  <!-- Safe inline serialized state metadata -->
  <script id="headroom-report-data" type="application/json">
${serializedData}
  </script>

  <!-- Interactive script -->
  <script>
  (function() {
    var themeToggle = document.getElementById("theme-toggle");
    var currentTheme = "auto";
    try {
      currentTheme = localStorage.getItem("headroom-theme") || "auto";
    } catch (e) {}

    function applyTheme(theme) {
      currentTheme = theme;
      if (theme === "auto") {
        document.documentElement.removeAttribute("data-theme");
        if (themeToggle) themeToggle.textContent = "Theme: Auto";
      } else {
        document.documentElement.setAttribute("data-theme", theme);
        if (themeToggle) themeToggle.textContent = "Theme: " + (theme === "dark" ? "Dark" : "Light");
      }
      try { localStorage.setItem("headroom-theme", theme); } catch (e) {}
    }

    applyTheme(currentTheme);

    if (themeToggle) {
      themeToggle.addEventListener("click", function() {
        if (currentTheme === "auto") applyTheme("dark");
        else if (currentTheme === "dark") applyTheme("light");
        else applyTheme("auto");
      });
    }

    var defaultMeterId = ${safeJsonSerialize(defaultSelection.meter_id)};
    var defaultMinutes = ${safeJsonSerialize(defaultSelection.window_minutes)};

    function safeKey(str) {
      return String(str || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    function activatePanel(meterId, minutes) {
      // Update table row selection
      document.querySelectorAll(".meter-row").forEach(function(r) {
        if (r.getAttribute("data-meter") === meterId) {
          r.classList.add("selected");
          r.setAttribute("aria-selected", "true");
        } else {
          r.classList.remove("selected");
          r.setAttribute("aria-selected", "false");
        }
      });

      // Update detail heading
      var heading = document.getElementById("selected-meter-heading");
      if (heading) heading.textContent = meterId;

      // Filter and update window tabs
      var matchingTabs = [];
      document.querySelectorAll(".window-tab").forEach(function(tab) {
        var tabMeter = tab.getAttribute("data-meter");
        var tabMins = tab.getAttribute("data-minutes");
        if (tabMeter === meterId) {
          tab.style.display = "inline-block";
          matchingTabs.push(tab);
          if (String(tabMins || "") === String(minutes != null ? minutes : "")) {
            tab.classList.add("active");
            tab.setAttribute("aria-selected", "true");
          } else {
            tab.classList.remove("active");
            tab.setAttribute("aria-selected", "false");
          }
        } else {
          tab.style.display = "none";
          tab.classList.remove("active");
          tab.setAttribute("aria-selected", "false");
        }
      });

      var hasActive = matchingTabs.some(function(t) { return t.classList.contains("active"); });
      if (!hasActive && matchingTabs.length) {
        matchingTabs[0].classList.add("active");
        matchingTabs[0].setAttribute("aria-selected", "true");
        var autoMins = matchingTabs[0].getAttribute("data-minutes");
        minutes = autoMins ? Number(autoMins) : null;
      }

      // Show chart panel
      var panelId = "panel-" + safeKey(meterId) + "-" + (minutes != null ? minutes : "custom");
      document.querySelectorAll(".chart-panel").forEach(function(p) {
        if (p.id === panelId) p.style.display = "block";
        else p.style.display = "none";
      });
    }

    // Row selection on click and Enter/Space
    document.querySelectorAll(".meter-row").forEach(function(row) {
      function onSelect() {
        var meterId = row.getAttribute("data-meter");
        if (!meterId) return;
        // On meter change prefer 5h when available
        var has5h = Boolean(document.querySelector('.window-tab[data-meter="' + CSS.escape(meterId) + '"][data-minutes="300"]'));
        var targetMinutes = has5h ? 300 : null;
        activatePanel(meterId, targetMinutes);
      }

      row.addEventListener("click", onSelect);
      row.addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      });
    });

    // Window tab selection
    document.querySelectorAll(".window-tab").forEach(function(tab) {
      tab.addEventListener("click", function() {
        var meterId = tab.getAttribute("data-meter");
        var minutes = tab.getAttribute("data-minutes");
        activatePanel(meterId, minutes ? Number(minutes) : null);
      });
    });

    // Tooltip handling with mouse & keyboard focus
    var tooltip = document.getElementById("chart-tooltip");
    var ttTitle = document.getElementById("tt-title");
    var ttObserved = document.getElementById("tt-observed");
    var ttRemaining = document.getElementById("tt-remaining");
    var ttUsed = document.getElementById("tt-used");
    var ttReset = document.getElementById("tt-reset");
    var ttFreshness = document.getElementById("tt-freshness");

    function populateTooltip(dot) {
      if (ttTitle) ttTitle.textContent = dot.getAttribute("data-meter") || "Sample";
      if (ttObserved) ttObserved.textContent = dot.getAttribute("data-observed") || "—";
      if (ttRemaining) ttRemaining.textContent = dot.getAttribute("data-remaining") + "%";
      if (ttUsed) ttUsed.textContent = dot.getAttribute("data-used") + "%";
      if (ttReset) ttReset.textContent = dot.getAttribute("data-reset") || "—";
      if (ttFreshness) ttFreshness.textContent = dot.getAttribute("data-freshness") || "—";
      if (tooltip) tooltip.style.opacity = "1";
    }

    document.querySelectorAll(".sample-dot").forEach(function(dot) {
      dot.addEventListener("mouseenter", function() { populateTooltip(dot); });
      dot.addEventListener("mousemove", function(e) {
        if (!tooltip) return;
        tooltip.style.left = (e.pageX + 12) + "px";
        tooltip.style.top = (e.pageY - 24) + "px";
      });
      dot.addEventListener("mouseleave", function() {
        if (tooltip) tooltip.style.opacity = "0";
      });
      dot.addEventListener("focus", function() {
        populateTooltip(dot);
        var rect = dot.getBoundingClientRect();
        if (tooltip) {
          tooltip.style.left = (window.scrollX + rect.left + 12) + "px";
          tooltip.style.top = (window.scrollY + rect.top - 24) + "px";
        }
      });
      dot.addEventListener("blur", function() {
        if (tooltip) tooltip.style.opacity = "0";
      });
    });
  })();
  </script>
</body>
</html>`;
}

/**
 * Write HTML browser report snapshot to destination with restrictive permissions (0o600).
 * Atomically refuses to overwrite an existing destination unless options.force is true.
 */
export async function writeBrowserReport(
  requestedPath: string,
  model: DashboardModel,
  options: WriteBrowserReportOptions = {}
): Promise<{ path: string; bytes: number }> {
  const cwd = options.cwd ?? process.cwd();
  let resolved = resolve(cwd, requestedPath);

  // If destination is an existing directory, resolve default filename inside it
  try {
    const existing = await lstat(resolved);
    if (existing.isDirectory()) {
      resolved = join(resolved, "headroom-report.html");
    }
  } catch (err: unknown) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw err;
  }

  // Reject symlinks
  try {
    const existing = await lstat(resolved);
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${resolved}`);
    }
    if (existing.isDirectory()) {
      throw new Error(`Refusing to overwrite directory: ${resolved}`);
    }
  } catch (err: unknown) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw err;
  }

  // Ensure parent directory exists
  await mkdir(dirname(resolved), { recursive: true });

  const html = renderBrowserReport(model);

  if (!options.force) {
    // Atomically refuse existing destination using O_EXCL | O_CREAT ("wx") and mode 0o600
    try {
      const handle = await open(resolved, "wx", 0o600);
      try {
        await handle.writeFile(html, "utf8");
      } finally {
        await handle.close();
      }
    } catch (err: unknown) {
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing file: ${resolved} (use --force to overwrite)`);
      }
      throw err;
    }
  } else {
    // Explicit force: atomic replace with mode 0o600
    await writeFileAtomic(resolved, html, 0o600);
  }

  const info = await lstat(resolved);
  return { path: resolved, bytes: info.size };
}

/** CLI entrypoint for headroom dashboard --html <path> [--force]. */
export async function htmlReportCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help")) {
    console.log("Usage: headroom dashboard --html <path> [--force]");
    return 0;
  }

  const htmlIndex = argv.indexOf("--html");
  const pathArg = htmlIndex >= 0 ? argv[htmlIndex + 1] : undefined;
  if (!pathArg || pathArg.startsWith("--")) {
    throw new Error("Usage: headroom dashboard --html <path> [--force]");
  }

  const force = argv.includes("--force") || argv.includes("--overwrite");
  const model = await gatherDashboard();
  const result = await writeBrowserReport(pathArg, model, { force });

  console.log(result.path);
  return 0;
}
