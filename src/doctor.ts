import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeServiceName } from "./adapters/claude.js";
import { readPolicy, readRouting } from "./config.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { engineStatus } from "./engine/codexbar/install.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { daemonLogPath } from "./logs.js";
import { credentialPath, headroomHome } from "./paths.js";
import { accountsPath, readAccounts } from "./registry.js";
import { isLocalAccount, type Account } from "./types.js";

const execFileAsync = promisify(execFile);
export type DoctorLevel = "OK" | "WARN" | "FAIL";
export interface DoctorCheck { level: DoctorLevel; check: string; detail: string; fix: string; }

function check(level: DoctorLevel, name: string, detail: string, fix: string): DoctorCheck { return { level, check: name, detail, fix }; }
function rendered(item: DoctorCheck): string { return `${item.level.padEnd(4)} ${item.check}: ${item.detail} — ${item.fix}`; }

async function secureFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && (process.platform === "win32" || (info.mode & 0o077) === 0);
  } catch { return false; }
}

async function credentialCheck(account: Account): Promise<DoctorCheck> {
  if (isLocalAccount(account)) return check("OK", `principal ${account.name} credential`, "local adapter has no credential", "no action needed");
  if (account.vendor === "claude" && process.platform === "darwin") {
    try {
      // Do not pass -w: doctor verifies Keychain metadata without ever reading a token.
      await execFileAsync("security", ["find-generic-password", "-s", claudeServiceName(account.location)]);
      return check("OK", `principal ${account.name} credential`, "Claude Keychain item present", "no action needed");
    } catch { return check("FAIL", `principal ${account.name} credential`, "Claude Keychain item is unavailable", `headroom keychain grant --principal ${account.name}`); }
  }
  const path = credentialPath(account.vendor, account.vendor === "antigravity" ? undefined : account.location);
  return (await secureFile(path))
    ? check("OK", `principal ${account.name} credential`, `credential file present (${path})`, "no action needed")
    : check("FAIL", `principal ${account.name} credential`, `missing or unsafe credential file (${path})`, account.vendor === "antigravity" ? "run: gemini" : `run: ${account.vendor}`);
}

function adapterCheck(account: Account): DoctorCheck {
  if (isLocalAccount(account)) return check("OK", `principal ${account.name} adapter`, "native local adapter selected", "no action needed");
  const level: DoctorLevel = account.adapter === "pending" ? "FAIL" : account.adapter === "codexbar" ? "WARN" : "OK";
  const fix = account.adapter === "pending" ? "run: headroom accounts discover" : account.adapter === "codexbar" ? "run: headroom engine install, or rediscover for native-ts" : "no action needed";
  return check(level, `principal ${account.name} adapter`, `${account.vendor} uses ${account.adapter}`, fix);
}

async function configCheck(name: "policy" | "routing", path: string): Promise<DoctorCheck> {
  try {
    if (!(await secureFile(path))) return check("WARN", name, `not present; using built-in defaults (${path})`, name === "policy" ? "copy examples/policy.toml to this path" : "create routing.toml with [consumes]");
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
  let keepaliveEnabled = process.platform === "darwin" || process.platform === "linux";
  try { keepaliveEnabled = (await readPolicy()).antigravity_keepalive; } catch { /* The policy check below reports the parse error. */ }
  let accounts: Account[] = [];
  try {
    accounts = await readAccounts();
    output.push(check(accounts.length ? "OK" : "WARN", "principals", accounts.length ? `${accounts.length} configured (${accountsPath()})` : "no principals configured", accounts.length ? "no action needed" : "headroom accounts discover"));
  } catch (error) {
    output.push(check("FAIL", "principals", error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT" ? `missing ${accountsPath()}` : "accounts.toml is invalid", "headroom accounts discover"));
  }
  for (const account of accounts) {
    output.push(await credentialCheck(account));
    output.push(adapterCheck(account));
  }

  const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath()]);
  output.push(upstream.present
    ? check("OK", "engine upstream hash", `${upstream.tag} verified (${upstream.path})`, "no action needed")
    : check("WARN", "engine upstream hash", `${upstream.tag} absent or hash mismatch`, "headroom engine install"));
  output.push(native
    ? check(native.includes(`${home}/engine/native/`) ? "OK" : "WARN", "engine native hash", native.includes(`${home}/engine/native/`) ? `verified (${native})` : `development binary (${native}) is not release-pinned`, native.includes(`${home}/engine/native/`) ? "no action needed" : "build a pinned native release or run headroom engine install")
    : check("WARN", "engine native hash", "no verified native engine", "npm run engine:build or headroom engine install"));

  const daemon = await daemonRequest(socketPath(), "health");
  if (daemon.status === "available") {
    output.push(check("OK", "daemon socket", socketPath(), "no action needed"));
    output.push(check("OK", "daemon health", "responding", "no action needed"));
    const health = daemon.result as { keepalive?: { running?: boolean; pid?: number | null } };
    const antigravity = accounts.find((account) => !isLocalAccount(account) && account.vendor === "antigravity");
    const keepalive = health.keepalive;
    if (!antigravity) output.push(check("OK", "Antigravity keepalive", "no Antigravity principal configured", "no action needed"));
    else if (!keepaliveEnabled) output.push(check("OK", "Antigravity keepalive", "disabled by policy; no agy process expected", "set antigravity_keepalive = true to enable warm local summaries"));
    else if (keepalive?.running && keepalive.pid) output.push(check("OK", "Antigravity keepalive", `agy supervisor process ${keepalive.pid} is running`, "no action needed"));
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
  output.push((await secureFile(daemonLogPath(home)))
    ? check("OK", "daemon log", daemonLogPath(home), "headroom logs --tail 50")
    : check("WARN", "daemon log", `not written yet (${daemonLogPath(home)})`, "headroom install-service"));
  return output;
}

export async function doctor(): Promise<number> {
  const checks = await doctorChecks();
  for (const item of checks) console.log(rendered(item));
  return checks.some((item) => item.level === "FAIL") ? 1 : 0;
}
