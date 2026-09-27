import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function openStore(prefix: string): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

function observation(overrides: Partial<Observation> = {}): Observation {
  const now = "2026-09-23T12:00:00Z";
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes: 300, enforcement: "hard" },
    quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: "2026-09-23T17:00:00Z",
    observed_at: now, fetched_at: now, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}

describe("HeadroomStore.recordModelCatalog (model_available / model_retired)", () => {
  it("seeds the first-ever read for a principal silently: rows land in known_models, no event fires", async () => {
    const store = await openStore("headroom-models-seed-");
    try {
      const at = new Date("2026-09-23T12:00:00Z");
      const result = store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }], at);
      expect(result.seeded).toBe(true);
      expect(result.added).toEqual([]);
      expect(result.retired).toEqual([]);
      const known = store.knownModels("codex-main");
      expect(known).toHaveLength(2);
      expect(known.every((row) => row.first_seen_at === at.toISOString() && row.retired_at === null)).toBe(true);
      expect(store.events("2026-01-01T00:00:00Z")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("emits exactly one model_available event per genuinely new id, never repeating it on an unchanged next read", async () => {
    const store = await openStore("headroom-models-new-once-");
    try {
      const seedAt = new Date("2026-09-23T12:00:00Z");
      store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra", name: "GPT-6-Astra" }], seedAt);

      const addedAt = new Date("2026-09-23T13:00:00Z");
      const first = store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }], addedAt);
      expect(first.seeded).toBe(false);
      expect(first.added).toEqual(["gpt-6-sol"]);
      const events = store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_available");
      expect(events).toHaveLength(1);
      expect(events[0].principal_id).toBe("codex-main");
      expect(events[0].reason).toBe("gpt-6-sol");
      expect(events[0].metadata?.model_id).toBe("gpt-6-sol");
      expect(events[0].metadata?.model_name).toBe("GPT-6-Sol");

      // The exact same catalog again (next poll): no new event, no duplicate row.
      const secondAt = new Date("2026-09-23T14:00:00Z");
      const second = store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }], secondAt);
      expect(second.added).toEqual([]);
      expect(store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_available")).toHaveLength(1);
      expect(store.knownModels("codex-main")).toHaveLength(2);
    } finally { store.close(); }
  });

  it("marks an authoritative empty first catalog as initialized, so a later first model is announced", async () => {
    const store = await openStore("headroom-models-empty-seed-");
    try {
      const emptyAt = new Date("2026-09-23T12:00:00Z");
      expect(store.recordModelCatalog("codex-main", "codex", [], emptyAt)).toMatchObject({ seeded: true, added: [] });
      const addedAt = new Date("2026-09-23T13:00:00Z");
      const result = store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra", name: "GPT-6-Astra" }], addedAt);
      expect(result).toMatchObject({ seeded: false, added: ["gpt-6-astra"] });
      expect(store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_available")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("retires an id no longer reported, with one model_retired event, and un-retires it without a new event if the vendor brings it back", async () => {
    const store = await openStore("headroom-models-retire-");
    try {
      store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra" }, { id: "gpt-6-sol" }], new Date("2026-09-23T12:00:00Z"));

      const retiredAt = new Date("2026-09-23T13:00:00Z");
      const retired = store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra" }], retiredAt);
      expect(retired.retired).toEqual(["gpt-6-sol"]);
      const afterRetire = store.knownModels("codex-main").find((row) => row.model_id === "gpt-6-sol");
      expect(afterRetire?.retired_at).toBe(retiredAt.toISOString());
      const retireEvents = store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_retired");
      expect(retireEvents).toHaveLength(1);
      expect(retireEvents[0].metadata?.model_id).toBe("gpt-6-sol");

      // Reappears: retired_at clears, but no fresh model_available event (only the very first sighting is newsworthy).
      const backAt = new Date("2026-09-23T14:00:00Z");
      const back = store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra" }, { id: "gpt-6-sol" }], backAt);
      expect(back.added).toEqual([]);
      const afterReturn = store.knownModels("codex-main").find((row) => row.model_id === "gpt-6-sol");
      expect(afterReturn?.retired_at).toBeNull();
      expect(afterReturn?.first_seen_at).toBe(new Date("2026-09-23T12:00:00Z").toISOString()); // unchanged
      expect(store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_available")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("only claims a dedicated bucket from a current fresh official observation, otherwise retaining unknown or shared-pool evidence", async () => {
    const store = await openStore("headroom-models-meter-evidence-");
    try {
      store.recordModelCatalog("claude-work", "claude", [{ id: "claude-sonnet-5", name: "Sonnet 5" }], new Date("2026-09-23T12:00:00Z"));

      // A current, fresh official model-scoped meter is enough to say this
      // newly listed model has a dedicated bucket.
      store.insert(observation({ principal_id: "claude-work", meter_id: "claude-work:fable" }));
      store.recordModelCatalog("claude-work", "claude", [{ id: "claude-sonnet-5" }, { id: "claude-fable-5" }], new Date("2026-09-23T13:00:00Z"));
      let event = store.events("2026-01-01T00:00:00Z").find((item) => item.kind === "model_available" && item.metadata?.model_id === "claude-fable-5");
      expect(event?.metadata?.shares_pool).toBe(false);

      // A later failed placeholder for the same meter replaces that old
      // fresh row as current evidence. It is UNKNOWN, never capacity.
      store.insert(observation({ principal_id: "claude-work", meter_id: "claude-work:fable", fetched_at: "2026-09-23T13:30:00Z", observed_at: "2026-09-23T13:30:00Z", freshness: "failed", quantity: null, window: null, resets_at: null }));
      store.recordModelCatalog("claude-work", "claude", [{ id: "claude-sonnet-5" }, { id: "claude-fable-5" }, { id: "claude-fable-pro" }], new Date("2026-09-23T14:00:00Z"));
      event = store.events("2026-01-01T00:00:00Z").find((item) => item.kind === "model_available" && item.metadata?.model_id === "claude-fable-pro");
      expect(event?.metadata?.shares_pool).toBeUndefined();

      // A held tentative vendor window is likewise not current evidence.
      store.insert(observation({ principal_id: "claude-work", meter_id: "claude-work:fable", fetched_at: "2026-09-23T14:30:00Z", observed_at: "2026-09-23T14:30:00Z", metadata: { vendor_window_held: true } }));
      store.recordModelCatalog("claude-work", "claude", [{ id: "claude-sonnet-5" }, { id: "claude-fable-5" }, { id: "claude-fable-pro" }, { id: "claude-fable-extended" }], new Date("2026-09-23T14:45:00Z"));
      event = store.events("2026-01-01T00:00:00Z").find((item) => item.kind === "model_available" && item.metadata?.model_id === "claude-fable-extended");
      expect(event?.metadata?.shares_pool).toBeUndefined();

      // A current generic official meter is the narrower, explicit shared
      // pool signal; it is distinct from merely lacking a dedicated meter.
      store.insert(observation({ principal_id: "claude-work", meter_id: "claude-work:main", fetched_at: "2026-09-23T14:30:00Z", observed_at: "2026-09-23T14:30:00Z" }));
      store.recordModelCatalog("claude-work", "claude", [{ id: "claude-sonnet-5" }, { id: "claude-fable-5" }, { id: "claude-fable-pro" }, { id: "claude-fable-extended" }, { id: "claude-terra-5" }], new Date("2026-09-23T15:00:00Z"));
      event = store.events("2026-01-01T00:00:00Z").find((item) => item.kind === "model_available" && item.metadata?.model_id === "claude-terra-5");
      expect(event?.metadata?.shares_pool).toBe(true);
    } finally { store.close(); }
  });

  it("keeps two principals' known models fully independent", async () => {
    const store = await openStore("headroom-models-independent-");
    try {
      store.recordModelCatalog("codex-main", "codex", [{ id: "gpt-6-astra" }], new Date("2026-09-23T12:00:00Z"));
      store.recordModelCatalog("codex-work", "codex", [{ id: "gpt-6-sol" }], new Date("2026-09-23T12:00:00Z"));
      expect(store.knownModels("codex-main").map((row) => row.model_id)).toEqual(["gpt-6-astra"]);
      expect(store.knownModels("codex-work").map((row) => row.model_id)).toEqual(["gpt-6-sol"]);
      expect(store.knownModels().map((row) => row.model_id).sort()).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    } finally { store.close(); }
  });
});
