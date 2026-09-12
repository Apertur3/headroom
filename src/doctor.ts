import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_GRANT_LAPSED_PREFIX, claudeKeychainMetadata, claudeLoggedOutFix, claudeServiceName, formatLocalTimestamp, isClaudeLoggedOutReason, probeSigningIdentity, resolveProbePath, syncClaudeProbeState } from "./adapters/claude.js";
import { parseBundleFlag, writeDoctorBundle } from "./bundle.js";
import { GEMINI_RETIRED_REASON } from "./adapters/gemini.js";
import { grokAuthPath } from "./adapters/grok.js";
import { isKimiCliCredential, kimiTokenPath } from "./adapters/kimi.js";
import { readPolicy, readRouting } from "./config.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { engineStatus } from "./engine/codexbar/install.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { daemonLogPath } from "./logs.js";
import { credentialPath, headroomHome } from "./paths.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";
import { accountsPath, readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";
import { updateNoticeLine } from "./update.js";
import { isLocalAccount, type Account, type ProviderAccount } from "./types.js";
import { headroomVersion } from "./version.js";
import { safeError } from "./security.js";

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
    // marker exists to prevent until the operator runs `keychain grant`. A
    // detected ACL lapse (issue #9) prints the stored reason as-is -- it
    // already names the rewrite time and the one-line fix -- while a plain
    // denial keeps the shorter, generic wording this line has always used.
    if (grantsNeeded.has(account.name)) {
      store?.audit("doctor", "claude_probe", account.name, "skipped: grant needed");
      const storedReason = grantsNeeded.get(account.name);
      const detail = storedReason?.startsWith(CLAUDE_GRANT_LAPSED_PREFIX) ? storedReason : "Keychain grant needed; probe skipped";
      return check("FAIL", `principal ${account.name} credential`, detail, `headroom keychain grant --principal ${account.name}`);
    }
    // A stored "logged out" verdict from the most recent probe (issue #11)
    // is checked before ever touching the Keychain again: metadata alone
    // cannot tell an item with no usable token apart from a healthy one --
    // neither ever decrypts the payload -- and this state is deliberately
    // not gate-marked (unlike a grant issue), so the only place doctor can
    // learn it is the last real probe result the collector already stored.
    const lastObservation = store?.latest(`${account.name}:all`);
    if (lastObservation?.freshness === "failed" && isClaudeLoggedOutReason(lastObservation.reason)) {
      return check("FAIL", `principal ${account.name} credential`, lastObservation.reason ?? "Claude Code is logged out", claudeLoggedOutFix(account.location));
    }
    // The same Apple-signed tool the probe reads the credential through, and
    // the reason this line can call it readable: the item's access list
    // admits `security`, so no dialog stands between Headroom and the
    // credential. Still without -w -- doctor reads the item's metadata and
    // never the token itself.
    const metadata = await claudeKeychainMetadata(claudeServiceName(account.location));
    store?.audit("doctor", "claude_probe", account.name, "called");
    // The fix is a login, not a grant: an item the metadata lookup cannot
    // see is one Claude Code has not written here (or one `security` could
    // not reach at all), and there is no permission left for anyone to hand
    // over -- the tool doing the reading is already admitted.
    if (!metadata.found) return check("FAIL", `principal ${account.name} credential`, "Claude Keychain item is unavailable", claudeLoggedOutFix(account.location));
    const modified = metadata.modifiedAt ? `, last modified ${formatLocalTimestamp(metadata.modifiedAt)}` : "";
    return check("OK", `principal ${account.name} credential`, `credential readable through the Apple security tool${modified}`, "no action needed");
  }
  if (account.vendor === "gemini") return check("WARN", `principal ${account.name} credential`, GEMINI_RETIRED_REASON, "use: agy");
  if (account.vendor === "antigravity") return check("INFO", `principal ${account.name} credential`, "authentication is owned by agy; see keepalive login state below", "run: agy if not logged in");
  if (account.vendor === "grok") {
    // `location` may name the token file itself or the directory holding it.
    const grokPath = grokAuthPath(account.location);
    return (await doctorFileStatus(grokPath)) === "present"
      ? check("OK", `principal ${account.name} credential`, `credential file present (${grokPath})`, "no action needed")
      : check("FAIL", `principal ${account.name} credential`, `missing or unsafe credential file (${grokPath})`, "run: grok login");
  }
  if (account.vendor === "kimi") {
    // `location` is either the Kimi Code CLI's own credential or the token file
    // the operator writes themselves. The adapter refuses either one if anyone
    // else can read it, so doctor holds both to that same 0600 bar rather than
    // the looser config-file bar above.
    const kimiPath = kimiTokenPath(account.location);
    const cli = isKimiCliCredential(kimiPath);
    const label = cli ? "CLI credential" : "token file";
    const status = await doctorFileStatus(kimiPath);
    const shared = status === "present" && process.platform !== "win32" && ((await lstat(kimiPath)).mode & 0o077) !== 0;
    const fix = cli ? `run: kimi login, then: chmod 600 ${kimiPath}` : `save the kimi-auth token to ${kimiPath}, then: chmod 600 ${kimiPath}`;
    return status === "present" && !shared
      ? check("OK", `principal ${account.name} credential`, `${label} present (${kimiPath})`, "no action needed")
      : check("FAIL", `principal ${account.name} credential`, shared ? `${label} is readable by group or other (${kimiPath})` : `missing or unsafe ${label} (${kimiPath})`, fix);
  }
  const path = credentialPath(account.vendor, account.location);
  return (await doctorFileStatus(path)) === "present"
    ? check("OK", `principal ${account.name} credential`, `credential file present (${path})`, "no action needed")
    : check("FAIL", `principal ${account.name} credential`, `missing or unsafe credential file (${path})`, `run: ${account.vendor}`);
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
 * binary resolvable at once -- the exact shape of the "checked the global
 * install, daemon runs the checkout" mismatch this check exists to surface.
 * Once a successful credential check has pinned one (store.probePath()), claude.ts's own
 * resolution always prefers it over any other candidate; this check compares
 * that pinned (daemon) binary against whatever this CLI process would
 * resolve on its own, naming both rather than leaving an operator to wonder
 * why a probe rebuild had no effect.
 *
 * OK when they are the same file, or (a rebuild changes the file without
 * changing who signed it) when both carry the same codesign designated
 * requirement -- see claude.ts's probeSigningIdentity, the same identity
 * identity syncClaudeProbeState records. WARN when they differ in both
 * respects: the daemon may be polling with a binary this CLI never touches.
 * Undefined when
 * there is nothing to report: no Claude principal configured, or (non-macOS)
 * the probe concept does not apply.
 */
export async function probePinCheck(
  store: HeadroomStore,
  claudeIds: string[],
  dependencies: { signingIdentity?: (pinnedPath?: string) => Promise<string | undefined> } = {},
): Promise<DoctorCheck | undefined> {
  if (process.platform !== "darwin" || !claudeIds.length) return undefined;
  const pinned = store.probePath();
  // Nothing to do about it: with no pin, claude.ts's ordinary resolution
  // order picks the probe, and the first successful `headroom keychain grant`
  // check pins whatever it ran.
  if (!pinned) return check("INFO", "probe binary", "no probe pinned yet for this Headroom home", "no action needed");
  const resolvedWithPin = await resolveProbePath(pinned);
  if (resolvedWithPin !== pinned) {
    return check(resolvedWithPin ? "WARN" : "FAIL", "probe binary",
      resolvedWithPin ? `pinned binary is gone (${pinned}); currently falling back to ${resolvedWithPin} instead` : `pinned binary is gone (${pinned}) and no other probe resolves`,
      "headroom keychain grant --use-this-build");
  }
  const cliProbe = await resolveProbePath();
  if (!cliProbe || cliProbe === pinned) return check("OK", "probe binary", `pinned: ${pinned}`, "no action needed");
  const signingIdentity = dependencies.signingIdentity ?? probeSigningIdentity;
  const [pinnedIdentity, cliIdentity] = await Promise.all([signingIdentity(pinned), signingIdentity()]);
  if (pinnedIdentity !== undefined && pinnedIdentity === cliIdentity) {
    return check("OK", "probe binary", `pinned: ${pinned}; this CLI resolves ${cliProbe}, same signing identity`, "no action needed");
  }
  return check("WARN", "probe binary",
    `the daemon's pinned probe (${pinned}) differs from this CLI's own probe (${cliProbe}), and they do not share a signing identity`,
    "headroom keychain grant re-pins it, or reinstall the service from the binary you want with headroom install-service");
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
  if (store) output.push(check("OK", "schema version", `${store.schemaVersion()} (this binary supports up to ${CURRENT_SCHEMA_VERSION})`, "no action needed"));
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
    // invoked (no prior daemon poll or CLI observe()), so the probe binary
    // this home is running is recorded before the checks below report on it.
    let probePin: DoctorCheck | undefined;
    if (store) {
      const claudeIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude").map((account) => account.name);
      await syncClaudeProbeState(store);
      probePin = await probePinCheck(store, claudeIds);
    }
    const grantsNeeded = store ? new Map(store.keychainGrantsNeeded().map((item) => [item.principal_id, item.reason])) : new Map<string, string>();
    for (const account of accounts) {
      output.push(await credentialCheck(account, grantsNeeded, store));
      const grant = keychainGrantCheck(account, grantsNeeded);
      if (grant) output.push(grant);
      output.push(adapterCheck(account));
      if (store) {
        const downgrade = store.planDowngrade(account.name);
        const plan = store.latestPerWindow().find((row) => row.principal_id === account.name && typeof row.metadata?.plan === "string")?.metadata?.plan;
        output.push(downgrade && !downgrade.acknowledged
          ? check("FAIL", `principal ${account.name} plan`, `DOWNGRADED: ${downgrade.from} to ${downgrade.to} since ${downgrade.since}`, `headroom ack plan ${account.name}`)
          : check("OK", `principal ${account.name} plan`, downgrade ? `${downgrade.to} downgrade acknowledged` : plan ? String(plan) : "unknown (not read yet)", "no action needed"));
      }
    }
    if (probePin) output.push(probePin);
    await doctorChecksTail(output, home, accounts, keepaliveEnabled);
  } finally { store?.close(); }
  return output;
}

async function doctorChecksTail(output: DoctorCheck[], home: string, accounts: Account[], keepaliveEnabled: boolean): Promise<void> {
  let nativeFailure: string | undefined;
  const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath().catch((error: unknown) => {
    nativeFailure = safeError(error); return undefined;
  })]);
  const verifiedNative = native && !native.includes("/.build/");
  output.push(upstream.present
    ? check("OK", "engine upstream hash", `${upstream.tag} verified (${upstream.path})`, "no action needed")
    : check("INFO", "engine upstream hash", `${upstream.tag} absent or hash mismatch; optional, needed only for providers without a native adapter`, "headroom engine install"));
  output.push(native
    ? check(verifiedNative ? "OK" : "INFO", "engine native hash", verifiedNative ? `verified (${native})` : `development binary (${native}) is not release-pinned`, verifiedNative ? "no action needed" : "install the published macOS package for a verified reader")
    : check(nativeFailure ? "FAIL" : "INFO", "engine native hash", nativeFailure ?? "no native reader for this installation", "reinstall headroomd on macOS"));

  if (accounts.some((account) => !isLocalAccount(account) && account.vendor === "antigravity")) {
    output.push(native
      ? check("OK", "Antigravity local reader", "native reader available; Gemini CLI is not required", "no action needed")
      : check("FAIL", "Antigravity local reader", nativeFailure ?? (process.platform === "darwin" ? "packaged native reader missing" : "packaged Antigravity reader is macOS-only"), process.platform === "darwin" ? "reinstall headroomd" : "use Antigravity with Headroom on macOS"));
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
      const level: DoctorLevel = keepalive.login_state !== "logged_in" || local?.outcome !== "fresh" ? "WARN" : "OK";
      const fix = keepalive.login_state === "not_logged_in" ? "run: agy" : local?.outcome === "fresh" ? "no action needed" : "check the Antigravity local reader above and headroom logs";
      output.push(check(level, "Antigravity keepalive", `agy: pid ${keepalive.pid}, up ${uptime}, ${state}${read}`, fix));
    }
    else output.push(check("WARN", "Antigravity keepalive", "agy is not running; its local summary is required", "run: agy and check headroom logs"));
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
 * Exported for tests. The same list on every platform: a first run on macOS
 * has nothing to grant, since the probe reads the Claude credential through
 * the Apple security tool the Keychain item already admits. */
export function nextSteps(_platform: NodeJS.Platform = process.platform): string[] {
  return ["headroom install-service", "claude mcp add headroom -- npx headroomd mcp"];
}

export async function doctor(argv: string[] = []): Promise<number> {
  // A redacted, pasteable-into-an-issue text file instead of the normal
  // check-by-check console output: writeDoctorBundle() gathers its own
  // sections (including a fresh doctorChecks() run) and never mutates
  // anything, same as the rest of this file.
  if (argv.includes("--bundle")) {
    const result = await writeDoctorBundle(parseBundleFlag(argv));
    console.log(`${result.path} (${result.bytes} bytes)`);
    return 0;
  }
  console.log(`Headroom ${await headroomVersion()}`);
  // Silent on any failure (a broken policy.toml is reported below by the
  // policy config check, a failed registry call at most logs a debug line):
  // the update notice must never turn a routine `doctor` run into a failure.
  try {
    const notice = await updateNoticeLine(await readPolicy());
    if (notice) console.log(notice);
  } catch { /* nothing to report here */ }
  const checks = await doctorChecks();
  for (const item of checks) console.log(rendered(item));
  if (await isFreshInstall(checks)) {
    console.log("");
    console.log("Next steps:");
    nextSteps().forEach((step, index) => console.log(`${index + 1}. ${step}`));
  }
  return checks.some((item) => item.level === "FAIL") ? 1 : 0;
}
