import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { outboundFetch, redact } from "../security.js";
import { assertVendorResponseLimits, vendorJson } from "../limits.js";
import { credentialPath } from "../paths.js";
import { executablePath } from "../paths.js";
import type { Observation, ProviderAccount } from "../types.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;
const SOURCE = "native:claude";

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

export class ProviderHTTPError extends Error {
  constructor(readonly status: number, provider: string) { super(`${provider} usage request failed (${status})`); }
}

export interface ClaudeDependencies {
  platform?: NodeJS.Platform;
  now?: () => Date;
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  /** Test seam only. Production macOS reads credentials exclusively in the probe. */
  keychain?: (service: string) => Promise<string>;
  probe?: (configDir: string) => Promise<string>;
  /** The exact probe binary this Headroom home was granted under (see
   * store.ts's probePath()); passed through to claudeProbe() so a poll uses
   * the same binary the operator actually granted rather than whatever the
   * plain resolution order would otherwise pick. Ignored once `probe` (the
   * test seam above) is given. */
  probePath?: string;
  /** Test seam only, mirroring `probe` above. Production calls
   * claudeKeychainMetadata() directly, which spawns the real `security`
   * binary; a test must never do that (it would touch the real login
   * Keychain), so it substitutes a fake here instead. */
  keychainMetadata?: (service: string) => Promise<ClaudeKeychainMetadata>;
}

export function claudeServiceName(configDir: string, home = homedir()): string {
  const directory = resolve(configDir);
  if (directory === resolve(home, ".claude")) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`;
}

async function readCredentialFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("credentials unavailable");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("credentials have unsafe permissions");
  return readFile(path, "utf8");
}

export class ClaudeProbeError extends Error {
  constructor(readonly kind: "missing" | "denied" | "timeout" | "unavailable" | "no_interaction", message: string) { super(message); }
}

/** The one wording for "the Keychain cannot show its access dialog from this
 * shell" -- macOS's errSecInteractionNotAllowed (a sandboxed or otherwise
 * non-interactive process) or a cancelled interaction, distinguished by the
 * probe from a genuine "no login here yet" (see HEADROOM_PROBE_NO_CREDENTIALS
 * below) which needs a completely different fix. Shared by the probe's own
 * error mapping and `headroom keychain grant`'s direct catch, so both say
 * exactly the same thing instead of drifting. */
export const KEYCHAIN_INTERACTION_BLOCKED_MESSAGE = "the Keychain dialog cannot be shown from this shell; run this command in your own Terminal";

/** The single wording for "this principal cannot be probed again until the
 * operator runs the grant command", shared by the daemon's synthetic
 * failure, the collector's gate, and doctor's FAIL line, so all three stay
 * in sync by construction rather than by convention. */
export function claudeGrantNeededReason(principalId: string): string {
  return `${CLAUDE_GRANT_NEEDED_PREFIX} run: headroom keychain grant --principal ${principalId}`;
}

/** Static prefix of claudeGrantNeededReason() above, so a caller can
 * recognize an explicit probe denial without reconstructing the principal
 * name. */
export const CLAUDE_GRANT_NEEDED_PREFIX = "Keychain grant needed;";

/** True only for the explicit denial reason claudeGrantNeededReason()
 * produces -- a probe that reported it could not read the item at all.
 * collector.ts's gate keys on this alone: the credential is now read through
 * the Apple security tool, which the item's own access list admits, so a
 * readable credential can never produce this and can never mark a principal
 * as needing anything. */
export function isClaudeProbeDenialReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(CLAUDE_GRANT_NEEDED_PREFIX);
}

/** The marker the probe prints when `/usr/bin/security` -- the tool the
 * Keychain item's access list actually admits, and so the read path the probe
 * answers through -- failed for any reason other than an absent item. Its
 * suffix is the tool's exit status (`exit=<n>`), `timeout`, or `unavailable`;
 * the tool's own output never appears anywhere, since the only thing on that
 * stream is the secret itself. */
const SECURITY_TOOL_FAILED_PATTERN = /HEADROOM_PROBE_SECURITY_TOOL_FAILED(?:\s+(\S+))?/;

/** The single wording for a failed `security` read, built from the marker's
 * suffix alone. An absent item is not this: it keeps HEADROOM_PROBE_NO_CREDENTIALS
 * and the "log in" fix it has always had. */
export function claudeSecurityToolFailureReason(detail: string | undefined): string {
  const status = /^exit=(-?\d+)$/.exec(detail ?? "");
  if (status) return `the macOS security tool could not read the credential (exit ${status[1]})`;
  if (detail === "timeout") return "the macOS security tool did not answer within 10s";
  return "the macOS security tool could not be run";
}

/** Static prefix of claudeKeychainLapseReason()'s formatted text (below), so
 * a caller can recognize a lapse reason -- as opposed to a plain denial --
 * without reconstructing the exact timestamp: collector.ts's grant gate
 * (isClaudeGrantIssue) and store.ts's grant_lapsed notifier event both key
 * off this. */
export const CLAUDE_GRANT_LAPSED_PREFIX = "Keychain grant lapsed;";

/** True for any reason string that means "this Claude principal needs
 * `headroom keychain grant` run again", whether from a plain denial
 * (claudeGrantNeededReason) or a detected ACL lapse
 * (claudeKeychainLapseReason). Shared so collector.ts's gate recognizes both
 * by construction instead of restating either prefix. */
export function isClaudeGrantIssue(reason: string | null | undefined): boolean {
  return typeof reason === "string" && (reason.startsWith(CLAUDE_GRANT_NEEDED_PREFIX) || reason.startsWith(CLAUDE_GRANT_LAPSED_PREFIX));
}

/** The single wording for "the Keychain item exists but its JSON carries no
 * usable OAuth access token" (issue #11: HEADROOM_PROBE_LOGGED_OUT, distinct
 * from HEADROOM_PROBE_NO_CREDENTIALS -- an absent item entirely). Signing
 * back in fixes this on its own, so it is never a Keychain grant issue: see
 * CLAUDE_LOGGED_OUT_PREFIX and isClaudeLoggedOutReason below, which
 * isClaudeGrantIssue above must never match. */
export function claudeLoggedOutFix(configDir: string): string {
  const directory = resolve(configDir);
  return directory === resolve(homedir(), ".claude") ? "run: claude and sign in" : `run: CLAUDE_CONFIG_DIR=${directory} claude and sign in`;
}

/** Full reason text for the logged-out state above, built from
 * claudeLoggedOutFix() so the probe error mapping (claudeProbe, below) and
 * doctor's per-principal credential line (credentialCheck) always print the
 * identical fix instead of restating it. */
export function claudeLoggedOutReason(configDir: string): string {
  const directory = resolve(configDir);
  const fix = claudeLoggedOutFix(directory);
  return directory === resolve(homedir(), ".claude") ? `Claude Code is logged out; ${fix}` : `Claude Code is logged out for ${directory}; ${fix}`;
}

/** Static prefix of claudeLoggedOutReason()'s output, so a caller (doctor's
 * credentialCheck) can recognize a stored logged-out verdict without
 * reconstructing the exact text. */
export const CLAUDE_LOGGED_OUT_PREFIX = "Claude Code is logged out";

/** True for any reason string produced by claudeLoggedOutReason() above. */
export function isClaudeLoggedOutReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(CLAUDE_LOGGED_OUT_PREFIX);
}

/** The item's `mdat` (modification date) attribute from `security
 * find-generic-password`'s attribute dump, e.g.
 * `"mdat"<timedate>=0x...  "20260907052443Z\000"` -- always UTC/Zulu, per
 * macOS's own Keychain attribute format. */
const KEYCHAIN_MDAT_PATTERN = /"mdat"<timedate>=0x[0-9A-Fa-f]*\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/;

/** Parses the `mdat` line out of `security find-generic-password`'s stdout.
 * Returns undefined (never throws) for a missing or malformed line -- a
 * detected lapse is still worth reporting even without an exact time. */
export function parseKeychainModifiedAt(stdout: string): Date | undefined {
  const match = KEYCHAIN_MDAT_PATTERN.exec(stdout);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export interface ClaudeKeychainMetadata { found: boolean; modifiedAt?: Date; }

/**
 * Metadata-only Keychain lookup: `security find-generic-password -s
 * <service>`, deliberately never `-w`, so it never reads or decrypts the
 * secret data. macOS permits this without the item's access control list
 * allowing this process -- exactly what distinguishes a genuinely absent
 * login (exit 44, "could not be found in the keychain") from an item that
 * exists but is presently ACL-blocked (see claudeKeychainLapseReason below
 * and issue #9). Spawned with an explicit argument vector, never a shell.
 * Any failure -- not found, `security` missing, an unexpected error -- comes
 * back as `{ found: false }` rather than throwing, so a lookup that could not
 * answer the question never gets mistaken for a confirmed absence or
 * fabricates a lapse.
 */
export async function claudeKeychainMetadata(service: string): Promise<ClaudeKeychainMetadata> {
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service], { timeout: TIMEOUT_MS, windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
    return { found: true, modifiedAt: parseKeychainModifiedAt(stdout) };
  } catch {
    return { found: false };
  }
}

/** `en-CA` gives an unambiguous YYYY-MM-DD date; `hour12: false` avoids an
 * AM/PM string the reader still has to convert. Local to whichever timezone
 * this process runs in, the same "local time" the operator reading the
 * message is in. */
export function formatLocalTimestamp(date: Date): string {
  return date.toLocaleString("en-CA", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(",", "");
}

/**
 * Disambiguates the probe's "no credentials" report (HEADROOM_PROBE_NO_CREDENTIALS
 * in the Swift probe source) between a genuinely absent login and an item
 * whose access control list Claude Code reset by rewriting it on token
 * refresh (issue #9: macOS resets an item's ACL on every rewrite, so the
 * probe loses access it was previously granted). The probe itself cannot
 * tell these two states apart -- decrypting the secret is exactly what the
 * lost ACL blocks -- so this reads the item's metadata only, which macOS
 * permits without the ACL grant. Returns undefined (the caller keeps the
 * original "no credentials" wording) when the item is genuinely absent.
 */
async function claudeKeychainLapseReason(account: ProviderAccount, dependencies: ClaudeDependencies): Promise<string | undefined> {
  const service = claudeServiceName(account.location);
  const metadata = await (dependencies.keychainMetadata ?? claudeKeychainMetadata)(service);
  if (!metadata.found) return undefined;
  const when = metadata.modifiedAt ? formatLocalTimestamp(metadata.modifiedAt) : "an unknown time";
  return `${CLAUDE_GRANT_LAPSED_PREFIX} Claude Code rewrote its credentials at ${when}; run: headroom keychain grant --principal ${account.name}`;
}

async function claudeProbe(configDir: string, pinnedPath?: string): Promise<string> {
  let helper: string | undefined;
  try { helper = await keychainHelper(pinnedPath); }
  catch (error) { throw new ClaudeProbeError("unavailable", error instanceof Error ? error.message : "Claude probe unavailable"); }
  if (!helper) throw new ClaudeProbeError("unavailable", "Claude probe not built; run npm run engine:build");
  try {
    const { stdout } = await execFileAsync(helper, ["--config-dir", resolve(configDir)], { timeout: TIMEOUT_MS + 2_000, maxBuffer: 1024 * 1024 + 1024, windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
    const value: unknown = JSON.parse(stdout);
    assertVendorResponseLimits(value);
    return stdout;
  } catch (error: unknown) {
    const result = error as { stderr?: string; code?: number | string };
    const stderr = result.stderr ?? "";
    // Checked before HEADROOM_PROBE_KEYCHAIN_DENIED (errSecAuthFailed, a real
    // ACL denial) and before the generic "no credentials" fallback
    // (errSecItemNotFound, a genuinely absent login): errSecInteractionNotAllowed
    // and a cancelled interaction both mean the dialog itself could not be
    // shown here, which used to fall through to the same "no credentials in
    // Keychain for this config dir" wording as an absent login and, from
    // `headroom keychain grant`, print the wrong fix ("no Claude login for
    // ...") even though the Keychain item is present -- exactly the dogfooded
    // failure from a sandboxed agent shell.
    if (stderr.includes("HEADROOM_PROBE_INTERACTION_NOT_ALLOWED")) throw new ClaudeProbeError("no_interaction", KEYCHAIN_INTERACTION_BLOCKED_MESSAGE);
    if (stderr.includes("HEADROOM_PROBE_KEYCHAIN_DENIED")) throw new ClaudeProbeError("denied", "Keychain access denied");
    // The probe reads the credential through /usr/bin/security, which the
    // Keychain item's own access list admits. A failure there is a broken
    // tool, not a permission the operator can hand over, so it never becomes
    // a grant issue: it reports the tool's exit status and stops. An item
    // that is simply not there stays HEADROOM_PROBE_NO_CREDENTIALS below.
    const securityToolFailure = SECURITY_TOOL_FAILED_PATTERN.exec(stderr);
    if (securityToolFailure) throw new ClaudeProbeError("unavailable", claudeSecurityToolFailureReason(securityToolFailure[1]));
    if (stderr.includes("HEADROOM_PROBE_TIMEOUT") || (error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new ClaudeProbeError("timeout", "Keychain access timed out");
    if (stderr.includes("HEADROOM_PROBE_EXPIRED")) throw new ClaudeProbeError("missing", `token expired; ${claudeCommandForDirectory(configDir)}`);
    // Parenthesized status code, matching ProviderHTTPError's own format:
    // collector.ts's and daemon.ts's shared backoff detection looks for this
    // exact shape, so a probe-side 403/429 backs off the same way a direct
    // fetch's would, instead of being silently discarded. The wording itself
    // is the same actionable "rejected the token" fix observeClaude() uses
    // for a live 401/403 over the direct-fetch path.
    if (stderr.includes("HEADROOM_PROBE_FORBIDDEN")) throw new ClaudeProbeError("missing", `Claude rejected the token (403); ${claudeCommandForDirectory(configDir)}`);
    if (stderr.includes("HEADROOM_PROBE_RATE_LIMITED")) throw new ClaudeProbeError("missing", "Claude usage request failed (429)");
    // The Keychain item exists (unlike HEADROOM_PROBE_NO_CREDENTIALS below)
    // but its JSON carries no usable OAuth access token: Claude Code is
    // logged out locally for this config dir (issue #11), not a Keychain
    // grant issue -- claudeLoggedOutReason()'s wording never matches
    // isClaudeGrantIssue, so the collector never marks this principal as
    // needing `headroom keychain grant`; signing back in fixes it on its own.
    if (stderr.includes("HEADROOM_PROBE_LOGGED_OUT")) throw new ClaudeProbeError("missing", claudeLoggedOutReason(configDir));
    if (stderr.includes("HEADROOM_PROBE_NO_CREDENTIALS")) throw new ClaudeProbeError("missing", "no credentials in Keychain for this config dir");
    throw new ClaudeProbeError("missing", "no credentials in Keychain for this config dir");
  }
}

/** Runs the probe once and throws whatever it reports. Nothing is granted and
 * no dialog is involved: the credential is read through /usr/bin/security,
 * which the Keychain item's own access list admits, so this is purely a
 * readability check.
 *
 * Returns the exact probe path the check ran under, so the caller (cli.ts's
 * `keychain grant`) can pin it -- see store.ts's setProbePath() -- the first
 * time a check ever succeeds for this Headroom home. undefined only if
 * somehow no probe resolved at all despite claudeProbe() not throwing, which
 * should not happen in practice. */
export async function checkClaudeCredentialReadable(configDir: string, pinnedPath?: string): Promise<{ probePath: string | undefined }> {
  const probePath = await resolveProbePath(pinnedPath);
  await claudeProbe(configDir, probePath ?? pinnedPath);
  return { probePath };
}

/** Thrown only when a packaged probe (bin/probe/darwin) is physically present
 * but fails SHA-256 verification: a real integrity problem the caller must
 * surface, distinct from "not built yet" (which silently falls through to
 * the next candidate, or ultimately to probeBinaryHash()/claudeProbe()'s own
 * "not built" message). */
export class ProbeVerificationError extends Error {}

/** Verifies bin/probe/darwin/headroom-claude-probe against its sibling SHA256
 * file (written by scripts/build-probe.sh). Returns undefined -- never
 * throws for "not packaged here" -- when the directory or binary is simply
 * absent, e.g. a source checkout before packing, or any non-darwin platform. */
export async function verifiedPackagedProbe(root: string): Promise<string | undefined> {
  const directory = join(root, "bin", "probe", "darwin");
  const binaryPath = join(directory, "headroom-claude-probe");
  const shaPath = join(directory, "SHA256");
  try { await lstat(binaryPath); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const verified = await executablePath(binaryPath);
  let recorded: string;
  try { recorded = (await readFile(shaPath, "utf8")).trim().split(/\s+/)[0] ?? ""; }
  catch { throw new ProbeVerificationError(`Claude probe SHA-256 record missing (${shaPath}); reinstall headroomd`); }
  const actual = createHash("sha256").update(await readFile(verified)).digest("hex");
  if (!recorded || actual !== recorded) throw new ProbeVerificationError("Claude probe SHA-256 verification failed; reinstall headroomd");
  return verified;
}

/**
 * Resolution order: HEADROOM_PROBE_PATH (a development override, never
 * SHA-256 verified -- the operator named it explicitly, always wins even
 * over a pin), `pinnedPath` (the exact binary this Headroom home was
 * actually granted under -- see store.ts's probePath()/setProbePath(), tried
 * next so a second candidate appearing later, e.g. a repo checkout built
 * alongside an existing global install, never silently takes over), the
 * packaged macOS probe shipped in the npm tarball (bin/probe/darwin,
 * SHA-256 verified against every use), then a repo dev build
 * (engine/.build/release, the output of `npm run engine:build`, confined to
 * this repository checkout). A verification failure on the packaged probe
 * propagates as ProbeVerificationError instead of silently falling through,
 * so a tampered or corrupted install never quietly downgrades to "not
 * built". A `pinnedPath` that no longer resolves (the granted binary was
 * removed or replaced) falls through to the normal order below it, rather
 * than failing outright -- the resulting hash mismatch against
 * probeGrantedHash is what correctly asks for a fresh grant.
 */
async function keychainHelper(pinnedPath?: string): Promise<string | undefined> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const override = process.env.HEADROOM_PROBE_PATH;
  if (override) { try { return await executablePath(override); } catch { return undefined; } }
  if (pinnedPath) { try { return await executablePath(pinnedPath); } catch { /* the pinned binary is gone; fall through below */ } }
  if (process.platform === "darwin") {
    const packaged = await verifiedPackagedProbe(root);
    if (packaged) return packaged;
  }
  const candidate = join(root, "engine", ".build", "release", "headroom-claude-probe");
  try { return await executablePath(candidate, { repoRoot: root, development: true }); } catch { /* not a repo dev build either */ }
  return undefined;
}

/** Public entry point for callers that need to know the exact path
 * (doctor's mismatch report, `headroom keychain grant`'s own pinning) rather
 * than just whether one resolves. Same resolution order as keychainHelper. */
export async function resolveProbePath(pinnedPath?: string): Promise<string | undefined> {
  return keychainHelper(pinnedPath);
}

/** sha256 of the resolved Claude probe binary, or undefined when none is
 * built/installed or the packaged probe fails verification. Used only to
 * detect a rebuild (see syncClaudeGrantState); a verification failure here
 * must never crash a background caller like doctor or an ordinary poll, so
 * it is treated the same as "no probe available". */
export async function probeBinaryHash(pinnedPath?: string): Promise<string | undefined> {
  let helper: string | undefined;
  try { helper = await keychainHelper(pinnedPath); } catch { return undefined; }
  if (!helper) return undefined;
  return createHash("sha256").update(await readFile(helper)).digest("hex");
}

/**
 * The resolved probe's designated requirement, which is the thing macOS
 * actually keys a Keychain item's ACL on -- not the binary's contents. A
 * probe signed by the stable local identity scripts/build-probe.sh creates
 * reads `identifier "headroom-claude-probe" and certificate leaf = H"..."`,
 * which is identical across every rebuild under that identity, so a grant
 * the operator already gave keeps working after `npm run engine:build`.
 *
 * Returns undefined when the signature is ad-hoc: an ad-hoc requirement is
 * a bare `cdhash H"..."`, a different value for every build, and a Keychain
 * grant given to one ad-hoc binary genuinely does not carry over to the
 * next. Also undefined off darwin, when no probe resolves, or when codesign
 * cannot read it -- callers then fall back to comparing binary hashes,
 * which is the conservative answer (ask for a fresh grant).
 */
export async function probeSigningIdentity(pinnedPath?: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  let helper: string | undefined;
  try { helper = await keychainHelper(pinnedPath); } catch { return undefined; }
  if (!helper) return undefined;
  let requirement: string;
  try {
    // `-r-` writes the requirement to stdout; the Executable= banner and any
    // diagnostics go to stderr.
    const { stdout } = await execFileAsync("/usr/bin/codesign", ["-d", "-r-", helper], { timeout: TIMEOUT_MS });
    requirement = stdout;
  } catch { return undefined; }
  const designated = requirement.split("\n").map((line) => line.trim()).find((line) => line.startsWith("designated =>"));
  if (!designated) return undefined;
  if (/\bcdhash\b/.test(designated)) return undefined; // ad-hoc: a per-build requirement, not an identity
  return designated;
}

export interface ClaudeGrantStore {
  keychainGrantNeeded(principalId: string): boolean;
  setKeychainGrantNeeded(principalId: string, reason: string): void;
  probeBinaryHash(): string | undefined;
  setProbeBinaryHash(hash: string): void;
  /** The most recent probe binary hash that actually proved itself: either an
   * explicit `headroom keychain grant` succeeded under it, or a poll got a
   * real vendor response through it. Distinct from probeBinaryHash, which is
   * only "the hash last seen", so a fresh install (no probeBinaryHash yet)
   * can still be recognized as already-trusted after a restore/reinstall of
   * the same binary. */
  probeGrantedHash(): string | undefined;
  setProbeGrantedHash(hash: string): void;
  /** The exact probe binary path this Headroom home was granted under, once
   * pinned (see store.ts's probePath()/setProbePath()). undefined before the
   * first successful `headroom keychain grant`. */
  probePath(): string | undefined;
  /** Every principal currently carrying a grant marker, and why. Optional so
   * a store that predates it, or a test double, keeps working; used only by
   * syncClaudeProbeState to retire markers no build writes any more. */
  keychainGrantsNeeded?(): Array<{ principal_id: string; reason: string }>;
  clearKeychainGrantNeeded?(principalId: string): void;
  setProbePath(path: string): void;
  /** The designated requirement the probe carried at the last sync (see
   * probeSigningIdentity above), or undefined for an ad-hoc probe. Optional
   * so a store that predates it, or a test double, keeps the plain
   * hash-comparison behavior. */
  probeSigningIdentity?(): string | undefined;
  setProbeSigningIdentity?(identity: string): void;
}

/** Gate consulted by the collector before every Claude probe attempt. */
export interface ClaudeGrantGate {
  needsGrant(principalId: string): boolean;
  markGrantNeeded(principalId: string, reason: string): void;
  /** Called once a probe attempt for the current binary hash actually
   * returns a real vendor response, so that hash is recorded as known-good
   * and never treated as an unproven first run again. */
  markProbeSucceeded(): void;
  /** The pinned probe path, passed to observeClaude()'s probePath dependency
   * so every poll uses the exact binary this Headroom home was granted
   * under. undefined before the first grant. */
  probePath(): string | undefined;
}

export function claudeGrantGate(store: ClaudeGrantStore): ClaudeGrantGate {
  return {
    needsGrant: (id) => store.keychainGrantNeeded(id),
    markGrantNeeded: (id, reason) => store.setKeychainGrantNeeded(id, reason),
    markProbeSucceeded: () => { const hash = store.probeBinaryHash(); if (hash) store.setProbeGrantedHash(hash); },
    probePath: () => store.probePath(),
  };
}

/** Reasons the previous build's rebuild detection wrote into the grant marker
 * ("probe binary rebuilt", "probe binary rebuilt (ad-hoc signed, ...)",
 * "probe signing identity changed", "no successful probe recorded for this
 * binary"). Every one of them describes the probe binary rather than a read
 * the Keychain refused, and nothing writes them any more -- an upgraded home
 * would otherwise keep a working principal gated forever behind a grant
 * command that no longer grants anything. A real denial ("Keychain grant
 * needed; ...", "Keychain access denied", "Keychain grant lapsed; ...") never
 * matches and is left exactly where it is.
 */
const PROBE_REBUILD_REASON_PATTERN = /^(probe |no successful probe )/;

/**
 * Records what probe binary this Headroom home is currently running: its
 * SHA-256 and its designated requirement (undefined for an ad-hoc build).
 * doctor reports from these; nothing else acts on them.
 *
 * It marks no principal, on a first run or on any other. It used to: macOS
 * keys a Keychain item's ACL on the trusted application's designated
 * requirement, so a rebuilt or re-signed probe was code the item had never
 * admitted, and every such change sent every Claude principal back through
 * `headroom keychain grant` before a background poll could touch the item.
 * The credential is now read through /usr/bin/security, which the item's own
 * access list admits whatever this binary is signed with, so there is no ACL
 * to lose and nothing for anyone to grant. Marking on a rebuild would only
 * block a working credential behind a dialog that never appears.
 */
export async function syncClaudeProbeState(
  store: ClaudeGrantStore,
  dependencies: {
    platform?: NodeJS.Platform;
    hash?: () => Promise<string | undefined>;
    signingIdentity?: () => Promise<string | undefined>;
  } = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") return;
  // Retires markers left by the build that gated a principal whenever the
  // probe binary changed. Idempotent, and never touches a denial marker.
  for (const item of store.keychainGrantsNeeded?.() ?? []) {
    if (PROBE_REBUILD_REASON_PATTERN.test(item.reason)) store.clearKeychainGrantNeeded?.(item.principal_id);
  }
  // Hashes the pinned path once one exists, not just whatever the plain
  // resolution order would currently pick -- the same "use exactly one
  // path" rule claudeProbe() itself follows once a check has pinned one.
  const hash = await (dependencies.hash ?? (() => probeBinaryHash(store.probePath())))();
  if (!hash) return;
  store.setProbeBinaryHash(hash);
  const identity = await (dependencies.signingIdentity ?? (() => probeSigningIdentity(store.probePath())))();
  // Recorded even when it is undefined (an ad-hoc probe), so a store never
  // keeps claiming an identity the current binary does not carry.
  store.setProbeSigningIdentity?.(identity ?? "");
}

interface Credential { token: string; expired: boolean; }

function claudeCommandForDirectory(configDir: string): string {
  const directory = resolve(configDir);
  return directory === resolve(homedir(), ".claude") ? "run: claude" : `run: CLAUDE_CONFIG_DIR=${directory} claude`;
}

function claudeCommand(account: ProviderAccount): string { return claudeCommandForDirectory(account.location); }

function shape(value: unknown, path = "$"): Array<{ path: string; kind: string }> {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const output = [{ path, kind }];
  if (isObject(value)) for (const [key, child] of Object.entries(value)) output.push(...shape(child, `${path}.${key}`));
  else if (Array.isArray(value) && value[0] !== undefined) output.push(...shape(value[0], `${path}[]`));
  return output;
}
export function parseClaudeCredential(payload: string, now = new Date()): Credential {
  try {
    const root: unknown = JSON.parse(payload);
    const oauth = isObject(root) && isObject(root.claudeAiOauth) ? root.claudeAiOauth : undefined;
    const token = oauth && typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
    const expiresAt = oauth && finiteNumber(oauth.expiresAt);
    if (!token || expiresAt === undefined) throw new Error("invalid");
    return { token, expired: now.getTime() >= expiresAt };
  } catch { throw new Error("OAuth credentials invalid"); }
}

function base(account: ProviderAccount, meter: string, now: string): Omit<Observation, "window" | "quantity" | "resets_at" | "freshness" | "reason"> {
  return { principal_id: account.name, meter_id: `${account.name}:${meter}`, observed_at: now, fetched_at: now, source: SOURCE, truth: "official", confidence: 1, adapter_version: "native-ts", upstream_schema_version: "v0.56.4" };
}

function failed(account: ProviderAccount, reason: string, now: string): Observation[] {
  return ["all", "fable", "routines"].map((meter) => ({ ...base(account, meter, now), window: null, quantity: null, resets_at: null, freshness: "failed" as const, truth: "estimated" as const, confidence: 0, reason: redact(reason) }));
}

/** Synthetic failed observations for a principal the grant gate is blocking,
 * built without ever attempting the probe (and so never popping a dialog). */
export function claudeGrantNeededObservations(account: ProviderAccount, now = new Date()): Observation[] {
  return failed(account, claudeGrantNeededReason(account.name), now.toISOString());
}

function window(account: ProviderAccount, meter: string, raw: unknown, minutes: number, now: string): Observation | undefined {
  if (!isObject(raw)) return undefined;
  const used = finiteNumber(raw.utilization) ?? finiteNumber(raw.percent);
  if (used === undefined) return undefined;
  const value = Math.min(100, Math.max(0, used));
  const resets = iso(raw.resets_at);
  return { ...base(account, meter, now), window: { kind: resets ? "fixed" : "rolling", minutes, enforcement: "hard" }, quantity: { used: value, limit: 100, remaining: Math.max(0, 100 - value), unit: "percent" }, resets_at: resets, freshness: "fresh" };
}

/**
 * A scoped limit that carries a percent is always emitted as a real,
 * fresh window -- even when the vendor flags it `is_active: false`. The
 * vendor's own "inactive" flag on `/usage` describes a bucket with no
 * enforced cap at all (nothing to show, hence the not_enforced fallback
 * below), not a live percent the vendor happens to be hiding elsewhere: the
 * owner-reported gap (`/usage` shows a Fable weekly bar near its cap while
 * Headroom read the same account's scoped meter as "inactive") was exactly
 * this case, a bucket with a real percent that got dropped because the flag
 * was trusted over the number sitting right beside it. Enforcement is
 * `soft` and `metadata.vendor_active` is `false` only in that case, purely
 * descriptive (nothing in Headroom currently branches on `enforcement`) so
 * a caller can still tell the two states apart. A scoped limit with no
 * percent at all -- active or not -- has nothing to report and keeps the
 * original not_enforced reporting.
 */
function scoped(account: ProviderAccount, meter: string, candidate: unknown, now: string): Observation {
  const inactive = isObject(candidate) && candidate.is_active === false;
  if (inactive) {
    const real = window(account, meter, candidate, 10_080, now);
    if (real) return { ...real, window: { ...real.window!, enforcement: "soft" }, reason: "vendor flags this limit inactive; shown because it carries a cap", metadata: { vendor_active: false } };
    return { ...base(account, meter, now), window: { kind: "rolling", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "not_enforced", reason: "vendor marks scoped limit inactive" };
  }
  return window(account, meter, candidate, 10_080, now) ?? { ...base(account, meter, now), window: { kind: "rolling", minutes: 10_080, enforcement: "hard" }, quantity: null, resets_at: null, freshness: "not_enforced", reason: "no scoped limit in response" };
}

/** `claude-main:sonnet-5`, not `claude-main:Sonnet 5`: lowercase, non-alnum
 * runs collapsed to one hyphen, no leading/trailing hyphen. Empty for a
 * display name that is somehow entirely non-alphanumeric, which the caller
 * treats as "nothing usable to name this meter" and skips. */
export function modelSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parse Claude's OAuth usage body without retaining the credential or response body. */
export function observationsFromClaudeUsage(body: unknown, account: ProviderAccount, at = new Date()): Observation[] {
  if (!isObject(body)) throw new Error("Claude usage response invalid");
  const now = at.toISOString();
  const output = [window(account, "all", body.five_hour, 300, now), window(account, "all", body.seven_day, 10_080, now)].filter((item): item is Observation => Boolean(item));
  let fable: unknown;
  let routines: unknown;
  // Any other model-scoped bucket the response offers, keyed by its own
  // display name's slug -- Sonnet, Opus, or any future named allowance
  // beyond the two Headroom already gives a dedicated meter.
  const modelBuckets = new Map<string, unknown>();
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith("seven_day_")) continue;
    const valid = isObject(value) && (finiteNumber(value.utilization) !== undefined || finiteNumber(value.percent) !== undefined);
    if (lower.includes("fable") && fable === undefined && valid) fable = value;
    if ((lower.includes("routine") || lower.includes("cowork")) && routines === undefined && valid) routines = value;
  }
  if (Array.isArray(body.limits)) for (const limit of body.limits) {
    if (!isObject(limit) || !String(limit.kind ?? "").toLowerCase().includes("scoped")) continue;
    // Match the Swift reader: an active but malformed scoped entry is ignored;
    // it must not displace a valid legacy seven_day_* window.
    if (limit.is_active !== false && finiteNumber(limit.utilization) === undefined && finiteNumber(limit.percent) === undefined) continue;
    const scope = isObject(limit.scope) ? limit.scope : undefined;
    const model = scope && isObject(scope.model) ? scope.model : undefined;
    const name = String(model?.display_name ?? model?.name ?? "");
    const lower = name.toLowerCase();
    if (lower.includes("fable")) { if (!isObject(fable) || limit.is_active !== false) fable = limit; }
    else if (lower.includes("routine") || lower.includes("cowork")) { if (!isObject(routines) || limit.is_active !== false) routines = limit; }
    else {
      const slug = modelSlug(name);
      if (!slug) continue;
      const existing = modelBuckets.get(slug);
      if (existing === undefined || limit.is_active !== false) modelBuckets.set(slug, limit);
    }
  }
  output.push(scoped(account, "fable", fable, now), scoped(account, "routines", routines, now));
  for (const [slug, limit] of modelBuckets) output.push(scoped(account, slug, limit, now));
  if (!output.some((item) => item.meter_id === `${account.name}:all`)) throw new Error("Claude usage response had no primary windows");
  return output;
}

/** Returns response key paths and value kinds without retaining response values. */
export async function claudeResponseShape(account: ProviderAccount, dependencies: ClaudeDependencies = {}): Promise<Array<{ path: string; kind: string }>> {
  const now = dependencies.now?.() ?? new Date();
  const darwin = dependencies.platform === "darwin" || (!dependencies.platform && process.platform === "darwin");
  if (darwin && !dependencies.keychain) return shape(JSON.parse(await (dependencies.probe ? dependencies.probe(account.location) : claudeProbe(account.location, dependencies.probePath))));
  let payload: string;
  try {
    payload = darwin
      ? await dependencies.keychain!(claudeServiceName(account.location))
      : await (dependencies.readFile ?? readCredentialFile)(credentialPath("claude", resolve(account.location)), "utf8");
  } catch { throw new Error(`${darwin ? "no credentials in Keychain for this config dir" : "no credentials for this config dir"}; ${claudeCommand(account)}`); }
  let credential: Credential;
  try { credential = parseClaudeCredential(payload, now); }
  catch { throw new Error(`credentials invalid; ${claudeCommand(account)}`); }
  if (credential.expired) throw new Error(`token expired; ${claudeCommand(account)}`);
  const response = await outboundFetch(dependencies.fetch ?? fetch, new Request("https://api.anthropic.com/api/oauth/usage", { method: "GET", headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
  if (!response.ok) throw new ProviderHTTPError(response.status, "Claude");
  return shape(await vendorJson(response));
}

export async function observeClaude(account: ProviderAccount, dependencies: ClaudeDependencies = {}): Promise<Observation[]> {
  const now = dependencies.now?.() ?? new Date();
  const timestamp = now.toISOString();
  const darwin = dependencies.platform === "darwin" || (!dependencies.platform && process.platform === "darwin");
  let credentialLoaded = false;
  try {
    if (darwin && !dependencies.keychain) return observationsFromClaudeUsage(JSON.parse(await (dependencies.probe ? dependencies.probe(account.location) : claudeProbe(account.location, dependencies.probePath))), account, now);
    const payload = darwin
      ? await dependencies.keychain!(claudeServiceName(account.location))
      : await (dependencies.readFile ?? readCredentialFile)(credentialPath("claude", resolve(account.location)), "utf8");
    credentialLoaded = true;
    const credential = parseClaudeCredential(payload, now);
    if (credential.expired) return failed(account, `token expired; ${claudeCommand(account)}`, timestamp);
    const request = new Request("https://api.anthropic.com/api/oauth/usage", { method: "GET", headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const response = await outboundFetch(dependencies.fetch ?? fetch, request);
    if (!response.ok) throw new ProviderHTTPError(response.status, "Claude");
    return observationsFromClaudeUsage(await vendorJson(response), account, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // A live 401/403 (a well-formed token the vendor rejected outright) is
    // just as actionable as a locally detected "no credentials" -- name the
    // exact fix instead of the bare "Claude usage request failed (401)",
    // which told the operator nothing to do about it.
    let reason: string;
    if (error instanceof ProviderHTTPError && (error.status === 401 || error.status === 403)) reason = `Claude rejected the token (${error.status}); ${claudeCommand(account)}`;
    else if (error instanceof ProviderHTTPError) reason = error.message;
    else if (error instanceof ClaudeProbeError && error.message.startsWith("token expired")) reason = `token expired; ${claudeCommand(account)}`;
    else if (error instanceof ClaudeProbeError && (error.kind === "denied" || error.kind === "timeout" || error.kind === "no_interaction")) reason = claudeGrantNeededReason(account.name);
    else if (error instanceof ClaudeProbeError && error.kind === "missing" && /no credentials in Keychain/.test(error.message)) {
      // The probe's own "no credentials" is ambiguous between a genuinely
      // absent login and an item that exists but lost its ACL grant when
      // Claude Code rewrote it (issue #9). Only the real probe path (darwin,
      // no injected `keychain` test seam) ever reaches this branch, so the
      // metadata lookup below is safe to run unconditionally here.
      reason = (await claudeKeychainLapseReason(account, dependencies)) ?? error.message;
    }
    else if (error instanceof ClaudeProbeError) reason = error.message;
    else if (error instanceof Error && error.message.startsWith("vendor response")) reason = error.message;
    else if (darwin && !credentialLoaded) reason = `no credentials in Keychain for this config dir; ${claudeCommand(account)}`;
    else if (/no credentials in Keychain/.test(message)) reason = `no credentials in Keychain for this config dir; ${claudeCommand(account)}`;
    else if (/credentials unavailable|credentials invalid|unsafe permissions/.test(message)) reason = `no credentials for this config dir; ${claudeCommand(account)}`;
    else reason = "Claude usage unavailable";
    return failed(account, reason, timestamp);
  }
}
