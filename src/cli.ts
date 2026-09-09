#!/usr/bin/env node
import { geminiResponseShape } from "./adapters/gemini.js";
import { readPolicy, readRouting, seedExampleConfig } from "./config.js";
import { existsSync, realpathSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, delimiter, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { appendDaemonLog, tailDaemonLog } from "./logs.js";
import { completionCommand, printCompletionMeterIds, printCompletionPrincipalIds, COMPLETION_HELP } from "./completion.js";
import { doctor } from "./doctor.js";
import { exportCommand, EXPORT_HELP } from "./export.js";
import { engineStatus, installEngine, installNativeEngine } from "./engine/codexbar/install.js";
import { observeLocal } from "./engine/local.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { ClaudeProbeError, claudeGrantGate, claudeResponseShape, checkClaudeCredentialReadable, probeBinaryHash, resolveProbePath, syncClaudeProbeState } from "./adapters/claude.js";
import { formatStatuslineBar, snapshotFromStatuslinePayload, statuslineProfile } from "./adapters/claude-statusline.js";
import { parseRenderOptions, renderedStatusline } from "./statusline-render.js";
import { clipboardCommand, observationsFromUsagePaste, parseUsagePanel, resolveClaudePrincipal } from "./adapters/claude-usage-paste.js";
import { codexResponseShape } from "./adapters/codex.js";
import { antigravityResponseShape } from "./adapters/antigravity.js";
import { pollAccounts } from "./collector.js";
import { formatMeters, formatRatePercent, formatReset, label, renderStatus, statusViewOptions, STATUS_VIEW_FLAGS } from "./status-view.js";
import { daemonRequest, socketPath, HeadroomDaemon } from "./daemon.js";
import { serveMcp } from "./mcp.js";
import { NOTIFY_USAGE, notifyCommand } from "./notify.js";
import { runSetup } from "./setup.js";
import { runUninstall } from "./uninstall.js";
import { canRouteWithLeases, reserveOnCan, unknownMeterPrincipals, type CanDecision } from "./policy.js";
import { withLastKnown, withPaceInfo } from "./pace.js";
import { buildCostEstimate, type CostEstimate, type LearnedCost } from "./cost.js";
import { budgetPlanLeases, parseBudgetPlan } from "./budget-plan.js";
import { isInboxKind, readInbox, sendInboxMessage, INBOX_KINDS, MAX_INBOX_MESSAGE_BYTES, type InboxKind, type InboxMessage } from "./inbox.js";
import { parseGateNeed, waitForReset, type FillClassFit, type GateNeed, type PlanResult } from "./pacing.js";
import { fillFor, gateFor, pickDecidingObservation, planFor, rateLines, routeFor, type RateLine, type RouteResult } from "./orchestrator-reads.js";
import { accountsPath, accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "./registry.js";
import { migrateLegacyHome } from "./paths.js";
import { formatResetsIn, resetsIn, withResetsIn } from "./resets.js";
import { readBoundedRegularFile, safeError, safeOutputDirectory, stripAmbientProxyEnvironment, writeFileAtomic } from "./security.js";
import { installService, uninstallService } from "./service.js";
import { modelTokenShare } from "./session-logs.js";
import { isEnvelopable, withContract, JSON_CONTRACT_VERSION, JSON_CONTRACT_DOC_PATH } from "./json-contract.js";
import { HeadroomStore, safeHeadroomDirectory } from "./store.js";
import { isLocalAccount, type Lease, type Observation, type HeadroomEvent, type ProviderAccount, type SpendRow } from "./types.js";
import { runUpdate, updateNoticeLine } from "./update.js";
import { headroomVersion } from "./version.js";

function since(value: string | undefined): string {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? "24h");
  if (!match) throw new Error("--since must be like 15m, 24h, or 7d");
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - Number(match[1]) * multiplier).toISOString();
}

/** Only fall back to SQLite when no daemon socket exists. A socket which cannot
 * answer health is an operational problem, not permission to race its writer. */
async function requestDaemon(method: string, params: Record<string, unknown> = {}): Promise<unknown | undefined> {
  const request = await daemonRequest(socketPath(), method, params);
  if (request.status === "available") return request.result;
  if (request.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
  return undefined;
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

// The status rendering itself lives in status-view.ts; re-exported here so
// every existing caller of `formatMeters` keeps its import path.
export { formatMeters };

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
      const blocked = meters.map((item) => directStore.dispatchBlockForMeter(item, now) ?? directStore.dispatchBlockForPrincipal(item.split(":")[0])).find(Boolean);
      if (blocked) decision = { allowed: false, meter: meters[0], state: "FREEZE", reason: blocked, meters: [{ meter: meters[0], state: "FREEZE", reason: blocked }] };
      else {
      const rows = new Map(allMeters.map((meter) => [meter, directStore.latestPerWindow(meter)]));
      const burn = directStore.burnRateFor([...rows.values()].flat(), now);
      const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
      decision = canRouteWithLeases(meters, localMeters, enriched, routing.local_preference, policy, argv.includes("--allow-unknown"), directStore.leases(undefined, true), owner, now);
      }
      directStore.audit("cli", "can", action, decision.allowed ? "yes" : "no");
    } finally { directStore.close(); }
  }

  // The learned-cost/max-more/optional-lease report is a direct read
  // regardless of the daemon: it is advisory bookkeeping over the same
  // on-disk store the daemon also writes to, not a vendor call, so it never
  // needs a daemon round trip of its own (see store.ts's WAL comment on
  // safe concurrent direct reads).
  const canPolicy = await readPolicy();
  const store = await HeadroomStore.open();
  let cost: CostEstimate;
  let leasedId: string | undefined;
  try {
    const learned = store.learnedCost(action)[0];
    const deciding = pickDecidingObservation(store.latestPerWindow(decision.meter));
    const remaining = deciding?.quantity?.unit === "percent" ? deciding.quantity.remaining ?? (deciding.quantity.limit !== null ? deciding.quantity.limit - deciding.quantity.used : null) : null;
    cost = buildCostEstimate(action, expectOverride, learned as LearnedCost | undefined, remaining);
    // The expected cost is only known once the estimate above exists, so the
    // deciding meter's protected reserve (policy.toml [reserve]) is applied
    // here -- before any lease starts, so a refused call never reserves
    // capacity it may not spend.
    decision = reserveOnCan(decision, canPolicy.reserve, remaining, cost.expected_percent);
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
    const asJson = argv.includes("--json");
    const request = await requestDaemon("leases");
    if (request !== undefined) {
      const items = unwrapRpc(request) as Lease[];
      if (asJson) { console.log(JSON.stringify(withContract({ leases: items }))); return 0; }
      printLeases(items);
      return 0;
    }
    directReadNotice(); const store = await HeadroomStore.open(); try { const items = store.leases(); store.audit("cli", "leases", null, "ok"); if (asJson) { console.log(JSON.stringify(withContract({ leases: items }))); return 0; } printLeases(items); return 0; } finally { store.close(); }
  }
  throw new Error("Usage: headroom lease <start|end|list> [--json]");
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
  const owner = option(argv, "--owner");
  const minutes = rateLookbackMinutes(argv);
  const need = option(argv, "--need");
  if (need) parseGateNeed(`${need}:0`);
  const asJson = argv.includes("--json");
  const request = await requestDaemon("rate", { meter, minutes, owner, need });
  let lines: RateLine[];
  if (request !== undefined) { lines = unwrapRpc(request) as RateLine[]; }
  else {
    directReadNotice();
    const store = await HeadroomStore.open();
    try { lines = rateLines(store, meter, minutes, new Date(), owner, need); store.audit("cli", "rate", meter ?? null, "ok"); }
    finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(lines)); return 0; }
  if (!lines.length) { console.log(meter ? `no readings for ${meter}` : "no readings"); return 0; }
  for (const line of lines) {
    if (line.reason !== undefined) { console.log(`${line.meter}  UNKNOWN (${line.reason})`); continue; }
    const windowLabel = line.window_minutes === 300 ? "5h" : line.window_minutes === 10_080 ? "wk" : line.window_minutes ? `${line.window_minutes}m` : "-";
    const usedText = line.used_percent === null ? "?" : `${Math.round(line.used_percent)}%`;
    if (line.burn_percent_per_hour === null) { console.log(`${line.meter}  ${windowLabel} ${usedText}  burn unknown (need 2+ fresh samples in the last ${minutes}m)${attributedSegment(line)}`); continue; }
    const stall = line.empty_in_seconds === null ? "not projected to empty before reset" : `stall in ${formatResetsIn(line.empty_in_seconds)}`;
    console.log(`${line.meter}  ${windowLabel} ${usedText}  burn ${formatRatePercent(line.burn_percent_per_hour)}, ${stall}${attributedSegment(line)}`);
  }
  return 0;
}

function vendorResetFromOutput(text: string): string | null {
  const explicit = /HEADROOM_EXHAUSTED_UNTIL=([^\s]+)/.exec(text)?.[1];
  if (explicit && Number.isFinite(Date.parse(explicit))) return new Date(explicit).toISOString();
  const codex = /You've hit your usage limit[\s\S]{0,240}?try again at ([^\n\r]+)/i.exec(text)?.[1];
  const claude = /(?:rate limit|usage limit reached)[\s\S]{0,160}?resets at ([^\n\r]+)/i.exec(text)?.[1];
  const value = codex ?? claude;
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function vendorLimitSeen(text: string): boolean {
  return /You've hit your usage limit|\brate limit\b|usage limit reached|HEADROOM_EXHAUSTED_UNTIL=/i.test(text);
}

async function report(argv: string[]): Promise<number> {
  const meter = option(argv, "--meter");
  if (!meter || !argv.includes("--exhausted")) throw new Error("Usage: headroom report --meter <meter_id> --exhausted [--until <iso or vendor date>] [--note <text>]");
  const rawUntil = option(argv, "--until");
  const until = rawUntil && Number.isFinite(Date.parse(rawUntil)) ? new Date(rawUntil).toISOString() : rawUntil ? (() => { throw new Error("--until must be an ISO timestamp or a vendor date"); })() : null;
  const store = await HeadroomStore.open();
  try { store.reportExhausted(meter, until, option(argv, "--note") ?? null); store.audit("cli", "report_exhausted", meter, "ok"); }
  finally { store.close(); }
  console.log(`${meter} exhausted${until ? `; resets ${until}` : ""}`);
  return 0;
}

async function ack(argv: string[]): Promise<number> {
  if (argv[0] !== "plan" || !argv[1]) throw new Error("Usage: headroom ack plan <principal>");
  const store = await HeadroomStore.open();
  try { store.acknowledgePlan(argv[1]); store.audit("cli", "ack_plan", argv[1], "ok"); }
  finally { store.close(); }
  console.log(`acknowledged plan change for ${argv[1]}`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  const flags = separator >= 0 ? argv.slice(0, separator) : argv;
  const meter = option(flags, "--meter");
  const owner = option(flags, "--owner");
  const actionClass = option(flags, "--class");
  if (!owner || !command.length || (!meter && !actionClass)) throw new Error("Usage: headroom run --meter <meter> --need <window>:<points> [--need ...] --owner <name> [--class <action-class>] [--ttl 3h] -- <command> [args...]");
  const needs: GateNeed[] = [];
  for (let index = 0; index < flags.length; index += 1) if (flags[index] === "--need") needs.push(parseGateNeed(flags[index + 1] ?? ""));
  const policy = await readPolicy();
  const store = await HeadroomStore.open();
  let lease: Lease | undefined;
  try {
    let target: string | string[] = meter ?? [];
    if (!meter && actionClass) {
      const routing = await readRouting();
      const meters = routing.consumes[actionClass];
      if (!meters?.length) throw new Error(`Unknown action class: ${actionClass}`);
      target = meters;
      const learned = store.learnedCost(actionClass)[0];
      if (!needs.length && learned) needs.push({ window: "5h", points: learned.median_percent });
      if (!needs.length) throw new Error(`No learned cost for ${actionClass}; provide --need`);
    }
    if (!needs.length) throw new Error("--need is required unless --class has a learned cost");
    const decision = gateFor(store, needs, target, policy.freeze_reserve_pct, false, new Date(), { owner, actionClass, pacing: policy.pacing, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve });
    if (!decision.allowed) {
      if (flags.includes("--json")) console.log(JSON.stringify(withContract({ gate: decision, lease_id: null })));
      else console.error(decision.reason);
      return 2;
    }
    const leaseMeter = meter ?? decision.meters_checked[0];
    const expected = needs.reduce((sum, need) => sum + need.points, 0);
    lease = store.startLease(owner, leaseMeter, expected, ttl(option(flags, "--ttl") ?? "3h"), "run", new Date(), actionClass ?? null);
    if (flags.includes("--json")) console.log(JSON.stringify(withContract({ gate: decision, lease_id: lease.id })));
  } finally { store.close(); }
  const child = spawn(command[0], command.slice(1), { stdio: ["inherit", "pipe", "pipe"], env: process.env });
  let transcript = "";
  child.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString(); transcript += text; process.stdout.write(text); });
  child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); transcript += text; process.stderr.write(text); });
  const forward = (signal: NodeJS.Signals): void => { if (!child.killed) child.kill(signal); };
  const onInt = (): void => forward("SIGINT"); const onTerm = (): void => forward("SIGTERM");
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
  const code = await new Promise<number>((resolve) => child.on("exit", (value, signal) => resolve(value ?? (signal === "SIGINT" ? 130 : 143))));
  process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
  const ending = await HeadroomStore.open();
  try {
    if (lease) ending.endLease(lease.id, owner, true);
    if (vendorLimitSeen(transcript)) ending.reportExhausted(lease?.meter_id ?? meter!, vendorResetFromOutput(transcript), "vendor reports the limit reached");
  } finally { ending.close(); }
  return code;
}

const SPEND_HELP = "Usage: headroom spend [--meter <meter_id>] [--owner <name>] [--since 24h] [--json]";
const INBOX_HELP = "Usage: headroom inbox --session <session-id> [--since <epoch-ms>] [--json]";
const INBOX_SEND_HELP = "Usage: headroom inbox send --to <session-id> --kind <budget|note|handoff> (--file <path> | --text <text>) [--from <session-id>]";
const PLAN_IMPORT_HELP = "Usage: headroom plan import <file>";

/** The " attributed to X ..%" tail `rate --owner` adds to a burn line. Empty
 * for a plain `rate`, so the existing one-line-per-window shape is unchanged
 * for every caller that did not ask for an owner. */
function attributedSegment(line: RateLine): string {
  if (line.attributed_owner === undefined) return "";
  return `, attributed to ${line.attributed_owner} ${(line.attributed_percent ?? 0).toFixed(2)}% (confidence ${(line.attributed_confidence ?? 0).toFixed(2)})`;
}

function windowLabelFor(minutes: number | null): string {
  return minutes === 300 ? "5h" : minutes === 10_080 ? "wk" : minutes ? `${minutes}m` : "-";
}

export function spendLines(rows: SpendRow[]): string[] {
  return rows.map((row) => `${row.meter_id}  ${windowLabelFor(row.window_minutes)}  ${row.owner}  ${row.attributed_percent.toFixed(2)}%  confidence ${row.confidence.toFixed(2)} (n=${row.samples})`);
}

/**
 * `headroom spend`: who moved the shared meter. The ledger books every poll's
 * delta against whoever held a lease at that moment, so this is the read that
 * turns one account's single total into a per-orchestrator answer. An
 * `unattributed` row is movement that happened with no lease open at all --
 * real spend whose owner simply cannot be known, shown rather than hidden.
 */
async function spend(argv: string[]): Promise<number> {
  const meter = option(argv, "--meter");
  const owner = option(argv, "--owner");
  const sinceIso = since(option(argv, "--since"));
  const asJson = argv.includes("--json");
  const request = await requestDaemon("spend", { meter, owner, since: sinceIso });
  let rows: SpendRow[];
  if (request !== undefined) { rows = unwrapRpc(request) as SpendRow[]; }
  else {
    directReadNotice();
    const store = await HeadroomStore.open();
    try { rows = store.spendByOwner({ meter, owner, since: sinceIso }); store.audit("cli", "spend", meter ?? owner ?? null, "ok"); }
    finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(rows)); return 0; }
  if (!rows.length) { console.log(`no attributed spend since ${sinceIso}`); return 0; }
  for (const line of spendLines(rows)) console.log(line);
  return 0;
}

export function inboxLines(result: { messages: InboxMessage[]; remaining: number }): string[] {
  const lines = result.messages.map((message) => `${message.at}  ${message.kind}  from ${message.from ?? "-"}  ${typeof message.body === "string" ? message.body : JSON.stringify(message.body)}`);
  if (result.remaining) lines.push(`(${result.remaining} more message${result.remaining === 1 ? "" : "s"} still queued; run inbox again)`);
  return lines;
}

/**
 * `headroom inbox`: the hand-off channel between orchestrators sharing an
 * account. Reading is destructive by design -- each message is renamed with a
 * `.read` suffix once its content has been printed -- so two reads of the
 * same inbox never both act on the same hand-off.
 */
async function inbox(argv: string[]): Promise<number> {
  if (argv[0] === "send") {
    const to = option(argv, "--to");
    const kind = option(argv, "--kind");
    const file = option(argv, "--file");
    const text = option(argv, "--text");
    if (!to || !kind) throw new Error(INBOX_SEND_HELP);
    if (!isInboxKind(kind)) throw new Error(`--kind must be one of ${INBOX_KINDS.join(", ")}`);
    if ((file === undefined) === (text === undefined)) throw new Error("pass exactly one of --file or --text");
    const body = file !== undefined ? await readBoundedRegularFile(file, MAX_INBOX_MESSAGE_BYTES) : text!;
    const sent = await sendInboxMessage({ to, kind: kind as InboxKind, text: body, from: option(argv, "--from") ?? null });
    console.log(`sent ${sent.file} to ${sent.session}`);
    return 0;
  }
  const session = option(argv, "--session");
  if (!session) throw new Error(INBOX_HELP);
  const sinceValue = option(argv, "--since");
  const sinceEpoch = sinceValue === undefined ? undefined : Number(sinceValue);
  if (sinceEpoch !== undefined && (!Number.isFinite(sinceEpoch) || sinceEpoch < 0)) throw new Error("--since must be milliseconds since the epoch");
  const result = await readInbox({ session, since: sinceEpoch });
  if (argv.includes("--json")) { console.log(JSON.stringify(withContract(result))); return 0; }
  if (!result.messages.length) { console.log(`no unread messages for ${result.session}`); return 0; }
  for (const line of inboxLines(result)) console.log(line);
  return 0;
}

/** `headroom plan import <file>`: turns a budget plan's declared shares into
 * ordinary advisory leases, so `gate --owner`, `route` and `spend` see the
 * agreed division without a second reservation mechanism of their own. */
async function planImport(argv: string[]): Promise<number> {
  const file = argv[0];
  if (!file || file.startsWith("--")) throw new Error(PLAN_IMPORT_HELP);
  const plan = parseBudgetPlan(await readBoundedRegularFile(file));
  const now = new Date();
  const planned = budgetPlanLeases(plan, now);
  if (!planned.length) { console.log(`no window in ${file} is still open; nothing imported`); return 0; }
  const store = await HeadroomStore.open();
  try {
    for (const lease of planned) {
      const created = store.startLease(lease.owner, lease.meter_id, lease.expect_percent, lease.ttl_ms, lease.note, now);
      console.log(`${created.id}  ${created.owner}  ${created.meter_id}  expect ${lease.expect_percent}%  expires ${created.expires_at}`);
    }
    store.audit("cli", "plan_import", file, `${planned.length} lease${planned.length === 1 ? "" : "s"}`);
  } finally { store.close(); }
  console.log(`imported ${planned.length} advisory lease${planned.length === 1 ? "" : "s"} from ${plan.windows.length} window${plan.windows.length === 1 ? "" : "s"}`);
  return 0;
}

async function plan(argv: string[]): Promise<number> {
  if (argv[0] === "import") return planImport(argv.slice(1));
  const meter = option(argv, "--meter");
  if (!meter) throw new Error("Usage: headroom plan --meter <meter_id> --until reset [--reserve <percent>] [--json]");
  const until = option(argv, "--until");
  if (until !== "reset") throw new Error("--until must be 'reset' (the only supported value)");
  const reserveValue = option(argv, "--reserve");
  if (reserveValue !== undefined && (!Number.isFinite(Number(reserveValue)) || Number(reserveValue) < 0 || Number(reserveValue) > 100)) throw new Error("--reserve must be 0 through 100");
  const asJson = argv.includes("--json");
  const need = option(argv, "--need");
  if (need) parseGateNeed(`${need}:0`);
  const request = await requestDaemon("plan", { meter, reserve_percent: reserveValue === undefined ? undefined : Number(reserveValue), need });
  let result: ({ meter: string } & PlanResult) | { meter: string; error: string };
  if (request !== undefined) { result = unwrapRpc(request) as typeof result; }
  else {
    directReadNotice();
    const policy = await readPolicy();
    const reserve = reserveValue === undefined ? policy.freeze_reserve_pct : Number(reserveValue);
    const store = await HeadroomStore.open();
    try { result = planFor(store, meter, reserve, new Date(), policy.staleness_minutes, policy.reserve, need); store.audit("cli", "plan", meter, "ok"); } finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(withContract(result))); return 0; }
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
    try { result = gateFor(store, needs, target, policy.freeze_reserve_pct, usePlan, new Date(), { ...options, pacing: policy.pacing, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve }); store.audit("cli", "gate", meter ?? (Array.isArray(target) ? target.join(",") : null), result.allowed ? "yes" : "no"); } finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(withContract(result))); return 0; }
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
  const need = option(argv, "--need"); if (need) parseGateNeed(`${need}:0`);
  const request = await requestDaemon("fill", { meter, lane_cost_percent: laneCost, weekly_reserve_percent: weeklyReserveValue === undefined ? undefined : Number(weeklyReserveValue), owner, plan_share_percent: planSharePercent, need });
  let result: Awaited<ReturnType<typeof fillFor>>;
  if (request !== undefined) { result = unwrapRpc(request) as typeof result; }
  else {
    directReadNotice();
    const policy = await readPolicy();
    const weeklyReserve = weeklyReserveValue === undefined ? policy.freeze_reserve_pct : Number(weeklyReserveValue);
    const store = await HeadroomStore.open();
    try { result = await fillFor(store, meter, laneCost, weeklyReserve, new Date(), { owner, planSharePercent, pacing: policy.pacing, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve, needWindow: need }); store.audit("cli", "fill", meter, "ok"); } finally { store.close(); }
  }
  if (asJson) { console.log(JSON.stringify(withContract(result))); return 0; }
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
    result = routeFor(store, meters, accounts, policy, argv.includes("--allow-unknown"), new Date(), owner);
    store.audit("cli", "route", actionClass, result.principal ? "yes" : "no");
  } finally { store.close(); }
  if (argv.includes("--json")) { console.log(JSON.stringify(withContract(result))); return result.principal ? 0 : 2; }
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
    console.log(JSON.stringify(withContract({
      principal, truth: "estimated", source: "local session logs", window_start: since.toISOString(), window_end: now.toISOString(),
      models: shares.map((item) => ({ ...item, share_percent: totalTokens > 0 ? Math.round(((item.input_tokens + item.output_tokens) / totalTokens) * 1000) / 10 : 0 })),
    })));
    return 0;
  }
  if (!shares.length || totalTokens === 0) {
    console.log(`${principal}  no local session-log token data for the current 5h window (estimated, from ${account.location}/projects)`);
    return 0;
  }
  console.log(`${principal} model token share, current 5h window from ${formatReset(since.toISOString())}: a local estimate from session logs, not the vendor meter`);
  console.log(`  (for the vendor's model-scoped meter use \`headroom --principal ${principal}\` and gate with --model <slug>)`);
  for (const item of shares) {
    const tokens = item.input_tokens + item.output_tokens;
    const share = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
    console.log(`  ${item.model.padEnd(24)} ${share.toFixed(0)}% of tokens, estimate (${item.input_tokens.toLocaleString()} in / ${item.output_tokens.toLocaleString()} out)`);
  }
  return 0;
}

/** Usage for the default command, shared by `--help` and the argument check. */
export const STATUS_HELP = "Usage: headroom [--json] [--principal X] [--threshold N] [--refresh] [--ttl 0] [--models] [--human|--plain|--agent] [--verbose] [--color|--no-color]";

export async function observe(argv: string[]): Promise<number> {
  const valueless = new Set(["--json", "--refresh", "--models", ...STATUS_VIEW_FLAGS]);
  const allowed = new Set(["--threshold", "--principal", "--ttl", ...valueless]);
  for (let index = 0; index < argv.length; index += 1) { if (!allowed.has(argv[index])) throw new Error(STATUS_HELP); if (!valueless.has(argv[index])) index += 1; }
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
      await syncClaudeProbeState(store);
      const polled = await pollAccounts(principal, { claudeGrant: claudeGrantGate(store), noDaemon: true });
      failures = polled.failures;
      store.insertPoll(polled.observations);
      for (const [principalId, outcome] of Object.entries(polled.claudeProbeOutcomes ?? {})) store.audit("cli", "claude_probe", principalId, outcome);
      const rawObservations = store.latestPerWindow().filter((item) => !principal || item.principal_id === principal);
      const now = new Date();
      const paced = withPaceInfo(rawObservations, store.burnRateFor(rawObservations, now), now);
      observations = withLastKnown(paced, store.lastKnownFor(rawObservations, now));
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
  const view = { ...statusViewOptions(argv, process.stdout.isTTY === true, process.env, process.stdout.columns), direct };
  // The grouped view's own footer already says where the numbers came from, so
  // the stderr notice would only repeat it on the one form that carries both.
  if (direct && (view.form !== "grouped" || argv.includes("--json"))) directReadNotice();
  const policy = await readPolicy();
  const thresholdRows = threshold === undefined ? undefined : thresholdReport(observations, threshold);
  const leaseMap = new Map<string, Lease[]>(); for (const item of leases) leaseMap.set(item.meter_id, [...(leaseMap.get(item.meter_id) ?? []), item]);
  if (argv.includes("--json")) { const withResets = withResetsIn(observations); console.log(JSON.stringify(withContract(thresholdRows === undefined ? { observations: withResets, leases } : { observations: withResets, leases, threshold: { percent: threshold, windows: thresholdRows, any_crossed: thresholdRows.some((item) => item.crossed), any_blocking: thresholdRows.some((item) => item.blocking) } }))); }
  else {
    // accounts.toml names each principal's vendor; a missing or unreadable
    // registry only costs the header its vendor word, never the reading.
    const vendors = new Map((await readAccounts().catch(() => [])).map((account) => [account.name, isLocalAccount(account) ? "local" : account.vendor]));
    for (const line of renderStatus({ observations, policy, resetSeen, freeResetUsed, leases: leaseMap, vendors }, view)) console.log(line);
    for (const failure of failures) console.log(failure);
    // Silent on failure (policy.update_check = false or a network problem):
    // the update notice must never turn a routine status call into one.
    const updateNotice = await updateNoticeLine(policy).catch(() => undefined);
    if (updateNotice) console.log(updateNotice);
  }
  if (thresholdRows?.some((item) => item.blocking)) return 2;
  return failures.length ? observations.length ? 3 : 1 : 0;
}

async function responseShape(argv: string[]): Promise<number> {
  if (argv.length !== 3 || argv[0] !== "--principal" || !argv[1] || argv[2] !== "--shape") throw new Error("Usage: headroom --principal <id> --shape");
  const account = (await readAccounts()).find((item) => item.name === argv[1]);
  if (!account || isLocalAccount(account) || account.adapter !== "native-ts") throw new Error("--shape requires a native TypeScript Claude, Codex, Antigravity or Gemini principal");
  const responses = account.vendor === "codex" ? await codexResponseShape(account)
    : account.vendor === "claude" ? { usage: await claudeResponseShape(account) }
    : account.vendor === "antigravity" ? await antigravityResponseShape(account)
    : account.vendor === "gemini" ? await geminiResponseShape(account)
    : undefined;
  if (!responses) throw new Error("--shape requires a native TypeScript Claude, Codex, Antigravity or Gemini principal");
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
  if (asJson) { console.log(JSON.stringify(withContract({ ...decision, cost, leased_id: leasedId ?? null }))); return; }
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
 *
 * `--render` prints the fuller line instead: the session's own two numbers
 * from this very payload, plus Headroom's view of every other principal,
 * model-scoped meter, pace state, lease and reserve, read from the daemon
 * under a fixed millisecond budget with a store fallback and no vendor call
 * at all. With `--chain` the chained output goes first and this line follows
 * on its own row.
 */
async function statusline(argv: string[]): Promise<number> {
  const chainAt = argv.indexOf("--chain");
  const chainCommand = chainAt >= 0 ? argv.slice(chainAt + 1).join(" ") : undefined;
  // Everything after --chain belongs to the chained command, so headroom's
  // own flags are only ever read from the part before it.
  const renderOptions = parseRenderOptions(chainAt >= 0 ? argv.slice(0, chainAt) : argv, process.stdout.isTTY === true);
  let raw = "";
  let snapshot: ReturnType<typeof snapshotFromStatuslinePayload>;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const profile = statuslineProfile(configDir);
  const now = new Date();
  try {
    raw = await readStdinText();
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { payload = undefined; }
    snapshot = snapshotFromStatuslinePayload(payload, profile, now);
    if (snapshot) {
      // Resolves and verifies the same safe Headroom home every other
      // command uses (never the raw, unchecked headroomHome() this used to
      // call directly), then verifies the statusline subdirectory itself
      // the same way before ever writing into it, and writes atomically
      // (temp file + rename, refusing an existing symlink at the
      // destination outright) rather than truncating the destination path
      // in place.
      const home = await safeHeadroomDirectory();
      const dir = await safeOutputDirectory(join(home, "statusline"));
      const path = join(dir, `${profile}.json`);
      await writeFileAtomic(path, JSON.stringify(snapshot), 0o600);
    }
  } catch { /* the bar must still print even if reading stdin or writing the snapshot fails */ }
  if (chainCommand) {
    try {
      const chained = await runChainCommand(chainCommand, raw);
      // Without --render the chained command owns the bar outright, exactly
      // as before. With it, the chained output goes first and headroom's own
      // line follows on a row of its own -- Claude Code renders one row per
      // printed line -- so adopting --render never costs an existing
      // statusline its place.
      if (!renderOptions) { process.stdout.write(chained); return 0; }
      process.stdout.write(chained.endsWith("\n") || chained === "" ? chained : `${chained}\n`);
    } catch { /* fall through to headroom's own bar rather than print nothing */ }
  }
  if (renderOptions) { console.log(await renderedStatusline(snapshot, profile, renderOptions, now)); return 0; }
  console.log(formatStatuslineBar(snapshot, now));
  return 0;
}

const USAGE_PASTE_HELP = "Usage: headroom usage (--paste | --clipboard) [--principal <id>] [--json]";

/** Whether a bare command name resolves on PATH, checked without running a
 * shell so nothing in the environment can turn a probe into an execution. */
function commandOnPath(name: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));
}

function readClipboardText(): Promise<string> {
  const { command, args } = clipboardCommand(process.platform, commandOnPath);
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(new Error(`could not read the clipboard with ${command}: ${safeError(error)}`));
      else resolve(stdout);
    });
  });
}

/** One printed line per ingested window: the meter, the window, the vendor's
 * own percentage, and the reset both as a clock time and as a countdown. */
export function usagePasteLine(observation: Observation, now = new Date()): string {
  const used = observation.quantity?.used ?? 0;
  const remaining = resetsIn(observation.resets_at, now).resets_in;
  const reset = observation.resets_at ? `resets ${formatReset(observation.resets_at)}${remaining ? ` (in ${remaining})` : ""}` : "no reset in the panel";
  return `ingested ${observation.meter_id} ${label(observation)} ${Math.round(used)}% used, ${reset}`;
}

/**
 * `headroom usage --paste` (stdin) or `--clipboard`: reads Claude Code's own
 * `/usage` panel as text and stores it as observations, so a figure only the
 * human can see becomes a machine reading within a minute. This is the answer
 * to a blocked meter: the account-wide probe can be denied, or a scoped
 * weekly bar can sit near its cap while the account-wide window still looks
 * free, and an orchestrator dispatching on the account meter alone would walk
 * straight into it. The rows go through the same store insert as a polled
 * reading, so events, pace states, `gate`, `can`, `rate` and `route` see them
 * immediately; the next successful poll supersedes them by being newer.
 */
async function usagePaste(argv: string[]): Promise<number> {
  const allowed = new Set(["--paste", "--clipboard", "--json", "--principal"]);
  for (let index = 0; index < argv.length; index += 1) {
    if (!allowed.has(argv[index])) throw new Error(USAGE_PASTE_HELP);
    if (argv[index] === "--principal") index += 1;
  }
  const fromClipboard = argv.includes("--clipboard");
  if (fromClipboard === argv.includes("--paste")) throw new Error(USAGE_PASTE_HELP);
  const principal = resolveClaudePrincipal(await readAccounts(), option(argv, "--principal"));
  const text = fromClipboard ? await readClipboardText() : await readStdinText();
  const now = new Date();
  const panel = parseUsagePanel(text, now);
  for (const line of panel.unparsed) console.error(`warning: could not read "${line}"`);
  if (!panel.windows.length) {
    console.error('no usage window in the pasted text; expected a line like "Current session" or "Current week (all models)" with a percent');
    return 1;
  }
  const store = await HeadroomStore.open();
  let stored;
  try {
    stored = store.insertAll(observationsFromUsagePaste(panel.windows, principal, now));
    store.audit("cli", "usage_paste", principal, "ok");
  } finally { store.close(); }
  if (argv.includes("--json")) { console.log(JSON.stringify(withResetsIn(stored, now))); return 0; }
  for (const item of stored) console.log(usagePasteLine(item, now));
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

/** Checks that the Claude credential is readable, for every Claude principal
 * in the registry or just the named one: it runs the probe once per principal
 * and prints either "readable, no dialog needed" or the real error the probe
 * reported. Nothing is granted. The probe reads the credential through
 * /usr/bin/security, which the Keychain item's own access list admits, so
 * there is no dialog to answer and nothing for the operator to allow.
 *
 * A successful check still clears that principal's keychain_grant_needed
 * marker, so a home carrying one from an older build (a denial, a timeout, or
 * a probe rebuild recorded before this read path existed) resumes polling.
 *
 * The probe checked here is always the one the daemon actually uses: the
 * pinned path (store.probePath()) is tried first, so a check run from a
 * different install than the one running the background daemon (the
 * global-npm-vs-checkout mismatch this exists for) still exercises the
 * daemon's own binary rather than whichever one this CLI process would
 * otherwise pick. If that pinned binary no longer exists on disk, this
 * refuses to silently substitute a different one -- it says so and asks for
 * `--use-this-build` before checking (and re-pinning to) whatever probe this
 * CLI resolves on its own. */
export async function keychain(argv: string[]): Promise<number> {
  const useThisBuild = argv.includes("--use-this-build");
  const parsed = argv.filter((arg) => arg !== "--use-this-build");
  if (parsed[0] !== "grant" || parsed.length > 3 || (parsed[1] && parsed[1] !== "--principal")) throw new Error("Usage: headroom keychain grant [--principal <claude-principal>] [--use-this-build]");
  // Printed before anything else so a reader who came here from an older
  // README, or from a stored marker, learns that there is nothing to answer.
  if (process.platform === "darwin") console.log("Checking that the Claude credential is readable. No Keychain dialog is involved: the probe reads it through /usr/bin/security, which the item already admits.");
  const requested = option(parsed, "--principal");
  const accounts = (await readAccounts()).filter((item): item is ProviderAccount => !isLocalAccount(item) && item.vendor === "claude");
  const targets = requested ? accounts.filter((item) => item.name === requested) : accounts;
  if (!targets.length) throw new Error(requested ? `No Claude principal named ${requested}; run headroom accounts discover` : "No Claude principal found; run headroom accounts discover");
  const store = await HeadroomStore.open();
  let failures = 0;
  try {
    const existingPin = store.probePath();
    let pinnedPath = existingPin;
    if (existingPin) {
      const resolvedWithPin = await resolveProbePath(existingPin);
      if (resolvedWithPin !== existingPin) {
        if (!useThisBuild) {
          console.error(`The daemon's pinned probe (${existingPin}) no longer exists on disk.`);
          console.error(resolvedWithPin
            ? `This CLI would use a different probe instead (${resolvedWithPin}); re-run with --use-this-build to check that one and re-pin the daemon to it.`
            : "This CLI has no other probe available either; build one (npm run engine:build) or reinstall headroomd.");
          return 1;
        }
        // The stale pin is ignored from here on; a fresh grant below resolves
        // (and re-pins to) whatever probe this CLI build actually has.
        pinnedPath = undefined;
      }
    }
    const hash = process.platform === "darwin" ? await probeBinaryHash(pinnedPath) : undefined;
    for (const account of targets) {
      let probePath: string | undefined;
      try {
        ({ probePath } = await checkClaudeCredentialReadable(account.location, pinnedPath));
      } catch (error) {
        // Claude Code was never run against this config dir, so there is no
        // credential to read yet: a distinct, actionable message beats the
        // probe's generic "no credentials" wording, and must not abort the
        // remaining principals.
        if (error instanceof ClaudeProbeError && error.message === "no credentials in Keychain for this config dir") {
          console.error(noKeychainItemMessage(account.location));
          failures += 1;
          continue;
        }
        // Every other probe failure is reported as it came back -- a failed
        // `security` read carrying the tool's exit status, an expired token,
        // a logged-out config dir -- rather than translated into a fix that
        // no longer exists. One bad principal never stops the rest.
        if (error instanceof ClaudeProbeError) {
          console.error(`${account.name}: ${error.message}`);
          failures += 1;
          continue;
        }
        throw error;
      }
      store.clearKeychainGrantNeeded(account.name);
      // The binary that just proved itself under an operator-run check must
      // never be treated as an unproven first run again by a background poll.
      if (hash) store.setProbeGrantedHash(hash);
      // Pinned on the very first successful check this Headroom home has
      // ever recorded, and re-pinned whenever a stale pin was just replaced
      // above (pinnedPath === undefined while existingPin was set) -- every
      // later probe call (background polls included, see collector.ts) uses
      // exactly this path from here on, even if a second candidate binary
      // later appears on disk.
      if ((!existingPin || pinnedPath === undefined) && probePath) store.setProbePath(probePath);
      console.log(`${account.name}: credential readable, no dialog needed${probePath ? ` (probe: ${probePath})` : ""}`);
    }
  } finally { store.close(); }
  return failures ? 1 : 0;
}

/** One line per top-level command for `headroom --help` / `headroom help`. */
export const COMMAND_LIST: ReadonlyArray<readonly [string, string]> = [
  ["status", "Print the current meters (the default; grouped for a terminal, one dense line per meter in a pipe)"],
  ["dashboard (top)", "Live terminal dashboard from cached readings, with pause, events, and leases"],
  ["can <action-class>", "Check whether an action class can consume its meters, per routing.toml"],
  ["events", "List reset and free-reset events"],
  ["history <meter>", "List stored observations for one meter"],
  ["lease start|list|end", "Reserve, list, or release a meter lease"],
  ["cost [<action-class>]", "Print the learned median/IQR/sample-count spent percent per action class"],
  ["rate", "Burn in percent per hour over a recent window, and ETA to the limit"],
  ["spend", "Per-owner attributed spend on a shared meter, from the spend ledger"],
  ["export", "Export observations, events, the spend ledger, and leases for a period as JSON or CSV"],
  ["inbox", "Read this session's hand-off messages, or send one to another session"],
  ["plan", "Points available per remaining 5h window and the plan line to hold (plan import <file> loads a budget plan)"],
  ["gate", "Pre-dispatch check: do these points fit the current window (and the plan)"],
  ["run", "Gate, lease, and launch one command as an atomic dispatch"],
  ["report", "Record a vendor-reported exhausted meter"],
  ["ack plan", "Acknowledge a principal plan downgrade before dispatching again"],
  ["wait", "Block until a meter's window resets, or --max elapses"],
  ["fill", "How many more lanes (and which action classes) fit before a window's unspent points are lost at reset"],
  ["route", "Pick the principal with the most headroom for an action class, and print its launch environment"],
  ["accounts discover", "Scan for Claude/Codex/Antigravity accounts and write accounts.toml"],
  ["doctor", "Diagnose the installation: principals, credentials, daemon, config (--bundle [path] writes a redacted report for a GitHub issue)"],
  ["setup", "One-shot interactive setup: discovery, doctor, Keychain grant, service, MCP registration"],
  ["keychain grant", "macOS: check that the Claude credential is readable (no dialog)"],
  ["install-service", "Install the daemon as a launchd/systemd/Task Scheduler service"],
  ["uninstall-service", "Remove the installed daemon service"],
  ["uninstall", "Reverse setup: stop/remove the service, remove the Claude Code MCP registration, optionally delete the Headroom home (--home), and print the npm uninstall command"],
  ["daemon", "Run the daemon in the foreground (an installed service does this for you)"],
  ["mcp", "Run the MCP server over stdio"],
  ["engine install", "Install the optional native sensing engine"],
  ["engine status", "Show whether the native and upstream engines are installed"],
  ["logs", "Print the tail of the daemon log"],
  ["notify", "Configure notifications, send a test message, or show the delivery ledger"],
  ["statusline", "Read Claude Code's statusLine JSON from stdin, snapshot it as a zero-auth source, and print a compact bar (--render for the full line)"],
  ["usage", "Turn a pasted Claude Code /usage panel into observations (--paste from stdin, --clipboard from the clipboard)"],
  ["update", "Check the npm registry for a newer headroomd and install it (--notes, --dry-run)"],
  ["version", "Print the Headroom version"],
  ["contract", "Print the JSON contract version and where it is documented"],
  ["completion <bash|zsh|fish|pwsh>", "Print a shell completion script for the given shell"],
];

/** Usage text for `headroom <command> --help`, keyed by the command's first token. */
export const COMMAND_HELP: Readonly<Record<string, string>> = {
  status: STATUS_HELP,
  dashboard: "Usage: headroom dashboard (alias: top) [--interval <s>] [--once] [--no-color] [--verbose]",
  can: "Usage: headroom can <action-class> --owner <name> [--allow-unknown] [--expect <percent>] [--lease] [--ttl 30m] [--json]",
  events: "Usage: headroom events [--since 24h] [--table]",
  history: "Usage: headroom history <meter> [--since 24h]",
  lease: [
    "Usage: headroom lease <start|end|list>",
    "  start: headroom lease start --owner <name> --meter <meter_id> [--expect <percent>] [--ttl 30m] [--note ...] [--class <action-class>]",
    "  end:   headroom lease end <id> --owner <name> [--force]",
    "  list:  headroom lease list [--json]",
  ].join("\n"),
  cost: "Usage: headroom cost [<action-class>] [--json]",
  rate: "Usage: headroom rate [--meter <meter_id>] [--owner <name>] [--minutes 30] [--window 10m] [--json]",
  spend: SPEND_HELP,
  export: EXPORT_HELP,
  inbox: [INBOX_HELP, `  send: ${INBOX_SEND_HELP}`].join("\n"),
  plan: [
    "Usage: headroom plan --meter <meter_id> --until reset [--reserve <percent>] [--json]",
    `  import: ${PLAN_IMPORT_HELP}`,
  ].join("\n"),
  gate: "Usage: headroom gate --need 5h:<N> [--need wk:<N>] (--meter <meter_id> | --class <action-class> | --model <slug>) --owner <name> [--plan] [--plan-share <N>] [--json]",
  run: "Usage: headroom run --meter <meter_id> --need <window>:<points> [--need ...] --owner <name> [--class <action-class>] [--ttl 3h] [--json] -- <command> [args...]",
  report: "Usage: headroom report --meter <meter_id> --exhausted [--until <iso or vendor date>] [--note <text>]",
  ack: "Usage: headroom ack plan <principal>",
  wait: "Usage: headroom wait --meter <meter_id> --until-reset [--max 6h]",
  fill: "Usage: headroom fill --meter <meter_id> --until-reset [--lane-cost <percent>] [--weekly-reserve <percent>] [--plan-share <N>] --owner <name> [--json]",
  route: "Usage: headroom route --class <action-class> --owner <name> [--allow-unknown] [--json]",
  accounts: "Usage: headroom accounts discover",
  doctor: "Usage: headroom doctor [--bundle [path]]",
  setup: "Usage: headroom setup [--yes] [--dry-run] [--skip-service] [--skip-mcp]",
  keychain: "Usage: headroom keychain grant [--principal <claude-principal>] [--use-this-build]",
  "install-service": "Usage: headroom install-service [--dry-run]",
  "uninstall-service": "Usage: headroom uninstall-service [--dry-run]",
  uninstall: "Usage: headroom uninstall [--home] [--yes] [--dry-run]",
  daemon: "Usage: headroom daemon",
  mcp: "Usage: headroom mcp",
  engine: "Usage: headroom engine <install|status> [--pin]",
  logs: "Usage: headroom logs [--tail 50]",
  notify: NOTIFY_USAGE,
  statusline: "Usage: headroom statusline [--render] [--style compact|full] [--meters <m1,m2>] [--color] [--chain <command>]",
  usage: USAGE_PASTE_HELP,
  update: "Usage: headroom update [--notes] [--dry-run] [--yes]",
  version: "Usage: headroom version (or: headroom --version)",
  contract: "Usage: headroom contract",
  completion: COMPLETION_HELP,
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
  // The JSON contract version is independent of the package version above:
  // it names the shape of --json/MCP output, which can stay at 1.0 across
  // many package releases. See docs/json-contract.md for what it covers.
  if (argv[0] === "contract") { console.log(`contract ${JSON_CONTRACT_VERSION}`); console.log(JSON_CONTRACT_DOC_PATH); return 0; }
  if (argv.includes("--help") && argv[0] && COMMAND_HELP[argv[0]]) { console.log(COMMAND_HELP[argv[0]]); return 0; }
  // Dispatched before anything else in main() (the proxy strip, the legacy
  // home migration, both of which can throw on a corrupted policy.toml or an
  // unusual home layout): this runs on every Claude Code prompt render, and
  // a statusLine command that fails to print at all blanks the user's status
  // bar. statusline() itself never throws for the same reason.
  if (argv[0] === "statusline") return statusline(argv.slice(1));
  if (argv[0] === "dashboard" || argv[0] === "top") return (await import("./dashboard.js")).dashboardCommand(argv.slice(1));
  // Same reasoning as statusline just above: a shell completion pop-up runs
  // on every Tab press, and the legacy-home notice line printed a few lines
  // down would land inside the completion script's own stdout (fatal for
  // `eval "$(headroom completion ...)"`) or as a spurious extra candidate --
  // so these are dispatched before that notice can ever print.
  if (argv[0] === "completion") return completionCommand(argv.slice(1));
  if (argv[0] === "_complete-meters") return printCompletionMeterIds();
  if (argv[0] === "_complete-principals") return printCompletionPrincipalIds();
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
  if (argv[0] === "doctor") return doctor(argv.slice(1));
  if (argv[0] === "setup") return runSetup(argv.slice(1));
  if (argv[0] === "logs") return logs(argv.slice(1));
  if (argv[0] === "notify") return notifyCommand(argv.slice(1));
  if (argv[0] === "daemon") return daemon();
  if (argv[0] === "keychain") return keychain(argv.slice(1));
  if (argv[0] === "mcp") { serveMcp(); return await new Promise<number>(() => undefined); }
  if (argv[0] === "install-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: headroom install-service [--dry-run]");
    const result = await installService(process.argv[1], process.platform, undefined, process.execPath, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would write" : "wrote"} ${result.path}\nTo load it: ${result.command}`);
    // Names the exact executable and script the service will run, so a
    // maintainer installing from a repo checkout (rather than a global npm
    // install) can see up front which build the background daemon is now
    // bound to.
    console.log(`The service will run: ${result.runtime} ${result.script} daemon`);
    if (result.dryRun) console.log(`\n${result.contents}`);
    return 0;
  }
  if (argv[0] === "uninstall-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: headroom uninstall-service [--dry-run]");
    const result = await uninstallService(process.platform, undefined, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would remove" : "removed"} ${result.path}\nTo unload it: ${result.command}`); return 0;
  }
  if (argv[0] === "uninstall") return runUninstall(argv.slice(1));
  if (argv[0] === "usage") return usagePaste(argv.slice(1));
  if (argv[0] === "update") return runUpdate(argv.slice(1));
  if (argv[0] === "history") return history(argv.slice(1));
  if (argv[0] === "events") return events(argv.slice(1));
  if (argv[0] === "lease") return lease(argv.slice(1));
  if (argv[0] === "can") return can(argv.slice(1));
  if (argv[0] === "cost") return cost(argv.slice(1));
  if (argv[0] === "rate") return rate(argv.slice(1));
  if (argv[0] === "spend") return spend(argv.slice(1));
  if (argv[0] === "export") return exportCommand(argv.slice(1));
  if (argv[0] === "inbox") return inbox(argv.slice(1));
  if (argv[0] === "plan") return plan(argv.slice(1));
  if (argv[0] === "gate") return gate(argv.slice(1));
  if (argv[0] === "run") return run(argv.slice(1));
  if (argv[0] === "report") return report(argv.slice(1));
  if (argv[0] === "ack") return ack(argv.slice(1));
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
