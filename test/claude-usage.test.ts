import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_USAGE_MIN_INTERVAL_MS, CLAUDE_USAGE_SOURCE, defaultRun, needsShell, observeClaudeUsage, resolveBinary } from "../src/adapters/claude-usage.js";
import { parseStatuslineSnapshot, reconcileSnapshot, snapshotFromStatuslinePayload, writeSnapshotLocked } from "../src/adapters/claude-statusline.js";

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

const reportLine = (limits: unknown[]) => JSON.stringify({ type: "assistant", usage_report: { rate_limits: { limits } } });
const okLimits = [{ kind: "session", percent: 7, resets_at: "2026-10-22T11:59:59+00:00" }, { kind: "weekly_all", percent: 61, resets_at: "2026-10-25T11:59:59+00:00" }];

describe("claude /usage runner hardening", () => {
  it("any malformed limit entry fails the whole read closed with a reason", async () => {
    const fable = { kind: "weekly_scoped", percent: 40, resets_at: null, scope: { model: { display_name: "Fable" } }, is_active: true };
    for (const bad of [{ ...fable, percent: "97" }, { ...fable, kind: "mystery" }, { ...fable, resets_at: "not a date" }, { ...fable, kind: 5 }]) {
      const result = await observeClaudeUsage(account, { run: async () => reportLine([...okLimits, bad]), now: () => at, stampDir: await stampDir() });
      expect(result).toEqual({ error: expect.stringContaining("malformed limit") });
    }
    expect(await observeClaudeUsage(account, { run: async () => reportLine([...okLimits, fable]), now: () => at, stampDir: await stampDir() })).toHaveProperty("rows");
  });

  it("mapper exceptions (empty limits, non-numeric primary) become a failed read, never a rejection", async () => {
    for (const limits of [[], [{ kind: "session", percent: "7", resets_at: null }]]) {
      await expect(observeClaudeUsage(account, { run: async () => reportLine(limits), now: () => at, stampDir: await stampDir() })).resolves.toEqual({ error: expect.any(String) });
    }
  });

  it("the run claim is an exclusive per-bucket stamp keyed by the full account location", async () => {
    const dir = await stampDir();
    const run = vi.fn(async () => stream());
    const other = { ...account, location: "/elsewhere/.claude-work" };
    const results = await Promise.all([observeClaudeUsage(account, { run, now: () => at, stampDir: dir }), observeClaudeUsage(account, { run, now: () => at, stampDir: dir }), observeClaudeUsage(other, { run, now: () => at, stampDir: dir })]);
    expect(results.filter((item) => item !== undefined)).toHaveLength(2); // one winner per location; same basename no longer shares a throttle
    await observeClaudeUsage(account, { run, now: () => new Date(at.getTime() + CLAUDE_USAGE_MIN_INTERVAL_MS), stampDir: dir });
    expect((await readdir(dir)).length).toBe(2); // the older stamp for that key was removed
  });

  it("Windows .cmd and .bat launchers run through a shell; the bare name resolves on PATH", () => {
    expect(needsShell("C:\\npm\\claude.cmd", "win32")).toBe(true);
    expect(needsShell("claude.BAT", "win32")).toBe(true);
    expect(needsShell("claude.exe", "win32")).toBe(false);
    expect(needsShell("claude.cmd", "darwin")).toBe(false);
    expect(resolveBinary("claude", "win32", "C:\\a;C:\\npm", (path) => path === "C:\\npm\\claude.cmd")).toBe("C:\\npm\\claude.cmd");
    expect(resolveBinary("claude", "darwin", "/bin", () => true)).toBe("claude");
  });

  it("a child that ignores SIGTERM is SIGKILLed at the timeout and the read settles as failed", async () => {
    const started = Date.now();
    await expect(defaultRun(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { env: {}, cwd: tmpdir(), timeout: 300 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
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
    expect(reconcileSnapshot(snap(5, 500, 1_800_000_900, "s2"), first).observed_at).toBe(1_800_000_900);
  });

  it("alternating idle sessions never restamp a snapshot", () => {
    let current = reconcileSnapshot(snap(30, 1000, 1_800_000_000, "s1"), undefined);
    current = reconcileSnapshot(snap(30, 400, 1_800_000_100, "s2"), current);
    expect(current.observed_at).toBe(1_800_000_100); // s2 is new and did work
    for (let step = 0; step < 6; step++) current = reconcileSnapshot(snap(30, step % 2 ? 400 : 1000, 1_800_000_200 + step * 100, step % 2 ? "s2" : "s1"), current);
    expect(current.observed_at).toBe(1_800_000_100);
    expect(Object.keys(current.sessions ?? {}).length).toBeLessThanOrEqual(32);
  });

  it("the no-lower guard needs both resets_at known and equal", () => {
    const bucket = (used: number, resets: number | null) => ({ ...snap(used, 1000, 1_800_000_000), five_hour: { used_percent: used, resets_at: resets } });
    expect(reconcileSnapshot(bucket(1, null), bucket(95, null)).five_hour?.used_percent).toBe(1);
    expect(reconcileSnapshot(bucket(1, 5), bucket(95, 5)).five_hour?.used_percent).toBe(95);
  });

  it("a snapshot write skips while another writer holds the lock, and takes over a lock older than 10 s", async () => {
    const path = join(await stampDir(), "default.json");
    const when = Math.floor(Date.now() / 1000);
    await writeFile(`${path}.lock`, "");
    await writeSnapshotLocked(path, snap(80, 1000, when), new Date());
    await expect(readFile(path, "utf8")).rejects.toThrow();
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    await writeSnapshotLocked(path, snap(80, 1000, when), new Date());
    expect(JSON.parse(await readFile(path, "utf8")).five_hour.used_percent).toBe(80);
    await expect(readFile(`${path}.lock`, "utf8")).rejects.toThrow();
  });

  it("rejects a file whose source is not statusline (the OAuth live-poll fill)", () => {
    const body = (source?: string) => JSON.stringify({ alias: "main", observed_at: Math.floor(Date.now() / 1000), five_hour: { used_pct: 4 }, ...(source ? { source } : {}) });
    expect(parseStatuslineSnapshot(body("live-poll"))).toBeUndefined();
    expect(parseStatuslineSnapshot(body("statusline"))).toBeDefined();
    expect(parseStatuslineSnapshot(body())).toBeDefined();
  });
});
