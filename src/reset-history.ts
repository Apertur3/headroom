import type { HeadroomEvent } from "./types.js";

export const RESET_HISTORY_DAYS = 30;
/** A banked (free) reset is recorded within this long of the window dropping. */
const BANKED_MATCH_MS = 5 * 60_000;

export type ResetClass = "scheduled" | "banked" | "early";

export interface ResetEntry { at: string; class: ResetClass; used_before: number | null }

export interface MeterResets {
  meter_id: string;
  scheduled: number;
  banked: number;
  early: number;
  /** Sum of used percent before the reset, over banked and early resets. */
  given_back: number;
  last_scheduled: string | null;
  resets: ResetEntry[];
}

/**
 * Classifies each reset_seen in the last 30 days per meter: scheduled, banked
 * (unscheduled with a free_reset_used on the same principal within minutes,
 * on any of its meters, so one banked reset is one reset), or early (the
 * vendor reset the window ahead of schedule). Newest reset first.
 */
export function resetHistory(events: HeadroomEvent[], now = new Date()): MeterResets[] {
  const since = now.getTime() - RESET_HISTORY_DAYS * 86_400_000;
  const free = events.filter((event) => event.kind === "free_reset_used" && event.principal_id);
  const byMeter = new Map<string, MeterResets>();
  for (const event of [...events].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    const at = Date.parse(event.created_at);
    if (event.kind !== "reset_seen" || !event.meter_id || !(at >= since && at <= now.getTime())) continue;
    const unscheduled = event.metadata?.unscheduled === true;
    const cls: ResetClass = !unscheduled ? "scheduled"
      : free.some((f) => f.principal_id === event.principal_id && Math.abs(Date.parse(f.created_at) - at) <= BANKED_MATCH_MS) ? "banked" : "early";
    const raw = event.metadata?.previous_used_percent;
    const used = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const meter = byMeter.get(event.meter_id) ?? { meter_id: event.meter_id, scheduled: 0, banked: 0, early: 0, given_back: 0, last_scheduled: null, resets: [] };
    meter[cls]++;
    if (cls === "scheduled") meter.last_scheduled ??= event.created_at;
    else meter.given_back += used ?? 0;
    meter.resets.push({ at: event.created_at, class: cls, used_before: used });
    byMeter.set(event.meter_id, meter);
  }
  return [...byMeter.values()].sort((a, b) => a.meter_id.localeCompare(b.meter_id));
}

export function resetSummary(meter: MeterResets): string {
  const parts = [meter.early ? `${meter.early} early by vendor` : "", meter.banked ? `${meter.banked} banked` : "", meter.scheduled ? `${meter.scheduled} scheduled` : ""].filter(Boolean);
  return `${parts.join(", ")} in ${RESET_HISTORY_DAYS}d${meter.given_back ? `, ${Math.round(meter.given_back)}% usage given back` : ""}`;
}

const CLASS_TEXT: Record<ResetClass, string> = { scheduled: "scheduled", banked: "banked free reset", early: "early by vendor" };

/** The report's "Resets" section; empty when no shown meter reset in the window. */
export function renderResetsSection(resets: MeterResets[] | undefined, shownMeters: ReadonlySet<string>, esc: (value: unknown) => string): string {
  const shown = (resets ?? []).filter((meter) => shownMeters.has(meter.meter_id));
  if (!shown.length) return "";
  const when = (at: string): string => esc(new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC");
  return `<section class="block" id="resets-section">
      <h2>Did a limit reset early?</h2>
      <p class="takeaway">Resets seen in the last ${RESET_HISTORY_DAYS} days. Early and banked resets give back usage already spent.</p>
      ${shown.map((meter) => `<details${meter.early + meter.banked ? " open" : ""}>
        <summary><strong>${esc(meter.meter_id)}</strong> <span class="muted">${esc(resetSummary(meter))}${meter.last_scheduled ? `; last scheduled reset ${when(meter.last_scheduled)}` : ""}</span></summary>
        <table class="data-table">
          <thead><tr><th>Time</th><th>Kind</th><th>Used before</th></tr></thead>
          <tbody>${meter.resets.map((reset) => `<tr><td class="mono">${when(reset.at)}</td><td>${CLASS_TEXT[reset.class]}</td><td class="mono">${reset.used_before === null ? "—" : `${Math.round(reset.used_before)}%`}</td></tr>`).join("")}</tbody>
        </table>
      </details>`).join("")}
    </section>`;
}
