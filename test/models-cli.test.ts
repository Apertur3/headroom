import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function assistantLine(model: string, timestamp: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
}

async function captureLog(): Promise<{ logs: string[]; restore: () => void }> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

describe("headroom --principal X --models", () => {
  it("requires --principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-models-")); temporary.push(root);
    await withHeadroomHome(join(root, ".headroom"), async () => {
      await expect(main(["--models"])).rejects.toThrow("--models requires --principal");
    });
  });

  it("requires a configured Claude principal, not e.g. a Codex one", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-models-codex-")); temporary.push(root);
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "codex-main"', 'vendor = "codex"', 'location = "/nonexistent/.codex"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    await withHeadroomHome(home, async () => {
      await expect(main(["--principal", "codex-main", "--models"])).rejects.toThrow("requires a configured Claude principal");
    });
  });

  it("reports per-model token share, estimated, from local session logs within the current 5h window", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-models-report-")); temporary.push(root);
    const home = join(root, ".headroom");
    const claudeConfigDir = join(root, ".claude");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', `location = ${JSON.stringify(claudeConfigDir)}`, 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const projectDir = join(claudeConfigDir, "projects", "-Users-x-project");
    await mkdir(projectDir, { recursive: true });
    const now = new Date();
    const recent = new Date(now.getTime() - 10 * 60_000).toISOString(); // 10 minutes ago: inside any reasonable 5h window
    await writeFile(join(projectDir, "session.jsonl"), [
      assistantLine("claude-fable-5-1", recent, 1000, 2000),
      assistantLine("claude-sonnet-5", recent, 100, 200),
    ].join("\n"));

    await withHeadroomHome(home, async () => {
      const { logs, restore } = await captureLog();
      try {
        const code = await main(["--principal", "claude-main", "--models"]);
        expect(code).toBe(0);
      } finally { restore(); }
      const text = logs.join("\n");
      expect(text).toContain("claude-main model token share, current 5h window")
      expect(text).toContain("not the vendor meter");;
      expect(text).toContain("claude-fable-5-1");
      expect(text).toContain("claude-sonnet-5");
      // 3000 total tokens vs 300: claude-fable-5-1 has ~91% of the total share.
      expect(text).toMatch(/claude-fable-5-1\s+91%/);
    });
  });

  it("--json includes truth: estimated and a share_percent per model, and uses the stored 5h window's own resets_at when available", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-models-json-")); temporary.push(root);
    const home = join(root, ".headroom");
    const claudeConfigDir = join(root, ".claude");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', `location = ${JSON.stringify(claudeConfigDir)}`, 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const projectDir = join(claudeConfigDir, "projects", "-Users-x-project");
    await mkdir(projectDir, { recursive: true });
    const now = new Date();
    await writeFile(join(projectDir, "session.jsonl"), assistantLine("claude-fable-5-1", new Date(now.getTime() - 60_000).toISOString(), 10, 20));

    const store = await HeadroomStore.open(home);
    store.insert({
      principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
      observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "fixture", truth: "official", freshness: "fresh",
      confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
    });
    store.close();

    await withHeadroomHome(home, async () => {
      const { logs, restore } = await captureLog();
      try {
        expect(await main(["--principal", "claude-main", "--models", "--json"])).toBe(0);
      } finally { restore(); }
      const result = JSON.parse(logs[0]);
      expect(result.truth).toBe("estimated");
      expect(result.principal).toBe("claude-main");
      expect(result.models).toEqual([{ model: "claude-fable-5-1", input_tokens: 10, output_tokens: 20, share_percent: 100 }]);
    });
  });

  it("reports 'no local session-log token data' rather than an error when there is none", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-models-empty-")); temporary.push(root);
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude-empty"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    await withHeadroomHome(home, async () => {
      const { logs, restore } = await captureLog();
      try {
        expect(await main(["--principal", "claude-main", "--models"])).toBe(0);
      } finally { restore(); }
      expect(logs.join("\n")).toContain("no local session-log token data");
    });
  });
});
