import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { claudeServiceName, observationsFromClaudeUsage, observeClaude } from "../src/adapters/claude.js";
import { observationsFromCodexUsage, observeCodex } from "../src/adapters/codex.js";

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
      expect.objectContaining({ meter_id: "codex-main:credits", quantity: { used: 0, limit: 1, remaining: 1, unit: "credits" }, resets_at: "2026-09-08T17:23:00Z" }),
    ]));
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
});
