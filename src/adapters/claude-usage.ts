import { execFile } from "node:child_process";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { headroomHome } from "../paths.js";
import { redact } from "../security.js";
import type { Observation, ProviderAccount } from "../types.js";
import { observationsFromClaudeUsage } from "./claude.js";
import { statuslineProfile } from "./claude-statusline.js";

const execFileAsync = promisify(execFile);

/** Source label of a reading taken by running Claude Code's own `/usage`. */
export const CLAUDE_USAGE_SOURCE = "native:claude-usage";
/** At most one `claude -p "/usage"` run per profile in this window. */
export const CLAUDE_USAGE_MIN_INTERVAL_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;
/** `/usage` runs no model turn: it prints a usage_report (an experimental SDK
 * message, SDKUsageReport) and exits. No shell, no token handled by Headroom:
 * Claude Code reads its own login. */
const ARGS = ["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""];
/** Only these variables reach the child; in particular no ANTHROPIC_API_KEY,
 * which would switch the session off the subscription. */
const ENV_KEYS = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot"];

export type ClaudeUsageRunner = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeout: number }) => Promise<string>;
export interface ClaudeUsageDependencies { run?: ClaudeUsageRunner; now?: () => Date; stampDir?: string; binary?: string }
/** `undefined`: ran recently, nothing to add. */
export type ClaudeUsageResult = { rows: Observation[] } | { error: string } | undefined;

const defaultRun: ClaudeUsageRunner = async (binary, args, options) => (await execFileAsync(binary, args, { ...options, maxBuffer: MAX_BUFFER, windowsHide: true })).stdout;

function childEnvironment(account: ProviderAccount): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  const extra = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  env.PATH = [process.env.PATH ?? "", ...extra].filter(Boolean).join(delimiter);
  if (account.location && resolve(account.location) !== resolve(homedir(), ".claude")) env.CLAUDE_CONFIG_DIR = resolve(account.location);
  return env;
}

/** Claims this profile's run slot by touching a stamp file; false while the last run is under the minimum interval. */
async function claimSlot(account: ProviderAccount, dependencies: ClaudeUsageDependencies, now: Date): Promise<boolean> {
  const dir = dependencies.stampDir ?? join(headroomHome(), "claude-usage");
  const path = join(dir, `${statuslineProfile(account.location)}.stamp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const last = await stat(path).then((info) => info.mtimeMs, () => undefined);
    if (last !== undefined && now.getTime() - last < CLAUDE_USAGE_MIN_INTERVAL_MS) return false;
    if (last === undefined) await writeFile(path, "", { mode: 0o600 });
    await utimes(path, now, now);
    return true;
  } catch { return false; } // cannot record the claim: fail closed rather than run unthrottled
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The usage_report of the stream's assistant message, as an OAuth-usage-shaped body. Never parses the text. */
export function usageBodyFromStream(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split("\n")) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { continue; }
    if (!isObject(message) || message.type !== "assistant" || !isObject(message.usage_report) || !isObject(message.usage_report.rate_limits)) continue;
    const limits = message.usage_report.rate_limits.limits;
    if (!Array.isArray(limits)) continue;
    const body: Record<string, unknown> = { limits: [] };
    for (const limit of limits) {
      if (!isObject(limit)) continue;
      const entry = { percent: limit.percent, resets_at: limit.resets_at };
      if (limit.kind === "session") body.five_hour = entry;
      else if (limit.kind === "weekly_all") body.seven_day = entry;
      else if (limit.kind === "weekly_scoped") (body.limits as unknown[]).push({ ...entry, kind: "weekly_scoped", scope: limit.scope, is_active: limit.is_active });
    }
    return body;
  }
  return undefined;
}

export async function observeClaudeUsage(account: ProviderAccount, dependencies: ClaudeUsageDependencies = {}): Promise<ClaudeUsageResult> {
  const now = dependencies.now?.() ?? new Date();
  if (!await claimSlot(account, dependencies, now)) return undefined;
  let stdout: string;
  try {
    stdout = await (dependencies.run ?? defaultRun)(dependencies.binary ?? process.env.HEADROOM_CLAUDE_BIN ?? "claude", ARGS, { env: childEnvironment(account), cwd: tmpdir(), timeout: TIMEOUT_MS });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" ? "the claude command was not found on PATH" : `claude /usage failed: ${redact(error instanceof Error ? error.message : "unknown error").slice(0, 200)}` };
  }
  const body = usageBodyFromStream(stdout);
  if (!body) return { error: "claude /usage returned no usage_report (API-key, setup-token or usage-billing session, or an older Claude Code)" };
  const rows = observationsFromClaudeUsage(body, account, now).map((row) => ({ ...row, source: CLAUDE_USAGE_SOURCE }));
  return rows.some((row) => row.freshness === "fresh") ? { rows } : { error: "claude /usage report carried no usable limits" };
}
