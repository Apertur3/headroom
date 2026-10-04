/**
 * `headroom hook install|uninstall|status --agent claude` (issue #149).
 *
 * Installs a tiny POSIX sh script under the Headroom home and one Claude Code
 * UserPromptSubmit entry that runs it, so every prompt carries the line the
 * daemon last wrote (agent-line.ts). The script only reads a file: no Node,
 * no network, no daemon round trip, and it always exits 0 so it can never
 * block or fail a prompt.
 *
 * Settings edits are deliberately narrow: one entry is added or removed,
 * every other key is re-serialized in its original order with the file's own
 * indentation, a settings file that does not parse is never rewritten, the
 * first change is preceded by a one-time backup, and a Claude config
 * directory that does not exist is never created.
 */
import { chmod, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultMaxAgeSeconds, formatAge, readAgentLine } from "./agent-line.js";
import { readPolicy } from "./config.js";
import { headroomHome } from "./paths.js";
import { defaultPolicy } from "./policy.js";
import { safeError, writeFileAtomic } from "./security.js";

export const HOOK_SCRIPT_NAME = "claude-line.sh";
export const HOOK_USAGE = "Usage: headroom hook <install|uninstall|status> [--agent claude]";
export const TOKEN_COST_NOTE = "about 60 tokens per turn";
export const SAMPLE_LINE = "[Headroom] claude-main wk 4% (+0.5%/h) NORMAL, resets in 6d 15h (as of 42s ago)";
const BACKUP_MARKER = "settings.json.headroom-bak-";

export function hookScriptPath(home = headroomHome()): string { return join(home, "hooks", HOOK_SCRIPT_NAME); }

/** Single-quoted for sh: the only character that needs care is the quote itself. */
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

/**
 * The hook script. The line file path is fixed at install time (the daemon
 * writes into this same home), and so is the stat flavour for the platform,
 * so a prompt costs two short forks (date, stat) and a builtin read.
 */
export function hookScript(home = headroomHome(), platform: NodeJS.Platform = process.platform): string {
  const statCommand = platform === "darwin" || platform === "freebsd" || platform === "openbsd" ? "stat -f %m" : "stat -c %Y";
  return [
    "#!/bin/sh",
    "# Headroom agent quota line: a Claude Code UserPromptSubmit hook installed by",
    "# `headroom hook install`. Prints the line the Headroom daemon last wrote and",
    "# its age. Reads one file; no network, no Node. Always exits 0, silent on error.",
    `f=${shellQuote(join(home, "line.txt"))}`,
    "{",
    "  [ -f \"$f\" ] || exit 0",
    "  IFS= read -r line < \"$f\" || [ -n \"$line\" ] || exit 0",
    "  [ -n \"$line\" ] || exit 0",
    "  now=$(date +%s) || exit 0",
    `  m=$(${statCommand} "$f") || exit 0`,
    "  case \"$now$m\" in ''|*[!0-9]*) exit 0 ;; esac",
    "  age=$((now - m)); [ \"$age\" -ge 0 ] || age=0",
    "  printf '%s (as of %ss ago)\\n' \"$line\" \"$age\"",
    "} 2>/dev/null",
    "exit 0",
    "",
  ].join("\n");
}

/** The exact command string written into settings.json. */
export function hookCommand(home = headroomHome()): string { return shellQuote(hookScriptPath(home)); }

/** Ours, whatever home it was installed from: the command runs a
 * `hooks/claude-line.sh` script, the tag every Headroom install writes. */
export function isHeadroomCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /[\\/]hooks[\\/]claude-line\.sh'?\s*$/.test(command.trim());
}

/** Every Claude config dir to cover: CLAUDE_CONFIG_DIR if set, else
 * ~/.claude, plus ~/.claude2 when it exists. Only existing dirs are kept. */
export async function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string[]> {
  const candidates = [env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(home, ".claude"), join(home, ".claude2")];
  const unique = [...new Set(candidates)];
  const existing: string[] = [];
  for (const dir of unique) {
    try { if ((await stat(dir)).isDirectory()) existing.push(dir); } catch { /* absent: never created */ }
  }
  return existing;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The file's own indentation (first indented line), default two spaces. */
function detectIndent(text: string): string | number {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

function serialize(value: JsonObject, original: string | undefined): string {
  const indent = original === undefined ? 2 : detectIndent(original);
  const trailingNewline = original === undefined ? true : original.endsWith("\n");
  return `${JSON.stringify(value, null, indent)}${trailingNewline ? "\n" : ""}`;
}

export interface SettingsEditResult {
  dir: string;
  path: string;
  outcome: "added" | "removed" | "unchanged" | "absent" | "refused";
  message?: string;
  backup?: string;
}

interface LoadedSettings { text: string | undefined; value: JsonObject; mode: number | undefined }

async function loadSettings(path: string): Promise<LoadedSettings> {
  let text: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`refusing to edit ${path}: it is a symlink; edit it by hand`);
    if (!info.isFile()) throw new Error(`refusing to edit ${path}: not a regular file`);
    text = await readFile(path, "utf8");
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error(`refusing to edit ${path}: it is not valid JSON; fix it or remove it, then run this again`); }
    if (!isObject(value)) throw new Error(`refusing to edit ${path}: the top level is not a JSON object`);
    if (value.hooks !== undefined && !isObject(value.hooks)) throw new Error(`refusing to edit ${path}: "hooks" is not an object`);
    const hooks = value.hooks as JsonObject | undefined;
    if (hooks?.UserPromptSubmit !== undefined && !Array.isArray(hooks.UserPromptSubmit)) throw new Error(`refusing to edit ${path}: "hooks.UserPromptSubmit" is not an array`);
    return { text, value, mode: info.mode & 0o777 };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: undefined, value: {}, mode: undefined };
    throw error;
  }
}

function groupHooks(group: Json): Json[] | undefined {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
}

function countOurs(value: JsonObject, command: string): { ours: number; exact: number } {
  const groups = isObject(value.hooks) && Array.isArray(value.hooks.UserPromptSubmit) ? value.hooks.UserPromptSubmit : [];
  let ours = 0; let exact = 0;
  for (const group of groups) for (const hook of groupHooks(group) ?? []) {
    if (isObject(hook) && isHeadroomCommand(hook.command)) { ours += 1; if (hook.command === command) exact += 1; }
  }
  return { ours, exact };
}

/** Removes every Headroom entry; an emptied group, an emptied
 * UserPromptSubmit and then an emptied `hooks` go with it. */
function withoutOurs(value: JsonObject): JsonObject {
  if (!isObject(value.hooks) || !Array.isArray(value.hooks.UserPromptSubmit)) return value;
  const groups: Json[] = [];
  for (const group of value.hooks.UserPromptSubmit) {
    const hooks = groupHooks(group);
    if (!hooks) { groups.push(group); continue; }
    const kept = hooks.filter((hook) => !(isObject(hook) && isHeadroomCommand(hook.command)));
    if (kept.length === hooks.length) groups.push(group);
    else if (kept.length) groups.push({ ...(group as JsonObject), hooks: kept });
  }
  const hooks: JsonObject = { ...value.hooks };
  if (groups.length) hooks.UserPromptSubmit = groups;
  else delete hooks.UserPromptSubmit;
  const next: JsonObject = { ...value, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

function withOurs(value: JsonObject, command: string): JsonObject {
  const base = withoutOurs(value);
  const hooks: JsonObject = isObject(base.hooks) ? { ...base.hooks } : {};
  const groups = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
  groups.push({ hooks: [{ type: "command", command }] });
  hooks.UserPromptSubmit = groups;
  return { ...base, hooks };
}

async function backupOnce(dir: string, original: string | undefined, now: Date): Promise<string | undefined> {
  if (original === undefined) return undefined;
  const existing = (await readdir(dir).catch(() => [] as string[])).find((name) => name.startsWith(BACKUP_MARKER));
  if (existing) return undefined;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = join(dir, `${BACKUP_MARKER}${stamp}`);
  await writeFile(path, original, { flag: "wx", mode: 0o600 });
  return path;
}

async function editSettings(dir: string, change: "install" | "uninstall", command: string, now: Date): Promise<SettingsEditResult> {
  const path = join(dir, "settings.json");
  let loaded: LoadedSettings;
  try { loaded = await loadSettings(path); }
  catch (error) { return { dir, path, outcome: "refused", message: safeError(error) }; }
  const { ours, exact } = countOurs(loaded.value, command);
  if (change === "install" && ours === 1 && exact === 1) return { dir, path, outcome: "unchanged" };
  if (change === "uninstall" && ours === 0) return { dir, path, outcome: loaded.text === undefined ? "absent" : "unchanged" };
  const next = change === "install" ? withOurs(loaded.value, command) : withoutOurs(loaded.value);
  const text = serialize(next, loaded.text);
  if (text === loaded.text) return { dir, path, outcome: "unchanged" };
  // JSON.stringify keeps key order and the detected indentation; anything
  // else hand-formatted (aligned arrays, escapes) comes back in its canonical
  // form, so say so. The one-time backup keeps the original bytes.
  const reformatted = loaded.text !== undefined && serialize(loaded.value, loaded.text) !== loaded.text;
  try {
    const backup = await backupOnce(dir, loaded.text, now);
    await writeFileAtomic(path, text, loaded.mode ?? 0o600);
    return { dir, path, outcome: change === "install" ? "added" : "removed", ...(backup ? { backup } : {}), ...(reformatted ? { message: "other keys were re-serialized in canonical JSON form" } : {}) };
  } catch (error) { return { dir, path, outcome: "refused", message: safeError(error) }; }
}

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  home?: string;
  platform?: NodeJS.Platform;
  now?: Date;
  log?: (line: string) => void;
}

function resolved(options: HookOptions) {
  return {
    env: options.env ?? process.env,
    userHome: options.userHome ?? homedir(),
    home: options.home ?? headroomHome(),
    platform: options.platform ?? process.platform,
    now: options.now ?? new Date(),
    log: options.log ?? ((line: string) => console.log(line)),
  };
}

async function writeScript(home: string, platform: NodeJS.Platform): Promise<boolean> {
  const dir = join(home, "hooks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = hookScriptPath(home);
  const content = hookScript(home, platform);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) { await chmod(path, 0o700); return false; }
  await writeFileAtomic(path, content, 0o700);
  await chmod(path, 0o700);
  return true;
}

function describe(result: SettingsEditResult): string {
  const backup = `${result.backup ? ` (backup: ${result.backup})` : ""}${result.message && result.outcome !== "refused" ? `; note: ${result.message}` : ""}`;
  switch (result.outcome) {
    case "added": return `  ${result.path}: hook added${backup}`;
    case "removed": return `  ${result.path}: hook removed${backup}`;
    case "unchanged": return `  ${result.path}: no change needed`;
    case "absent": return `  ${result.path}: no settings file; nothing to remove`;
    case "refused": return `  ${result.message}`;
  }
}

/** Exit 0 when every covered settings file ended up right, 1 otherwise. */
export async function installHook(options: HookOptions = {}): Promise<number> {
  const { env, userHome, home, platform, now, log } = resolved(options);
  if (platform === "win32") { log("Hook install is not supported on Windows yet. The daemon still writes line.txt; `headroom line` prints it."); return 1; }
  const dirs = await claudeConfigDirs(env, userHome);
  if (!dirs.length) { log(`No Claude Code config directory found (${env.CLAUDE_CONFIG_DIR || join(userHome, ".claude")}); nothing installed.`); return 1; }
  const command = hookCommand(home);
  // The script is in place before any settings file names it, so no prompt
  // ever runs a command that does not exist yet. If every settings file was
  // refused, a script this call created is removed again: nothing runs it.
  const existed = await stat(hookScriptPath(home)).then(() => true, () => false);
  const scriptChanged = await writeScript(home, platform);
  const results: SettingsEditResult[] = [];
  for (const dir of dirs) results.push(await editSettings(dir, "install", command, now));
  if (!existed && results.every((item) => item.outcome === "refused")) await unlink(hookScriptPath(home)).catch(() => {});
  else log(`Hook script: ${hookScriptPath(home)}${scriptChanged ? " (written)" : " (up to date)"}`);
  for (const result of results) log(describe(result));
  return results.some((item) => item.outcome === "refused") ? 1 : 0;
}

export async function uninstallHook(options: HookOptions = {}): Promise<number> {
  const { env, userHome, home, platform, now, log } = resolved(options);
  if (platform === "win32") { log("Hook install is not supported on Windows yet; nothing to remove."); return 1; }
  const dirs = await claudeConfigDirs(env, userHome);
  const results: SettingsEditResult[] = [];
  for (const dir of dirs) results.push(await editSettings(dir, "uninstall", hookCommand(home), now));
  for (const result of results) log(describe(result));
  if (!dirs.length) log("No Claude Code config directory found; nothing to remove from settings.");
  // The script goes only when no covered settings file still runs it.
  if (!results.some((item) => item.outcome === "refused")) {
    try { await unlink(hookScriptPath(home)); log(`Removed ${hookScriptPath(home)}`); } catch { /* already gone */ }
  }
  return results.some((item) => item.outcome === "refused") ? 1 : 0;
}

export interface HookState {
  supported: boolean;
  dirs: Array<{ dir: string; state: "installed" | "not installed" | "unreadable"; message?: string }>;
  script: boolean;
  line_age_seconds: number | undefined;
  line_stale: boolean;
}

export async function hookState(options: HookOptions = {}): Promise<HookState> {
  const { env, userHome, home, platform, now } = resolved(options);
  const reading = await readAgentLine(home, now);
  const maxAge = defaultMaxAgeSeconds(await readPolicy().catch(() => defaultPolicy));
  const line_stale = reading.age_seconds === undefined || reading.age_seconds > maxAge;
  const script = await stat(hookScriptPath(home)).then((info) => info.isFile()).catch(() => false);
  if (platform === "win32") return { supported: false, dirs: [], script, line_age_seconds: reading.age_seconds, line_stale };
  const dirs: HookState["dirs"] = [];
  for (const dir of await claudeConfigDirs(env, userHome)) {
    try {
      const loaded = await loadSettings(join(dir, "settings.json"));
      dirs.push({ dir, state: countOurs(loaded.value, hookCommand(home)).ours ? "installed" : "not installed" });
    } catch (error) { dirs.push({ dir, state: "unreadable", message: safeError(error) }); }
  }
  return { supported: true, dirs, script, line_age_seconds: reading.age_seconds, line_stale };
}

/** One summary for doctor and `hook status`. */
export function describeHookState(state: HookState): string {
  if (!state.supported) return "hook install is not supported on Windows yet; the daemon still writes line.txt";
  const installed = state.dirs.filter((item) => item.state === "installed");
  const line = state.line_age_seconds === undefined ? "no line file yet" : `line ${formatAge(state.line_age_seconds)} old${state.line_stale ? ", STALE" : ""}`;
  if (!state.dirs.length) return `no Claude Code config directory found; ${line}`;
  if (!installed.length) return `not installed (${state.dirs.map((item) => item.dir).join(", ")}); ${line}`;
  const missingScript = state.script ? "" : ", hook script missing (run headroom hook install)";
  return `installed in ${installed.map((item) => item.dir).join(", ")}${missingScript}; ${line}`;
}

export async function hookCommandMain(argv: string[], options: HookOptions = {}): Promise<number> {
  const { log } = resolved(options);
  const [action, ...rest] = argv;
  let agent: string | undefined = "claude";
  let bad = false;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--agent") { agent = rest[index + 1]; index += 1; }
    else bad = true;
  }
  if (!action || !["install", "uninstall", "status"].includes(action) || bad || !agent) { console.error(HOOK_USAGE); return 2; }
  if (agent === "codex" || agent === "gemini") { log(`Hooks for ${agent} are not supported yet: no hook mechanism has been verified for it. \`headroom line\` prints the same line for any agent.`); return 2; }
  if (agent !== "claude") { console.error(`Unknown agent: ${agent}. ${HOOK_USAGE}`); return 2; }
  if (action === "install") return installHook(options);
  if (action === "uninstall") return uninstallHook(options);
  const state = await hookState(options);
  log(`Claude Code hook: ${describeHookState(state)}`);
  for (const item of state.dirs) if (item.state === "unreadable") log(`  ${item.message}`);
  return 0;
}
