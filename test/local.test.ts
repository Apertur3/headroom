import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { observeLocal, vllmQueue } from "../src/engine/local.js";
import { formatMeters } from "../src/cli.js";
import { canRoute, defaultPolicy, paceDecision } from "../src/policy.js";
import { parseRouting } from "../src/config.js";
import type { LocalAccount, Observation } from "../src/types.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function stub(metrics: string, models = ["local-27b"]): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: models.map((id) => ({ id })) })); return; }
    if (request.url === "/metrics") { response.end(metrics); return; }
    if (request.url === "/health") { response.end("ok"); return; }
    response.statusCode = 404; response.end();
  });
  servers.push(server);
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject).listen(0, "127.0.0.1", resolve); }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { server.close(); servers.splice(servers.indexOf(server), 1); throw error; }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

function local(base_url: string, wake?: string): LocalAccount { return { name: "gpu-box", kind: "local", base_url, ...(wake ? { wake } : {}), adapter: "native" }; }

describe("native:local adapter", () => {
  it("reads model ids and vLLM queue metrics as an UP capacity state", async () => {
    let base: string;
    try { base = await stub("vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n"); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP local HTTP stub: sandbox forbids listen(2)\n"); return; } throw error; }
    const observation = await observeLocal(local(base));
    expect(observation).toMatchObject({ meter_id: "gpu-box:capacity", source: "native:local", window: { kind: "state" }, quantity: { used: 0, limit: null, unit: "requests" }, freshness: "fresh", metadata: { state: "UP", model_ids: ["local-27b"], running: 0, waiting: 0, cost_model: "marginal" } });
    expect(formatMeters([observation], defaultPolicy)).toEqual(["gpu-box:capacity  UP model=local-27b running=0 waiting=0"]);
    expect(paceDecision(observation, defaultPolicy).state).toBe("UP");
  });

  it("reports BUSY from the recorded metrics fixture", async () => {
    const metrics = await readFile(new URL("../fixtures/local/vllm-metrics.prom", import.meta.url), "utf8");
    expect(vllmQueue(metrics)).toEqual({ running: 0, waiting: 2 });
    let base: string;
    try { base = await stub(metrics); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const observation = await observeLocal(local(base));
    expect(observation.metadata).toMatchObject({ state: "BUSY", waiting: 2 });
    expect(paceDecision(observation, defaultPolicy)).toMatchObject({ state: "BUSY", reason: "local pool busy; waiting 2" });
  });

  it("fails closed with the reported-only wake command when the base URL is down", async () => {
    const observation = await observeLocal(local("http://127.0.0.1:1", "ssh gateway wake-workstation"));
    expect(observation).toMatchObject({ freshness: "failed", reason: "down; wake: ssh gateway wake-workstation", metadata: { state: "DOWN", cost_model: "marginal" } });
    expect(formatMeters([observation], defaultPolicy)).toEqual(["gpu-box:capacity  DOWN (wake: ssh gateway wake-workstation)"]);
  });
});

describe("local routing preference", () => {
  const now = new Date("2026-09-03T12:00:00Z");
  const subscription = (): Observation => ({
    principal_id: "codex", meter_id: "codex:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 90, limit: 100, remaining: 10, unit: "percent" },
    resets_at: "2026-09-03T12:50:00Z", observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  });
  const localUp = (): Observation => ({
    principal_id: "gpu-box", meter_id: "gpu-box:capacity", window: { kind: "state", minutes: null, enforcement: "soft" }, quantity: { used: 0, limit: null, remaining: null, unit: "requests" },
    resets_at: null, observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "native:local", truth: "estimated", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", metadata: { state: "UP", model_ids: [], running: 0, waiting: 0, cost_model: "marginal" },
  });

  it("considers fallback local capacity only after every subscription meter is conserving", () => {
    const observations = new Map([["codex:main", subscription()], ["gpu-box:capacity", localUp()]]);
    expect(canRoute(["codex:main"], ["gpu-box:capacity"], observations, "fallback", { ...defaultPolicy, pace_grace_fraction: 0 }, false, now)).toMatchObject({ allowed: true, meter: "gpu-box:capacity", state: "UP", local_preference: "fallback", local_meter_considered: true });
    expect(canRoute(["codex:main"], ["gpu-box:capacity"], observations, "never", { ...defaultPolicy, pace_grace_fraction: 0 }, false, now)).toMatchObject({ allowed: false, local_preference: "never", local_meter_considered: false });
    expect(parseRouting('local_preference = "prefer"\n[consumes]\nbuild = ["codex:main"]')).toEqual({ local_preference: "prefer", consumes: { build: ["codex:main"] } });
  });
});
