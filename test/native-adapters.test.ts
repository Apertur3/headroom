import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeResponseShape, claudeServiceName, observationsFromClaudeUsage, observeClaude } from "../src/adapters/claude.js";
import { codexResponseShape, observationsFromCodexRateLimitEvents, observationsFromCodexUsage, observeCodex, readCodexRateLimitEvents } from "../src/adapters/codex.js";

const claude = { name: "claude-main", vendor: "claude", location: "/Users/test/.claude", adapter: "native-ts" } as const;
const codex = { name: "codex-main", vendor: "codex", location: "/Users/test/.codex", adapter: "native-ts" } as const;
const at = new Date("2026-09-03T17:26:36Z");

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
    const output = JSON.stringify([claudeRows, codexRows, log.mock.calls]);
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
    expect(expiredClaude[0].reason).toBe("token expired; run: CLAUDE_CONFIG_DIR=/Users/test/.claude2 claude");
    expect(missingClaude[0].reason).toBe("no credentials in Keychain for this config dir; run: CLAUDE_CONFIG_DIR=/Users/test/.claude2 claude");
    expect(expiredCodex[0].reason).toBe("token expired; run: CODEX_HOME=/Users/test/.codex2 codex login");
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
