/**
 * Readers for the "model available" feature (issue: Headroom said nothing
 * when a vendor added a new model to an account that shares an existing
 * quota pool). This is deliberately separate from `model_new` (store.ts's
 * `newBucketName`), which only fires when a vendor reports a whole new
 * *meter*: a model can appear inside an account's existing shared pool with
 * no new meter at all, and this is the source of truth for that case.
 *
 * Every reader here is read-only and uses a source Headroom already has
 * access to for its ordinary quota poll -- no new credential, no new
 * consent, no new vendor endpoint Headroom does not already call for some
 * other principal:
 *  - Codex: the CLI's own local model-list cache file under `$CODEX_HOME`
 *    (`models_cache.json`), refreshed by ordinary `codex` use. No network
 *    call at all.
 *  - Claude: Claude Code's own local model-catalog cache under the config
 *    dir (`cache/model-catalog/*.json`), one file per token the CLI has
 *    used; the newest by `fetchedAt` wins. No network call at all.
 *  - Antigravity (opt-in, `antigravity_model_catalog = true` in policy.toml):
 *    `cloudcode-pa.googleapis.com`'s `fetchAvailableModels`, authenticated
 *    with the Gemini CLI's own OAuth file (`~/.gemini/oauth_creds.json`).
 *    That is a different credential from the one agy uses for quota, so it is
 *    off by default and nothing here opens that file unless the caller opts in.
 *
 * A vendor with no available source (Claude with no catalog cache yet,
 * Codex with no `models_cache.json`) is reported as `undefined`, never an
 * empty list -- an empty list would look, to `HeadroomStore.recordModelCatalog`,
 * like every previously known model just got retired.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { vendorHome } from "./paths.js";
import { vendorJson } from "./limits.js";
import {
  defaultCredentialPaths, discoverGeminiOAuthClient, loadCodeAssist,
  modelsFromAvailableModels, postAvailableModels, readCredential, refreshCredential, resolveProjectId,
  secureRead as secureCredentialRead, type CodeAssistDependencies,
} from "./adapters/google-code-assist.js";
import { isAccountEnabled, type ProviderAccount } from "./types.js";
import type { HeadroomStore } from "./store.js";

export interface CatalogModel { id: string; name: string | null; }

const OBJECT = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A local catalog that has not been refreshed in a day is not evidence that
 * a model remains available now. The vendor clients refresh these caches in
 * normal use, so treating an older (or invalid/future) timestamp as
 * unavailable is safer than announcing stale entries as new availability. */
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
const MODEL_CATALOG_CLOCK_SKEW_MS = 5 * 60_000;

function freshCatalogTimestamp(value: unknown, now: Date): boolean {
  const at = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(at) && at <= now.getTime() + MODEL_CATALOG_CLOCK_SKEW_MS && now.getTime() - at <= MODEL_CATALOG_MAX_AGE_MS;
}

async function readRegularFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
  return readFile(path, "utf8");
}

/**
 * Codex CLI's own local model-list cache, `$CODEX_HOME/models_cache.json`
 * (a non-secret file the CLI refreshes on ordinary use; it carries no
 * token, no account id beyond an opaque hashed `identity`, and lives beside
 * `auth.json`, never inside it). Shape: `{ models: [{ slug, display_name,
 * visibility, ... }] }`. `visibility: "hide"` entries (internal test/review
 * models CodexBar itself never lists) are excluded.
 */
export async function readCodexModelCatalog(codexHome: string, readFileFn: (path: string) => Promise<string> = readRegularFile, now = new Date()): Promise<CatalogModel[] | undefined> {
  let text: string;
  try { text = await readFileFn(join(codexHome, "models_cache.json")); }
  catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!OBJECT(parsed) || !freshCatalogTimestamp(parsed.fetched_at, now) || !Array.isArray(parsed.models)) return undefined;
  return parsed.models.flatMap((entry): CatalogModel[] => {
    if (!OBJECT(entry) || typeof entry.slug !== "string" || !entry.slug.trim()) return [];
    if (entry.visibility === "hide") return [];
    const name = typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : null;
    return [{ id: entry.slug.trim(), name }];
  });
}

interface ModelCatalogFile { fetchedAt?: number; catalog?: { config?: { models?: unknown } }; }

/**
 * Claude Code's own local model catalog, cached per token under
 * `<configDir>/cache/model-catalog/*.json`. A profile accumulates one file
 * per token the CLI has used (the OAuth access token rotates on refresh);
 * every file under one config dir belongs to the same principal, so this
 * reads the newest by `fetchedAt` rather than trying to reproduce whatever
 * hash the CLI derives from the current token. Shape: `{ fetchedAt,
 * catalog: { config: { models: [{ id, name }] } } }`.
 */
export async function readClaudeModelCatalog(configDir: string, readDir: (path: string) => Promise<string[]> = async (path) => readdir(path), readFileFn: (path: string) => Promise<string> = readRegularFile, now = new Date()): Promise<CatalogModel[] | undefined> {
  const directory = join(configDir, "cache", "model-catalog");
  let names: string[];
  try { names = await readDir(directory); } catch { return undefined; }
  const files: ModelCatalogFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(await readFileFn(join(directory, name)));
      if (OBJECT(parsed) && freshCatalogTimestamp(parsed.fetchedAt, now)) files.push(parsed as ModelCatalogFile);
    } catch { /* one unreadable or malformed cache file must not fail the whole read */ }
  }
  if (!files.length) return undefined;
  const newest = files.sort((left, right) => (right.fetchedAt ?? 0) - (left.fetchedAt ?? 0))[0];
  const models = newest.catalog?.config?.models;
  if (!Array.isArray(models)) return undefined;
  return models.flatMap((entry): CatalogModel[] => {
    if (!OBJECT(entry) || typeof entry.id !== "string" || !entry.id.trim()) return [];
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
    return [{ id: entry.id.trim(), name }];
  });
}

/**
 * Antigravity's `fetchAvailableModels`, via the exact credential/project-id
 * resolution `observeAntigravity` already performs for
 * `loadCodeAssist`/`retrieveUserQuota` on the same host. Returns `undefined`
 * (never throws, never blocks a caller's quota poll) on anything short of a
 * successful parsed response: no credentials, an expired token this call
 * chose not to refresh-and-persist anywhere, no Code Assist project, or a
 * non-2xx response.
 */
export async function fetchAntigravityModelCatalog(dependencies: CodeAssistDependencies = {}): Promise<CatalogModel[] | undefined> {
  try {
    const now = dependencies.now?.() ?? new Date();
    const fetcher = dependencies.fetch ?? fetch;
    const stored = await readCredential(dependencies.credentialPaths?.() ?? defaultCredentialPaths(), dependencies.readFile ?? secureCredentialRead, now);
    const credentials = await refreshCredential(fetcher, stored, dependencies.oauthClient ?? discoverGeminiOAuthClient);
    const codeAssist = await loadCodeAssist(fetcher, credentials.token, { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }, "antigravity");
    const projectId = resolveProjectId(credentials.projectId, codeAssist);
    if (!projectId) return undefined;
    const response = await postAvailableModels(fetcher, credentials.token, projectId, "antigravity");
    if (!response.ok) return undefined;
    return modelsFromAvailableModels(await vendorJson(response));
  } catch {
    // Never surfaced: a model-list miss must never fail a quota poll.
    return undefined;
  }
}

export interface ModelAvailabilityDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  readCodexModelCatalog?: typeof readCodexModelCatalog;
  readClaudeModelCatalog?: typeof readClaudeModelCatalog;
  fetchAntigravityModelCatalog?: typeof fetchAntigravityModelCatalog;
  /** `policy.antigravity_model_catalog`. Absent or false: Antigravity
   * principals are skipped before any file read or network call. */
  antigravityModelCatalog?: boolean;
}

/** Model lists change rarely; this is checked independently of the ordinary
 * (as low as one-minute) quota poll interval so it never adds vendor load
 * to that faster loop. */
export const MODEL_CHECK_INTERVAL_MS = 60 * 60_000;

function daemonStateKey(principalId: string): string { return `model_check:${principalId}`; }

async function catalogFor(account: ProviderAccount, dependencies: ModelAvailabilityDependencies, now: Date): Promise<CatalogModel[] | undefined> {
  if (account.vendor === "codex") return (dependencies.readCodexModelCatalog ?? readCodexModelCatalog)(resolve(account.location || vendorHome("codex")), undefined, now);
  if (account.vendor === "claude") return (dependencies.readClaudeModelCatalog ?? readClaudeModelCatalog)(resolve(account.location || vendorHome("claude")), undefined, undefined, now);
  if (account.vendor === "antigravity") return (dependencies.fetchAntigravityModelCatalog ?? fetchAntigravityModelCatalog)({ now: dependencies.now, fetch: dependencies.fetch });
  return undefined;
}

/**
 * Checks every codex/claude/antigravity principal's model catalog against
 * `known_models`, at most once per `MODEL_CHECK_INTERVAL_MS` per principal
 * (tracked in `daemon_state`, so a restart does not reset the throttle).
 * Never throws: one vendor's read failing must never stop the others, and
 * must never fail whatever ordinary quota poll this was piggybacked onto.
 */
export async function checkModelAvailability(store: HeadroomStore, accounts: readonly ProviderAccount[], dependencies: ModelAvailabilityDependencies = {}): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  for (const account of accounts) {
    // This is the credential and cache-read boundary. Callers filter too,
    // but this guard makes a parked principal safe even for a new caller.
    if (!isAccountEnabled(account)) continue;
    if (account.vendor !== "codex" && account.vendor !== "claude" && account.vendor !== "antigravity") continue;
    // Opt-in only: the Antigravity catalog call reads the Gemini CLI's OAuth
    // file, so without explicit consent it is skipped before the claim below.
    if (account.vendor === "antigravity" && dependencies.antigravityModelCatalog !== true) continue;
    const key = daemonStateKey(account.name);
    // Claim before the reader's first await. This is a BEGIN IMMEDIATE
    // transaction in the store, so overlapping daemon polls and direct CLI
    // processes cannot all decide that the same hourly check is due.
    if (!store.claimDaemonInterval(key, now, MODEL_CHECK_INTERVAL_MS)) continue;
    try {
      const models = await catalogFor(account, dependencies, now);
      if (models === undefined) continue;
      store.recordModelCatalog(account.name, account.vendor, models, now);
    } catch { /* The pre-I/O claim remains: a broken source is not retried every poll. */ }
  }
}
