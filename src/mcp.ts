import { daemonRequest, socketPath } from "./daemon.js";
import { pollAccounts } from "./collector.js";
import { readPolicy, readRouting } from "./config.js";
import { observeLocal } from "./engine/local.js";
import { canRoute } from "./policy.js";
import { readAccounts } from "./registry.js";
import { TallyStore } from "./store.js";
import { isLocalAccount } from "./types.js";

type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
const tools = [
  { name: "quota_status", description: "Return the latest quota windows for every Tally meter.", inputSchema: { type: "object", properties: {} } },
  { name: "quota_can", description: "Check whether an action class can consume all of its meters.", inputSchema: { type: "object", properties: { action_class: { type: "string" }, allow_unknown: { type: "boolean" } }, required: ["action_class"] } },
  { name: "quota_events", description: "Return Tally events since an ISO timestamp or duration resolved by the caller.", inputSchema: { type: "object", properties: { since: { type: "string" } } } },
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
  const store = await TallyStore.open();
  try {
    store.insertAll(polled.observations);
    store.audit("mcp", "status", null, polled.failures.length ? "partial" : "ok");
    return { source: "direct", observations: store.latestPerWindow(), failures: polled.failures };
  } finally { store.close(); }
}

async function directCan(action: string, allowUnknown: boolean): Promise<DirectResult> {
  const routing = await readRouting();
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action || "(missing)"}`);
  const [policy, accounts, store] = await Promise.all([readPolicy(), readAccounts(), TallyStore.open()]);
  try {
    const localAccounts = accounts.filter(isLocalAccount);
    store.insertAll(await Promise.all(localAccounts.map(observeLocal)));
    const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
    const allMeters = [...new Set([...meters, ...localMeters])];
    const decision = canRoute(meters, localMeters, new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)])), routing.local_preference, policy, allowUnknown);
    store.audit("mcp", "can", action, decision.allowed ? "yes" : "no");
    return { source: "direct", decision };
  } finally { store.close(); }
}

async function directEvents(since: unknown): Promise<DirectResult> {
  const value = typeof since === "string" ? since : new Date(Date.now() - 86_400_000).toISOString();
  const store = await TallyStore.open();
  try {
    const events = store.events(value);
    store.audit("mcp", "events", null, "ok");
    return { source: "direct", events };
  } finally { store.close(); }
}

async function directResult(method: string, arguments_: Record<string, unknown>): Promise<DirectResult> {
  if (method === "status") return directStatus();
  if (method === "can") return directCan(typeof arguments_.action_class === "string" ? arguments_.action_class : "", arguments_.allow_unknown === true);
  return directEvents(arguments_.since);
}

async function daemonCall(method: string, params: Record<string, unknown>): Promise<unknown | undefined> {
  const request = await daemonRequest(socketPath(), method, params);
  if (request.status === "available") return request.result;
  if (request.status === "unresponsive") throw new Error("Tally daemon socket is present but health did not respond within 2s");
  return undefined;
}

export async function handleMcp(line: string, call = daemonCall, fallback = directResult): Promise<Record<string, unknown> | undefined> {
  let request: Request;
  try { request = JSON.parse(line) as Request; } catch { return failure(null, -32700, "Parse error"); }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return failure(request.id, -32600, "Invalid Request");
  if (request.method === "initialize") {
    return response(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "tally", version: "0.1.0" } });
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "tools/list") return response(request.id, { tools });
  if (request.method !== "tools/call") return failure(request.id, -32601, "Method not found");
  const params = request.params ?? {};
  const name = params.name;
  const arguments_ = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const method = name === "quota_status" ? "status" : name === "quota_can" ? "can" : name === "quota_events" ? "events" : undefined;
  if (!method) return failure(request.id, -32602, "Unknown tool");
  const result = await call(method, method === "can" ? { action_class: arguments_.action_class, allow_unknown: arguments_.allow_unknown === true } : method === "events" ? { since: arguments_.since } : {});
  const resolved = result === undefined ? await fallback(method, arguments_) : result;
  return response(request.id, { content: [{ type: "text", text: JSON.stringify(resolved) }], structuredContent: resolved });
}
