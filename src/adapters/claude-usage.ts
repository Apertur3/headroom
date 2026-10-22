import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { headroomHome } from "../paths.js";
import { redact } from "../security.js";
import type { Observation, ProviderAccount } from "../types.js";
import { observationsFromClaudeUsage } from "./claude.js";

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

/** Windows npm installs expose `claude.cmd`, which only a shell can start. Safe here: every argument is a constant and the only variable input travels in env. */
export const needsShell = (binary: string, platform: string = process.platform): boolean => platform === "win32" && /\.(cmd|bat)$/i.test(binary);

/** A bare `claude` on Windows is `claude.exe` or the npm `claude.cmd` shim; look both up on PATH. */
export function resolveBinary(binary: string, platform: string = process.platform, pathVariable = process.env.PATH ?? "", exists = existsSync): string {
  if (platform !== "win32" || /[\\/.]/.test(binary)) return binary;
  for (const dir of pathVariable.split(";")) for (const extension of [".exe", ".cmd", ".bat"]) if (dir && exists(`${dir}\\${binary}${extension}`)) return `${dir}\\${binary}${extension}`;
  return binary;
}

/** Own timer, SIGKILL: execFile's SIGTERM-only timeout leaves a child that ignores it (and the poll awaiting it) hanging. */
export const defaultRun: ClaudeUsageRunner = (binary, args, options) => new Promise((resolvePromise, reject) => {
  const shell = needsShell(binary);
  const child = execFile(shell && binary.includes(" ") ? `"${binary}"` : binary, shell ? args.map((arg) => arg === "" ? '""' : arg) : args, { env: options.env, cwd: options.cwd, maxBuffer: MAX_BUFFER, windowsHide: true, shell }, (error, stdout) => {
    clearTimeout(timer);
    if (error) reject(error); else resolvePromise(stdout);
  });
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out after ${options.timeout / 1000}s`)); }, options.timeout);
});

function childEnvironment(account: ProviderAccount): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  const extra = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  env.PATH = [process.env.PATH ?? "", ...extra].filter(Boolean).join(delimiter);
  if (account.location && resolve(account.location) !== resolve(homedir(), ".claude")) env.CLAUDE_CONFIG_DIR = resolve(account.location);
  return env;
}

/** Claims this account's run slot by exclusively creating a stamp named for the current 10-minute bucket; false when it already exists. */
async function claimSlot(account: ProviderAccount, dependencies: ClaudeUsageDependencies, now: Date): Promise<boolean> {
  const dir = dependencies.stampDir ?? join(headroomHome(), "claude-usage");
  const key = createHash("sha256").update(resolve(account.location)).digest("hex").slice(0, 12);
  // ponytail: bucket-aligned throttle, two runs can straddle a boundary
  const name = `${key}.${Math.floor(now.getTime() / CLAUDE_USAGE_MIN_INTERVAL_MS)}.stamp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await (await open(join(dir, name), "wx", 0o600)).close();
    for (const old of await readdir(dir)) if (old.startsWith(`${key}.`) && old !== name) await unlink(join(dir, old)).catch(() => undefined);
    return true;
  } catch { return false; } // already claimed, or cannot record the claim: fail closed rather than run unthrottled
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const LIMIT_KINDS = ["session", "weekly_all", "weekly_scoped"];
const validReset = (value: unknown): boolean => value === null || value === undefined || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && Number.isFinite(Date.parse(value)));

/** The usage_report of the stream's assistant message, as an OAuth-usage-shaped body. Never parses the text.
 * Throws when any limit entry is malformed: a partly readable report must fail closed, not drop a bucket. */
export function usageBodyFromStream(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split("\n")) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { continue; }
    if (!isObject(message) || message.type !== "assistant" || !isObject(message.usage_report) || !isObject(message.usage_report.rate_limits)) continue;
    const limits = message.usage_report.rate_limits.limits;
    if (!Array.isArray(limits)) continue;
    const body: Record<string, unknown> = { limits: [] };
    for (const limit of limits) {
      if (!isObject(limit) || typeof limit.kind !== "string" || !LIMIT_KINDS.includes(limit.kind) || typeof limit.percent !== "number" || !Number.isFinite(limit.percent) || !validReset(limit.resets_at)) throw new Error("claude /usage report has a malformed limit entry");
      const entry = { percent: limit.percent, resets_at: limit.resets_at };
      if (limit.kind === "session") body.five_hour = entry;
      else if (limit.kind === "weekly_all") body.seven_day = entry;
      else (body.limits as unknown[]).push({ ...entry, kind: "weekly_scoped", scope: limit.scope, is_active: limit.is_active });
    }
    return body;
  }
  return undefined;
}

export async function observeClaudeUsage(account: ProviderAccount, dependencies: ClaudeUsageDependencies = {}): Promise<ClaudeUsageResult> {
  const now = dependencies.now?.() ?? new Date();
  if (!await claimSlot(account, dependencies, now)) return undefined;
  try {
    const stdout = await (dependencies.run ?? defaultRun)(resolveBinary(dependencies.binary ?? process.env.HEADROOM_CLAUDE_BIN ?? "claude"), ARGS, { env: childEnvironment(account), cwd: tmpdir(), timeout: TIMEOUT_MS });
    const body = usageBodyFromStream(stdout);
    if (!body) return { error: "claude /usage returned no usage_report (API-key, setup-token or usage-billing session, or an older Claude Code)" };
    const rows = observationsFromClaudeUsage(body, account, now).map((row) => ({ ...row, source: CLAUDE_USAGE_SOURCE }));
    return rows.some((row) => row.freshness === "fresh") ? { rows } : { error: "claude /usage report carried no usable limits" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" ? "the claude command was not found on PATH" : `claude /usage failed: ${redact(error instanceof Error ? error.message : "unknown error").slice(0, 200)}` };
  }
}
