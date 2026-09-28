import { randomUUID } from "node:crypto";
import { claudeGrantGate, syncClaudeProbeState } from "./adapters/claude.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { pollAccounts, withBackoffReasons, PROTECTED_STATUS_PATTERN } from "./collector.js";
import { readPolicy, readRouting } from "./config.js";
import { observeLocal } from "./engine/local.js";
import { canRouteWithLeases, unknownMeterPrincipals, type CanDecision } from "./policy.js";
import { withPaceInfo, withStatusInfo } from "./pace.js";
import { normalizeUnmarkedDaemonStatus } from "./status-normalization.js";
import { buildCostEstimate } from "./cost.js";
import { parseGateNeed, type GateNeed } from "./pacing.js";
import { admitCanCost, fillFor, gateFor, pickDecidingObservation, planFor, rateLines, routeFor } from "./orchestrator-reads.js";
import { readAccounts, readAccountsOrEmpty } from "./registry.js";
import { observationsFromUsagePaste, parseUsagePanel, resolveClaudePrincipal } from "./adapters/claude-usage-paste.js";
import { resetSecondsRemaining, resetsIn, withResetsIn } from "./resets.js";
import { withCreditsLapsed } from "./credits.js";
import { safeError } from "./security.js";
import { readInbox } from "./inbox.js";
import { isEnvelopable, withContract } from "./json-contract.js";
import { checkHostHealth, readHostGuardPolicy } from "./host-health.js";
import { HeadroomStore } from "./store.js";
import { disabledPrincipalForMeter, disabledPrincipalReason, isAccountEnabled, isLocalAccount, type Heartbeat, type Timer } from "./types.js";

type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };

interface JsonSchemaProperty { type?: string; items?: { type?: string; pattern?: string }; minimum?: number; maximum?: number; exclusiveMinimum?: number; enum?: string[]; }
interface ToolDefinition { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, JsonSchemaProperty>; required?: string[] }; }

const tools: ToolDefinition[] = [
  { name: "quota_status", description: "Return the latest quota windows for every Headroom meter.", inputSchema: { type: "object", properties: {} } },
  { name: "quota_can", description: "Check whether an action class can consume all of its meters. With no expect_percent, reports the learned cost and confidence for this action class; lease atomically reserves every consumed meter for the learned (or given) expectation so the next call learns too.", inputSchema: { type: "object", properties: { action_class: { type: "string" }, owner: { type: "string" }, allow_unknown: { type: "boolean" }, expect_percent: { type: "number", minimum: 0, maximum: 100 }, lease: { type: "boolean" } }, required: ["action_class", "owner"] } },
  { name: "quota_events", description: "Return Headroom events since an ISO timestamp or duration resolved by the caller.", inputSchema: { type: "object", properties: { since: { type: "string" } } } },
  { name: "quota_lease_start", description: "Reserve a meter for an orchestrator. owner defaults to this MCP session's client name and session id when omitted.", inputSchema: { type: "object", properties: { owner: { type: "string" }, meter_id: { type: "string" }, expected_percent: { type: "number", minimum: 0, maximum: 100 }, ttl_ms: { type: "number", exclusiveMinimum: 0 }, note: { type: "string" }, action_class: { type: "string" } }, required: ["meter_id"] } },
  { name: "quota_lease_end", description: "End a meter lease. A different owner must set force plus confirm_force and a reason, both of which are audited.", inputSchema: { type: "object", properties: { id: { type: "string" }, owner: { type: "string" }, force: { type: "boolean" }, confirm_force: { type: "boolean" }, reason: { type: "string" } }, required: ["id", "owner"] } },
  { name: "quota_leases", description: "List meter leases and estimated spend.", inputSchema: { type: "object", properties: {} } },
  { name: "quota_cost", description: "Learned median, interquartile range and sample count of spent percent, per action class.", inputSchema: { type: "object", properties: { action_class: { type: "string" } } } },
  { name: "quota_rate", description: "Burn in percent per hour over the last N minutes. need selects a vendor-reported window.", inputSchema: { type: "object", properties: { meter: { type: "string" }, minutes: { type: "number", exclusiveMinimum: 0 }, owner: { type: "string" }, need: { type: "string" } } } },
  { name: "quota_spend", description: "Per-owner attributed spend on shared meters: how much of each window's actual movement the spend ledger books to each lease owner, with a confidence. The owner `unattributed` is movement that happened while no lease was open. since is an ISO timestamp, defaulting to 24 hours ago.", inputSchema: { type: "object", properties: { meter: { type: "string" }, owner: { type: "string" }, since: { type: "string" } } } },
  { name: "quota_inbox", description: "Read this session's hand-off messages from <HEADROOM_HOME>/inbox/<session>/, oldest first, marking each read. Read-only: sending a message is `headroom inbox send`, never this tool.", inputSchema: { type: "object", properties: { session: { type: "string" }, since: { type: "number", minimum: 0 } }, required: ["session"] } },
  { name: "quota_plan", description: "Points available per remaining vendor-reported window before reset, including advisory banked-reset guidance. need selects that window.", inputSchema: { type: "object", properties: { meter: { type: "string" }, reserve_percent: { type: "number", minimum: 0, maximum: 100 }, need: { type: "string" }, target_points: { type: "number", minimum: 0 } }, required: ["meter"] } },
  { name: "quota_gate", description: "Pre-dispatch check for vendor-reported windows. needs accepts 5h, wk, 30d, or an exact <n>m, <n>h, or <n>d duration.", inputSchema: { type: "object", properties: { needs: { type: "array", items: { type: "string", pattern: "^(5h|wk|30d|[1-9][0-9]*[mhd]):[0-9]+(\\.[0-9]+)?$" } }, meter: { type: "string" }, plan: { type: "boolean" }, reserve_percent: { type: "number", minimum: 0, maximum: 100 }, cap_percent: { type: "number", minimum: 0, maximum: 100 }, duration_minutes: { type: "number", exclusiveMinimum: 0 }, allowance: { type: "string", enum: ["pro_rata", "fill"] }, owner: { type: "string" }, plan_share_percent: { type: "number", minimum: 0 }, action_class: { type: "string" } }, required: ["needs"] } },
  { name: "quota_wait", description: "Returns immediately (never blocks) with the meter's reset time and a suggested sleep, for a caller that polls itself.", inputSchema: { type: "object", properties: { meter: { type: "string" } }, required: ["meter"] } },
  { name: "quota_fill", description: "How many more lanes fit before a vendor-reported window resets. need selects that window.", inputSchema: { type: "object", properties: { meter: { type: "string" }, lane_cost_percent: { type: "number", exclusiveMinimum: 0 }, weekly_reserve_percent: { type: "number", minimum: 0, maximum: 100 }, duration_minutes: { type: "number", exclusiveMinimum: 0 }, allowance: { type: "string", enum: ["pro_rata", "fill"] }, owner: { type: "string" }, plan_share_percent: { type: "number", minimum: 0 }, action_class: { type: "string" }, need: { type: "string" } }, required: ["meter"] } },
  { name: "quota_usage_paste", description: "Turn the text of Claude Code's /usage panel into observations, for a meter Headroom cannot poll (a denied probe, or a model-scoped weekly bar the account-wide window hides). text is the pasted panel; principal names the Claude principal and is required when more than one is configured. Stores the readings the same way a poll does, so status, gate, can, rate and route see them immediately.", inputSchema: { type: "object", properties: { principal: { type: "string" }, text: { type: "string" } }, required: ["text"] } },
  { name: "quota_route", description: "Among the principals routing.toml's [consumes] entry for this action class allows, picks the one with the most remaining headroom on its own tightest window and returns its launch environment (e.g. CLAUDE_CONFIG_DIR for a second Claude profile). Every candidate's own state and reason is reported too, not just the winner.", inputSchema: { type: "object", properties: { action_class: { type: "string" }, owner: { type: "string" }, allow_unknown: { type: "boolean" } }, required: ["action_class", "owner"] } },
  { name: "quota_heartbeat", description: "Record or refresh this orchestrator's heartbeat lease with the daemon -- the one process that survives a crashed session -- so a lapse past 2x interval_ms is noticed and, once configured, notified. owner defaults to this MCP session's client name and session id, same as quota_lease_start. resume_sentence is what a human or a fresh session should do to pick this session's work back up; omit it on a plain re-beat to keep whatever was registered before. Pass stop: true to deregister instead of beating (interval_ms and resume_sentence are ignored then).", inputSchema: { type: "object", properties: { owner: { type: "string" }, interval_ms: { type: "number", exclusiveMinimum: 0 }, resume_sentence: { type: "string" }, stop: { type: "boolean" } } } },
];

/**
 * One validation pass over a tool's raw arguments before anything is
 * dispatched -- to the daemon or to the direct fallback -- so an argument
 * that fails the tool's own advertised schema never reaches either path
 * instead of being silently coerced or dropped there. Every declared
 * property is enforced for type, finiteness and the same numeric bounds the
 * CLI's own flag parsing uses; an argument key the tool does not declare is
 * rejected outright; `needs` (quota_gate) is rejected as a whole array the
 * moment any one member is not a valid "5h:N"/"wk:N" string, rather than
 * silently dropping just the bad member and gating on whatever remains.
 * Required-ness is deliberately NOT enforced here: that stays the
 * responsibility of each tool's own handler (direct or daemon), which can
 * report a more specific error (e.g. an auto-derived lease owner) than a
 * blanket "X is required" would.
 */
function validateToolArguments(toolName: string, rawArguments: unknown): Record<string, unknown> {
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  const properties = tool.inputSchema.properties;
  if (rawArguments === undefined) return {};
  if (typeof rawArguments !== "object" || rawArguments === null || Array.isArray(rawArguments)) throw new Error("arguments must be a plain object");
  const args = rawArguments as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!(key in properties)) throw new Error(`unknown argument: ${key}`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    if (spec.type === "string") {
      if (typeof value !== "string") throw new Error(`${key} must be a string`);
      if (spec.enum && !spec.enum.includes(value)) throw new Error(`${key} must be one of ${spec.enum.join(", ")}`);
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    } else if (spec.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
      if (spec.minimum !== undefined && value < spec.minimum) throw new Error(`${key} must be at least ${spec.minimum}`);
      if (spec.maximum !== undefined && value > spec.maximum) throw new Error(`${key} must be at most ${spec.maximum}`);
      if (spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum) throw new Error(`${key} must be greater than ${spec.exclusiveMinimum}`);
    } else if (spec.type === "array") {
      if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
      if (key === "needs") {
        for (const item of value) {
          // Keep the MCP boundary on the same parser as --need. The tool
          // schema deliberately advertises 30d and arbitrary durations;
          // duplicating a smaller regex here used to reject valid calls
          // before either the daemon or direct path could see them.
          if (typeof item !== "string") throw new Error(`needs contains an invalid entry: ${JSON.stringify(item)}`);
          try { parseGateNeed(item); }
          catch { throw new Error(`needs contains an invalid entry: ${JSON.stringify(item)} (use 5h:N, wk:N, 30d:N, or <n>m|h|d:N)`); }
        }
      } else if (spec.items?.type === "string") {
        for (const item of value) if (typeof item !== "string") throw new Error(`${key} must be an array of strings`);
      }
    }
  }
  return args;
}

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

/** The direct-MCP equivalent of daemon status: one shared served shape keeps
 * freshness, pace, last-known and reset countdowns on the same clock. */
function withStatus(store: HeadroomStore, observations: ReturnType<HeadroomStore["latestPerWindow"]>, stalenessMinutes: number, now: Date) {
  return withStatusInfo(observations, store.burnRateFor(observations, now), store.lastKnownFor(observations, now), stalenessMinutes, now);
}

/** `quota_status`'s additive `heartbeats`/`due_timers` fields (see
 * src/cli.ts's own `observe()`, which this mirrors): every registered
 * heartbeat, and every pending timer already at or past its own `at`. Both
 * `store.heartbeats()` and `store.timers()` are plain reads, so this is safe
 * to call on a read-only-opened store (the cache path) as well as a normal
 * one (the direct path). */
function heartbeatFields(store: HeadroomStore, now: Date): { heartbeats: Heartbeat[]; due_timers: Timer[] } {
  return { heartbeats: store.heartbeats(), due_timers: store.timers().filter((item) => Date.parse(item.at) <= now.getTime()) };
}

// Registry reads for the disabled-principal check use readAccountsOrEmpty():
// a missing accounts.toml (before the first `accounts discover`) is a
// normal, well-defined "no accounts configured" state, but a malformed or
// otherwise unreadable file must still fail closed -- propagated here, which
// the outer handleMcp try/catch turns into an MCP tool error -- never
// silently reported as "no disabled accounts," which could admit a parked
// principal's stored capacity as current.
async function disabledMeterReason(meter: string): Promise<string | undefined> {
  const principal = disabledPrincipalForMeter(await readAccountsOrEmpty(), meter);
  return principal ? disabledPrincipalReason(principal) : undefined;
}

async function statusObservations(store: HeadroomStore, observations: ReturnType<HeadroomStore["latestPerWindow"]>, stalenessMinutes: number, now: Date): Promise<{ observations: ReturnType<typeof withStatus>; disabled_principals: string[] }> {
  // A direct MCP read must hide old rows exactly like daemon-backed status;
  // this configuration lookup touches neither credentials nor adapters.
  const accounts = await readAccountsOrEmpty();
  const disabled_principals = accounts.filter((account) => !isAccountEnabled(account)).map((account) => account.name);
  const served = withCreditsLapsed(withStatus(store, observations.filter((item) => !disabled_principals.includes(item.principal_id)), stalenessMinutes, now), now);
  return { observations: served, disabled_principals };
}

/** Exported only for tests: the MCP client that skips the daemon and reads
 * straight from the collector must gate the Claude probe exactly like the
 * CLI's no-daemon fallback does. */
export interface DirectStatusDependencies {
  /** Test seam: production uses the wall clock and real collector. */
  now?: () => Date;
  poll?: typeof pollAccounts;
}

export async function directStatus(dependencies: DirectStatusDependencies = {}): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try {
    const policy = await readPolicy();
    const requestedAt = dependencies.now?.() ?? new Date();
    const now = requestedAt.getTime();
    // Without a daemon scheduler, a direct MCP status call has no in-process
    // rate limit of its own; share one persisted in the database instead, so
    // repeated tool calls (or several MCP client processes reading the same
    // HEADROOM_HOME) do not each poll the vendor independently. A protected
    // status backs off the same way the daemon's own scheduler does.
    const backoff = store.directPollBackoff();
    if (backoff.until > now) {
      store.audit("mcp", "status", null, "rate_limited");
      const cached = withBackoffReasons(store.latestPerWindow(), () => backoff.until, now);
      return { source: "direct", ...(await statusObservations(store, cached, policy.staleness_minutes, requestedAt)), failures: [], plan_downgraded: store.planDowngrades()[0] ?? null, ...heartbeatFields(store, requestedAt) };
    }
    if (now - backoff.lastPollAt < policy.poll_interval_minutes * 60_000) {
      return { source: "direct", ...(await statusObservations(store, store.latestPerWindow(), policy.staleness_minutes, requestedAt)), failures: [], plan_downgraded: store.planDowngrades()[0] ?? null, ...heartbeatFields(store, requestedAt) };
    }
    // Same gating as the CLI's no-daemon fallback (src/cli.ts observe()):
    // without this, an MCP client polling directly (no daemon running) would
    // spawn the Claude probe on every call regardless of a keychain_grants
    // marker, popping a fresh dialog instead of respecting it.
    await syncClaudeProbeState(store);
    const polled = await (dependencies.poll ?? pollAccounts)(undefined, { claudeGrant: claudeGrantGate(store), noDaemon: true });
    // Polling is asynchronous. Everything sent to the caller must use the
    // response clock, not the clock captured before a slow vendor call.
    const responseAt = dependencies.now?.() ?? new Date();
    const responseNow = responseAt.getTime();
    store.insertPoll(polled.observations);
    for (const [principalId, outcome] of Object.entries(polled.claudeProbeOutcomes ?? {})) store.audit("mcp", "claude_probe", principalId, outcome);
    store.audit("mcp", "status", null, polled.failures.length ? "partial" : "ok");
    const protectedFailure = polled.failures.some((failure) => PROTECTED_STATUS_PATTERN.test(failure));
    const failures = protectedFailure ? backoff.failures + 1 : 0;
    store.setDirectPollBackoff({ lastPollAt: responseNow, until: protectedFailure ? responseNow + Math.min(3_600_000, 60_000 * 2 ** backoff.failures) : 0, failures });
    return { source: "direct", ...(await statusObservations(store, store.latestPerWindow(), policy.staleness_minutes, responseAt)), failures: polled.failures, plan_downgraded: store.planDowngrades()[0] ?? null, ...heartbeatFields(store, responseAt) };
  } finally { store.close(); }
}

/**
 * The read-only cached counterpart of `directStatus`: used only when a
 * daemon socket exists but would not answer `health` even after one retry
 * (see `daemonCallReadThrough`). Never polls a vendor and never writes --
 * `HeadroomStore.openReadOnly()` could not anyway -- it only serves whatever
 * is already stored, with freshness/pace computed against the current clock
 * exactly like every other status path, so a stale row still serves stale.
 * `source: "cache"` and `daemon: "unresponsive"` mark it apart from both a
 * live daemon answer (no `source` at all) and the no-daemon `"direct"` read.
 */
async function cacheStatus(dependencies: DirectStatusDependencies = {}): Promise<DirectResult> {
  const store = await HeadroomStore.openReadOnly();
  try {
    const policy = await readPolicy();
    const now = dependencies.now?.() ?? new Date();
    return {
      source: "cache", daemon: "unresponsive",
      ...(await statusObservations(store, store.latestPerWindow(), policy.staleness_minutes, now)),
      failures: [], plan_downgraded: store.planDowngrades()[0] ?? null,
      ...heartbeatFields(store, now),
    };
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
    const disabledMeter = meters.find((meter) => disabledPrincipalForMeter(accounts, meter) !== undefined);
    if (disabledMeter) {
      const reason = disabledPrincipalReason(disabledPrincipalForMeter(accounts, disabledMeter)!);
      const decision: CanDecision = { allowed: false, meter: disabledMeter, state: "UNKNOWN", reason, meters: meters.map((meter) => ({ meter, state: "UNKNOWN", reason })) };
      return { source: "direct", decision, cost: buildCostEstimate(action, expectOverride, undefined, null), leased_id: null };
    }
    const localAccounts = accounts.filter(isLocalAccount).filter(isAccountEnabled);
    store.insertAll(await Promise.all(localAccounts.map(observeLocal)));
    const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
    const now = new Date();
    const decide = (includeOwnerReservations = false): CanDecision => directCanDecision(store, meters, localMeters, routing.local_preference, policy, allowUnknown, owner, now, includeOwnerReservations);
    const raw = decide();
    const learned = store.learnedCost(action)[0];
    const expected = buildCostEstimate(action, expectOverride, learned, null).expected_percent;
    const leaseMeters = (decision: CanDecision): string[] => localMeters.includes(decision.meter) ? [decision.meter] : meters;
    let decision = admitCanCost(store, raw, leaseMeters(raw), policy, expected, now);
    let leases: ReturnType<HeadroomStore["leases"]> = [];
    if (leaseFlag && expected !== null) {
      // The capacity decision and every resulting meter reservation share one
      // SQLite write lock. Re-read with this owner's existing reservations
      // included, so retries cannot stack leases past the actual capacity.
      const admitted = store.admitAndStartLeases(
        () => {
          const current = decide(true);
          return admitCanCost(store, current, leaseMeters(current), policy, expected, now);
        },
        owner,
        leaseMeters,
        expected,
        30 * 60_000,
        `can:${action}`,
        now,
        action,
      );
      decision = admitted.decision;
      leases = admitted.leases;
      if (leases.length) store.audit("mcp", "lease_start", `${owner}:${meters.join(",")}`, "ok");
    }
    const cost = buildCostEstimate(action, expectOverride, learned, remainingForDecision(store, decision));
    store.audit("mcp", "can", action, decision.allowed ? "yes" : "no");
    return { source: "direct", decision, cost, leased_id: leases[0]?.id ?? null };
  } finally { store.close(); }
}

/** The direct counterpart of HeadroomDaemon#canDecision. It stays synchronous
 * because it is also evaluated inside admitAndStartLeases' write lock. */
function directCanDecision(store: HeadroomStore, meters: string[], localMeters: string[], localPreference: "fallback" | "prefer" | "never", policy: Awaited<ReturnType<typeof readPolicy>>, allowUnknown: boolean, owner: string, now: Date, includeOwnerReservations = false): CanDecision {
  const blocked = meters.map((meter) => store.dispatchBlockForMeter(meter, now) ?? store.dispatchBlockForPrincipal(meter.split(":")[0])).find(Boolean);
  if (blocked) return { allowed: false, meter: meters[0], state: "FREEZE", reason: blocked, meters: [{ meter: meters[0], state: "FREEZE", reason: blocked }] };
  const allMeters = [...new Set([...meters, ...localMeters])];
  const rows = new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
  const burn = store.burnRateFor([...rows.values()].flat(), now);
  const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
  return canRouteWithLeases(meters, localMeters, enriched, localPreference, policy, allowUnknown, store.leases(undefined, true, now), owner, now, includeOwnerReservations);
}

function remainingForDecision(store: HeadroomStore, decision: CanDecision): number | null {
  const deciding = pickDecidingObservation(store.latestPerWindow(decision.meter));
  return deciding?.quantity?.unit === "percent" ? deciding.quantity.remaining ?? (deciding.quantity.limit !== null ? deciding.quantity.limit - deciding.quantity.used : null) : null;
}

/** The read-only counterpart of `directCanDecision`: `dispatchBlockForMeter`
 * and `leases()` each self-heal with a write (clearing an expired exhausted
 * report, marking an expired lease ended) that a read-only connection cannot
 * make. `dispatchBlockForMeterReadOnly`/`leasesReadOnly` return the same
 * verdict without it -- see their own doc comments in store.ts. */
function directCanDecisionReadOnly(store: HeadroomStore, meters: string[], localMeters: string[], localPreference: "fallback" | "prefer" | "never", policy: Awaited<ReturnType<typeof readPolicy>>, allowUnknown: boolean, owner: string, now: Date): CanDecision {
  const blocked = meters.map((meter) => store.dispatchBlockForMeterReadOnly(meter, now) ?? store.dispatchBlockForPrincipal(meter.split(":")[0])).find(Boolean);
  if (blocked) return { allowed: false, meter: meters[0], state: "FREEZE", reason: blocked, meters: [{ meter: meters[0], state: "FREEZE", reason: blocked }] };
  const allMeters = [...new Set([...meters, ...localMeters])];
  const rows = new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
  const burn = store.burnRateFor([...rows.values()].flat(), now);
  const enriched = new Map([...rows].map(([meter, list]) => [meter, withPaceInfo(list, burn, now)]));
  return canRouteWithLeases(meters, localMeters, enriched, localPreference, policy, allowUnknown, store.leasesReadOnly(undefined, true, now), owner, now);
}

/**
 * `quota_can` without `lease: true`, served from the store's stored rows when
 * the daemon exists but would not answer health even after one retry. Never
 * polls a local account and never admits/starts a lease -- `lease: true`
 * never reaches this function at all (see the `atomicCanLease` guard in
 * handleMcp), so a dispatch decision that can reserve capacity stays exactly
 * as fail-closed as it is today.
 */
/** Exported only for cache-fallback tests; production reaches this through
 * `quota_can` after the daemon read-through reports an unresponsive socket. */
export async function cacheCan(action: string, allowUnknown: boolean, owner: string | undefined, expectOverride: number | null): Promise<DirectResult> {
  if (!owner?.trim()) throw new Error("owner is required");
  const routing = await readRouting();
  if (!routing.present) throw new Error("No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action || "(missing)"}`);
  const [policy, accounts, store] = await Promise.all([readPolicy(), readAccounts(), HeadroomStore.openReadOnly()]);
  try {
    const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
    if (unknownMeters.length) throw new Error(`Routing action class ${action} names unknown meter(s): ${unknownMeters.join(", ")}`);
    const disabledMeter = meters.find((meter) => disabledPrincipalForMeter(accounts, meter) !== undefined);
    if (disabledMeter) {
      const reason = disabledPrincipalReason(disabledPrincipalForMeter(accounts, disabledMeter)!);
      const decision: CanDecision = { allowed: false, meter: disabledMeter, state: "UNKNOWN", reason, meters: meters.map((meter) => ({ meter, state: "UNKNOWN", reason })) };
      return { source: "cache", daemon: "unresponsive", decision, cost: buildCostEstimate(action, expectOverride, undefined, null), leased_id: null };
    }
    const localMeters = accounts.filter(isLocalAccount).filter(isAccountEnabled).map((account) => `${account.name}:capacity`);
    const now = new Date();
    const decision = directCanDecisionReadOnly(store, meters, localMeters, routing.local_preference, policy, allowUnknown, owner, now);
    const learned = store.learnedCost(action)[0];
    const cost = buildCostEstimate(action, expectOverride, learned, remainingForDecision(store, decision));
    return { source: "cache", daemon: "unresponsive", decision, cost, leased_id: null };
  } finally { store.close(); }
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

async function cacheEvents(since: unknown): Promise<DirectResult> {
  const value = typeof since === "string" ? since : new Date(Date.now() - 86_400_000).toISOString();
  const store = await HeadroomStore.openReadOnly();
  try { return { source: "cache", daemon: "unresponsive", events: store.events(value) }; }
  finally { store.close(); }
}

async function directLeaseStart(arguments_: Record<string, unknown>): Promise<DirectResult> {
  const meterId = String(arguments_.meter_id ?? "");
  const disabled = meterId ? await disabledMeterReason(meterId) : undefined;
  // A write, not a read with its own "UNKNOWN" convention: refuse it the
  // same way the daemon's own lease_start RPC rejection already does (a
  // thrown error, which handleMcp's own catch turns into a standard MCP
  // tool error), never a one-off { allowed: false } object only this path
  // would ever produce.
  if (disabled) throw new Error(disabled);
  const store = await HeadroomStore.open();
  try {
    const owner = String(arguments_.owner ?? "");
    const actionClass = typeof arguments_.action_class === "string" && arguments_.action_class.trim() ? arguments_.action_class.trim() : null;
    const lease = store.startLease(owner, meterId, typeof arguments_.expected_percent === "number" ? arguments_.expected_percent : null, typeof arguments_.ttl_ms === "number" ? arguments_.ttl_ms : 30 * 60_000, typeof arguments_.note === "string" ? arguments_.note : null, new Date(), actionClass);
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

/**
 * `quota_heartbeat`: the MCP twin of `headroom heartbeat`. `stop: true`
 * deregisters instead of beating; interval_ms and resume_sentence are then
 * ignored, matching the CLI's own `--stop` (which also takes no `--every`).
 */
async function directHeartbeat(arguments_: Record<string, unknown>): Promise<DirectResult> {
  const owner = String(arguments_.owner ?? "");
  if (!owner.trim()) throw new Error("owner is required");
  const store = await HeadroomStore.open();
  try {
    if (arguments_.stop === true) {
      const stopped = store.heartbeatStop(owner);
      store.audit("mcp", "heartbeat_stop", owner, "ok");
      return { source: "direct", stopped };
    }
    const intervalMs = typeof arguments_.interval_ms === "number" ? arguments_.interval_ms : Number.NaN;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("interval_ms must be positive");
    const resumeSentence = arguments_.resume_sentence === null ? null : typeof arguments_.resume_sentence === "string" ? arguments_.resume_sentence : undefined;
    const heartbeat = store.heartbeatBeat(owner, intervalMs, resumeSentence, new Date());
    store.audit("mcp", "heartbeat_beat", owner, "ok");
    return { source: "direct", heartbeat };
  } finally { store.close(); }
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

async function directRate(meter: unknown, minutes: unknown, owner: unknown, need: unknown): Promise<DirectResult> {
  const disabled = typeof meter === "string" ? await disabledMeterReason(meter) : undefined;
  if (disabled) return { source: "direct", lines: [{ meter, window_minutes: null, used_percent: null, burn_percent_per_hour: null, empty_in_seconds: null, resets_at: null, reason: disabled }] };
  const store = await HeadroomStore.open();
  try {
    const lines = rateLines(store, typeof meter === "string" ? meter : undefined, typeof minutes === "number" && minutes > 0 ? minutes : 30, new Date(), typeof owner === "string" && owner.trim() ? owner.trim() : undefined, typeof need === "string" ? need : undefined);
    store.audit("mcp", "rate", typeof meter === "string" ? meter : null, "ok");
    return { source: "direct", lines };
  } finally { store.close(); }
}

/** Exported only for cache-fallback tests; production reaches this through
 * `quota_rate` after the daemon read-through reports an unresponsive socket. */
export async function cacheRate(meter: unknown, minutes: unknown, owner: unknown, need: unknown): Promise<DirectResult> {
  const disabled = typeof meter === "string" ? await disabledMeterReason(meter) : undefined;
  if (disabled) return { source: "cache", daemon: "unresponsive", lines: [{ meter, window_minutes: null, used_percent: null, burn_percent_per_hour: null, empty_in_seconds: null, resets_at: null, reason: disabled }] };
  const store = await HeadroomStore.openReadOnly();
  try {
    const lines = rateLines(store, typeof meter === "string" ? meter : undefined, typeof minutes === "number" && minutes > 0 ? minutes : 30, new Date(), typeof owner === "string" && owner.trim() ? owner.trim() : undefined, typeof need === "string" ? need : undefined);
    return { source: "cache", daemon: "unresponsive", lines };
  } finally { store.close(); }
}

/** `quota_spend`: the MCP twin of `headroom spend`. */
async function directSpend(meter: unknown, owner: unknown, since: unknown): Promise<DirectResult> {
  const sinceValue = typeof since === "string" && since.trim() ? since.trim() : new Date(Date.now() - 86_400_000).toISOString();
  const store = await HeadroomStore.open();
  try {
    const rows = store.spendByOwner({
      meter: typeof meter === "string" && meter.trim() ? meter.trim() : undefined,
      owner: typeof owner === "string" && owner.trim() ? owner.trim() : undefined,
      since: sinceValue,
    });
    store.audit("mcp", "spend", typeof meter === "string" ? meter : typeof owner === "string" ? owner : null, "ok");
    return { source: "direct", since: sinceValue, rows };
  } finally { store.close(); }
}

/**
 * `quota_inbox`: reads one session's hand-off messages. Deliberately
 * read-only -- an agent may consume what another orchestrator left for it,
 * but writing into someone else's inbox stays an explicit `headroom inbox
 * send`, so a tool call can never fabricate a hand-off from a session that
 * did not make one.
 */
async function directInbox(session: unknown, since: unknown): Promise<DirectResult> {
  if (typeof session !== "string" || !session.trim()) throw new Error("session is required");
  const result = await readInbox({ session: session.trim(), since: typeof since === "number" ? since : undefined });
  return { source: "direct", ...result };
}

async function directPlan(meter: unknown, reservePercent: unknown, need: unknown, targetPoints: unknown): Promise<DirectResult> {
  if (typeof meter !== "string" || !meter) throw new Error("meter is required");
  const disabled = await disabledMeterReason(meter);
  // Same documented { meter, error, notices } failure shape `plan` always
  // returns (docs/json-contract.md) -- no `unknown` field (plan's contract
  // has none), matching the daemon's identical disabled-plan branch.
  if (disabled) return { source: "direct", meter, error: disabled, notices: [] };
  const policy = await readPolicy();
  const reserve = typeof reservePercent === "number" ? reservePercent : policy.freeze_reserve_pct;
  const store = await HeadroomStore.open();
  try { const result = planFor(store, meter, reserve, new Date(), policy.staleness_minutes, policy.reserve, typeof need === "string" ? need : undefined, typeof targetPoints === "number" ? targetPoints : undefined, policy.reserve_meta, policy.policy_mtime); store.audit("mcp", "plan", meter, "ok"); return { source: "direct", ...result }; } finally { store.close(); }
}

/**
 * `quota_usage_paste`: the CLI's `headroom usage --paste` over MCP, so an
 * agent handed the text of a `/usage` panel can turn it into readings without
 * shelling out. Direct only, like the other tools with no daemon RPC case:
 * this is a rare, human-triggered write, not a hot path.
 */
async function directUsagePaste(principal: unknown, text: unknown): Promise<DirectResult> {
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required: paste the /usage panel");
  const resolved = resolveClaudePrincipal(await readAccounts(), typeof principal === "string" && principal.trim() ? principal.trim() : undefined);
  const disabled = await disabledMeterReason(`${resolved}:all`);
  // A write, not a read with its own "UNKNOWN" convention: refuse it as an
  // ordinary thrown error (handleMcp's own catch turns it into a standard
  // MCP tool error), matching the CLI's usage --paste refusal, never a
  // one-off { allowed: false } object only this path would ever produce.
  if (disabled) throw new Error(disabled);
  const now = new Date();
  const panel = parseUsagePanel(text, now);
  if (!panel.windows.length) throw new Error('no usage window in the pasted text; expected a line like "Current session" or "Current week (all models)" with a percent');
  const store = await HeadroomStore.open();
  try {
    const stored = store.insertAll(observationsFromUsagePaste(panel.windows, resolved, now));
    store.audit("mcp", "usage_paste", resolved, "ok");
    return { source: "direct", principal: resolved, observations: withResetsIn(stored, now), unparsed: panel.unparsed };
  } finally { store.close(); }
}

async function directRoute(actionClass: unknown, owner: unknown, allowUnknown: unknown): Promise<DirectResult> {
  if (typeof actionClass !== "string" || !actionClass) throw new Error("action_class is required");
  if (typeof owner !== "string" || !owner.trim()) throw new Error("owner is required");
  const routing = await readRouting();
  if (!routing.present) throw new Error("No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
  const meters = routing.consumes[actionClass];
  if (!meters) throw new Error(`Unknown action class: ${actionClass}`);
  const [policy, accounts, store] = await Promise.all([readPolicy(), readAccounts(), HeadroomStore.open()]);
  try {
    const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
    if (unknownMeters.length) throw new Error(`Routing action class ${actionClass} names unknown meter(s): ${unknownMeters.join(", ")}`);
    const result = routeFor(store, meters, accounts, policy, allowUnknown === true, new Date(), owner);
    store.audit("mcp", "route", actionClass, result.principal ? "yes" : "no");
    return { source: "direct", ...result };
  } finally { store.close(); }
}

async function directGate(rawNeeds: unknown, meter: unknown, usePlan: unknown, reservePercent: unknown, owner: unknown, planSharePercent: unknown, actionClass: unknown, allowance: unknown, capPercent: unknown, durationMinutes: unknown): Promise<DirectResult> {
  const needs: GateNeed[] = Array.isArray(rawNeeds) ? rawNeeds.filter((item): item is string => typeof item === "string").map((item) => parseGateNeed(item)) : [];
  if (!needs.length) throw new Error("needs is required (e.g. [\"5h:15\"])");
  const disabled = typeof meter === "string" ? await disabledMeterReason(meter) : undefined;
  // meters_checked names the meter actually examined, matching gateFor's own
  // convention (and the daemon's identical disabled-gate branch) -- never a
  // hard-coded empty array.
  if (disabled) return { source: "direct", allowed: false, unknown: true, reason: disabled, meters_checked: typeof meter === "string" ? [meter] : [], notices: [] };
  const policy = await readPolicy();
  const reserve = Math.max(policy.freeze_reserve_pct, typeof reservePercent === "number" ? reservePercent : policy.freeze_reserve_pct);
  const routing = typeof actionClass === "string" ? await readRouting() : undefined;
  const store = await HeadroomStore.open();
  try {
    const result = gateFor(store, needs, typeof meter === "string" ? meter : undefined, reserve, usePlan === true, new Date(), {
      owner: typeof owner === "string" ? owner : undefined,
      planSharePercent: typeof planSharePercent === "number" ? planSharePercent : undefined,
      actionClass: typeof actionClass === "string" ? actionClass : undefined,
      pacing: policy.pacing,
      allowance: allowance === "pro_rata" || allowance === "fill" ? allowance : policy.allowance,
      capPercent: typeof capPercent === "number" ? capPercent : undefined,
      durationMinutes: typeof durationMinutes === "number" ? durationMinutes : routing?.costs[typeof actionClass === "string" ? actionClass : ""]?.duration_minutes,
      staleness_minutes: policy.staleness_minutes,
      reserves: policy.reserve, reserveMeta: policy.reserve_meta, policyMtime: policy.policy_mtime,
    });
    store.audit("mcp", "gate", typeof meter === "string" ? meter : null, result.allowed ? "yes" : "no");
    return { source: "direct", ...result };
  } finally { store.close(); }
}

async function directFill(meter: unknown, laneCostPercent: unknown, weeklyReservePercent: unknown, owner: unknown, planSharePercent: unknown, need: unknown, actionClass: unknown, allowance: unknown, durationMinutes: unknown): Promise<DirectResult> {
  if (typeof meter !== "string" || !meter) throw new Error("meter is required");
  const disabled = await disabledMeterReason(meter);
  if (disabled) return { source: "direct", meter, error: disabled, notices: [] };
  const policy = await readPolicy();
  const weeklyReserve = typeof weeklyReservePercent === "number" ? weeklyReservePercent : policy.freeze_reserve_pct;
  const laneCost = typeof laneCostPercent === "number" ? laneCostPercent : undefined;
  const routing = typeof actionClass === "string" ? await readRouting() : undefined;
  const store = await HeadroomStore.open();
  try {
    const result = await fillFor(store, meter, laneCost, weeklyReserve, new Date(), { owner: typeof owner === "string" ? owner : undefined, planSharePercent: typeof planSharePercent === "number" ? planSharePercent : undefined, actionClass: typeof actionClass === "string" ? actionClass : undefined, durationMinutes: typeof durationMinutes === "number" ? durationMinutes : routing?.costs[typeof actionClass === "string" ? actionClass : ""]?.duration_minutes, pacing: policy.pacing, allowance: allowance === "pro_rata" || allowance === "fill" ? allowance : policy.allowance, staleness_minutes: policy.staleness_minutes, reserves: policy.reserve, reserveMeta: policy.reserve_meta, policyMtime: policy.policy_mtime, needWindow: typeof need === "string" ? need : undefined });
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
  const disabled = await disabledMeterReason(meter);
  if (disabled) return { source: "direct", meter, resets_at: null, resets_in_seconds: null, suggested_sleep_seconds: null, reason: disabled, unknown: true };
  const store = await HeadroomStore.open();
  try {
    const rows = store.latestPerWindow(meter).filter((item) => item.window?.kind !== "state" && item.window?.kind !== "count" && item.window?.minutes);
    const shortest = [...rows].sort((a, b) => (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER))[0];
    const resetsAt = shortest?.resets_at ?? null;
    const resets_in_seconds = resetSecondsRemaining(resetsAt);
    store.audit("mcp", "wait", meter, "ok");
    return { source: "direct", meter, resets_at: resetsAt, resets_in_seconds, suggested_sleep_seconds: resets_in_seconds === null ? null : Math.max(0, Math.min(resets_in_seconds, 3600)) };
  } finally { store.close(); }
}

async function directResult(method: string, arguments_: Record<string, unknown>): Promise<DirectResult> {
  if (method === "status") return directStatus();
  if (method === "can") return directCan(typeof arguments_.action_class === "string" ? arguments_.action_class : "", arguments_.allow_unknown === true, typeof arguments_.owner === "string" ? arguments_.owner : undefined, typeof arguments_.expect_percent === "number" ? arguments_.expect_percent : null, arguments_.lease === true);
  if (method === "lease_start") return directLeaseStart(arguments_);
  if (method === "heartbeat") return directHeartbeat(arguments_);
  if (method === "lease_end") return directLeaseEnd(arguments_);
  if (method === "leases") return directLeases();
  if (method === "cost") return directCost(arguments_.action_class);
  if (method === "rate") return directRate(arguments_.meter, arguments_.minutes, arguments_.owner, arguments_.need);
  if (method === "spend") return directSpend(arguments_.meter, arguments_.owner, arguments_.since);
  if (method === "inbox") return directInbox(arguments_.session, arguments_.since);
  if (method === "plan") return directPlan(arguments_.meter, arguments_.reserve_percent, arguments_.need, arguments_.target_points);
  if (method === "gate") return directGate(arguments_.needs, arguments_.meter, arguments_.plan, arguments_.reserve_percent, arguments_.owner, arguments_.plan_share_percent, arguments_.action_class, arguments_.allowance, arguments_.cap_percent, arguments_.duration_minutes);
  if (method === "wait") return directWait(arguments_.meter);
  if (method === "fill") return directFill(arguments_.meter, arguments_.lane_cost_percent, arguments_.weekly_reserve_percent, arguments_.owner, arguments_.plan_share_percent, arguments_.need, arguments_.action_class, arguments_.allowance, arguments_.duration_minutes);
  if (method === "route") return directRoute(arguments_.action_class, arguments_.owner, arguments_.allow_unknown);
  if (method === "usage_paste") return directUsagePaste(arguments_.principal, arguments_.text);
  return directEvents(arguments_.since);
}

/**
 * The read-only cached counterpart of `directResult`, dispatched only for
 * the tool methods `daemonCallReadThrough` found a daemon unresponsive on
 * (see its own doc comment): `status`, `events`, `rate`, and `can` without a
 * lease. Every other method never reaches here -- `handleMcp` only takes
 * this branch when `servedFromCache` is set, which only that eligibility
 * check ever sets.
 */
async function cacheResult(method: string, arguments_: Record<string, unknown>): Promise<DirectResult> {
  if (method === "status") return cacheStatus();
  if (method === "can") return cacheCan(typeof arguments_.action_class === "string" ? arguments_.action_class : "", arguments_.allow_unknown === true, typeof arguments_.owner === "string" ? arguments_.owner : undefined, typeof arguments_.expect_percent === "number" ? arguments_.expect_percent : null);
  if (method === "rate") return cacheRate(arguments_.meter, arguments_.minutes, arguments_.owner, arguments_.need);
  return cacheEvents(arguments_.since);
}

async function daemonCall(method: string, params: Record<string, unknown>): Promise<unknown | undefined> {
  const request = await daemonRequest(socketPath(), method, params);
  if (request.status === "available") return request.result;
  if (request.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
  return undefined;
}

/**
 * The read-only counterpart of `daemonCall`, used only for the tool methods
 * eligible for a cached fallback: `status`, `events`, `rate`, and `can`
 * without a lease (see handleMcp's own `cacheEligible` check -- `lease: true`
 * never reaches this function). Retries the health check once before
 * reporting the daemon unresponsive, exactly like the CLI's
 * `requestDaemonReadThrough` (src/cli.ts) -- a poll's own synchronous write
 * (store.ts's `insertPoll`) can occasionally still run past a single 2s
 * budget under host load, and a second attempt often lands once it has
 * finished.
 */
async function daemonCallReadThrough(method: string, params: Record<string, unknown>): Promise<{ kind: "available"; result: unknown } | { kind: "absent" } | { kind: "cache" }> {
  const request = await daemonRequest(socketPath(), method, params, 2_000, 30_000, undefined, 2);
  if (request.status === "available") return { kind: "available", result: request.result };
  if (request.status === "unresponsive") return { kind: "cache" };
  return { kind: "absent" };
}

/**
 * Daemon RPC predates MCP structuredContent and returns bare arrays for a
 * few read methods. MCP requires structuredContent to be a JSON object, and
 * the direct fallback has always exposed named object wrappers. Normalize at
 * the protocol boundary so daemon presence cannot change a tool's shape.
 */
function normalizeDaemonResult(method: string, result: unknown, arguments_: Record<string, unknown>): unknown {
  if (!Array.isArray(result)) return result;
  if (method === "events") return { source: "daemon", events: result };
  if (method === "leases") return { source: "daemon", leases: result };
  if (method === "cost") return { source: "daemon", items: result };
  if (method === "rate") return { source: "daemon", lines: result };
  if (method === "spend") {
    const since = typeof arguments_.since === "string" && arguments_.since.trim()
      ? arguments_.since.trim()
      : new Date(Date.now() - 86_400_000).toISOString();
    return { source: "daemon", since, rows: result };
  }
  return result;
}

/** This stdio server implements the current compatibility generation while
 * retaining the two earlier releases clients still negotiate. */
function negotiatedProtocolVersion(params: unknown): string {
  const requested = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>).protocolVersion : undefined;
  return requested === "2025-06-18" || requested === "2025-03-26" || requested === "2024-11-05" || requested === "2024-10-07"
    ? requested
    : "2025-06-18";
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
    return response(request.id, { protocolVersion: negotiatedProtocolVersion(request.params), capabilities: { tools: {} }, serverInfo: { name: "headroom", version: "0.1.0" } });
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "ping") return response(request.id, {});
  if (request.method === "tools/list") return response(request.id, { tools });
  if (request.method !== "tools/call") return failure(request.id, -32601, "Method not found");
  const params = request.params ?? {};
  const name = params.name;
  const methodByTool: Record<string, string> = {
    quota_status: "status", quota_can: "can", quota_events: "events", quota_lease_start: "lease_start", quota_lease_end: "lease_end", quota_leases: "leases",
    quota_cost: "cost", quota_rate: "rate", quota_plan: "plan", quota_gate: "gate", quota_wait: "wait", quota_fill: "fill", quota_route: "route",
    quota_usage_paste: "usage_paste", quota_spend: "spend", quota_inbox: "inbox", quota_heartbeat: "heartbeat",
  };
  const method = typeof name === "string" ? methodByTool[name] : undefined;
  if (!method) return failure(request.id, -32602, "Unknown tool");
  // Validated once, here, before any dispatch to the daemon or the direct
  // fallback: neither path should ever see an argument that fails the
  // tool's own advertised schema.
  let rawArguments: Record<string, unknown>;
  try { rawArguments = validateToolArguments(name as string, params.arguments); }
  catch (error) { return failure(request.id, -32602, error instanceof Error ? error.message : "Invalid params"); }
  if (method === "lease_end" && rawArguments.force === true) {
    const reason = typeof rawArguments.reason === "string" ? rawArguments.reason.trim() : "";
    if (rawArguments.confirm_force !== true || !reason) return failure(request.id, -32602, "force requires confirm_force: true and a non-empty reason string, both of which are audited");
  }
  const arguments_ = method === "lease_start" || method === "heartbeat" ? { ...rawArguments, owner: deriveLeaseOwner(rawArguments.owner) } : rawArguments;
  // Every tool handler is wrapped: a thrown error (invalid owner, unknown
  // action class, a daemon socket error, ...) must become a JSON-RPC error
  // response, never an uncaught rejection out of this stdio loop.
  try {
    // `can_lease` needs the learned/overridden expected cost before it can
    // enter the daemon's atomic admission transaction. Reading that model is
    // local bookkeeping; the daemon remains the sole owner of the decision
    // plus lease write when it is available.
    const atomicCanLease = method === "can" && arguments_.lease === true;
    const requestedCost = atomicCanLease ? await expectedCanCost(typeof arguments_.action_class === "string" ? arguments_.action_class : "", typeof arguments_.expect_percent === "number" ? arguments_.expect_percent : null) : undefined;
    const params_ = method === "can" ? { action_class: arguments_.action_class, allow_unknown: arguments_.allow_unknown === true, owner: arguments_.owner }
      : method === "events" ? { since: arguments_.since }
      : method === "lease_start" ? arguments_ : method === "lease_end" ? arguments_
      : method === "cost" ? { action_class: arguments_.action_class }
      : method === "rate" ? { meter: arguments_.meter, minutes: arguments_.minutes, owner: arguments_.owner, need: arguments_.need }
      : method === "spend" ? { meter: arguments_.meter, owner: arguments_.owner, since: arguments_.since }
      : method === "plan" ? { meter: arguments_.meter, reserve_percent: arguments_.reserve_percent, need: arguments_.need, target_points: arguments_.target_points }
      : method === "gate" ? { meter: arguments_.meter, plan: arguments_.plan, reserve_percent: arguments_.reserve_percent, cap_percent: arguments_.cap_percent, duration_minutes: arguments_.duration_minutes, allowance: arguments_.allowance, owner: arguments_.owner, plan_share_percent: arguments_.plan_share_percent, action_class: arguments_.action_class, needs: Array.isArray(arguments_.needs) ? arguments_.needs.filter((item): item is string => typeof item === "string").map((item) => parseGateNeed(item)) : [] }
      : method === "fill" ? { meter: arguments_.meter, lane_cost_percent: arguments_.lane_cost_percent, weekly_reserve_percent: arguments_.weekly_reserve_percent, duration_minutes: arguments_.duration_minutes, allowance: arguments_.allowance, owner: arguments_.owner, plan_share_percent: arguments_.plan_share_percent, action_class: arguments_.action_class, need: arguments_.need }
      : method === "route" ? { action_class: arguments_.action_class, owner: arguments_.owner, allow_unknown: arguments_.allow_unknown === true }
      : method === "usage_paste" ? { principal: arguments_.principal, text: arguments_.text }
      : method === "heartbeat" ? (arguments_.stop === true ? { owner: arguments_.owner } : { owner: arguments_.owner, interval_ms: arguments_.interval_ms, resume_sentence: arguments_.resume_sentence })
      : {};
    const daemonMethod = method === "heartbeat" ? (arguments_.stop === true ? "heartbeat_stop" : "heartbeat_beat")
      : atomicCanLease && requestedCost?.expected_percent !== null
      ? "can_lease"
      : method;
    if (daemonMethod === "can_lease") Object.assign(params_, { expected_percent: requestedCost!.expected_percent });
    // quota_wait must never block, and quota_route is a direct read only
    // (see routeFor's own doc comment: an infrequent, deliberate call, not a
    // hot path worth a daemon RPC case) -- both skip the daemon `call` step
    // every other tool takes.
    const noDaemonStep = method === "wait" || method === "route" || method === "usage_paste" || method === "inbox";
    // Only a plain read can still answer usefully from stored rows when the
    // daemon exists but would not answer health even after one retry: never
    // a write, and never `can` with `lease: true` (a dispatch decision that
    // could reserve capacity stays exactly as fail-closed as it is today).
    // `call` is swapped out in tests, so this only ever engages against the
    // real daemon transport, not a test double standing in for it.
    const cacheEligible = !noDaemonStep && call === daemonCall
      && (method === "status" || method === "events" || method === "rate" || (method === "can" && !atomicCanLease));
    let result: unknown;
    let servedFromCache = false;
    if (noDaemonStep) result = undefined;
    else if (cacheEligible) {
      const outcome = await daemonCallReadThrough(daemonMethod, params_);
      if (outcome.kind === "available") result = outcome.result;
      else if (outcome.kind === "cache") servedFromCache = true;
    } else {
      result = await call(daemonMethod, params_);
    }
    // A rejected daemon RPC (e.g. a disabled-principal fail-closed refusal
    // from plan/gate/fill/rate/lease_start/can) comes back as a JSON-RPC
    // error envelope, not `undefined` -- daemonRequest()/rpc() only treat a
    // dropped connection as "unresponsive", never a domain-level `error`
    // reply, as "not available". Without this check that envelope would be
    // treated as ordinary tool data and wrapped inside a successful
    // tools/call reply (see src/cli.ts's own unwrapRpc for the equivalent
    // direct-CLI guard). Throwing here instead routes it through the same
    // catch below that already turns every other failure into a proper MCP
    // tool error.
    if (result && typeof result === "object" && "jsonrpc" in result && "error" in result) {
      const rpcErrorReply = (result as { error?: { message?: unknown } }).error;
      throw new Error(typeof rpcErrorReply?.message === "string" ? rpcErrorReply.message : "Daemon request failed");
    }
    const resolved = servedFromCache ? await cacheResult(method, arguments_) : result === undefined ? await fallback(method, arguments_) : result;
    // The learned-cost/max-more/optional-lease report is the same regardless
    // of whether the decision came from the daemon (a raw CanDecision) or
    // from the direct fallback (already bundled with its own cost/leased_id):
    // a daemon-sourced decision still gets this annotation added here.
    let finalResult = method === "can" && result !== undefined ? await annotateDaemonCan(resolved, typeof arguments_.action_class === "string" ? arguments_.action_class : "", typeof arguments_.expect_percent === "number" ? arguments_.expect_percent : null, requestedCost)
      // A daemon-sourced heartbeat reply is the bare Heartbeat/{stopped}
      // object the "heartbeat_beat"/"heartbeat_stop" RPC returns; the direct
      // fallback (directHeartbeat, above) already returns the named,
      // source-tagged shape below, so only the daemon path needs wrapping
      // here.
      : method === "heartbeat" && result !== undefined ? { source: "daemon", ...(daemonMethod === "heartbeat_stop" ? { stopped: (resolved as { stopped: boolean }).stopped } : { heartbeat: resolved }) }
      : normalizeDaemonResult(method, resolved, arguments_);
    if (method === "status" && Array.isArray(finalResult)) {
      const policy = await readPolicy();
      const observations = await normalizeUnmarkedDaemonStatus(finalResult, policy.staleness_minutes);
      const downgrade = await call("plan_downgrades", {});
      // Same additive fields as the direct/cache paths (heartbeatFields,
      // above), read here from the daemon instead of a local store. An older
      // daemon that does not yet answer these two methods reads as "none",
      // never a crash -- same defensive Array.isArray guard as src/cli.ts's
      // own observe().
      const heartbeatsReply = await call("heartbeats", {});
      const heartbeats = Array.isArray(heartbeatsReply) ? heartbeatsReply as Heartbeat[] : [];
      const timersReply = await call("timer_list", {});
      const pendingTimers = Array.isArray(timersReply) ? timersReply as Timer[] : [];
      const dueTimers = pendingTimers.filter((item) => Date.parse(item.at) <= Date.now());
      // disabled_principals is derived here, from the registry, never
      // returned by the daemon's own "status" RPC -- that stays the bare
      // Observation[] array the 1.x contract requires (docs/json-contract.md).
      // A missing accounts.toml reads as "no accounts"; a malformed or
      // otherwise unreadable one fails closed (propagates, caught below as
      // an MCP tool error) rather than silently reporting "no disabled
      // accounts."
      const accounts = await readAccountsOrEmpty();
      const disabled_principals = accounts.filter((account) => !isAccountEnabled(account)).map((account) => account.name);
      const filteredObservations = observations.filter((item) => !disabled_principals.includes(item.principal_id));
      finalResult = { observations: filteredObservations, plan_downgraded: Array.isArray(downgrade) ? downgrade[0] ?? null : null, disabled_principals, heartbeats, due_timers: dueTimers };
    }
    // `can` and `gate` additionally carry the same host-pressure reading
    // `headroom can`/`gate --json` and `doctor` report (src/host-health.ts):
    // an orchestrator sharing this machine sees local pressure alongside the
    // quota decision, whether that decision itself came from the daemon or a
    // direct read. Purely additive and never a refusal here -- only `headroom
    // run`, which launches locally, refuses on host pressure.
    if ((method === "can" || method === "gate") && isEnvelopable(finalResult)) {
      const hostGuardPolicy = await readHostGuardPolicy();
      finalResult = { ...finalResult, host: await checkHostHealth(hostGuardPolicy) };
    }
    // The contract envelope fits object results. Array-shaped daemon reads
    // have already been normalized above, since MCP structuredContent itself
    // must always be an object.
    const envelopedResult = isEnvelopable(finalResult) ? withContract(finalResult) : finalResult;
    return response(request.id, { content: [{ type: "text", text: JSON.stringify(envelopedResult) }], structuredContent: envelopedResult });
  } catch (error) {
    return failure(request.id, -32000, safeError(error));
  }
}

/** Reads the cost model once before dispatching a daemon `can_lease` call. */
async function expectedCanCost(action: string, expectOverride: number | null): Promise<ReturnType<typeof buildCostEstimate>> {
  const store = await HeadroomStore.open();
  try {
    return buildCostEstimate(action, expectOverride, store.learnedCost(action)[0], null);
  } finally { store.close(); }
}

/** Wrap daemon `can` and `can_lease` replies in the MCP result shape without
 * ever starting a second lease outside the daemon's transaction. */
async function annotateDaemonCan(raw: unknown, action: string, expectOverride: number | null, requestedCost: ReturnType<typeof buildCostEstimate> | undefined): Promise<Record<string, unknown>> {
  const atomicAdmission = !!raw && typeof raw === "object" && !Array.isArray(raw) && "decision" in raw;
  const admitted = atomicAdmission
    ? raw as { decision: CanDecision; leases?: ReturnType<HeadroomStore["leases"]> }
    : { decision: raw as CanDecision, leases: [] as ReturnType<HeadroomStore["leases"]> };
  const store = await HeadroomStore.open();
  try {
    const cost = buildCostEstimate(action, expectOverride, store.learnedCost(action)[0], remainingForDecision(store, admitted.decision));
    const leases = admitted.leases ?? [];
    // requestedCost is deliberately kept in the call signature: its expected
    // value is what the daemon admitted atomically, while the returned cost
    // below recomputes max_more from the final deciding meter for parity with
    // the direct fallback.
    if (requestedCost?.expected_percent !== undefined && cost.expected_percent !== requestedCost.expected_percent) cost.expected_percent = requestedCost.expected_percent;
    return { ...admitted.decision, cost, leased_id: leases[0]?.id ?? null };
  } finally { store.close(); }
}
