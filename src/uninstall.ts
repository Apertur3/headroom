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
import { servicePath, stopWindowsDaemon, uninstallService, waitForDaemonExit, windowsStopFailure } from "./service.js";
import type { ShutdownOutcome } from "./daemon.js";
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
  /** The platform whose shell the printed retry commands are written for; overridden in tests. */
  platform?: NodeJS.Platform;
  /** The platform whose service manager and daemon uninstall handles (the Windows stop-then-delete
   * sequence runs only for "win32"); overridden in tests. Defaults to process.platform. */
  servicePlatform?: NodeJS.Platform;
  /** True while a Headroom daemon for this home answers health; overridden in tests. */
  probeDaemon?: () => Promise<boolean>;
  /** Asks the daemon to shut down over its authenticated pipe (Windows); overridden in tests. */
  requestShutdown?: () => Promise<ShutdownOutcome>;
  /** Test seam so the bounded waits do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the Windows daemon to exit after the shutdown request (default 10 s). */
  stopWaitMs?: number;
}

/** Task Scheduler task name; matches service.ts's WINDOWS_TASK. */
const WINDOWS_TASK = "Headroom Daemon";
const WINDOWS_END_COMMAND = `schtasks /End /TN "${WINDOWS_TASK}"`;

interface UninstallOptions {
  home: boolean;
  yes: boolean;
  dryRun: boolean;
  rl: Interface | undefined;
  /** Set when the daemon was still running after the service step, so the home must not be deleted. */
  daemonStillRunning?: boolean;
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

async function defaultProbeDaemon(): Promise<boolean> {
  // Loaded lazily, as service.ts does: daemon.ts is the whole daemon. Dials the current pipe name and
  // falls back to the legacy one, so a daemon an older version started is seen too.
  const { daemonRequest, socketPath } = await import("./daemon.js");
  return (await daemonRequest(socketPath(), "health", {}, 500, 500)).status === "available";
}

async function defaultRequestShutdown(): Promise<ShutdownOutcome> {
  const { requestDaemonShutdown, socketPath } = await import("./daemon.js");
  return requestDaemonShutdown(socketPath());
}

/** Printed when the Windows daemon outlives the wait. Headroom has no way to verify a Windows process's
 * identity (process-tree.ts's identity checks need `ps`), so it never kills one by name or pid. */
function daemonStillRunningMessage(waitMs: number, why: string): string[] {
  return [
    `  the Headroom daemon is still running ${Math.round(waitMs / 1000)}s after it was asked to stop: ${why}.`,
    "  Headroom cannot verify a Windows process's identity, so it does not kill it.",
    "  Stop it yourself (Task Manager: the node.exe running `headroom daemon`, or Ctrl+C in its window), then run `headroom uninstall --home` again.",
  ];
}

function shellQuote(value: string): string { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`; }

function claudeDisplayCommand(env: Record<string, string>, scope: "user" | "local", cwd?: string, platform: NodeJS.Platform = process.platform): string {
  const command = `claude mcp remove --scope ${scope} headroom`;
  if (platform === "win32") {
    // PowerShell: `env -u` and `(cd .. && ..)` do not exist there. The default profile must not inherit a CLAUDE_CONFIG_DIR either.
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const profile = env.CLAUDE_CONFIG_DIR ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(env.CLAUDE_CONFIG_DIR)}` : "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue";
    // A `;` list keeps going after a failed Set-Location, which would remove the
    // registration of whatever directory the user pasted this into; run the
    // removal only once the bound directory was actually entered.
    return cwd ? `if (Set-Location -LiteralPath ${psQuote(cwd)} -PassThru -ErrorAction SilentlyContinue) { ${profile}; ${command} }` : `${profile}; ${command}`;
  }
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
  const platform = overrides.servicePlatform ?? process.platform;
  const path = servicePath(platform);
  let present = true;
  try { await lstat(path); } catch { present = false; }
  if (!present) { console.log(`  no Headroom service found at ${path}; nothing to do`); return true; }
  const plan = await uninstallService(platform, homedir(), true);
  const waitMs = overrides.stopWaitMs ?? 10_000;
  if (options.dryRun) {
    if (platform === "win32") console.log(`  (dry run) would ask the daemon to shut down, wait up to ${Math.round(waitMs / 1000)}s for it to exit, then end the task (${WINDOWS_END_COMMAND})`);
    console.log(`  (dry run) would stop it: ${plan.command}`);
    console.log(`  (dry run) would remove ${path}`);
    return true;
  }
  const runServiceStop = overrides.runServiceStop ?? defaultRunServiceStop;
  let ok = true;
  if (platform === "win32") {
    // schtasks /Delete removes the task but not the daemon it already started, which then keeps
    // headroom.db open and makes deleting the home fail with EBUSY (#136). schtasks /End does not
    // stop it either (it ends only the task's cmd.exe wrapper), so ask the daemon itself to shut
    // down over its authenticated pipe, wait, bounded, for it to stop answering, and end the task
    // as a backup. A non-zero /End (the task was not running) is not itself a failure: the wait decides.
    console.log("  asking the daemon to shut down");
    const sleep = overrides.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const stop = await stopWindowsDaemon({
      requestShutdown: overrides.requestShutdown ?? defaultRequestShutdown,
      probe: overrides.probeDaemon ?? defaultProbeDaemon,
      end: async () => {
        console.log(`  ending the task: ${WINDOWS_END_COMMAND}`);
        try {
          const code = await runServiceStop(WINDOWS_END_COMMAND);
          if (code !== 0) console.log(`  end command exited ${code} (continuing; the task may not be running)`);
          return { code, output: "" };
        } catch (error) { console.log(`  end command failed: ${safeError(error)} (continuing)`); return { code: 1, output: safeError(error) }; }
      },
      sleep,
      waitMs,
    });
    if (stop.stopped) console.log("  the daemon is not running");
    else {
      for (const line of daemonStillRunningMessage(waitMs, windowsStopFailure(stop))) console.error(line);
      options.daemonStillRunning = true;
      ok = false;
    }
  }
  console.log(`  stopping it: ${plan.command}`);
  try {
    const code = await runServiceStop(plan.command);
    if (code !== 0) console.log(`  stop command exited ${code} (continuing; it may already be stopped)`);
  } catch (error) { console.log(`  stop command failed: ${safeError(error)} (continuing to remove the file)`); }
  try {
    await uninstallService(platform, homedir(), false);
    console.log(`  removed ${path}`);
  } catch (error) { console.error(`  failed: ${safeError(error)}`); return false; }
  return ok;
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
    const display = claudeDisplayCommand(profile, scope, cwd, overrides.platform);
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
async function stepHome(options: UninstallOptions, overrides: UninstallOverrides): Promise<boolean> {
  console.log("Step 3: delete the Headroom home directory");
  const path = headroomHome();
  if (!options.home) { console.log(`  skipped; pass --home to also delete ${path} (accounts.toml, config, database and logs go with it)`); return true; }
  console.log(`  this deletes ${path}, including accounts.toml, policy/routing config, the database and logs`);
  if (process.platform === "darwin") console.log("  the Keychain grant marker lives inside this directory; the macOS Keychain ACL granted to the probe binary itself disappears with that binary, not from this step");
  if (options.dryRun) { console.log(`  (dry run) would ask to delete ${path}`); return true; }
  const confirmed = options.yes ? true : options.rl ? isYes(await options.rl.question(`  Delete ${path}? [y/N] `)) : false;
  if (!confirmed) { console.log("  skipped; not deleted"); return true; }
  const windows = (overrides.servicePlatform ?? process.platform) === "win32";
  if (windows) {
    // Windows will not delete a file another process holds open, and a running daemon holds
    // headroom.db: deleting then would remove part of the home and fail on the rest. Delete only
    // once no daemon answers; this also covers a daemon started outside the service.
    if (options.daemonStillRunning) { console.error(`  not deleted: the daemon is still running (see step 1); ${path} was left in place`); return false; }
    const sleep = overrides.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    if (!(await waitForDaemonExit(overrides.probeDaemon ?? defaultProbeDaemon, sleep, 0))) {
      console.error(`  not deleted: a Headroom daemon for this home is still running; stop it, then run \`headroom uninstall --home\` again. ${path} was left in place`);
      return false;
    }
  }
  // On Windows a just-exited daemon can hold its handles for a moment, so retry briefly on EBUSY/EPERM.
  try { await rm(path, { recursive: true, force: true, ...(windows ? { maxRetries: 5, retryDelay: 200 } : {}) }); console.log(`  deleted ${path}`); }
  catch (error) {
    console.error(`  failed: ${safeError(error)}`);
    if (windows && (error as NodeJS.ErrnoException).code === "EBUSY") console.error("  a process still holds a file in the home open; close any running `headroom` command and run `headroom uninstall --home` again");
    return false;
  }
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
    if (!(await stepHome(options, overrides))) ok = false;
    console.log("");
    stepNpm();
    console.log("");
    console.log(ok ? "Uninstall finished." : "Uninstall finished with errors.");
    return ok ? 0 : 1;
  } finally { rl?.close(); }
}
