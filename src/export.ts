import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact, writeFileAtomic } from "./security.js";
import { HeadroomStore } from "./store.js";
import type { HeadroomEvent, Lease, StoredObservation } from "./types.js";

export const EXPORT_HELP =
  "Usage: headroom export [--since 7d] [--until <iso>] [--meter <meter_id>] [--principal <principal_id>] [--kind observations|events|spend|leases|all] [--format json|csv] [--out <path>]";

type ExportKind = "observations" | "events" | "spend" | "leases";
type ExportKindOption = ExportKind | "all";
type ExportFormat = "json" | "csv";

const EXPORT_KINDS: readonly ExportKind[] = ["observations", "events", "spend", "leases"];
const VALID_KINDS = new Set<string>([...EXPORT_KINDS, "all"]);
const VALID_FORMATS = new Set<string>(["json", "csv"]);

/** Refuses a period that would hand back more rows than a CLI export is ever
 * meant to carry at once, rather than silently building a multi-gigabyte
 * document. Exported (with an overridable limit) so it can be exercised
 * directly without actually inserting a million rows into a test database. */
export const EXPORT_ROW_LIMIT = 1_000_000;

export interface SpendLedgerExportRow {
  id: number;
  meter_id: string;
  window_minutes: number | null;
  from_at: string;
  to_at: string;
  delta_percent: number;
  owner: string;
  share_percent: number;
  confidence: number;
}

interface ExportOptions {
  since: string;
  until: string;
  meter?: string;
  principal?: string;
  kind: ExportKindOption;
  format: ExportFormat;
  out?: string;
}

interface CollectedRows {
  observations?: StoredObservation[];
  events?: HeadroomEvent[];
  spend?: SpendLedgerExportRow[];
  leases?: Lease[];
}

function opt(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sinceIso(value: string | undefined, now: Date): string {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? "7d");
  if (!match) throw new Error("--since must be like 15m, 24h, or 7d");
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - Number(match[1]) * multiplier).toISOString();
}

function untilIso(value: string | undefined, now: Date): string {
  if (value === undefined) return now.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("--until must be an ISO 8601 timestamp");
  return parsed.toISOString();
}

export function parseExportArgs(argv: string[], now: Date = new Date()): ExportOptions {
  const kind = opt(argv, "--kind") ?? "all";
  if (!VALID_KINDS.has(kind)) throw new Error(EXPORT_HELP);
  const format = opt(argv, "--format") ?? "json";
  if (!VALID_FORMATS.has(format)) throw new Error(EXPORT_HELP);
  const since = sinceIso(opt(argv, "--since"), now);
  const until = untilIso(opt(argv, "--until"), now);
  if (Date.parse(since) > Date.parse(until)) throw new Error("--since must be before --until");
  const out = opt(argv, "--out");
  if (format === "csv" && !out) throw new Error("--out is required with --format csv");
  return { since, until, meter: opt(argv, "--meter"), principal: opt(argv, "--principal"), kind: kind as ExportKindOption, format: format as ExportFormat, out };
}

function requestedKinds(kind: ExportKindOption): ExportKind[] {
  return kind === "all" ? [...EXPORT_KINDS] : [kind];
}

/** Throws once `total` exceeds `limit`, naming a narrower range as the fix.
 * A separate function (rather than inline in exportCommand) so the bound
 * itself can be tested against a small, fast, made-up count instead of
 * actually materializing a million rows in a test database. */
export function assertWithinExportBound(total: number, limit: number = EXPORT_ROW_LIMIT): void {
  if (total > limit) throw new Error(`export would return ${total} rows, more than the ${limit} row bound; narrow --since/--until or add --meter/--kind to reduce it`);
}

function redactObservation(row: StoredObservation): StoredObservation {
  return row.reason ? { ...row, reason: redact(row.reason) } : row;
}

function redactEvent(event: HeadroomEvent): HeadroomEvent {
  return event.reason ? { ...event, reason: redact(event.reason) } : event;
}

function redactLease(lease: Lease): Lease {
  const note = lease.note ? redact(lease.note) : lease.note;
  const endedReason = lease.ended_reason ? redact(lease.ended_reason) : lease.ended_reason;
  return note === lease.note && endedReason === lease.ended_reason ? lease : { ...lease, note, ended_reason: endedReason };
}

/**
 * Every observation for the period, across every meter (or just `--meter`
 * when given). The observations table has no single "list everything since
 * X" read; latestPerWindow() enumerates every meter id the store has ever
 * seen (it is append-only, so this is reliable even for a meter that has
 * stopped reporting), and history() then supplies that meter's own rows.
 */
function collectObservations(store: HeadroomStore, options: ExportOptions): StoredObservation[] {
  const meterIds = options.meter ? [options.meter] : [...new Set(store.latestPerWindow().map((observation) => observation.meter_id))];
  const untilMs = Date.parse(options.until);
  const rows: StoredObservation[] = [];
  for (const meterId of meterIds) {
    for (const row of store.history(meterId, options.since)) {
      if (Date.parse(row.fetched_at) > untilMs) continue;
      if (options.principal && row.principal_id !== options.principal) continue;
      rows.push(redactObservation(row));
    }
  }
  rows.sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at) || a.id - b.id);
  return rows;
}

function collectEvents(store: HeadroomStore, options: ExportOptions): HeadroomEvent[] {
  const untilMs = Date.parse(options.until);
  return store.events(options.since)
    .filter((event) => Date.parse(event.created_at) <= untilMs)
    .filter((event) => !options.meter || event.meter_id === options.meter)
    .filter((event) => !options.principal || event.principal_id === options.principal)
    .map(redactEvent);
}

/** Leases carry no principal_id (only `owner`, a different concept), so
 * `--principal` does not filter this kind. Filtered by started_at falling
 * inside [since, until]; expireLeases() still runs against the real current
 * time (leases() default), never against `until`, so exporting a past
 * period never mutates a still-open lease's end state. */
function collectLeases(store: HeadroomStore, options: ExportOptions): Lease[] {
  const sinceMs = Date.parse(options.since);
  const untilMs = Date.parse(options.until);
  return store.leases(options.meter, false)
    .filter((lease) => { const startedMs = Date.parse(lease.started_at); return startedMs >= sinceMs && startedMs <= untilMs; })
    .map(redactLease);
}

function buildJsonDocument(schemaVersion: number, options: ExportOptions, rows: CollectedRows): Record<string, unknown> {
  const document: Record<string, unknown> = {
    schema_version: schemaVersion,
    exported_at: new Date().toISOString(),
    range: { since: options.since, until: options.until, meter: options.meter ?? null, principal: options.principal ?? null },
  };
  if (rows.observations) document.observations = rows.observations;
  if (rows.events) document.events = rows.events;
  if (rows.spend) document.spend = rows.spend;
  if (rows.leases) document.leases = rows.leases;
  return document;
}

/** RFC 4180 quoting: a field carrying a comma, double quote, or line break is
 * wrapped in double quotes with any embedded quote doubled. Everything else
 * is written bare. Objects (an observation's window/quantity/metadata) are
 * serialized to JSON first, since a CSV cell has no nested structure of its
 * own. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDocument(columns: readonly string[], records: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [columns.join(","), ...records.map((record) => columns.map((column) => csvField(record[column])).join(","))];
  return `${lines.join("\n")}\n`;
}

const OBSERVATION_COLUMNS = ["id", "principal_id", "meter_id", "window", "quantity", "resets_at", "observed_at", "fetched_at", "source", "truth", "freshness", "confidence", "adapter_version", "upstream_schema_version", "reason", "metadata"] as const;
const EVENT_COLUMNS = ["id", "kind", "origin", "confidence", "evidence_observation_ids", "created_at", "corrected_by", "meter_id", "principal_id", "reason", "last_seen_at"] as const;
const SPEND_COLUMNS = ["id", "meter_id", "window_minutes", "from_at", "to_at", "delta_percent", "owner", "share_percent", "confidence"] as const;
const LEASE_COLUMNS = ["id", "owner", "meter_id", "expected_percent", "note", "action_class", "started_at", "expires_at", "ended_at", "ended_reason", "spent_percent"] as const;

function csvFor(kind: ExportKind, rows: CollectedRows): string {
  if (kind === "observations") return csvDocument(OBSERVATION_COLUMNS, (rows.observations ?? []) as unknown as Array<Record<string, unknown>>);
  if (kind === "events") return csvDocument(EVENT_COLUMNS, (rows.events ?? []) as unknown as Array<Record<string, unknown>>);
  if (kind === "spend") return csvDocument(SPEND_COLUMNS, (rows.spend ?? []) as unknown as Array<Record<string, unknown>>);
  return csvDocument(LEASE_COLUMNS, (rows.leases ?? []) as unknown as Array<Record<string, unknown>>);
}

/** `<base>-<kind>.csv`, stripping a trailing `.csv` from `--out` first so
 * `--out export.csv --kind all` produces `export-observations.csv` and so on
 * rather than `export.csv-observations.csv`. */
function suffixedPath(base: string, kind: ExportKind): string {
  const withoutExtension = base.endsWith(".csv") ? base.slice(0, -4) : base;
  return `${withoutExtension}-${kind}.csv`;
}

async function writeOutputFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, content, 0o600);
}

async function writeCsvOutputs(options: ExportOptions, rows: CollectedRows): Promise<string[]> {
  const kinds = requestedKinds(options.kind);
  const paths = kinds.length === 1 ? [options.out!] : kinds.map((kind) => suffixedPath(options.out!, kind));
  for (let index = 0; index < kinds.length; index += 1) await writeOutputFile(paths[index], csvFor(kinds[index], rows));
  return paths;
}

function countRows(rows: CollectedRows): number {
  return (rows.observations?.length ?? 0) + (rows.events?.length ?? 0) + (rows.spend?.length ?? 0) + (rows.leases?.length ?? 0);
}

/**
 * `headroom export`: a bounded, redacted dump of stored history for a period
 * -- observations verbatim (every column as stored, no derived pace fields),
 * events, the raw spend ledger, and leases -- as one JSON document to stdout
 * or a file, or as CSV (one file per kind when `--kind all`, one file
 * otherwise). This is a direct store read with no daemon round trip: export
 * is a bulk historical report, not a live decision the daemon's in-memory
 * scheduling state could change the answer to.
 */
export async function exportCommand(argv: string[]): Promise<number> {
  const options = parseExportArgs(argv);
  const store = await HeadroomStore.open();
  try {
    const kinds = requestedKinds(options.kind);
    const rows: CollectedRows = {};
    if (kinds.includes("observations")) rows.observations = collectObservations(store, options);
    if (kinds.includes("events")) rows.events = collectEvents(store, options);
    if (kinds.includes("spend")) rows.spend = store.spendLedgerRows({ since: options.since, until: options.until, meter: options.meter });
    if (kinds.includes("leases")) rows.leases = collectLeases(store, options);
    const total = countRows(rows);
    assertWithinExportBound(total);

    const subject = options.meter ?? options.principal ?? null;
    if (options.format === "csv") {
      const written = await writeCsvOutputs(options, rows);
      store.audit("cli", "export", subject, `ok kind=${options.kind} format=csv rows=${total}`);
      for (const path of written) console.log(`wrote ${path}`);
      return 0;
    }
    const text = JSON.stringify(buildJsonDocument(store.schemaVersion(), options, rows));
    if (options.out) {
      await writeOutputFile(options.out, text);
      store.audit("cli", "export", subject, `ok kind=${options.kind} format=json rows=${total}`);
      console.log(`wrote ${options.out}`);
    } else {
      store.audit("cli", "export", subject, `ok kind=${options.kind} format=json rows=${total}`);
      console.log(text);
    }
    return 0;
  } finally { store.close(); }
}
