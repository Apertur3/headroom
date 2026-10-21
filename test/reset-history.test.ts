import { describe, expect, it } from "vitest";
import { renderResetsSection, resetHistory, resetSummary } from "../src/reset-history.js";
import type { HeadroomEvent } from "../src/types.js";

const now = new Date("2026-10-20T12:00:00.000Z");
const ago = (days: number, minutes = 0): string => new Date(now.getTime() - days * 86_400_000 + minutes * 60_000).toISOString();

function event(kind: HeadroomEvent["kind"], created_at: string, meter: string | null, principal: string, metadata: HeadroomEvent["metadata"] = null): HeadroomEvent {
  return { id: `${kind}-${created_at}-${meter}`, kind, origin: "inferred", confidence: 0.8, evidence_observation_ids: [], created_at, corrected_by: null, meter_id: meter, principal_id: principal, reason: null, last_seen_at: null, metadata };
}

describe("resetHistory", () => {
  const events = [
    event("reset_seen", ago(20), "acme:main", "acme", { window_minutes: 10_080 }),
    event("reset_seen", ago(10), "acme:main", "acme", { unscheduled: true, previous_used_percent: 40 }),
    event("reset_seen", ago(5), "acme:main", "acme", { unscheduled: true, previous_used_percent: 70 }),
    // one banked reset recorded on two meters of the same principal
    event("free_reset_used", ago(5, 2), "acme:credits", "acme"),
    event("free_reset_used", ago(5, 1), "acme:main", "acme"),
    event("reset_seen", ago(3), "acme:main", "acme", { window_minutes: 300 }),
    event("reset_seen", ago(31), "acme:main", "acme", { unscheduled: true, previous_used_percent: 99 }),
    event("reset_seen", ago(2), "other:main", "other", { unscheduled: true, previous_used_percent: 10 }),
  ];
  const [acme, other] = resetHistory(events, now);

  it("classifies scheduled, early and banked and sums usage given back", () => {
    expect([acme.scheduled, acme.banked, acme.early]).toEqual([1, 1, 1]);
    expect(acme.given_back).toBe(110);
    expect(acme.last_scheduled).toBe(ago(20));
    expect(acme.resets.map((r) => r.class)).toEqual(["banked", "early", "scheduled"]);
  });

  it("does not match a free reset of another principal and drops resets past 30 days and sub-daily windows", () => {
    expect(other.early).toBe(1);
    expect(acme.resets).toHaveLength(3);
  });

  it("renders only shown meters", () => {
    const esc = (v: unknown): string => String(v).replace(/</g, "&lt;");
    expect(resetSummary(acme)).toBe("1 early by vendor, 1 banked, 1 scheduled in 30d, 110% usage given back");
    expect(renderResetsSection([acme, other], new Set(["acme:main"]), esc)).toContain("acme:main");
    expect(renderResetsSection([acme, other], new Set(["acme:main"]), esc)).not.toContain("other:main");
    expect(renderResetsSection([acme], new Set(), esc)).toBe("");
  });
});
