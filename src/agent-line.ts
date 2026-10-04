/**
 * The one-line quota status an agent sees on every prompt (issue #149).
 *
 * The daemon writes it after each poll cycle into `line.txt` and `line.json`
 * in the Headroom home, from the same enriched readings the `status` RPC
 * serves. `headroom line` prints it, and the Claude Code hook script (see
 * agent-hook.ts) only reads the file, so the prompt path never runs Node,
 * never polls a vendor and never waits on the daemon.
 *
 * The line carries only numbers, account names reduced to a safe character
 * set, and fixed words. A reading that is stale or failed never contributes a
 * number: its account reads UNKNOWN instead.
 */
import { open, rename, unlink, lstat, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readPolicy } from "./config.js";
import { creditsLapsed, isCurrentBankedResetObservation } from "./credits.js";
import { headroomHome } from "./paths.js";
import { blockedLaneReason, defaultPolicy, paceDecision, type Policy } from "./policy.js";
import { formatResetsIn, servedResetsIn } from "./resets.js";
import { formatRatePercent, labelForMinutes } from "./status-view.js";
import type { Observation, PaceState } from "./types.js";

export const LINE_TEXT_FILE = "line.txt";
export const LINE_JSON_FILE = "line.json";
export const LINE_SCHEMA = 1;
/** Past this the least constrained accounts are dropped and counted. */
export const MAX_LINE_CHARS = 320;
export const NO_READING_MESSAGE = "Headroom: no fresh reading (is the daemon running? headroom doctor)";
const SEPARATOR = " · ";
const PREFIX = "[Headroom]";

export type LineUnknownReason = "stale" | "failed" | "held" | "none";

export interface AgentLineAccount {
  name: string;
  state: PaceState;
  /** Set only when state is UNKNOWN: a fixed word, never vendor text. */
  unknown_reason?: LineUnknownReason;
  meter?: string;
  window?: string;
  used_percent?: number;
  burn_percent_per_hour?: number | null;
  resets_in_seconds?: number | null;
  reset_overdue?: boolean;
  fetched_at?: string;
  free_resets?: { available: number; expires_at: string | null };
}

export interface AgentLine {
  schema: typeof LINE_SCHEMA;
  observed_at: string;
  line: string;
  accounts: AgentLineAccount[];
}

/** Account and meter names come from accounts.toml and the vendors; only this
 * set reaches a prompt, so a name cannot smuggle words or markup into it. */
export function sanitizeName(name: string): string {
  const cleaned = String(name).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 48);
  return cleaned || "_";
}

/** A window that can bind an account: an enforced percent window that is not
 * a local pool, a credit balance, or a lane blocked behind its exhausted
 * weekly (that weekly is itself a candidate and reads FREEZE). */
function isCandidate(item: Observation): boolean {
  if (item.window?.kind === "state" || item.window?.kind === "count") return false;
  if (item.freshness === "not_enforced") return false;
  if (blockedLaneReason(item) !== undefined) return false;
  return item.quantity?.unit === "percent" || item.quantity === null || item.quantity === undefined;
}

const SEVERITY: Partial<Record<PaceState, number>> = { HARVEST: 1, NORMAL: 2, CONSERVE: 3, FREEZE: 4 };

function unknownReason(item: Observation): LineUnknownReason {
  if (item.freshness === "stale") return "stale";
  if (item.freshness === "failed") return "failed";
  if (item.metadata?.vendor_window_held || item.metadata?.vendor_inconsistent) return "held";
  return "none";
}

function shortMeter(item: Observation): string {
  const prefix = `${item.principal_id}:`;
  return item.meter_id.startsWith(prefix) ? item.meter_id.slice(prefix.length) : item.meter_id;
}

function round1(value: number): number { return Math.round(value * 10) / 10; }

function accountFor(name: string, rows: Observation[], policy: Policy, now: Date): AgentLineAccount | undefined {
  const candidates = rows.filter(isCandidate);
  // Only a banked reset (Codex's free resets, or an operator's manual entry)
  // counts, and only while current: a money balance of the same count shape,
  // a stale vendor count or a lapsed one never reaches the line.
  const credits = rows.find((item) => isCurrentBankedResetObservation(item, policy.staleness_minutes, now) && !creditsLapsed(item, now) && (item.quantity?.remaining ?? 0) > 0);
  const freeResets = credits ? { available: Math.round(credits.quantity!.remaining ?? 0), expires_at: credits.resets_at ?? null } : undefined;
  if (!candidates.length) return undefined;
  const decided = candidates.map((item) => ({ item, state: item.metadata?.exhausted ? "FREEZE" as PaceState : paceDecision(item, policy, now).state }));
  const unknown = decided.find((entry) => SEVERITY[entry.state] === undefined);
  // One unknown window makes the whole account UNKNOWN: its binding window
  // cannot be named without it. The meter is named when it is not the
  // account's main one, so a reader knows which part is unread.
  const meterName = (item: Observation): string => { const meter = shortMeter(item); return meter === "all" || meter === "main" ? name : `${name}:${sanitizeName(meter)}`; };
  if (unknown) return { name: meterName(unknown.item), state: "UNKNOWN", unknown_reason: unknownReason(unknown.item), meter: sanitizeName(unknown.item.meter_id) };
  const binding = decided.reduce((best, entry) => {
    const a = SEVERITY[entry.state]!; const b = SEVERITY[best.state]!;
    if (a !== b) return a > b ? entry : best;
    const usedA = entry.item.quantity!.used; const usedB = best.item.quantity!.used;
    if (usedA !== usedB) return usedA > usedB ? entry : best;
    return (entry.item.window?.minutes ?? 0) > (best.item.window?.minutes ?? 0) ? entry : best;
  });
  const reset = servedResetsIn(binding.item, now);
  return {
    name: meterName(binding.item),
    state: binding.state,
    meter: sanitizeName(binding.item.meter_id),
    window: labelForMinutes(binding.item.window?.minutes),
    used_percent: round1(binding.item.quantity!.used),
    burn_percent_per_hour: typeof binding.item.burn_percent_per_hour === "number" && Number.isFinite(binding.item.burn_percent_per_hour) ? round1(binding.item.burn_percent_per_hour) : null,
    resets_in_seconds: reset.reset_overdue ? 0 : reset.resets_in_seconds,
    ...(reset.reset_overdue ? { reset_overdue: true } : {}),
    fetched_at: binding.item.fetched_at,
    ...(freeResets ? { free_resets: freeResets } : {}),
  };
}

function expiryDay(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  // Fixed English, UTC calendar: the same day `headroom credits` prints, and
  // no locale can put anything but ASCII letters and digits here.
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function segment(account: AgentLineAccount): string {
  if (account.state === "UNKNOWN") return `${account.name} UNKNOWN (${account.unknown_reason === "none" ? "no reading" : account.unknown_reason})`;
  const burn = account.burn_percent_per_hour;
  const burnText = burn === null || burn === undefined ? "" : ` (${burn >= 0 ? "+" : ""}${formatRatePercent(burn)})`;
  const resetText = account.reset_overdue ? ", reset overdue" : account.resets_in_seconds === null || account.resets_in_seconds === undefined ? "" : `, resets in ${formatResetsIn(account.resets_in_seconds)}`;
  const free = account.free_resets;
  const expiry = free ? expiryDay(free.expires_at) : undefined;
  const freeText = free ? `, ${free.available} free reset${free.available === 1 ? "" : "s"}${expiry ? ` (expires ${expiry})` : ""}` : "";
  return `${account.name} ${account.window} ${Math.round(account.used_percent ?? 0)}%${burnText} ${account.state}${resetText}${freeText}`;
}

/** Joins the account segments, most constrained first, dropping from the end
 * past MAX_LINE_CHARS and naming how many were left out. */
function joinLine(accounts: AgentLineAccount[]): string {
  if (!accounts.length) return `${PREFIX} no accounts with a quota reading`;
  const segments = accounts.map(segment);
  let kept = segments.length;
  const render = (count: number): string => `${PREFIX} ${segments.slice(0, count).join(SEPARATOR)}${count < segments.length ? `${SEPARATOR}+${segments.length - count} more` : ""}`;
  while (kept > 1 && render(kept).length > MAX_LINE_CHARS) kept -= 1;
  return render(kept);
}

function rank(account: AgentLineAccount): number {
  if (account.state === "UNKNOWN") return 5;
  return SEVERITY[account.state] ?? 0;
}

/**
 * Builds the line from status-enriched observations (the `status` RPC's own
 * shape). `principals` names every enabled, non-local account so one that has
 * never been read still shows up as UNKNOWN instead of vanishing.
 */
export function buildAgentLine(observations: Observation[], policy: Policy, principals: string[], now = new Date()): AgentLine {
  const byPrincipal = new Map<string, Observation[]>();
  for (const name of principals) byPrincipal.set(name, []);
  for (const item of observations) {
    if (item.window?.kind === "state") continue;
    byPrincipal.set(item.principal_id, [...(byPrincipal.get(item.principal_id) ?? []), item]);
  }
  const accounts: AgentLineAccount[] = [];
  for (const [principal, rows] of byPrincipal) {
    const name = sanitizeName(principal);
    if (!rows.length) { accounts.push({ name, state: "UNKNOWN", unknown_reason: "none" }); continue; }
    const account = accountFor(name, rows, policy, now);
    if (account) accounts.push(account);
  }
  accounts.sort((a, b) => rank(b) - rank(a) || (b.used_percent ?? 0) - (a.used_percent ?? 0) || a.name.localeCompare(b.name));
  return { schema: LINE_SCHEMA, observed_at: now.toISOString(), line: joinLine(accounts), accounts };
}

/** temp file in the same directory, fsync, rename: a reader sees the old line
 * or the new one, never half of either. Mode 0600 from creation. */
async function writeDurable(path: string, data: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing to write through symlinked destination: ${path}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  // Windows refuses to replace a file another process has open (a reader
  // mid-read); that lasts milliseconds, so a few short retries cover it. A
  // write that still fails is logged by the daemon and redone next poll.
  for (let attempt = 1; ; attempt += 1) {
    try { await rename(temporary, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) { await new Promise((resolve) => setTimeout(resolve, 10 * attempt)); continue; }
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

/** line.json first, then line.txt: the hook reads line.txt, so its mtime is
 * the moment both files were current. */
export async function writeAgentLine(home: string, line: AgentLine): Promise<void> {
  await writeDurable(join(home, LINE_JSON_FILE), `${JSON.stringify(line)}\n`);
  await writeDurable(join(home, LINE_TEXT_FILE), `${line.line}\n`);
}

export interface LineReading {
  line: string | undefined;
  json: AgentLine | undefined;
  age_seconds: number | undefined;
}

/** Strips anything but printable ASCII and the separator dot: the daemon
 * already writes only that, this keeps a hand-edited file from carrying
 * control characters into a prompt. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7E·]/g, "").slice(0, 1024);
}

export async function readAgentLine(home = headroomHome(), now = new Date()): Promise<LineReading> {
  const path = join(home, LINE_TEXT_FILE);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024) return { line: undefined, json: undefined, age_seconds: undefined };
    const text = printable((await readFile(path, "utf8")).split("\n")[0] ?? "").trim();
    const age = Math.max(0, Math.floor((now.getTime() - info.mtimeMs) / 1000));
    let json: AgentLine | undefined;
    try {
      const parsed = JSON.parse(await readFile(join(home, LINE_JSON_FILE), "utf8")) as AgentLine;
      if (parsed && typeof parsed === "object" && typeof parsed.line === "string") json = parsed;
    } catch { json = undefined; }
    return { line: text || undefined, json, age_seconds: age };
  } catch { return { line: undefined, json: undefined, age_seconds: undefined }; }
}

export function formatAge(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : formatResetsIn(seconds);
}

export const LINE_USAGE = "Usage: headroom line [--json] [--max-age <seconds>]";

/** Default freshness limit: two poll intervals, since the daemon rewrites the
 * line after every poll and jitters each interval by up to 20%. */
export function defaultMaxAgeSeconds(policy: Policy): number {
  return Math.max(60, Math.round(policy.poll_interval_minutes * 60 * 2));
}

/**
 * `headroom line`. Fails open: it always exits 0 and always prints one line,
 * because its callers are prompt hooks and agent preambles that must never
 * break on Headroom's account. It never invents a number: a missing file says
 * so, and an old one is printed with its age and a STALE mark.
 */
export async function lineCommand(argv: string[], home = headroomHome(), now = new Date()): Promise<number> {
  try {
    const json = argv.includes("--json");
    let maxAge: number | undefined;
    const at = argv.indexOf("--max-age");
    if (at >= 0) {
      const value = Number(argv[at + 1]);
      if (Number.isFinite(value) && value > 0) maxAge = value;
    }
    const unknownFlags = argv.filter((item, index) => item !== "--json" && item !== "--max-age" && !(index > 0 && argv[index - 1] === "--max-age"));
    if (unknownFlags.length) console.error(LINE_USAGE);
    if (maxAge === undefined) {
      const policy = await readPolicy().catch(() => defaultPolicy);
      maxAge = defaultMaxAgeSeconds(policy);
    }
    const reading = await readAgentLine(home, now);
    const stale = reading.age_seconds === undefined || reading.age_seconds > maxAge;
    if (json) {
      const base = reading.json ?? { schema: LINE_SCHEMA, observed_at: null, line: reading.line ?? null, accounts: [] };
      console.log(JSON.stringify({ ...base, line: reading.line ?? null, age_seconds: reading.age_seconds ?? null, max_age_seconds: maxAge, stale, ...(reading.line ? {} : { message: NO_READING_MESSAGE }) }));
      return 0;
    }
    if (!reading.line) { console.log(NO_READING_MESSAGE); return 0; }
    console.log(stale ? `STALE (${formatAge(reading.age_seconds!)} ago) ${reading.line}` : reading.line);
    return 0;
  } catch {
    try { console.log(NO_READING_MESSAGE); } catch { /* fail open */ }
    return 0;
  }
}
