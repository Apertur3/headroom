import { daemonRequest, socketPath } from "./daemon.js";
import { pollAccounts } from "./collector.js";
import { readPolicy, readRouting } from "./config.js";
import { observeLocal } from "./engine/local.js";
import { canRouteWithLeases } from "./policy.js";
import { readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount } from "./types.js";

type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
const tools = [
  { name: "quota_status", description: "Return the latest quota windows for every Headroom meter.", inputSchema: { type: "object", properties: {} } },
  { name: "quota_can", description: "Check whether an action class can consume all of its meters.", inputSchema: { type: "object", properties: { action_class: { type: "string" }, owner: { type: "string" }, allow_unknown: { type: "boolean" } }, required: ["action_class", "owner"] } },
  { name: "quota_events", description: "Return Headroom events since an ISO timestamp or duration resolved by the caller.", inputSchema: { type: "object", properties: { since: { type: "string" } } } },
  { name: "quota_lease_start", description: "Reserve a meter for an orchestrator.", inputSchema: { type: "object", properties: { owner: { type: "string" }, meter_id: { type: "string" }, expected_percent: { type: "number" }, ttl_ms: { type: "number" }, note: { type: "string" } }, required: ["owner", "meter_id"] } },
  { name: "quota_lease_end", description: "End a meter lease. A different owner must set force.", inputSchema: { type: "object", properties: { id: { type: "string" }, owner: { type: "string" }, force: { type: "boolean" } }, required: ["id", "owner"] } },
  { name: "quota_leases", description: "List meter leases and estimated spend.", inputSchema: { type: "object", properties: {} } },
];

function response(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result }; }
function failure(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

/** Minimal MCP stdio transport; deliberately dependency-free for offline installs. */
export function serveMcp(): void {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (part: string) => {
    buffer += part;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      void handleMcp(line).then((result) => { if (result) process.stdout.write(`${JSON.stringify(result)}\n`); });
    }
  });
}

type DirectResult = Record<string, unknown>;

async function directStatus(): Promise<DirectResult> {
  const polled = await pollAccounts();
  const store = await HeadroomStore.open();
  try {
    store.insertAll(polled.observations);
    store.audit("mcp", "status", null, polled.failures.length ? "partial" : "ok");
    return { source: "direct", observations: store.latestPerWindow(), failures: polled.failures };
  } finally { store.close(); }
}

async function directCan(action: string, allowUnknown: boolean, owner?: string): Promise<DirectResult> {
  if (!owner?.trim()) throw new Error("owner is required");
  const routing = await readRouting();
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action || "(missing)"}`);
  const [policy, accounts, store] = await Promise.all([readPolicy(), readAccounts(), HeadroomStore.open()]);
  try {
    const localAccounts = accounts.filter(isLocalAccount);
    store.insertAll(await Promise.all(localAccounts.map(observeLocal)));
    const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
    const allMeters = [...new Set([...meters, ...localMeters])];
    const decision = canRouteWithLeases(meters, localMeters, new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)])), routing.local_preference, policy, allowUnknown, store.leases(undefined, true), owner);
    store.audit("mcp", "can", action, decision.allowed ? "yes" : "no");
    return { source: "direct", decision };
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

async function directLeaseStart(arguments_: Record<string, unknown>): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try { return { source: "direct", lease: store.startLease(String(arguments_.owner ?? ""), String(arguments_.meter_id ?? ""), typeof arguments_.expected_percent === "number" ? arguments_.expected_percent : null, typeof arguments_.ttl_ms === "number" ? arguments_.ttl_ms : 30 * 60_000, typeof arguments_.note === "string" ? arguments_.note : null) }; }
  finally { store.close(); }
}

async function directLeaseEnd(arguments_: Record<string, unknown>): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try { return { source: "direct", lease: store.endLease(String(arguments_.id ?? ""), typeof arguments_.owner === "string" ? arguments_.owner : "", arguments_.force === true) }; }
  finally { store.close(); }
}

async function directLeases(): Promise<DirectResult> {
  const store = await HeadroomStore.open();
  try { return { source: "direct", leases: store.leases(undefined, true) }; } finally { store.close(); }
}

async function directResult(method: string, arguments_: Record<string, unknown>): Promise<DirectResult> {
  if (method === "status") return directStatus();
  if (method === "can") return directCan(typeof arguments_.action_class === "string" ? arguments_.action_class : "", arguments_.allow_unknown === true, typeof arguments_.owner === "string" ? arguments_.owner : undefined);
  if (method === "lease_start") return directLeaseStart(arguments_);
  if (method === "lease_end") return directLeaseEnd(arguments_);
  if (method === "leases") return directLeases();
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
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return failure(request.id, -32600, "Invalid Request");
  if (request.method === "initialize") {
    return response(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "headroom", version: "0.1.0" } });
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "tools/list") return response(request.id, { tools });
  if (request.method !== "tools/call") return failure(request.id, -32601, "Method not found");
  const params = request.params ?? {};
  const name = params.name;
  const arguments_ = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const method = name === "quota_status" ? "status" : name === "quota_can" ? "can" : name === "quota_events" ? "events" : name === "quota_lease_start" ? "lease_start" : name === "quota_lease_end" ? "lease_end" : name === "quota_leases" ? "leases" : undefined;
  if (!method) return failure(request.id, -32602, "Unknown tool");
  const result = await call(method, method === "can" ? { action_class: arguments_.action_class, allow_unknown: arguments_.allow_unknown === true, owner: arguments_.owner } : method === "events" ? { since: arguments_.since } : method === "lease_start" ? arguments_ : method === "lease_end" ? arguments_ : {});
  const resolved = result === undefined ? await fallback(method, arguments_) : result;
  return response(request.id, { content: [{ type: "text", text: JSON.stringify(resolved) }], structuredContent: resolved });
}
