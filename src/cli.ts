#!/usr/bin/env node
import { readPolicy, readRouting } from "./config.js";
import { pathToFileURL } from "node:url";
import { engineStatus, installEngine, installNativeEngine } from "./engine/codexbar/install.js";
import { observeLocal } from "./engine/local.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { pollAccounts } from "./collector.js";
import { daemonRequest, socketPath, TallyDaemon } from "./daemon.js";
import { serveMcp } from "./mcp.js";
import { canRoute, paceDecision, type CanDecision } from "./policy.js";
import { accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "./registry.js";
import { safeError } from "./security.js";
import { installService, uninstallService } from "./service.js";
import { TallyStore } from "./store.js";
import { isLocalAccount, type Observation, type PaceState } from "./types.js";

function since(value: string | undefined): string {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? "24h");
  if (!match) throw new Error("--since must be like 15m, 24h, or 7d");
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - Number(match[1]) * multiplier).toISOString();
}

function formatReset(value: string | null | undefined): string {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function label(observation: Observation): string {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

function formatWindow(observation: Observation, state: PaceState, reason: string): string {
  if (state === "NOT_ENFORCED") return `${label(observation)} n/a${observation.reason ? ` (${observation.reason})` : ""}`;
  if (!observation.quantity || state === "UNKNOWN") return `${label(observation)} UNKNOWN (${observation.reason ?? reason})`;
  return `${label(observation)} ${Math.round(observation.quantity.used)}% ↻${formatReset(observation.resets_at)} ${state}`;
}

function formatLocal(observation: Observation): string {
  const state = observation.metadata?.state ?? "DOWN";
  if (state === "DOWN") {
    const wake = observation.reason?.match(/(?:^|; )wake: (.+)$/)?.[1];
    return wake ? `${observation.meter_id}  DOWN (wake: ${wake})` : `${observation.meter_id}  DOWN (${observation.reason ?? "down"})`;
  }
  const model = observation.metadata?.model_ids?.[0] ?? "unknown";
  return `${observation.meter_id}  ${state} model=${model} running=${observation.metadata?.running ?? observation.quantity?.used ?? 0} waiting=${observation.metadata?.waiting ?? 0}`;
}

/** Only fall back to SQLite when no daemon socket exists. A socket which cannot
 * answer health is an operational problem, not permission to race its writer. */
async function requestDaemon(method: string, params: Record<string, unknown> = {}): Promise<unknown | undefined> {
  const request = await daemonRequest(socketPath(), method, params);
  if (request.status === "available") return request.result;
  if (request.status === "unresponsive") throw new Error("Tally daemon socket is present but health did not respond within 2s");
  return undefined;
}

function age(observation: Observation): string {
  const milliseconds = Math.max(0, Date.now() - new Date(observation.fetched_at).getTime());
  return milliseconds < 60_000 ? "<1m" : `${Math.floor(milliseconds / 60_000)}m`;
}

function windowOrder(observation: Observation): number {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return 0;
  if (minutes === 10_080) return 1;
  return 2;
}

export function formatMeters(observations: Observation[], policy: Awaited<ReturnType<typeof readPolicy>>): string[] {
  const meters = new Map<string, Observation[]>();
  for (const observation of observations) meters.set(observation.meter_id, [...(meters.get(observation.meter_id) ?? []), observation]);
  return [...meters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([meter, windows]) => {
    const ordered = [...windows].sort((a, b) => windowOrder(a) - windowOrder(b) || (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER));
    if (ordered.length === 1 && ordered[0].window?.kind === "state") return formatLocal(ordered[0]);
    const enforced = ordered.filter((item) => item.freshness !== "not_enforced");
    const freshness = !enforced.length ? "not enforced" : enforced.some((item) => item.freshness === "fresh") ? "fresh" : enforced.some((item) => item.freshness === "failed") ? "failed" : "stale";
    return `${meter}  ${ordered.map((item) => {
      const decision = paceDecision(item, policy);
      return formatWindow(item, decision.state, decision.reason);
    }).join(" | ")}  (${freshness} ${age(ordered[0])})`;
  });
}

async function history(argv: string[]): Promise<number> {
  const meter = argv[0];
  if (!meter) throw new Error("Usage: tally history <meter> [--since 24h]");
  const at = argv.indexOf("--since");
  const request = await requestDaemon("history", { meter, since: since(at >= 0 ? argv[at + 1] : undefined) });
  if (request !== undefined) { console.log(JSON.stringify(unwrapRpc(request))); return 0; }
  directReadNotice();
  const store = await TallyStore.open();
  try {
    const items = store.history(meter, since(at >= 0 ? argv[at + 1] : undefined));
    store.audit("cli", "history", meter, "ok");
    console.log(JSON.stringify(items));
    return 0;
  } finally { store.close(); }
}

async function events(argv: string[]): Promise<number> {
  const at = argv.indexOf("--since");
  const request = await requestDaemon("events", { since: since(at >= 0 ? argv[at + 1] : undefined) });
  if (request !== undefined) { console.log(JSON.stringify(unwrapRpc(request))); return 0; }
  directReadNotice();
  const store = await TallyStore.open();
  try {
    const items = store.events(since(at >= 0 ? argv[at + 1] : undefined));
    store.audit("cli", "events", null, "ok");
    console.log(JSON.stringify(items));
    return 0;
  } finally { store.close(); }
}

async function can(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action) throw new Error("Usage: tally can <action-class> [--allow-unknown] [--json]");
  const routing = await readRouting();
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action}`);
  const request = await requestDaemon("can", { action_class: action, allow_unknown: argv.includes("--allow-unknown") });
  if (request !== undefined) {
    const decision = unwrapRpc(request) as CanDecision;
    printCan(decision, argv.includes("--json"));
    return decision.allowed ? 0 : 2;
  }
  directReadNotice();
  const [policy, store] = await Promise.all([readPolicy(), TallyStore.open()]);
  try {
    const localAccounts = (await readAccounts()).filter(isLocalAccount);
    // With no daemon, `can` is also a direct read: refresh local state rather
    // than deciding a routing preference from an old queue-depth sample.
    store.insertAll(await Promise.all(localAccounts.map(observeLocal)));
    const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
    const allMeters = [...new Set([...meters, ...localMeters])];
    const latest = new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
    const decision = canRoute(meters, localMeters, latest, routing.local_preference, policy, argv.includes("--allow-unknown"));
    store.audit("cli", "can", action, decision.allowed ? "yes" : "no");
    printCan(decision, argv.includes("--json"));
    return decision.allowed ? 0 : 2;
  } finally { store.close(); }
}

async function observe(argv: string[]): Promise<number> {
  const allowed = new Set(["--json", "--threshold", "--principal"]);
  for (let index = 0; index < argv.length; index += 1) { if (!allowed.has(argv[index])) throw new Error("Usage: tally [--json] [--principal X] [--threshold N]"); if (argv[index] !== "--json") index += 1; }
  const thresholdIndex = argv.indexOf("--threshold");
  const threshold = thresholdIndex >= 0 ? Number(argv[thresholdIndex + 1]) : undefined;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)) throw new Error("--threshold must be 0 through 100");
  const principalIndex = argv.indexOf("--principal");
  const principal = principalIndex >= 0 ? argv[principalIndex + 1] : undefined;
  const request = await requestDaemon("status");
  const daemonObservations = request === undefined ? undefined : unwrapRpc(request) as Observation[];
  let observations: Observation[];
  let failures: string[];
  const direct = daemonObservations === undefined;
  if (daemonObservations) {
    observations = daemonObservations.filter((item) => !principal || item.principal_id === principal);
    failures = [];
  } else {
    const polled = await pollAccounts(principal);
    failures = polled.failures;
    const store = await TallyStore.open();
    try {
      store.insertAll(polled.observations);
      observations = store.latestPerWindow().filter((item) => !principal || item.principal_id === principal);
      store.audit("cli", "observe", principal ?? null, failures.length ? "partial" : "ok");
    } finally { store.close(); }
  }
  if (direct) directReadNotice();
  const policy = await readPolicy();
  if (argv.includes("--json")) console.log(JSON.stringify(observations));
  else { for (const line of formatMeters(observations, policy)) console.log(line); for (const failure of failures) console.log(failure); }
  if (threshold !== undefined && observations.some((item) => item.freshness !== "not_enforced" && item.quantity && item.quantity.used >= threshold)) return 2;
  return failures.length ? observations.length ? 3 : 1 : 0;
}

function unwrapRpc(value: unknown): unknown {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: { message?: unknown } }).error;
    throw new Error(typeof error?.message === "string" ? error.message : "Daemon request failed");
  }
  return value;
}

function printCan(decision: CanDecision, asJson: boolean): void {
  if (asJson) { console.log(JSON.stringify(decision)); return; }
  console.log(`${decision.allowed ? "YES" : "NO"} ${decision.meter} ${decision.state} (${decision.reason})`);
  for (const meter of decision.meters) console.log(`  ${meter.meter} ${meter.state} (${meter.reason})`);
}

function directReadNotice(): void { process.stderr.write("(direct read, no daemon)\n"); }

async function daemon(): Promise<number> {
  const instance = await TallyDaemon.create();
  await instance.start();
  console.log(`tally daemon listening on ${socketPath()}`);
  await new Promise<void>((resolve) => {
    const stop = () => { void instance.stop().finally(resolve); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "engine" && argv[1] === "install") {
    const native = await installNativeEngine();
    if (native.installed) { console.log(`native engine ${native.tag} installed at ${native.path} (sha256 ${native.sha256})`); return 0; }
    console.log(`${native.hint} Falling back to the pinned upstream engine.`);
    const result = await installEngine();
    console.log(`upstream engine ${result.tag} installed at ${result.path} (sha256 ${result.sha256}${result.firstPin ? "; first pin recorded" : ""})`); return 0;
  }
  if (argv[0] === "engine" && argv[1] === "status") { const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath()]); console.log(`native ${native ? "present" : "absent"} ${native ?? "~/.tally/engine/native/tally-engine (or engine/.build/release/tally-engine)"}`); console.log(`upstream ${upstream.tag} ${upstream.present ? "present" : "absent"} ${upstream.path}`); return native || upstream.present ? 0 : 1; }
  if (argv[0] === "accounts" && argv[1] === "discover") { const accounts = await discoverAccounts(); console.log(accountsToml(accounts)); await writeDiscoveredAccounts(accounts); return 0; }
  if (argv[0] === "daemon") return daemon();
  if (argv[0] === "mcp") { serveMcp(); return await new Promise<number>(() => undefined); }
  if (argv[0] === "install-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: tally install-service [--dry-run]");
    const result = await installService(process.argv[1], process.platform, undefined, process.execPath, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would write" : "wrote"} ${result.path}\nTo load it: ${result.command}`); return 0;
  }
  if (argv[0] === "uninstall-service") { const result = await uninstallService(); console.log(`removed ${result.path}\nTo unload it: ${result.command}`); return 0; }
  if (argv[0] === "history") return history(argv.slice(1));
  if (argv[0] === "events") return events(argv.slice(1));
  if (argv[0] === "can") return can(argv.slice(1));
  return observe(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(`tally error: ${safeError(error)}`); process.exitCode = 1; });
}
