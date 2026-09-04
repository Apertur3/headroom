import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeServiceName, syncClaudeGrantState } from "./adapters/claude.js";
import { readPolicy, readRouting } from "./config.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { engineStatus } from "./engine/codexbar/install.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { daemonLogPath } from "./logs.js";
import { credentialPath, headroomHome } from "./paths.js";
import { accountsPath, readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type Account, type ProviderAccount } from "./types.js";

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
    return { check: check("OK", "home directory", home, "no action needed"), store };
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
  return check("FAIL", `principal ${account.name} keychain grant`, `Keychain grant needed; run: headroom keychain grant --principal ${account.name}`, `headroom keychain grant --principal ${account.name}`);
}

function adapterCheck(account: Account): DoctorCheck {
  if (isLocalAccount(account)) return check("OK", `principal ${account.name} adapter`, "native local adapter selected", "no action needed");
  const level: DoctorLevel = account.adapter === "pending" ? "FAIL" : account.adapter === "codexbar" ? "WARN" : "OK";
  const fix = account.adapter === "pending" ? "run: headroom accounts discover" : account.adapter === "codexbar" ? "run: headroom engine install, or rediscover for native-ts" : "no action needed";
  return check(level, `principal ${account.name} adapter`, `${account.vendor} uses ${account.adapter}`, fix);
}

async function configCheck(name: "policy" | "routing", path: string): Promise<DoctorCheck> {
  try {
    const status = await doctorFileStatus(path);
    if (status === "missing") return check("WARN", name, `not present; using built-in defaults (${path})`, name === "policy" ? "copy examples/policy.toml to this path" : "create routing.toml with [consumes]");
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
      output.push(check("FAIL", "principals", error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT" ? `missing ${accountsPath()}` : "accounts.toml is invalid", "headroom accounts discover"));
    }
    // Runs even when `headroom doctor` is the very first command ever
    // invoked (no prior daemon poll or CLI observe()), so a fresh install or
    // a freshly rebuilt probe binary is caught here too, before credentialCheck
    // below ever touches the Keychain.
    if (store) {
      const claudeIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude").map((account) => account.name);
      await syncClaudeGrantState(store, claudeIds);
    }
    const grantsNeeded = store ? new Map(store.keychainGrantsNeeded().map((item) => [item.principal_id, item.reason])) : new Map<string, string>();
    for (const account of accounts) {
      output.push(await credentialCheck(account, grantsNeeded, store));
      const grant = keychainGrantCheck(account, grantsNeeded);
      if (grant) output.push(grant);
      output.push(adapterCheck(account));
    }
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
    ? check(native.includes(`${home}/engine/native/`) ? "OK" : "WARN", "engine native hash", native.includes(`${home}/engine/native/`) ? `verified (${native})` : `development binary (${native}) is not release-pinned`, native.includes(`${home}/engine/native/`) ? "no action needed" : "build a pinned native release or run headroom engine install")
    : check("WARN", "engine native hash", "no verified native engine", "npm run engine:build or headroom engine install"));

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
    else output.push(check("FAIL", "Antigravity keepalive", "agy process is not running", "set antigravity_keepalive = true and restart headroom service"));
  } else {
    output.push(check("FAIL", "daemon socket", daemon.status === "absent" ? "not found" : "present but unresponsive", "headroom install-service"));
    output.push(check("FAIL", "daemon health", "not available", "headroom install-service"));
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
}

export async function doctor(): Promise<number> {
  const checks = await doctorChecks();
  for (const item of checks) console.log(rendered(item));
  return checks.some((item) => item.level === "FAIL") ? 1 : 0;
}
