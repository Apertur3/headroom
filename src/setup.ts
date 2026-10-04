import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { promisify } from "node:util";
import { configureNotifications, type Ask } from "./notify-configure.js";
import { doctor } from "./doctor.js";
import { CLAUDE_MCP_ADD_ARGS, MCP_ADD_COMMAND } from "./mcp-registration.js";
import { isAccountsMissingError, NoAccountsConfiguredError, NO_ACCOUNTS_MESSAGE, observe } from "./cli.js";
import { accountsPath, accountsToml, discoverAccounts, writeDiscoveredAccounts } from "./registry.js";
import { describeServiceStart, installAndStartService, installService, type ServiceStartOptions } from "./service.js";
import { safeError } from "./security.js";
import { installHook, SAMPLE_LINE, TOKEN_COST_NOTE } from "./agent-hook.js";

const execFileAsync = promisify(execFile);

export const SETUP_USAGE = "Usage: headroom setup [--yes] [--dry-run] [--skip-service] [--skip-mcp] [--hook]";

export interface SetupOverrides {
  ask?: Ask;
  configureNotify?: (ask: Ask) => Promise<number>;
  /** Checks PATH for the `claude` command; overridden in tests to avoid depending on the machine. */
  claudeOnPath?: () => Promise<boolean>;
  /** Runs `claude mcp add ...` for real; overridden in tests so `~/.claude.json` is never touched. */
  runClaudeMcpAdd?: () => Promise<number>;
  /** Service-manager and daemon-probe stand-ins for the service step; overridden in tests so launchctl, systemctl and schtasks are never run. */
  serviceStart?: ServiceStartOptions;
  /** Replaces the final doctor + observe; overridden in tests so no real Keychain, vendor or native probe is ever queried. */
  finalCheck?: () => Promise<void>;
  /** Installs the agent quota-line hook; defaults to `headroom hook install --agent claude`. */
  installHook?: () => Promise<number>;
}

interface SetupOptions {
  yes: boolean;
  dryRun: boolean;
  skipService: boolean;
  skipMcp: boolean;
  /** --hook: install the agent quota-line hook without asking (the only way --yes installs it). */
  hook: boolean;
  /** True only when nothing this run does is allowed to change anything: either --dry-run, or
   * stdin is not a TTY and --yes was not passed. No question is ever asked in this mode; every
   * step narrates what it would have done and moves on, so a script can never get stuck on a
   * prompt it cannot answer. */
  planOnly: boolean;
  interactive: boolean;
  rl: Pick<Interface, "question"> | undefined;
}

async function defaultClaudeOnPath(): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", ["claude"]);
    return true;
  } catch { return false; }
}

function defaultRunClaudeMcpAdd(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", CLAUDE_MCP_ADD_ARGS, { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Only an explicit y/Y/yes/Yes is yes; Enter (and anything else) matches the
 * displayed `[y/N]` default and skips the step. Exported for tests: exercising
 * this directly is far simpler than driving a real TTY through readline. */
export function isYes(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
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
    // --yes must not clobber hand-edited accounts; overwriting needs an explicit answer.
    if (options.yes && !options.planOnly) {
      console.log("Keeping the existing accounts.toml (rerun `headroom accounts discover` to rewrite it).");
      return true;
    }
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

async function stepDoctor(options: SetupOptions): Promise<boolean> {
  console.log("Step 2: run doctor");
  if (process.platform === "darwin") console.log("  macOS: no Keychain dialog to answer; the Claude credential is read through /usr/bin/security, which the item already admits.");
  if (options.planOnly) {
    // doctor() opens (and so creates) the Headroom home database and, on
    // macOS, looks up Keychain item metadata for each configured Claude
    // principal. Describe it instead of running it in plan mode.
    console.log("  (dry run) would run: headroom doctor (installation diagnostics; creates the Headroom home database if it does not exist yet, and on macOS looks up Keychain item metadata -- never the secret itself -- for each configured Claude principal)");
    return true;
  }
  try { await doctor(); }
  catch (error) { console.error(`  failed: ${safeError(error)}`); }
  return true;
}

async function stepInstallService(options: SetupOptions, overrides: SetupOverrides): Promise<boolean> {
  console.log("Step 3: install the background service (launchd, systemd user unit, or Windows Task Scheduler)");
  if (options.skipService) {
    console.log("  skipped via --skip-service");
    return true;
  }
  if (options.planOnly) {
    try {
      const result = await installService(process.argv[1], process.platform, undefined, process.execPath, true);
      console.log(`  (dry run) would write ${result.path}`);
      console.log(`  (dry run) to load it: ${result.command}`);
      console.log(`  (dry run) the service would run: ${result.runtime} ${result.script} daemon`);
    } catch (error) { return surviveStepError(options, error); }
    return true;
  }
  if (!(await confirm(options, "  Install the Headroom background service now?"))) {
    console.log("  skipped; run `headroom install-service` later");
    return true;
  }
  try {
    const started = await installAndStartService(process.argv[1], process.platform, undefined, process.execPath, process.env, undefined, overrides.serviceStart);
    describeServiceStart(started).forEach((line) => console.log(`  ${line}`));
    if (started.install) console.log(`  the service will run: ${started.install.runtime} ${started.install.script} daemon`);
  } catch (error) { return surviveStepError(options, error); }
  return true;
}

export async function stepNotifications(options: { yes: boolean; planOnly: boolean; rl?: Pick<Interface, "question"> }, overrides: SetupOverrides = {}): Promise<boolean> {
  console.log("Notifications (optional)");
  if (options.yes || options.planOnly || !options.rl) {
    console.log("  skipped; run `headroom notify configure` later");
    return true;
  }
  if (!isYes(await options.rl.question("Notifications? [y/N] "))) {
    console.log("  skipped; run `headroom notify configure` later");
    return true;
  }
  const ask: Ask = (question) => options.rl!.question(question);
  const code = await (overrides.configureNotify ?? ((ask: Ask) => configureNotifications([], { ask })))(ask);
  if (code) console.log("  Notifications need attention; run `headroom notify configure` later");
  return true;
}

async function stepMcp(options: SetupOptions, overrides: SetupOverrides): Promise<boolean> {
  console.log("Step 4: register the MCP server for Claude Code");
  if (options.skipMcp) {
    console.log("  skipped via --skip-mcp");
    return true;
  }
  console.log(`  ${MCP_ADD_COMMAND}`);
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
    console.log(code === 0 ? "  registered" : `  claude mcp add exited with code ${code} (if it said the server already exists, it is already registered)`);
  } catch (error) { return surviveStepError(options, error); }
  return true;
}

/** Enter and y/yes are yes; only n/no declines. For the one step whose
 * displayed default is `[Y/n]`. */
export function isYesDefault(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed !== "n" && trimmed !== "no";
}

/**
 * The agent quota line (issue #149). Offered, never silent: an interactive
 * run asks with a sample line and the token cost, default yes; `--yes` alone
 * skips it, and only `--hook` installs it without a question.
 */
export async function stepAgentHook(options: Pick<SetupOptions, "yes" | "planOnly" | "hook" | "rl">, overrides: SetupOverrides = {}): Promise<boolean> {
  console.log("Agent quota line (optional)");
  console.log("  Adds one line to every Claude Code prompt so the agent sees live quota before it plans, for example:");
  console.log(`    ${SAMPLE_LINE}`);
  console.log(`  Cost: ${TOKEN_COST_NOTE}. Remove it any time with: headroom hook uninstall --agent claude`);
  if (process.platform === "win32") { console.log("  not supported on Windows yet; `headroom line` prints the same line"); return true; }
  if (options.planOnly) { console.log(`  (dry run) would ${options.hook ? "install it (--hook)" : "ask: Add the quota line to every Claude Code prompt? [Y/n]"}`); return true; }
  let install = options.hook;
  if (!install && options.yes) { console.log("  skipped (--yes installs it only with --hook); run `headroom hook install --agent claude` later"); return true; }
  if (!install && options.rl) install = isYesDefault(await options.rl.question("  Add the quota line to every Claude Code prompt? [Y/n] "));
  if (!install) { console.log("  skipped; run `headroom hook install --agent claude` later"); return true; }
  try {
    const code = await (overrides.installHook ?? (() => installHook({ log: (line) => console.log(`  ${line}`) })))();
    if (code) console.log("  the hook was not installed everywhere; see above, then run `headroom hook install --agent claude`");
  } catch (error) { return surviveStepError({ rl: options.rl } as SetupOptions, error); }
  return true;
}

async function stepFinalCheck(options: SetupOptions, overrides: SetupOverrides): Promise<boolean> {
  console.log("Step 5: final check");
  if (options.planOnly) {
    // observe() (with no daemon running, the common case for a first-time
    // plan) polls every configured principal directly, which can make a
    // real, credential-backed vendor call. A plan must call no vendor.
    console.log("  (dry run) would run: headroom doctor and headroom observe (installation diagnostics plus a live usage read, which can call configured vendors using their real credentials)");
    console.log("Pace legend: HARVEST = spend it before it expires, NORMAL = proceed, CONSERVE = slow down, FREEZE = do not spawn, UNKNOWN = treat as no capacity.");
    return true;
  }
  try { if (overrides.finalCheck) await overrides.finalCheck(); else { await doctor(); await observe([]); } }
  catch (error) {
    console.error(isAccountsMissingError(error) || error instanceof NoAccountsConfiguredError ? `  ${NO_ACCOUNTS_MESSAGE}` : `  failed: ${safeError(error)}`);
  }
  console.log("Pace legend: HARVEST = spend it before it expires, NORMAL = proceed, CONSERVE = slow down, FREEZE = do not spawn, UNKNOWN = treat as no capacity.");
  return true;
}

/**
 * One-shot interactive setup for a person without an agent: it composes the same commands
 * `skills/headroom/SKILL.md` tells an agent to run, in the same order, asking before anything
 * that changes something. Reuses `discoverAccounts`/`doctor`/`installService` rather
 * than re-implementing any of their logic.
 */
export async function runSetup(argv: string[], overrides: SetupOverrides = {}): Promise<number> {
  const known = new Set(["--yes", "--dry-run", "--skip-service", "--skip-mcp", "--hook"]);
  for (const arg of argv) if (!known.has(arg)) throw new Error(SETUP_USAGE);
  const yes = argv.includes("--yes");
  const dryRun = argv.includes("--dry-run");
  const skipService = argv.includes("--skip-service");
  const skipMcp = argv.includes("--skip-mcp");
  const hook = argv.includes("--hook");
  const interactive = (process.stdin.isTTY === true || overrides.ask !== undefined) && !dryRun;
  const planOnly = dryRun || (!interactive && !yes);
  const rl = interactive && !overrides.ask ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const options: SetupOptions = { yes, dryRun, skipService, skipMcp, hook, planOnly, interactive, rl: overrides.ask && interactive ? { question: overrides.ask } : rl };
  try {
    console.log("Headroom setup");
    if (planOnly) console.log("(nothing will change; showing the plan)");
    for (const step of [
      () => stepDiscoverAccounts(options),
      () => stepDoctor(options),
      () => stepInstallService(options, overrides),
      () => stepNotifications(options, overrides).catch((error: unknown) => surviveStepError(options, error)),
      () => stepMcp(options, overrides),
      () => stepAgentHook(options, overrides),
      () => stepFinalCheck(options, overrides),
    ]) {
      console.log("");
      if (!(await step())) return 1;
    }
    console.log("");
    console.log("Setup finished.");
    return 0;
  } finally { rl?.close(); }
}
