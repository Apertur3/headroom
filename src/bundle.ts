/**
 * `headroom doctor --bundle [<path>]`: one redacted, human-readable text file
 * meant to be pasted into a GitHub issue. Everything here is read-only, same
 * as the rest of doctor.ts -- generating a bundle must never poll a vendor,
 * write a credential, or touch accounts.toml, policy.toml or routing.toml
 * for anything other than reading their (redacted) text.
 *
 * Every section is gathered independently and never throws: a partially
 * broken install (the very reason someone is filing a bug) still produces a
 * usable bundle, with the broken section saying so instead of the whole
 * command failing.
 */
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir, hostname as machineHostname, release as osRelease, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatMeters } from "./cli.js";
import { readPolicy } from "./config.js";
import { parseNotifyConfig, type NotifyConfig } from "./notify.js";
import { parsePolicy, type Policy } from "./policy.js";
import { doctorChecks, doctorFileStatus, type DoctorCheck } from "./doctor.js";
import { tailDaemonLog } from "./logs.js";
import { withPaceInfo } from "./pace.js";
import { headroomHome } from "./paths.js";
import { accountsPath, readAccounts } from "./registry.js";
import { redact, storedDeliveryError, writeFileAtomic } from "./security.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type Lease } from "./types.js";
import { headroomVersion } from "./version.js";

const AUDIT_ROW_LIMIT = 20;
const DAEMON_LOG_LINES = 50;

export interface DoctorBundleResult {
  path: string;
  bytes: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Private-network and carrier-grade-NAT ranges an operator's own machine
 * could be sitting on: 10/8, 172.16/12, 192.168/16 (RFC1918) and 100.64/10
 * (the range Tailscale and similar tailnets use). None of these help anyone
 * reading a bug report, and every one of them names a specific home or
 * office network. */
function isPrivateIpv4(first: number, second: number): boolean {
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

function redactNetworkAddresses(text: string): string {
  return text.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (whole, first: string, second: string) => (isPrivateIpv4(Number(first), Number(second)) ? "[REDACTED]" : whole));
}

/** Catches an assignment-shaped secret (`token=...`, `api_key: "..."`) that
 * none of security.ts's redact() token-shape patterns happen to match.
 * Belt-and-suspenders: policy.toml and routing.toml have no such fields
 * today, so this is expected to find nothing, but it runs on every bundle
 * regardless of what today's schema happens to hold. */
function redactAssignedSecrets(text: string): string {
  return text.replace(/\b(token|api[_-]?key|secret|password|passwd|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

/** A URL's `user:pass@` part: everything in the authority up to its last
 * `@`, whatever characters the password holds and whatever host follows. */
function redactUrlUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[REDACTED]@");
}

/** Scheme and host of an http(s) URL, without user info, path or query. */
function urlOrigin(value: string): string | undefined {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : undefined; } catch { return undefined; }
}

/**
 * policy.toml as Headroom itself parses it, never its raw text: comments and
 * anything the parsers do not read are dropped. Every notify channel value
 * (webhook URL, ntfy topic and server, Telegram chat id) is a capability for
 * that channel, so a URL keeps only its scheme and host and anything else is
 * replaced; the proxy keeps only its scheme and host. A file that does not
 * parse is left out whole, since the parse error alone cannot say which line
 * holds a secret.
 */
export function policyListing(text: string): string[] {
  let policy: Policy, notify: NotifyConfig | undefined;
  try { policy = parsePolicy(text); notify = parseNotifyConfig(text); }
  catch { return ["policy.toml did not parse; contents left out (headroom doctor names the problem)"]; }
  const channel = (values: object) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "string" ? urlOrigin(value) ?? "[REDACTED]" : value]));
  const { policy_mtime: _mtime, proxy, ...rest } = policy;
  const listing = { ...rest, ...(proxy ? { proxy: urlOrigin(proxy) ?? "[REDACTED]" } : {}), ...(notify ? { notify: { ...notify, telegram: channel(notify.telegram), ntfy: channel(notify.ntfy), webhook: channel(notify.webhook) } } : {}) };
  return JSON.stringify(listing, null, 2).split("\n");
}

/** The configured channel capabilities (ntfy topic, Telegram chat id, webhook
 * path): replaced wherever they turn up, since an older version's log line can
 * carry a channel reply that no line-shape rule can bound. */
export function channelCapabilities(text: string): string[] {
  let notify: NotifyConfig | undefined;
  try { notify = parseNotifyConfig(text); } catch { return []; }
  if (!notify) return [];
  const hook: string[] = [];
  for (const value of [notify.webhook.url, notify.ntfy.server]) {
    try { if (value) { const url = new URL(value); hook.push(url.pathname + url.search, url.pathname, url.search); } } catch { /* not a URL */ }
  }
  // Longest first, so a path is replaced before its own query. Values under 3
  // characters guard nothing (anyone can guess them) and would wipe the bundle.
  return [notify.ntfy.topic, notify.telegram.chat_id, ...hook].filter((value): value is string => !!value && value.length >= 3 && value !== "/").sort((a, b) => b.length - a.length);
}

/** Replaces this machine's home directory, username, and hostname wherever
 * they appear verbatim -- identifiers redact() has no way to recognize on
 * its own, since none of them are shaped like a token. Runs after redact()
 * so a path that happens to embed something token-shaped is still caught by
 * both passes. */
function redactMachineIdentity(text: string, home: string, username: string, hostname: string): string {
  let output = home ? text.split(home).join("~") : text;
  if (username) {
    const segment = new RegExp(`(?<=^|[\\\\/])${escapeRegExp(username)}(?=[\\\\/]|$)`, "gm");
    output = output.replace(segment, "<user>");
  }
  if (hostname && hostname !== "localhost") output = output.split(hostname).join("<host>");
  return output;
}

/** accounts.toml's own location -- named explicitly, on top of the general
 * home/username scrubbing above, because a custom HEADROOM_HOME can point
 * it entirely outside the home directory that scrubbing pass recognizes.
 * The database file gets the same treatment even though nothing in this
 * bundle currently prints its path; masking it here costs nothing and
 * matches the same "never verbatim" rule. */
function redactKnownStoreLocations(text: string, home: string): string {
  return text.split(accountsPath()).join("<accounts.toml>").split(join(home, "headroom.db")).join("<headroom.db>");
}

/** The full redaction pass, applied once to the whole assembled bundle
 * rather than per-section, so no section can accidentally skip it. */
export function redactBundleText(text: string, capabilities: string[] = []): string {
  const withoutCapabilities = capabilities.reduce((output, value) => output.replace(new RegExp(escapeRegExp(value), "gi"), "[REDACTED]"), text);
  // Older versions put the malformed policy.toml line itself into
  // this error, and the daemon log keeps it.
  const withoutConfigLines = withoutCapabilities.replace(/(Invalid Headroom notify config:)[^\n]*/g, "$1 [REDACTED]")
    // Delivery failures in the daemon log, which older versions logged with
    // the channel's reply text.
    .replace(/(notify \S+ (?:failed for \d+ event\(s\)|gave up on \d+ event\(s\) after \d+ attempts): )([^\n]*)/g, (_line, prefix: string, detail: string) => prefix + storedDeliveryError(detail));
  const withTokensAndEmails = redact(redactUrlUserinfo(withoutConfigLines));
  const withoutNetworkAddresses = redactNetworkAddresses(withTokensAndEmails);
  const withoutAssignedSecrets = redactAssignedSecrets(withoutNetworkAddresses);
  const withoutKnownStoreLocations = redactKnownStoreLocations(withoutAssignedSecrets, headroomHome());
  return redactMachineIdentity(withoutKnownStoreLocations, homedir(), userInfo().username, machineHostname());
}

function renderDoctorLine(item: DoctorCheck): string {
  // Mirrors doctor.ts's own (unexported) rendered(): level, check name,
  // detail, and fix, exactly as `headroom doctor` prints them.
  return `${item.level.padEnd(4)} ${item.check}: ${item.detail} — ${item.fix}`;
}

async function doctorLinesSection(): Promise<string[]> {
  try {
    const checks = await doctorChecks();
    return checks.map(renderDoctorLine);
  } catch (error) {
    return [`doctor checks unavailable: ${errorMessage(error)}`];
  }
}

async function principalLines(): Promise<string[]> {
  try {
    const accounts = await readAccounts();
    if (!accounts.length) return ["no principals configured"];
    return accounts.map((account) => isLocalAccount(account)
      ? `${account.name}  kind=local adapter=${account.adapter}`
      : `${account.name}  vendor=${account.vendor} adapter=${account.adapter}`);
  } catch (error) {
    return [`principals unavailable: ${errorMessage(error)}`];
  }
}

/** One config file (policy.toml or routing.toml), held to the same file-safety
 * bar doctor's own configCheck() uses. routing.toml holds no secrets and is
 * copied as text; policy.toml does (notify channels, a proxy password), so it
 * goes through policyListing() instead. */
async function configFileSection(path: string, render: (text: string) => string[] = (text) => text.split("\n")): Promise<string[]> {
  const status = await doctorFileStatus(path).catch<DoctorFileStatusFallback>(() => "unsafe");
  if (status === "missing") return ["not present; using built-in defaults"];
  if (status === "unsafe") return [`unsafe file, skipped: ${path}`];
  try {
    return render(await readFile(path, "utf8"));
  } catch (error) {
    return [`unreadable: ${errorMessage(error)}`];
  }
}
type DoctorFileStatusFallback = "present" | "missing" | "unsafe";

async function daemonLogSection(home: string): Promise<string[]> {
  try {
    const text = await tailDaemonLog(DAEMON_LOG_LINES, home);
    // Every record starts with its timestamp. A line without one is the rest of a
    // multi-line message (older versions logged channel replies whole), so it goes.
    return text ? text.split("\n").map((line) => /^\d{4}-\d\d-\d\dT\S+Z /.test(line) ? line : "[continuation line hidden]") : ["no daemon log written yet"];
  } catch (error) {
    return [`daemon log unavailable: ${errorMessage(error)}`];
  }
}

interface AuditDatabase {
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}

/**
 * store.ts exposes no public read of the audit table (its own audit() is
 * insert-only), and adding one there is out of scope here. Opens its own
 * read connection to the same SQLite file instead, same "node:sqlite" via
 * createRequire technique store.ts uses, held to the same file-safety bar
 * (doctorFileStatus) every other path in this bundle uses before it is read.
 */
async function auditRowsSection(home: string): Promise<string[]> {
  const dbPath = join(home, "headroom.db");
  const status = await doctorFileStatus(dbPath).catch<DoctorFileStatusFallback>(() => "unsafe");
  if (status !== "present") return ["no audit rows recorded yet"];
  try {
    const DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => AuditDatabase }).DatabaseSync;
    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("SELECT caller, action, meter_or_principal, outcome, at FROM audit ORDER BY id DESC LIMIT ?").all(AUDIT_ROW_LIMIT);
      if (!rows.length) return ["no audit rows recorded yet"];
      return rows.reverse().map((row) => `${row.at}  ${row.caller}  ${row.action}  ${row.meter_or_principal ?? "-"}  ${row.outcome}`);
    } finally { db.close(); }
  } catch (error) {
    return [`audit rows unavailable: ${errorMessage(error)}`];
  }
}

/** The current cached meter lines, formatted exactly as `headroom status`
 * prints them -- read straight from the store, same as status's own
 * no-daemon fallback. Deliberately never polls a vendor: doctor (and so the
 * bundle it builds) is a non-mutating diagnostic. */
async function statusLinesSection(): Promise<string[]> {
  try {
    const policy = await readPolicy();
    const store = await HeadroomStore.open();
    try {
      const raw = store.latestPerWindow();
      const now = new Date();
      const observations = withPaceInfo(raw, store.burnRateFor(raw, now), now);
      const resetSeen = store.resetSeenFor(observations);
      const freeResetUsed = store.freeResetUsedFor(observations);
      const leases = store.leases(undefined, true);
      const leaseMap = new Map<string, Lease[]>();
      for (const item of leases) leaseMap.set(item.meter_id, [...(leaseMap.get(item.meter_id) ?? []), item]);
      const lines = formatMeters(observations, policy, resetSeen, leaseMap, freeResetUsed);
      return lines.length ? lines : ["no readings yet"];
    } finally { store.close(); }
  } catch (error) {
    return [`status unavailable: ${errorMessage(error)}`];
  }
}

async function binaryPathLine(): Promise<string> {
  const candidate = process.argv[1] ?? process.execPath;
  try { return await realpath(candidate); } catch { return candidate; }
}

function section(title: string, lines: string[]): string[] {
  return [`== ${title} ==`, ...(lines.length ? lines : ["(none)"]), ""];
}

const DISCLAIMER = [
  "Headroom support bundle",
  "",
  "This file has been redacted before writing: token- and credential-shaped",
  "values, email addresses, private network addresses, this machine's",
  "hostname, home directory and username were replaced with placeholders.",
  "Redaction is best effort, not a guarantee -- read the whole file yourself",
  "before pasting it into a GitHub issue.",
  "",
];

/** Assembles every section, in the fixed order the bundle test locks down,
 * then runs the single redaction pass over the whole thing. */
export async function buildBundleText(): Promise<string> {
  const home = headroomHome();
  const routingPath = process.env.HEADROOM_ROUTING ?? join(home, "routing.toml");
  const [version, doctorLines, principals, policyLines, routingLines, daemonLog, auditRows, statusLines, binaryPath] = await Promise.all([
    headroomVersion(),
    doctorLinesSection(),
    principalLines(),
    configFileSection(join(home, "policy.toml"), policyListing),
    configFileSection(routingPath),
    daemonLogSection(home),
    auditRowsSection(home),
    statusLinesSection(),
    binaryPathLine(),
  ]);
  const header = [
    ...DISCLAIMER,
    `Headroom version: ${version}`,
    `Node version: ${process.version}`,
    `OS: ${process.platform} ${process.arch} (${osRelease()})`,
    `Binary: ${binaryPath}`,
    "",
  ];
  const body = [
    ...section("doctor", doctorLines),
    ...section("principals", principals),
    ...section("policy.toml", policyLines),
    ...section("routing.toml", routingLines),
    ...section(`daemon log (last ${DAEMON_LOG_LINES} lines)`, daemonLog),
    ...section(`audit (last ${AUDIT_ROW_LIMIT} rows)`, auditRows),
    ...section("status", statusLines),
  ];
  const capabilities = channelCapabilities(await readFile(join(home, "policy.toml"), "utf8").catch(() => ""));
  return redactBundleText([...header, ...body].join("\n"), capabilities);
}

function defaultBundleFilename(): string {
  return `headroom-bundle-${new Date().toISOString().slice(0, 10)}.txt`;
}

/** A bare `--bundle` (or one followed by another flag) writes the default
 * filename in the current directory; `--bundle <path>` writes there instead,
 * or into that directory (with the default filename) when it already exists
 * as one. */
async function resolveBundlePath(requested: string | undefined, cwd: string): Promise<string> {
  if (!requested) return join(cwd, defaultBundleFilename());
  const resolved = resolve(cwd, requested);
  try {
    const info = await lstat(resolved);
    if (info.isDirectory()) return join(resolved, defaultBundleFilename());
  } catch { /* does not exist yet: treat it as the exact file path requested */ }
  return resolved;
}

export async function writeDoctorBundle(requestedPath?: string, cwd: string = process.cwd()): Promise<DoctorBundleResult> {
  const path = await resolveBundlePath(requestedPath, cwd);
  await mkdir(dirname(path), { recursive: true });
  const text = await buildBundleText();
  await writeFileAtomic(path, text, 0o600);
  const info = await lstat(path);
  return { path, bytes: info.size };
}

/** Reads the optional path after `--bundle` off the raw doctor argv: absent,
 * or the next token when it is not itself another flag. */
export function parseBundleFlag(argv: string[]): string | undefined {
  const index = argv.indexOf("--bundle");
  if (index === -1) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : undefined;
}
