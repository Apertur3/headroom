import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ observeClaude: vi.fn() }));
vi.mock("../src/adapters/claude.js", async (original) => ({ ...await original<typeof import("../src/adapters/claude.js")>(), observeClaude: probe.observeClaude }));
const { pollAccounts } = await import("../src/collector.js");

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); probe.observeClaude.mockReset(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup(claudeProbe: boolean, snapshot: "fresh" | "stale" | "none"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-probe-off-")); temporary.push(root);
  const home = join(root, ".headroom"), state = join(root, "state");
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "accounts.toml"), `[[accounts]]\nname = "claude-main"\nvendor = "claude"\nlocation = ${JSON.stringify(join(homedir(), ".claude"))}\nadapter = "native-ts"\n`, { mode: 0o600 });
  await writeFile(join(home, "policy.toml"), `claude_probe = ${claudeProbe}\nstatusline_snapshot_dirs = [${JSON.stringify(state)}]\n`, { mode: 0o600 });
  // The collector-shaped file the owner's fleet writes: alias "main", epoch observed_at, used_pct.
  if (snapshot !== "none") await writeFile(join(state, "main.json"), JSON.stringify({
    alias: "main", observed_at: Math.floor(Date.now() / 1000) - (snapshot === "fresh" ? 5 : 3600),
    five_hour: { used_pct: 4, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_pct: 60, resets_at: Math.floor(Date.now() / 1000) + 86_400 }, source: "statusline",
  }), { mode: 0o600 });
  return home;
}

const stream = () => readFile(new URL("./fixtures/claude/usage-stream.synthetic.jsonl", import.meta.url), "utf8");
const t0 = new Date();

async function poll(home: string, run?: () => Promise<string>, now: () => Date = () => t0) {
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
  try { return await pollAccounts(undefined, run ? { claudeUsage: { run, now } } : {}); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("claude_probe = false: a full collector cycle never reaches the probe, Keychain or network", () => {
  it.each(["fresh", "stale", "none"] as const)("snapshot %s", async (snapshot) => {
    const home = await setup(false, snapshot);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("network must not be called"); });
    probe.observeClaude.mockImplementation(() => { throw new Error("probe must not be called"); });
    const result = await poll(home);
    expect(probe.observeClaude).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    const rows = result.observations.filter((item) => item.principal_id === "claude-main");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((item) => item.freshness === "failed")).toBe(false);
    if (snapshot === "fresh") expect(rows).toContainEqual(expect.objectContaining({ meter_id: "claude-main:all", source: "native:claude-statusline", freshness: "fresh", quantity: expect.objectContaining({ used: 4 }) }));
    if (snapshot === "stale") expect(rows.every((item) => item.freshness === "stale")).toBe(true);
    if (snapshot === "none") expect(rows.every((item) => item.freshness === "stale" && item.quantity === null)).toBe(true);
  });

  it("claude_probe = true still falls back to the probe when there is no snapshot", async () => {
    const home = await setup(true, "none");
    probe.observeClaude.mockResolvedValue([]);
    await poll(home);
    expect(probe.observeClaude).toHaveBeenCalledTimes(1);
  });

  it("with no snapshot, Claude Code's /usage fills the meters (Fable too) from native:claude-usage", async () => {
    const run = vi.fn(async () => stream());
    const none = await poll(await setup(false, "none"), run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(none.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "claude-main:all", source: "native:claude-usage", freshness: "fresh", quantity: expect.objectContaining({ used: 7 }) }),
      expect.objectContaining({ meter_id: "claude-main:fable", source: "native:claude-usage", freshness: "fresh" }),
    ]));
  });


  it("probe on + fresh snapshot + recent ok /usage: zero probe calls over 3 polls", async () => {
    const home = await setup(true, "fresh");
    const run = vi.fn(async () => stream());
    for (let i = 0; i < 3; i++) await poll(home, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(probe.observeClaude).not.toHaveBeenCalled();
  });

  it("probe on + /usage error + no snapshot: the probe runs once per poll", async () => {
    const home = await setup(true, "none");
    probe.observeClaude.mockResolvedValue([]);
    const run = vi.fn(async () => { throw new Error("exit 1"); });
    for (let i = 0; i < 3; i++) await poll(home, run);
    expect(run).toHaveBeenCalledTimes(1); // throttled, but the failed run still counts as unknown
    expect(probe.observeClaude).toHaveBeenCalledTimes(3);
  });

  it("probe off + fresh snapshot: /usage refreshes the Fable row at most every 10 minutes", async () => {
    const home = await setup(false, "fresh");
    const run = vi.fn(async () => stream());
    let clock = t0.getTime();
    const first = await poll(home, run, () => new Date(clock));
    expect(first.observations).toContainEqual(expect.objectContaining({ meter_id: "claude-main:fable", source: "native:claude-usage", freshness: "fresh" }));
    expect(first.observations.filter((item) => item.meter_id === "claude-main:all").every((item) => item.source === "native:claude-statusline")).toBe(true);
    clock += 60_000;
    await poll(home, run, () => new Date(clock));
    expect(run).toHaveBeenCalledTimes(1);
    clock += 11 * 60_000;
    await poll(home, run, () => new Date(clock));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("throttled after an ok run with no snapshot: no probe, nothing added", async () => {
    const home = await setup(true, "none");
    const run = vi.fn(async () => stream());
    await poll(home, run);
    const second = await poll(home, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(probe.observeClaude).not.toHaveBeenCalled();
    expect(second.failures).toEqual([]);
  });
});
