import { formatClockTime, formatResetsIn } from "./resets.js";
import { redact } from "./security.js";
import type { HeadroomEvent, Observation } from "./types.js";

function clean(value: string): string { return redact(value).replace(/[\r\n\t]+/g, " ").trim(); }

function planVendor(principal: string): string {
  return principal.split("-")[0].replace(/^./, (letter) => letter.toUpperCase()) || humanName(principal);
}

export function planDowngradeText(principal: string, from: string, to: string, since: string, reminder = false): string {
  const vendor = planVendor(principal);
  const at = formatClockTime(new Date(since));
  const prefix = reminder ? "🚨 PLAN DOWNGRADED REMINDER:" : "🚨 PLAN DOWNGRADED:";
  return `${prefix} ${vendor} is now on the ${clean(to)} plan (was ${clean(from)}) since ${at}. Do NOT use a reset credit. Dispatches are refused until you run: headroom ack plan ${clean(principal)}`;
}

export function humanName(value: string): string {
  const words = clean(value).replace(/[-_:]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function subject(principal: string | null, meter: string | null): string {
  const parts = meter?.split(":") ?? [];
  const name = humanName(principal ?? parts[0] ?? "Source");
  const bucket = parts.slice(1).join(" ");
  return bucket && !["all", "main", "credits", "capacity"].includes(bucket) ? `${name} ${humanName(bucket)}` : name;
}

function windowName(minutes: number | null | undefined): string {
  if (minutes === 10_080) return "weekly";
  if (!minutes) return "";
  return formatResetsIn(minutes * 60);
}

function dateText(value: string | null | undefined, clock = true): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  return clock ? `${day} ${formatClockTime(date)}` : day;
}

function message(headline: string, facts: string, consequence?: string): string {
  return [headline, clean(facts), consequence].filter(Boolean).join("\n");
}

/** Event evidence is ordered oldest first. No live reading replaces a historical fact. */
export function eventText(event: HeadroomEvent, evidence: Observation[] = [], siblings: Observation[] = []): string {
  const current = evidence.at(-1);
  const previous = evidence.length > 1 ? evidence[0] : undefined;
  const name = subject(event.principal_id, event.meter_id);
  const principal = humanName(event.principal_id ?? "Source");
  const minutes = event.metadata?.window_minutes ?? current?.window?.minutes;
  const window = windowName(minutes);
  const meter = `${name}${window ? ` ${window}` : ""}`;
  const count = current?.metadata?.free_resets_available ?? (current?.quantity?.unit === "credits" ? current.quantity.remaining : null);
  const expiry = dateText(current?.resets_at, false);
  switch (event.kind) {
    case "reset_seen": {
      const used = event.metadata?.used_percent ?? current?.quantity?.used;
      const was = event.metadata?.previous_used_percent ?? previous?.quantity?.used;
      const at = formatClockTime(new Date(event.created_at));
      if (event.metadata?.unscheduled) return message("🔄 Unscheduled reset",
        `${meter} is back${used == null ? "" : ` to ${Math.round(used)}%`}${was == null ? "" : ` (was ${Math.round(was)}%)`} at ${at}.`,
        minutes === 10_080 ? "Plan again: a full week of capacity appeared." : "Plan again: capacity appeared ahead of schedule.");
      const sibling = siblings.find((row) => row.meter_id === event.meter_id && row.window?.minutes && row.window.minutes !== minutes && row.freshness === "fresh" && row.quantity?.unit === "percent");
      return message(minutes === 10_080 ? "🗓️ Weekly reset" : "🗓️ Scheduled reset",
        `${meter}${used == null ? " reset" : ` is at ${Math.round(used)}% again`} (reset ${at}).`,
        sibling ? `${windowName(sibling.window?.minutes)} is still at ${Math.round(sibling.quantity!.used)}%. Plan with both windows in mind.` : "Capacity is available again in this window.");
    }
    case "free_reset_granted": return message("🎁 Free reset credit granted",
      count == null ? `${principal} received a reset credit.` : `${principal} now has ${Math.round(count)}${expiry ? ` (expire ${expiry})` : ""}.`, "Use a credit when you need more capacity.");
    case "free_reset_used": return event.metadata?.credit_spent_on_free_plan === true
      ? "🚨 A reset credit was just spent on the free plan"
      : message("🎟️ Free reset used", `${name}${count == null ? " used a reset" : ` now has ${Math.round(count)} reset credits left`}.`, "Check the refreshed allowance before planning more work.");
    case "credits_changed": return message("🪙 Credits changed", count == null ? `${principal}'s credit balance changed.` : `${principal} now has ${Math.round(count)} reset credits.`, "Check the balance before using another credit.");
    case "plan_changed": {
      const from = typeof event.metadata?.from_plan === "string" ? clean(event.metadata.from_plan) : previous?.metadata?.plan ? clean(previous.metadata.plan) : "previous plan";
      const to = typeof event.metadata?.to_plan === "string" ? clean(event.metadata.to_plan) : current?.metadata?.plan ? clean(current.metadata.plan) : "new plan";
      const at = formatClockTime(new Date(event.created_at));
      const downgrade = event.metadata?.downgrade === true;
      if (event.metadata?.restored === true) return `📈 plan restored\n${planVendor(event.principal_id ?? "") } is now on the ${to} plan. Dispatches are allowed again.`;
      if (event.metadata?.downgrade === undefined) return message("📋 Plan changed", current?.metadata?.plan ? `${principal} is now on ${clean(current.metadata.plan)}${previous?.metadata?.plan ? ` (was ${clean(previous.metadata.plan)})` : ""}.` : `${principal}'s plan changed.`, "Check your new limits before planning work.");
      if (downgrade) return planDowngradeText(event.principal_id ?? "unknown", from, to, event.created_at);
      return message("📈 Plan changed", `${principal} plan changed: ${from} to ${to} at ${at}.`, "Allowances may have increased; check the new limits before planning work.");
    }
    case "exhausted_reported": {
      const reset = dateText(current?.resets_at ?? (typeof event.metadata?.resets_at === "string" ? event.metadata.resets_at : undefined));
      return `🛑 ${name} reports its limit reached${reset ? `; resets ${reset}` : ""}. Dispatches to ${name} are refused until then.`;
    }
    case "window_retired": return message("🧹 Window retired", `${meter} is no longer reported by the vendor.`, "It no longer participates in dispatch decisions.");
    case "source_failed": {
      const duration = Math.max(0, Math.floor((Date.parse(event.last_seen_at ?? event.created_at) - Date.parse(event.created_at)) / 60_000));
      const reason = clean(event.reason ?? current?.reason ?? "");
      const status = /\b[45][0-9]{2}\b/.exec(reason)?.[0];
      return message("⚠️ Source failed", `${name} has not answered${duration ? ` for ${duration} minutes` : ""}${reason ? ` (${status ?? reason.split(";")[0].slice(0, 100)})` : ""}.`, "Rows read UNKNOWN until it recovers.");
    }
    case "source_recovered": return message("✅ Source recovered", `${name} is reading again.`, "Fresh readings are available for planning.");
    case "pace_projection_conserve": {
      const reason = clean(event.reason ?? "");
      const projection = /^burning (\d+)%\/h, empty in (.+), reset in (.+)$/.exec(reason);
      return message("🐢 Projected stall", projection ? `${meter} burns ${projection[1]}%/h and would hit 100% in ${projection[2]}, reset in ${projection[3]}.` : `${meter} may run out before its reset.`, "Slow down to make this window last.");
    }
    case "model_new": return message("🆕 New model bucket seen", `${principal} now reports "${humanName(event.reason ?? event.meter_id?.split(":").at(-1) ?? "New model")}" as its own meter.`, "Check its allowance before routing work to it.");
    case "grant_lapsed": return message("🔑 Keychain grant lapsed", `${principal}.`, `Run: headroom keychain grant --principal ${clean(event.principal_id ?? "unknown")}`);
    case "lease_started": return message("▶️ Lease started", `${name} has a new work reservation.`, "Its reserved capacity is accounted for while the lease runs.");
    case "lease_ended": return message("🏁 Lease ended", `${name}'s work reservation ended.`, "Unused reserved capacity is available again.");
  }
}

export function thresholdText(observation: Observation, threshold: number): string {
  const name = subject(observation.principal_id, observation.meter_id);
  const date = dateText(observation.resets_at);
  const remaining = observation.resets_at ? formatResetsIn((Date.parse(observation.resets_at) - Date.parse(observation.fetched_at)) / 1000) : undefined;
  return message("🔥 Threshold", `${name} ${windowName(observation.window?.minutes)} crossed ${Math.round(threshold)}% (now ${Math.round(observation.quantity!.used)}%)${date ? `; resets ${date}, in ${remaining}` : "; reset time unknown"}.`, date ? "CONSERVE until then." : "CONSERVE until capacity returns.");
}
