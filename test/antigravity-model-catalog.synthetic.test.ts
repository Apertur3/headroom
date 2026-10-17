/** Synthetic model catalogs and quota lanes; no account or recorded vendor data. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollAccounts } from "../src/collector.js";
import { nativeEnginePath, runNativeEngine } from "../src/engine/native/run.js";
import { eventText } from "../src/notify-format.js";
import { HeadroomStore } from "../src/store.js";
import { buildAgentLine } from "../src/agent-line.js";
import { defaultPolicy } from "../src/policy.js";
import type { Observation } from "../src/types.js";

vi.mock("../src/engine/native/run.js", () => ({ NATIVE_ENGINE_TIMEOUT_MS: 90_000, nativeEnginePath: vi.fn(), runNativeEngine: vi.fn() }));
const PRINCIPAL = "synthetic-agy";
const BASE = [{ id: "synthetic-gemini", name: "Synthetic Gemini" }];
const NEW = { id: "synthetic-argon", name: "Synthetic Argon" };
const NOW = new Date("2026-10-01T12:00:00Z");
type Model = typeof NEW;
let home: string;
let store: HeadroomStore;
const previousHome = process.env.HEADROOM_HOME;
let hour: number;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "headroom-synthetic-catalog-"));
  process.env.HEADROOM_HOME = home;
  await writeFile(join(home, "accounts.toml"), `[[accounts]]\nname = "${PRINCIPAL}"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n`);
  store = await HeadroomStore.open(home);
  hour = 0;
  vi.mocked(nativeEnginePath).mockResolvedValue("/synthetic/engine");
});
afterEach(async () => {
  store?.close();
  if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  vi.clearAllMocks();
  await rm(home, { recursive: true, force: true });
});

function engineRows(models: Model[], state = "complete"): Observation[] {
  const at = new Date(NOW.getTime() + hour++ * 3_600_000).toISOString();
  return (["gemini", "claude-gpt"] as const).flatMap((meter) => ([300, 10_080] as const).map((minutes) => ({
    principal_id: PRINCIPAL, meter_id: `${PRINCIPAL}:${meter}`, window: { kind: minutes === 300 ? "rolling" as const : "fixed" as const, minutes, enforcement: "hard" as const },
    quantity: state === "failed" || state === "availability" || (state === "partial" && minutes === 10_080) ? null : { used: 10, limit: 100, remaining: 90, unit: "percent" as const },
    resets_at: "2026-10-08T12:00:00Z", observed_at: at, fetched_at: at, source: "local:antigravity:warm",
    truth: "official" as const, freshness: state === "failed" || state === "availability" || (state === "partial" && minutes === 10_080) ? "failed" as const : "fresh" as const,
    confidence: 1, adapter_version: "synthetic", upstream_schema_version: "synthetic",
    metadata: { model_catalog: models },
    lane: { payload_kind: state === "availability" ? "availability_only" : "quota_summary", bucket: state === "partial" && minutes === 10_080 ? "not_reported" : "reported", usage_known: state !== "failed" && state !== "availability" && !(state === "partial" && minutes === 10_080), disabled: false },
  })));
}
async function poll(models: Model[], state = "complete"): Promise<Observation[]> {
  vi.mocked(runNativeEngine).mockResolvedValue(engineRows(models, state));
  const result = await pollAccounts(undefined, { nativeEngineAvailable: true, daemonOwnsAntigravity: true });
  store.insertPoll(result.observations);
  return result.observations;
}
function modelEvents(kind: "model_available" | "model_retired") { return store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === kind); }

describe("Antigravity local catalog (synthetic)", () => {
  it("first complete read seeds IDs and human names silently", async () => {
    await poll(BASE);
    expect(store.knownModels(PRINCIPAL)).toMatchObject([{ model_id: BASE[0].id, model_name: BASE[0].name, vendor: "antigravity", retired_at: null }]);
    expect(modelEvents("model_available")).toEqual([]);
    expect(modelEvents("model_retired")).toEqual([]);
  });
  it("later complete read emits exactly one available alert with plain Antigravity wording", async () => {
    store.recordModelCatalog(PRINCIPAL, "antigravity", BASE, NOW);
    await poll([...BASE, NEW]);
    await poll([...BASE, NEW]);
    expect(modelEvents("model_available")).toHaveLength(1);
    expect(eventText(modelEvents("model_available")[0])).toBe("New model available in Antigravity: Synthetic Argon");
  });
  it.each(["failed", "partial", "availability"])("%s reads neither learn nor retire models", async (state) => {
    await poll([...BASE, NEW]);
    for (let count = 0; count < 4; count++) await poll([{ id: "synthetic-untrusted", name: "Untrusted" }], state);
    expect(store.knownModels(PRINCIPAL).map((model) => model.model_id).sort()).toEqual([BASE[0].id, NEW.id].sort());
    expect(store.knownModels(PRINCIPAL).every((model) => model.retired_at === null)).toBe(true);
    expect(modelEvents("model_retired")).toEqual([]);
    expect(modelEvents("model_available")).toEqual([]);
  });
  it("retires once only after three complete absences across restart, ignoring partial reads", async () => {
    store.recordModelCatalog(PRINCIPAL, "antigravity", [...BASE, NEW], NOW);
    await poll(BASE);
    await poll(BASE, "partial");
    await poll(BASE);
    expect(modelEvents("model_retired")).toEqual([]);
    store.close(); store = await HeadroomStore.open(home);
    await poll(BASE);
    await poll(BASE);
    expect(modelEvents("model_retired")).toHaveLength(1);
    expect(modelEvents("model_retired")[0].metadata?.model_id).toBe(NEW.id);
  });
  it("reappearance resets the absence count and never announces a known model again", async () => {
    await poll([...BASE, NEW]);
    await poll(BASE); await poll(BASE);
    await poll([...BASE, NEW]);
    await poll(BASE); await poll(BASE);
    expect(store.knownModels(PRINCIPAL).find((model) => model.model_id === NEW.id)?.retired_at).toBeNull();
    expect(modelEvents("model_retired")).toEqual([]);
    expect(modelEvents("model_available")).toEqual([]);
  });
  it("carries the model catalog on regenerated blocked lanes in a complete read", async () => {
    const rows = engineRows(BASE);
    rows[0] = { ...rows[0], quantity: null, freshness: "failed", lane: { payload_kind: "quota_summary", bucket: "reported", usage_known: false, disabled: true } } as Observation;
    rows[1].quantity = { used: 100, limit: 100, remaining: 0, unit: "percent" };
    vi.mocked(runNativeEngine).mockResolvedValue(rows);
    const result = await pollAccounts(undefined, { nativeEngineAvailable: true, daemonOwnsAntigravity: true });
    expect(result.observations[0].metadata).toMatchObject({ lane_state: "blocked_by_weekly", model_catalog: BASE });
    store.insertPoll(result.observations);
    expect(store.knownModels(PRINCIPAL)).toHaveLength(1);
  });

  it("replayed complete rows cannot accelerate retirement", async () => {
    await poll([...BASE, NEW]);
    const rows = await poll(BASE);
    for (let count = 0; count < 4; count++) store.insertPoll(rows);
    expect(modelEvents("model_retired")).toEqual([]);
    await poll(BASE);
    expect(modelEvents("model_retired")).toEqual([]);
    await poll(BASE);
    expect(modelEvents("model_retired")).toHaveLength(1);
  });
  it.each(["missing", "empty", "malformed", "inconsistent", "stale"])("%s catalog evidence does not count as a complete absence", async (state) => {
    await poll([...BASE, NEW]);
    for (let count = 0; count < 4; count++) {
      const rows = engineRows(BASE);
      if (state === "missing") for (const row of rows) delete row.metadata;
      if (state === "empty") for (const row of rows) row.metadata = { model_catalog: [] };
      if (state === "malformed") for (const row of rows) row.metadata = { model_catalog: [{ id: "", name: "Invalid" }] };
      if (state === "inconsistent") rows[0].metadata = { model_catalog: [NEW] };
      if (state === "stale") for (const row of rows) row.freshness = "stale";
      store.insertPoll(rows);
    }
    await poll(BASE); await poll(BASE);
    expect(store.knownModels(PRINCIPAL).find((model) => model.model_id === NEW.id)?.retired_at).toBeNull();
    await poll(BASE);
    expect(modelEvents("model_retired")).toHaveLength(1);
  });
  it("F1 seeds local models silently after a legacy remote catalog and keeps remote-only rows active", async () => {
    store.recordModelCatalog(PRINCIPAL, "antigravity", [NEW], NOW, { retireMissing: false });
    // Reproduce an upgraded installation's legacy remote initialization marker.
    store.setDaemonState(`model_catalog_initialized:${PRINCIPAL}`, NOW.toISOString());
    await poll(BASE);
    expect(modelEvents("model_available")).toEqual([]);
    for (let count = 0; count < 4; count++) await poll(BASE);
    expect(store.knownModels(PRINCIPAL).find((row) => row.model_id === NEW.id)?.retired_at).toBeNull();
    expect(modelEvents("model_retired")).toEqual([]);
  });
  it("F1 remote refreshes neither reset local absences nor revive locally retired models", async () => {
    await poll([...BASE, NEW]);
    for (let count = 0; count < 3; count++) {
      await poll(BASE);
      store.recordModelCatalog(PRINCIPAL, "antigravity", [NEW], NOW, { retireMissing: false });
    }
    expect(store.daemonState(`model_missing:${PRINCIPAL}:${NEW.id}`)).toBe("3");
    expect(store.knownModels(PRINCIPAL).find((row) => row.model_id === NEW.id)?.retired_at).not.toBeNull();
    expect(modelEvents("model_retired")).toHaveLength(1);
  });
  it("F2 partial reads strip catalogs from reused fresh rows", async () => {
    await poll([...BASE, NEW]);
    const partial = await poll(BASE, "partial");
    expect(partial.every((row) => row.metadata?.model_catalog === undefined)).toBe(true);
  });
  it("F4 blocked lane replays use the engine timestamp rather than poll time", async () => {
    await poll([...BASE, NEW]);
    const rows = engineRows(BASE);
    rows[0] = { ...rows[0], quantity: null, freshness: "failed", lane: { payload_kind: "quota_summary", bucket: "reported", usage_known: false, disabled: true } } as Observation;
    rows[1].quantity = { used: 100, limit: 100, remaining: 0, unit: "percent" };
    for (let count = 0; count < 4; count++) {
      vi.mocked(runNativeEngine).mockResolvedValue(rows);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW.getTime() + (10 + count) * 3_600_000));
      try {
        const result = await pollAccounts(undefined, { nativeEngineAvailable: true, daemonOwnsAntigravity: true });
        store.insertPoll(result.observations);
      } finally { vi.useRealTimers(); }
    }
    expect(store.daemonState(`antigravity_model_read:${PRINCIPAL}`)).toBe(rows[0].fetched_at);
    expect(modelEvents("model_retired")).toEqual([]);
  });
  it("F4 store ignores newer synthesized timestamps when guarding engine replays", async () => {
    await poll([...BASE, NEW]);
    const rows = engineRows(BASE);
    rows[0] = { ...rows[0], quantity: null, freshness: "failed", lane: { payload_kind: "quota_summary", bucket: "reported", usage_known: false, disabled: true } } as Observation;
    rows[1].quantity = { used: 100, limit: 100, remaining: 0, unit: "percent" };
    const engineAt = rows[1].fetched_at;
    for (let count = 0; count < 4; count++) {
      rows[0].fetched_at = new Date(NOW.getTime() + (10 + count) * 3_600_000).toISOString();
      store.insertPoll(rows);
    }
    expect(store.daemonState(`antigravity_model_read:${PRINCIPAL}`)).toBe(engineAt);
    expect(modelEvents("model_retired")).toEqual([]);
  });
  it("F5 duplicate catalog ids keep their first name without dropping the catalog", async () => {
    await poll([...BASE, { ...BASE[0], name: "Duplicate alias" }, NEW]);
    expect(store.knownModels(PRINCIPAL).map((row) => [row.model_id, row.model_name])).toEqual([
      [NEW.id, NEW.name], [BASE[0].id, BASE[0].name],
    ]);
  });
  it("headroom line names an unknown Antigravity weekly instead of a blank value", () => {
    const rows = engineRows(BASE, "partial");
    const line = buildAgentLine(rows, defaultPolicy, [PRINCIPAL], NOW);
    expect(line.line).toContain(`${PRINCIPAL}:gemini UNKNOWN (failed)`);
    expect(line.line).not.toMatch(/Gemini wk\s*(?:·|$)/i);
  });
});

describe("shared catalog retirement guard (synthetic)", () => {
  it.each(["codex", "claude"])("%s requires three absences, resets on reappearance and keeps addition deduplication", (vendor) => {
    store.recordModelCatalog(vendor, vendor, [...BASE, NEW], NOW);
    expect(store.recordModelCatalog(vendor, vendor, BASE).retired).toEqual([]);
    expect(store.recordModelCatalog(vendor, vendor, BASE).retired).toEqual([]);
    store.recordModelCatalog(vendor, vendor, [...BASE, NEW]);
    expect(store.recordModelCatalog(vendor, vendor, BASE).retired).toEqual([]);
    expect(store.recordModelCatalog(vendor, vendor, BASE).retired).toEqual([]);
    expect(store.recordModelCatalog(vendor, vendor, BASE).retired).toEqual([NEW.id]);
    store.recordModelCatalog(vendor, vendor, BASE);
    expect(modelEvents("model_retired")).toHaveLength(1);
    store.recordModelCatalog(vendor, vendor, [...BASE, NEW]);
    expect(modelEvents("model_available")).toEqual([]);
  });
});
