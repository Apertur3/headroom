#!/usr/bin/env node
import { readPolicy, readRouting, seedExampleConfig } from "./config.js";
import { realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { appendDaemonLog, tailDaemonLog } from "./logs.js";
import { doctor } from "./doctor.js";
import { engineStatus, installEngine, installNativeEngine } from "./engine/codexbar/install.js";
import { observeLocal } from "./engine/local.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { ClaudeProbeError, claudeGrantGate, claudeResponseShape, grantClaudeKeychainAccess, probeBinaryHash, syncClaudeGrantState } from "./adapters/claude.js";
import { formatStatuslineBar, snapshotFromStatuslinePayload, statuslineProfile } from "./adapters/claude-statusline.js";
import { codexResponseShape } from "./adapters/codex.js";
import { antigravityResponseShape } from "./adapters/antigravity.js";
import { pollAccounts } from "./collector.js";
import { daemonRequest, socketPath, HeadroomDaemon } from "./daemon.js";
import { serveMcp } from "./mcp.js";
import { canRouteWithLeases, paceDecision, unknownMeterPrincipals, type CanDecision } from "./policy.js";
import { withPaceInfo } from "./pace.js";
import { buildCostEstimate, type CostEstimate, type LearnedCost } from "./cost.js";
import { parseGateNeed, waitForReset, type FillClassFit, type GateNeed, type PlanResult } from "./pacing.js";
import { fillFor, gateFor, pickDecidingObservation, planFor, rateLines, routeFor, type RateLine, type RouteResult } from "./orchestrator-reads.js";
import { accountsPath, accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "./registry.js";
import { headroomHome, migrateLegacyHome } from "./paths.js";
import { formatResetsIn, resetsIn, withResetsIn } from "./resets.js";
import { safeError, stripAmbientProxyEnvironment } from "./security.js";
import { installService, uninstallService } from "./service.js";
import { modelTokenShare } from "./session-logs.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type Lease, type Observation, type PaceState, type HeadroomEvent, type ProviderAccount } from "./types.js";
import { headroomVersion } from "./version.js";

function since(value: string | undefined): string {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? "24h");
  if (!match) throw new Error("--since must be like 15m, 24h, or 7d");
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - Number(match[1]) * multiplier).toISOString();
}

function formatReset(value: string | null | undefined): string {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function label(observation: Observation): string {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

function windowKey(observation: Observation): string { return `${observation.meter_id}:${observation.window?.minutes ?? "none"}`; }

/** A whole-percent rate reads cleanly at a glance ("22%/h"); rounding a rate
 * under 1%/h the same way collapses it to a bare "0%/h" and reads as no
 * activity at all, so those get one decimal instead ("0.1%/h"). Exactly
 * zero still prints as a plain "0%/h" -- there's no precision to preserve. */
function formatRatePercent(value: number): string {
  const text = value !== 0 && Math.abs(value) < 1 ? value.toFixed(1) : String(Math.round(value));
  return `${text}%/h`;
}

/** The short pace segment appended to a window's status line once its burn
 * rate is known: the live burn alongside the sustainable pace that would
 * exactly spend the remaining allowance by reset, so a glance says whether
 * the current rate is faster or slower than that line. Omitted entirely
 * (not "burn 0%/h") when burn itself is null -- fewer than two fresh
 * samples in the lookback, nothing to report yet. */
function paceSegment(observation: Observation): string {
  const burn = observation.burn_percent_per_hour;
  if (burn === null || burn === undefined) return "";
  const sustainable = observation.sustainable_percent_per_hour;
  const sustainableText = sustainable === null || sustainable === undefined ? "?" : formatRatePercent(sustainable);
  return ` burn ${formatRatePercent(burn)}, ok ${sustainableText}`;
}

function formatWindow(observation: Observation, state: PaceState, reason: string, resetSeen?: string, freeResetUsed?: string): string {
  if (observation.window?.kind === "count" && observation.quantity?.unit === "credits") {
    const available = observation.quantity.remaining ?? 0;
    const date = observation.resets_at ? new Date(observation.resets_at) : undefined;
    const expiry = date && !Number.isNaN(date.getTime()) ? ` (expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)})` : "";
    return `credits ${available} available${expiry}`;
  }
  const evidence = `${resetSeen ? ` reset seen ${formatReset(resetSeen)}` : ""}${freeResetUsed ? ` free reset ${formatReset(freeResetUsed)}` : ""}`;
  if (state === "NOT_ENFORCED") return `${label(observation)} n/a${observation.reason ? ` (${observation.reason})` : ""}`;
  if (!observation.quantity || state === "UNKNOWN") return `${label(observation)} UNKNOWN (${observation.reason ?? reason})${evidence}`;
  const seconds = resetsIn(observation.resets_at).resets_in_seconds;
  const countdown = seconds === null ? "" : ` (in ${formatResetsIn(seconds)})`;
  return `${label(observation)} ${Math.round(observation.quantity.used)}% ↻${formatReset(observation.resets_at)}${countdown} ${state}${evidence}${paceSegment(observation)}`;
}

function formatLocal(observation: Observation): string {
  const state = observation.metadata?.state ?? "DOWN";
  if (state === "DOWN") {
    const wake = observation.reason?.match(/(?:^|; )wake: (.+)$/)?.[1];
    return wake ? `${observation.meter_id}  DOWN (wake: ${wake})` : `${observation.meter_id}  DOWN (${observation.reason ?? "down"})`;
  }
  const model = observation.metadata?.model_ids?.[0] ?? "unknown";
  return `${observation.meter_id}  ${state} model=${model} running=${observation.metadata?.running ?? observation.quantity?.used ?? 0} waiting=${observation.metadata?.waiting ?? 0}`;
}

/** Only fall back to SQLite when no daemon socket exists. A socket which cannot
 * answer health is an operational problem, not permission to race its writer. */
async function requestDaemon(method: string, params: Record<string, unknown> = {}): Promise<unknown | undefined> {
  const request = await daemonRequest(socketPath(), method, params);
  if (request.status === "available") return request.result;
  if (request.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
  return undefined;
}

function age(observation: Observation): string {
  const milliseconds = Math.max(0, Date.now() - new Date(observation.fetched_at).getTime());
  return milliseconds < 60_000 ? "<1m" : `${Math.floor(milliseconds / 60_000)}m`;
}

function windowOrder(observation: Observation): number {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return 0;
  if (minutes === 10_080) return 1;
  return 2;
}

export interface ThresholdWindow {
  meter_id: string;
  window_minutes: number | null;
  used_percent: number | null;
  crossed: boolean;
  blocking: boolean;
  freshness: Observation["freshness"];
}

export function thresholdReport(observations: Observation[], threshold: number): ThresholdWindow[] {
  return observations.map((item) => {
    const used = item.quantity?.unit === "percent" ? item.quantity.used : null;
    const crossed = item.freshness !== "not_enforced" && used !== null && used >= threshold;
    const blocking = item.freshness !== "not_enforced" && (item.freshness !== "fresh" || crossed);
    return { meter_id: item.meter_id, window_minutes: item.window?.minutes ?? null, used_percent: used, crossed, blocking, freshness: item.freshness };
  });
}

export function formatMeters(observations: Observation[], policy: Awaited<ReturnType<typeof readPolicy>>, resetSeen = new Map<string, string>(), leases = new Map<string, Lease[]>(), freeResetUsed = new Map<string, string>()): string[] {
  const meters = new Map<string, Observation[]>();
  for (const observation of observations) meters.set(observation.meter_id, [...(meters.get(observation.meter_id) ?? []), observation]);
  return [...meters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([meter, windows]) => {
    const ordered = [...windows].sort((a, b) => windowOrder(a) - windowOrder(b) || (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER));
    if (ordered.length === 1 && ordered[0].window?.kind === "state") return formatLocal(ordered[0]);
    const enforced = ordered.filter((item) => item.freshness !== "not_enforced");
    const freshness = !enforced.length ? "not enforced" : enforced.some((item) => item.freshness === "fresh") ? "fresh" : enforced.some((item) => item.freshness === "failed") ? "failed" : "stale";
    const active = leases.get(meter) ?? [];
    const leaseLabel = active.length ? ` leases: ${active.length} (${active.map((item) => item.owner).join(", ")})` : "";
    return `${meter}  ${ordered.map((item) => {
      const decision = paceDecision(item, policy);
      return formatWindow(item, decision.state, decision.reason, resetSeen.get(windowKey(item)), freeResetUsed.get(windowKey(item)));
    }).join(" | ")}  (${freshness} ${age(ordered[0])})${leaseLabel}`;
  });
}

async function history(argv: string[]): Promise<number> {
  const meter = argv[0];
  if (!meter) throw new Error("Usage: headroom history <meter> [--since 24h]");
  const at = argv.indexOf("--since");
  const request = await requestDaemon("history", { meter, since: since(at >= 0 ? argv[at + 1] : undefined) });
  if (request !== undefined) { console.log(JSON.stringify(unwrapRpc(request))); return 0; }
  directReadNotice();
  const store = await HeadroomStore.open();
  try {
    const items = store.history(meter, since(at >= 0 ? argv[at + 1] : undefined));
    store.audit("cli", "history", meter, "ok");
    console.log(JSON.stringify(items));
    return 0;
  } finally { store.close(); }
}

async function events(argv: string[]): Promise<number> {
  const at = argv.indexOf("--since");
  const table = argv.includes("--table");
  const request = await requestDaemon("events", { since: since(at >= 0 ? argv[at + 1] : undefined) });
  if (request !== undefined) { printEventsOutput(unwrapRpc(request) as HeadroomEvent[], table); return 0; }
  directReadNotice();
  const store = await HeadroomStore.open();
  try {
    const items = store.events(since(at >= 0 ? argv[at + 1] : undefined));
    store.audit("cli", "events", null, "ok");
    printEventsOutput(items, table);
    return 0;
  } finally { store.close(); }
}

/** The default output is always a JSON array, empty allowed, so a scripted
 * caller never has to special-case a quiet period. --table is the only path
 * to the human-readable rendering. */
export function printEventsOutput(items: HeadroomEvent[], table: boolean): void {
  if (!table) { console.log(JSON.stringify(items)); return; }
  printEvents(items);
}

function printEvents(items: HeadroomEvent[]): void {
  for (const item of items) {
    const subject = item.meter_id ?? item.principal_id ?? "-";
    const event = item.kind === "reset_seen" ? `reset seen ${formatReset(item.created_at)}`
      : item.kind === "free_reset_used" ? `free reset used ${formatReset(item.created_at)}${item.reason ? ` (${item.reason})` : ""}`
      : item.kind;
    console.log(`${subject}  ${event} (${item.origin}, ${Math.round(item.confidence * 100)}%)`);
  }
}

async function can(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action) throw new Error("Usage: headroom can <action-class> --owner <name> [--allow-unknown] [--expect <percent>] [--lease] [--ttl 30m] [--json]");
  const ownerAt = argv.indexOf("--owner");
  const owner = ownerAt >= 0 ? argv[ownerAt + 1] : undefined;
  if (!owner) throw new Error("--owner is required");
  const expectValue = option(argv, "--expect");
  const expectOverride = expectValue === undefined ? null : Number(expectValue);
  if (expectOverride !== null && (!Number.isFinite(expectOverride) || expectOverride < 0 || expectOverride > 100)) throw new Error("--expect must be 0 through 100");
  const leaseFlag = argv.includes("--lease");
  const routing = await readRouting();
  if (!routing.present) throw new Error("No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action}`);
  const accounts = await readAccounts();
  const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
  if (unknownMeters.length) throw new Error(`Routing action class ${action} names unknown meter(s): ${unknownMeters.join(", ")}`);

  const request = await requestDaemon("can", { action_class: action, allow_unknown: argv.includes("--allow-unknown"), owner });
  let decision: CanDecision;
  if (request !== undefined) {
    decision = unwrapRpc(request) as CanDecision;
  } else {
    directReadNotice();
    const [policy, directStore] = await Promise.all([readPolicy(), HeadroomStore.open()]);
    try {
      const localAccounts = accounts.filter(isLocalAccount);
      // With no daemon, `can` is also a direct read: refresh local state rather
      // than deciding a routing preference from an old queue-depth sample.
      directStore.insertAll(await Promise.all(localAccounts.map(observeLocal)));
      const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
      const allMeters = [...new Set([...meters, ...localMeters])];
      const now = new Date();
      const rows = new Map(allMeters.map((meter) => [meter, directStore.latestPerWindow(meter)]));
      const burn = directStore.burnRateFor([...rows.values()].flat(), now);
      const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
      decision = canRouteWithLeases(meters, localMeters, enriched, routing.local_preference, policy, argv.includes("--allow-unknown"), directStore.leases(undefined, true), owner, now);
      directStore.audit("cli", "can", action, decision.allowed ? "yes" : "no");
    } finally { directStore.close(); }
  }

  // The learned-cost/max-more/optional-lease report is a direct read
  // regardless of the daemon: it is advisory bookkeeping over the same
  // on-disk store the daemon also writes to, not a vendor call, so it never
  // needs a daemon round trip of its own (see store.ts's WAL comment on
  // safe concurrent direct reads).
  const store = await HeadroomStore.open();
  let cost: CostEstimate;
  let leasedId: string | undefined;
  try {
    const learned = store.learnedCost(action)[0];
    const deciding = pickDecidingObservation(store.latestPerWindow(decision.meter));
    const remaining = deciding?.quantity?.unit === "percent" ? deciding.quantity.remaining ?? (deciding.quantity.limit !== null ? deciding.quantity.limit - deciding.quantity.used : null) : null;
    cost = buildCostEstimate(action, expectOverride, learned as LearnedCost | undefined, remaining);
    if (leaseFlag && decision.allowed && cost.expected_percent !== null) {
      const lease = store.startLease(owner, decision.meter, cost.expected_percent, ttl(option(argv, "--ttl")), `can:${action}`, new Date(), action);
      store.audit("cli", "lease_start", `${owner}:${decision.meter}`, "ok");
      leasedId = lease.id;
    }
  } finally { store.close(); }

  printCan(decision, cost, leasedId, argv.includes("--json"));
  return decision.allowed ? 0 : 2;
}

function ttl(value: string | undefined, flag = "--ttl"): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value ?? "30m");
  if (!match) throw new Error(`${flag} must be like 5s, 30m, 2h, or 1d`);
  const multiplier = match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * multiplier;
}

function option(argv: string[], name: string): string | undefined { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }

function printLeases(items: Lease[]): void {
  for (const item of items) console.log(`${item.id}  ${item.owner}  ${item.meter_id}  expect ${item.expected_percent ?? "-"}%  spent ${item.spent_percent.toFixed(2)}%  ${item.ended_at ? item.ended_reason ?? "ended" : `expires ${item.expires_at}`}${item.note ? `  ${item.note}` : ""}`);
}

export function endedLeaseMessage(lease: Lease): string { return lease.already_ended ? `already ended ${lease.id} (owner ${lease.owner})` : `ended ${lease.id} (owner ${lease.owner})`; }

async function lease(argv: string[]): Promise<number> {
  if (argv[0] === "start") {
    const owner = option(argv, "--owner"); const meter = option(argv, "--meter"); const expect = option(argv, "--expect"); const note = option(argv, "--note"); const actionClass = option(argv, "--class");
    if (!owner || !meter) throw new Error("Usage: headroom lease start --owner <name> --meter <meter_id> [--expect <percent>] [--ttl 30m] [--note ...] [--class <action-class>]");
    const expected = expect === undefined ? null : Number(expect);
    if (expected !== null && (!Number.isFinite(expected) || expected < 0 || expected > 100)) throw new Error("--expect must be 0 through 100");
    const params = { owner, meter_id: meter, expected_percent: expected, ttl_ms: ttl(option(argv, "--ttl")), note: note ?? null, action_class: actionClass ?? null };
    const request = await requestDaemon("lease_start", params);
    if (request !== undefined) { console.log((unwrapRpc(request) as Lease).id); return 0; }
    directReadNotice(); const store = await HeadroomStore.open(); try { const created = store.startLease(params.owner, params.meter_id, params.expected_percent, params.ttl_ms, params.note, new Date(), params.action_class); store.audit("cli", "lease_start", meter, "ok"); console.log(created.id); return 0; } finally { store.close(); }
  }
  if (argv[0] === "end") {
    const id = argv[1]; const owner = option(argv, "--owner"); if (!id) throw new Error("Usage: headroom lease end <id> [--owner <name>] [--force]");
    if (!owner) throw new Error("Usage: headroom lease end <id> --owner <name> [--force]");
    try {
      const params = { id, owner, force: argv.includes("--force") }; const request = await requestDaemon("lease_end", params);
      if (request !== undefined) { console.log(endedLeaseMessage(unwrapRpc(request) as Lease)); return 0; }
      directReadNotice(); const store = await HeadroomStore.open(); try { const ended = store.endLease(id, owner, params.force); store.audit("cli", params.force && ended.owner !== owner ? "lease_force_end" : "lease_end", params.force && ended.owner !== owner ? `${owner}->${ended.owner}` : ended.meter_id, "ok"); console.log(endedLeaseMessage(ended)); return 0; } finally { store.close(); }
    } catch (error) {
      // An owner mismatch is an expected refusal, not an opaque CLI failure.
      console.error(safeError(error));
      return 1;
    }
  }
  if (argv[0] === "list") {
    const request = await requestDaemon("leases");
    if (request !== undefined) { printLeases(unwrapRpc(request) as Lease[]); return 0; }
    directReadNotice(); const store = await HeadroomStore.open(); try { const items = store.leases(); store.audit("cli", "leases", null, "ok"); printLeases(items); return 0; } finally { store.close(); }
  }
  throw new Error("Usage: headroom lease <start|end|list>");
}

async function cost(argv: string[]): Promise<number> {
  const actionClass = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  const asJson = argv.includes("--json");
  const request = await requestDaemon("cost", { action_class: actionClass });
  let items: LearnedCost[];
  if (request !== undefined) { items = unwrapRpc(request) as LearnedCost[]; }
  else {
    directReadNotice();
    const store = await HeadroomStore.open();
    try { items = store.learnedCost(actionClass); store.audit("cli", "cost", actionClass ?? null, "ok"); }
    finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(items)); return 0; }
  if (!items.length) { console.log(actionClass ? `no learned cost for ${actionClass} yet` : "no learned cost yet"); return 0; }
  for (const item of items) console.log(`${item.action_class}  median ${item.median_percent.toFixed(2)}% (IQR ${item.iqr_low.toFixed(2)}%-${item.iqr_high.toFixed(2)}%, n=${item.sample_count})`);
  return 0;
}

/** --window accepts a duration string (10m, 1h); --minutes takes a bare
 * number. Both set the same lookback; --window is the more ergonomic form
 * for a short burst-detection read like `rate --window 10m`. */
function rateLookbackMinutes(argv: string[]): number {
  const windowValue = option(argv, "--window");
  if (windowValue !== undefined) return ttl(windowValue, "--window") / 60_000;
  const minutesValue = option(argv, "--minutes");
  const minutes = minutesValue === undefined ? 30 : Number(minutesValue);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--minutes must be a positive number");
  return minutes;
}

async function rate(argv: string[]): Promise<number> {
  const meter = option(argv, "--meter");
  const minutes = rateLookbackMinutes(argv);
  const asJson = argv.includes("--json");
  const request = await requestDaemon("rate", { meter, minutes });
  let lines: RateLine[];
  if (request !== undefined) { lines = unwrapRpc(request) as RateLine[]; }
  else {
    directReadNotice();
    const store = await HeadroomStore.open();
    try { lines = rateLines(store, meter, minutes); store.audit("cli", "rate", meter ?? null, "ok"); }
    finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(lines)); return 0; }
  if (!lines.length) { console.log(meter ? `no readings for ${meter}` : "no readings"); return 0; }
  for (const line of lines) {
    if (line.reason !== undefined) { console.log(`${line.meter}  UNKNOWN (${line.reason})`); continue; }
    const windowLabel = line.window_minutes === 300 ? "5h" : line.window_minutes === 10_080 ? "wk" : line.window_minutes ? `${line.window_minutes}m` : "-";
    const usedText = line.used_percent === null ? "?" : `${Math.round(line.used_percent)}%`;
    if (line.burn_percent_per_hour === null) { console.log(`${line.meter}  ${windowLabel} ${usedText}  burn unknown (need 2+ fresh samples in the last ${minutes}m)`); continue; }
    const stall = line.empty_in_seconds === null ? "not projected to empty before reset" : `stall in ${formatResetsIn(line.empty_in_seconds)}`;
    console.log(`${line.meter}  ${windowLabel} ${usedText}  burn ${formatRatePercent(line.burn_percent_per_hour)}, ${stall}`);
  }
  return 0;
}

async function plan(argv: string[]): Promise<number> {
  const meter = option(argv, "--meter");
  if (!meter) throw new Error("Usage: headroom plan --meter <meter_id> --until reset --reserve <percent> [--json]");
  const until = option(argv, "--until");
  if (until !== "reset") throw new Error("--until must be 'reset' (the only supported value)");
  const reserveValue = option(argv, "--reserve");
  if (reserveValue !== undefined && (!Number.isFinite(Number(reserveValue)) || Number(reserveValue) < 0 || Number(reserveValue) > 100)) throw new Error("--reserve must be 0 through 100");
  const asJson = argv.includes("--json");
  const request = await requestDaemon("plan", { meter, reserve_percent: reserveValue === undefined ? undefined : Number(reserveValue) });
  let result: ({ meter: string } & PlanResult) | { meter: string; error: string };
  if (request !== undefined) { result = unwrapRpc(request) as typeof result; }
  else {
    directReadNotice();
    const policy = await readPolicy();
    const reserve = reserveValue === undefined ? policy.freeze_reserve_pct : Number(reserveValue);
    const store = await HeadroomStore.open();
    try { result = planFor(store, meter, reserve); store.audit("cli", "plan", meter, "ok"); } finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(result)); return 0; }
  // planFor's only error path is an unreadable/never-seen meter (no weekly
  // window at all) -- that is a data state to report, not a CLI failure, so
  // it renders like status's own UNKNOWN line and exits 0 rather than 1.
  if ("error" in result) { console.log(`${result.meter}  UNKNOWN (${result.error})`); return 0; }
  console.log(`${result.meter}  ${result.points_per_5h_window.toFixed(2)} pts/5h-window over ${result.remaining_5h_windows} window${result.remaining_5h_windows === 1 ? "" : "s"} (weekly remaining ${result.weekly_remaining_percent.toFixed(1)}%, reserve ${result.reserve_percent}%)  plan line ${result.plan_line_percent_per_hour.toFixed(2)}%/h`);
  return 0;
}

async function gate(argv: string[]): Promise<number> {
  const ownerAt = argv.indexOf("--owner");
  const owner = ownerAt >= 0 ? argv[ownerAt + 1] : undefined;
  const usage = "Usage: headroom gate --need 5h:N [--need wk:N] (--meter <meter_id> | --class <action-class> | --model <slug>) --owner <name> [--plan] [--plan-share N] [--json]";
  if (!owner) throw new Error(usage);
  const needs: GateNeed[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === "--need") needs.push(parseGateNeed(argv[index + 1] ?? ""));
  if (!needs.length) throw new Error("--need is required (5h:N or wk:N)");
  const meter = option(argv, "--meter");
  const actionClass = option(argv, "--class");
  const model = option(argv, "--model");
  // An omitted target used to fail closed silently over every known meter,
  // which read as a plain "NO" against whichever meter happened to sort
  // first rather than the one the caller actually meant.
  if (!meter && !actionClass && !model) throw new Error(usage);
  let target: string | string[] | undefined = meter;
  if (!meter && actionClass) {
    const routing = await readRouting();
    const meters = routing.consumes[actionClass];
    if (!meters) throw new Error(`Unknown action class: ${actionClass}`);
    target = meters;
  }
  // `--model fable` is a resolved shorthand for every configured Claude
  // principal's own `<principal>:fable` (or any other model-scoped) meter --
  // resolved here, client-side, so the daemon and MCP paths never need to
  // know the concept exists; they just see the same meter list `--meter`
  // would have given them directly.
  if (!meter && !actionClass && model) {
    const claudeAccounts = (await readAccounts()).filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude");
    if (!claudeAccounts.length) throw new Error("--model requires at least one configured Claude principal");
    target = claudeAccounts.map((account) => `${account.name}:${model}`);
  }
  const usePlan = argv.includes("--plan");
  const planShareValue = option(argv, "--plan-share");
  const planSharePercent = planShareValue === undefined ? undefined : Number(planShareValue);
  if (planSharePercent !== undefined && (!Number.isFinite(planSharePercent) || planSharePercent < 0)) throw new Error("--plan-share must be a non-negative percent");
  const asJson = argv.includes("--json");
  const options = { owner, planSharePercent, actionClass };
  const request = await requestDaemon("gate", { needs, meter: target, plan: usePlan, owner, plan_share_percent: planSharePercent, action_class: actionClass });
  let result: Awaited<ReturnType<typeof gateFor>>;
  if (request !== undefined) { result = unwrapRpc(request) as typeof result; }
  else {
    directReadNotice();
    const policy = await readPolicy();
    const store = await HeadroomStore.open();
    try { result = gateFor(store, needs, target, policy.freeze_reserve_pct, usePlan, new Date(), { ...options, pacing: policy.pacing }); store.audit("cli", "gate", meter ?? (Array.isArray(target) ? target.join(",") : null), result.allowed ? "yes" : "no"); } finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(result)); return 0; }
  const targetLabel = meter ?? (Array.isArray(target) ? target.join(", ") : actionClass);
  // A refusal because the meter's own usage could not be read at all (an
  // unreadable/never-seen window) is a different state than a refusal
  // because a known usage does not fit the request -- render it the same way
  // status/rate/plan/fill do, rather than as a plain "NO".
  if (result.unknown) { console.log(`${targetLabel}  UNKNOWN (${result.reason})`); return result.allowed ? 0 : 2; }
  const lanesRemaining = result.lanes_remaining_for_class !== undefined ? ` (${result.lanes_remaining_for_class === null ? "lane count unknown for " + actionClass : `${result.lanes_remaining_for_class} more ${actionClass} fit`})` : "";
  console.log(`${result.allowed ? "YES" : "NO"} ${targetLabel} (${result.reason})${lanesRemaining}`);
  return result.allowed ? 0 : 2;
}

async function wait(argv: string[]): Promise<number> {
  const meter = option(argv, "--meter");
  if (!meter || !argv.includes("--until-reset")) throw new Error("Usage: headroom wait --meter <meter_id> --until-reset [--max 6h]");
  const maxValue = option(argv, "--max");
  const maxMs = maxValue === undefined ? null : ttl(maxValue, "--max");
  // Set whenever a poll finds no windowed reading for this meter at all: the
  // meter's own latest reason (e.g. a pending Keychain grant), so the final
  // "unknown" outcome below can name why instead of a bare "resets_at
  // unknown". Kept from the last poll, since waitForReset stops polling as
  // soon as it decides there is nothing to wait on.
  let unknownReason: string | undefined;
  const getResetsAt = async (): Promise<string | null> => {
    const request = await requestDaemon("status");
    let observations: Observation[];
    if (request !== undefined) { observations = unwrapRpc(request) as Observation[]; }
    else {
      const store = await HeadroomStore.open();
      try { observations = store.latestPerWindow(meter); } finally { store.close(); }
    }
    const rows = observations.filter((item) => item.meter_id === meter && item.window?.kind !== "state" && item.window?.kind !== "count" && item.window?.minutes);
    const shortest = [...rows].sort((a, b) => (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER))[0];
    if (!shortest) unknownReason = observations.find((item) => item.meter_id === meter)?.reason ?? undefined;
    return shortest?.resets_at ?? null;
  };
  const outcome = await waitForReset(getResetsAt, maxMs);
  if (outcome === "reset") { console.log(`${meter} reset`); return 0; }
  if (outcome === "timeout") { console.error(`timed out waiting for ${meter} to reset${maxValue ? ` after ${maxValue}` : ""}`); return 3; }
  // Not a CLI failure: the meter's reading itself is unknown, the same data
  // state status/rate/plan/gate/fill all report the same way, and exiting 0
  // like they do lets a caller distinguish "don't know yet" from a real error.
  console.log(`${meter}  UNKNOWN (${unknownReason ?? "resets_at unknown"})`);
  return 0;
}

async function fill(argv: string[]): Promise<number> {
  const ownerAt = argv.indexOf("--owner");
  const owner = ownerAt >= 0 ? argv[ownerAt + 1] : undefined;
  const meter = option(argv, "--meter");
  if (!meter || !owner || !argv.includes("--until-reset")) throw new Error("Usage: headroom fill --meter <meter_id> --until-reset [--lane-cost <percent>] [--weekly-reserve <percent>] --owner <name> [--json]");
  const laneCostValue = option(argv, "--lane-cost");
  const laneCost = laneCostValue === undefined ? undefined : Number(laneCostValue);
  if (laneCost !== undefined && (!Number.isFinite(laneCost) || laneCost <= 0)) throw new Error("--lane-cost must be a positive percent");
  const weeklyReserveValue = option(argv, "--weekly-reserve");
  if (weeklyReserveValue !== undefined && (!Number.isFinite(Number(weeklyReserveValue)) || Number(weeklyReserveValue) < 0 || Number(weeklyReserveValue) > 100)) throw new Error("--weekly-reserve must be 0 through 100");
  const planShareValue = option(argv, "--plan-share");
  const planSharePercent = planShareValue === undefined ? undefined : Number(planShareValue);
  if (planSharePercent !== undefined && (!Number.isFinite(planSharePercent) || planSharePercent < 0)) throw new Error("--plan-share must be a non-negative percent");
  const asJson = argv.includes("--json");
  const request = await requestDaemon("fill", { meter, lane_cost_percent: laneCost, weekly_reserve_percent: weeklyReserveValue === undefined ? undefined : Number(weeklyReserveValue), owner, plan_share_percent: planSharePercent });
  let result: Awaited<ReturnType<typeof fillFor>>;
  if (request !== undefined) { result = unwrapRpc(request) as typeof result; }
  else {
    directReadNotice();
    const policy = await readPolicy();
    const weeklyReserve = weeklyReserveValue === undefined ? policy.freeze_reserve_pct : Number(weeklyReserveValue);
    const store = await HeadroomStore.open();
    try { result = await fillFor(store, meter, laneCost, weeklyReserve, new Date(), { owner, planSharePercent, pacing: policy.pacing }); store.audit("cli", "fill", meter, "ok"); } finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(result)); return 0; }
  // fillFor's only error path is an unreadable/never-seen meter (no enforced
  // window at all) -- a data state to report, not a CLI failure, so it
  // renders like status's own UNKNOWN line and exits 0 rather than 1 or 2.
  if ("error" in result) { console.log(`${result.meter}  UNKNOWN (${result.error})`); return 0; }
  const timeLeft = result.resets_in_seconds === null ? "?" : formatResetsIn(result.resets_in_seconds);
  if (result.lanes) console.log(`${result.meter}  ${result.window_used} window  ${result.lanes.lanes} lanes, ${result.lanes.points_used.toFixed(1)}% used, time left ${timeLeft} (${result.lanes.reason})`);
  else console.log(`${result.meter}  ${result.window_used} window  lanes unknown (${result.lanes_error}); time left ${timeLeft}`);
  for (const item of result.classes as FillClassFit[]) console.log(`  ${item.action_class}: ${item.percent} pts, ${item.duration_minutes} min, fits ${item.fits}x`);
  return result.lanes && result.lanes.lanes > 0 ? 0 : 2;
}

/**
 * Direct read only, deliberately: unlike status/can/gate/fill, `route` is a
 * deliberate, occasional operator (or orchestrator) call before dispatching
 * one lane, not a hot path a daemon needs to cache -- so it always opens its
 * own store rather than adding a daemon RPC case and an MCP forwarding path
 * for a command this infrequent.
 */
async function route(argv: string[]): Promise<number> {
  const ownerAt = argv.indexOf("--owner");
  const owner = ownerAt >= 0 ? argv[ownerAt + 1] : undefined;
  const actionClass = option(argv, "--class");
  const usage = "Usage: headroom route --class <action-class> --owner <name> [--allow-unknown] [--json]";
  if (!owner || !actionClass) throw new Error(usage);
  const routing = await readRouting();
  if (!routing.present) throw new Error("No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
  const meters = routing.consumes[actionClass];
  if (!meters) throw new Error(`Unknown action class: ${actionClass}`);
  const accounts = await readAccounts();
  const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
  if (unknownMeters.length) throw new Error(`Routing action class ${actionClass} names unknown meter(s): ${unknownMeters.join(", ")}`);
  const policy = await readPolicy();
  const store = await HeadroomStore.open();
  let result: RouteResult;
  try {
    result = routeFor(store, meters, accounts, policy, argv.includes("--allow-unknown"), new Date());
    store.audit("cli", "route", actionClass, result.principal ? "yes" : "no");
  } finally { store.close(); }
  if (argv.includes("--json")) { console.log(JSON.stringify(result)); return result.principal ? 0 : 2; }
  if (!result.principal) {
    console.log(`no principal fits ${actionClass} (${result.reason})`);
    for (const candidate of result.candidates) console.log(`  ${candidate.principal} ${candidate.state} (${candidate.reason})`);
    return 2;
  }
  const environment = Object.entries(result.environment).map(([key, value]) => `${key}=${value}`).join(" ");
  console.log(`${result.principal}${environment ? ` ${environment}` : ""}  (${result.reason})`);
  return 0;
}

/**
 * `headroom --principal X --models`: a best-effort LOCAL estimate of
 * per-model token share over the current 5h window, read straight from
 * Claude Code's own session logs (never a vendor call). The vendor's own
 * `/usage` percentages cannot be split by model at all -- this is a token
 * count, not a percent-of-limit figure, and is always labeled `estimated`
 * for exactly that reason. See docs/concepts.md.
 */
async function printModelShare(principal: string | undefined, asJson: boolean): Promise<number> {
  if (!principal) throw new Error("--models requires --principal <id>");
  const accounts = await readAccounts();
  const account = accounts.find((item) => item.name === principal);
  if (!account || isLocalAccount(account) || account.vendor !== "claude") throw new Error(`--models requires a configured Claude principal (got ${principal})`);
  const now = new Date();
  // Best effort: prefer the stored <principal>:all 5h window's own resets_at
  // (whatever the vendor last reported) as the window boundary; fall back to
  // a flat trailing 5 hours when nothing has ever been read for this meter.
  let since = new Date(now.getTime() - 5 * 3_600_000);
  try {
    const store = await HeadroomStore.open();
    try {
      const row = store.latestPerWindow(`${principal}:all`).find((item) => item.window?.minutes === 300);
      if (row?.resets_at) { const reset = Date.parse(row.resets_at); if (Number.isFinite(reset)) since = new Date(Math.max(0, reset - 300 * 60_000)); }
    } finally { store.close(); }
  } catch { /* no store yet: keep the flat trailing-5h fallback */ }
  const shares = await modelTokenShare(account.location, since, now);
  const totalTokens = shares.reduce((sum, item) => sum + item.input_tokens + item.output_tokens, 0);
  if (asJson) {
    console.log(JSON.stringify({
      principal, truth: "estimated", source: "local session logs", window_start: since.toISOString(), window_end: now.toISOString(),
      models: shares.map((item) => ({ ...item, share_percent: totalTokens > 0 ? Math.round(((item.input_tokens + item.output_tokens) / totalTokens) * 1000) / 10 : 0 })),
    }));
    return 0;
  }
  if (!shares.length || totalTokens === 0) {
    console.log(`${principal}  no local session-log token data for the current 5h window (estimated, from ${account.location}/projects)`);
    return 0;
  }
  console.log(`${principal} model token share (estimated, local session logs, current 5h window from ${formatReset(since.toISOString())})`);
  for (const item of shares) {
    const tokens = item.input_tokens + item.output_tokens;
    const share = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
    console.log(`  ${item.model.padEnd(24)} ${share.toFixed(0)}% (${item.input_tokens.toLocaleString()} in / ${item.output_tokens.toLocaleString()} out)`);
  }
  return 0;
}

async function observe(argv: string[]): Promise<number> {
  const allowed = new Set(["--json", "--threshold", "--principal", "--refresh", "--ttl", "--models"]);
  for (let index = 0; index < argv.length; index += 1) { if (!allowed.has(argv[index])) throw new Error("Usage: headroom [--json] [--principal X] [--threshold N] [--refresh] [--ttl 0] [--models]"); if (argv[index] !== "--json" && argv[index] !== "--refresh" && argv[index] !== "--models") index += 1; }
  const thresholdIndex = argv.indexOf("--threshold");
  const threshold = thresholdIndex >= 0 ? Number(argv[thresholdIndex + 1]) : undefined;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)) throw new Error("--threshold must be 0 through 100");
  const principalIndex = argv.indexOf("--principal");
  const principal = principalIndex >= 0 ? argv[principalIndex + 1] : undefined;
  if (argv.includes("--models")) return printModelShare(principal, argv.includes("--json"));
  // --ttl 0 is a synonym for --refresh: both force a fresh probe through the
  // daemon's own `refresh` method (still gated by the grant marker and the
  // daemon's own vendor backoff, same as any other poll) instead of serving
  // whatever the daemon last cached. A no-daemon direct read already polls
  // fresh on every call, so this is a no-op there.
  if (argv.includes("--refresh") || option(argv, "--ttl") === "0") {
    const refreshed = await requestDaemon("refresh", { principal });
    if (refreshed !== undefined) {
      const outcome = unwrapRpc(refreshed) as { rate_limited?: true } | Observation[];
      if (outcome && !Array.isArray(outcome) && outcome.rate_limited) process.stderr.write("(refresh throttled by the daemon's own poll interval or vendor backoff; showing the latest cached reading)\n");
    }
  }
  const request = await requestDaemon("status");
  const daemonObservations = request === undefined ? undefined : unwrapRpc(request) as Observation[];
  let observations: Observation[];
  let failures: string[];
  let resetSeen = new Map<string, string>();
  let freeResetUsed = new Map<string, string>();
  let leases: Lease[] = [];
  const direct = daemonObservations === undefined;
  if (daemonObservations) {
    observations = daemonObservations.filter((item) => !principal || item.principal_id === principal);
    failures = [];
    const leaseRequest = await requestDaemon("leases");
    leases = leaseRequest === undefined ? [] : unwrapRpc(leaseRequest) as Lease[];
  } else {
    const store = await HeadroomStore.open();
    try {
      const accounts = await readAccounts();
      const claudeIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude" && (!principal || account.name === principal)).map((account) => account.name);
      await syncClaudeGrantState(store, claudeIds);
      const polled = await pollAccounts(principal, { claudeGrant: claudeGrantGate(store), noDaemon: true });
      failures = polled.failures;
      store.insertAll(polled.observations);
      for (const [principalId, outcome] of Object.entries(polled.claudeProbeOutcomes ?? {})) store.audit("cli", "claude_probe", principalId, outcome);
      const rawObservations = store.latestPerWindow().filter((item) => !principal || item.principal_id === principal);
      const now = new Date();
      observations = withPaceInfo(rawObservations, store.burnRateFor(rawObservations, now), now);
      resetSeen = store.resetSeenFor(observations);
      freeResetUsed = store.freeResetUsedFor(observations);
      leases = store.leases(undefined, true);
      store.audit("cli", "observe", principal ?? null, failures.length ? "partial" : "ok");
    } finally { store.close(); }
  }
  if (!direct) {
    const windows = observations.map((item) => ({ meter_id: item.meter_id, minutes: item.window?.minutes, resets_at: item.resets_at }));
    const resetEvents = unwrapRpc(await requestDaemon("reset_seen", { windows })) as Record<string, string>;
    resetSeen = new Map(Object.entries(resetEvents));
    const freeResetEvents = unwrapRpc(await requestDaemon("free_reset_used", { windows })) as Record<string, string>;
    freeResetUsed = new Map(Object.entries(freeResetEvents));
  }
  if (direct) directReadNotice();
  const policy = await readPolicy();
  const thresholdRows = threshold === undefined ? undefined : thresholdReport(observations, threshold);
  const leaseMap = new Map<string, Lease[]>(); for (const item of leases) leaseMap.set(item.meter_id, [...(leaseMap.get(item.meter_id) ?? []), item]);
  if (argv.includes("--json")) { const withResets = withResetsIn(observations); console.log(JSON.stringify(thresholdRows === undefined ? { observations: withResets, leases } : { observations: withResets, leases, threshold: { percent: threshold, windows: thresholdRows, any_crossed: thresholdRows.some((item) => item.crossed), any_blocking: thresholdRows.some((item) => item.blocking) } })); }
  else { for (const line of formatMeters(observations, policy, resetSeen, leaseMap, freeResetUsed)) console.log(line); for (const failure of failures) console.log(failure); }
  if (thresholdRows?.some((item) => item.blocking)) return 2;
  return failures.length ? observations.length ? 3 : 1 : 0;
}

async function responseShape(argv: string[]): Promise<number> {
  if (argv.length !== 3 || argv[0] !== "--principal" || !argv[1] || argv[2] !== "--shape") throw new Error("Usage: headroom --principal <id> --shape");
  const account = (await readAccounts()).find((item) => item.name === argv[1]);
  if (!account || isLocalAccount(account) || account.adapter !== "native-ts") throw new Error("--shape requires a native TypeScript Claude, Codex, or Antigravity principal");
  const responses = account.vendor === "codex" ? await codexResponseShape(account)
    : account.vendor === "claude" ? { usage: await claudeResponseShape(account) }
    : account.vendor === "antigravity" ? await antigravityResponseShape(account)
    : undefined;
  if (!responses) throw new Error("--shape requires a native TypeScript Claude, Codex, or Antigravity principal");
  console.log(JSON.stringify({ principal_id: account.name, vendor: account.vendor, responses }));
  return 0;
}

/** A genuine JSON-RPC error reply is the FULL envelope (`{jsonrpc, id,
 * error}`) -- daemon.ts's rpc() only ever hands that whole object back on an
 * error; on success it hands back just `reply.result`. A domain-level
 * success result that happens to carry its own plain "error" field (e.g.
 * plan's `{meter, error: "..."}`) never has a top-level `jsonrpc`, so
 * checking for `error` alone used to mistake that domain shape for an RPC
 * failure and discard its real message behind a generic fallback. */
function unwrapRpc(value: unknown): unknown {
  if (value && typeof value === "object" && "jsonrpc" in value && "error" in value) {
    const error = (value as { error?: { message?: unknown } }).error;
    throw new Error(typeof error?.message === "string" ? error.message : "Daemon request failed");
  }
  return value;
}

/**
 * policy.ts's meterDecision() already builds its own reason as
 * "<window label> STATE (<detail>)" for a window whose state has no bare
 * percentage to show (UNKNOWN, most commonly) -- a self-contained line, good
 * on its own (e.g. in `--json`, or a routing decision read straight from
 * `can`'s meters array). printCan's own template below wraps that same
 * reason a second time as "STATE (<reason>)", so a windowless failure (no
 * window label at all, printed as "-") came out doubled: "UNKNOWN (-
 * UNKNOWN (Codex rejected the token (401); run: codex login))". Strip the
 * redundant "<label> STATE (" .. ")" shell down to its inner detail before
 * printCan wraps it again, so the state appears exactly once. A reason that
 * was never wrapped that way (e.g. "no readings for X") passes through
 * unchanged.
 */
function dedupeStateReason(state: string, reason: string): string {
  const match = new RegExp(`^\\S+\\s+${state}\\s*\\((.*)\\)$`).exec(reason);
  return match ? match[1] : reason;
}

function printCan(decision: CanDecision, cost: CostEstimate, leasedId: string | undefined, asJson: boolean): void {
  if (asJson) { console.log(JSON.stringify({ ...decision, cost, leased_id: leasedId ?? null })); return; }
  console.log(`${decision.allowed ? "YES" : "NO"} ${decision.meter} ${decision.state} (${dedupeStateReason(decision.state, decision.reason)})`);
  for (const meter of decision.meters) console.log(`  ${meter.meter} ${meter.state} (${dedupeStateReason(meter.state, meter.reason)})`);
  if (cost.expected_percent !== null) {
    const iqr = cost.iqr_low !== null && cost.iqr_high !== null ? ` (IQR ${cost.iqr_low.toFixed(1)}-${cost.iqr_high.toFixed(1)}%, n=${cost.sample_count})` : "";
    const maxMore = cost.max_more_before_reset === null ? "" : `; max ${cost.max_more_before_reset} more before reset at the current sustainable pace`;
    console.log(`cost: ${cost.source} ${cost.expected_percent.toFixed(1)}%${iqr}, confidence ${cost.confidence}${maxMore}`);
  }
  if (leasedId) console.log(`leased ${leasedId}`);
}

function directReadNotice(): void { process.stderr.write("(direct read, no daemon)\n"); }

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** Runs the operator's own prior statusLine command (--chain), feeding it the
 * exact same stdin payload headroom itself received, and returns its stdout
 * verbatim -- headroom still snapshots the reading (the caller does that
 * before calling this) without silently replacing an existing statusline
 * setup Claude Code only lets one command own. */
function runChainCommand(command: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Meant to be configured as Claude Code's own `statusLine` command (see
 * docs/quickstart.md): reads the JSON object Claude Code renders on every
 * prompt, containing `rate_limits.five_hour`/`rate_limits.seven_day` (and
 * possibly other model-scoped buckets), snapshots it to
 * `<HEADROOM_HOME>/statusline/<profile>.json` for the statusline adapter to
 * read as a zero-auth Claude source, and prints a compact one-line bar for
 * Claude Code's own status bar. `--chain <command>` runs an existing
 * statusLine command with the same stdin and prints its output instead, so
 * adopting headroom does not require giving up a prior custom statusline.
 * Never fails to print a line: a statusLine command that errors blanks the
 * user's prompt bar.
 */
async function statusline(argv: string[]): Promise<number> {
  const chainAt = argv.indexOf("--chain");
  const chainCommand = chainAt >= 0 ? argv.slice(chainAt + 1).join(" ") : undefined;
  let raw = "";
  let snapshot: ReturnType<typeof snapshotFromStatuslinePayload>;
  const now = new Date();
  try {
    raw = await readStdinText();
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { payload = undefined; }
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const profile = statuslineProfile(configDir);
    snapshot = snapshotFromStatuslinePayload(payload, profile, now);
    if (snapshot) {
      const dir = join(headroomHome(), "statusline");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${profile}.json`);
      await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
      await chmod(path, 0o600);
    }
  } catch { /* the bar must still print even if reading stdin or writing the snapshot fails */ }
  if (chainCommand) {
    try { process.stdout.write(await runChainCommand(chainCommand, raw)); return 0; }
    catch { /* fall through to headroom's own bar rather than print nothing */ }
  }
  console.log(formatStatuslineBar(snapshot, now));
  return 0;
}

async function daemon(): Promise<number> {
  const instance = await HeadroomDaemon.create();
  await instance.start();
  await appendDaemonLog(`daemon started; listening on ${socketPath()}`);
  await new Promise<void>((resolve) => {
    const stop = () => { void instance.stop().then(() => appendDaemonLog("daemon stopped")).finally(resolve); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
  return 0;
}

async function logs(argv: string[]): Promise<number> {
  if (argv.length > 2 || (argv[0] && argv[0] !== "--tail")) throw new Error("Usage: headroom logs [--tail 50]");
  const requested = argv[0] === "--tail" ? Number(argv[1]) : 50;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 10_000) throw new Error("--tail must be a whole number from 1 through 10000");
  const output = await tailDaemonLog(requested);
  if (output) console.log(output);
  return 0;
}

/** The message for a config dir Claude Code was never logged into: distinct
 * from a Keychain access denial, since there is nothing to grant yet. */
export function noKeychainItemMessage(directory: string): string {
  return `no Claude login for ${directory}; run: CLAUDE_CONFIG_DIR=${directory} claude, or remove this principal from accounts.toml`;
}

/** With no --principal this grants every Claude principal in the registry: one
 * Keychain dialog per principal, one printed confirmation line each. A grant
 * always clears that principal's keychain_grant_needed marker (set by a prior
 * denial/timeout, or by a probe binary rebuild), so the daemon resumes
 * probing it on its next poll. */
async function keychain(argv: string[]): Promise<number> {
  if (argv[0] !== "grant" || argv.length > 3 || (argv[1] && argv[1] !== "--principal")) throw new Error("Usage: headroom keychain grant [--principal <claude-principal>]");
  // Printed unconditionally, before ever touching the Keychain: an agent
  // shell running this command has no way to learn why a dialog it cannot
  // see never appeared, and the dogfooded failure mode ("no credentials")
  // gave no hint that the real problem was the shell itself.
  if (process.platform === "darwin") console.log("Run this from your own terminal; macOS shows a Keychain dialog that cannot appear in a sandboxed or remote shell.");
  const requested = option(argv, "--principal");
  const accounts = (await readAccounts()).filter((item): item is ProviderAccount => !isLocalAccount(item) && item.vendor === "claude");
  const targets = requested ? accounts.filter((item) => item.name === requested) : accounts;
  if (!targets.length) throw new Error(requested ? `No Claude principal named ${requested}; run headroom accounts discover` : "No Claude principal found; run headroom accounts discover");
  const store = await HeadroomStore.open();
  let failures = 0;
  try {
    const existingPin = store.probePath();
    const hash = process.platform === "darwin" ? await probeBinaryHash(existingPin) : undefined;
    for (const account of targets) {
      let probePath: string | undefined;
      try {
        ({ probePath } = await grantClaudeKeychainAccess(account.location, existingPin));
      } catch (error) {
        // Claude Code was never run against this config dir, so there is
        // nothing for the operator to grant access to yet: a distinct,
        // actionable message beats the probe's generic "no credentials"
        // wording, and must not abort the remaining principals.
        if (error instanceof ClaudeProbeError && error.message === "no credentials in Keychain for this config dir") {
          console.error(noKeychainItemMessage(account.location));
          failures += 1;
          continue;
        }
        // The dialog exists and would have worked (doctor already confirmed
        // the Keychain item is present); this shell just cannot show it.
        // Distinct from the case above on purpose: the fix here is "run this
        // command somewhere else", never "there's nothing to grant yet".
        if (error instanceof ClaudeProbeError && error.kind === "no_interaction") {
          console.error(`${account.name}: ${error.message}`);
          failures += 1;
          continue;
        }
        throw error;
      }
      store.clearKeychainGrantNeeded(account.name);
      // The binary that just proved itself under an operator-run grant must
      // never be treated as an unproven first run again by a background poll.
      if (hash) store.setProbeGrantedHash(hash);
      // Pinned once, on the very first successful grant this Headroom home
      // has ever recorded -- every later probe call (background polls
      // included, see collector.ts) uses exactly this path from here on,
      // even if a second candidate binary later appears on disk.
      if (!existingPin && probePath) store.setProbePath(probePath);
      console.log(`Keychain access granted for ${account.name}`);
    }
  } finally { store.close(); }
  return failures ? 1 : 0;
}

/** One line per top-level command for `headroom --help` / `headroom help`. */
export const COMMAND_LIST: ReadonlyArray<readonly [string, string]> = [
  ["status", "Print one line per meter (the default; also takes --json, --principal, --threshold, --refresh, --models)"],
  ["can <action-class>", "Check whether an action class can consume its meters, per routing.toml"],
  ["events", "List reset and free-reset events"],
  ["history <meter>", "List stored observations for one meter"],
  ["lease start|list|end", "Reserve, list, or release a meter lease"],
  ["cost [<action-class>]", "Print the learned median/IQR/sample-count spent percent per action class"],
  ["rate", "Burn in percent per hour over a recent window, and ETA to the limit"],
  ["plan", "Points available per remaining 5h window and the plan line to hold"],
  ["gate", "Pre-dispatch check: do these points fit the current window (and the plan)"],
  ["wait", "Block until a meter's window resets, or --max elapses"],
  ["fill", "How many more lanes (and which action classes) fit before a window's unspent points are lost at reset"],
  ["route", "Pick the principal with the most headroom for an action class, and print its launch environment"],
  ["accounts discover", "Scan for Claude/Codex/Antigravity accounts and write accounts.toml"],
  ["doctor", "Diagnose the installation: principals, credentials, daemon, config"],
  ["keychain grant", "macOS: grant the Claude probe Keychain access"],
  ["install-service", "Install the daemon as a launchd/systemd/Task Scheduler service"],
  ["uninstall-service", "Remove the installed daemon service"],
  ["daemon", "Run the daemon in the foreground (an installed service does this for you)"],
  ["mcp", "Run the MCP server over stdio"],
  ["engine install", "Install the optional native sensing engine"],
  ["engine status", "Show whether the native and upstream engines are installed"],
  ["logs", "Print the tail of the daemon log"],
  ["statusline", "Read Claude Code's statusLine JSON from stdin, snapshot it as a zero-auth source, and print a compact bar"],
  ["version", "Print the Headroom version"],
];

/** Usage text for `headroom <command> --help`, keyed by the command's first token. */
export const COMMAND_HELP: Readonly<Record<string, string>> = {
  can: "Usage: headroom can <action-class> --owner <name> [--allow-unknown] [--expect <percent>] [--lease] [--ttl 30m] [--json]",
  events: "Usage: headroom events [--since 24h] [--table]",
  history: "Usage: headroom history <meter> [--since 24h]",
  lease: [
    "Usage: headroom lease <start|end|list>",
    "  start: headroom lease start --owner <name> --meter <meter_id> [--expect <percent>] [--ttl 30m] [--note ...] [--class <action-class>]",
    "  end:   headroom lease end <id> --owner <name> [--force]",
    "  list:  headroom lease list",
  ].join("\n"),
  cost: "Usage: headroom cost [<action-class>] [--json]",
  rate: "Usage: headroom rate [--meter <meter_id>] [--minutes 30] [--window 10m] [--json]",
  plan: "Usage: headroom plan --meter <meter_id> --until reset --reserve <percent> [--json]",
  gate: "Usage: headroom gate --need 5h:<N> [--need wk:<N>] (--meter <meter_id> | --class <action-class> | --model <slug>) --owner <name> [--plan] [--plan-share <N>] [--json]",
  wait: "Usage: headroom wait --meter <meter_id> --until-reset [--max 6h]",
  fill: "Usage: headroom fill --meter <meter_id> --until-reset [--lane-cost <percent>] [--weekly-reserve <percent>] [--plan-share <N>] --owner <name> [--json]",
  route: "Usage: headroom route --class <action-class> --owner <name> [--allow-unknown] [--json]",
  accounts: "Usage: headroom accounts discover",
  doctor: "Usage: headroom doctor",
  keychain: "Usage: headroom keychain grant [--principal <claude-principal>]",
  "install-service": "Usage: headroom install-service [--dry-run]",
  "uninstall-service": "Usage: headroom uninstall-service [--dry-run]",
  daemon: "Usage: headroom daemon",
  mcp: "Usage: headroom mcp",
  engine: "Usage: headroom engine <install|status> [--pin]",
  logs: "Usage: headroom logs [--tail 50]",
  statusline: "Usage: headroom statusline [--chain <command>]",
  version: "Usage: headroom version (or: headroom --version)",
};

export function helpText(): string {
  const width = Math.max(...COMMAND_LIST.map(([name]) => name.length));
  return [
    "Usage: headroom [command] [options]",
    "",
    "Commands:",
    ...COMMAND_LIST.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    "",
    "Run `headroom <command> --help` for usage on one command.",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "help") { console.log(helpText()); return 0; }
  if (argv[0] === "--version" || argv[0] === "version") { console.log(await headroomVersion()); return 0; }
  if (argv.includes("--help") && argv[0] && COMMAND_HELP[argv[0]]) { console.log(COMMAND_HELP[argv[0]]); return 0; }
  // Dispatched before anything else in main() (the proxy strip, the legacy
  // home migration, both of which can throw on a corrupted policy.toml or an
  // unusual home layout): this runs on every Claude Code prompt render, and
  // a statusLine command that fails to print at all blanks the user's status
  // bar. statusline() itself never throws for the same reason.
  if (argv[0] === "statusline") return statusline(argv.slice(1));
  // Before any command can fetch a vendor endpoint: an operator's shell
  // proxy must never silently carry a credentialed request unless
  // policy.toml opts in.
  stripAmbientProxyEnvironment((await readPolicy()).proxy);
  if (await migrateLegacyHome()) console.log(["Moved ~/.", "ta", "lly", " to ~/.headroom."].join(""));
  if (argv[0] === "engine" && argv[1] === "install") {
    const pin = argv.includes("--pin");
    if (argv.some((item) => item !== "engine" && item !== "install" && item !== "--pin")) throw new Error("Usage: headroom engine install [--pin]");
    const native = await installNativeEngine();
    if (native.installed) { console.log(`native engine ${native.tag} installed at ${native.path} (sha256 ${native.sha256})`); return 0; }
    console.log(`${native.hint} Falling back to the pinned upstream engine.`);
    const result = await installEngine({ pin });
    if (result.firstPin) { console.log(`SHA-256 for ${result.tag}: ${result.sha256}\nAdd this hash to engine.lock.json and commit it; no engine was installed.`); return 0; }
    console.log(`upstream engine ${result.tag} installed at ${result.path} (sha256 ${result.sha256})`); return 0;
  }
  if (argv[0] === "engine" && argv[1] === "status") { const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath()]); console.log(`native ${native ? "present" : "absent"} ${native ?? "~/.headroom/engine/native/headroom-engine (or engine/.build/release/headroom-engine)"}`); console.log(`upstream ${upstream.tag} ${upstream.present ? "present" : "absent"} ${upstream.path}`); return native || upstream.present ? 0 : 1; }
  if (argv[0] === "accounts" && argv[1] === "discover") {
    const accounts = await discoverAccounts();
    console.log(accountsToml(accounts));
    await writeDiscoveredAccounts(accounts);
    console.log(`Wrote ${accountsPath()} (${accounts.length} account${accounts.length === 1 ? "" : "s"}). Next: headroom doctor`);
    for (const line of await seedExampleConfig()) console.log(line);
    return 0;
  }
  if (argv[0] === "doctor") return doctor();
  if (argv[0] === "logs") return logs(argv.slice(1));
  if (argv[0] === "daemon") return daemon();
  if (argv[0] === "keychain") return keychain(argv.slice(1));
  if (argv[0] === "mcp") { serveMcp(); return await new Promise<number>(() => undefined); }
  if (argv[0] === "install-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: headroom install-service [--dry-run]");
    const result = await installService(process.argv[1], process.platform, undefined, process.execPath, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would write" : "wrote"} ${result.path}\nTo load it: ${result.command}`);
    if (result.dryRun) console.log(`\n${result.contents}`);
    return 0;
  }
  if (argv[0] === "uninstall-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: headroom uninstall-service [--dry-run]");
    const result = await uninstallService(process.platform, undefined, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would remove" : "removed"} ${result.path}\nTo unload it: ${result.command}`); return 0;
  }
  if (argv[0] === "history") return history(argv.slice(1));
  if (argv[0] === "events") return events(argv.slice(1));
  if (argv[0] === "lease") return lease(argv.slice(1));
  if (argv[0] === "can") return can(argv.slice(1));
  if (argv[0] === "cost") return cost(argv.slice(1));
  if (argv[0] === "rate") return rate(argv.slice(1));
  if (argv[0] === "plan") return plan(argv.slice(1));
  if (argv[0] === "gate") return gate(argv.slice(1));
  if (argv[0] === "wait") return wait(argv.slice(1));
  if (argv[0] === "fill") return fill(argv.slice(1));
  if (argv[0] === "route") return route(argv.slice(1));
  if (argv.includes("--shape")) return responseShape(argv);
  return observe(argv);
}

/**
 * `import.meta.url` is the entry module's canonical (symlink-resolved) URL,
 * always -- Node's ESM loader realpath()s it. `process.argv[1]` is the raw
 * argument the caller passed and is left exactly as given. On macOS these
 * differ whenever the invoking path crosses a system alias (`/var` ->
 * `/private/var`, `/tmp` -> `/private/tmp`): a plain string comparison then
 * always fails, this file's own main() never runs, and the CLI silently
 * exits 0 with no output at all. Any global npm prefix or accounts/home
 * directory rooted under a default TMPDIR hits this, not just tests --
 * resolving process.argv[1] the same way import.meta.url already is fixes it
 * for every caller, not just the common case.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(realpathSync(argv1)).href; }
  catch { return false; }
}

function sameMissingFile(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return basename(left) === basename(right)
      && realpathSync.native(dirname(left)) === realpathSync.native(dirname(right));
  } catch { return false; }
}

/** True only for the exact ENOENT a fresh install produces the first time any
 * command reads accounts.toml -- never for a symlink/permission failure or an
 * ENOENT on some other path, which must still surface as a real error. */
export function isAccountsMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errno = error as NodeJS.ErrnoException;
  if (errno.code !== "ENOENT" || typeof errno.path !== "string") return false;
  // Compare through the directory's real path: Windows may report a short
  // (8.3) form of the temp directory, and both forms name the same file.
  return sameMissingFile(errno.path, accountsPath());
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    if (isAccountsMissingError(error)) { console.error("No accounts configured yet. Run: headroom accounts discover"); process.exitCode = 1; return; }
    console.error(`headroom error: ${safeError(error)}`); process.exitCode = 1;
  });
}
