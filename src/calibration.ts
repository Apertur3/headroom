/**
 * Fallback conversion ratios between a 5-hour window's percent and a weekly
 * window's percent, used only when no learned per-lane or per-class cost
 * exists yet. Measured on a live orchestrator running Claude Max 20x
 * (docs/reports/dogfood/2026-09-05-orchestrator.md): fully spending one
 * 5-hour window costs about 22 weekly points, and eight parallel build lanes
 * running together burn about 22 weekly points per hour.
 */
export const WEEKLY_POINTS_PER_FULL_5H_WINDOW = 22;
export const MEASURED_PARALLEL_LANES = 8;
export const WEEKLY_POINTS_PER_HOUR_AT_MEASURED_PARALLELISM = 22;
export const WEEKLY_POINTS_PER_LANE_PER_HOUR = WEEKLY_POINTS_PER_HOUR_AT_MEASURED_PARALLELISM / MEASURED_PARALLEL_LANES;

/** Convert a 5-hour-window percent cost into the weekly percent it costs,
 * using the measured ratio: fully spending a 5h window (100%) costs about
 * WEEKLY_POINTS_PER_FULL_5H_WINDOW weekly points. */
export function fiveHourPercentToWeeklyPercent(fiveHourPercent: number): number {
  return fiveHourPercent * (WEEKLY_POINTS_PER_FULL_5H_WINDOW / 100);
}
