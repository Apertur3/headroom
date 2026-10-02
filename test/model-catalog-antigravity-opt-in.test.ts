import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap the two calls the Gemini OAuth file read goes through (secureRead:
// lstat, then readFile) so the test can prove that file is never opened.
const fsCalls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const record = (path: unknown) => { fsCalls.paths.push(String(path)); };
  return {
    ...actual,
    lstat: ((path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => { record(path); return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest); }) as typeof actual.lstat,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => { record(path); return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest); }) as typeof actual.readFile,
  };
});

import { checkModelAvailability } from "../src/model-catalog.js";
import { defaultPolicy, parsePolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fsCalls.paths.length = 0;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const antigravity: ProviderAccount = { name: "antigravity", vendor: "antigravity", location: "agy", adapter: "native-ts" };

/** A fake home holding a Gemini CLI OAuth file, so a read of it would succeed
 * and lead to a network call if the opt-in gate were missing. */
async function fakeHomeWithGeminiCredential(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "headroom-agy-catalog-optin-"));
  temporary.push(home);
  await mkdir(join(home, ".gemini"), { recursive: true });
  const file = join(home, ".gemini", "oauth_creds.json");
  await writeFile(file, JSON.stringify({ access_token: "not-a-secret", expiry_date: Date.now() + 86_400_000, project: "synthetic-project" }), { mode: 0o600 });
  await chmod(file, 0o600);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function catalogFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ models: { "synthetic-model": { displayName: "Synthetic Model" } } })));
}

const geminiFileReads = () => fsCalls.paths.filter((path) => path.includes("oauth_creds.json"));

describe("Antigravity model catalog opt-in", () => {
  it("is off by default in policy and parses an explicit opt-in", () => {
    expect(defaultPolicy.antigravity_model_catalog).toBe(false);
    expect(parsePolicy("").antigravity_model_catalog).toBe(false);
    expect(parsePolicy("antigravity_model_catalog = true\n").antigravity_model_catalog).toBe(true);
    expect(parsePolicy("antigravity_model_catalog = false\n").antigravity_model_catalog).toBe(false);
  });

  it("never opens the Gemini OAuth file or calls Google when the opt-in is absent or false", async () => {
    const home = await fakeHomeWithGeminiCredential();
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const fetch = catalogFetch();
      await checkModelAvailability(store, [antigravity], { fetch });
      await checkModelAvailability(store, [antigravity], { fetch, antigravityModelCatalog: false });
      expect(geminiFileReads()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(store.knownModels("antigravity")).toEqual([]);
    } finally { store.close(); }
  });

  it("reads the Gemini OAuth file and calls fetchAvailableModels only after an explicit opt-in", async () => {
    const home = await fakeHomeWithGeminiCredential();
    const store = await HeadroomStore.open(join(home, ".headroom"));
    try {
      const fetch = catalogFetch();
      await checkModelAvailability(store, [antigravity], { fetch, antigravityModelCatalog: true });
      expect(geminiFileReads().length).toBeGreaterThan(0);
      const urls = fetch.mock.calls.map(([request]) => (request as unknown as Request).url);
      expect(urls).toContain("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
      expect(store.knownModels("antigravity")).toHaveLength(1);
    } finally { store.close(); }
  });
});
