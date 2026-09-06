import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { claudeServiceName, resolveProbePath, syncClaudeGrantState } from "./adapters/claude.js";
import { discoverGeminiOAuthClientDetail } from "./adapters/antigravity.js";
import { grokAuthPath } from "./adapters/grok.js";
import { kimiTokenPath } from "./adapters/kimi.js";
import { readPolicy, readRouting } from "./config.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { engineStatus } from "./engine/codexbar/install.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { daemonLogPath } from "./logs.js";
import { credentialPath, headroomHome } from "./paths.js";
import { accountsPath, readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type Account, type ProviderAccount } from "./types.js";
import { headroomVersion } from "./version.js";

const execFileAsync = promisify(execFile);
export type DoctorLevel = "OK" | "INFO" | "WARN" | "FAIL";
export interface DoctorCheck { level: DoctorLevel; check: string; detail: string; fix: string; }

function check(level: DoctorLevel, name: string, detail: string, fix: string): DoctorCheck { return { level, check: name, detail, fix }; }
function rendered(item: DoctorCheck): string { return `${item.level.padEnd(4)} ${item.check}: ${item.detail} — ${item.fix}`; }

type FileStatus = "present" | "missing" | "unsafe";

/** Config and service-managed logs are intentionally allowed to be 0644; only
 * ownership, links, and writable permissions make these paths unsafe. */
export async function doctorFileStatus(path: string): Promise<FileStatus> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return "unsafe";
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "unsafe";
    if (process.platform !== "win32" && (info.mode & 0o022) !== 0) return "unsafe";
    return "present";
  } catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe"; }
}

async function credentialCheck(account: Account, grantsNeeded: Map<string, string>, store: HeadroomStore | undefined): Promise<DoctorCheck> {
  if (isLocalAccount(account)) return check("OK", `principal ${account.name} credential`, "local adapter has no credential", "no action needed");
  if (account.vendor === "claude" && process.platform === "darwin") {
    // A principal already marked grant-needed must never touch the Keychain
    // item again here: the keychainGrantCheck below already reports the same
    // FAIL, and probing anyway is exactly the extra Keychain touch the
    // marker exists to prevent until the operator runs `keychain grant`.
    if (grantsNeeded.has(account.name)) {
      store?.audit("doctor", "claude_probe", account.name, "skipped: grant needed");
      return check("FAIL", `principal ${account.name} credential`, "Keychain grant needed; probe skipped", `headroom keychain grant --principal ${account.name}`);
    }
    try {
      // Do not pass -w: doctor verifies Keychain metadata without ever reading a token.
      await execFileAsync("security", ["find-generic-password", "-s", claudeServiceName(account.location)]);
      store?.audit("doctor", "claude_probe", account.name, "called");
      return check("OK", `principal ${account.name} credential`, "Claude Keychain item present", "no action needed");
    } catch {
      store?.audit("doctor", "claude_probe", account.name, "called");
      return check("FAIL", `principal ${account.name} credential`, "Claude Keychain item is unavailable", `headroom keychain grant --principal ${account.name}`);
    }
  }
  if (account.vendor === "grok") {
    // `location` may name the token file itself or the directory holding it.
    const grokPath = grokAuthPath(account.location);
    return (await doctorFileStatus(grokPath)) === "present"
      ? check("OK", `principal ${account.name} credential`, `credential file present (${grokPath})`, "no action needed")
      : check("FAIL", `principal ${account.name} credential`, `missing or unsafe credential file (${grokPath})`, "run: grok login");
  }
  if (account.vendor === "kimi") {
    // `location` is the token file the operator writes themselves. The adapter
    // refuses one anyone else can read, so doctor holds it to that same 0600
    // bar rather than the looser config-file bar above.
    const kimiPath = kimiTokenPath(account.location);
    const status = await doctorFileStatus(kimiPath);
    const shared = status === "present" && process.platform !== "win32" && ((await lstat(kimiPath)).mode & 0o077) !== 0;
    return status === "present" && !shared
      ? check("OK", `principal ${account.name} credential`, `token file present (${kimiPath})`, "no action needed")
      : check("FAIL", `principal ${account.name} credential`, shared ? `token file is readable by group or other (${kimiPath})` : `missing or unsafe token file (${kimiPath})`, `save the kimi-auth token to ${kimiPath}, then: chmod 600 ${kimiPath}`);
  }
  const path = credentialPath(account.vendor, account.vendor === "antigravity" ? undefined : account.location);
  return (await doctorFileStatus(path)) === "present"
    ? check("OK", `principal ${account.name} credential`, `credential file present (${path})`, "no action needed")
    : check("FAIL", `principal ${account.name} credential`, `missing or unsafe credential file (${path})`, account.vendor === "antigravity" ? "run: gemini" : `run: ${account.vendor}`);
}

/** Opening the store creates ~/.headroom at 0700 on a fresh machine (the same
 * mkdir every other Headroom entry point uses) and, on an existing home with
 * group/world permissions, surfaces the same refusal every other command
 * hits -- as an actionable FAIL instead of a crash with no doctor coverage. */
export async function homeCheck(home: string): Promise<{ check: DoctorCheck; store: HeadroomStore | undefined }> {
  try {
    const store = await HeadroomStore.open(home);
    // NTFS has no POSIX mode bits, and safeHeadroomDirectory() (store.ts)
    // skips the group/world-writable check entirely on win32 for exactly
    // that reason -- so a directory that opened successfully here has had no
    // permission enforcement to speak of on Windows, unlike everywhere else.
    // Say so plainly instead of reporting a bare OK that reads the same as a
    // real POSIX pass.
    const detail = process.platform === "win32" ? `${home} (group/world permission checks are not applicable on Windows; relying on NTFS ACLs)` : home;
    return { check: check("OK", "home directory", detail, "no action needed"), store };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unsafe Headroom home directory";
    const fix = /group or world permissions/.test(message) ? "chmod 700 ~/.headroom" : `fix ownership or permissions on ${home}`;
    return { check: check("FAIL", "home directory", message, fix), store: undefined };
  }
}

export function keychainGrantCheck(account: Account, grantsNeeded: Map<string, string>): DoctorCheck | undefined {
  if (isLocalAccount(account) || account.vendor !== "claude") return undefined;
  const reason = grantsNeeded.get(account.name);
  if (reason === undefined) return undefined;
  return check("FAIL", `principal ${account.name} keychain grant`, `Keychain grant needed; run this from your own terminal (macOS shows a Keychain dialog that cannot appear in a sandboxed or remote shell): headroom keychain grant --principal ${account.name}`, `headroom keychain grant --principal ${account.name}`);
}

/**
 * A machine that has both a packaged install and a repo checkout (or two
 * different global installs) can have more than one `headroom-claude-probe`
 * binary resolvable at once. Once a grant has pinned one (store.probePath()),
 * claude.ts's own resolution always prefers it over any other candidate --
 * this check exists only to say so out loud, naming both the granted binary
 * and any other one that currently resolves but is deliberately not used,
 * rather than leaving an operator to wonder why a probe rebuild had no
 * effect. Undefined when there is nothing to report: no Claude principal
 * configured, or (non-macOS) the probe concept does not apply.
 */
export async function probePinCheck(store: HeadroomStore, claudeIds: string[]): Promise<DoctorCheck | undefined> {
  if (process.platform !== "darwin" || !claudeIds.length) return undefined;
  const pinned = store.probePath();
  if (!pinned) return check("INFO", "claude probe binary", "no probe granted yet for this Headroom home", "headroom keychain grant");
  const resolvedWithPin = await resolveProbePath(pinned);
  if (resolvedWithPin !== pinned) {
    return check(resolvedWithPin ? "WARN" : "FAIL", "claude probe binary",
      resolvedWithPin ? `granted binary is gone (${pinned}); currently falling back to ${resolvedWithPin} instead` : `granted binary is gone (${pinned}) and no other probe resolves`,
      "headroom keychain grant");
  }
  const resolvedWithoutPin = await resolveProbePath();
  if (resolvedWithoutPin && resolvedWithoutPin !== pinned) {
    return check("INFO", "claude probe binary", `granted: ${pinned}; not granted (a second candidate exists but is not used): ${resolvedWithoutPin}`, "no action needed; run headroom keychain grant again only to switch to the other binary");
  }
  return check("OK", "claude probe binary", `granted: ${pinned}`, "no action needed");
}

export function adapterCheck(account: Account): DoctorCheck {
  if (isLocalAccount(account)) return check("OK", `principal ${account.name} adapter`, "native local adapter selected", "no action needed");
  const level: DoctorLevel = account.adapter === "pending" ? "FAIL" : account.adapter === "codexbar" ? "WARN" : "OK";
  const fix = account.adapter === "pending" ? "run: headroom accounts discover" : account.adapter === "codexbar" ? "run: headroom engine install, or rediscover for native-ts" : "no action needed";
  // CodexBarCore (the optional Swift engine's dependency) performs its own
  // authenticated HTTP request outside Headroom's outbound allowlist; make
  // that visible at every `doctor` run, not only in SECURITY.md.
  const detail = account.adapter === "codexbar"
    ? `${account.vendor} uses codexbar; this optional engine performs its own network calls outside Headroom's outbound allowlist, and its readings are marked truth: estimated`
    : `${account.vendor} uses ${account.adapter}`;
  return check(level, `principal ${account.name} adapter`, detail, fix);
}

async function configCheck(name: "policy" | "routing", path: string): Promise<DoctorCheck> {
  try {
    const status = await doctorFileStatus(path);
    if (status === "missing") return check("INFO", name, `not present; using built-in defaults (${path})`, name === "policy" ? "copy examples/policy.toml to this path" : "create routing.toml with [consumes]");
    if (status === "unsafe") return check("FAIL", name, `unsafe file (${path})`, `fix ownership or writable permissions on ${path}`);
    await (name === "policy" ? readPolicy() : readRouting());
    return check("OK", name, `valid ${path}`, "no action needed");
  } catch (error) {
    return check("FAIL", name, error instanceof Error ? error.message : "invalid configuration", `fix ${path}`);
  }
}

/** A non-mutating installation diagnostic. It deliberately never opens credential contents. */
export async function doctorChecks(): Promise<DoctorCheck[]> {
  const home = headroomHome();
  const output: DoctorCheck[] = [];
  const { check: homeResult, store } = await homeCheck(home);
  output.push(homeResult);
  try {
    let keepaliveEnabled = process.platform === "darwin" || process.platform === "linux";
    try { keepaliveEnabled = (await readPolicy()).antigravity_keepalive; } catch { /* The policy check below reports the parse error. */ }
    let accounts: Account[] = [];
    try {
      accounts = await readAccounts();
      output.push(check(accounts.length ? "OK" : "WARN", "principals", accounts.length ? `${accounts.length} configured (${accountsPath()})` : "no principals configured", accounts.length ? "no action needed" : "headroom accounts discover"));
    } catch (error) {
      // A never-created accounts.toml (first run, before `accounts discover`)
      // has no configured principal to block reading -- WARN, matching the
      // empty-registry case just above. A present but unparseable file is a
      // real, blocking misconfiguration and stays FAIL.
      const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
      output.push(check(missing ? "WARN" : "FAIL", "principals", missing ? `missing ${accountsPath()}` : "accounts.toml is invalid", "headroom accounts discover"));
    }
    // Runs even when `headroom doctor` is the very first command ever
    // invoked (no prior daemon poll or CLI observe()), so a fresh install or
    // a freshly rebuilt probe binary is caught here too, before credentialCheck
    // below ever touches the Keychain.
    let probePin: DoctorCheck | undefined;
    if (store) {
      const claudeIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude").map((account) => account.name);
      await syncClaudeGrantState(store, claudeIds);
      probePin = await probePinCheck(store, claudeIds);
    }
    const grantsNeeded = store ? new Map(store.keychainGrantsNeeded().map((item) => [item.principal_id, item.reason])) : new Map<string, string>();
    for (const account of accounts) {
      output.push(await credentialCheck(account, grantsNeeded, store));
      const grant = keychainGrantCheck(account, grantsNeeded);
      if (grant) output.push(grant);
      output.push(adapterCheck(account));
    }
    if (probePin) output.push(probePin);
    await doctorChecksTail(output, home, accounts, keepaliveEnabled);
  } finally { store?.close(); }
  return output;
}

async function doctorChecksTail(output: DoctorCheck[], home: string, accounts: Account[], keepaliveEnabled: boolean): Promise<void> {
  const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath()]);
  output.push(upstream.present
    ? check("OK", "engine upstream hash", `${upstream.tag} verified (${upstream.path})`, "no action needed")
    : check("INFO", "engine upstream hash", `${upstream.tag} absent or hash mismatch; optional, needed only for providers without a native adapter`, "headroom engine install"));
  output.push(native
    ? check(native.includes(`${home}/engine/native/`) ? "OK" : "INFO", "engine native hash", native.includes(`${home}/engine/native/`) ? `verified (${native})` : `development binary (${native}) is not release-pinned`, native.includes(`${home}/engine/native/`) ? "no action needed" : "build a pinned native release or run headroom engine install")
    : check("INFO", "engine native hash", "no verified native engine", "npm run engine:build or headroom engine install"));

  if (accounts.some((account) => !isLocalAccount(account) && account.vendor === "antigravity")) {
    // Best-effort and never blocking: env overrides always resolve
    // instantly, and the real Homebrew/npm-global candidate paths are a
    // bounded, local filesystem walk. Never reads or logs the client id or
    // secret themselves, only which layout matched.
    let detail: Awaited<ReturnType<typeof discoverGeminiOAuthClientDetail>>;
    try { detail = await discoverGeminiOAuthClientDetail(); } catch { detail = undefined; }
    output.push(detail
      ? check("OK", "Antigravity OAuth client", `resolved via ${detail.layout}`, "no action needed")
      : check("WARN", "Antigravity OAuth client", "could not locate the Gemini CLI's bundled OAuth client", "install the Gemini CLI, or set GEMINI_OAUTH_CLIENT_ID/GEMINI_OAUTH_CLIENT_SECRET"));
  }

  const daemon = await daemonRequest(socketPath(), "health");
  if (daemon.status === "available") {
    output.push(check("OK", "daemon socket", socketPath(), "no action needed"));
    output.push(check("OK", "daemon health", "responding", "no action needed"));
    const health = daemon.result as { keepalive?: { running?: boolean; pid?: number | null; uptime_ms?: number | null; login_state?: "unknown" | "logged_in" | "not_logged_in"; local_reads?: Record<string, { outcome?: string; payload_kind?: string }> } };
    const antigravity = accounts.find((account) => !isLocalAccount(account) && account.vendor === "antigravity");
    const keepalive = health.keepalive;
    if (!antigravity) output.push(check("OK", "Antigravity keepalive", "no Antigravity principal configured", "no action needed"));
    else if (!keepaliveEnabled) output.push(check("OK", "Antigravity keepalive", "disabled by policy; no agy process expected", "set antigravity_keepalive = true to enable warm local summaries"));
    else if (keepalive?.running && keepalive.pid) {
      const local = antigravity ? keepalive.local_reads?.[antigravity.name] : undefined;
      const uptime = keepalive.uptime_ms === undefined || keepalive.uptime_ms === null ? "?" : `${Math.floor(keepalive.uptime_ms / 1000)}s`;
      const read = local ? `; local ${local.outcome ?? "unknown"} (${local.payload_kind ?? "unknown"})` : "; local read not recorded yet";
      const state = keepalive.login_state === "logged_in" ? "logged in" : keepalive.login_state === "not_logged_in" ? "not logged in" : "login state pending";
      const level: DoctorLevel = keepalive.login_state === "not_logged_in" ? "WARN" : "OK";
      const fix = keepalive.login_state === "not_logged_in" ? "run: agy" : "no action needed";
      output.push(check(level, "Antigravity keepalive", `agy: pid ${keepalive.pid}, up ${uptime}, ${state}${read}`, fix));
    }
    // Not a FAIL: keepalive is secondary now that the remote quota endpoint
    // can answer directly (see the Antigravity OAuth client check above) --
    // the daemon starts agy lazily, only once a poll shows remote fell
    // short, so "not running yet" is the common, healthy state.
    else output.push(check("OK", "Antigravity keepalive", "agy is not running; the remote quota endpoint is the primary source", "run: agy (only needed if remote returns availability-only or a 403)"));
  } else {
    // A missing daemon never blocks reading a configured principal -- every
    // CLI/MCP entry point falls back to a direct read -- so it is a WARN, not
    // a FAIL. A socket that exists but does not answer health is different:
    // requestDaemon() throws on that state instead of falling back, which
    // does block a read, so it stays FAIL.
    const level: DoctorLevel = daemon.status === "absent" ? "WARN" : "FAIL";
    output.push(check(level, "daemon socket", daemon.status === "absent" ? "not found" : "present but unresponsive", "headroom install-service"));
    output.push(check(level, "daemon health", daemon.status === "absent" ? "not available" : "present but unresponsive", "headroom install-service"));
    if (accounts.some((account) => !isLocalAccount(account) && account.vendor === "antigravity")) output.push(keepaliveEnabled
      ? check("WARN", "Antigravity keepalive", "cannot inspect agy without a healthy daemon", "headroom install-service")
      : check("OK", "Antigravity keepalive", "disabled by policy; no agy process expected", "set antigravity_keepalive = true to enable warm local summaries"));
  }

  output.push(await configCheck("policy", join(home, "policy.toml")));
  output.push(await configCheck("routing", process.env.HEADROOM_ROUTING ?? join(home, "routing.toml")));
  const logStatus = await doctorFileStatus(daemonLogPath(home));
  output.push(logStatus === "present"
    ? check("OK", "daemon log", daemonLogPath(home), "headroom logs --tail 50")
    : logStatus === "missing"
      ? check("WARN", "daemon log", `not written yet (${daemonLogPath(home)})`, "headroom install-service")
      : check("WARN", "daemon log", `unsafe log file (${daemonLogPath(home)})`, "fix ownership or writable permissions"));
  const mcp = await mcpRegistrationCheck(accounts);
  if (mcp) output.push(mcp);
}

/**
 * Claude Code's own config file for a profile: `<home>/.claude.json` for the
 * default `~/.claude` profile (a legacy sibling of the `.claude` directory,
 * not inside it), or `<CLAUDE_CONFIG_DIR>/.claude.json` for any other
 * profile. Verified against this machine's real files, not just the vendor's
 * docs: `~/.claude/.claude.json` (inside the default directory) exists too,
 * but is a different, older artifact with no `mcpServers` key -- only the
 * path this function returns is the one Claude Code itself reads and writes
 * MCP registrations to.
 */
export function claudeConfigJsonPath(location: string, home = homedir()): string {
  const directory = resolve(location);
  return directory === resolve(home, ".claude") ? join(home, ".claude.json") : join(directory, ".claude.json");
}

async function mcpRegisteredFor(location: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(claudeConfigJsonPath(location), "utf8")) as { mcpServers?: Record<string, unknown> };
    return typeof parsed.mcpServers === "object" && parsed.mcpServers !== null && "headroom" in parsed.mcpServers;
  } catch { return false; }
}

/**
 * One line naming which configured Claude profiles have Headroom's MCP
 * server registered (`claude mcp add headroom -- ...`) and which don't, read
 * straight from each profile's own `.claude.json` -- never assumed from
 * whether the current process happens to be running under the MCP server
 * itself, since a session started before an install or a rename would not
 * see a stdio tool registration it does not hold. Undefined (no check row at
 * all) when there is no configured Claude principal to report on.
 */
export async function mcpRegistrationCheck(accounts: Account[]): Promise<DoctorCheck | undefined> {
  const claudeAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude");
  if (!claudeAccounts.length) return undefined;
  const registered: string[] = [];
  const unregistered: string[] = [];
  for (const account of claudeAccounts) (await mcpRegisteredFor(account.location) ? registered : unregistered).push(account.name);
  const detail = `registered for ${registered.length ? registered.join(", ") : "none"}${unregistered.length ? `; not registered for ${unregistered.join(", ")}` : ""}`;
  const fix = unregistered.length ? "claude mcp add headroom -- npx headroomd mcp (CLAUDE_CONFIG_DIR=<dir> for a non-default profile)" : "no action needed";
  return check(unregistered.length ? "INFO" : "OK", "mcp registration", detail, fix);
}

/**
 * First-run mode: no daemon is running, and none has ever started on this
 * Headroom home. A brand-new install needs one ordered list of commands, not
 * eight independent FAIL/WARN lines to triage by hand.
 *
 * The daemon log's mere existence is not a usable signal here: opening the
 * store (homeCheck(), the very first step of doctorChecks()) runs one-time
 * schema migrations that themselves write a summary line to the log, so the
 * file exists after doctor's own first run even though no daemon has ever
 * started. Only cli.ts's daemon() writes the literal "daemon started" line,
 * so its absence is what actually means "never started".
 */
export async function isFreshInstall(checks: DoctorCheck[], home = headroomHome()): Promise<boolean> {
  const daemonAbsent = checks.some((item) => item.check === "daemon socket" && item.detail === "not found");
  if (!daemonAbsent) return false;
  try { return !(await readFile(daemonLogPath(home), "utf8")).includes("daemon started"); }
  catch { return true; } // no log at all: certainly never started
}

/** Exact commands for isFreshInstall()'s "Next steps" block, in run order.
 * Exported for tests; keychain grant is macOS-only, mirroring keychain
 * grant's own platform gate. */
export function nextSteps(platform: NodeJS.Platform = process.platform): string[] {
  const steps = platform === "darwin" ? ["headroom keychain grant"] : [];
  steps.push("headroom install-service", "claude mcp add headroom -- npx headroomd mcp");
  return steps;
}

export async function doctor(): Promise<number> {
  console.log(`Headroom ${await headroomVersion()}`);
  const checks = await doctorChecks();
  for (const item of checks) console.log(rendered(item));
  if (await isFreshInstall(checks)) {
    console.log("");
    console.log("Next steps:");
    nextSteps().forEach((step, index) => console.log(`${index + 1}. ${step}`));
  }
  return checks.some((item) => item.level === "FAIL") ? 1 : 0;
}
