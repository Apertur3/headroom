import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { vendorJson } from "./limits.js";
import { appendDaemonLog } from "./logs.js";
import { headroomHome } from "./paths.js";
import type { Policy } from "./policy.js";
import { outboundFetch, readBoundedRegularFile, redact, safeError, safeOutputDirectory, writeFileAtomic } from "./security.js";
import { servicePath } from "./service.js";
import { isYes } from "./setup.js";
import { HeadroomStore } from "./store.js";
import { headroomVersion } from "./version.js";

/**
 * `headroom update`: checks the npm registry for a newer `headroomd`, and the
 * background notice `status`/`doctor` print when one exists. Deliberately
 * never automatic -- see docs/quickstart.md's "Staying up to date" for why a
 * daemon that reads credentials must never replace its own binary unattended.
 * Only the package name ever travels; nothing here identifies this machine or
 * its accounts.
 */

const PACKAGE_NAME = "headroomd";
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const RELEASES_BASE_URL = "https://api.github.com/repos/Apertur3/headroom/releases/tags/";
/** Matches the outbound guard's own bound (security.ts's outboundFetch): a
 * vendor-shaped 5-second timeout, even though neither of these two hosts is a
 * credentialed vendor endpoint. */
const FETCH_TIMEOUT_MS = 5_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_STATE_FILENAME = "update-check.json";
const DAEMON_STATE_KEY = "update_check";
const UPDATE_STATE_MAX_BYTES = 4 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- version comparison ----

interface Semver { major: number; minor: number; patch: number; prerelease: string[]; }

/** `X.Y.Z` or `X.Y.Z-<prerelease>` (e.g. `0.1.0-beta.4`), the shape every
 * headroomd release has used so far. Undefined for anything else, so a
 * malformed registry or local version never compares as newer than a well-
 * formed one on either side. */
export function parseSemver(version: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split(".") : [] };
}

/** Semver 2.0's own precedence rule for prerelease identifiers: numeric
 * identifiers compare numerically, alphanumeric ones lexically, a numeric
 * identifier always sorts below an alphanumeric one, a shorter list sorts
 * below a longer one that shares the same prefix, and no prerelease at all
 * outranks any prerelease. */
function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  if (a.length === 0 && b.length > 0) return 1;
  if (a.length > 0 && b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumeric = /^\d+$/.test(a[index]);
    const bNumeric = /^\d+$/.test(b[index]);
    const cmp = aNumeric && bNumeric ? Number(a[index]) - Number(b[index])
      : aNumeric ? -1
      : bNumeric ? 1
      : a[index] < b[index] ? -1 : a[index] > b[index] ? 1 : 0;
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** Positive when `a` is newer than `b`, negative when older, 0 when equal or
 * when either string does not parse as a version at all -- an unparseable
 * version never looks newer, so a malformed registry response never
 * triggers an install. */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

// ---- registry + release notes (both through the outbound guard) ----

/** `registry.npmjs.org/<package>/latest`: the package's own version, and
 * nothing about this machine. Redirects are refused and the response is size-
 * and depth-capped by the same outboundFetch/vendorJson every credentialed
 * adapter call uses (see security.ts), even though this call carries no
 * credential of its own. */
export async function fetchLatestVersion(doFetch: typeof fetch = fetch): Promise<string> {
  const response = await outboundFetch(doFetch, new Request(REGISTRY_LATEST_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error(`npm registry responded ${response.status}`);
  const body = await vendorJson(response);
  const version = object(body) && typeof body.version === "string" ? body.version.trim() : "";
  if (!version) throw new Error("npm registry response carried no version");
  return version;
}

/** The GitHub release body for one tag, unauthenticated -- the only thing
 * `--notes` reads. A missing release (not yet tagged, or a version this
 * adapter never shipped a release for) is reported as "no notes", not a
 * failure: `update` still offers to install without notes to show. */
export async function fetchReleaseNotes(version: string, doFetch: typeof fetch = fetch): Promise<string | undefined> {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const response = await outboundFetch(doFetch, new Request(`${RELEASES_BASE_URL}${encodeURIComponent(tag)}`, {
    // GitHub's REST API rejects an unauthenticated request with no User-Agent.
    headers: { Accept: "application/vnd.github+json", "User-Agent": PACKAGE_NAME },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }));
  if (!response.ok) return undefined;
  const body = await vendorJson(response);
  return object(body) && typeof body.body === "string" ? body.body : undefined;
}

// ---- platform-specific executable names ----

/** Windows resolves a global npm install through the `.cmd` shim; spawning
 * the bare `npm` name there (no shell) fails to find it at all. */
export function npmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/** Same reasoning as npmCommand: the freshly (re)installed `headroom` is a
 * `.cmd` shim on Windows once npm has just written it. */
export function headroomCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "headroom.cmd" : "headroom";
}

export function npmInstallArgs(version: string): string[] {
  return ["install", "-g", `${PACKAGE_NAME}@${version}`];
}

// ---- spawning npm and the freshly installed binary ----

export interface SpawnResult { code: number; stdout: string; stderr: string; }

/** Always an argument vector, never a shell string: `spawnFn` is called with
 * `command` and `args` as separate entries, so nothing in a version string or
 * an npm error can be interpreted as shell syntax. */
function runCommand(command: string, args: string[], spawnFn: typeof spawn): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ code: 1, stdout: "", stderr: safeError(error) }); return; }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr || safeError(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function runNpmInstall(version: string, platform: NodeJS.Platform = process.platform, spawnFn: typeof spawn = spawn): Promise<SpawnResult> {
  return runCommand(npmCommand(platform), npmInstallArgs(version), spawnFn);
}

/** The version the just-installed `headroom` reports for itself, read by
 * actually running it rather than trusting the registry's own string --
 * npm's install can succeed while resolving a different version (a lockfile,
 * a mirror, an operator override), so this is the truthful confirmation, not
 * an echo of what update.ts asked for. Undefined on any failure to run it. */
export async function installedBinaryVersion(platform: NodeJS.Platform = process.platform, spawnFn: typeof spawn = spawn): Promise<string | undefined> {
  const result = await runCommand(headroomCommand(platform), ["--version"], spawnFn);
  return result.code === 0 ? (result.stdout.trim() || undefined) : undefined;
}

// ---- restarting the service update installed on top of ----

async function serviceExists(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try { return (await lstat(servicePath(platform, home, env))).isFile(); }
  catch { return false; }
}

function restartServiceCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "launchctl", args: ["kickstart", "-k", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.headroom.daemon`] };
  if (platform === "win32") return { command: "schtasks", args: ["/Run", "/TN", "Headroom Daemon"] };
  return { command: "systemctl", args: ["--user", "restart", "headroom.service"] };
}

/** Only touches a service Headroom itself installed (servicePath() existing
 * as a file); a machine that never ran `install-service` gets no restart
 * attempt at all, matching install-service/uninstall-service's own scope. */
async function restartServiceIfPresent(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, spawnFn: typeof spawn): Promise<"restarted" | "failed" | "absent"> {
  if (!(await serviceExists(platform, home, env))) return "absent";
  const { command, args } = restartServiceCommand(platform);
  const result = await runCommand(command, args, spawnFn);
  return result.code === 0 ? "restarted" : "failed";
}

// ---- the 24-hour cached check behind the status/doctor notice line ----

interface UpdateCheckState { checked_at: string; latest_version: string; }

function parseUpdateCheckState(raw: string | undefined): UpdateCheckState | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)) return undefined;
    const checkedAt = typeof parsed.checked_at === "string" ? parsed.checked_at : undefined;
    const latestVersion = typeof parsed.latest_version === "string" ? parsed.latest_version : undefined;
    if (!checkedAt || !latestVersion || !Number.isFinite(Date.parse(checkedAt))) return undefined;
    return { checked_at: checkedAt, latest_version: latestVersion };
  } catch { return undefined; }
}

async function readUpdateCheckState(store: HeadroomStore | undefined, home: string): Promise<UpdateCheckState | undefined> {
  if (store) return parseUpdateCheckState(store.daemonState(DAEMON_STATE_KEY));
  try { return parseUpdateCheckState(await readBoundedRegularFile(join(home, UPDATE_STATE_FILENAME), UPDATE_STATE_MAX_BYTES)); }
  catch { return undefined; }
}

async function writeUpdateCheckState(store: HeadroomStore | undefined, home: string, state: UpdateCheckState): Promise<void> {
  if (store) { store.setDaemonState(DAEMON_STATE_KEY, JSON.stringify(state)); return; }
  try {
    const dir = await safeOutputDirectory(home);
    await writeFileAtomic(join(dir, UPDATE_STATE_FILENAME), JSON.stringify(state), 0o600);
  } catch { /* best effort: a failed cache write only means checking again sooner */ }
}

export interface UpdateNoticeDependencies {
  fetch?: typeof fetch;
  home?: string;
  now?: () => Date;
  /** An already-open store to read/write the cache through, so a caller that
   * has one open (status's direct-read path) does not open a second one.
   * Opened and closed here when omitted. */
  store?: HeadroomStore;
}

/**
 * The one line `headroom` (status) and `headroom doctor` print when a newer
 * `headroomd` is on the npm registry: `"headroomd <latest> is available;
 * run: headroom update"`. Checks at most once every 24 hours -- the last
 * check time and the version it saw are cached in the store's daemon_state
 * table, or a small JSON file in the Headroom home when the table cannot be
 * reached at all -- and sends nothing but the package name to the registry.
 * A failed check is silent here (only a debug line in the daemon log, read
 * with `headroom logs --tail`) and returns undefined rather than throwing, so
 * it never turns a routine `status`/`doctor` call into a failure. Disabled
 * outright, with no network call at all, by `policy.update_check = false`.
 * Never called by the daemon itself -- only by the two CLI commands a human
 * reads.
 */
export async function updateNoticeLine(policy: Policy, deps: UpdateNoticeDependencies = {}): Promise<string | undefined> {
  if (!policy.update_check) return undefined;
  const now = deps.now?.() ?? new Date();
  const home = deps.home ?? headroomHome();
  const ownsStore = deps.store === undefined;
  let store = deps.store;
  if (ownsStore) { try { store = await HeadroomStore.open(home); } catch { store = undefined; } }
  try {
    const current = await headroomVersion();
    const cached = await readUpdateCheckState(store, home);
    let latest = cached && now.getTime() - Date.parse(cached.checked_at) < UPDATE_CHECK_INTERVAL_MS ? cached.latest_version : undefined;
    if (latest === undefined) {
      try {
        latest = await fetchLatestVersion(deps.fetch ?? fetch);
        await writeUpdateCheckState(store, home, { checked_at: now.toISOString(), latest_version: latest });
      } catch (error) {
        await appendDaemonLog(`update check failed: ${safeError(error)}`, home).catch(() => undefined);
        return undefined;
      }
    }
    return isNewerVersion(current, latest) ? `${PACKAGE_NAME} ${latest} is available; run: headroom update` : undefined;
  } finally { if (ownsStore) store?.close(); }
}

// ---- `headroom update` itself ----

export const UPDATE_HELP = "Usage: headroom update [--notes] [--dry-run] [--yes]";

async function defaultAskYesNo(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return isYes(await rl.question(`${question} `)); }
  finally { rl.close(); }
}

export interface RunUpdateDependencies {
  fetch?: typeof fetch;
  spawnFn?: typeof spawn;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Enter means No, same as setup.ts's own confirm(); overridden in tests so
   * nothing here ever waits on a real TTY. */
  askYesNo?: (question: string) => Promise<boolean>;
}

/**
 * `headroom update [--notes] [--dry-run] [--yes]`. Running this command is
 * itself the deliberate, human-initiated action Headroom otherwise never
 * takes on its own -- see docs/quickstart.md -- so with no `--notes` an
 * available newer version installs right away; `--notes` shows the GitHub
 * release body first and asks "Install? [y/N]" (Enter is No, `--yes` skips
 * the question). `--dry-run` never spawns anything. Exit 0 when already
 * current, declined, or installed; 1 on any failure (the registry could not
 * be reached, or npm itself failed).
 */
export async function runUpdate(argv: string[], deps: RunUpdateDependencies = {}): Promise<number> {
  const known = new Set(["--notes", "--dry-run", "--yes"]);
  for (const arg of argv) if (!known.has(arg)) throw new Error(UPDATE_HELP);
  const dryRun = argv.includes("--dry-run");
  const wantsNotes = argv.includes("--notes");
  const skipQuestion = argv.includes("--yes");
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? headroomHome({ platform });
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const spawnFn = deps.spawnFn ?? spawn;

  const current = await headroomVersion();
  let latest: string;
  try { latest = await fetchLatestVersion(doFetch); }
  catch (error) { console.error(`could not check the npm registry for the latest ${PACKAGE_NAME} version: ${safeError(error)}`); return 1; }

  console.log(`current: ${current}`);
  console.log(`latest: ${latest}`);

  if (!isNewerVersion(current, latest)) {
    console.log(`${PACKAGE_NAME} ${current} is already the latest version`);
    return 0;
  }

  if (wantsNotes) {
    let notes: string | undefined;
    try { notes = await fetchReleaseNotes(latest, doFetch); } catch { notes = undefined; }
    console.log("");
    console.log(notes?.trim() ? notes.trim() : "(no release notes found)");
    console.log("");
    if (!skipQuestion) {
      const proceed = await (deps.askYesNo ?? defaultAskYesNo)("Install? [y/N]");
      if (!proceed) { console.log("Not installing."); return 0; }
    }
  }

  if (dryRun) {
    console.log(`would run: ${npmCommand(platform)} ${npmInstallArgs(latest).join(" ")}`);
    if (await serviceExists(platform, home, env)) console.log("would restart the Headroom service");
    return 0;
  }

  console.log(`installing ${PACKAGE_NAME}@${latest}...`);
  const install = await runNpmInstall(latest, platform, spawnFn);
  if (install.code !== 0) {
    console.error(`npm install failed (exit ${install.code})`);
    const detail = redact((install.stderr || install.stdout).trim());
    if (detail) console.error(detail);
    return 1;
  }

  const restart = await restartServiceIfPresent(platform, home, env, spawnFn);
  if (restart === "restarted") console.log("restarted the Headroom service");
  else if (restart === "failed") console.error("could not restart the Headroom service; restart it yourself");

  const installedVersion = await installedBinaryVersion(platform, spawnFn);
  console.log(installedVersion ? `headroom ${installedVersion} installed` : `installed ${PACKAGE_NAME}@${latest} (could not read the installed binary's own version)`);
  return 0;
}
