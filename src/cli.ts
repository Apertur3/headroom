#!/usr/bin/env node
import { adaptCodexPayload } from "./engine/codexbar/adapt.js";
import { engineStatus, installEngine, verifiedEnginePath } from "./engine/codexbar/install.js";
import { runCodexBar } from "./engine/codexbar/run.js";
import { observationsFromReading } from "./engine/observation.js";
import { nativeEnginePath, runNativeEngine } from "./engine/native/run.js";
import { accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { isLocalAccount, type Observation, type ProviderAccount } from "./types.js";

function formatReset(value: string | null | undefined): string {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function formatObservation(observation: Observation): string {
  if (observation.source === "engine:local" && observation.reason === "adapter pending") {
    return `${observation.meter_id}  UNKNOWN (adapter pending)`;
  }
  const amount = observation.quantity ? `${observation.quantity.used}% ↻${formatReset(observation.resets_at)}` : "UNKNOWN";
  return `${observation.meter_id}  ${amount} (${observation.freshness}; ${observation.source})${observation.reason ? `: ${observation.reason}` : ""}`;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "engine" && argv[1] === "install") {
    const result = await installEngine();
    console.log(`engine ${result.tag} installed at ${result.path} (sha256 ${result.sha256}${result.firstPin ? "; first pin recorded" : ""})`);
    return 0;
  }
  if (argv[0] === "engine" && argv[1] === "status") {
    const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath()]);
    console.log(`native ${native ? "present" : "absent"} ${native ?? "~/.tally/engine/native/tally-engine (or engine/.build/release/tally-engine)"}`);
    console.log(`upstream ${upstream.tag} ${upstream.present ? "present" : "absent"} ${upstream.path}`);
    return native || upstream.present ? 0 : 1;
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
  const providerAccounts = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account));
  const localAccounts = accounts.filter(isLocalAccount);
  const observations: Observation[] = [];
  const failures: string[] = [];
  const native = await nativeEnginePath();
  if (native) {
    try {
      observations.push(...await runNativeEngine(native, providerAccounts));
    } catch (error) {
      failures.push(`native engine source failed: ${safeError(error)}`);
    }
  }
  let engine: string | undefined;
  for (const account of native ? [] : providerAccounts) {
    if (account.adapter === "pending" || account.vendor !== "codex") { failures.push(`${account.name} source failed: native engine unavailable`); continue; }
    try {
      engine ??= await verifiedEnginePath();
      const result = await runCodexBar(engine, account);
      observations.push(...adaptCodexPayload(result.payload, account.name).flatMap(observationsFromReading));
    } catch (error) { failures.push(`${account.name} source failed: ${safeError(error)}`); }
  }
  const now = new Date().toISOString();
  for (const account of localAccounts) {
    observations.push({ principal_id: account.name, meter_id: `${account.name}:capacity`, window: null, quantity: null, resets_at: null, observed_at: now, fetched_at: now, source: "engine:local", truth: "estimated", freshness: "failed", confidence: 0, adapter_version: "pending", upstream_schema_version: "pending", reason: "adapter pending" });
  }
  if (json) console.log(JSON.stringify(observations));
  else {
    for (const observation of observations) console.log(formatObservation(observation));
    for (const failure of failures) console.log(failure);
  }
  if (failures.length) return observations.length ? 3 : 1;
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(`tally error: ${safeError(error)}`); process.exitCode = 1; });
