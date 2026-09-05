/**
 * Best-effort per-model token attribution from Claude Code's own local
 * session logs (`<CLAUDE_CONFIG_DIR>/projects/**\/*.jsonl`). Never a vendor
 * call, never authoritative: the vendor's own `/usage` percentages cannot be
 * split by model (see docs/concepts.md), so this is a local estimate of
 * *token share* within the current 5h window, not a percent-of-limit figure.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ModelTokenShare {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** Every `type: "assistant"` line's model + input/output token pair, one per
 * line, from a single session log file's raw text. Malformed lines and lines
 * missing a model or usage are skipped, never thrown -- a session log is
 * Claude Code's own working file, not a validated data contract. */
function parseAssistantUsage(raw: string): Array<{ model: string; timestamp: string; input_tokens: number; output_tokens: number }> {
  const results: Array<{ model: string; timestamp: string; input_tokens: number; output_tokens: number }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as Record<string, unknown>;
    if (entry.type !== "assistant") continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const message = entry.message;
    if (!timestamp || typeof message !== "object" || message === null) continue;
    const model = (message as Record<string, unknown>).model;
    const usage = (message as Record<string, unknown>).usage;
    if (typeof model !== "string" || !model || typeof usage !== "object" || usage === null) continue;
    const inputTokens = (usage as Record<string, unknown>).input_tokens;
    const outputTokens = (usage as Record<string, unknown>).output_tokens;
    if (typeof inputTokens !== "number" || typeof outputTokens !== "number") continue;
    results.push({ model, timestamp, input_tokens: inputTokens, output_tokens: outputTokens });
  }
  return results;
}

/** Every `.jsonl` file under `<configDir>/projects/`, recursively, with its
 * mtime -- sorted newest first, capped at `limit` (mirrors codex.ts's own
 * "20 most recently modified session logs" convention: a real Claude Code
 * install can have thousands of project session files, and only the recent
 * ones can possibly hold an entry from the current 5h window). Best effort:
 * a missing projects directory (never used Claude Code here, or no local
 * session logs at all) returns an empty list, never throws. */
async function recentSessionLogFiles(configDir: string, limit = 50): Promise<Array<{ path: string; mtimeMs: number }>> {
  const root = join(configDir, "projects");
  const files: Array<{ path: string; mtimeMs: number }> = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.name.endsWith(".jsonl")) continue;
      try { files.push({ path, mtimeMs: (await stat(path)).mtimeMs }); } catch { /* removed mid-scan: skip it */ }
    }
  }
  await walk(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}

/**
 * Per-model input/output token totals from every assistant turn in
 * `<configDir>/projects/**\/*.jsonl` whose own timestamp falls in
 * `[since, until]`. Only files modified since `since` are even opened (a
 * file's mtime is always at or after its last line's own timestamp, so an
 * older file cannot hold an in-window entry). Returns an empty array, never
 * throws, for a config dir with no session logs at all.
 */
export async function modelTokenShare(configDir: string, since: Date, until: Date): Promise<ModelTokenShare[]> {
  const files = await recentSessionLogFiles(configDir);
  const totals = new Map<string, { input_tokens: number; output_tokens: number }>();
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  for (const file of files) {
    if (file.mtimeMs < sinceMs) continue;
    let raw: string;
    try { raw = await readFile(file.path, "utf8"); } catch { continue; }
    for (const entry of parseAssistantUsage(raw)) {
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
      const current = totals.get(entry.model) ?? { input_tokens: 0, output_tokens: 0 };
      current.input_tokens += entry.input_tokens;
      current.output_tokens += entry.output_tokens;
      totals.set(entry.model, current);
    }
  }
  return [...totals.entries()].map(([model, tokens]) => ({ model, ...tokens })).sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
}
