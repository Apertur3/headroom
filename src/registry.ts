import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocalAccount, type Account, type LocalAccount, type ProviderAccount } from "./types.js";
import { expandHome, tallyHome } from "./paths.js";

export function accountsPath(): string { return join(tallyHome(), "accounts.toml"); }

function quoted(value: string): string { return JSON.stringify(value); }

export function accountsToml(accounts: Account[]): string {
  return accounts.map((account) => isLocalAccount(account)
    ? ["[[accounts]]", `name = ${quoted(account.name)}`, 'kind = "local"', `base_url = ${quoted(account.base_url)}`, ...(account.wake ? [`wake = ${quoted(account.wake)}`] : []), 'adapter = "native"', ""].join("\n")
    : ["[[accounts]]", `name = ${quoted(account.name)}`, `vendor = ${quoted(account.vendor)}`, `location = ${quoted(account.location)}`, `adapter = ${quoted(account.adapter)}`, ""].join("\n")).join("\n");
}

async function exists(path: string): Promise<boolean> {
  try { await fs.access(path); return true; } catch { return false; }
}

async function agyOnPath(pathValue: string | undefined): Promise<boolean> {
  const candidates = (pathValue ?? "").split(":").filter((directory) => directory && directory !== ".");
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
  const antigravityCLI = join(home, ".gemini", "antigravity-cli");
  if (await exists(antigravityCLI) || await agyOnPath(environment.PATH)) {
    accounts.push({ name: "antigravity", vendor: "antigravity", location: await exists(antigravityCLI) ? antigravityCLI : "agy", adapter: "engine" });
  }
  return accounts;
}

export async function writeDiscoveredAccounts(accounts: Account[]): Promise<void> {
  await fs.mkdir(tallyHome(), { recursive: true, mode: 0o700 });
  await fs.writeFile(accountsPath(), accountsToml(accounts), { mode: 0o600 });
  await fs.chmod(accountsPath(), 0o600);
}

export async function readAccounts(): Promise<Account[]> {
  const text = await fs.readFile(accountsPath(), "utf8");
  const accounts: Account[] = [];
  let current: Record<string, string> | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[accounts]]") { if (current) accounts.push(validate(current)); current = {}; continue; }
    const match = /^(name|vendor|location|adapter|kind|base_url|wake)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (!match || !current) throw new Error(`Invalid accounts.toml line: ${line}`);
    current[match[1]] = JSON.parse(`"${match[2]}"`) as string;
  }
  if (current) accounts.push(validate(current));
  return accounts.map((account) => isLocalAccount(account) ? account : { ...account, location: expandHome(account.location) });
}

function validate(value: Record<string, string>): Account {
  if (value.kind === "local") {
    if (!value.name || !value.base_url || (value.adapter && value.adapter !== "native")) throw new Error("Invalid local account entry in accounts.toml");
    return { name: value.name, kind: "local", base_url: value.base_url, ...(value.wake ? { wake: value.wake } : {}), adapter: "native" } satisfies LocalAccount;
  }
  if (!value.name || (value.vendor !== "codex" && value.vendor !== "claude" && value.vendor !== "antigravity") || !value.location || (value.adapter !== "codexbar" && value.adapter !== "native" && value.adapter !== "native-ts" && value.adapter !== "engine" && value.adapter !== "pending")) throw new Error("Invalid account entry in accounts.toml");
  // `native` was the old Swift-first spelling. Preserve existing configs while
  // making the new registry default unambiguous.
  const adapter = value.adapter === "native" ? (value.vendor === "antigravity" ? "engine" : "native-ts") : value.adapter;
  return { name: value.name, vendor: value.vendor, location: value.location, adapter } as ProviderAccount;
}
