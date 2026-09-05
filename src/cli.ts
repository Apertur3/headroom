#!/usr/bin/env node
import { readPolicy, readRouting } from "./config.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { appendDaemonLog, tailDaemonLog } from "./logs.js";
import { doctor } from "./doctor.js";
import { engineStatus, installEngine, installNativeEngine } from "./engine/codexbar/install.js";
import { observeLocal } from "./engine/local.js";
import { nativeEnginePath } from "./engine/native/run.js";
import { claudeGrantGate, claudeResponseShape, grantClaudeKeychainAccess, probeBinaryHash, syncClaudeGrantState } from "./adapters/claude.js";
import { codexResponseShape } from "./adapters/codex.js";
import { pollAccounts } from "./collector.js";
import { daemonRequest, socketPath, HeadroomDaemon } from "./daemon.js";
import { serveMcp } from "./mcp.js";
import { canRouteWithLeases, paceDecision, unknownMeterPrincipals, type CanDecision } from "./policy.js";
import { accountsToml, discoverAccounts, readAccounts, writeDiscoveredAccounts } from "./registry.js";
import { migrateLegacyHome } from "./paths.js";
import { safeError, stripAmbientProxyEnvironment } from "./security.js";
import { installService, uninstallService } from "./service.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type Lease, type Observation, type PaceState, type HeadroomEvent, type ProviderAccount } from "./types.js";

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

function windowKey(observation: Observation): string { return `${observation.meter_id}:${observation.window?.minutes ?? "none"}`; }

function formatWindow(observation: Observation, state: PaceState, reason: string, resetSeen?: string, freeResetUsed?: string): string {
  if (observation.window?.kind === "count" && observation.quantity?.unit === "credits") {
    const available = observation.quantity.remaining ?? 0;
    const date = observation.resets_at ? new Date(observation.resets_at) : undefined;
    const expiry = date && !Number.isNaN(date.getTime()) ? ` (expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)})` : "";
    return `credits ${available} available${expiry}`;
  }
  const evidence = `${resetSeen ? ` reset seen ${formatReset(resetSeen)}` : ""}${freeResetUsed ? ` free reset ${formatReset(freeResetUsed)}` : ""}`;
  if (state === "NOT_ENFORCED") return `${label(observation)} n/a${observation.reason ? ` (${observation.reason})` : ""}`;
  if (!observation.quantity || state === "UNKNOWN") return `${label(observation)} UNKNOWN (${observation.reason ?? reason})${evidence}`;
  return `${label(observation)} ${Math.round(observation.quantity.used)}% ↻${formatReset(observation.resets_at)} ${state}${evidence}`;
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
  if (request.status === "unresponsive") throw new Error("Headroom daemon socket is present but health did not respond within 2s");
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

export interface ThresholdWindow {
  meter_id: string;
  window_minutes: number | null;
  used_percent: number | null;
  crossed: boolean;
  blocking: boolean;
  freshness: Observation["freshness"];
}

export function thresholdReport(observations: Observation[], threshold: number): ThresholdWindow[] {
  return observations.map((item) => {
    const used = item.quantity?.unit === "percent" ? item.quantity.used : null;
    const crossed = item.freshness !== "not_enforced" && used !== null && used >= threshold;
    const blocking = item.freshness !== "not_enforced" && (item.freshness !== "fresh" || crossed);
    return { meter_id: item.meter_id, window_minutes: item.window?.minutes ?? null, used_percent: used, crossed, blocking, freshness: item.freshness };
  });
}

export function formatMeters(observations: Observation[], policy: Awaited<ReturnType<typeof readPolicy>>, resetSeen = new Map<string, string>(), leases = new Map<string, Lease[]>(), freeResetUsed = new Map<string, string>()): string[] {
  const meters = new Map<string, Observation[]>();
  for (const observation of observations) meters.set(observation.meter_id, [...(meters.get(observation.meter_id) ?? []), observation]);
  return [...meters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([meter, windows]) => {
    const ordered = [...windows].sort((a, b) => windowOrder(a) - windowOrder(b) || (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER));
    if (ordered.length === 1 && ordered[0].window?.kind === "state") return formatLocal(ordered[0]);
    const enforced = ordered.filter((item) => item.freshness !== "not_enforced");
    const freshness = !enforced.length ? "not enforced" : enforced.some((item) => item.freshness === "fresh") ? "fresh" : enforced.some((item) => item.freshness === "failed") ? "failed" : "stale";
    const active = leases.get(meter) ?? [];
    const leaseLabel = active.length ? ` leases: ${active.length} (${active.map((item) => item.owner).join(", ")})` : "";
    return `${meter}  ${ordered.map((item) => {
      const decision = paceDecision(item, policy);
      return formatWindow(item, decision.state, decision.reason, resetSeen.get(windowKey(item)), freeResetUsed.get(windowKey(item)));
    }).join(" | ")}  (${freshness} ${age(ordered[0])})${leaseLabel}`;
  });
}

async function history(argv: string[]): Promise<number> {
  const meter = argv[0];
  if (!meter) throw new Error("Usage: headroom history <meter> [--since 24h]");
  const at = argv.indexOf("--since");
  const request = await requestDaemon("history", { meter, since: since(at >= 0 ? argv[at + 1] : undefined) });
  if (request !== undefined) { console.log(JSON.stringify(unwrapRpc(request))); return 0; }
  directReadNotice();
  const store = await HeadroomStore.open();
  try {
    const items = store.history(meter, since(at >= 0 ? argv[at + 1] : undefined));
    store.audit("cli", "history", meter, "ok");
    console.log(JSON.stringify(items));
    return 0;
  } finally { store.close(); }
}

async function events(argv: string[]): Promise<number> {
  const at = argv.indexOf("--since");
  const table = argv.includes("--table");
  const request = await requestDaemon("events", { since: since(at >= 0 ? argv[at + 1] : undefined) });
  if (request !== undefined) { printEventsOutput(unwrapRpc(request) as HeadroomEvent[], table); return 0; }
  directReadNotice();
  const store = await HeadroomStore.open();
  try {
    const items = store.events(since(at >= 0 ? argv[at + 1] : undefined));
    store.audit("cli", "events", null, "ok");
    printEventsOutput(items, table);
    return 0;
  } finally { store.close(); }
}

/** The default output is always a JSON array, empty allowed, so a scripted
 * caller never has to special-case a quiet period. --table is the only path
 * to the human-readable rendering. */
export function printEventsOutput(items: HeadroomEvent[], table: boolean): void {
  if (!table) { console.log(JSON.stringify(items)); return; }
  printEvents(items);
}

function printEvents(items: HeadroomEvent[]): void {
  for (const item of items) {
    const subject = item.meter_id ?? item.principal_id ?? "-";
    const event = item.kind === "reset_seen" ? `reset seen ${formatReset(item.created_at)}`
      : item.kind === "free_reset_used" ? `free reset used ${formatReset(item.created_at)}${item.reason ? ` (${item.reason})` : ""}`
      : item.kind;
    console.log(`${subject}  ${event} (${item.origin}, ${Math.round(item.confidence * 100)}%)`);
  }
}

async function can(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action) throw new Error("Usage: headroom can <action-class> --owner <name> [--allow-unknown] [--json]");
  const ownerAt = argv.indexOf("--owner");
  const owner = ownerAt >= 0 ? argv[ownerAt + 1] : undefined;
  if (!owner) throw new Error("--owner is required");
  const routing = await readRouting();
  if (!routing.present) throw new Error("No routing.toml configured; create ~/.headroom/routing.toml with a [consumes] section");
  const meters = routing.consumes[action];
  if (!meters) throw new Error(`Unknown action class: ${action}`);
  const accounts = await readAccounts();
  const unknownMeters = unknownMeterPrincipals(meters, new Set(accounts.map((item) => item.name)));
  if (unknownMeters.length) throw new Error(`Routing action class ${action} names unknown meter(s): ${unknownMeters.join(", ")}`);
  const request = await requestDaemon("can", { action_class: action, allow_unknown: argv.includes("--allow-unknown"), owner });
  if (request !== undefined) {
    const decision = unwrapRpc(request) as CanDecision;
    printCan(decision, argv.includes("--json"));
    return decision.allowed ? 0 : 2;
  }
  directReadNotice();
  const [policy, store] = await Promise.all([readPolicy(), HeadroomStore.open()]);
  try {
    const localAccounts = accounts.filter(isLocalAccount);
    // With no daemon, `can` is also a direct read: refresh local state rather
    // than deciding a routing preference from an old queue-depth sample.
    store.insertAll(await Promise.all(localAccounts.map(observeLocal)));
    const localMeters = localAccounts.map((account) => `${account.name}:capacity`);
    const allMeters = [...new Set([...meters, ...localMeters])];
    const latest = new Map(allMeters.map((meter) => [meter, store.latestPerWindow(meter)]));
    const decision = canRouteWithLeases(meters, localMeters, latest, routing.local_preference, policy, argv.includes("--allow-unknown"), store.leases(undefined, true), owner);
    store.audit("cli", "can", action, decision.allowed ? "yes" : "no");
    printCan(decision, argv.includes("--json"));
    return decision.allowed ? 0 : 2;
  } finally { store.close(); }
}

function ttl(value: string | undefined): number {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? "30m");
  if (!match) throw new Error("--ttl must be like 30m, 2h, or 1d");
  return Number(match[1]) * (match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000);
}

function option(argv: string[], name: string): string | undefined { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }

function printLeases(items: Lease[]): void {
  for (const item of items) console.log(`${item.id}  ${item.owner}  ${item.meter_id}  expect ${item.expected_percent ?? "-"}%  spent ${item.spent_percent.toFixed(2)}%  ${item.ended_at ? item.ended_reason ?? "ended" : `expires ${item.expires_at}`}${item.note ? `  ${item.note}` : ""}`);
}

export function endedLeaseMessage(lease: Lease): string { return lease.already_ended ? `already ended ${lease.id} (owner ${lease.owner})` : `ended ${lease.id} (owner ${lease.owner})`; }

async function lease(argv: string[]): Promise<number> {
  if (argv[0] === "start") {
    const owner = option(argv, "--owner"); const meter = option(argv, "--meter"); const expect = option(argv, "--expect"); const note = option(argv, "--note");
    if (!owner || !meter) throw new Error("Usage: headroom lease start --owner <name> --meter <meter_id> [--expect <percent>] [--ttl 30m] [--note ...]");
    const expected = expect === undefined ? null : Number(expect);
    if (expected !== null && (!Number.isFinite(expected) || expected < 0 || expected > 100)) throw new Error("--expect must be 0 through 100");
    const params = { owner, meter_id: meter, expected_percent: expected, ttl_ms: ttl(option(argv, "--ttl")), note: note ?? null };
    const request = await requestDaemon("lease_start", params);
    if (request !== undefined) { console.log((unwrapRpc(request) as Lease).id); return 0; }
    directReadNotice(); const store = await HeadroomStore.open(); try { const created = store.startLease(params.owner, params.meter_id, params.expected_percent, params.ttl_ms, params.note); store.audit("cli", "lease_start", meter, "ok"); console.log(created.id); return 0; } finally { store.close(); }
  }
  if (argv[0] === "end") {
    const id = argv[1]; const owner = option(argv, "--owner"); if (!id) throw new Error("Usage: headroom lease end <id> [--owner <name>] [--force]");
    if (!owner) throw new Error("Usage: headroom lease end <id> --owner <name> [--force]");
    try {
      const params = { id, owner, force: argv.includes("--force") }; const request = await requestDaemon("lease_end", params);
      if (request !== undefined) { console.log(endedLeaseMessage(unwrapRpc(request) as Lease)); return 0; }
      directReadNotice(); const store = await HeadroomStore.open(); try { const ended = store.endLease(id, owner, params.force); store.audit("cli", params.force && ended.owner !== owner ? "lease_force_end" : "lease_end", params.force && ended.owner !== owner ? `${owner}->${ended.owner}` : ended.meter_id, "ok"); console.log(endedLeaseMessage(ended)); return 0; } finally { store.close(); }
    } catch (error) {
      // An owner mismatch is an expected refusal, not an opaque CLI failure.
      console.error(safeError(error));
      return 1;
    }
  }
  if (argv[0] === "list") {
    const request = await requestDaemon("leases");
    if (request !== undefined) { printLeases(unwrapRpc(request) as Lease[]); return 0; }
    directReadNotice(); const store = await HeadroomStore.open(); try { const items = store.leases(); store.audit("cli", "leases", null, "ok"); printLeases(items); return 0; } finally { store.close(); }
  }
  throw new Error("Usage: headroom lease <start|end|list>");
}

async function observe(argv: string[]): Promise<number> {
  const allowed = new Set(["--json", "--threshold", "--principal"]);
  for (let index = 0; index < argv.length; index += 1) { if (!allowed.has(argv[index])) throw new Error("Usage: headroom [--json] [--principal X] [--threshold N]"); if (argv[index] !== "--json") index += 1; }
  const thresholdIndex = argv.indexOf("--threshold");
  const threshold = thresholdIndex >= 0 ? Number(argv[thresholdIndex + 1]) : undefined;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)) throw new Error("--threshold must be 0 through 100");
  const principalIndex = argv.indexOf("--principal");
  const principal = principalIndex >= 0 ? argv[principalIndex + 1] : undefined;
  const request = await requestDaemon("status");
  const daemonObservations = request === undefined ? undefined : unwrapRpc(request) as Observation[];
  let observations: Observation[];
  let failures: string[];
  let resetSeen = new Map<string, string>();
  let freeResetUsed = new Map<string, string>();
  let leases: Lease[] = [];
  const direct = daemonObservations === undefined;
  if (daemonObservations) {
    observations = daemonObservations.filter((item) => !principal || item.principal_id === principal);
    failures = [];
    const leaseRequest = await requestDaemon("leases");
    leases = leaseRequest === undefined ? [] : unwrapRpc(leaseRequest) as Lease[];
  } else {
    const store = await HeadroomStore.open();
    try {
      const accounts = await readAccounts();
      const claudeIds = accounts.filter((account): account is ProviderAccount => !isLocalAccount(account) && account.vendor === "claude" && (!principal || account.name === principal)).map((account) => account.name);
      await syncClaudeGrantState(store, claudeIds);
      const polled = await pollAccounts(principal, { claudeGrant: claudeGrantGate(store) });
      failures = polled.failures;
      store.insertAll(polled.observations);
      for (const [principalId, outcome] of Object.entries(polled.claudeProbeOutcomes ?? {})) store.audit("cli", "claude_probe", principalId, outcome);
      observations = store.latestPerWindow().filter((item) => !principal || item.principal_id === principal);
      resetSeen = store.resetSeenFor(observations);
      freeResetUsed = store.freeResetUsedFor(observations);
      leases = store.leases(undefined, true);
      store.audit("cli", "observe", principal ?? null, failures.length ? "partial" : "ok");
    } finally { store.close(); }
  }
  if (!direct) {
    const windows = observations.map((item) => ({ meter_id: item.meter_id, minutes: item.window?.minutes, resets_at: item.resets_at }));
    const resetEvents = unwrapRpc(await requestDaemon("reset_seen", { windows })) as Record<string, string>;
    resetSeen = new Map(Object.entries(resetEvents));
    const freeResetEvents = unwrapRpc(await requestDaemon("free_reset_used", { windows })) as Record<string, string>;
    freeResetUsed = new Map(Object.entries(freeResetEvents));
  }
  if (direct) directReadNotice();
  const policy = await readPolicy();
  const thresholdRows = threshold === undefined ? undefined : thresholdReport(observations, threshold);
  const leaseMap = new Map<string, Lease[]>(); for (const item of leases) leaseMap.set(item.meter_id, [...(leaseMap.get(item.meter_id) ?? []), item]);
  if (argv.includes("--json")) console.log(JSON.stringify(thresholdRows === undefined ? { observations, leases } : { observations, leases, threshold: { percent: threshold, windows: thresholdRows, any_crossed: thresholdRows.some((item) => item.crossed), any_blocking: thresholdRows.some((item) => item.blocking) } }));
  else { for (const line of formatMeters(observations, policy, resetSeen, leaseMap, freeResetUsed)) console.log(line); for (const failure of failures) console.log(failure); }
  if (thresholdRows?.some((item) => item.blocking)) return 2;
  return failures.length ? observations.length ? 3 : 1 : 0;
}

async function responseShape(argv: string[]): Promise<number> {
  if (argv.length !== 3 || argv[0] !== "--principal" || !argv[1] || argv[2] !== "--shape") throw new Error("Usage: headroom --principal <id> --shape");
  const account = (await readAccounts()).find((item) => item.name === argv[1]);
  if (!account || isLocalAccount(account) || account.adapter !== "native-ts") throw new Error("--shape requires a native TypeScript Claude or Codex principal");
  const responses = account.vendor === "codex" ? await codexResponseShape(account) : account.vendor === "claude" ? { usage: await claudeResponseShape(account) } : undefined;
  if (!responses) throw new Error("--shape requires a native TypeScript Claude or Codex principal");
  console.log(JSON.stringify({ principal_id: account.name, vendor: account.vendor, responses }));
  return 0;
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
  const instance = await HeadroomDaemon.create();
  await instance.start();
  await appendDaemonLog(`daemon started; listening on ${socketPath()}`);
  await new Promise<void>((resolve) => {
    const stop = () => { void instance.stop().then(() => appendDaemonLog("daemon stopped")).finally(resolve); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
  return 0;
}

async function logs(argv: string[]): Promise<number> {
  if (argv.length > 2 || (argv[0] && argv[0] !== "--tail")) throw new Error("Usage: headroom logs [--tail 50]");
  const requested = argv[0] === "--tail" ? Number(argv[1]) : 50;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 10_000) throw new Error("--tail must be a whole number from 1 through 10000");
  const output = await tailDaemonLog(requested);
  if (output) console.log(output);
  return 0;
}

/** With no --principal this grants every Claude principal in the registry: one
 * Keychain dialog per principal, one printed confirmation line each. A grant
 * always clears that principal's keychain_grant_needed marker (set by a prior
 * denial/timeout, or by a probe binary rebuild), so the daemon resumes
 * probing it on its next poll. */
async function keychain(argv: string[]): Promise<number> {
  if (argv[0] !== "grant" || argv.length > 3 || (argv[1] && argv[1] !== "--principal")) throw new Error("Usage: headroom keychain grant [--principal <claude-principal>]");
  const requested = option(argv, "--principal");
  const accounts = (await readAccounts()).filter((item): item is ProviderAccount => !isLocalAccount(item) && item.vendor === "claude");
  const targets = requested ? accounts.filter((item) => item.name === requested) : accounts;
  if (!targets.length) throw new Error(requested ? `No Claude principal named ${requested}; run headroom accounts discover` : "No Claude principal found; run headroom accounts discover");
  const store = await HeadroomStore.open();
  try {
    const hash = process.platform === "darwin" ? await probeBinaryHash() : undefined;
    for (const account of targets) {
      await grantClaudeKeychainAccess(account.location);
      store.clearKeychainGrantNeeded(account.name);
      // The binary that just proved itself under an operator-run grant must
      // never be treated as an unproven first run again by a background poll.
      if (hash) store.setProbeGrantedHash(hash);
      console.log(`Keychain access granted for ${account.name}`);
    }
  } finally { store.close(); }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // Before any command can fetch a vendor endpoint: an operator's shell
  // proxy must never silently carry a credentialed request unless
  // policy.toml opts in.
  stripAmbientProxyEnvironment((await readPolicy()).proxy);
  if (await migrateLegacyHome()) console.log(["Moved ~/.", "ta", "lly", " to ~/.headroom."].join(""));
  if (argv[0] === "engine" && argv[1] === "install") {
    const pin = argv.includes("--pin");
    if (argv.some((item) => item !== "engine" && item !== "install" && item !== "--pin")) throw new Error("Usage: headroom engine install [--pin]");
    const native = await installNativeEngine();
    if (native.installed) { console.log(`native engine ${native.tag} installed at ${native.path} (sha256 ${native.sha256})`); return 0; }
    console.log(`${native.hint} Falling back to the pinned upstream engine.`);
    const result = await installEngine({ pin });
    if (result.firstPin) { console.log(`SHA-256 for ${result.tag}: ${result.sha256}\nAdd this hash to engine.lock.json and commit it; no engine was installed.`); return 0; }
    console.log(`upstream engine ${result.tag} installed at ${result.path} (sha256 ${result.sha256})`); return 0;
  }
  if (argv[0] === "engine" && argv[1] === "status") { const [upstream, native] = await Promise.all([engineStatus(), nativeEnginePath()]); console.log(`native ${native ? "present" : "absent"} ${native ?? "~/.headroom/engine/native/headroom-engine (or engine/.build/release/headroom-engine)"}`); console.log(`upstream ${upstream.tag} ${upstream.present ? "present" : "absent"} ${upstream.path}`); return native || upstream.present ? 0 : 1; }
  if (argv[0] === "accounts" && argv[1] === "discover") { const accounts = await discoverAccounts(); console.log(accountsToml(accounts)); await writeDiscoveredAccounts(accounts); return 0; }
  if (argv[0] === "doctor") return doctor();
  if (argv[0] === "logs") return logs(argv.slice(1));
  if (argv[0] === "daemon") return daemon();
  if (argv[0] === "keychain") return keychain(argv.slice(1));
  if (argv[0] === "mcp") { serveMcp(); return await new Promise<number>(() => undefined); }
  if (argv[0] === "install-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: headroom install-service [--dry-run]");
    const result = await installService(process.argv[1], process.platform, undefined, process.execPath, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would write" : "wrote"} ${result.path}\nTo load it: ${result.command}`); return 0;
  }
  if (argv[0] === "uninstall-service") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--dry-run")) throw new Error("Usage: headroom uninstall-service [--dry-run]");
    const result = await uninstallService(process.platform, undefined, argv[1] === "--dry-run");
    console.log(`${result.dryRun ? "would remove" : "removed"} ${result.path}\nTo unload it: ${result.command}`); return 0;
  }
  if (argv[0] === "history") return history(argv.slice(1));
  if (argv[0] === "events") return events(argv.slice(1));
  if (argv[0] === "lease") return lease(argv.slice(1));
  if (argv[0] === "can") return can(argv.slice(1));
  if (argv.includes("--shape")) return responseShape(argv);
  return observe(argv);
}

/**
 * `import.meta.url` is the entry module's canonical (symlink-resolved) URL,
 * always -- Node's ESM loader realpath()s it. `process.argv[1]` is the raw
 * argument the caller passed and is left exactly as given. On macOS these
 * differ whenever the invoking path crosses a system alias (`/var` ->
 * `/private/var`, `/tmp` -> `/private/tmp`): a plain string comparison then
 * always fails, this file's own main() never runs, and the CLI silently
 * exits 0 with no output at all. Any global npm prefix or accounts/home
 * directory rooted under a default TMPDIR hits this, not just tests --
 * resolving process.argv[1] the same way import.meta.url already is fixes it
 * for every caller, not just the common case.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(realpathSync(argv1)).href; }
  catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(`headroom error: ${safeError(error)}`); process.exitCode = 1; });
}
