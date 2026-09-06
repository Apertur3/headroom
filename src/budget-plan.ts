/**
 * Budget plan import: a small JSON file that says, ahead of time, how a
 * window's capacity is meant to be divided between sessions.
 *
 *   {
 *     "windows": [
 *       { "starts_at": "2026-09-06T09:00:00Z", "ends_at": "2026-09-06T14:00:00Z",
 *         "meter": "claude-main:all", "shares": { "session-a": 60, "session-b": 20 } }
 *     ]
 *   }
 *
 * Importing it starts one ordinary, advisory lease per share (owner = the
 * session id, expected percent = the share, expiring at the window's end), so
 * the plan needs no second reservation mechanism: `gate --owner`, `route`,
 * `can` and the spend ledger already understand leases and immediately see
 * the plan through them. A window that has already ended is skipped rather
 * than imported as an instantly expired lease.
 */
import { assertSessionId } from "./inbox.js";
import { exceedsJsonDepth } from "./security.js";

/** Nesting depth accepted in a plan file: `windows` -> a window -> `shares`
 * -> a number is 3, so anything past 6 is not a plan document. */
const MAX_PLAN_DEPTH = 6;

export interface BudgetPlanShare { owner: string; expect_percent: number }

export interface BudgetPlanWindow {
  starts_at: string;
  ends_at: string;
  meter: string;
  shares: BudgetPlanShare[];
}

export interface BudgetPlan { windows: BudgetPlanWindow[] }

function isoTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required and must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} is not a valid ISO timestamp: ${value}`);
  return new Date(parsed).toISOString();
}

/** Parses and fully validates a plan document. Every failure names the field
 * that caused it: an import that silently dropped a malformed window would
 * hand an orchestrator a budget nobody agreed to. */
export function parseBudgetPlan(text: string): BudgetPlan {
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new Error("plan file is not valid JSON"); }
  if (exceedsJsonDepth(raw, MAX_PLAN_DEPTH)) throw new Error("plan file is nested deeper than a plan document can be");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plan file must be an object with a windows array");
  const windowsValue = (raw as Record<string, unknown>).windows;
  if (!Array.isArray(windowsValue)) throw new Error("plan file must be an object with a windows array");
  if (!windowsValue.length) throw new Error("plan file has no windows");
  const windows = windowsValue.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`windows[${index}] must be an object`);
    const window = item as Record<string, unknown>;
    const startsAt = isoTime(window.starts_at, `windows[${index}].starts_at`);
    const endsAt = isoTime(window.ends_at, `windows[${index}].ends_at`);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error(`windows[${index}].ends_at must be after starts_at`);
    const meter = typeof window.meter === "string" ? window.meter.trim() : "";
    if (!meter) throw new Error(`windows[${index}].meter is required`);
    const sharesValue = window.shares;
    if (!sharesValue || typeof sharesValue !== "object" || Array.isArray(sharesValue)) throw new Error(`windows[${index}].shares must be an object of session id to percent`);
    const shares = Object.entries(sharesValue as Record<string, unknown>).map(([owner, percent]) => {
      let session: string;
      try { session = assertSessionId(owner); }
      catch (error) { throw new Error(`windows[${index}].shares has an invalid session id ${JSON.stringify(owner)}: ${error instanceof Error ? error.message : String(error)}`); }
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error(`windows[${index}].shares.${session} must be a number 0 through 100`);
      return { owner: session, expect_percent: percent };
    });
    if (!shares.length) throw new Error(`windows[${index}].shares is empty`);
    return { starts_at: startsAt, ends_at: endsAt, meter, shares };
  });
  return { windows };
}

export interface PlannedLease {
  owner: string;
  meter_id: string;
  expect_percent: number;
  ttl_ms: number;
  note: string;
}

/** The advisory leases a plan resolves to at `now`. A window already over
 * contributes nothing; a window still in the future is claimed from now
 * until its end, so a plan imported early is visible to `gate` immediately
 * rather than at the moment it starts. */
export function budgetPlanLeases(plan: BudgetPlan, now = new Date()): PlannedLease[] {
  const output: PlannedLease[] = [];
  for (const window of plan.windows) {
    const ttl = Date.parse(window.ends_at) - now.getTime();
    if (ttl <= 0) continue;
    for (const share of window.shares) {
      output.push({ owner: share.owner, meter_id: window.meter, expect_percent: share.expect_percent, ttl_ms: ttl, note: `plan ${window.starts_at}/${window.ends_at}` });
    }
  }
  return output;
}
