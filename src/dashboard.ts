import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { readPolicy } from "./config.js";
import { DASHBOARD_HEALTH_TIMEOUT_MS, DASHBOARD_REQUEST_TIMEOUT_MS, dashboardSnapshot, readDashboardStore, type DashboardModel as CachedDashboardModel, type DashboardReader, type DashboardSnapshot } from "./dashboard-data.js";
import { readAccounts } from "./registry.js";
import { HeadroomStore, safeHeadroomDirectory } from "./store.js";
import { headroomVersion } from "./version.js";
import { IDLE_WINDOW_REASON } from "./engine/observation.js";
import { paceDecision, reserveFor } from "./policy.js";
import { decodeResetSeen, formatResetsIn, resetsIn } from "./resets.js";
import { safeError } from "./security.js";
import { explainUnknown, formatRatePercent, label, planDowngradeLine, renderStatus, statusViewOptions } from "./status-view.js";
import { isLocalAccount, type HeadroomEvent, type Observation } from "./types.js";

export interface DashboardModel extends CachedDashboardModel {
  history?: Record<string, Observation[]>;
  graphEvents?: HeadroomEvent[];
}

/** An older daemon can be alive without implementing the dashboard method. */
export async function dashboardRead(reader: DashboardReader): ReturnType<typeof dashboardSnapshot> {
  const reply = await reader.request().catch(() => undefined);
  const result = await dashboardSnapshot({ request: async () => reply, fallback: reader.fallback });
  const response = reply as { status?: string; result?: { error?: { code?: number } } } | undefined;
  const olderDaemon = response?.status === "available" && response.result?.error?.code === -32601;
  return { ...result, direct: result.direct && !olderDaemon };
}

/** One history read per meter, shared by all its windows and the weekly view. */
export function readDashboardGraphs(store: HeadroomStore, rows: Observation[], now: Date): Pick<DashboardModel, "history" | "graphEvents"> {
  const starts = new Map<string, number>();
  for (const row of rows) {
    if (row.window?.enforcement !== "hard" || row.window.kind === "state" || row.window.kind === "count") continue;
    const reset = Date.parse(row.resets_at ?? "");
    const start = Number.isFinite(reset) && row.window.minutes ? reset - row.window.minutes * 60_000 : now.getTime();
    starts.set(row.meter_id, Math.min(starts.get(row.meter_id) ?? Infinity, start, now.getTime() - 7 * 86_400_000));
  }
  return {
    history: Object.fromEntries([...starts].map(([meter, start]) => [meter, store.history(meter, new Date(start).toISOString())])),
    graphEvents: store.events(new Date(now.getTime() - 7 * 86_400_000).toISOString()),
  };
}

/** A store can retain retired principals; the dashboard only shows the registry. */
export function filterDashboardPrincipals(snapshot: DashboardSnapshot, principals: Set<string>): DashboardSnapshot {
  if (!principals.size) return snapshot;
  const observations = snapshot.observations.filter((row) => principals.has(row.principal_id));
  return {
    ...snapshot,
    observations,
    events: snapshot.events.filter((event) => !event.principal_id || principals.has(event.principal_id)),
    leases: snapshot.leases.filter((lease) => observations.some((row) => row.meter_id === lease.meter_id)),
  };
}

export async function gatherDashboard(): Promise<DashboardModel> {
  const { daemonRequest, socketPath } = await import("./daemon.js");
  // The daemon binds its socket below the canonicalized safe home. Using the
  // same path here matters when HEADROOM_HOME itself is a filesystem alias.
  const home = await safeHeadroomDirectory();
  const [reply, policy, accounts, version] = await Promise.all([
    // The probe needs to be quick, while the snapshot gets the full
    // interactive budget for a brief SQLite handoff.
    daemonRequest(socketPath(home), "dashboard", {}, DASHBOARD_HEALTH_TIMEOUT_MS, DASHBOARD_REQUEST_TIMEOUT_MS).catch(() => undefined),
    readPolicy(), readAccounts().catch(() => []), headroomVersion(),
  ]);
  const store = await HeadroomStore.open(home);
  try {
    const now = new Date();
    const { snapshot, direct } = await dashboardRead({ request: async () => reply, fallback: async () => readDashboardStore(store, now) });
    const filtered = filterDashboardPrincipals(snapshot, new Set(accounts.map((account) => account.name)));
    const observations = filtered.observations;
    return { ...filtered, ...readDashboardGraphs(store, observations, now), direct, policy, version, now,
      vendors: new Map(accounts.map((account) => [account.name, isLocalAccount(account) ? "local" : account.vendor])) };
  } finally { store.close(); }
}

export const DASHBOARD_HELP = "Usage: headroom dashboard (alias: top) [--interval <s>] [--once] [--no-color] [--verbose] [--ascii]";
export const ENTER_DASHBOARD = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
export const LEAVE_DASHBOARD = "\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l";
const KEYS = "q quit  p pause  v verbose  e events  g graphs  arrows/jk scroll  PgUp/PgDn/space page  Home/End  Tab focus  Enter panel  ? help";
const GRAPH_LEGEND = "Burndown: solid used and plan, │ now, ░ reserve";

export interface DashboardView { width: number; height: number; verbose: boolean; eventsWide: boolean; graphs?: boolean; ascii?: boolean; terminalHeight?: number; scroll?: number; focus?: number; help?: boolean; }
export interface DashboardState { paused: boolean; verbose: boolean; eventsWide: boolean; help: boolean; quit: boolean; graphs?: boolean; scroll?: number; focus?: number; }

export function handleDashboardKey(state: DashboardState, key: string, pageRows = 10): DashboardState {
  if (key === "q" || key === "\x03") return { ...state, quit: true };
  if (key === "p") return { ...state, paused: !state.paused };
  if (key === "v") return { ...state, verbose: !state.verbose };
  if (key === "e") return { ...state, eventsWide: !state.eventsWide };
  if (key === "g") return { ...state, graphs: state.graphs === false };
  if (key === "?") return { ...state, help: !state.help };
  if (key === "up" || key === "k") return { ...state, scroll: Math.max(0, (state.scroll ?? 0) - 1) };
  if (key === "down" || key === "j") return { ...state, scroll: (state.scroll ?? 0) + 1 };
  if (key === "wheelup") return { ...state, scroll: Math.max(0, (state.scroll ?? 0) - 3) };
  if (key === "wheeldown") return { ...state, scroll: (state.scroll ?? 0) + 3 };
  if (key === "pageup") return { ...state, scroll: Math.max(0, (state.scroll ?? 0) - pageRows) };
  if (key === "pagedown" || key === " ") return { ...state, scroll: (state.scroll ?? 0) + pageRows };
  if (key === "home") return { ...state, scroll: 0 };
  if (key === "end") return { ...state, scroll: Number.MAX_SAFE_INTEGER };
  if (key === "tab") return { ...state, focus: (state.focus ?? 0) + 1 };
  return state;
}

/** Decode raw terminal input without letting mouse reports become keyboard input. */
export function decodeDashboardKeys(chunk: string): string[] {
  const keys: string[] = [];
  const sequences: Record<string, string> = {
    "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down",
    "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
    "\x1b[H": "home", "\x1b[1~": "home", "\x1bOH": "home",
    "\x1b[F": "end", "\x1b[4~": "end", "\x1bOF": "end",
  };
  for (let index = 0; index < chunk.length;) {
    const rest = chunk.slice(index);
    const sequence = Object.keys(sequences).find((value) => rest.startsWith(value));
    if (sequence) { keys.push(sequences[sequence]); index += sequence.length; continue; }
    // X10 reports are six bytes. Consume them, including non-UTF-8 coordinate bytes.
    if (rest.startsWith("\x1b[M")) { index += Math.min(6, rest.length); continue; }
    const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])/.exec(rest);
    if (sgr) {
      if (sgr[2] === "M" && sgr[1] === "64") keys.push("wheelup");
      if (sgr[2] === "M" && sgr[1] === "65") keys.push("wheeldown");
      index += sgr[0].length;
      continue;
    }
    // Ignore every other complete CSI or SS3 sequence rather than treating its
    // final bytes as ordinary keys.
    if (rest.startsWith("\x1b[")) {
      const final = rest.slice(2).search(/[\x40-\x7e]/);
      index += final >= 0 ? final + 3 : rest.length;
      continue;
    }
    if (rest.startsWith("\x1bO")) { index += Math.min(3, rest.length); continue; }
    if (rest[0] === "\x1b") { index++; continue; }
    const char = rest[0];
    if (char === "\r" || char === "\n") keys.push("enter");
    else if (char === "\t") keys.push("tab");
    else keys.push(char);
    index++;
  }
  return keys;
}

function clean(text: string): string { return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
function cells(char: string): number {
  if (/\p{Mark}/u.test(char)) return 0;
  const code = char.codePointAt(0)!;
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
}
function length(text: string): number { return [...text].reduce((sum, char) => sum + cells(char), 0); }
function clip(text: string, width: number): string {
  let result = "", used = 0;
  for (const char of clean(text)) { used += cells(char); if (used > width) break; result += char; }
  return result;
}
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = clean(text);
  while (length(remaining) > width) {
    const part = clip(remaining, width);
    if (!part) { lines.push("?"); remaining = remaining.slice([...remaining][0].length); continue; }
    lines.push(part); remaining = remaining.slice(part.length);
  }
  if (remaining) lines.push(remaining);
  return lines;
}
function clock(date: string | Date): string {
  const value = new Date(date);
  return Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value) : "?";
}
function spark(values: Array<number | null>): string {
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  return values.map((value) => value === null ? "·" : "▁▂▃▄▅▆▇█"[Math.round(Math.max(0, value) / max * 7)]).join("");
}
interface GraphPoint { at: number; used: number; reset: number; }
const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, value));

function graphPoints(row: Observation, model: DashboardModel): GraphPoint[] {
  const points = new Map<number, GraphPoint>();
  for (const reading of [...(model.history?.[row.meter_id] ?? []), row]) {
    const at = Date.parse(reading.observed_at);
    if (reading.principal_id !== row.principal_id || reading.meter_id !== row.meter_id || reading.window?.minutes !== row.window?.minutes || reading.window?.enforcement !== "hard" || reading.freshness !== "fresh" || reading.quantity?.unit !== "percent" || !Number.isFinite(reading.quantity.used) || !Number.isFinite(at) || at > model.now.getTime()) continue;
    points.set(at, { at, used: clamp(reading.quantity.used, 100), reset: Date.parse(reading.resets_at ?? "") });
  }
  return [...points.values()].sort((a, b) => a.at - b.at);
}

function hasBurndown(row: Observation, model: DashboardModel): boolean {
  return row.window?.enforcement === "hard" && (row.window.kind === "fixed" || row.window.kind === "rolling") && row.freshness !== "not_enforced"
    && (row.quantity?.unit === "percent" || Boolean(model.history?.[row.meter_id]?.some((reading) => reading.window?.minutes === row.window?.minutes && reading.quantity?.unit === "percent")));
}

function ends(left: string, right: string, width: number): string {
  return clip(left, Math.max(0, width - length(right))) + " ".repeat(Math.max(0, width - length(left) - length(right))) + clip(right, width);
}

/** Eight plot rows, with 2 by 4 dots per cell, or 1 by 2 half blocks. */
export function renderBurndown(row: Observation, model: DashboardModel, width: number, ascii = false): string[] {
  const reset = Date.parse(row.resets_at ?? "");
  const all = graphPoints(row, model);
  const current = all.filter((point) => point.reset === reset);
  let graphReset = reset;
  let points = current;
  // A reset naturally leaves one fresh point in the new period. Keep the
  // useful previous line visible until this period has a second point.
  const prior = [...new Set(all.map((point) => point.reset).filter((value) => Number.isFinite(value) && value !== reset))]
    .sort((a, b) => b - a).find((value) => all.filter((point) => point.reset === value).length >= 2);
  const showingPrior = current.length < 2 && prior !== undefined;
  if (showingPrior) { graphReset = prior; points = all.filter((point) => point.reset === prior); }
  if (current.length < 2 && all.length >= 2 && !showingPrior) return [clip(`  new period, ${current.length} reading${current.length === 1 ? "" : "s"} so far`, width)];
  const start = row.window?.minutes ? graphReset - row.window.minutes * 60_000 : points[0]?.at;
  points = points.filter((point) => point.at >= start && point.at <= graphReset);
  if (width < 12 || !Number.isFinite(start) || !Number.isFinite(graphReset) || graphReset <= start || all.length < 2 || points.length < 2) return [clip("  collecting readings", width)];
  const columns = Math.floor(width) - 6, rows = width < 60 ? 6 : 8, sx = ascii ? 1 : 2, sy = ascii ? 2 : 4;
  const pixelWidth = columns * sx, pixelHeight = rows * sy;
  const actual = new Uint8Array(pixelWidth * pixelHeight), plan = new Uint8Array(pixelWidth * pixelHeight);
  const x = (at: number): number => Math.round(clamp((at - start) / (graphReset - start), 1) * (pixelWidth - 1));
  const y = (used: number): number => Math.round((1 - used / 100) * (pixelHeight - 1));
  const line = (target: Uint8Array, x1: number, y1: number, x2: number, y2: number, dotted = false): void => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let step = 0; step <= steps; step++) {
      if (dotted && step % 4 !== 0 && step !== steps) continue;
      const px = Math.round(x1 + (x2 - x1) * step / steps), py = Math.round(y1 + (y2 - y1) * step / steps);
      target[py * pixelWidth + px] = 1;
    }
  };
  line(plan, 0, pixelHeight - 1, pixelWidth - 1, 0);
  for (let i = 0; i < points.length; i++) {
    const current = points[i], previous = points[i - 1];
    // A decrease is a reset or correction, not negative consumption.
    if (previous && current.used >= previous.used) line(actual, x(previous.at), y(previous.used), x(current.at), y(current.used));
    else line(actual, x(current.at), y(current.used), x(current.at), y(current.used));
  }
  const nowColumn = Math.floor(x(model.now.getTime()) / sx);
  const reserve = reserveFor(model.policy.reserve, row.meter_id);
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  const plot = Array.from({ length: rows }, (_, cellY) => {
    let text = "";
    for (let cellX = 0; cellX < columns; cellX++) {
      let usedMask = 0, planMask = 0;
      for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) {
        const index = (cellY * sy + dy) * pixelWidth + cellX * sx + dx;
        const bit = ascii ? 1 << dy : bits[dy][dx];
        if (actual[index]) usedMask |= bit;
        if (plan[index]) planMask |= bit;
      }
      const shaded = reserve > 0 && cellY * sy / (pixelHeight - 1) * 100 < reserve;
      if (usedMask || planMask) text += ascii ? usedMask ? [" ", "▀", "▄", "█"][usedMask] : "." : String.fromCodePoint(0x2800 + (usedMask | planMask));
      else if (cellX === nowColumn) text += ascii ? "|" : "│";
      else text += shaded ? ascii ? ":" : "░" : " ";
    }
    return `${cellY === 0 ? "100%" : cellY === rows - 1 ? "  0%" : "    "}${ascii ? "|" : "│"}${text}${ascii ? "|" : "│"}`;
  });
  const dayTime = (at: number): string => new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  const axis = ends(dayTime(start), `${dayTime(graphReset)} reset`, width);
  const decision = paceDecision(row, model.policy, model.now);
  const used = row.quantity?.unit === "percent" && decision.state !== "UNKNOWN" ? row.quantity.used : null;
  const planned = clamp((model.now.getTime() - start) / (graphReset - start), 1) * 100;
  const difference = used === null ? 0 : Math.round(used - planned);
  const pace = used === null ? "pace unknown" : difference > 0 ? `over pace by ${difference} points` : difference < 0 ? `under pace${decision.state === "HARVEST" ? ", HARVEST" : ""}` : "on pace";
  const minutes = Math.max(0, Math.floor((reset - model.now.getTime()) / 60_000));
  const summary = `${used === null ? "?" : Math.round(used)}% used, ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m left, ${pace}`;
  const compact = `${used === null ? "?" : Math.round(used)}%, ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m, ${pace}`;
  const period = showingPrior ? `new period, ${current.length} reading${current.length === 1 ? "" : "s"} so far` : "";
  return [...plot, axis, clip(period || (length(summary) <= width ? summary : compact), width)];
}

/** Seven elapsed days, using weekly readings and local calendar day ticks. */
export function renderWeekly(row: Observation, model: DashboardModel, width: number): string[] {
  const end = model.now.getTime(), start = end - 7 * 86_400_000;
  const points = graphPoints(row, model).filter((point) => point.at >= start);
  if (!points.length) return [];
  const columns = Math.max(7, Math.min(60, Math.floor(width) - 2));
  const position = (at: number): number => Math.round(clamp((at - start) / (end - start), 1) * (columns - 1));
  const pixels = new Uint8Array(columns * 8), ticks = Array<string>(columns).fill(" ");
  const put = (x: number, used: number): void => { pixels[(7 - Math.round(clamp(used / 100, 1) * 7)) * columns + x] = 1; };
  for (let i = 0; i < points.length; i++) {
    const previous = points[i - 1], current = points[i];
    if (!previous) put(position(current.at), current.used);
    else {
      const x1 = position(previous.at), y1 = 7 - Math.round(clamp(previous.used / 100, 1) * 7), x2 = position(current.at), y2 = 7 - Math.round(clamp(current.used / 100, 1) * 7);
      for (let step = 0, count = Math.max(1, Math.abs(x2 - x1)); step <= count; step++) pixels[Math.round(y1 + (y2 - y1) * step / count) * columns + Math.round(x1 + (x2 - x1) * step / count)] = 1;
    }
  }
  for (const event of model.graphEvents ?? model.events) {
    const at = Date.parse(event.created_at);
    if (event.corrected_by || (event.metadata?.window_minutes != null && event.metadata.window_minutes !== row.window?.minutes) || at < start || at > end || !Number.isFinite(at) || (event.meter_id ? event.meter_id !== row.meter_id : event.principal_id !== row.principal_id)) continue;
    const marker = event.kind.startsWith("free_reset_") ? "F" : event.kind === "reset_seen" && event.metadata?.unscheduled ? "!" : undefined;
    if (!marker) continue;
    const index = position(at);
    // Markers occupy the tick line so the plot remains a braille sparkline.
    ticks[index] = ticks[index] === " " || ticks[index] === marker ? marker : "*";
  }
  const day = new Date(start); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + 1);
  while (day.getTime() <= end) {
    const index = position(day.getTime()), name = `|${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day)}`;
    for (let i = 0; i < name.length && index + i < columns; i++) if (ticks[index + i] === " ") ticks[index + i] = name[i];
    day.setDate(day.getDate() + 1);
  }
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  const chart = Array.from({ length: columns }, (_, x) => {
    let mask = 0;
    for (let y = 0; y < 8; y++) if (pixels[y * columns + x]) mask |= bits[Math.floor(y / 4)][0];
    return String.fromCodePoint(0x2800 + mask);
  }).join("");
  return [clip(`  WEEKLY ${row.meter_id} | last 7 days | F free reset  ! unscheduled  * both`, width), `  ${chart}`, `  ${ticks.join("").trimEnd()}`];
}

function windowLines(row: Observation, model: DashboardModel, view: DashboardView, sharedReason = false): string[] {
  const decision = paceDecision(row, model.policy, model.now);
  const meter = row.meter_id.startsWith(`${row.principal_id}:`) ? row.meter_id.slice(row.principal_id.length + 1) : row.meter_id;
  const key = `${row.meter_id}:${row.window?.minutes ?? "none"}`;
  if (row.window?.kind === "state") {
    const state = row.metadata?.state ?? "DOWN";
    const status = state === "UP" ? "ok" : state === "BUSY" ? "busy" : "down";
    return [`  ${row.principal_id}  ${state}  ${row.metadata?.model_ids?.join(",") || "?"}  ${row.metadata?.running ?? row.quantity?.used ?? 0} running, ${row.metadata?.waiting ?? 0} waiting  ${status}${row.reason && row.reason !== "down" ? ` (${row.reason})` : ""}`];
  }
  if (row.quantity?.unit === "credits") return [`  credits  ${row.quantity.remaining ?? "?"} available${creditExpiry(row.resets_at)}`];
  const unknown = decision.state === "UNKNOWN";
  const used = !unknown && row.quantity?.unit === "percent" ? row.quantity.used : null;
  const filled = used === null ? 0 : Math.round(Math.max(0, Math.min(100, used)) / 5);
  const bar = unknown ? "?".repeat(20) : "#".repeat(filled) + ".".repeat(20 - filled);
  const seconds = resetsIn(row.resets_at, model.now).resets_in_seconds;
  const glyph = { NORMAL: "●", HARVEST: "↗", CONSERVE: "⚠", FREEZE: "🛑", UNKNOWN: "?", NOT_ENFORCED: "", UP: "●", BUSY: "⚠", DOWN: "🛑" }[decision.state];
  let text = `  ${clip(meter, 10).padEnd(10)} ${label(row).padEnd(3)} [${bar}] ${used === null ? "  -" : `${Math.round(used)}%`.padStart(4)} ${glyph} resets in ${unknown || seconds === null ? "?" : formatResetsIn(seconds)} ${decision.state}`;
  if (row.metadata?.vendor_inconsistent) text += " (vendor readings inconsistent, holding)";
  else if (row.metadata?.vendor_window_held) text += " (new window unconfirmed, holding)";
  if (decision.state === "NOT_ENFORCED") text = `  ${meter} ${label(row)} n/a (not enforced)`;
  if (view.graphs !== false && view.width >= 100 && !unknown && model.burns[key]?.length) text += ` ${spark(model.burns[key])}`;
  const lines = [text];
  if (unknown) {
    const known = row.last_known ?? (row.quantity?.unit === "percent" ? { used_percent: row.quantity.used, observed_at: row.observed_at, window_minutes: undefined } : null);
    const knownWindow = known?.window_minutes !== undefined ? `${label({ ...row, window: { kind: "fixed", minutes: known.window_minutes, enforcement: "hard" } })} ` : "";
    lines.push(...wrap(`    ${sharedReason ? "" : `${explainUnknown(row.reason ?? decision.reason).text} `}last ${known ? `${knownWindow}${Math.round(known.used_percent)}% at ${clock(known.observed_at)}` : "reading unavailable"}`, view.width));
  }
  if (view.verbose) {
    const rate = (value: number | null | undefined): string => value == null ? "?" : formatRatePercent(value);
    const seen = model.resetSeen[key] ? decodeResetSeen(model.resetSeen[key]) : undefined;
    lines.push(...wrap(`    burn ${rate(row.burn_percent_per_hour)}, sustainable ${rate(row.sustainable_percent_per_hour)}, reset seen ${seen ? `${clock(seen.at)}${seen.unscheduled ? " (unscheduled)" : ""}` : "-"}, idle ${row.truth === "estimated" && row.reason === IDLE_WINDOW_REASON ? "unverified" : "no"}`, view.width));
  }
  if (view.graphs !== false && hasBurndown(row, model)) {
    lines.push(...renderBurndown(row, model, Math.min(view.width, view.width < 100 ? 40 : 60), view.ascii));
  }
  return lines;
}

interface DashboardContent { lines: string[]; panels: number[]; principals: string[]; }

function tightest(rows: Observation[], model: DashboardModel): Observation {
  return [...rows].sort((a, b) => {
    const state = (value: Observation): number => (({ FREEZE: 4, CONSERVE: 3, UNKNOWN: 2, HARVEST: 1, NORMAL: 0, NOT_ENFORCED: -1 } as Record<string, number>)[paceDecision(value, model.policy, model.now).state] ?? 0);
    return state(b) - state(a) || (b.quantity?.used ?? -1) - (a.quantity?.used ?? -1) || (a.window?.minutes ?? Infinity) - (b.window?.minutes ?? Infinity);
  })[0]!;
}

function creditExpiry(value: string | null | undefined): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return `, expire ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(value))}`;
}

function summaryLine(principal: string, rows: Observation[], model: DashboardModel, focused: boolean): string {
  const row = tightest(rows, model);
  const prefix = `${focused ? ">" : " "} ${clip(principal, 16).padEnd(16)}`;
  if (row.window?.kind === "state") {
    const state = row.metadata?.state ?? "DOWN";
    const status = state === "UP" ? "ok" : state === "BUSY" ? "busy" : "down";
    return `${prefix} ${state}  ${row.metadata?.model_ids?.[0] ?? "?"}  ${row.metadata?.running ?? row.quantity?.used ?? 0} running, ${row.metadata?.waiting ?? 0} waiting  ${status}`;
  }
  if (row.quantity?.unit === "credits") return `${prefix} ${row.quantity.remaining ?? "?"} available${creditExpiry(row.resets_at)}`;
  const decision = paceDecision(row, model.policy, model.now), used = row.quantity?.unit === "percent" && decision.state !== "UNKNOWN" ? Math.round(row.quantity.used) : null;
  const bar = used === null ? "?".repeat(20) : "#".repeat(Math.round(used / 5)) + ".".repeat(20 - Math.round(used / 5));
  const seconds = resetsIn(row.resets_at, model.now).resets_in_seconds;
  const status = decision.state === "FREEZE" ? "stop" : decision.state === "CONSERVE" ? "watch" : decision.state === "UNKNOWN" ? "unknown" : "ok";
  return `${prefix} [${bar}] ${used === null ? "  -" : `${used}%`.padStart(4)} resets in ${seconds === null || decision.state === "UNKNOWN" ? "?" : formatResetsIn(seconds)} ${decision.state} ${status}`;
}

function dashboardContent(model: DashboardModel, view: DashboardView): DashboardContent {
  const width = view.width;
  const lines: string[] = [];
  const principals = [...new Set(model.observations.map((row) => row.principal_id))].sort();
  const active = model.leases.filter((lease) => !lease.ended_at && Date.parse(lease.expires_at) > model.now.getTime());
  const hourAgo = model.now.getTime() - 3_600_000;
  const next = model.observations.filter((row) => row.resets_at && Date.parse(row.resets_at) >= model.now.getTime()).sort((a, b) => Date.parse(a.resets_at!) - Date.parse(b.resets_at!))[0];
  lines.push("OVERVIEW");
  principals.forEach((principal, index) => lines.push(summaryLine(principal, model.observations.filter((row) => row.principal_id === principal), model, index === (view.focus ?? 0) % Math.max(1, principals.length))));
  const recent = model.events.filter((event) => Date.parse(event.created_at) >= hourAgo).length;
  lines.push(`${recent} event${recent === 1 ? "" : "s"} in the last hour, ${active.length} lease${active.length === 1 ? "" : "s"} active${next ? `, next reset ${next.principal_id} ${label(next)} in ${formatResetsIn(Math.max(0, (Date.parse(next.resets_at!) - model.now.getTime()) / 1000))}` : ""}`);
  lines.push("");
  const panels: number[] = [];
  for (const principal of principals) {
    panels.push(lines.length);
    const rows = model.observations.filter((row) => row.principal_id === principal).sort((a, b) => a.meter_id.localeCompare(b.meter_id) || (a.window?.minutes ?? 0) - (b.window?.minutes ?? 0));
    const metered = rows.filter((row) => row.window?.kind !== "state");
    const header = metered.length ? renderStatus({ observations: metered, policy: model.policy, vendors: model.vendors, now: model.now }, { form: "grouped", width: 10_000, verbose: false, color: false, direct: model.direct })[0] : `${principal}  local`;
    const reason = metered.map((row) => paceDecision(row, model.policy, model.now)).find((decision) => decision.state === "UNKNOWN");
    lines.push(header);
    if (reason) lines.push(...wrap(`  UNKNOWN: ${explainUnknown(reason.reason).text}`, width));
    lines.push(...rows.flatMap((row) => windowLines(row, model, view, Boolean(reason))));
    if (view.graphs !== false) {
      const weekly = rows.find((row) => [ `${principal}:all`, `${principal}:main` ].includes(row.meter_id) && row.window?.minutes === 10080 && row.window.enforcement === "hard" && row.freshness !== "not_enforced");
      if (weekly) lines.push(...renderWeekly(weekly, model, Math.min(60, width)));
    }
    lines.push("");
  }
  if (!principals.length) lines.push("No cached readings yet. Start the daemon to collect them.", "");
  const events = ["EVENTS (last 8)", ...[...model.events].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8).map((event) => `${clock(event.created_at)} ${event.metadata?.unscheduled ? "!unscheduled " : ""}${event.kind} ${event.meter_id ?? event.principal_id ?? "-"}`)];
  if (events.length === 1) events.push("No events");
  const right = ["LEASES / RESERVES / PACING", ...active.map((lease) => `${lease.owner} ${lease.meter_id} ${lease.expected_percent ?? "?"}% held, ${lease.spent_percent.toFixed(1)}% spent, ${formatResetsIn(Math.max(0, (Date.parse(lease.expires_at) - model.now.getTime()) / 1000))} left`)];
  if (!active.length) right.push("No active leases");
  for (const meter of [...new Set(model.observations.map((row) => row.meter_id))]) { const reserve = reserveFor(model.policy.reserve, meter); if (reserve > 0) right.push(`reserve ${meter}: ${reserve}%`); }
  if (model.policy.pacing === "none") right.push("Even pacing disabled; hard limits still apply");
  right.push(...model.notices);
  if (width < 80 || view.eventsWide) lines.push(...events.flatMap((line) => wrap(line, width)), "", ...right.flatMap((line) => wrap(line, width)));
  else {
    const leftWidth = Math.floor((width - 3) / 2), rightWidth = width - leftWidth - 3, left = events.flatMap((line) => wrap(line, leftWidth)), rhs = right.flatMap((line) => wrap(line, rightWidth));
    lines.push(...Array.from({ length: Math.max(left.length, rhs.length) }, (_, i) => `${left[i] ?? ""}${" ".repeat(Math.max(0, leftWidth - length(left[i] ?? "")))} | ${rhs[i] ?? ""}`.trimEnd()));
  }
  return { lines, panels, principals };
}

function dashboardControls(width: number, ascii = false): string {
  const scroll = ascii ? "up/down/PgDn scroll" : "↑↓/PgDn scroll";
  const full = `q quit  p pause  v verbose  e events  g graphs  ${scroll}  ? help`;
  const withoutGraphs = `q quit  p pause  v verbose  e events  ${scroll}  ? help`;
  const compact = `q p v e  ${scroll}  ? help`;
  return length(full) <= width ? full : length(withoutGraphs) <= width ? withoutGraphs : compact;
}

interface DashboardLayout {
  header: string[];
  content: DashboardContent;
  footer: string[];
  room: number;
  maxScroll: number;
  scroll: number;
}

function dashboardLayout(model: DashboardModel, options: DashboardView): DashboardLayout {
  const width = Math.max(1, Math.floor(options.width) || 80), height = Math.max(1, Math.floor(options.height) || 24);
  const latest = Math.max(...model.observations.map((row) => Date.parse(row.fetched_at)).filter(Number.isFinite));
  const source = model.direct ? "direct read" : Number.isFinite(latest) ? `daemon fresh ${Math.max(0, Math.floor((model.now.getTime() - latest) / 1000))}s ago` : "daemon, no readings yet";
  const title = `Headroom ${model.version} | ${source} | ${clock(model.now)}`;
  const art = width >= 100 && (options.terminalHeight ?? height) >= 30;
  const header = [...(model.planDowngraded ?? []).map(planDowngradeLine), ...(art ? ["╷ ╷ ╭── ╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭╮╭╮", `├─┤ ├─  ├─┤ │ │ ├┬╯ │ │ │ │ │╰╯│  ${title}`, "╵ ╵ ╰── ╵ ╵ ╰─╯ ╵╰╴ ╰─╯ ╰─╯ ╵  ╵"] : [title])];
  const bodyWidth = width > 1 ? width - 1 : 1;
  const content = dashboardContent(model, { ...options, width: bodyWidth, height });
  const baseFooter = options.help ? [KEYS, GRAPH_LEGEND] : [dashboardControls(bodyWidth, options.ascii)];
  const baseRoom = Math.max(0, height - header.length - baseFooter.length);
  const overflows = content.lines.length > baseRoom;
  const room = Math.max(0, height - header.length - baseFooter.length - (overflows ? 1 : 0));
  const maxScroll = Math.max(0, content.lines.length - room);
  const scroll = Math.min(maxScroll, Math.max(0, options.scroll ?? 0));
  const overflow = !overflows ? [] : [scroll < maxScroll
    ? `${options.ascii ? "v" : "▼"} ${maxScroll - scroll} more rows  scroll: wheel / ${options.ascii ? "up/down" : "↑↓"} / PgDn`
    : `${options.ascii ? "^" : "▲"} back to top: Home`];
  return { header, content, footer: [...overflow, ...baseFooter], room, maxScroll, scroll };
}

/** A deterministic dashboard frame with a fixed header and a scrollable content viewport. */
export function renderDashboard(model: DashboardModel, options: DashboardView): string[] {
  const width = Math.max(1, Math.floor(options.width) || 80), height = Math.max(1, Math.floor(options.height) || 24);
  const bodyWidth = width > 1 ? width - 1 : 1;
  const layout = dashboardLayout(model, options);
  const visible = layout.room ? layout.content.lines.slice(layout.scroll, layout.scroll + layout.room) : [];
  const thumb = (index: number): string => {
    if (width <= 1 || layout.maxScroll === 0 || layout.room === 0) return "";
    const thumbSize = Math.max(1, Math.round(layout.room * layout.room / layout.content.lines.length));
    const start = Math.round(layout.scroll / layout.maxScroll * Math.max(0, layout.room - thumbSize));
    return index >= start && index < start + thumbSize ? "█" : "░";
  };
  const frame = [...layout.header, ...visible, ...layout.footer];
  return frame.slice(0, height).map((line, index) => clip(line, bodyWidth) + thumb(index - layout.header.length));
}

export function dashboardPanelOffset(model: DashboardModel, options: DashboardView, focus: number): number {
  const content = dashboardContent(model, { ...options, width: Math.max(1, options.width - 1) });
  return content.panels.length ? content.panels[((focus % content.panels.length) + content.panels.length) % content.panels.length] : 0;
}

export function dashboardOptions(argv: string[], isTTY: boolean, environment: NodeJS.ProcessEnv = process.env, columns?: number): { interval: number; once: boolean; color: boolean; verbose: boolean; width: number; ascii: boolean } {
  let interval = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") { interval = Number(argv[++i]); if (!Number.isFinite(interval) || interval < 2 || interval * 1000 > 2_147_483_647) throw new Error("--interval must be at least 2 seconds and fit a terminal timer"); }
    else if (!["--once", "--no-color", "--verbose", "-v", "--ascii"].includes(argv[i])) throw new Error(DASHBOARD_HELP);
  }
  const options = statusViewOptions(argv, isTTY, environment, columns);
  return { interval: interval * 1000, once: argv.includes("--once") || !isTTY, color: isTTY && environment.NO_COLOR === undefined && options.color, verbose: options.verbose, width: options.width, ascii: argv.includes("--ascii") || environment.TERM === "dumb" };
}

function paint(lines: string[], color: boolean): string[] {
  if (!color) return lines;
  const painted = lines.map((line) => {
    if (line.startsWith("PLAN DOWNGRADED:")) return `\x1b[31m${line}\x1b[0m`;
    if (line.startsWith("  UNKNOWN:")) return `\x1b[2m${line}\x1b[0m`;
    const match = /(\[[#.?]{20}\]).*?\b(NORMAL|HARVEST|CONSERVE|FREEZE|UNKNOWN)\b/.exec(line);
    const state = match?.[2];
    const code = state === "UNKNOWN" ? 90 : state === "FREEZE" || state === "DOWN" ? 31 : state === "CONSERVE" || state === "BUSY" ? 33 : 32;
    if (!state) return line;
    return line.replace(/\[[#.?]{20}\]/, (bar) => `\x1b[${code}m${bar}\x1b[0m`).replace(new RegExp(`\\b${state}\\b`), `\x1b[${code}m${state}\x1b[0m`);
  });
  for (let index = 0; index < painted.length; index++) {
    if (!/^\s*new period, \d+ readings? so far[█░]?$/.test(lines[index])) continue;
    for (let prior = index; prior >= 0; prior--) {
      painted[prior] = `\x1b[2m${painted[prior]}\x1b[0m`;
      if (/^100%(?:│|\|)/.test(lines[prior])) break;
    }
  }
  return painted;
}

export interface DashboardIO {
  input: ReadStream;
  output: WriteStream;
  errors: Pick<NodeJS.WriteStream, "write">;
  signals: NodeJS.EventEmitter;
  environment: NodeJS.ProcessEnv;
  gather: () => Promise<DashboardModel>;
}

export async function dashboardCommand(argv: string[], io: DashboardIO = { input: process.stdin, output: process.stdout, errors: process.stderr, signals: process, environment: process.env, gather: gatherDashboard }): Promise<number> {
  const { input, output, errors, signals } = io;
  if (argv.includes("--help")) { output.write(DASHBOARD_HELP + "\n"); return 0; }
  const options = dashboardOptions(argv, output.isTTY === true, io.environment, output.columns);
  const view = (): DashboardView => ({ width: output.columns || options.width, height: output.rows || 24, verbose: state.verbose, eventsWide: state.eventsWide, graphs: state.graphs, ascii: options.ascii, terminalHeight: output.rows || 24 });
  let state: DashboardState = { paused: false, verbose: options.verbose, eventsWide: false, help: false, quit: false, graphs: true, scroll: 0, focus: 0 };
  if (options.once || !input.isTTY) {
    const model = await io.gather();
    output.write(paint(renderDashboard(model, { ...view(), height: Number.MAX_SAFE_INTEGER }), options.color).join("\n") + "\n");
    return 0;
  }
  const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
  let entered = false, stopped = false, busy = false, model: DashboardModel | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Promise<number>((resolve) => {
    const restore = (): void => {
      if (timer) clearInterval(timer);
      signals.removeListener("SIGINT", quit); signals.removeListener("SIGTERM", quit); signals.removeListener("exit", restore);
      input.removeListener("keypress", keypress); input.removeListener("data", inputData); input.removeListener("error", fail); input.removeListener("end", quit);
      output.removeListener("resize", resize); output.removeListener("error", fail);
      try { input.setRawMode(wasRaw); } catch { /* The input may already be closed. */ }
      if (!wasFlowing) input.pause();
      if (entered) { entered = false; try { output.write(LEAVE_DASHBOARD); } catch { /* The output may already be closed. */ } }
    };
    const finish = (error?: unknown): void => {
      if (stopped) return;
      stopped = true; restore();
      if (error !== undefined) errors.write(`headroom error: ${safeError(error)}\n`);
      resolve(error === undefined ? 0 : 1);
    };
    const quit = (): void => finish();
    const fail = (error: unknown): void => finish(error);
    const draw = (): void => {
      if (!model || stopped) return;
      const layout = dashboardLayout(model, { ...view(), scroll: state.scroll, focus: state.focus, help: state.help });
      state.scroll = layout.scroll;
      const lines = renderDashboard(model, { ...view(), scroll: state.scroll, focus: state.focus, help: state.help });
      if (!state.help && state.paused) {
        const bodyWidth = Math.max(1, view().width - 1);
        lines[lines.length - 1] = clip(`PAUSED | ${dashboardControls(bodyWidth - length("PAUSED | "), options.ascii)}`, bodyWidth);
      }
      // CUP uses one-based terminal coordinates. An explicit 1;1 avoids
      // terminals that interpret the compact home form as a zero column.
      output.write("\x1b[1;1H" + paint(lines, options.color).map((line) => line + "\x1b[K").join("\r\n") + "\x1b[J");
    };
    const refresh = async (): Promise<void> => {
      if (stopped || busy || state.paused) return;
      busy = true;
      try { const next = await io.gather(); if (!state.paused && !stopped) { model = next; draw(); } }
      catch (error) { if (!stopped) fail(error); }
      finally { busy = false; }
    };
    const resize = (): void => { try { draw(); } catch (error) { fail(error); } };
    const applyKey = (raw: string): void => {
      const paused = state.paused;
      if (raw === "enter" && model) state = { ...state, scroll: dashboardPanelOffset(model, view(), state.focus ?? 0) };
      else {
        const pageRows = model ? dashboardLayout(model, { ...view(), scroll: state.scroll, focus: state.focus, help: state.help }).room : Math.max(1, view().height - (state.help ? 3 : 2));
        state = handleDashboardKey(state, raw === "space" ? " " : raw, Math.max(1, pageRows));
      }
      if (raw === "tab" && model) state.focus = (state.focus ?? 0) % Math.max(1, new Set(model.observations.map((row) => row.principal_id)).size);
      if (state.quit) { quit(); return; }
      resize();
      if (paused && !state.paused) void refresh();
    };
    // Kept as a narrow test seam; real terminal input is decoded from raw bytes
    // below so mouse reports never enter Node's generic keypress decoder.
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      applyKey(key?.ctrl && key.name === "c" ? "\x03" : key?.name === "return" ? "enter" : key?.name ?? text ?? "");
    };
    const inputData = (chunk: string | Buffer): void => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("latin1");
      for (const key of decodeDashboardKeys(raw)) applyKey(key);
    };
    try {
      signals.on("SIGINT", quit); signals.on("SIGTERM", quit); signals.on("exit", restore);
      input.on("error", fail); input.on("end", quit); output.on("error", fail); output.on("resize", resize);
      input.on("keypress", keypress); input.on("data", inputData);
      entered = true; output.write(ENTER_DASHBOARD); input.setRawMode(true); input.resume();
      timer = setInterval(() => { void refresh(); }, options.interval);
      void refresh();
    } catch (error) { fail(error); }
  });
}
