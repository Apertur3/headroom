import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { readPolicy } from "./config.js";
import { dashboardSnapshot, readDashboardStore, type DashboardModel as CachedDashboardModel, type DashboardReader } from "./dashboard-data.js";
import { readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";
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

export async function gatherDashboard(): Promise<DashboardModel> {
  const { daemonRequest, socketPath } = await import("./daemon.js");
  const [reply, policy, accounts, version] = await Promise.all([
    daemonRequest(socketPath(), "dashboard", {}, 250, 250).catch(() => undefined),
    readPolicy(), readAccounts().catch(() => []), headroomVersion(),
  ]);
  const store = await HeadroomStore.open();
  try {
    const now = new Date();
    const { snapshot, direct } = await dashboardRead({ request: async () => reply, fallback: async () => readDashboardStore(store, now) });
    return { ...snapshot, ...readDashboardGraphs(store, snapshot.observations, now), direct, policy, version, now,
      vendors: new Map(accounts.map((account) => [account.name, isLocalAccount(account) ? "local" : account.vendor])) };
  } finally { store.close(); }
}

export const DASHBOARD_HELP = "Usage: headroom dashboard (alias: top) [--interval <s>] [--once] [--no-color] [--verbose] [--ascii]";
export const ENTER_DASHBOARD = "\x1b[?1049h\x1b[?25l";
export const LEAVE_DASHBOARD = "\x1b[0m\x1b[?25h\x1b[?1049l";
const KEYS = "q quit  p pause/resume  v verbose  e events wide  g graphs  ? help";

export interface DashboardView { width: number; height: number; verbose: boolean; eventsWide: boolean; graphs?: boolean; ascii?: boolean; terminalHeight?: number; }
export interface DashboardState { paused: boolean; verbose: boolean; eventsWide: boolean; help: boolean; quit: boolean; graphs?: boolean; }

export function handleDashboardKey(state: DashboardState, key: string): DashboardState {
  if (key === "q" || key === "\x03") return { ...state, quit: true };
  if (key === "p") return { ...state, paused: !state.paused };
  if (key === "v") return { ...state, verbose: !state.verbose };
  if (key === "e") return { ...state, eventsWide: !state.eventsWide };
  if (key === "g") return { ...state, graphs: state.graphs === false };
  if (key === "?") return { ...state, help: !state.help };
  return state;
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
  const all = graphPoints(row, model).filter((point) => point.reset === reset);
  const start = row.window?.minutes ? reset - row.window.minutes * 60_000 : all[0]?.at;
  const points = all.filter((point) => point.at >= start && point.at <= reset);
  if (width < 12 || !Number.isFinite(start) || !Number.isFinite(reset) || reset <= start || points.length < 3) return [clip("  collecting readings", width)];
  const columns = Math.floor(width) - 6, rows = 8, sx = ascii ? 1 : 2, sy = ascii ? 2 : 4;
  const pixelWidth = columns * sx, pixelHeight = rows * sy;
  const actual = new Uint8Array(pixelWidth * pixelHeight), plan = new Uint8Array(pixelWidth * pixelHeight);
  const x = (at: number): number => Math.round(clamp((at - start) / (reset - start), 1) * (pixelWidth - 1));
  const y = (used: number): number => Math.round((1 - used / 100) * (pixelHeight - 1));
  const line = (target: Uint8Array, x1: number, y1: number, x2: number, y2: number, dotted = false): void => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let step = 0; step <= steps; step++) {
      if (dotted && step % 4 !== 0 && step !== steps) continue;
      const px = Math.round(x1 + (x2 - x1) * step / steps), py = Math.round(y1 + (y2 - y1) * step / steps);
      target[py * pixelWidth + px] = 1;
    }
  };
  line(plan, 0, pixelHeight - 1, pixelWidth - 1, 0, true);
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
  const axis = ends(dayTime(start), `${dayTime(reset)} reset`, width);
  const decision = paceDecision(row, model.policy, model.now);
  const used = row.quantity?.unit === "percent" && decision.state !== "UNKNOWN" ? row.quantity.used : null;
  const planned = clamp((model.now.getTime() - start) / (reset - start), 1) * 100;
  const difference = used === null ? 0 : Math.round(used - planned);
  const pace = used === null ? "pace unknown" : difference > 0 ? `over pace by ${difference} points` : difference < 0 ? `under pace${decision.state === "HARVEST" ? ", HARVEST" : ""}` : "on pace";
  const minutes = Math.max(0, Math.floor((reset - model.now.getTime()) / 60_000));
  const summary = `${used === null ? "?" : Math.round(used)}% used, ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m left, ${pace}`;
  const compact = `${used === null ? "?" : Math.round(used)}%, ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m, ${pace}`;
  return [...plot, axis, clip(length(summary) <= width ? summary : compact, width)];
}

/** Seven elapsed days, using weekly readings and local calendar day ticks. */
export function renderWeekly(row: Observation, model: DashboardModel, width: number): string[] {
  const end = model.now.getTime(), start = end - 7 * 86_400_000;
  const points = graphPoints(row, model).filter((point) => point.at >= start);
  if (!points.length) return [];
  const columns = Math.max(1, Math.floor(width) - 2);
  const position = (at: number): number => Math.round(clamp((at - start) / (end - start), 1) * (columns - 1));
  const chart = Array<string>(columns).fill("·"), ticks = Array<string>(columns).fill(" ");
  for (const point of points) chart[position(point.at)] = "▁▂▃▄▅▆▇█"[Math.round(point.used / 100 * 7)];
  for (const event of model.graphEvents ?? model.events) {
    const at = Date.parse(event.created_at);
    if (event.corrected_by || (event.metadata?.window_minutes != null && event.metadata.window_minutes !== row.window?.minutes) || at < start || at > end || !Number.isFinite(at) || (event.meter_id ? event.meter_id !== row.meter_id : event.principal_id !== row.principal_id)) continue;
    const marker = event.kind.startsWith("free_reset_") ? "F" : event.kind === "reset_seen" && event.metadata?.unscheduled ? "!" : undefined;
    if (!marker) continue;
    const index = position(at);
    chart[index] = ["F", "!", "*"].includes(chart[index]) && chart[index] !== marker ? "*" : marker;
  }
  const day = new Date(start); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + 1);
  while (day.getTime() <= end) {
    const index = position(day.getTime()), name = `|${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day)}`;
    for (let i = 0; i < name.length && index + i < columns; i++) ticks[index + i] = name[i];
    day.setDate(day.getDate() + 1);
  }
  return [clip(`  WEEKLY ${row.meter_id} | last 7 days | F free reset  ! unscheduled  * both`, width), `  ${chart.join("")}`, `  ${ticks.join("").trimEnd()}`];
}

function windowLines(row: Observation, model: DashboardModel, view: DashboardView, sharedReason = false): string[] {
  const decision = paceDecision(row, model.policy, model.now);
  const meter = row.meter_id.startsWith(`${row.principal_id}:`) ? row.meter_id.slice(row.principal_id.length + 1) : row.meter_id;
  const key = `${row.meter_id}:${row.window?.minutes ?? "none"}`;
  if (row.window?.kind === "state") return [`  ${meter}  ${row.metadata?.state ?? "DOWN"}  model=${row.metadata?.model_ids?.join(",") || "?"}  queue=${row.metadata?.waiting ?? 0}  running=${row.metadata?.running ?? row.quantity?.used ?? 0}${row.reason ? ` (${row.reason})` : ""}`];
  if (row.quantity?.unit === "credits") return [`  credits  ${row.quantity.remaining ?? "?"} available${row.resets_at ? `, expires ${row.resets_at.slice(0, 10)}` : ""}`];
  const unknown = decision.state === "UNKNOWN";
  const used = !unknown && row.quantity?.unit === "percent" ? row.quantity.used : null;
  const filled = used === null ? 0 : Math.round(Math.max(0, Math.min(100, used)) / 5);
  const bar = unknown ? "?".repeat(20) : "#".repeat(filled) + ".".repeat(20 - filled);
  const seconds = resetsIn(row.resets_at, model.now).resets_in_seconds;
  const glyph = { NORMAL: "●", HARVEST: "↗", CONSERVE: "⚠", FREEZE: "🛑", UNKNOWN: "?", NOT_ENFORCED: "", UP: "●", BUSY: "⚠", DOWN: "🛑" }[decision.state];
  let text = `  ${clip(meter, 10).padEnd(10)} ${label(row).padEnd(3)} [${bar}] ${used === null ? "  -" : `${Math.round(used)}%`.padStart(4)} ${glyph} resets in ${unknown || seconds === null ? "?" : formatResetsIn(seconds)} ${decision.state}`;
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
    lines.push(...renderBurndown(row, model, view.width, view.ascii));
  }
  return lines;
}

/** A deterministic grouped frame. Terminal escapes are applied by the runner. */
export function renderDashboard(model: DashboardModel, options: DashboardView): string[] {
  const width = Math.max(1, Math.floor(options.width) || 80), height = Math.max(1, Math.floor(options.height) || 24);
  const view = { ...options, width, height };
  const latest = Math.max(...model.observations.map((row) => Date.parse(row.fetched_at)).filter(Number.isFinite));
  const source = model.direct ? "direct read" : Number.isFinite(latest) ? `daemon fresh ${Math.max(0, Math.floor((model.now.getTime() - latest) / 1000))}s ago` : "daemon, no readings yet";
  const title = `Headroom ${model.version} | ${source} | ${clock(model.now)}`;
  const lines = width >= 100 && (view.terminalHeight ?? height) >= 30
    ? ["╷ ╷ ╭── ╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭╮╭╮", `├─┤ ├─  ├─┤ │ │ ├┬╯ │ │ │ │ │╰╯│  ${title}`, "╵ ╵ ╰── ╵ ╵ ╰─╯ ╵╰╴ ╰─╯ ╰─╯ ╵  ╵", ""]
    : [title, ""];
  const downgrades = model.planDowngraded ?? [];
  lines.unshift(...downgrades.map(planDowngradeLine), ...(downgrades.length ? [""] : []));
  if (view.graphs !== false && model.observations.some((row) => hasBurndown(row, model))) lines.push(clip(`Burndown: solid used, dotted plan, ${view.ascii ? "|" : "│"} now, ${view.ascii ? ":" : "░"} reserve`, width));
  const principals = [...new Set(model.observations.map((row) => row.principal_id))].sort();
  for (const principal of principals) {
    const rows = model.observations.filter((row) => row.principal_id === principal).sort((a, b) => a.meter_id.localeCompare(b.meter_id) || (a.window?.minutes ?? 0) - (b.window?.minutes ?? 0));
    const metered = rows.filter((row) => row.window?.kind !== "state");
    // Reuse the human status header, including its vendor and plan inference.
    const header = metered.length ? renderStatus({ observations: metered, policy: model.policy, vendors: model.vendors, now: model.now }, { form: "grouped", width: 10_000, verbose: false, color: false, direct: model.direct })[0] : `${principal}  local`;
    const explanations = metered.flatMap((row) => {
      const decision = paceDecision(row, model.policy, model.now);
      return decision.state === "UNKNOWN" ? [explainUnknown(row.reason ?? decision.reason).text] : [];
    });
    const shared = explanations.length > 0 && new Set(explanations).size === 1;
    lines.push(header);
    if (shared) lines.push(...wrap(`  UNKNOWN: ${explanations[0]}`, width));
    lines.push(...rows.flatMap((row) => windowLines(row, model, view, shared)));
    if (view.graphs !== false && width >= 100) {
      const weekly = rows.find((row) => [ `${principal}:all`, `${principal}:main` ].includes(row.meter_id) && row.window?.minutes === 10080 && row.window.enforcement === "hard" && row.freshness !== "not_enforced");
      if (weekly) lines.push(...renderWeekly(weekly, model, width));
    }
    lines.push("");
  }
  if (!principals.length) lines.push("No cached readings yet. Start the daemon to collect them.", "");
  const events = ["EVENTS (last 8)", ...[...model.events].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8).map((event) => `${clock(event.created_at)} ${event.metadata?.unscheduled ? "!unscheduled " : ""}${event.kind} ${event.meter_id ?? event.principal_id ?? "-"}`)];
  if (events.length === 1) events.push("No events");
  const active = model.leases.filter((lease) => !lease.ended_at && Date.parse(lease.expires_at) > model.now.getTime());
  const right = ["LEASES / RESERVES / PACING", ...active.map((lease) => `${lease.owner} ${lease.meter_id} ${lease.expected_percent ?? "?"}% held, ${lease.spent_percent.toFixed(1)}% spent, ${formatResetsIn(Math.max(0, (Date.parse(lease.expires_at) - model.now.getTime()) / 1000))} left`)];
  if (!active.length) right.push("No active leases");
  for (const meter of [...new Set(model.observations.map((row) => row.meter_id))]) {
    const reserve = reserveFor(model.policy.reserve, meter);
    if (reserve > 0) right.push(`reserve ${meter}: ${reserve}%`);
  }
  if (model.policy.pacing === "none") right.push("Even pacing disabled; hard limits still apply");
  right.push(...model.notices);
  let footer: string[];
  if (width < 80 || view.eventsWide) footer = [...events.flatMap((line) => wrap(line, width)), "", ...right.flatMap((line) => wrap(line, width))];
  else {
    const leftWidth = Math.floor((width - 3) / 2), rightWidth = width - leftWidth - 3;
    const left = events.flatMap((line) => wrap(line, leftWidth)), rhs = right.flatMap((line) => wrap(line, rightWidth));
    footer = Array.from({ length: Math.max(left.length, rhs.length) }, (_, i) => {
      const text = left[i] ?? "";
      return `${text}${" ".repeat(leftWidth - length(text))} | ${rhs[i] ?? ""}`.trimEnd();
    });
  }
  // Keep a footer visible even when a large registry cannot fit on one screen.
  const footerRoom = Math.min(footer.length, Math.max(2, Math.floor(height / 3)));
  const bodyRoom = Math.max(1, height - footerRoom - 1);
  const body = lines.length > bodyRoom ? [...lines.slice(0, Math.max(1, bodyRoom - 1)), "... more panels than terminal rows"] : lines;
  const result = [...body, ...footer, "q quit  p pause  v verbose  e events  g graphs  ? help"];
  if (result.length > height) result.splice(height - 2, result.length - height + 1, "... more detail than terminal rows");
  return result.slice(0, height).map((line) => clip(line, width));
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
  return lines.map((line) => {
    if (line.startsWith("PLAN DOWNGRADED:")) return `\x1b[31m${line}\x1b[0m`;
    const state = /\b(NORMAL|HARVEST|CONSERVE|FREEZE|UNKNOWN|UP|BUSY|DOWN)\b/.exec(line)?.[1];
    const code = state === "UNKNOWN" ? 90 : state === "FREEZE" || state === "DOWN" ? 31 : state === "CONSERVE" || state === "BUSY" ? 33 : 32;
    if (!state) return line;
    return line.replace(/\[[#.?]{20}\]/, (bar) => `\x1b[${code}m${bar}\x1b[0m`).replace(new RegExp(`\\b${state}\\b`), `\x1b[${code}m${state}\x1b[0m`);
  });
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
  let state: DashboardState = { paused: false, verbose: options.verbose, eventsWide: false, help: false, quit: false, graphs: true };
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
      input.removeListener("keypress", keypress); input.removeListener("error", fail); input.removeListener("end", quit);
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
      const lines = renderDashboard(model, view());
      lines[lines.length - 1] = clip(state.help ? KEYS : `${state.paused ? "PAUSED | " : ""}q quit  p pause  v verbose  e events  g graphs  ? help`, view().width);
      output.write("\x1b[H" + paint(lines, options.color).map((line) => line + "\x1b[K").join("\r\n") + "\x1b[J");
    };
    const refresh = async (): Promise<void> => {
      if (stopped || busy || state.paused) return;
      busy = true;
      try { const next = await io.gather(); if (!state.paused && !stopped) { model = next; draw(); } }
      catch (error) { if (!stopped) fail(error); }
      finally { busy = false; }
    };
    const resize = (): void => { try { draw(); } catch (error) { fail(error); } };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      const paused = state.paused;
      state = handleDashboardKey(state, key?.ctrl && key.name === "c" ? "\x03" : text ?? "");
      if (state.quit) { quit(); return; }
      resize();
      if (paused && !state.paused) void refresh();
    };
    try {
      signals.on("SIGINT", quit); signals.on("SIGTERM", quit); signals.on("exit", restore);
      input.on("error", fail); input.on("end", quit); output.on("error", fail); output.on("resize", resize);
      emitKeypressEvents(input); input.on("keypress", keypress);
      entered = true; output.write(ENTER_DASHBOARD); input.setRawMode(true); input.resume();
      timer = setInterval(() => { void refresh(); }, options.interval);
      void refresh();
    } catch (error) { fail(error); }
  });
}
