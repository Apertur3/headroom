import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocalAccount, type Account, type LocalAccount, type ProviderAccount } from "./types.js";
import { assertSafeAncestry, expandHome, headroomHome, vendorHome } from "./paths.js";
import { readBoundedRegularFile, withAccountsLock, writeFileAtomic } from "./security.js";
import { grokAuthPath } from "./adapters/grok.js";
import { kimiCliCredentialPath, kimiTokenPath } from "./adapters/kimi.js";

export function accountsPath(): string { return join(headroomHome(), "accounts.toml"); }

function quoted(value: string): string { return JSON.stringify(value); }

export function accountsToml(accounts: Account[]): string {
  return accounts.map((account) => isLocalAccount(account)
    ? ["[[accounts]]", `name = ${quoted(account.name)}`, ...(account.enabled === false ? ["enabled = false"] : []), 'kind = "local"', `base_url = ${quoted(account.base_url)}`, ...(account.wake ? [`wake = ${quoted(account.wake)}`] : []), 'adapter = "native"', ""].join("\n")
    : ["[[accounts]]", `name = ${quoted(account.name)}`, ...(account.enabled === false ? ["enabled = false"] : []), `vendor = ${quoted(account.vendor)}`, `location = ${quoted(account.location)}`, `adapter = ${quoted(account.adapter)}`, ...(account.agy_path ? [`agy_path = ${quoted(account.agy_path)}`] : []), ...(account.alias ? [`alias = ${quoted(account.alias)}`] : []), ""].join("\n")).join("\n");
}

async function exists(path: string): Promise<boolean> {
  try { await fs.access(path); return true; } catch { return false; }
}

async function agyOnPath(pathValue: string | undefined): Promise<boolean> {
  const candidates = (pathValue ?? "").split(process.platform === "win32" ? ";" : ":").filter((directory) => directory && directory !== ".");
  return (await Promise.all(candidates.map(async (directory) => {
    try { await fs.access(join(directory, "agy"), constants.X_OK); return true; } catch { return false; }
  }))).some(Boolean);
}

export async function discoverAccounts(home = homedir(), environment = process.env): Promise<Account[]> {
  const entries = await fs.readdir(home, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && (/^\.codex(?:\d+|[-_].+)?$/.test(entry.name) || /^\.claude(?:\d+|[-_].+)?$/.test(entry.name))).map((entry) => entry.name).sort();
  let codexNumber = 0;
  let claudeNumber = 0;
  const accounts: ProviderAccount[] = candidates.map((directory) => {
    const vendor = directory.startsWith(".codex") ? "codex" : "claude";
    const ordinal = vendor === "codex" ? ++codexNumber : ++claudeNumber;
    const primary = directory === `.${vendor}`;
    return {
      name: `${vendor}-${primary ? "main" : ordinal}`,
      vendor,
      location: join(home, directory),
      adapter: "native-ts",
    };
  });
  const antigravityCLI = join(vendorHome("gemini", { home }), "antigravity-cli");
  if (await exists(antigravityCLI) || await agyOnPath(environment.PATH)) {
    accounts.push({ name: "antigravity", vendor: "antigravity", location: await exists(antigravityCLI) ? antigravityCLI : "agy", adapter: "native-ts" });
  }
  // Gemini CLI consumer subscriptions were retired on 2026-06-18.
  // Old OAuth files must not create a second, unusable subscription.
  // `grok login` writes its token under GROK_HOME, defaulting to ~/.grok.
  const grokHome = environment.GROK_HOME ? expandHome(environment.GROK_HOME) : join(home, ".grok");
  if (await exists(grokAuthPath(grokHome, home))) {
    accounts.push({ name: "grok", vendor: "grok", location: grokHome, adapter: "native-ts" });
  }
  // Kimi, in order of preference. The Kimi Code CLI writes an OAuth credential
  // of its own, which needs nothing from the operator; the manual token file
  // stays the documented alternative for anyone who only has the desktop app,
  // whose session token lives in a browser cookie store this project does not
  // open. Whichever exists names the principal's `location`; the CLI credential
  // wins when both do (see docs/vendors.md).
  const kimiCredentials = [kimiCliCredentialPath(home, environment), kimiTokenPath(undefined, home)];
  for (const credential of kimiCredentials) {
    if (!await exists(credential)) continue;
    accounts.push({ name: "kimi", vendor: "kimi", location: credential, adapter: "native-ts" });
    break;
  }
  return accounts;
}

export async function writeDiscoveredAccounts(accounts: Account[]): Promise<void> {
  const home = headroomHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  // Same trust boundary as policy.toml's own editor (cli.ts's policySet*):
  // refuse a home directory reached through an unsafe (foreign-owned, or
  // writable-without-sticky-bit) ancestor before ever touching the file that
  // names every principal's credential location.
  await assertSafeAncestry(home);
  // The complete read-modify-write runs under the shared accounts.toml lock
  // (see setAccountEnabled's own comment for the race this closes): without
  // it, a rediscovery here could read a principal's `enabled` flag before a
  // concurrent `accounts disable` writes it, then overwrite that write with
  // this scan's own default -- silently re-enabling a principal an operator
  // just parked.
  await withAccountsLock(home, async () => {
    // Discovery updates locations and adapters, but an existing account is
    // the operator's configuration. In particular, rediscovery must not
    // wake a deliberately parked principal.
    const existing = await readAccountsOrEmpty();
    // Only the operator's `enabled` flag survives a rediscovery for a name it
    // already knew -- everything else (location, adapter, etc.) comes from the
    // fresh scan, so a moved config dir or a changed adapter actually takes
    // effect instead of being frozen at whatever discovery first saw. A
    // provider account discovery no longer finds (credential removed, config
    // dir gone) is dropped, matching docs/vendors.md's "rerunning discovery
    // replaces the account file" -- it must stop being polled forever. Local
    // accounts (`kind: "local"`) are never produced by discovery at all and
    // are preserved untouched.
    const priorEnabled = new Map(existing.map((account) => [account.name, account.enabled]));
    const discovered = accounts.map((account) => priorEnabled.get(account.name) === false ? ({ ...account, enabled: false } as Account) : account);
    const localAccounts = existing.filter(isLocalAccount);
    const merged = [...discovered, ...localAccounts];
    // Atomic (temp file + rename) on every platform, and 0600 on POSIX (mode
    // bits are meaningless on Windows, which has no equivalent here -- see
    // writeFileAtomic's own doc comment): a plain writeFile's `mode` option
    // only applies the first time the path is created -- an existing
    // accounts.toml left permissive by an older Headroom, or by an operator's
    // own editor, would otherwise stay permissive forever, and a write
    // interrupted mid-truncate could leave a corrupt file. writeFileAtomic
    // instead builds the new file with the right mode from the start and
    // rename()s it into place, refusing outright if accounts.toml is itself a
    // symlink.
    await writeFileAtomic(accountsPath(), accountsToml(merged), 0o600);
  });
}

/** accounts.toml does not exist yet (a fresh home, before `accounts discover`).
 * Carries ENOENT and the path like the raw fs error it replaces, but is
 * recognised by type, so the match never depends on how the platform spells
 * the path (drive-letter case, short 8.3 names, separators). */
export class AccountsMissingError extends Error {
  readonly code = "ENOENT";
  constructor(readonly path: string) { super(`ENOENT: no such file or directory, open '${path}'`); this.name = "AccountsMissingError"; }
}

export async function readAccounts(): Promise<Account[]> {
  // No-follow and bounded: accounts.toml names every principal's credential
  // location, and both registry mutations below read it before ever
  // reaching writeFileAtomic's own symlink check on the write side -- a
  // plain readFile here would still follow a symlink planted at this path,
  // or block indefinitely reading a FIFO someone left there instead.
  let text: string;
  try { text = await readBoundedRegularFile(accountsPath()); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AccountsMissingError(accountsPath());
    throw error;
  }
  const accounts: Account[] = [];
  let current: Record<string, string> | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[\[accounts\]\]\s*(?:#.*)?$/.test(line)) { if (current) accounts.push(validate(current)); current = {}; continue; }
    const stringMatch = /^(name|vendor|location|adapter|kind|base_url|wake|agy_path|alias)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    const enabledMatch = /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (!current || (!stringMatch && !enabledMatch)) throw new Error(`Invalid accounts.toml line: ${line}`);
    if (stringMatch) current[stringMatch[1]] = JSON.parse(`"${stringMatch[2]}"`) as string;
    else current.enabled = enabledMatch![1];
  }
  if (current) accounts.push(validate(current));
  return accounts.map((account) => isLocalAccount(account) ? account : { ...account, location: expandHome(account.location) });
}

/**
 * The disabled-principal check (and anything else that only needs to know
 * *which* principals exist, not fail a whole command over it) reads the
 * registry through this instead of a swallowing `.catch(() => [])`: a
 * missing `accounts.toml` (before the first `accounts discover`) is a
 * normal, well-defined "no accounts configured" state, but a malformed or
 * otherwise unreadable file must still fail closed -- propagated here, never
 * silently reported as "nothing disabled," which could let a parked
 * principal's stored capacity look admissible again.
 */
export async function readAccountsOrEmpty(): Promise<Account[]> {
  return readAccounts().catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Account[];
    throw error;
  });
}

function validate(value: Record<string, string>): Account {
  if (value.kind === "local") {
    if (!value.name || !value.base_url || (value.adapter && value.adapter !== "native")) throw new Error("Invalid local account entry in accounts.toml");
    return { name: value.name, ...(value.enabled === "false" ? { enabled: false } : {}), kind: "local", base_url: value.base_url, ...(value.wake ? { wake: value.wake } : {}), adapter: "native" } satisfies LocalAccount;
  }
  if (!value.name || (value.vendor !== "codex" && value.vendor !== "claude" && value.vendor !== "antigravity" && value.vendor !== "gemini" && value.vendor !== "grok" && value.vendor !== "kimi") || !value.location || (value.adapter !== "codexbar" && value.adapter !== "native" && value.adapter !== "native-ts" && value.adapter !== "engine" && value.adapter !== "pending")) throw new Error("Invalid account entry in accounts.toml");
  // `native` was the old Swift-first spelling. Preserve existing configs while
  // making the new registry default unambiguous.
  const adapter = value.adapter === "native" ? (value.vendor === "antigravity" ? "engine" : "native-ts") : value.adapter;
  return { name: value.name, ...(value.enabled === "false" ? { enabled: false } : {}), vendor: value.vendor, location: value.location, adapter, ...(value.agy_path ? { agy_path: expandHome(value.agy_path) } : {}), ...(value.alias ? { alias: value.alias } : {}) } as ProviderAccount;
}

/** Changes only one entry's enabled line. This avoids a serialize/parse round
 * trip that would erase an operator's comments, layout, and unknown future
 * TOML keys just to park one principal.
 *
 * The complete read-modify-write runs under the shared accounts.toml lock
 * (withAccountsLock, security.js -- same design as policy.toml's own lock,
 * a separate lock directory since the two files have no ordering to protect
 * between them): setAccountEnabled and a concurrent rediscovery
 * (writeDiscoveredAccounts) are two independent read-modify-write paths on
 * the same file, and without a shared lock, a rediscovery's own read could
 * land before this call's write and its later write then overwrite it --
 * silently re-enabling a principal an operator just disabled. */
export async function setAccountEnabled(name: string, enabled: boolean): Promise<void> {
  const path = accountsPath();
  const home = headroomHome();
  await assertSafeAncestry(home);
  await withAccountsLock(home, async () => {
    // Same no-follow, bounded read as readAccounts() above -- setAccountEnabled
    // has its own direct read (it edits raw lines rather than the parsed
    // form), so it needs the same guard before it, not just writeFileAtomic's
    // symlink refusal on the write that follows.
    const text = await readBoundedRegularFile(path);
    const lines = text.split(/(?<=\n)/);
    const bare = (line: string): string => line.replace(/\r?\n$/, "");
    const starts = lines.map((line, index) => /^\s*\[\[accounts\]\]\s*(?:#.*)?$/.test(bare(line)) ? index : -1).filter((index) => index >= 0);
    let start = -1, end = lines.length, nameLine = -1;
    for (let index = 0; index < starts.length; index += 1) {
      const candidateStart = starts[index];
      const candidateEnd = starts[index + 1] ?? lines.length;
      const found = lines.slice(candidateStart + 1, candidateEnd).findIndex((line) => {
        const match = /^\s*name\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(bare(line));
        return match !== null && JSON.parse(match[1]) === name;
      });
      if (found >= 0) { start = candidateStart; end = candidateEnd; nameLine = candidateStart + 1 + found; break; }
    }
    if (start < 0) throw new Error(`Unknown account: ${name}`);
    const enabledLine = lines.slice(start + 1, end).findIndex((line) => /^\s*enabled\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(bare(line)));
    if (enabledLine >= 0) {
      const index = start + 1 + enabledLine;
      lines[index] = lines[index].replace(/^(\s*)enabled\s*=\s*(?:true|false)(\s*(?:#.*)?)(\r?\n?)$/, `$1enabled = ${enabled}$2$3`);
    } else {
      const newline = lines[nameLine].endsWith("\r\n") ? "\r\n" : "\n";
      if (!lines[nameLine].endsWith("\n")) lines[nameLine] += newline;
      lines.splice(nameLine + 1, 0, `enabled = ${enabled}${newline}`);
    }
    // Atomic on every platform, 0600 on POSIX -- see writeDiscoveredAccounts'
    // own comment: a plain writeFile here would leave an existing permissive
    // mode untouched, could truncate the file on an interrupted write, and
    // would follow a symlink at this path instead of refusing it.
    await writeFileAtomic(path, lines.join(""), 0o600);
  });
}
