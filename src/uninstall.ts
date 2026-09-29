import { exec, execFile, spawn } from "node:child_process";
import { lstat, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { promisify } from "node:util";
import { isAccountsMissingError } from "./cli.js";
import { claudeConfigJsonPath, mcpRegistrationFor } from "./doctor.js";
import { launchEnvironment } from "./orchestrator-reads.js";
import { headroomHome } from "./paths.js";
import { readAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { servicePath, uninstallService } from "./service.js";
import { isYes } from "./setup.js";
import { isLocalAccount, type Account, type ProviderAccount } from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface UninstallOverrides {
  /** Checks PATH for the `claude` command; overridden in tests to avoid depending on the machine. */
  claudeOnPath?: () => Promise<boolean>;
  /** Runs `claude mcp remove --scope <scope> headroom` for real; overridden in tests so no real Claude Code profile is ever touched. `cwd` is set for local scope only: Claude Code looks the entry up under the directory it runs in. */
  runClaudeMcpRemove?: (env: NodeJS.ProcessEnv, scope: "user" | "local", cwd?: string) => Promise<number>;
  /** Runs the platform's own stop/unload command for the installed service; overridden in tests so launchd, systemd and Task Scheduler are never touched. */
  runServiceStop?: (command: string) => Promise<number>;
}

interface UninstallOptions {
  home: boolean;
  yes: boolean;
  dryRun: boolean;
  rl: Interface | undefined;
}

/** The profile's environment for the spawned `claude`: CLAUDE_CONFIG_DIR made absolute (a local-scope
 * removal runs from another cwd, where a relative path would name a different profile), and for the
 * default profile any CLAUDE_CONFIG_DIR inherited from the caller cleared so it cannot redirect the
 * removal to another profile's config. */
function removalEnvironment(account: ProviderAccount): { env: NodeJS.ProcessEnv; profile: Record<string, string> } {
  const launch = launchEnvironment(account);
  const profile: Record<string, string> = launch.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: resolve(launch.CLAUDE_CONFIG_DIR) } : {};
  const env = { ...process.env, ...profile };
  if (!profile.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
  return { env, profile };
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function defaultClaudeOnPath(): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", ["claude"]);
    return true;
  } catch { return false; }
}

function defaultRunClaudeMcpRemove(env: NodeJS.ProcessEnv, scope: "user" | "local", cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["mcp", "remove", "--scope", scope, "headroom"], { stdio: "inherit", env, cwd });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Runs the exact stop/unload command service.ts's own uninstallService() already
 * printed for a human to run -- launchctl bootout, systemctl disable --now, or
 * schtasks /Delete -- through a shell, since the darwin form embeds a `$(id -u)`
 * substitution. A non-zero exit (the common case for a service that was never
 * loaded, or already stopped) is reported, not treated as fatal: the file
 * removal that follows is what actually matters for uninstall. */
async function defaultRunServiceStop(command: string): Promise<number> {
  try { await execAsync(command); return 0; }
  catch (error) { return typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1; }
}

function shellQuote(value: string): string { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`; }

function claudeDisplayCommand(env: Record<string, string>, scope: "user" | "local", cwd?: string): string {
  const command = `claude mcp remove --scope ${scope} headroom`;
  // The default profile must not inherit a CLAUDE_CONFIG_DIR from the shell the user pastes this into.
  const withProfile = env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${shellQuote(env.CLAUDE_CONFIG_DIR)} ${command}` : `env -u CLAUDE_CONFIG_DIR ${command}`;
  return cwd ? `(cd ${shellQuote(cwd)} && ${withProfile})` : withProfile;
}

/**
 * Step 1: stop and remove the background service `headroom install-service`
 * (or `setup`) wrote. Only ever touches the one path service.ts's own
 * servicePath() computes for this platform -- the launchd plist, systemd user
 * unit, or Task Scheduler XML Headroom itself names and writes -- never a
 * service belonging to anything else.
 */
async function stepService(options: UninstallOptions, overrides: UninstallOverrides): Promise<boolean> {
  console.log("Step 1: stop and remove the background service");
  const path = servicePath();
  let present = true;
  try { await lstat(path); } catch { present = false; }
  if (!present) { console.log(`  no Headroom service found at ${path}; nothing to do`); return true; }
  const plan = await uninstallService(process.platform, homedir(), true);
  if (options.dryRun) {
    console.log(`  (dry run) would stop it: ${plan.command}`);
    console.log(`  (dry run) would remove ${path}`);
    return true;
  }
  console.log(`  stopping it: ${plan.command}`);
  const runServiceStop = overrides.runServiceStop ?? defaultRunServiceStop;
  try {
    const code = await runServiceStop(plan.command);
    if (code !== 0) console.log(`  stop command exited ${code} (continuing; it may already be stopped)`);
  } catch (error) { console.log(`  stop command failed: ${safeError(error)} (continuing to remove the file)`); }
  try {
    await uninstallService(process.platform, homedir(), false);
    console.log(`  removed ${path}`);
  } catch (error) { console.error(`  failed: ${safeError(error)}`); return false; }
  return true;
}

/**
 * Step 2: remove the MCP registration (`claude mcp add headroom -- ...`) for
 * every configured Claude profile that actually has one, read straight from
 * each profile's own `.claude.json` the same way `headroom doctor`'s mcp
 * registration check does. A user-scope entry is removed with `--scope user`;
 * an entry a plain `claude mcp add` left at local scope is removed with
 * `--scope local` run from the directory it is bound to, which is where Claude
 * Code looks it up. Only the `headroom` name is ever named, so unrelated MCP
 * entries are never touched.
 */
async function stepMcp(options: UninstallOptions, overrides: UninstallOverrides): Promise<boolean> {
  console.log("Step 2: remove the Claude Code MCP registration");
  let accounts: Account[];
  try { accounts = await readAccounts(); }
  catch (error) {
    if (isAccountsMissingError(error)) { console.log("  no accounts.toml; nothing to remove"); return true; }
    console.error(`  failed: ${safeError(error)}`);
    return false;
  }
  const claudeAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude");
  if (!claudeAccounts.length) { console.log("  no configured Claude profiles; nothing to remove"); return true; }
  const registered: { account: ProviderAccount; scope: "user" | "local"; cwd?: string }[] = [];
  for (const account of claudeAccounts) {
    const found = await mcpRegistrationFor(account.location);
    if (found.user) registered.push({ account, scope: "user" });
    for (const cwd of found.localDirectories) registered.push({ account, scope: "local", cwd });
  }
  if (!registered.length) { console.log("  not registered for any configured Claude profile"); return true; }
  const claudeOnPath = overrides.claudeOnPath ?? defaultClaudeOnPath;
  let onPath: boolean;
  try { onPath = await claudeOnPath(); }
  catch (error) { console.error(`  failed: ${safeError(error)}`); return false; }
  const runClaudeMcpRemove = overrides.runClaudeMcpRemove ?? defaultRunClaudeMcpRemove;
  let failed = false;
  for (const { account, scope, cwd } of registered) {
    const { env, profile } = removalEnvironment(account);
    const display = claudeDisplayCommand(profile, scope, cwd);
    const label = cwd ? `${account.name} (${scope} scope, ${cwd})` : `${account.name} (${scope} scope)`;
    if (cwd && !(await directoryExists(cwd))) {
      // Claude Code looks a local entry up under the directory it runs in, so it cannot be removed without that directory.
      console.log(`  ${label}: ${cwd} no longer exists, so \`claude mcp remove\` cannot run there. The entry is inert while the directory is gone. To remove it, recreate the directory (mkdir -p ${shellQuote(cwd)}) and run headroom uninstall again, or delete projects["${cwd}"].mcpServers.headroom yourself in ${claudeConfigJsonPath(account.location)}`);
      continue;
    }
    if (options.dryRun) { console.log(`  (dry run) would run for ${label}: ${display}`); continue; }
    if (!onPath) { console.log(`  \`claude\` was not found on PATH; run this yourself for ${label}: ${display}`); continue; }
    try {
      const code = await runClaudeMcpRemove(env, scope, cwd);
      console.log(code === 0 ? `  removed for ${label}` : `  claude mcp remove exited with code ${code} for ${label}; run it yourself: ${display}`);
      if (code !== 0) failed = true;
    } catch (error) { console.error(`  failed for ${label}: ${safeError(error)}`); failed = true; }
  }
  return !failed;
}

/**
 * Step 3: only with `--home`, delete the Headroom home directory (database,
 * logs, config -- including accounts.toml and the Keychain grant marker
 * stored in the database). The macOS Keychain ACL granted to the probe binary
 * itself is separate from this directory: it disappears when the binary that
 * was granted access is removed, not from anything this step does.
 */
async function stepHome(options: UninstallOptions): Promise<boolean> {
  console.log("Step 3: delete the Headroom home directory");
  const path = headroomHome();
  if (!options.home) { console.log(`  skipped; pass --home to also delete ${path} (accounts.toml, config, database and logs go with it)`); return true; }
  console.log(`  this deletes ${path}, including accounts.toml, policy/routing config, the database and logs`);
  if (process.platform === "darwin") console.log("  the Keychain grant marker lives inside this directory; the macOS Keychain ACL granted to the probe binary itself disappears with that binary, not from this step");
  if (options.dryRun) { console.log(`  (dry run) would ask to delete ${path}`); return true; }
  const confirmed = options.yes ? true : options.rl ? isYes(await options.rl.question(`  Delete ${path}? [y/N] `)) : false;
  if (!confirmed) { console.log("  skipped; not deleted"); return true; }
  try { await rm(path, { recursive: true, force: true }); console.log(`  deleted ${path}`); }
  catch (error) { console.error(`  failed: ${safeError(error)}`); return false; }
  return true;
}

/** Step 4: Headroom never removes its own package while it is running --
 * this only ever prints the command for the user to run themselves. */
function stepNpm(): void {
  console.log("Step 4: uninstall the npm package");
  console.log("  Headroom cannot remove its own package while it is running. Run this yourself:");
  console.log("  npm uninstall -g headroomd");
}

/**
 * `headroom uninstall`: reverses what `headroom setup` (and `install-service`
 * / `claude mcp add`) did, in order -- stop and remove the background
 * service, remove the Claude Code MCP registration for every configured
 * profile that has one, optionally delete the Headroom home, and print the
 * one command Headroom cannot run for itself.
 */
export async function runUninstall(argv: string[], overrides: UninstallOverrides = {}): Promise<number> {
  const known = new Set(["--home", "--yes", "--dry-run"]);
  for (const arg of argv) if (!known.has(arg)) throw new Error("Usage: headroom uninstall [--home] [--yes] [--dry-run]");
  const home = argv.includes("--home");
  const yes = argv.includes("--yes");
  const dryRun = argv.includes("--dry-run");
  const interactive = process.stdin.isTTY === true && !dryRun && home && !yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const options: UninstallOptions = { home, yes, dryRun, rl };
  try {
    console.log(dryRun ? "Headroom uninstall (dry run; nothing will change)" : "Headroom uninstall");
    let ok = true;
    console.log("");
    if (!(await stepService(options, overrides))) ok = false;
    console.log("");
    if (!(await stepMcp(options, overrides))) ok = false;
    console.log("");
    if (!(await stepHome(options))) ok = false;
    console.log("");
    stepNpm();
    console.log("");
    console.log(ok ? "Uninstall finished." : "Uninstall finished with errors.");
    return ok ? 0 : 1;
  } finally { rl?.close(); }
}
