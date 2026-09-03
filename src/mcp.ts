import { rpc, socketPath } from "./daemon.js";

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

export async function handleMcp(line: string, call = (method: string, params: Record<string, unknown>) => rpc(socketPath(), method, params)): Promise<Record<string, unknown> | undefined> {
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
  if (result === undefined) return failure(request.id, -32000, "Tally daemon unavailable; run `tally daemon`");
  return response(request.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
}
