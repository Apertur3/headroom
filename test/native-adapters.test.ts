import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeProbeError, claudeGrantGate, claudeGrantNeededObservations, claudeGrantNeededReason,
  claudeResponseShape, claudeServiceName, observationsFromClaudeUsage, observeClaude, syncClaudeGrantState,
} from "../src/adapters/claude.js";
import { codexResponseShape, observationsFromCodexRateLimitEvents, observationsFromCodexUsage, observeCodex, readCodexRateLimitEvents } from "../src/adapters/codex.js";
import { observationsFromAntigravityQuota, observeAntigravity, parseAntigravityCredential } from "../src/adapters/antigravity.js";
import { PROTECTED_STATUS_PATTERN } from "../src/collector.js";

const claude = { name: "claude-main", vendor: "claude", location: "/Users/test/.claude", adapter: "native-ts" } as const;
const codex = { name: "codex-main", vendor: "codex", location: "/Users/test/.codex", adapter: "native-ts" } as const;
const antigravity = { name: "antigravity", vendor: "antigravity", location: "/Users/test/.gemini/antigravity-cli", adapter: "native-ts" } as const;
const at = new Date("2026-09-03T17:26:36Z");
// The adapters build their "run: CLAUDE_CONFIG_DIR=... claude" / "run:
// CODEX_HOME=... codex login" reason text from resolve(account.location):
// on Windows, resolve() of this POSIX-looking fixture path comes back
// drive-relative with backslashes (there is no real Windows equivalent of
// "/Users/test/.claude2" -- it is just a fixed fixture, not a simulated
// platform path). Building the expectation through the same resolve() call
// keeps the assertion correct on every platform instead of hardcoding the
// forward-slash form.
const claude2Dir = resolve("/Users/test/.claude2");
const codex2Dir = resolve("/Users/test/.codex2");

describe("native TypeScript adapter conformance (synthetic until recorder capture)", () => {
  it("ports Claude usage windows and its scoped not-enforced semantics", async () => {
    const body = JSON.parse(await readFile(new URL("../fixtures/http/claude/usage.synthetic.json", import.meta.url), "utf8"));
    const rows = observationsFromClaudeUsage(body, claude, at);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ unit: "percent", used: 12 }), source: "native:claude" }),
      expect.objectContaining({ meter_id: "claude-main:all", window: expect.objectContaining({ minutes: 10_080 }), quantity: expect.objectContaining({ used: 66 }) }),
      expect.objectContaining({ meter_id: "claude-main:fable", freshness: "not_enforced", reason: "vendor marks scoped limit inactive" }),
      expect.objectContaining({ meter_id: "claude-main:routines", freshness: "not_enforced", reason: "no scoped limit in response" }),
    ]));
  });

  it("ports Codex main, Spark, and reset-credit windows with the native fixture units", async () => {
    const [usage, credits] = await Promise.all(["usage.synthetic.json", "rate-limit-reset-credits.synthetic.json"].map(async (name) => JSON.parse(await readFile(new URL(`../fixtures/http/codex/${name}`, import.meta.url), "utf8"))));
    const rows = observationsFromCodexUsage(usage, credits, codex, at);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "codex-main:main", freshness: "not_enforced", window: { kind: "rolling", minutes: 300, enforcement: "hard" } }),
      expect.objectContaining({ meter_id: "codex-main:main", window: expect.objectContaining({ minutes: 10_080 }), quantity: expect.objectContaining({ unit: "percent", used: 16 }), source: "native:codex" }),
      expect.objectContaining({ meter_id: "codex-main:spark", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 8 }) }),
      expect.objectContaining({ meter_id: "codex-main:credits", window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: 1, unit: "credits" }, resets_at: "2026-09-08T17:23:00Z" }),
    ]));
  });

  it("maps verified Antigravity quota buckets to the two 5-hour and weekly meters", async () => {
    const body = JSON.parse(await readFile(new URL("../fixtures/http/antigravity/retrieve-user-quota.synthetic.json", import.meta.url), "utf8"));
    const rows = observationsFromAntigravityQuota(body, antigravity, at);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "antigravity:gemini", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 24, limit: 100, remaining: 76, unit: "percent" }, source: "remote:antigravity" }),
      expect.objectContaining({ meter_id: "antigravity:gemini", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: { used: 66, limit: 100, remaining: 34, unit: "percent" } }),
      expect.objectContaining({ meter_id: "antigravity:claude-gpt", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 19, limit: 100, remaining: 81, unit: "percent" } }),
      expect.objectContaining({ meter_id: "antigravity:claude-gpt", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: { used: 58, limit: 100, remaining: 42, unit: "percent" } }),
    ]));
  });

  it("normalizes a synthetic-reset quota snapshot with the shared placeholder rule", () => {
    const at = new Date("2026-09-03T17:26:36Z");
    const rows = observationsFromAntigravityQuota({ buckets: [
      { modelId: "gemini-5-hour", remainingFraction: 1, resetTime: "2026-09-03T22:26:36Z" },
      { modelId: "gemini-weekly", remainingFraction: 1, resetTime: "2026-09-10T17:26:36Z" },
      { modelId: "claude-gpt-5-hour", remainingFraction: 1, resetTime: "2026-09-03T22:26:36Z" },
      { modelId: "claude-gpt-weekly", remainingFraction: 1, resetTime: "2026-09-10T17:26:36Z" },
    ] }, antigravity, at);
    expect(rows.filter((row) => row.meter_id === "antigravity:gemini")).toEqual(expect.arrayContaining([
      expect.objectContaining({ freshness: "failed", reason: "availability-only payload; quota summary not served" }),
    ]));
  });

  it("rejects an availability-only Antigravity quota answer without treating model availability as quota", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ buckets: [] })));
    const rows = await observeAntigravity(antigravity, {
      now: () => at,
      credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-03T18:26:36Z" }),
      fetch,
    });
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ freshness: "failed", reason: "quota endpoint returned availability only", quantity: null })]));
    const requests = fetch.mock.calls.map(([request]) => request as Request);
    expect(requests.map((request) => request.url)).toEqual([
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ]);
    expect(requests[0].headers.get("User-Agent")).toBe("antigravity");
    expect(requests[0].headers.get("x-goog-api-client")).toBeNull();
    expect(await requests[0].text()).toBe("{}");
  });

  it("preserves a redacted Google Code Assist refusal reason", async () => {
    const rows = await observeAntigravity(antigravity, {
      now: () => at,
      credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-03T18:26:36Z" }),
      fetch: async () => new Response(JSON.stringify({ error: { reasonCode: "UNSUPPORTED_CLIENT", message: "Gemini Code Assist for individuals is no longer supported for person@example.com; Bearer eyJ.not-a-token" } }), { status: 403 }),
    });
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ freshness: "failed", reason: "HTTP 403 UNSUPPORTED_CLIENT: Gemini Code Assist for individuals is no longer supported for [REDACTED]; [REDACTED]" })]));
  });

  it("recognizes a 429 Antigravity refusal as a protected status the same way a 401/403 one is", async () => {
    const rows = await observeAntigravity(antigravity, {
      now: () => at,
      credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-03T18:26:36Z" }),
      fetch: async () => new Response(JSON.stringify({ error: { reasonCode: "RATE_LIMITED", message: "too many requests" } }), { status: 429 }),
    });
    const failed = rows.find((row) => row.freshness === "failed");
    expect(failed?.reason).toMatch(/^HTTP 429\b/);
    // The exact bug this regresses: collector.ts's/daemon.ts's backoff
    // detection previously only matched a parenthesized "(429)" (the shape
    // ProviderHTTPError produces for Claude/Codex), never Google's own bare
    // "HTTP 429" wording, so an Antigravity rate limit was silently retried.
    expect(PROTECTED_STATUS_PATTERN.test(failed?.reason ?? "")).toBe(true);
  });

  it("still recognizes the parenthesized status format other vendor adapters use", () => {
    expect(PROTECTED_STATUS_PATTERN.test("Claude usage request failed (401)")).toBe(true);
    expect(PROTECTED_STATUS_PATTERN.test("Codex usage request failed (429)")).toBe(true);
    expect(PROTECTED_STATUS_PATTERN.test("no credentials in Keychain for this config dir")).toBe(false);
  });

  it("refreshes expired Gemini CLI OAuth in memory before posting quota", async () => {
    const quota = await readFile(new URL("../fixtures/http/antigravity/retrieve-user-quota.synthetic.json", import.meta.url), "utf8");
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }))).mockResolvedValueOnce(new Response(quota));
    const rows = await observeAntigravity(antigravity, {
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "old-access", refresh_token: "refresh-only", expiry_date: at.getTime() - 1 }),
      oauthClient: async () => ({ clientId: "test-client.apps.googleusercontent.com", clientSecret: "test-client-secret" }), fetch,
    });
    expect(rows).toContainEqual(expect.objectContaining({ freshness: "fresh", source: "remote:antigravity" }));
    const requests = fetch.mock.calls.map(([request]) => request as Request);
    expect(requests.map((request) => request.url)).toEqual(["https://oauth2.googleapis.com/token", "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"]);
    expect(await requests[0].text()).toContain("grant_type=refresh_token");
    expect(requests[1].headers.get("Authorization")).toBe("Bearer new-access");
  });

  it("always emits a main weekly row so a missing vendor field replaces prior data", () => {
    const rows = observationsFromCodexUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_788_802_800 } } }, {}, codex, at);
    expect(rows).toContainEqual(expect.objectContaining({ meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, freshness: "failed", reason: "vendor returned no weekly window" }));
  });

  it("maps the recorded primary and secondary response shape after the upstream field rename", async () => {
    const usage = JSON.parse(await readFile(new URL("../fixtures/http/codex/usage.real.redacted.json", import.meta.url), "utf8"));
    const rows = observationsFromCodexUsage(usage, {}, codex, at);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "codex-main:main", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 42 }) }),
      expect.objectContaining({ meter_id: "codex-main:main", window: expect.objectContaining({ minutes: 10_080 }), quantity: expect.objectContaining({ used: 23 }) }),
    ]));
  });

  it("falls back to the most recent recorded session rate-limit event and marks old evidence stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-log-"));
    try {
      await mkdir(join(root, "sessions"));
      await writeFile(join(root, "sessions", "rollout.jsonl"), await readFile(new URL("../fixtures/codex/session-rate-limit.real.redacted.jsonl", import.meta.url), "utf8"));
      const events = await readCodexRateLimitEvents(root);
      expect(events).toHaveLength(1);
      const fresh = observationsFromCodexRateLimitEvents(events, codex, new Date("2026-09-03T15:05:00Z"));
      expect(fresh).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "native:codex:session-log", truth: "official", freshness: "fresh", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 100 }) }),
        expect.objectContaining({ source: "native:codex:session-log", truth: "official", freshness: "fresh", window: expect.objectContaining({ minutes: 10_080 }) }),
      ]));
      expect(observationsFromCodexRateLimitEvents(events, codex, at)).toContainEqual(expect.objectContaining({ freshness: "stale", window: expect.objectContaining({ minutes: 300 }) }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("selects the newest event across the 20 newest session files and maps window_minutes 300 to 5h", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-codex-20-logs-"));
    try {
      await mkdir(join(root, "sessions"));
      for (let index = 0; index < 21; index += 1) {
        const timestamp = index === 20 ? "2026-09-03T23:59:00Z" : `2026-09-03T${String(index).padStart(2, "0")}:00:00Z`;
        const path = join(root, "sessions", `${String(index).padStart(2, "0")}.jsonl`);
        await writeFile(path, `${JSON.stringify({ timestamp, payload: { rate_limits: { primary: { used_percent: index, window_minutes: 300 } } } })}\n`);
        await utimes(path, new Date("2026-09-03T00:00:00Z"), new Date(`2026-09-03T${index === 20 ? "00" : String(index + 1).padStart(2, "0")}:00:00Z`));
      }
      const events = await readCodexRateLimitEvents(root);
      const rows = observationsFromCodexRateLimitEvents(events, codex, new Date("2026-09-03T19:30:00Z"));
      expect(rows).toEqual([expect.objectContaining({ window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 19 }) })]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses session evidence before calling a missing primary window not enforced", async () => {
    const session = [{ timestamp: "2026-09-03T17:25:00Z", primary: { used_percent: 100, window_minutes: 300, resets_at: 1788803040 } }];
    const usage = { rate_limit: { secondary: { used_percent: 23, window_minutes: 10_080, resets_at: 1789407600 } } };
    const rows = await observeCodex(codex, {
      now: () => at,
      readFile: async () => JSON.stringify({ tokens: { access_token: "not-a-secret", expires_at: at.getTime() + 60_000 } }),
      readRateLimitEvents: async () => session,
      fetch: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usage))).mockResolvedValueOnce(new Response("{}")),
    });
    expect(rows).toContainEqual(expect.objectContaining({ meter_id: "codex-main:main", source: "native:codex:session-log", truth: "official", quantity: expect.objectContaining({ used: 100 }), freshness: "fresh" }));
  });

  it("never lets the session-log fallback override a weekly window the endpoint already provided", async () => {
    // The exact live defect: an old session-log event (here also carrying a
    // weekly reading) must not eclipse a perfectly good, fresher weekly
    // reading from the live endpoint just because the endpoint is polled
    // again later than the session log's own timestamp.
    const session = [{ timestamp: "2026-09-03T07:31:04Z", primary: { used_percent: 100, window_minutes: 300, resets_at: 1788803040 }, secondary: { used_percent: 41, window_minutes: 10_080, resets_at: 1789407600 } }];
    const usage = { rate_limit: { secondary: { used_percent: 83, window_minutes: 10_080, resets_at: 1789407600 } } };
    const rows = await observeCodex(codex, {
      now: () => at,
      readFile: async () => JSON.stringify({ tokens: { access_token: "not-a-secret", expires_at: at.getTime() + 60_000 } }),
      readRateLimitEvents: async () => session,
      fetch: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usage))).mockResolvedValueOnce(new Response("{}")),
    });
    const weekly = rows.find((row) => row.meter_id === "codex-main:main" && row.window?.minutes === 10_080);
    // The endpoint's own 83%, not the session log's stale 41%.
    expect(weekly).toMatchObject({ source: "native:codex", freshness: "fresh", quantity: expect.objectContaining({ used: 83 }) });
    expect(rows.some((row) => row.meter_id === "codex-main:main" && row.window?.minutes === 10_080 && row.source === "native:codex:session-log")).toBe(false);
    // The 5h window still legitimately falls back to the session log, since
    // the endpoint never reports one at all.
    expect(rows).toContainEqual(expect.objectContaining({ meter_id: "codex-main:main", window: expect.objectContaining({ minutes: 300 }), source: "native:codex:session-log", quantity: expect.objectContaining({ used: 100 }) }));
  });

  it("derives a session reset from its event timestamp and remaining seconds", () => {
    const rows = observationsFromCodexRateLimitEvents([{ timestamp: "2026-09-03T15:00:00Z", primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 600 } }], codex, new Date("2026-09-03T15:01:00Z"));
    expect(rows).toContainEqual(expect.objectContaining({ resets_at: "2026-09-03T15:10:00.000Z", window: expect.objectContaining({ minutes: 300 }) }));
  });

  it("does not leak a token from auth.json or Keychain JSON through rows, errors, or logs", async () => {
    const secret = "eyJ.fake-canary-token.never-log";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejectedFetch = async () => { throw new Error(secret); };
    const claudeRows = await observeClaude(claude, { platform: "darwin", now: () => at, keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: secret, expiresAt: at.getTime() + 60_000 } }), fetch: rejectedFetch });
    const codexRows = await observeCodex(codex, { now: () => at, readFile: async () => JSON.stringify({ tokens: { access_token: secret, expires_at: at.getTime() + 60_000 } }), fetch: rejectedFetch });
    const antigravityRows = await observeAntigravity(antigravity, { now: () => at, credentialPaths: () => ["gemini-oauth"], readFile: async () => JSON.stringify({ access_token: secret, expiry_date: "2026-09-03T18:26:36Z" }), fetch: rejectedFetch });
    const output = JSON.stringify([claudeRows, codexRows, antigravityRows, log.mock.calls]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("Bearer");
    log.mockRestore();
  });

  it("uses the config-scoped Keychain service rule", () => {
    expect(claudeServiceName("/Users/test/.claude", "/Users/test")).toBe("Claude Code-credentials");
    expect(claudeServiceName("/Users/test/.claude2", "/Users/test")).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
  });

  it("returns actionable per-config credential reasons", async () => {
    const claude2 = { ...claude, name: "claude-2", location: "/Users/test/.claude2" };
    const expiredClaude = await observeClaude(claude2, { platform: "darwin", now: () => at, keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: at.getTime() - 1 } }) });
    const missingClaude = await observeClaude(claude2, { platform: "darwin", now: () => at, keychain: async () => { throw new Error("missing"); } });
    const codex2 = { ...codex, location: "/Users/test/.codex2" };
    const expiredCodex = await observeCodex(codex2, { now: () => at, readFile: async () => JSON.stringify({ tokens: { access_token: "token", expires_at: at.getTime() - 1 } }) });
    const expiredAntigravity = await observeAntigravity(antigravity, { now: () => at, credentialPaths: () => ["gemini-oauth"], readFile: async () => JSON.stringify({ access_token: "token", expiry_date: "2026-09-03T17:26:35Z" }) });
    expect(expiredClaude[0].reason).toBe(`token expired; run: CLAUDE_CONFIG_DIR=${claude2Dir} claude`);
    expect(missingClaude[0].reason).toBe(`no credentials in Keychain for this config dir; run: CLAUDE_CONFIG_DIR=${claude2Dir} claude`);
    expect(expiredCodex[0].reason).toBe(`token expired; run: CODEX_HOME=${codex2Dir} codex login`);
    expect(expiredAntigravity[0].reason).toBe("token expired; run: gemini");
  });

  it("names the exact fix for a live 401/403 (a well-formed token the vendor rejected), not the bare status message", async () => {
    // A non-default config dir (as elsewhere in this file, .claude2/.codex2)
    // is the only portable way to assert the exact CLAUDE_CONFIG_DIR/CODEX_HOME
    // wording: the plain "run: claude"/"run: codex login" form only appears
    // when the fixture's path equals this machine's *real* home directory,
    // which a test cannot control without mocking os.homedir() itself.
    const claude2 = { ...claude, name: "claude-2", location: "/Users/test/.claude2" };
    const rejected401 = await observeClaude(claude2, { platform: "darwin", now: () => at, keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: at.getTime() + 60_000 } }), fetch: async () => new Response("{}", { status: 401 }) });
    const rejected403 = await observeClaude(claude2, { platform: "darwin", now: () => at, keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: at.getTime() + 60_000 } }), fetch: async () => new Response("{}", { status: 403 }) });
    expect(rejected401[0].reason).toBe(`Claude rejected the token (401); run: CLAUDE_CONFIG_DIR=${claude2Dir} claude`);
    expect(rejected403[0].reason).toBe(`Claude rejected the token (403); run: CLAUDE_CONFIG_DIR=${claude2Dir} claude`);

    const codex2 = { ...codex, location: "/Users/test/.codex2" };
    const codexRejected401 = await observeCodex(codex2, { now: () => at, readFile: async () => JSON.stringify({ tokens: { access_token: "token", expires_at: at.getTime() + 60_000 } }), fetch: async () => new Response("{}", { status: 401 }) });
    const codexRejected403 = await observeCodex(codex2, { now: () => at, readFile: async () => JSON.stringify({ tokens: { access_token: "token", expires_at: at.getTime() + 60_000 } }), fetch: async () => new Response("{}", { status: 403 }) });
    expect(codexRejected401[0].reason).toBe(`Codex rejected the token (401); run: CODEX_HOME=${codex2Dir} codex login`);
    expect(codexRejected403[0].reason).toBe(`Codex rejected the token (403); run: CODEX_HOME=${codex2Dir} codex login`);

    // The parenthesized status code -- collector.ts's shared backoff pattern --
    // must still match the new, friendlier wording.
    expect(PROTECTED_STATUS_PATTERN.test(rejected401[0].reason ?? "")).toBe(true);
    expect(PROTECTED_STATUS_PATTERN.test(codexRejected403[0].reason ?? "")).toBe(true);
  });

  it("accepts Gemini CLI's top-level JSON token as the fallback credential format", () => {
    expect(parseAntigravityCredential(JSON.stringify({ access_token: "token", expiry_date: at.getTime() + 60_000 }), at)).toMatchObject({ token: "token", expired: false });
  });

  it("does not mistake agy's session token record for Google OAuth", () => {
    expect(() => parseAntigravityCredential(JSON.stringify({ auth_method: "oauth", token: "not-google-oauth" }), at)).toThrow("Gemini CLI OAuth credentials invalid");
  });

  it("reports response paths and value kinds without response values", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: { primary: { used_percent: 73 } } }))).mockResolvedValueOnce(new Response(JSON.stringify({ available_count: 1 })));
    const codexShape = await codexResponseShape(codex, { now: () => at, readFile: async () => JSON.stringify({ tokens: { access_token: "token", expires_at: at.getTime() + 60_000 } }), fetch });
    const claudeShape = await claudeResponseShape(claude, { platform: "darwin", now: () => at, keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: at.getTime() + 60_000 } }), fetch: async () => new Response(JSON.stringify({ five_hour: { utilization: 12 } })) });
    expect(codexShape.usage).toContainEqual({ path: "$.rate_limit.primary.used_percent", kind: "number" });
    expect(claudeShape).toContainEqual({ path: "$.five_hour.utilization", kind: "number" });
    expect(JSON.stringify(codexShape)).not.toContain("73");
  });
});

function fakeGrantStore() {
  const grants = new Map<string, string>();
  let hash: string | undefined;
  let grantedHash: string | undefined;
  return {
    keychainGrantNeeded: (id: string) => grants.has(id),
    setKeychainGrantNeeded: (id: string, reason: string) => { grants.set(id, reason); },
    probeBinaryHash: () => hash,
    setProbeBinaryHash: (value: string) => { hash = value; },
    probeGrantedHash: () => grantedHash,
    setProbeGrantedHash: (value: string) => { grantedHash = value; },
    grants,
  };
}

describe("Claude Keychain grant gate", () => {
  it("maps a probe denial or timeout to the same actionable reason, without a raw Keychain message", async () => {
    const denied = await observeClaude(claude, { platform: "darwin", now: () => at, probe: async () => { throw new ClaudeProbeError("denied", "Keychain access denied"); } });
    const timedOut = await observeClaude(claude, { platform: "darwin", now: () => at, probe: async () => { throw new ClaudeProbeError("timeout", "Keychain access timed out"); } });
    expect(denied[0].reason).toBe(claudeGrantNeededReason("claude-main"));
    expect(timedOut[0].reason).toBe(claudeGrantNeededReason("claude-main"));
    expect(denied.every((row) => row.freshness === "failed")).toBe(true);
    expect(denied[0].reason).toBe("Keychain grant needed; run: headroom keychain grant --principal claude-main");
  });

  it("builds synthetic gate-blocked observations without ever attempting the probe", () => {
    const rows = claudeGrantNeededObservations(claude, at);
    expect(rows.map((row) => row.meter_id)).toEqual(["claude-main:all", "claude-main:fable", "claude-main:routines"]);
    expect(rows.every((row) => row.freshness === "failed" && row.reason === claudeGrantNeededReason("claude-main"))).toBe(true);
  });

  it("wires a store into a needsGrant/markGrantNeeded gate", () => {
    const store = fakeGrantStore();
    const gate = claudeGrantGate(store);
    expect(gate.needsGrant("claude-main")).toBe(false);
    gate.markGrantNeeded("claude-main", "Keychain access denied");
    expect(gate.needsGrant("claude-main")).toBe(true);
    expect(store.grants.get("claude-main")).toBe("Keychain access denied");
  });

  it("marks every Claude principal on a first-ever sync, with no prior successful probe or grant", async () => {
    const store = fakeGrantStore();
    // A fresh install (or a rebuilt probe) must only ever pop its first
    // Keychain dialog through `headroom keychain grant`, never a background
    // daemon poll -- so the very first sync, with nothing recorded yet, marks
    // every given principal instead of trusting an unproven binary.
    await expect(syncClaudeGrantState(store, ["claude-main", "claude-2"], { platform: "darwin", hash: async () => "hash-a" })).resolves.toBe(true);
    expect([...store.grants.keys()].sort()).toEqual(["claude-2", "claude-main"]);
    expect(store.probeBinaryHash()).toBe("hash-a");
  });

  it("does not re-mark an unchanged hash, and does mark every principal again on a rebuild", async () => {
    const store = fakeGrantStore();
    await syncClaudeGrantState(store, ["claude-main"], { platform: "darwin", hash: async () => "hash-a" });
    store.grants.clear(); // simulate the operator clearing it via `headroom keychain grant`
    // The same hash again, with nothing else changed, is not re-marked.
    await expect(syncClaudeGrantState(store, ["claude-main", "claude-2"], { platform: "darwin", hash: async () => "hash-a" })).resolves.toBe(false);
    expect(store.grants.size).toBe(0);
    // A different hash is a rebuild: every given principal is marked, in one pass.
    await expect(syncClaudeGrantState(store, ["claude-main", "claude-2"], { platform: "darwin", hash: async () => "hash-b" })).resolves.toBe(true);
    expect([...store.grants.keys()].sort()).toEqual(["claude-2", "claude-main"]);
    expect(store.probeBinaryHash()).toBe("hash-b");
  });

  it("does not mark a first-ever sync when this exact hash already succeeded once", async () => {
    const store = fakeGrantStore();
    // A successful `headroom keychain grant` (or a successful poll) recorded
    // this hash as granted; probeBinaryHash itself may be absent (e.g. a
    // restored store), but the sync must still recognize the binary.
    store.setProbeGrantedHash("hash-a");
    await expect(syncClaudeGrantState(store, ["claude-main"], { platform: "darwin", hash: async () => "hash-a" })).resolves.toBe(false);
    expect(store.grants.size).toBe(0);
    // A different (rebuilt) binary is unproven even though some other hash was granted before.
    await expect(syncClaudeGrantState(store, ["claude-main"], { platform: "darwin", hash: async () => "hash-b" })).resolves.toBe(true);
    expect(store.grants.get("claude-main")).toBe("probe binary rebuilt");
  });

  it("records a successful grant or a successful probe as the granted hash", () => {
    const store = fakeGrantStore();
    store.setProbeBinaryHash("hash-a");
    const gate = claudeGrantGate(store);
    expect(store.probeGrantedHash()).toBeUndefined();
    gate.markProbeSucceeded();
    expect(store.probeGrantedHash()).toBe("hash-a");
  });

  it("skips rebuild detection off macOS, with no probe binary, or with no Claude principals", async () => {
    const store = fakeGrantStore();
    await expect(syncClaudeGrantState(store, ["claude-main"], { platform: "linux", hash: async () => "hash-a" })).resolves.toBe(false);
    expect(store.probeBinaryHash()).toBeUndefined();
    await expect(syncClaudeGrantState(store, ["claude-main"], { platform: "darwin", hash: async () => undefined })).resolves.toBe(false);
    expect(store.probeBinaryHash()).toBeUndefined();
    await expect(syncClaudeGrantState(store, [], { platform: "darwin", hash: async () => "hash-a" })).resolves.toBe(false);
    expect(store.probeBinaryHash()).toBeUndefined();
  });
});
