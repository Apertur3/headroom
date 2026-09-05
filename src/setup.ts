import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { promisify } from "node:util";
import { doctor, doctorChecks, type DoctorCheck } from "./doctor.js";
import { isAccountsMissingError, keychain, observe } from "./cli.js";
import { accountsPath, accountsToml, discoverAccounts, writeDiscoveredAccounts } from "./registry.js";
import { installService } from "./service.js";
import { safeError } from "./security.js";

const execFileAsync = promisify(execFile);

export interface SetupOverrides {
  /** Real Keychain access; overridden in tests so no dialog is ever attempted. */
  keychainGrant?: (argv: string[]) => Promise<number>;
  /** Checks PATH for the `claude` command; overridden in tests to avoid depending on the machine. */
  claudeOnPath?: () => Promise<boolean>;
  /** Runs `claude mcp add ...` for real; overridden in tests so `~/.claude.json` is never touched. */
  runClaudeMcpAdd?: () => Promise<number>;
}

interface SetupOptions {
  yes: boolean;
  dryRun: boolean;
  skipService: boolean;
  skipMcp: boolean;
  /** True only when nothing this run does is allowed to change anything: either --dry-run, or
   * stdin is not a TTY and --yes was not passed. No question is ever asked in this mode; every
   * step narrates what it would have done and moves on, so a script can never get stuck on a
   * prompt it cannot answer. */
  planOnly: boolean;
  interactive: boolean;
  rl: Interface | undefined;
}

async function defaultClaudeOnPath(): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", ["claude"]);
    return true;
  } catch { return false; }
}

function defaultRunClaudeMcpAdd(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["mcp", "add", "headroom", "--", "headroom", "mcp"], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** y/Y/Enter is yes; anything else skips the step. */
function isYes(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
}

async function confirm(options: SetupOptions, question: string): Promise<boolean> {
  if (options.yes) return true;
  if (!options.rl) return false;
  return isYes(await options.rl.question(`${question} [y/N] `));
}

/** Reports a step's own thrown error and, only when a person is present to answer, asks whether
 * to keep going. With no one to ask (planOnly, or --yes with no TTY) setup keeps going on its
 * own -- there is no user decision to make exit code 1 for. */
async function surviveStepError(options: SetupOptions, error: unknown): Promise<boolean> {
  console.error(`  failed: ${safeError(error)}`);
  if (!options.rl) return true;
  const keepGoing = isYes(await options.rl.question("Continue with the remaining steps? [y/N] "));
  if (!keepGoing) console.log("Stopping.");
  return keepGoing;
}

async function stepDiscoverAccounts(options: SetupOptions): Promise<boolean> {
  console.log("Step 1: discover accounts (scan for Claude, Codex and Antigravity logins)");
  const path = accountsPath();
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch { existing = undefined; }
  if (existing !== undefined) {
    console.log(`accounts.toml already exists at ${path}:`);
    console.log(existing.trimEnd());
  }
  const question = existing !== undefined ? "Rerun discovery and overwrite accounts.toml?" : "Scan for Claude, Codex and Antigravity accounts and write accounts.toml?";
  if (options.planOnly) {
    console.log(`(dry run) would ask: ${question}`);
    try {
      const accounts = await discoverAccounts();
      console.log(accountsToml(accounts).trimEnd() || "(no accounts found)");
      console.log(`(dry run) would write ${path} (${accounts.length} account${accounts.length === 1 ? "" : "s"})`);
    } catch (error) { return surviveStepError(options, error); }
    return true;
  }
  if (!(await confirm(options, question))) {
    console.log(existing !== undefined ? "Keeping the existing accounts.toml." : "Skipped; run `headroom accounts discover` later.");
    return true;
  }
  try {
    const accounts = await discoverAccounts();
    console.log(accountsToml(accounts).trimEnd() || "(no accounts found)");
    await writeDiscoveredAccounts(accounts);
    console.log(`Wrote ${path} (${accounts.length} account${accounts.length === 1 ? "" : "s"}).`);
  } catch (error) { return surviveStepError(options, error); }
  return true;
}

async function stepDoctor(): Promise<boolean> {
  console.log("Step 2: run doctor");
  try { await doctor(); }
  catch (error) { console.error(`  failed: ${safeError(error)}`); }
  return true;
}

function keychainAccountName(check: DoctorCheck): string | undefined {
  return /^principal (\S+) (?:credential|keychain grant)$/.exec(check.check)?.[1];
}

async function stepKeychainGrant(options: SetupOptions, overrides: SetupOverrides): Promise<boolean> {
  console.log("Step 3: grant Keychain access");
  if (process.platform !== "darwin") {
    console.log("  skipped; not macOS");
    return true;
  }
  const keychainGrant = overrides.keychainGrant ?? keychain;
  let checks: DoctorCheck[];
  try { checks = await doctorChecks(); }
  catch (error) { return surviveStepError(options, error); }
  const needed = checks.filter((item) => item.level === "FAIL" && item.fix.startsWith("headroom keychain grant"));
  const names = [...new Set(needed.map(keychainAccountName).filter((name): name is string => name !== undefined))];
  if (!names.length) {
    console.log("  already granted for every configured Claude principal (or none configured)");
    return true;
  }
  console.log("  This opens one macOS Keychain access dialog per principal below. Answer it with Always Allow, or every future poll will prompt again.");
  const commands = names.map((name) => `headroom keychain grant --principal ${name}`);
  if (options.planOnly) {
    for (const command of commands) console.log(`  (dry run) would run: ${command}`);
    return true;
  }
  if (options.yes) {
    // The one step --yes never runs on its own: print what the user needs to run themselves.
    for (const command of commands) console.log(`  run this yourself: ${command}`);
    return true;
  }
  if (!(await confirm(options, `  Run ${commands.length === 1 ? commands[0] : `${commands.length} Keychain grants`} now?`))) {
    for (const command of commands) console.log(`  skipped; run later: ${command}`);
    return true;
  }
  for (const name of names) {
    try { await keychainGrant(["grant", "--principal", name]); }
    catch (error) { if (!(await surviveStepError(options, error))) return false; }
  }
  return true;
}

async function stepInstallService(options: SetupOptions): Promise<boolean> {
  console.log("Step 4: install the background service (launchd, systemd user unit, or Windows Task Scheduler)");
  if (options.skipService) {
    console.log("  skipped via --skip-service");
    return true;
  }
  if (options.planOnly) {
    try {
      const result = await installService(process.argv[1], process.platform, undefined, process.execPath, true);
      console.log(`  (dry run) would write ${result.path}`);
      console.log(`  (dry run) to load it: ${result.command}`);
    } catch (error) { return surviveStepError(options, error); }
    return true;
  }
  if (!(await confirm(options, "  Install the Headroom background service now?"))) {
    console.log("  skipped; run `headroom install-service` later");
    return true;
  }
  try {
    const result = await installService(process.argv[1], process.platform, undefined, process.execPath, false);
    console.log(`  wrote ${result.path}`);
    console.log(`  to load it: ${result.command}`);
  } catch (error) { return surviveStepError(options, error); }
  return true;
}

async function stepMcp(options: SetupOptions, overrides: SetupOverrides): Promise<boolean> {
  console.log("Step 5: register the MCP server for Claude Code");
  if (options.skipMcp) {
    console.log("  skipped via --skip-mcp");
    return true;
  }
  console.log("  claude mcp add headroom -- headroom mcp");
  const claudeOnPath = overrides.claudeOnPath ?? defaultClaudeOnPath;
  const runClaudeMcpAdd = overrides.runClaudeMcpAdd ?? defaultRunClaudeMcpAdd;
  let onPath: boolean;
  try { onPath = await claudeOnPath(); }
  catch (error) { return surviveStepError(options, error); }
  if (!onPath) {
    console.log("  `claude` was not found on PATH; run the command above yourself once it is");
    return true;
  }
  if (options.planOnly) {
    console.log("  (dry run) would offer to run this now");
    return true;
  }
  if (!(await confirm(options, "  Run this now to register the MCP server?"))) {
    console.log("  skipped; run the command above yourself");
    return true;
  }
  try {
    const code = await runClaudeMcpAdd();
    console.log(code === 0 ? "  registered" : `  claude mcp add exited with code ${code}`);
  } catch (error) { return surviveStepError(options, error); }
  return true;
}

async function stepFinalCheck(): Promise<boolean> {
  console.log("Step 6: final check");
  try { await doctor(); await observe([]); }
  catch (error) {
    console.error(isAccountsMissingError(error) ? "  No accounts configured yet. Run: headroom accounts discover" : `  failed: ${safeError(error)}`);
  }
  console.log("Pace legend: HARVEST = spend it before it expires, NORMAL = proceed, CONSERVE = slow down, FREEZE = do not spawn, UNKNOWN = treat as no capacity.");
  return true;
}

/**
 * One-shot interactive setup for a person without an agent: it composes the same commands
 * `skills/headroom/SKILL.md` tells an agent to run, in the same order, asking before anything
 * that changes something. Reuses `discoverAccounts`/`doctor`/`keychain`/`installService` rather
 * than re-implementing any of their logic.
 */
export async function runSetup(argv: string[], overrides: SetupOverrides = {}): Promise<number> {
  const known = new Set(["--yes", "--dry-run", "--skip-service", "--skip-mcp"]);
  for (const arg of argv) if (!known.has(arg)) throw new Error("Usage: headroom setup [--yes] [--dry-run] [--skip-service] [--skip-mcp]");
  const yes = argv.includes("--yes");
  const dryRun = argv.includes("--dry-run");
  const skipService = argv.includes("--skip-service");
  const skipMcp = argv.includes("--skip-mcp");
  const interactive = process.stdin.isTTY === true && !dryRun;
  const planOnly = dryRun || (!interactive && !yes);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const options: SetupOptions = { yes, dryRun, skipService, skipMcp, planOnly, interactive, rl };
  try {
    console.log("Headroom setup");
    if (planOnly) console.log("(nothing will change; showing the plan)");
    for (const step of [
      () => stepDiscoverAccounts(options),
      () => stepDoctor(),
      () => stepKeychainGrant(options, overrides),
      () => stepInstallService(options),
      () => stepMcp(options, overrides),
      () => stepFinalCheck(),
    ]) {
      console.log("");
      if (!(await step())) return 1;
    }
    console.log("");
    console.log("Setup finished.");
    return 0;
  } finally { rl?.close(); }
}
