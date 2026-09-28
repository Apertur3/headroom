import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(models).toEqual([{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }]);
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
    expect(models).toEqual([{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }]);
  });

  it("skips one malformed cache file rather than failing the whole read", async () => {
    const configDir = await tempDir("headroom-claude-models-partial-");
    const catalogDir = join(configDir, "cache", "model-catalog");
    const at = new Date("2026-09-23T18:00:00Z");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "broken.json"), "{not json");
    await writeFile(join(catalogDir, "good.json"), JSON.stringify({ fetchedAt: at.getTime(), catalog: { config: { models: [{ id: "claude-haiku-4-5", name: "Haiku 4.5" }] } } }));
    expect(await readClaudeModelCatalog(configDir, undefined, undefined, at)).toEqual([{ id: "claude-haiku-4-5", name: "Haiku 4.5" }]);
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
      const readCodex = vi.fn().mockResolvedValue([{ id: "gpt-6-astra", name: "GPT-6-Astra" }]);
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
      readCodex.mockResolvedValue([{ id: "gpt-6-astra", name: "GPT-6-Astra" }, { id: "gpt-6-sol", name: "GPT-6-Sol" }]);
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
      const readCodex = vi.fn().mockResolvedValue([{ id: "gpt-6-astra", name: "GPT-6-Astra" }]);
      const readClaude = vi.fn().mockResolvedValue([{ id: "claude-sonnet-5", name: "Sonnet 5" }]);
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
      ], { readCodexModelCatalog: readCodex, readClaudeModelCatalog: readClaude, fetchAntigravityModelCatalog: fetchAntigravity });
      expect(readCodex).toHaveBeenCalledWith("/tmp/codex-live", undefined, expect.any(Date));
      expect(readClaude).toHaveBeenCalledWith("/tmp/claude-live", undefined, undefined, expect.any(Date));
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
      let release: ((models: { id: string; name: string }[]) => void) | undefined;
      const readCodex = vi.fn(() => new Promise<{ id: string; name: string }[]>((resolve) => { release = resolve; }));
      const accounts = [account("codex-main", "codex")];
      const first = checkModelAvailability(store, accounts, { now: () => at, readCodexModelCatalog: readCodex });
      await Promise.resolve();
      await checkModelAvailability(store, accounts, { now: () => at, readCodexModelCatalog: readCodex });
      expect(readCodex).toHaveBeenCalledTimes(1);
      release?.([{ id: "gpt-6-astra", name: "GPT-6-Astra" }]);
      await first;
    } finally { store.close(); }
  });
});
