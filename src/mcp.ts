import { randomUUID } from "node:crypto";
import { claudeGrantGate, syncClaudeGrantState } from "./adapters/claude.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { pollAccounts, PROTECTED_STATUS_PATTERN } from "./collector.js";
import { readPolicy, readRouting } from "./config.js";
import { observeLocal } from "./engine/local.js";
import { canRouteWithLeases, unknownMeterPrincipals, type CanDecision } from "./policy.js";
import { withPaceInfo } from "./pace.js";
import { buildCostEstimate } from "./cost.js";
import { parseGateNeed, type GateNeed } from "./pacing.js";
import { fillFor, gateFor, pickDecidingObservation, planFor, rateLines } from "./orchestrator-reads.js";
import { readAccounts } from "./registry.js";
import { resetsIn, withResetsIn } from "./resets.js";
import { safeError } from "./security.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type ProviderAccount } from "./types.js";

type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
const tools = [
  { name: "quota_status", description: "Return the latest quota windows for every Headroom meter.", inputSchema: { type: "object", properties: {} } },
  { name: "quota_can", description: "Check whether an action class can consume all of its meters. With no expect_percent, reports the learned cost and confidence for this action class; lease reserves the deciding meter for the learned (or given) expectation so the next call learns too.", inputSchema: { type: "object", properties: { action_class: { type: "string" }, owner: { type: "string" }, allow_unknown: { type: "boolean" }, expect_percent: { type: "number" }, lease: { type: "boolean" } }, required: ["action_class", "owner"] } },
  { name: "quota_events", description: "Return Headroom events since an ISO timestamp or duration resolved by the caller.", inputSchema: { type: "object", properties: { since: { type: "string" } } } },
  { name: "quota_lease_start", description: "Reserve a meter for an orchestrator. owner defaults to this MCP session's client name and session id when omitted.", inputSchema: { type: "object", properties: { owner: { type: "string" }, meter_id: { type: "string" }, expected_percent: { type: "number" }, ttl_ms: { type: "number" }, note: { type: "string" }, action_class: { type: "string" } }, required: ["meter_id"] } },
  { name: "quota_lease_end", description: "End a meter lease. A different owner must set force plus confirm_force and a reason, both of which are audited.", inputSchema: { type: "object", properties: { id: { type: "string" }, owner: { type: "string" }, force: { type: "boolean" }, confirm_force: { type: "boolean" }, reason: { type: "string" } }, required: ["id", "owner"] } },
  { name: "quota_leases", description: "List meter leases and estimated spend.", inputSchema: { type: "object", properties: {} } },
  { name: "quota_cost", description: "Learned median, interquartile range and sample count of spent percent, per action class.", inputSchema: { type: "object", properties: { action_class: { type: "string" } } } },
  { name: "quota_rate", description: "Burn in percent per hour over the last N minutes (default 30), and projected time to the window's limit.", inputSchema: { type: "object", properties: { meter: { type: "string" }, minutes: { type: "number" } } } },
  { name: "quota_plan", description: "Weekly points available per remaining 5h window before reset, and the plan line (linear budget) to hold.", inputSchema: { type: "object", properties: { meter: { type: "string" }, reserve_percent: { type: "number" } }, required: ["meter"] } },
  { name: "quota_gate", description: "Pre-dispatch check: do these points fit the current window (and, with plan true, the plan line)? Under even pacing (the default), a 5h need is also checked against the caller's pro-rata line and a 10-minute burst check. needs is an array like [\"5h:15\", \"wk:3\"].", inputSchema: { type: "object", properties: { needs: { type: "array", items: { type: "string" } }, meter: { type: "string" }, plan: { type: "boolean" }, reserve_percent: { type: "number" }, owner: { type: "string" }, plan_share_percent: { type: "number" }, action_class: { type: "string" } }, required: ["needs"] } },
  { name: "quota_wait", description: "Returns immediately (never blocks) with the meter's reset time and a suggested sleep, for a caller that polls itself.", inputSchema: { type: "object", properties: { meter: { type: "string" } }, required: ["meter"] } },
  { name: "quota_fill", description: "How many more lanes fit before a 5h window's unspent points are lost at reset, and which routing.toml action classes fit the remaining points and minutes. Under even pacing (the default), only offers the full remainder in the last 45 minutes before reset; earlier than that it offers the caller's pro-rata allowance.", inputSchema: { type: "object", properties: { meter: { type: "string" }, lane_cost_percent: { type: "number" }, weekly_reserve_percent: { type: "number" }, owner: { type: "string" }, plan_share_percent: { type: "number" } }, required: ["meter"] } },
];

/**
 * Lease ownership is a client-supplied string; binding it to something the
 * caller doesn't fully control closes the easiest form of accidental
 * cross-orchestrator lease theft. This stdio transport serves exactly one
 * client for the process's lifetime, so a session id assigned once (and
 * refreshed at initialize, per MCP's own session model) plus the client's own
 * declared name gives every lease started without an explicit owner a stable,
 * traceable identity: `<client name>#<session id>`.
 */
let mcpSessionId = randomUUID();
let mcpClientName = "mcp-client";

function deriveLeaseOwner(owner: unknown): string {
  if (typeof owner === "string" && owner.trim()) return owner.trim();
  return `${mcpClientName}#${mcpSessionId}`;
}

function response(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result }; }
function failure(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

/** A local, single-client stdio server still bounds what one unterminated
 * line can hold in memory, and how many requests it will process at once,
 * rather than trusting the client to behave. Mirrors daemon.ts's socket-level
 * bounds. */
const MAX_MCP_LINE_BYTES = 64 * 1024;
const MAX_CONCURRENT_MCP_CALLS = 32;
let inFlightMcpCalls = 0;

/** Minimal MCP stdio transport; deliberately dependency-free for offline installs. */
export function serveMcp(): void {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (part: string) => {
    buffer += part;
    if (Buffer.byteLength(buffer, "utf8") > MAX_MCP_LINE_BYTES) {
      // No line terminator arrived before the cap: drop the oversized
      // fragment rather than let it grow buffer without bound.
      process.stdout.write(`${JSON.stringify(failure(null, -32600, "Request line exceeds the maximum size"))}\n`);
      buffer = "";
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (inFlightMcpCalls >= MAX_CONCURRENT_MCP_CALLS) {
        process.stdout.write(`${JSON.stringify(failure(null, -32000, "Too many concurrent requests"))}\n`);
        continue;
      }
      inFlightMcpCalls += 1;
      // handleMcp() itself never rejects (every tool handler is wrapped), but
      // this stdio loop must survive even a defect in that guarantee rather
      // than crash the process on an unhandled rejection.
      void handleMcp(line)
        .then((result) => { if (result) process.stdout.write(`${JSON.stringify(result)}\n`); })
        .catch(() => { /* already converted to a JSON-RPC error by handleMcp */ })
        .finally(() => { inFlightMcpCalls -= 1; });
    }
  });
}

type DirectResult = Record<string, unknown>;

/** Attaches burn/empty-in/sustainable-pace fields to every observation of a
 * fresh store read, from one shared burn computation. */
function withPace(store: HeadroomStore, observations: ReturnType<HeadroomStore["latestPerWindow"]>, now: Date): ReturnType<HeadroomStore["latestPerWindow"]> {
  return withPaceInfo(observations, store.burnRateFor(observations, now), now) as ReturnType<HeadroomStore["latestPerWindow"]>;
}

/** Exported only for tests: the MCP client that skips the daemon and reads
 * straight from the collector must gate the Claude probe exactly like the
 * CLI's no-daemon fallback does. */
export async function directStatus(): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try {
    const policy = await readPolicy();
    const now = Date.now();
    // Without a daemon scheduler, a direct MCP status call has no in-process
    // rate limit of its own; share one persisted in the database instead, so
    // repeated tool calls (or several MCP client processes reading the same
    // HEADROOM_HOME) do not each poll the vendor independently. A protected
    // status backs off the same way the daemon's own scheduler does.
    const backoff = store.directPollBackoff();
    if (backoff.until > now) {
      store.audit("mcp", "status", null, "rate_limited");
      return { source: "direct", observations: withResetsIn(withPace(store, store.latestPerWindow(), new Date(now))), failures: [] };
    }
    if (now - backoff.lastPollAt < policy.poll_interval_minutes * 60_000) {
      return { source: "direct", observations: withResetsIn(withPace(store, store.latestPerWindow(), new Date(now))), failures: [] };
    }
    // Same gating as the CLI's no-daemon fallback (src/cli.ts observe()):
    // without this, an MCP client polling directly (no daemon running) would
    // spawn the Claude probe on every call regardless of a keychain_grants
    // marker, popping a fresh dialog instead of respecting it.
    const accounts = await readAccounts();
    const claudeIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude").map((account) => account.name);
    await syncClaudeGrantState(store, claudeIds);
    const polled = await pollAccounts(undefined, { claudeGrant: claudeGrantGate(store), noDaemon: true });
    store.insertAll(polled.observations);
    for (const [principalId, outcome] of Object.entries(polled.claudeProbeOutcomes ?? {})) store.audit("mcp", "claude_probe", principalId, outcome);
    store.audit("mcp", "status", null, polled.failures.length ? "partial" : "ok");
    const protectedFailure = polled.failures.some((failure) => PROTECTED_STATUS_PATTERN.test(failure));
    const failures = protectedFailure ? backoff.failures + 1 : 0;
    store.setDirectPollBackoff({ lastPollAt: now, until: protectedFailure ? now + Math.min(3_600_000, 60_000 * 2 ** backoff.failures) : 0, failures });
    return { source: "direct", observations: withResetsIn(withPace(store, store.latestPerWindow(), new Date(now))), failures: polled.failures };
  } finally { store.close(); }
}

async function directCan(action: string, allowUnknown: boolean, owner: string | undefined, expectOverride: number | null, leaseFlag: boolean): Promise<DirectResult> {
  if (!owner?.trim()) throw new Error("owner is required");
  const routing = await readRouting();
  if (!routing.present) throw new Error("No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action || "(missing)"}`);
  const [policy, accounts, store] = await Promise.all([readPolicy(), readAccounts(), HeadroomStore.open()]);
  try {
    const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
    if (unknownMeters.length) throw new Error(`Routing action class ${action} names unknown meter(s): ${unknownMeters.join(", ")}`);
    const localAccounts = accounts.filter(isLocalAccount);
    store.insertAll(await Promise.all(localAccounts.map(observeLocal)));
    const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
    const allMeters = [...new Set([...meters, ...localMeters])];
    const now = new Date();
    const rows = new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
    const burn = store.burnRateFor([...rows.values()].flat(), now);
    const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
    const decision = canRouteWithLeases(meters, localMeters, enriched, routing.local_preference, policy, allowUnknown, store.leases(undefined, true), owner, now);
    store.audit("mcp", "can", action, decision.allowed ? "yes" : "no");
    const { cost, leasedId } = annotateCanCost(store, action, expectOverride, leaseFlag, owner, decision, now);
    return { source: "direct", decision, cost, leased_id: leasedId ?? null };
  } finally { store.close(); }
}

/** Learned cost, confidence, "max more before reset" and (with lease) a new
 * lease for the deciding meter -- the same annotation whether the decision
 * came from the daemon or from directCan's own read, so quota_can's cost
 * report never depends on whether a daemon happens to be running. */
function annotateCanCost(store: HeadroomStore, action: string, expectOverride: number | null, leaseFlag: boolean, owner: string, decision: CanDecision, now: Date): { cost: ReturnType<typeof buildCostEstimate>; leasedId?: string } {
  const learned = store.learnedCost(action)[0];
  const deciding = pickDecidingObservation(store.latestPerWindow(decision.meter));
  const remaining = deciding?.quantity?.unit === "percent" ? deciding.quantity.remaining ?? (deciding.quantity.limit !== null ? deciding.quantity.limit - deciding.quantity.used : null) : null;
  const cost = buildCostEstimate(action, expectOverride, learned, remaining);
  let leasedId: string | undefined;
  if (leaseFlag && decision.allowed && cost.expected_percent !== null) {
    const lease = store.startLease(owner, decision.meter, cost.expected_percent, 30 * 60_000, `can:${action}`, now, action);
    store.audit("mcp", "lease_start", `${owner}:${decision.meter}`, "ok");
    leasedId = lease.id;
  }
  return { cost, leasedId };
}

async function directEvents(since: unknown): Promise<DirectResult> {
  const value = typeof since === "string" ? since : new Date(Date.now() - 86_400_000).toISOString();
  const store = await HeadroomStore.open();
  try {
    const events = store.events(value);
    store.audit("mcp", "events", null, "ok");
    return { source: "direct", events };
  } finally { store.close(); }
}

async function directLeaseStart(arguments_: Record<string, unknown>): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try {
    const owner = String(arguments_.owner ?? "");
    const meterId = String(arguments_.meter_id ?? "");
    const lease = store.startLease(owner, meterId, typeof arguments_.expected_percent === "number" ? arguments_.expected_percent : null, typeof arguments_.ttl_ms === "number" ? arguments_.ttl_ms : 30 * 60_000, typeof arguments_.note === "string" ? arguments_.note : null);
    store.audit("mcp", "lease_start", `${owner}:${meterId}`, "ok");
    return { source: "direct", lease };
  } finally { store.close(); }
}

async function directLeaseEnd(arguments_: Record<string, unknown>): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try {
    const id = String(arguments_.id ?? "");
    const owner = typeof arguments_.owner === "string" ? arguments_.owner : "";
    const force = arguments_.force === true;
    const lease = store.endLease(id, owner, force);
    if (force && lease.owner !== owner) {
      const reason = typeof arguments_.reason === "string" && arguments_.reason.trim() ? arguments_.reason.trim().slice(0, 200) : "(no reason given)";
      store.audit("mcp", "lease_force_end", `${owner}->${lease.owner}:${id} reason=${reason}`, "ok");
    } else {
      store.audit("mcp", "lease_end", `${owner}:${id}`, "ok");
    }
    return { source: "direct", lease };
  }
  finally { store.close(); }
}

async function directLeases(): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try { return { source: "direct", leases: store.leases(undefined, true) }; } finally { store.close(); }
}

async function directCost(actionClass: unknown): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try {
    const items = store.learnedCost(typeof actionClass === "string" && actionClass.trim() ? actionClass.trim() : undefined);
    store.audit("mcp", "cost", typeof actionClass === "string" ? actionClass : null, "ok");
    return { source: "direct", items };
  } finally { store.close(); }
}

async function directRate(meter: unknown, minutes: unknown): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try {
    const lines = rateLines(store, typeof meter === "string" ? meter : undefined, typeof minutes === "number" && minutes > 0 ? minutes : 30);
    store.audit("mcp", "rate", typeof meter === "string" ? meter : null, "ok");
    return { source: "direct", lines };
  } finally { store.close(); }
}

async function directPlan(meter: unknown, reservePercent: unknown): Promise<DirectResult> {
  if (typeof meter !== "string" || !meter) throw new Error("meter is required");
  const policy = await readPolicy();
  const reserve = typeof reservePercent === "number" ? reservePercent : policy.freeze_reserve_pct;
  const store = await HeadroomStore.open();
  try { const result = planFor(store, meter, reserve); store.audit("mcp", "plan", meter, "ok"); return { source: "direct", ...result }; } finally { store.close(); }
}

async function directGate(rawNeeds: unknown, meter: unknown, usePlan: unknown, reservePercent: unknown, owner: unknown, planSharePercent: unknown, actionClass: unknown): Promise<DirectResult> {
  const needs: GateNeed[] = Array.isArray(rawNeeds) ? rawNeeds.filter((item): item is string => typeof item === "string").map((item) => parseGateNeed(item)) : [];
  if (!needs.length) throw new Error("needs is required (e.g. [\"5h:15\"])");
  const policy = await readPolicy();
  const reserve = typeof reservePercent === "number" ? reservePercent : policy.freeze_reserve_pct;
  const store = await HeadroomStore.open();
  try {
    const result = gateFor(store, needs, typeof meter === "string" ? meter : undefined, reserve, usePlan === true, new Date(), {
      owner: typeof owner === "string" ? owner : undefined,
      planSharePercent: typeof planSharePercent === "number" ? planSharePercent : undefined,
      actionClass: typeof actionClass === "string" ? actionClass : undefined,
      pacing: policy.pacing,
    });
    store.audit("mcp", "gate", typeof meter === "string" ? meter : null, result.allowed ? "yes" : "no");
    return { source: "direct", ...result };
  } finally { store.close(); }
}

async function directFill(meter: unknown, laneCostPercent: unknown, weeklyReservePercent: unknown, owner: unknown, planSharePercent: unknown): Promise<DirectResult> {
  if (typeof meter !== "string" || !meter) throw new Error("meter is required");
  const policy = await readPolicy();
  const weeklyReserve = typeof weeklyReservePercent === "number" ? weeklyReservePercent : policy.freeze_reserve_pct;
  const laneCost = typeof laneCostPercent === "number" ? laneCostPercent : undefined;
  const store = await HeadroomStore.open();
  try {
    const result = await fillFor(store, meter, laneCost, weeklyReserve, new Date(), { owner: typeof owner === "string" ? owner : undefined, planSharePercent: typeof planSharePercent === "number" ? planSharePercent : undefined, pacing: policy.pacing });
    store.audit("mcp", "fill", meter, "ok");
    return { source: "direct", ...result };
  } finally { store.close(); }
}

/** Never blocks: returns the meter's short window's reset time (from the
 * already-collected store, no vendor call) and a suggested sleep, capped at
 * an hour so a caller re-checks rather than sleeping through a long window
 * in one uninterruptible call. */
async function directWait(meter: unknown): Promise<DirectResult> {
  if (typeof meter !== "string" || !meter) throw new Error("meter is required");
  const store = await HeadroomStore.open();
  try {
    const rows = store.latestPerWindow(meter).filter((item) => item.window?.kind !== "state" && item.window?.kind !== "count" && item.window?.minutes);
    const shortest = [...rows].sort((a, b) => (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER))[0];
    const resetsAt = shortest?.resets_at ?? null;
    const { resets_in_seconds } = resetsIn(resetsAt);
    store.audit("mcp", "wait", meter, "ok");
    return { source: "direct", meter, resets_at: resetsAt, resets_in_seconds, suggested_sleep_seconds: resets_in_seconds === null ? null : Math.max(0, Math.min(resets_in_seconds, 3600)) };
  } finally { store.close(); }
}

async function directResult(method: string, arguments_: Record<string, unknown>): Promise<DirectResult> {
  if (method === "status") return directStatus();
  if (method === "can") return directCan(typeof arguments_.action_class === "string" ? arguments_.action_class : "", arguments_.allow_unknown === true, typeof arguments_.owner === "string" ? arguments_.owner : undefined, typeof arguments_.expect_percent === "number" ? arguments_.expect_percent : null, arguments_.lease === true);
  if (method === "lease_start") return directLeaseStart(arguments_);
  if (method === "lease_end") return directLeaseEnd(arguments_);
  if (method === "leases") return directLeases();
  if (method === "cost") return directCost(arguments_.action_class);
  if (method === "rate") return directRate(arguments_.meter, arguments_.minutes);
  if (method === "plan") return directPlan(arguments_.meter, arguments_.reserve_percent);
  if (method === "gate") return directGate(arguments_.needs, arguments_.meter, arguments_.plan, arguments_.reserve_percent, arguments_.owner, arguments_.plan_share_percent, arguments_.action_class);
  if (method === "wait") return directWait(arguments_.meter);
  if (method === "fill") return directFill(arguments_.meter, arguments_.lane_cost_percent, arguments_.weekly_reserve_percent, arguments_.owner, arguments_.plan_share_percent);
  return directEvents(arguments_.since);
}

async function daemonCall(method: string, params: Record<string, unknown>): Promise<unknown | undefined> {
  const request = await daemonRequest(socketPath(), method, params);
  if (request.status === "available") return request.result;
  if (request.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
  return undefined;
}

export async function handleMcp(line: string, call = daemonCall, fallback = directResult): Promise<Record<string, unknown> | undefined> {
  let request: Request;
  try { request = JSON.parse(line) as Request; } catch { return failure(null, -32700, "Parse error"); }
  // A malformed envelope (null, a bare string/number, an array, or an object
  // missing method) must produce a JSON-RPC error, never throw: accessing
  // `.jsonrpc` on a non-object `request` (e.g. the JSON literal `null`)
  // would otherwise throw here, escaping serveMcp()'s uncaught `.then()`.
  if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    const id = request && typeof request === "object" && !Array.isArray(request) ? (request as Request).id : null;
    return failure(id, -32600, "Invalid Request");
  }
  if (request.method === "initialize") {
    // A new session id per initialize matches MCP's own session lifecycle;
    // a stale owner string from a prior client session must never be reused.
    mcpSessionId = randomUUID();
    const clientInfo = request.params && typeof request.params === "object" ? (request.params as Record<string, unknown>).clientInfo : undefined;
    const declaredName = clientInfo && typeof clientInfo === "object" ? (clientInfo as Record<string, unknown>).name : undefined;
    mcpClientName = typeof declaredName === "string" && declaredName.trim() ? declaredName.trim().slice(0, 80) : "mcp-client";
    return response(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "headroom", version: "0.1.0" } });
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "tools/list") return response(request.id, { tools });
  if (request.method !== "tools/call") return failure(request.id, -32601, "Method not found");
  const params = request.params ?? {};
  const name = params.name;
  const rawArguments = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const methodByTool: Record<string, string> = {
    quota_status: "status", quota_can: "can", quota_events: "events", quota_lease_start: "lease_start", quota_lease_end: "lease_end", quota_leases: "leases",
    quota_cost: "cost", quota_rate: "rate", quota_plan: "plan", quota_gate: "gate", quota_wait: "wait", quota_fill: "fill",
  };
  const method = typeof name === "string" ? methodByTool[name] : undefined;
  if (!method) return failure(request.id, -32602, "Unknown tool");
  if (method === "lease_end" && rawArguments.force === true) {
    const reason = typeof rawArguments.reason === "string" ? rawArguments.reason.trim() : "";
    if (rawArguments.confirm_force !== true || !reason) return failure(request.id, -32602, "force requires confirm_force: true and a non-empty reason string, both of which are audited");
  }
  const arguments_ = method === "lease_start" ? { ...rawArguments, owner: deriveLeaseOwner(rawArguments.owner) } : rawArguments;
  // Every tool handler is wrapped: a thrown error (invalid owner, unknown
  // action class, a daemon socket error, ...) must become a JSON-RPC error
  // response, never an uncaught rejection out of this stdio loop.
  try {
    const params_ = method === "can" ? { action_class: arguments_.action_class, allow_unknown: arguments_.allow_unknown === true, owner: arguments_.owner }
      : method === "events" ? { since: arguments_.since }
      : method === "lease_start" ? arguments_ : method === "lease_end" ? arguments_
      : method === "cost" ? { action_class: arguments_.action_class }
      : method === "rate" ? { meter: arguments_.meter, minutes: arguments_.minutes }
      : method === "plan" ? { meter: arguments_.meter, reserve_percent: arguments_.reserve_percent }
      : method === "gate" ? { meter: arguments_.meter, plan: arguments_.plan, reserve_percent: arguments_.reserve_percent, owner: arguments_.owner, plan_share_percent: arguments_.plan_share_percent, action_class: arguments_.action_class, needs: Array.isArray(arguments_.needs) ? arguments_.needs.filter((item): item is string => typeof item === "string").map((item) => parseGateNeed(item)) : [] }
      : method === "fill" ? { meter: arguments_.meter, lane_cost_percent: arguments_.lane_cost_percent, weekly_reserve_percent: arguments_.weekly_reserve_percent, owner: arguments_.owner, plan_share_percent: arguments_.plan_share_percent }
      : {};
    // quota_wait must never block: it always answers from the store directly
    // (no vendor call, no daemon round trip that could itself take a while),
    // so it deliberately skips the daemon `call` step every other tool takes.
    const result = method === "wait" ? undefined : await call(method, params_);
    const resolved = result === undefined ? await fallback(method, arguments_) : result;
    // The learned-cost/max-more/optional-lease report is the same regardless
    // of whether the decision came from the daemon (a raw CanDecision) or
    // from the direct fallback (already bundled with its own cost/leased_id):
    // a daemon-sourced decision still gets this annotation added here.
    const finalResult = method === "can" && result !== undefined ? await annotateDaemonCan(resolved as CanDecision, typeof arguments_.action_class === "string" ? arguments_.action_class : "", typeof arguments_.expect_percent === "number" ? arguments_.expect_percent : null, arguments_.lease === true, typeof arguments_.owner === "string" ? arguments_.owner : "") : resolved;
    return response(request.id, { content: [{ type: "text", text: JSON.stringify(finalResult) }], structuredContent: finalResult });
  } catch (error) {
    return failure(request.id, -32000, safeError(error));
  }
}

/** Wraps a daemon-sourced CanDecision with the same cost/lease annotation
 * directCan() already bundles for its own (no-daemon) result. */
async function annotateDaemonCan(decision: CanDecision, action: string, expectOverride: number | null, leaseFlag: boolean, owner: string): Promise<Record<string, unknown>> {
  const store = await HeadroomStore.open();
  try {
    const { cost, leasedId } = annotateCanCost(store, action, expectOverride, leaseFlag, owner, decision, new Date());
    return { ...decision, cost, leased_id: leasedId ?? null };
  } finally { store.close(); }
}
