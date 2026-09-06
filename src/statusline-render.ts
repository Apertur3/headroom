/**
 * The one-line status bar `headroom statusline --render` prints back into
 * Claude Code's own status line on every prompt.
 *
 * Two sources, deliberately: the session's own 5h and weekly percentages come
 * straight from the JSON Claude Code just piped in, so they are exact for
 * this session and this render; everything else (the other principals, the
 * model-scoped meters, pace states, active leases, the protected reserve)
 * comes from Headroom's own view, read from the daemon over the local socket
 * with a hard millisecond budget and a fallback to the on-disk store. There
 * is never a vendor call on this path, and never an unbounded wait: this runs
 * in front of the user's prompt, so a slow or wedged daemon has to cost a
 * fixed handful of milliseconds and then be dropped, not delay the prompt.
 *
 * Because the non-session half is read from what the collector last stored,
 * those figures can be up to one poll interval old. The session's own two
 * numbers never are.
 */
import { readPolicy } from "./config.js";
import { rpc, socketPath } from "./daemon.js";
import { withPaceInfo } from "./pace.js";
import { defaultPolicy, paceDecision, reserveFor, type Policy } from "./policy.js";
import { readAccounts } from "./registry.js";
import { formatResetsIn } from "./resets.js";
import { HeadroomStore } from "./store.js";
import { isLocalAccount, type Lease, type Observation, type PaceState } from "./types.js";
import { formatStatuslineBar, statuslineMeterName, statuslineProfile, type StatuslineSnapshot } from "./adapters/claude-statusline.js";

export type StatuslineStyle = "compact" | "full";

/** The whole non-session half of the line has this long to arrive, daemon
 * round trip included. A prompt render is not a place to wait: past this the
 * line is drawn from the store instead, and past the store it is drawn from
 * the payload alone. */
export const DAEMON_BUDGET_MS = 150;

/** Compact style is a status bar, not a report: it shares one terminal row
 * with Claude Code's own model and directory segments. Segments past this
 * width are dropped from the least important end and counted as `+N`. */
export const COMPACT_MAX_WIDTH = 120;

const SEPARATOR = " · ";

export interface RenderOptions {
  style: StatuslineStyle;
  /** Meter ids, principal ids or meter labels the Headroom half is narrowed
   * to. Empty means everything. The session's own 5h and weekly segments are
   * never filtered out: they come from the payload, not from a meter. */
  meters: string[];
  color: boolean;
}

export interface StatuslineContext {
  observations: Observation[];
  leases: Lease[];
  policy: Policy;
  /** Headroom's principal name for the Claude profile that is rendering this
   * status line, when accounts.toml names one. */
  principal?: string;
  source: "daemon" | "store" | "none";
}

const ANSI = { reset: "\u001b[0m", green: "\u001b[32m", yellow: "\u001b[33m", red: "\u001b[31m", dim: "\u001b[2m" };

function paint(text: string, code: string | undefined, color: boolean): string {
  return color && code ? `${code}${text}${ANSI.reset}` : text;
}

function stateColor(state: PaceState): string | undefined {
  if (state === "HARVEST" || state === "UP") return ANSI.green;
  if (state === "CONSERVE" || state === "BUSY") return ANSI.yellow;
  if (state === "FREEZE" || state === "DOWN") return ANSI.red;
  if (state === "UNKNOWN") return ANSI.dim;
  return undefined;
}

/** Mirrors cli.ts's own window labels so a segment here reads the same as the
 * same window on `headroom status`. */
function windowLabel(minutes: number | null | undefined): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

/** Whole percent, the same rounding `headroom status` prints. */
function percent(used: number): string { return `${Math.round(used)}%`; }

/** Mirrors cli.ts's formatRatePercent: whole percent normally, one decimal
 * below 1%/h so a slow burn does not collapse to a bare "0%/h". */
function ratePercent(value: number): string {
  const text = value !== 0 && Math.abs(value) < 1 ? value.toFixed(1) : String(Math.round(value));
  return `${text}%/h`;
}

/** JavaScript's own Date range in seconds, the same bound the snapshot
 * adapter applies before letting an epoch reach `new Date()`. */
const MAX_EPOCH_SECONDS = 8_640_000_000_000;

/** Countdown to a reset given as epoch seconds (Claude Code's own unit),
 * through the shared formatResetsIn helper. Undefined -- so the caller omits
 * the countdown entirely rather than printing a wrong one -- when there is no
 * reset, or the value is not a date at all. */
function countdownFromEpoch(seconds: number | null | undefined, now: Date): string | undefined {
  if (seconds === null || seconds === undefined) return undefined;
  if (!Number.isFinite(seconds) || Math.abs(seconds) > MAX_EPOCH_SECONDS) return undefined;
  return formatResetsIn(Math.max(0, Math.round((seconds * 1000 - now.getTime()) / 1000)));
}

interface Segment {
  /** What the segment measures as, escape codes excluded, so the width
   * budget is about what the user actually sees. */
  plain: string;
  /** What is printed, colour included when colour is on. */
  colored: string;
  /** Whether the width budget may drop this segment. The session's own two
   * numbers, the reserve and the lease count never are. */
  droppable: boolean;
}

/**
 * One segment. The pace state is appended only when it is not NORMAL --
 * NORMAL is the resting state of every healthy meter and printing it on every
 * one of them would fill the bar with the one word that carries no news --
 * and only when Headroom actually has a row for that window, so an exact
 * vendor percentage is never shadowed by an UNKNOWN that only means
 * "Headroom has not polled this yet".
 */
function segment(body: string, state: PaceState | undefined, color: boolean, droppable: boolean): Segment {
  if (state === undefined || state === "NORMAL") return { plain: body, colored: body, droppable };
  return { plain: `${body} ${state}`, colored: `${body} ${paint(state, stateColor(state), color)}`, droppable };
}

/** The burn and time-to-stall tail `--style full` adds, from the same
 * `rate` figures `headroom rate` prints. Empty in compact style, and empty
 * for a window with too few samples to have a burn at all. */
function burnTail(row: Observation | undefined, style: StatuslineStyle): string {
  if (style !== "full" || !row) return "";
  const burn = row.burn_percent_per_hour;
  if (burn === null || burn === undefined) return "";
  const stall = row.empty_in_seconds;
  const stallText = stall === null || stall === undefined ? "" : `, stall in ${formatResetsIn(stall)}`;
  return ` burn ${ratePercent(burn)}${stallText}`;
}

function lastDroppableIndex(segments: Segment[]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) if (segments[index].droppable) return index;
  return -1;
}

/**
 * Joins the segments, dropping droppable ones from the end until the visible
 * line fits the width budget and reporting how many went as a trailing `+N`.
 * Width is measured on the plain text so turning colour on never costs a
 * segment.
 */
export function joinSegments(segments: Segment[], maxWidth: number | undefined): string {
  let kept = segments;
  let dropped = 0;
  const width = (list: Segment[], count: number): number =>
    list.map((item) => item.plain).join(SEPARATOR).length + (count ? SEPARATOR.length + `+${count}`.length : 0);
  while (maxWidth !== undefined && width(kept, dropped) > maxWidth) {
    const index = lastDroppableIndex(kept);
    if (index < 0) break;
    kept = [...kept.slice(0, index), ...kept.slice(index + 1)];
    dropped += 1;
  }
  const text = kept.map((item) => item.colored).join(SEPARATOR);
  return dropped ? `${text}${SEPARATOR}+${dropped}` : text;
}

/** Whether a Headroom-sourced segment survives `--meters`: an empty list
 * keeps everything, otherwise the meter id, its principal half or the window
 * label has to be named. */
function selected(filter: string[], meterId: string, principalId: string, label: string): boolean {
  if (!filter.length) return true;
  const suffix = meterId.slice(meterId.indexOf(":") + 1);
  return filter.some((item) => item === meterId || item === principalId || item === label || item === suffix);
}

function enforcedPercent(row: Observation): boolean {
  return row.freshness !== "not_enforced" && row.quantity?.unit === "percent" && row.window?.kind !== "state";
}

/** The window that decides a principal's segment: the fullest enforced
 * percent window it has. A principal reading 83% weekly and 4% on its 5h
 * window is a principal with a weekly problem, and that is the number worth
 * one segment of a status bar. */
function decidingRow(rows: Observation[]): Observation | undefined {
  const enforced = rows.filter(enforcedPercent);
  if (!enforced.length) return undefined;
  return enforced.reduce((worst, item) => (item.quantity!.used > worst.quantity!.used ? item : worst));
}

/**
 * The status-bar line itself: pure, given a payload snapshot, a context and
 * the options. Never throws and never returns an empty string -- a statusLine
 * command that prints nothing blanks the user's bar -- falling back to the
 * plain payload-only bar when there is nothing at all to say.
 */
export function renderStatusline(snapshot: StatuslineSnapshot | undefined, context: StatuslineContext, options: RenderOptions, now = new Date()): string {
  const { style, color } = options;
  const policy = context.policy;
  const principal = context.principal;
  const rows = context.observations;
  const mine = principal ? rows.filter((row) => row.principal_id === principal) : [];
  const allMeter = principal ? `${principal}:all` : undefined;
  const rowFor = (meterId: string, minutes: number): Observation | undefined =>
    mine.find((row) => row.meter_id === meterId && row.window?.minutes === minutes);

  const segments: Segment[] = [];

  // 1. The session's own two windows, always from the payload Claude Code
  //    just handed over, so they are exact for this render.
  const fiveRow = allMeter ? rowFor(allMeter, 300) : undefined;
  const weekRow = allMeter ? rowFor(allMeter, 10_080) : undefined;
  if (snapshot?.five_hour) {
    const reset = countdownFromEpoch(snapshot.five_hour.resets_at, now);
    const body = `5h ${percent(snapshot.five_hour.used_percent)}${reset ? ` ↻${reset}` : ""}${burnTail(fiveRow, style)}`;
    segments.push(segment(body, fiveRow ? paceDecision(fiveRow, policy, now).state : undefined, color, false));
  }
  if (snapshot?.seven_day) {
    // The weekly countdown is a days-away figure that earns its width only in
    // full style; compact keeps the weekly segment to its percentage.
    const reset = style === "full" ? countdownFromEpoch(snapshot.seven_day.resets_at, now) : undefined;
    const body = `wk ${percent(snapshot.seven_day.used_percent)}${reset ? ` ↻${reset}` : ""}${burnTail(weekRow, style)}`;
    segments.push(segment(body, weekRow ? paceDecision(weekRow, policy, now).state : undefined, color, false));
  }

  // 2. The session principal's model-scoped meters (Fable, Routines, any
  //    other bucket the vendor caps separately). Preferred from the payload,
  //    which is exact, and filled in from Headroom for a scoped meter this
  //    render's payload did not carry.
  const scoped = new Map<string, { used: number; row?: Observation }>();
  for (const [key, bucket] of Object.entries(snapshot?.extra ?? {})) {
    const name = statuslineMeterName(key);
    if (name) scoped.set(name, { used: bucket.used_percent });
  }
  for (const row of mine) {
    if (!enforcedPercent(row) || row.meter_id === allMeter) continue;
    const name = row.meter_id.slice(row.meter_id.indexOf(":") + 1);
    const existing = scoped.get(name);
    if (existing) existing.row = row;
    else scoped.set(name, { used: row.quantity!.used, row });
  }
  for (const [name, entry] of [...scoped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // A scoped bucket read straight off the payload is worth showing even
    // when accounts.toml names no principal for this profile: the number is
    // exact either way, and only the pace state beside it needs a principal.
    if (!selected(options.meters, principal ? `${principal}:${name}` : name, principal ?? name, name)) continue;
    segments.push(segment(`${name} ${percent(entry.used)}${burnTail(entry.row, style)}`, entry.row ? paceDecision(entry.row, policy, now).state : undefined, color, true));
  }

  // 3. Every other principal Headroom knows about, most constrained first so
  //    the segment that matters survives the width budget.
  const others = new Map<string, Observation[]>();
  for (const row of rows) {
    if (row.principal_id === principal) continue;
    others.set(row.principal_id, [...(others.get(row.principal_id) ?? []), row]);
  }
  const otherSegments: Array<{ used: number; segment: Segment }> = [];
  for (const [id, list] of others) {
    const row = decidingRow(list) ?? list[0];
    if (!row) continue;
    if (!selected(options.meters, row.meter_id, id, windowLabel(row.window?.minutes))) continue;
    const state = paceDecision(row, policy, now).state;
    if (!enforcedPercent(row)) {
      // A local pool (or a window with no percentage at all) has a state and
      // nothing to put a percentage on; its state is the whole reading, so it
      // is printed even when a percentage segment would have hidden NORMAL.
      otherSegments.push({ used: -1, segment: { plain: `${id} ${state}`, colored: `${id} ${paint(state, stateColor(state), color)}`, droppable: true } });
      continue;
    }
    const body = `${id} ${windowLabel(row.window?.minutes)} ${percent(row.quantity!.used)}${burnTail(row, style)}`;
    otherSegments.push({ used: row.quantity!.used, segment: segment(body, state, color, true) });
  }
  for (const item of otherSegments.sort((a, b) => b.used - a.used)) segments.push(item.segment);

  // 4. Leases and the protected reserve: short, pinned, and the two things
  //    that explain a refusal a healthy-looking percentage would not.
  const leases = context.leases.length;
  if (leases) segments.push({ plain: `${leases} lease${leases === 1 ? "" : "s"}`, colored: `${leases} lease${leases === 1 ? "" : "s"}`, droppable: false });
  const reserve = reserveFor(policy.reserve, allMeter ?? "");
  if (reserve > 0) segments.push({ plain: `reserve ${reserve}%`, colored: `reserve ${reserve}%`, droppable: false });

  if (!segments.length) return formatStatuslineBar(snapshot, now);
  return joinSegments(segments, style === "compact" ? COMPACT_MAX_WIDTH : undefined);
}

/**
 * The daemon half of the line, under one wall-clock budget for the whole
 * exchange -- not a per-call timeout. `status` and `leases` go out together
 * on their own connections; whatever has not answered when the budget expires
 * is abandoned and the caller falls back to the store. A daemon that is
 * mid-poll, wedged, or simply not running all look the same from here, which
 * is the point: none of them may delay a prompt.
 */
export async function daemonRows(path: string, budgetMs = DAEMON_BUDGET_MS, request = rpc): Promise<{ observations: Observation[]; leases: Lease[] } | undefined> {
  const deadline = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), budgetMs);
    timer.unref?.();
  });
  const work = (async () => {
    const [status, leases] = await Promise.all([request(path, "status", {}, budgetMs), request(path, "leases", {}, budgetMs)]);
    if (!Array.isArray(status)) return undefined;
    return { observations: status as Observation[], leases: Array.isArray(leases) ? leases as Lease[] : [] };
  })();
  return Promise.race([work, deadline]).catch(() => undefined);
}

/** Headroom's principal name for one Claude profile, from accounts.toml.
 * Undefined when the file is missing or names no account for this profile;
 * the line then simply has no session-scoped half to attribute. */
export async function sessionPrincipal(profile: string): Promise<string | undefined> {
  try {
    const accounts = await readAccounts();
    const match = accounts.find((account) => !isLocalAccount(account) && account.vendor === "claude" && statuslineProfile(account.location) === profile);
    return match?.name;
  } catch { return undefined; }
}

/**
 * Everything the line needs beyond the payload: the daemon's view within the
 * budget, else the store's own last-written view, else nothing. Never a
 * vendor call from here -- `latestPerWindow` is a read of what the collector
 * already stored, so the fallback path cannot turn a prompt render into a
 * network request.
 */
export async function statuslineContext(profile: string, now = new Date(), budgetMs = DAEMON_BUDGET_MS): Promise<StatuslineContext> {
  const policy = await readPolicy().catch(() => defaultPolicy);
  const principal = await sessionPrincipal(profile);
  try {
    const fromDaemon = await daemonRows(socketPath(), budgetMs);
    if (fromDaemon) return { ...fromDaemon, policy, ...(principal ? { principal } : {}), source: "daemon" };
  } catch { /* the store fallback below is the answer to any daemon trouble */ }
  try {
    const store = await HeadroomStore.open();
    try {
      const rows = store.latestPerWindow();
      return {
        observations: withPaceInfo(rows, store.burnRateFor(rows, now), now),
        leases: store.leases(undefined, true, now),
        policy, ...(principal ? { principal } : {}), source: "store",
      };
    } finally { store.close(); }
  } catch { return { observations: [], leases: [], policy, ...(principal ? { principal } : {}), source: "none" }; }
}

/** Parses `--render`'s own flags out of the argument list ahead of `--chain`
 * (everything after `--chain` belongs to the chained command). An unknown
 * style is not an error: this command must always print a line, so it falls
 * back to compact rather than refusing. */
export function parseRenderOptions(argv: string[], isTty: boolean, environment: NodeJS.ProcessEnv = process.env): RenderOptions | undefined {
  if (!argv.includes("--render")) return undefined;
  const styleAt = argv.indexOf("--style");
  const style: StatuslineStyle = styleAt >= 0 && argv[styleAt + 1] === "full" ? "full" : "compact";
  const metersAt = argv.indexOf("--meters");
  const meters = metersAt >= 0 ? (argv[metersAt + 1] ?? "").split(",").map((item) => item.trim()).filter(Boolean) : [];
  const explicitColor = argv.includes("--color");
  const noColor = (environment.NO_COLOR ?? "") !== "";
  return { style, meters, color: explicitColor || (isTty && !noColor) };
}

/**
 * The whole rendered line, end to end. Absorbs every failure into the plain
 * payload-only bar: this is what Claude Code shows the user on every prompt,
 * so it prints something honest or it prints the simpler thing, never an
 * error and never nothing.
 */
export async function renderedStatusline(snapshot: StatuslineSnapshot | undefined, profile: string, options: RenderOptions, now = new Date(), budgetMs = DAEMON_BUDGET_MS): Promise<string> {
  try {
    const context = await statuslineContext(profile, now, budgetMs);
    return renderStatusline(snapshot, context, options, now);
  } catch { return formatStatuslineBar(snapshot, now); }
}
