import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "./types.js";
import { expandHome, tallyHome } from "./paths.js";

export function accountsPath(): string { return join(tallyHome(), "accounts.toml"); }

function quoted(value: string): string { return JSON.stringify(value); }

export function accountsToml(accounts: Account[]): string {
  return accounts.map((account) => ["[[accounts]]", `name = ${quoted(account.name)}`, `vendor = ${quoted(account.vendor)}`, `location = ${quoted(account.location)}`, `adapter = ${quoted(account.adapter)}`, ""].join("\n")).join("\n");
}

export async function discoverAccounts(home = homedir()): Promise<Account[]> {
  const entries = await fs.readdir(home, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && (/^\.codex(?:\d+|[-_].+)?$/.test(entry.name) || /^\.claude(?:\d+|[-_].+)?$/.test(entry.name))).map((entry) => entry.name).sort();
  let codexNumber = 0;
  let claudeNumber = 0;
  return candidates.map((directory) => {
    const vendor = directory.startsWith(".codex") ? "codex" : "claude";
    const ordinal = vendor === "codex" ? ++codexNumber : ++claudeNumber;
    const primary = directory === `.${vendor}`;
    return {
      name: `${vendor}-${primary ? "main" : ordinal}`,
      vendor,
      location: join(home, directory),
      adapter: "native",
    };
  });
}

export async function writeDiscoveredAccounts(accounts: Account[]): Promise<void> {
  await fs.mkdir(tallyHome(), { recursive: true, mode: 0o700 });
  await fs.writeFile(accountsPath(), accountsToml(accounts), { mode: 0o600 });
  await fs.chmod(accountsPath(), 0o600);
}

export async function readAccounts(): Promise<Account[]> {
  const text = await fs.readFile(accountsPath(), "utf8");
  const accounts: Account[] = [];
  let current: Partial<Account> | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[accounts]]") { if (current) accounts.push(validate(current)); current = {}; continue; }
    const match = /^(name|vendor|location|adapter)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (!match || !current) throw new Error(`Invalid accounts.toml line: ${line}`);
    current[match[1] as keyof Account] = JSON.parse(`"${match[2]}"`) as never;
  }
  if (current) accounts.push(validate(current));
  return accounts.map((account) => ({ ...account, location: expandHome(account.location) }));
}

function validate(value: Partial<Account>): Account {
  if (!value.name || (value.vendor !== "codex" && value.vendor !== "claude" && value.vendor !== "antigravity") || !value.location || (value.adapter !== "codexbar" && value.adapter !== "native" && value.adapter !== "pending")) throw new Error("Invalid account entry in accounts.toml");
  return value as Account;
}
