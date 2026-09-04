import type { LocalAccount, Observation } from "../types.js";
import { allowedOutbound, outboundFetch } from "../security.js";
import { vendorJson, vendorText } from "../limits.js";

const timeoutMs = 3_000;

function endpoint(baseUrl: string, path: string): string {
  const value = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  return allowedOutbound(value, [baseUrl]).toString();
}

async function get(baseUrl: string, path: string): Promise<Response> {
  return outboundFetch(fetch, new Request(endpoint(baseUrl, path), { signal: AbortSignal.timeout(timeoutMs) }), { localBaseUrls: [baseUrl] });
}

function modelIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) return [];
  return (body as { data: unknown[] }).data.flatMap((model) => {
    if (!model || typeof model !== "object" || typeof (model as { id?: unknown }).id !== "string") return [];
    return [(model as { id: string }).id];
  });
}

/** Prometheus exposition is intentionally parsed narrowly: only these vLLM gauges
 * influence scheduling; all other metrics remain opaque to Headroom. */
export function vllmQueue(metrics: string): { running: number; waiting: number } | undefined {
  const value = (name: string): number | undefined => {
    const match = metrics.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9]+(?:\\.[0-9]+)?)\\s*$`, "m"));
    return match ? Number(match[1]) : undefined;
  };
  const running = value("vllm:num_requests_running");
  const waiting = value("vllm:num_requests_waiting");
  return running === undefined && waiting === undefined ? undefined : { running: running ?? 0, waiting: waiting ?? 0 };
}

function down(account: LocalAccount, error: unknown): Observation {
  const now = new Date().toISOString();
  const wake = account.wake ? `; wake: ${account.wake}` : "";
  return {
    principal_id: account.name, meter_id: `${account.name}:capacity`, window: { kind: "state", minutes: null, enforcement: "soft" }, quantity: null,
    resets_at: null, observed_at: now, fetched_at: now, source: "native:local", truth: "estimated", freshness: "failed", confidence: 1,
    adapter_version: "local-v1", upstream_schema_version: "openai-compatible-v1", reason: `down${wake}`,
    metadata: { state: "DOWN", model_ids: [], running: 0, waiting: 0, cost_model: "marginal" },
  };
}

/** Probe an OpenAI-compatible local pool. /v1/models is the liveness contract;
 * /metrics and /health are optional implementation-specific enrichments. */
export async function observeLocal(account: LocalAccount): Promise<Observation> {
  try {
    const modelsResponse = await get(account.base_url, "v1/models");
    if (!modelsResponse.ok) throw new Error(`models HTTP ${modelsResponse.status}`);
    const models = modelIds(await vendorJson(modelsResponse));
    const [metrics, health] = await Promise.all([
      get(account.base_url, "metrics").then(async (response) => response.ok ? vllmQueue(await vendorText(response)) : undefined).catch(() => undefined),
      get(account.base_url, "health").then(() => undefined).catch(() => undefined),
    ]);
    const running = metrics?.running ?? 0;
    const waiting = metrics?.waiting ?? 0;
    const state = waiting > 0 ? "BUSY" : "UP";
    const now = new Date().toISOString();
    return {
      principal_id: account.name, meter_id: `${account.name}:capacity`, window: { kind: "state", minutes: null, enforcement: "soft" },
      quantity: { used: running, limit: null, remaining: null, unit: "requests" }, resets_at: null, observed_at: now, fetched_at: now,
      source: "native:local", truth: "estimated", freshness: "fresh", confidence: 1, adapter_version: "local-v1", upstream_schema_version: "openai-compatible-v1",
      metadata: { state, model_ids: models, running, waiting, cost_model: "marginal" },
    };
  } catch (error) {
    return down(account, error);
  }
}
