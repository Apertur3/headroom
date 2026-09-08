import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { gatherDashboard, type DashboardModel } from "./dashboard-data.js";
import { IDLE_WINDOW_REASON } from "./engine/observation.js";
import { paceDecision, reserveFor } from "./policy.js";
import { decodeResetSeen, formatResetsIn, resetsIn } from "./resets.js";
import { safeError } from "./security.js";
import { formatRatePercent, label, renderStatus, statusViewOptions } from "./status-view.js";
import type { Observation } from "./types.js";
export type { DashboardModel } from "./dashboard-data.js";

export const DASHBOARD_HELP = "Usage: headroom dashboard (alias: top) [--interval <s>] [--once] [--no-color] [--verbose]";
export const ENTER_DASHBOARD = "\x1b[?1049h\x1b[?25l";
export const LEAVE_DASHBOARD = "\x1b[0m\x1b[?25h\x1b[?1049l";
const KEYS = "q quit  p pause/resume  v verbose  e events wide  ? help";

export interface DashboardView { width: number; height: number; verbose: boolean; eventsWide: boolean; }
export interface DashboardState { paused: boolean; verbose: boolean; eventsWide: boolean; help: boolean; quit: boolean; }

export function handleDashboardKey(state: DashboardState, key: string): DashboardState {
  if (key === "q" || key === "\x03") return { ...state, quit: true };
  if (key === "p") return { ...state, paused: !state.paused };
  if (key === "v") return { ...state, verbose: !state.verbose };
  if (key === "e") return { ...state, eventsWide: !state.eventsWide };
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
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(11, 19) : "?";
}
function spark(values: Array<number | null>): string {
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  return values.map((value) => value === null ? "·" : "▁▂▃▄▅▆▇█"[Math.round(Math.max(0, value) / max * 7)]).join("");
}
function windowLines(row: Observation, model: DashboardModel, view: DashboardView): string[] {
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
  let text = `  ${clip(meter, 10).padEnd(10)} ${label(row).padEnd(3)} [${bar}] ${used === null ? "  -" : `${Math.round(used)}%`.padStart(4)} resets in ${unknown || seconds === null ? "?" : formatResetsIn(seconds)} ${decision.state}`;
  if (decision.state === "NOT_ENFORCED") text = `  ${meter} ${label(row)} n/a (not enforced)`;
  if (view.width >= 100 && !unknown && model.burns[key]?.length) text += ` ${spark(model.burns[key])}`;
  const lines = [text];
  if (unknown) {
    const known = row.last_known ?? (row.quantity?.unit === "percent" ? { used_percent: row.quantity.used, observed_at: row.observed_at, window_minutes: undefined } : null);
    const knownWindow = known?.window_minutes !== undefined ? `${label({ ...row, window: { kind: "fixed", minutes: known.window_minutes, enforcement: "hard" } })} ` : "";
    lines.push(...wrap(`    ${row.reason || decision.reason}; last ${known ? `${knownWindow}${Math.round(known.used_percent)}% at ${clock(known.observed_at)} UTC` : "reading unavailable"}`, view.width));
  }
  if (view.verbose) {
    const rate = (value: number | null | undefined): string => value == null ? "?" : formatRatePercent(value);
    const seen = model.resetSeen[key] ? decodeResetSeen(model.resetSeen[key]) : undefined;
    lines.push(...wrap(`    burn ${rate(row.burn_percent_per_hour)}, sustainable ${rate(row.sustainable_percent_per_hour)}, reset seen ${seen ? `${clock(seen.at)}${seen.unscheduled ? " (unscheduled)" : ""}` : "-"}, idle ${row.truth === "estimated" && row.reason === IDLE_WINDOW_REASON ? "unverified" : "no"}`, view.width));
  }
  return lines;
}

/** A deterministic grouped frame. Terminal escapes are applied by the runner. */
export function renderDashboard(model: DashboardModel, options: DashboardView): string[] {
  const width = Math.max(1, Math.floor(options.width) || 80), height = Math.max(1, Math.floor(options.height) || 24);
  const view = { ...options, width, height };
  const latest = Math.max(...model.observations.map((row) => Date.parse(row.fetched_at)).filter(Number.isFinite));
  const source = model.direct ? "direct read" : Number.isFinite(latest) ? `daemon fresh ${Math.max(0, Math.floor((model.now.getTime() - latest) / 1000))} s ago` : "daemon, no readings yet";
  const lines = [`Headroom ${model.version} | ${source} | ${clock(model.now)} UTC`, ""];
  const principals = [...new Set(model.observations.map((row) => row.principal_id))].sort();
  for (const principal of principals) {
    const rows = model.observations.filter((row) => row.principal_id === principal).sort((a, b) => a.meter_id.localeCompare(b.meter_id) || (a.window?.minutes ?? 0) - (b.window?.minutes ?? 0));
    const metered = rows.filter((row) => row.window?.kind !== "state");
    // Reuse the human status header, including its vendor and plan inference.
    const header = metered.length ? renderStatus({ observations: metered, policy: model.policy, vendors: model.vendors, now: model.now }, { form: "grouped", width: 10_000, verbose: false, color: false, direct: model.direct })[0] : `${principal}  local`;
    lines.push(header, ...rows.flatMap((row) => windowLines(row, model, view)), "");
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
  const result = [...body, ...footer, "q quit  p pause  v verbose  e events  ? help"];
  if (result.length > height) result.splice(height - 2, result.length - height + 1, "... more detail than terminal rows");
  return result.slice(0, height).map((line) => clip(line, width));
}

export function dashboardOptions(argv: string[], isTTY: boolean, environment: NodeJS.ProcessEnv = process.env, columns?: number): { interval: number; once: boolean; color: boolean; verbose: boolean; width: number } {
  let interval = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") { interval = Number(argv[++i]); if (!Number.isFinite(interval) || interval < 2 || interval * 1000 > 2_147_483_647) throw new Error("--interval must be at least 2 seconds and fit a terminal timer"); }
    else if (!["--once", "--no-color", "--verbose", "-v"].includes(argv[i])) throw new Error(DASHBOARD_HELP);
  }
  const options = statusViewOptions(argv, isTTY, environment, columns);
  return { interval: interval * 1000, once: argv.includes("--once") || !isTTY, color: isTTY && environment.NO_COLOR === undefined && options.color, verbose: options.verbose, width: options.width };
}

function paint(lines: string[], color: boolean): string[] {
  if (!color) return lines;
  return lines.map((line) => {
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
  const view = (): DashboardView => ({ width: output.columns || options.width, height: output.rows || 24, verbose: state.verbose, eventsWide: state.eventsWide });
  let state: DashboardState = { paused: false, verbose: options.verbose, eventsWide: false, help: false, quit: false };
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
      lines[lines.length - 1] = clip(state.help ? KEYS : `${state.paused ? "PAUSED | " : ""}q quit  p pause  v verbose  e events  ? help`, view().width);
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
