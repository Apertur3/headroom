import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelTokenShare } from "../src/session-logs.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function assistantLine(model: string, timestamp: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
}

async function configDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-session-logs-")); temporary.push(root);
  return root;
}

describe("modelTokenShare", () => {
  it("sums input/output tokens per model from assistant turns within the window, across nested project directories", async () => {
    const dir = await configDir();
    const projectDir = join(dir, "projects", "-Users-x-project");
    await mkdir(projectDir, { recursive: true });
    const lines = [
      assistantLine("claude-fable-5-1", "2026-09-05T10:00:00Z", 100, 200),
      assistantLine("claude-fable-5-1", "2026-09-05T10:05:00Z", 50, 75),
      assistantLine("claude-sonnet-5", "2026-09-05T10:10:00Z", 10, 20),
    ].join("\n");
    await writeFile(join(projectDir, "session-a.jsonl"), lines);
    const rows = await modelTokenShare(dir, new Date("2026-09-05T09:00:00Z"), new Date("2026-09-05T12:00:00Z"));
    expect(rows).toEqual([
      { model: "claude-fable-5-1", input_tokens: 150, output_tokens: 275 },
      { model: "claude-sonnet-5", input_tokens: 10, output_tokens: 20 },
    ]);
  });

  it("excludes entries outside [since, until], and non-assistant lines", async () => {
    const dir = await configDir();
    const projectDir = join(dir, "projects", "-Users-x-project");
    await mkdir(projectDir, { recursive: true });
    const lines = [
      assistantLine("claude-fable-5-1", "2026-09-05T05:00:00Z", 999, 999), // before window
      assistantLine("claude-fable-5-1", "2026-09-05T10:00:00Z", 100, 200), // in window
      assistantLine("claude-fable-5-1", "2026-09-05T15:00:00Z", 999, 999), // after window
      JSON.stringify({ type: "user", timestamp: "2026-09-05T10:01:00Z", message: { role: "user", content: "hi" } }),
      "not even json",
    ].join("\n");
    await writeFile(join(projectDir, "session-a.jsonl"), lines);
    const rows = await modelTokenShare(dir, new Date("2026-09-05T09:00:00Z"), new Date("2026-09-05T12:00:00Z"));
    expect(rows).toEqual([{ model: "claude-fable-5-1", input_tokens: 100, output_tokens: 200 }]);
  });

  it("skips a file whose mtime predates the window start, without even opening it", async () => {
    const dir = await configDir();
    const projectDir = join(dir, "projects", "-Users-x-project");
    await mkdir(projectDir, { recursive: true });
    const path = join(projectDir, "old-session.jsonl");
    // A timestamp inside the window, but the FILE's own mtime is set well
    // before the window start -- this must never surface, since a real
    // session log's mtime is always at or after its last line's timestamp.
    await writeFile(path, assistantLine("claude-fable-5-1", "2026-09-05T10:00:00Z", 100, 200));
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(path, old, old);
    const rows = await modelTokenShare(dir, new Date("2026-09-05T09:00:00Z"), new Date("2026-09-05T12:00:00Z"));
    expect(rows).toEqual([]);
  });

  it("returns an empty array, never throws, for a config dir with no session logs at all", async () => {
    const dir = await configDir();
    await expect(modelTokenShare(dir, new Date(0), new Date())).resolves.toEqual([]);
  });

  it("sorts by total tokens descending", async () => {
    const dir = await configDir();
    const projectDir = join(dir, "projects", "-Users-x-project");
    await mkdir(projectDir, { recursive: true });
    const lines = [
      assistantLine("small-model", "2026-09-05T10:00:00Z", 1, 1),
      assistantLine("big-model", "2026-09-05T10:01:00Z", 500, 500),
    ].join("\n");
    await writeFile(join(projectDir, "session-a.jsonl"), lines);
    const rows = await modelTokenShare(dir, new Date("2026-09-05T09:00:00Z"), new Date("2026-09-05T12:00:00Z"));
    expect(rows.map((row) => row.model)).toEqual(["big-model", "small-model"]);
  });
});
