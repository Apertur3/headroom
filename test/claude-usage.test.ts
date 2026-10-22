import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_USAGE_MIN_INTERVAL_MS, CLAUDE_USAGE_SOURCE, observeClaudeUsage } from "../src/adapters/claude-usage.js";
import { parseStatuslineSnapshot, reconcileSnapshot, snapshotFromStatuslinePayload } from "../src/adapters/claude-statusline.js";

const account = { name: "claude-work", vendor: "claude", location: "/nonexistent/.claude-work", adapter: "native-ts" } as const;
const at = new Date("2026-10-22T09:00:00Z");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const stampDir = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "headroom-usage-stamp-")); temporary.push(dir); return dir; };
const stream = (): Promise<string> => readFile(new URL("./fixtures/claude/usage-stream.synthetic.jsonl", import.meta.url), "utf8");

describe("claude /usage runner", () => {
  it("maps the usage_report to 5h, weekly and the Fable meter, with no shell and a scrubbed environment", async () => {
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    const run = vi.fn(async () => stream());
    try {
      const result = await observeClaudeUsage(account, { run, now: () => at, stampDir: await stampDir(), binary: "claude" });
      expect(result && "rows" in result).toBe(true);
      const rows = (result as { rows: { meter_id: string; source: string; freshness: string; quantity: { used: number } | null; window: { minutes: number | null } | null }[] }).rows;
      expect(rows.every((row) => row.source === CLAUDE_USAGE_SOURCE)).toBe(true);
      expect(rows).toContainEqual(expect.objectContaining({ meter_id: "claude-work:all", window: expect.objectContaining({ minutes: 300 }), quantity: expect.objectContaining({ used: 7 }) }));
      expect(rows).toContainEqual(expect.objectContaining({ meter_id: "claude-work:all", window: expect.objectContaining({ minutes: 10_080 }), quantity: expect.objectContaining({ used: 61 }) }));
      expect(rows).toContainEqual(expect.objectContaining({ meter_id: "claude-work:fable", freshness: "fresh", quantity: expect.objectContaining({ used: 0 }) }));
      const [binary, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; cwd: string }];
      expect(binary).toBe("claude");
      expect(args).toEqual(["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""]);
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.env.CLAUDE_CONFIG_DIR).toMatch(/\.claude-work$/);
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });

  it("runs at most once per profile every 10 minutes", async () => {
    const dir = await stampDir();
    const run = vi.fn(async () => stream());
    expect(await observeClaudeUsage(account, { run, now: () => at, stampDir: dir })).toHaveProperty("rows");
    expect(await observeClaudeUsage(account, { run, now: () => new Date(at.getTime() + 60_000), stampDir: dir })).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await observeClaudeUsage(account, { run, now: () => new Date(at.getTime() + CLAUDE_USAGE_MIN_INTERVAL_MS + 1000), stampDir: dir })).toHaveProperty("rows");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed with a reason: no usage_report, text only, a missing binary, a crash", async () => {
    const textOnly = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Current session: 7% used" }] } });
    for (const run of [async () => '{"type":"result"}\n', async () => textOnly, async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); }, async () => { throw new Error("exit 1"); }]) {
      const result = await observeClaudeUsage(account, { run, now: () => at, stampDir: await stampDir() });
      expect(result).toEqual({ error: expect.any(String) });
    }
  });
});

describe("statusline reader and writer guards", () => {
  const payload = (used: number, api: number, session = "s1") => ({ session_id: session, cost: { total_api_duration_ms: api }, rate_limits: { five_hour: { used_percentage: used, resets_at: 2_000_000_000 } } });
  const snap = (used: number, api: number, when: number, session?: string) => snapshotFromStatuslinePayload(payload(used, api, session), "default", new Date(when * 1000))!;

  it("restamps observed_at only when the session's API time grew, and never lowers used within one reset", () => {
    const first = snap(30, 1000, 1_800_000_000);
    const replay = reconcileSnapshot(snap(10, 1000, 1_800_000_900), first);
    expect(replay.observed_at).toBe(1_800_000_000);
    expect(replay.five_hour?.used_percent).toBe(30);
    const worked = reconcileSnapshot(snap(35, 2000, 1_800_000_900), first);
    expect(worked.observed_at).toBe(1_800_000_900);
    expect(worked.five_hour?.used_percent).toBe(35);
    expect(reconcileSnapshot(snap(5, 0, 1_800_000_900, "s2"), first).observed_at).toBe(1_800_000_900);
  });

  it("rejects a file whose source is not statusline (the OAuth live-poll fill)", () => {
    const body = (source?: string) => JSON.stringify({ alias: "main", observed_at: Math.floor(Date.now() / 1000), five_hour: { used_pct: 4 }, ...(source ? { source } : {}) });
    expect(parseStatuslineSnapshot(body("live-poll"))).toBeUndefined();
    expect(parseStatuslineSnapshot(body("statusline"))).toBeDefined();
    expect(parseStatuslineSnapshot(body())).toBeDefined();
  });
});
