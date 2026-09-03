#!/usr/bin/env node
import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { engineStatus, installEngine, verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "./registry.js";
import { safeError } from "./security.js";
import type { Reading } from "./types.js";

function formatReset(value: string | null | undefined): string {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function formatReading(reading: Reading): string {
  const five = reading.windows.five_hour;
  const weekly = reading.windows.weekly;
  const pieces = [
    five ? `5h ${five.used_percent}% ↻${formatReset(five.resets_at)}` : "5h —",
    weekly ? `wk ${weekly.used_percent}% ↻${formatReset(weekly.resets_at)}` : "wk —",
    `free resets ${reading.extras.free_resets_available ?? 0}`,
  ];
  return `${reading.account}/${reading.pool}  ${pieces.join(" | ")}`;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "engine" && argv[1] === "install") {
    const result = await installEngine();
    console.log(`engine ${result.tag} installed at ${result.path} (sha256 ${result.sha256}${result.firstPin ? "; first pin recorded" : ""})`);
    return 0;
  }
  if (argv[0] === "engine" && argv[1] === "status") {
    const status = await engineStatus();
    console.log(`engine ${status.tag} ${status.present ? "present" : "absent"} ${status.path}`);
    return status.present ? 0 : 1;
  }
  if (argv[0] === "accounts" && argv[1] === "discover") {
    const accounts = await discoverAccounts();
    console.log(accountsToml(accounts));
    await writeDiscoveredAccounts(accounts);
    return 0;
  }
  if (argv.some((arg) => arg !== "--json")) throw new Error("Usage: tally [--json] | tally engine <install|status> | tally accounts discover");
  const json = argv.includes("--json");
  const accounts = await readAccounts();
  const readings: Reading[] = [];
  const failures: string[] = [];
  let engine: string | undefined;
  for (const account of accounts) {
    if (account.adapter === "pending") { failures.push(`${account.name} source failed: adapter pending`); continue; }
    try {
      engine ??= await verifiedEnginePath();
      const result = await runCodexBar(engine, account);
      readings.push(...adaptCodexPayload(result.payload, account.name));
    } catch (error) { failures.push(`${account.name} source failed: ${safeError(error)}`); }
  }
  if (json) console.log(JSON.stringify(readings));
  else {
    for (const reading of readings) console.log(formatReading(reading));
    for (const failure of failures) console.log(failure);
  }
  if (failures.length) return readings.length ? 3 : 1;
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(`tally error: ${safeError(error)}`); process.exitCode = 1; });
