import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkModelAvailability, fetchAntigravityModelCatalog, MODEL_CATALOG_MAX_AGE_MS, MODEL_CHECK_INTERVAL_MS,
  readClaudeModelCatalog, readCodexModelCatalog,
} from "../src/model-catalog.js";
import { HeadroomStore } from "../src/store.js";
import type { ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

describe("Codex model catalog reader (local cache file, no network)", () => {
  it("reads slug and display_name out of $CODEX_HOME/models_cache.json, dropping hidden entries", async () => {
    const home = await tempDir("headroom-codex-models-");
    const at = new Date("2026-09-23T18:00:00Z");
    await writeFile(join(home, "models_cache.json"), JSON.stringify({
      fetched_at: "2026-09-23T17:20:36Z",
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ],
    }));
    const models = await readCodexModelCatalog(home, undefined, at);
    expect(models).toEqual({ models: [{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }], fetchedAt: "2026-09-23T17:20:36.000Z" });
  });

  it("returns undefined, never an empty array, when the cache file does not exist yet", async () => {
    const home = await tempDir("headroom-codex-models-missing-");
    expect(await readCodexModelCatalog(home)).toBeUndefined();
  });

  it("returns undefined on malformed JSON rather than throwing", async () => {
    const home = await tempDir("headroom-codex-models-malformed-");
    await writeFile(join(home, "models_cache.json"), "{not json");
    expect(await readCodexModelCatalog(home)).toBeUndefined();
  });

  it("does not treat a stale or timestamp-less cache as a current catalog", async () => {
    const home = await tempDir("headroom-codex-models-stale-");
    const at = new Date("2026-09-23T18:00:00Z");
    await writeFile(join(home, "models_cache.json"), JSON.stringify({ fetched_at: new Date(at.getTime() - MODEL_CATALOG_MAX_AGE_MS - 1).toISOString(), models: [{ slug: "gpt-6-astra" }] }));
    expect(await readCodexModelCatalog(home, undefined, at)).toBeUndefined();
    await writeFile(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    expect(await readCodexModelCatalog(home, undefined, at)).toBeUndefined();
  });
});

describe("Claude model catalog reader (local cache directory, no network)", () => {
  it("reads the newest-by-fetchedAt file under cache/model-catalog and maps its models", async () => {
    const configDir = await tempDir("headroom-claude-models-");
    const catalogDir = join(configDir, "cache", "model-catalog");
    const at = new Date("2026-09-23T18:00:00Z");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "tok-old.json"), JSON.stringify({
      fetchedAt: at.getTime() - 2000, catalog: { config: { models: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }] } },
    }));
    await writeFile(join(catalogDir, "tok-new.json"), JSON.stringify({
      fetchedAt: at.getTime() - 1000, catalog: { config: { models: [{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }] } },
    }));
    const models = await readClaudeModelCatalog(configDir, undefined, undefined, at);
    expect(models).toEqual({ models: [{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }], fetchedAt: new Date(at.getTime() - 1000).toISOString() });
  });

  it("skips one malformed cache file rather than failing the whole read", async () => {
    const configDir = await tempDir("headroom-claude-models-partial-");
    const catalogDir = join(configDir, "cache", "model-catalog");
    const at = new Date("2026-09-23T18:00:00Z");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "broken.json"), "{not json");
    await writeFile(join(catalogDir, "good.json"), JSON.stringify({ fetchedAt: at.getTime(), catalog: { config: { models: [{ id: "claude-haiku-4-5", name: "Haiku 4.5" }] } } }));
    expect(await readClaudeModelCatalog(configDir, undefined, undefined, at)).toEqual({ models: [{ id: "claude-haiku-4-5", name: "Haiku 4.5" }], fetchedAt: at.toISOString() });
  });

  it("returns undefined when the config dir has no model-catalog cache yet", async () => {
    const configDir = await tempDir("headroom-claude-models-none-");
    expect(await readClaudeModelCatalog(configDir)).toBeUndefined();
  });

  it("rejects an arbitrarily old newest file instead of stamping it as seen now", async () => {
    const configDir = await tempDir("headroom-claude-models-stale-");
    const catalogDir = join(configDir, "cache", "model-catalog");
    const at = new Date("2026-09-23T18:00:00Z");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "old.json"), JSON.stringify({ fetchedAt: at.getTime() - MODEL_CATALOG_MAX_AGE_MS - 1, catalog: { config: { models: [{ id: "claude-opus-5-5" }] } } }));
    expect(await readClaudeModelCatalog(configDir, undefined, undefined, at)).toBeUndefined();
  });
});

describe("Antigravity model catalog reader (fetchAvailableModels, same credential as quota)", () => {
  const at = new Date("2026-09-23T18:00:00Z");

  it("resolves the project from the stored credential and parses the models map", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: { "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" }, "claude-sonnet": { displayName: "Claude Sonnet" } },
      })));
    const models = await fetchAntigravityModelCatalog({
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-23T20:00:00Z", project: "stored-project" }),
      fetch,
    });
    expect(models).toEqual([{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }, { id: "claude-sonnet", name: "Claude Sonnet" }]);
    const requests = fetch.mock.calls.map(([request]) => request as Request);
    expect(requests[1].url).toBe("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(await requests[1].text()).toBe(JSON.stringify({ project: "stored-project" }));
  });

  it("returns undefined, never throws, when no Code Assist project can be resolved", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({})));
    const models = await fetchAntigravityModelCatalog({
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-23T20:00:00Z" }),
      fetch,
    });
    expect(models).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1); // never calls fetchAvailableModels without a project
  });

  it("returns undefined on a non-2xx response instead of throwing", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const models = await fetchAntigravityModelCatalog({
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-23T20:00:00Z", project: "stored-project" }),
      fetch,
    });
    expect(models).toBeUndefined();
  });

  it("does not retire models from a 200 response with an invalid catalog body", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: "shape" })));
    const models = await fetchAntigravityModelCatalog({
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-23T20:00:00Z", project: "stored-project" }),
      fetch,
    });
    expect(models).toBeUndefined();
  });

  it("returns undefined, never throws, with no credentials on disk", async () => {
    const models = await fetchAntigravityModelCatalog({
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    });
    expect(models).toBeUndefined();
  });
});

describe("checkModelAvailability orchestration", () => {
  function account(name: string, vendor: ProviderAccount["vendor"], enabled = true): ProviderAccount {
    return { name, vendor, ...(enabled ? {} : { enabled: false }), location: `/tmp/${name}`, adapter: "native-ts" };
  }

  it("checks every codex/claude/antigravity principal once, then skips all of them inside the hourly throttle", async () => {
    const home = await tempDir("headroom-model-check-throttle-");
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const at = new Date("2026-09-23T18:00:00Z");
      const readCodex = vi.fn().mockResolvedValue({ models: [{ id: "gpt-6-astra", name: "GPT-6-Astra" }], fetchedAt: "2026-09-23T18:00:00Z" });
      const accounts = [account("codex-main", "codex")];
      await checkModelAvailability(store, accounts, { now: () => at, readCodexModelCatalog: readCodex });
      expect(readCodex).toHaveBeenCalledTimes(1);
      // Seeded silently: known_models has the row, but no event fired yet.
      expect(store.knownModels("codex-main")).toHaveLength(1);
      expect(store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_available")).toHaveLength(0);

      // A second check a minute later is inside the hourly throttle.
      const soon = new Date(at.getTime() + 60_000);
      await checkModelAvailability(store, accounts, { now: () => soon, readCodexModelCatalog: readCodex });
      expect(readCodex).toHaveBeenCalledTimes(1);

      // Past the hour, and with a genuinely new model, it checks again and emits one event.
      const later = new Date(at.getTime() + MODEL_CHECK_INTERVAL_MS + 1000);
      readCodex.mockResolvedValue({ models: [{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }], fetchedAt: later.toISOString() });
      await checkModelAvailability(store, accounts, { now: () => later, readCodexModelCatalog: readCodex });
      expect(readCodex).toHaveBeenCalledTimes(2);
      expect(store.events("2026-01-01T00:00:00Z").filter((event) => event.kind === "model_available")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("ignores local pool accounts and vendors with no reader (gemini, grok, kimi)", async () => {
    const home = await tempDir("headroom-model-check-vendors-");
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const readCodex = vi.fn();
      const readClaude = vi.fn();
      await checkModelAvailability(store, [account("g", "gemini"), account("k", "kimi"), account("x", "grok")], { readCodexModelCatalog: readCodex, readClaudeModelCatalog: readClaude });
      expect(readCodex).not.toHaveBeenCalled();
      expect(readClaude).not.toHaveBeenCalled();
      expect(store.knownModels()).toHaveLength(0);
    } finally { store.close(); }
  });

  it("never invokes readers for disabled-only inputs, then uses each live account's own path", async () => {
    const home = await tempDir("headroom-model-check-disabled-");
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const readCodex = vi.fn().mockResolvedValue({ models: [{ id: "gpt-6-astra", name: "GPT-6-Astra" }], fetchedAt: "2026-09-23T18:00:00Z" });
      const readClaude = vi.fn().mockResolvedValue({ models: [{ id: "claude-sonnet-5", name: "Sonnet 5" }], fetchedAt: "2026-09-23T18:00:00Z" });
      const fetchAntigravity = vi.fn().mockResolvedValue([]);
      await checkModelAvailability(store, [
        account("codex-parked", "codex", false), account("claude-parked", "claude", false), account("antigravity-parked", "antigravity", false),
      ], { readCodexModelCatalog: readCodex, readClaudeModelCatalog: readClaude, fetchAntigravityModelCatalog: fetchAntigravity });
      expect(readCodex).not.toHaveBeenCalled();
      expect(readClaude).not.toHaveBeenCalled();
      expect(fetchAntigravity).not.toHaveBeenCalled();
      expect(store.knownModels("codex-parked")).toEqual([]);
      expect(store.knownModels("claude-parked")).toEqual([]);
      expect(store.knownModels("antigravity-parked")).toEqual([]);

      await checkModelAvailability(store, [
        account("codex-live", "codex"), account("claude-live", "claude"), account("antigravity-live", "antigravity"),
      ], { readCodexModelCatalog: readCodex, readClaudeModelCatalog: readClaude, fetchAntigravityModelCatalog: fetchAntigravity, antigravityModelCatalog: true });
      expect(readCodex).toHaveBeenCalledWith(resolve("/tmp/codex-live"), undefined, expect.any(Date));
      expect(readClaude).toHaveBeenCalledWith(resolve("/tmp/claude-live"), undefined, undefined, expect.any(Date));
      expect(fetchAntigravity).toHaveBeenCalledTimes(1);
      expect(store.knownModels("codex-live")).toHaveLength(1);
      expect(store.knownModels("claude-live")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("advances the throttle even when a reader throws, so a broken source is not retried every poll", async () => {
    const home = await tempDir("headroom-model-check-broken-");
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const at = new Date("2026-09-23T18:00:00Z");
      const readCodex = vi.fn().mockRejectedValue(new Error("boom"));
      const accounts = [account("codex-main", "codex")];
      await expect(checkModelAvailability(store, accounts, { now: () => at, readCodexModelCatalog: readCodex })).resolves.toBeUndefined();
      const soon = new Date(at.getTime() + 60_000);
      await checkModelAvailability(store, accounts, { now: () => soon, readCodexModelCatalog: readCodex });
      expect(readCodex).toHaveBeenCalledTimes(1); // throttled even though the first attempt failed
    } finally { store.close(); }
  });

  it("claims the interval before awaiting a reader, so overlapping checks make one catalog read", async () => {
    const home = await tempDir("headroom-model-check-overlap-");
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const at = new Date("2026-09-23T18:00:00Z");
      let release: ((catalog: { models: { id: string; name: string }[]; fetchedAt: string }) => void) | undefined;
      const readCodex = vi.fn(() => new Promise<{ models: { id: string; name: string }[]; fetchedAt: string }>((resolve) => { release = resolve; }));
      const accounts = [account("codex-main", "codex")];
      const first = checkModelAvailability(store, accounts, { now: () => at, readCodexModelCatalog: readCodex });
      await Promise.resolve();
      await checkModelAvailability(store, accounts, { now: () => at, readCodexModelCatalog: readCodex });
      expect(readCodex).toHaveBeenCalledTimes(1);
      release?.({ models: [{ id: "gpt-6-astra", name: "GPT-6-Astra" }], fetchedAt: at.toISOString() });
      await first;
    } finally { store.close(); }
  });
});

// Synthetic partial cache payloads must never become authoritative catalogs.
describe("partial local model catalogs (synthetic)", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  it("rejects a Codex model array containing an incomplete entry", async () => {
    const read = async () => JSON.stringify({ fetched_at: now.toISOString(), models: [{ slug: "synthetic-codex", display_name: "Synthetic Codex" }, {}] });
    expect(await readCodexModelCatalog("/synthetic", read, now)).toBeUndefined();
  });
  it("rejects a Claude model array containing an incomplete entry", async () => {
    const read = async () => JSON.stringify({ fetchedAt: now.getTime(), catalog: { config: { models: [{ id: "synthetic-claude", name: "Synthetic Claude" }, {}] } } });
    expect(await readClaudeModelCatalog("/synthetic", async () => ["synthetic.json"], read, now)).toBeUndefined();
  });
});

describe("F3 cache snapshot evidence (synthetic)", () => {
  const start = new Date("2026-10-01T12:00:00Z");
  it.each(["codex", "claude"] as const)("F3 %s empty catalogs are unavailable", async (vendor) => {
    const read = async () => JSON.stringify(vendor === "codex" ? { fetched_at: start.toISOString(), models: [] } : { fetchedAt: start.getTime(), catalog: { config: { models: [] } } });
    expect(await (vendor === "codex" ? readCodexModelCatalog("/synthetic", read, start) : readClaudeModelCatalog("/synthetic", async () => ["catalog.json"], read, start))).toBeUndefined();
  });
  it("F3 hidden-only Codex catalogs are unavailable", async () => {
    expect(await readCodexModelCatalog("/synthetic", async () => JSON.stringify({ fetched_at: start.toISOString(), models: [{ slug: "synthetic-hidden", visibility: "hide" }] }), start)).toBeUndefined();
  });
  it.each(["codex", "claude"] as const)("F3 %s counts distinct cache timestamps per principal across restart", async (vendor) => {
    const home = await tempDir("headroom-cache-replay-");
    const cache = vendor === "codex" ? home : join(home, "cache", "model-catalog");
    await mkdir(cache, { recursive: true });
    const file = join(cache, vendor === "codex" ? "models_cache.json" : "catalog.json");
    let fetched = start;
    const write = (ids: string[]) => writeFile(file, JSON.stringify(vendor === "codex" ? { fetched_at: fetched.toISOString(), models: ids.map((slug) => ({ slug })) } : { fetchedAt: fetched.getTime(), catalog: { config: { models: ids.map((id) => ({ id })) } } }));
    let store = await HeadroomStore.open(join(home, "store"));
    const accounts: ProviderAccount[] = ["synthetic-a", "synthetic-b"].map((name) => ({ name, vendor, location: home, adapter: "native-ts" }));
    try {
      await write(["synthetic-base", "synthetic-old"]);
      await checkModelAvailability(store, accounts, { now: () => start });
      fetched = new Date(start.getTime() + MODEL_CHECK_INTERVAL_MS);
      await write(["synthetic-base"]);
      for (let hour = 1; hour <= 4; hour++) {
        await checkModelAvailability(store, accounts, { now: () => new Date(start.getTime() + hour * MODEL_CHECK_INTERVAL_MS) });
        if (hour === 2) { store.close(); store = await HeadroomStore.open(join(home, "store")); }
      }
      expect(accounts.map((account) => store.daemonState(`model_missing:${account.name}:synthetic-old`))).toEqual(["1", "1"]);
      expect(store.knownModels().every((row) => row.retired_at === null)).toBe(true);
      for (let hour = 5; hour <= 6; hour++) {
        fetched = new Date(start.getTime() + hour * MODEL_CHECK_INTERVAL_MS);
        await write(["synthetic-base"]);
        await checkModelAvailability(store, accounts, { now: () => fetched });
      }
      expect(store.knownModels().filter((row) => row.retired_at !== null)).toHaveLength(2);
    } finally { store.close(); }
  });
});
