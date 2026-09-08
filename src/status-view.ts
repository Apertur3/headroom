/**
 * Rendering for `headroom status` (the bare `headroom` default).
 *
 * Two forms, one data path:
 *
 * - The **grouped** form is for a person at a terminal. It groups the meters
 *   by principal, gives each principal a header, and puts the pace state in
 *   the last column of every row so the eye scans one column of states
 *   instead of re-reading a dense line per meter. Detail (burn, sustainable
 *   pace, reset evidence, the reserve) moves to `--verbose`.
 * - The **plain** form is the original one-line-per-meter output, byte for
 *   byte. It is what a pipe, a redirect and an agent shell get, because the
 *   audience there is a parser: fewest tokens, the same field order on every
 *   line, no colour, no headers, no footer prose. `--json` is still the
 *   recommended agent path; this is the fallback for a plain shell call.
 *
 * The form is chosen by whether stdout is a TTY, with `--human`, `--plain`
 * and `--agent` as explicit overrides.
 */
import { IDLE_WINDOW_REASON } from "./engine/observation.js";
import { paceDecision, reserveFor, reserveNote, type Policy } from "./policy.js";
import { decodeResetSeen, formatClockTime, formatResetsIn, formatResetsInCoarse, resetsIn } from "./resets.js";
import type { Lease, Observation, PaceState } from "./types.js";

// ---------------------------------------------------------------------------
// Shared formatting helpers (used by both forms, and by cli.ts elsewhere)
// ---------------------------------------------------------------------------

export function formatReset(value: string | null | undefined, now = new Date()): string {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${formatDay(value)} ${time}`;
}

function formatDay(value: string | null | undefined): string {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/** Same short window word `label()` below uses, from a bare minutes number
 * rather than an observation -- for a `last_known.window_minutes`, which
 * names a different window than the one the reading is attached to. */
function labelForMinutes(minutes: number | null | undefined): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

export function label(observation: Observation): string {
  return labelForMinutes(observation.window?.minutes);
}

/** "wk " / "5h " ahead of a last_known reading's percent when it names a
 * window other than the row it is attached to (a windowless failure whose
 * reading was borrowed from another window of the same meter) -- empty for
 * an ordinary same-window last_known, which needs no such disambiguation. */
function lastKnownWindowPrefix(lastKnown: NonNullable<Observation["last_known"]>): string {
  return lastKnown.window_minutes !== undefined ? `${labelForMinutes(lastKnown.window_minutes)} ` : "";
}

function windowKey(observation: Observation): string { return `${observation.meter_id}:${observation.window?.minutes ?? "none"}`; }

/** A whole-percent rate reads cleanly at a glance ("22%/h"); rounding a rate
 * under 1%/h the same way collapses it to a bare "0%/h" and reads as no
 * activity at all, so those get one decimal instead ("0.1%/h"). Exactly
 * zero still prints as a plain "0%/h" -- there's no precision to preserve. */
export function formatRatePercent(value: number): string {
  const text = value !== 0 && Math.abs(value) < 1 ? value.toFixed(1) : String(Math.round(value));
  return `${text}%/h`;
}

function age(observation: Observation, now: Date): string {
  const milliseconds = Math.max(0, now.getTime() - new Date(observation.fetched_at).getTime());
  return milliseconds < 60_000 ? "<1m" : `${Math.floor(milliseconds / 60_000)}m`;
}

/** Same "<1m"/"Nm" shape as age() above, from a last_known reading's own
 * precomputed age_seconds rather than a fresh now-minus-fetched_at. */
function lastKnownAge(lastKnown: NonNullable<Observation["last_known"]>): string {
  return lastKnown.age_seconds < 60 ? "<1m" : `${Math.floor(lastKnown.age_seconds / 60)}m`;
}

/** "last 41%, 65m ago" -- the compact form used in the grouped view's own
 * reset column, where the row's meter and window already say which reading
 * this is. A windowless row's borrowed reading gets its source window named
 * first instead: "last wk 41%, 6h ago". */
function lastKnownCompact(lastKnown: NonNullable<Observation["last_known"]>): string {
  return `last ${lastKnownWindowPrefix(lastKnown)}${Math.round(lastKnown.used_percent)}%, ${lastKnownAge(lastKnown)} ago`;
}

/** "weekly"/"5h" for the grouped view's own unscheduled-reset line ("the
 * weekly is back to 0%") -- full words rather than labelForMinutes' terse
 * column abbreviations, since this line is prose, not a table cell. */
function windowNoun(minutes: number | null | undefined): string {
  if (minutes === 10_080) return "weekly";
  if (minutes === 300) return "5h";
  return labelForMinutes(minutes);
}

function windowOrder(observation: Observation): number {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return 0;
  if (minutes === 10_080) return 1;
  return 2;
}

function orderWindows(windows: Observation[]): Observation[] {
  return [...windows].sort((a, b) => windowOrder(a) - windowOrder(b) || (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER));
}

/** fresh / stale / failed / not enforced, aggregated over a set of windows
 * exactly the way the plain form aggregates them per meter. */
function freshnessWord(windows: Observation[]): string {
  const enforced = windows.filter((item) => item.freshness !== "not_enforced");
  if (!enforced.length) return "not enforced";
  if (enforced.some((item) => item.freshness === "fresh")) return "fresh";
  if (enforced.some((item) => item.freshness === "failed")) return "failed";
  return "stale";
}

function isCredits(observation: Observation): boolean {
  return observation.window?.kind === "count" && observation.quantity?.unit === "credits";
}

function isLocalPool(observation: Observation): boolean {
  return observation.window?.kind === "state";
}

function newest(observations: Observation[]): Observation {
  return [...observations].sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0];
}

// ---------------------------------------------------------------------------
// The plain (agent / pipe) form: unchanged, one line per meter
// ---------------------------------------------------------------------------

/** The short pace segment appended to a window's status line once its burn
 * rate is known: the live burn alongside the sustainable pace that would
 * exactly spend the remaining allowance by reset, so a glance says whether
 * the current rate is faster or slower than that line. Omitted entirely
 * (not "burn 0%/h") when burn itself is null -- fewer than two fresh
 * samples in the lookback, nothing to report yet. */
function paceSegment(observation: Observation): string {
  const burn = observation.burn_percent_per_hour;
  if (burn === null || burn === undefined) return "";
  const sustainable = observation.sustainable_percent_per_hour;
  const sustainableText = sustainable === null || sustainable === undefined ? "?" : formatRatePercent(sustainable);
  return ` burn ${formatRatePercent(burn)}, ok ${sustainableText}`;
}

function formatWindow(observation: Observation, state: PaceState, reason: string, resetSeen?: string, freeResetUsed?: string, reservePercent = 0, now = new Date()): string {
  if (isCredits(observation)) {
    const available = observation.quantity?.remaining ?? 0;
    const date = observation.resets_at ? new Date(observation.resets_at) : undefined;
    const expiry = date && !Number.isNaN(date.getTime()) ? ` (expires ${formatDay(observation.resets_at)})` : "";
    return `credits ${available} available${expiry}`;
  }
  // resetSeen may carry resets.ts's unscheduled marker (issue #20): a reset
  // that fired before its own scheduled instant, worth flagging inline since
  // it changes what a human or an agent reading this line should plan
  // around, not just when it happened.
  const decodedResetSeen = resetSeen ? decodeResetSeen(resetSeen) : undefined;
  const evidence = `${decodedResetSeen ? ` reset seen ${formatReset(decodedResetSeen.at, now)}${decodedResetSeen.unscheduled ? " (unscheduled)" : ""}` : ""}${freeResetUsed ? ` free reset ${formatReset(freeResetUsed, now)}` : ""}`;
  if (state === "NOT_ENFORCED") return `${label(observation)} n/a${observation.reason ? ` (${observation.reason})` : ""}`;
  if (!observation.quantity || state === "UNKNOWN") {
    // The last known reading is named "at <clock time>" here (unlike the
    // grouped view's more compact form below) because the dense form has no
    // separate column to put it in -- it all lives inside one parenthetical.
    // A windowless row's borrowed reading names its source window first
    // ("last wk 41% at ...") the same way the compact form does.
    const known = observation.last_known ? `; last ${lastKnownWindowPrefix(observation.last_known)}${Math.round(observation.last_known.used_percent)}% at ${formatClockTime(new Date(observation.last_known.observed_at))}, ${lastKnownAge(observation.last_known)} ago` : "";
    return `${label(observation)} UNKNOWN (${observation.reason ?? reason}${known})${evidence}`;
  }
  const seconds = resetsIn(observation.resets_at, now).resets_in_seconds;
  const countdown = seconds === null ? "" : ` (in ${formatResetsIn(seconds)})`;
  // A vendor-reported idle window that looks like a manufactured placeholder
  // (see engine/observation.ts's normalizeObservations) is still shown as a
  // real number -- the owner's decision is to annotate doubt, not hide the
  // vendor's own reading behind UNKNOWN.
  const doubt = observation.truth === "estimated" && observation.reason === IDLE_WINDOW_REASON ? " (idle, unverified)" : "";
  // The protected reserve (policy.toml [reserve]) follows the numbers so a
  // reader can see why a healthy-looking percentage still produced a NO from
  // gate/fill/route/can. It never changes the pace state beside it.
  return `${label(observation)} ${Math.round(observation.quantity.used)}%${reserveNote(reservePercent)} ↻${formatReset(observation.resets_at, now)}${countdown} ${state}${doubt}${evidence}${paceSegment(observation)}`;
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

export function formatMeters(observations: Observation[], policy: Policy, resetSeen = new Map<string, string>(), leases = new Map<string, Lease[]>(), freeResetUsed = new Map<string, string>(), now = new Date()): string[] {
  const meters = new Map<string, Observation[]>();
  for (const observation of observations) meters.set(observation.meter_id, [...(meters.get(observation.meter_id) ?? []), observation]);
  return [...meters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([meter, windows]) => {
    const ordered = orderWindows(windows);
    if (ordered.length === 1 && isLocalPool(ordered[0])) return formatLocal(ordered[0]);
    const active = leases.get(meter) ?? [];
    const leaseLabel = active.length ? ` leases: ${active.length} (${active.map((item) => item.owner).join(", ")})` : "";
    return `${meter}  ${ordered.map((item) => {
      const decision = paceDecision(item, policy, now);
      return formatWindow(item, decision.state, decision.reason, resetSeen.get(windowKey(item)), freeResetUsed.get(windowKey(item)), reserveFor(policy.reserve, item.meter_id), now);
    }).join(" | ")}  (${freshnessWord(ordered)} ${age(ordered[0], now)})${leaseLabel}`;
  });
}

// ---------------------------------------------------------------------------
// UNKNOWN, in plain words
// ---------------------------------------------------------------------------

export interface UnknownExplanation {
  /** A two- or three-word category, reused verbatim in the footer. */
  cause: string;
  /** One sentence saying why, then what to do about it when there is a fix. */
  text: string;
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/[;:,]+$/, "");
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Turns an adapter's terse `reason` into something a person can act on. The
 * vendor reasons are already honest, they are just written for a log line:
 * "Keychain grant needed; run: headroom keychain grant --principal x" says
 * nothing about what a Keychain grant is, or why a number is missing.
 */
export function explainUnknown(reason: string | null | undefined): UnknownExplanation {
  const text = (reason ?? "no reading").trim();
  const remedy = /run:?\s+(headroom [^.;]+?)\s*$/i.exec(text);
  const body = remedy ? text.slice(0, remedy.index).replace(/[;:,\s]+$/, "") : text;
  const withRemedy = (why: string): string => remedy ? `${sentence(why)} Run: ${remedy[1].trim()}` : sentence(why);
  if (/^keychain grant needed/i.test(text)) return { cause: "grant needed", text: withRemedy("macOS has not let Headroom read this account's credentials yet") };
  if (/^keychain grant lapsed/i.test(text)) return { cause: "grant lapsed", text: withRemedy(`the Keychain grant lapsed: ${body.replace(/^keychain grant lapsed;?\s*/i, "")}`) };
  if (/^no daemon/i.test(text)) return { cause: "no daemon", text: withRemedy(body.replace(/^no daemon;?\s*/i, "the daemon is not running, and ")) };
  if (/^stale/i.test(text)) return { cause: "stale", text: `the last reading is older than the staleness limit, so Headroom will not report it as fact (${body}). Run: headroom --refresh` };
  if (/^no readings for/i.test(text)) return { cause: "never read", text: `${sentence(body)} Run: headroom --refresh` };
  return { cause: "read failed", text: withRemedy(body) };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const ANSI = { reset: "\u001b[0m", green: "\u001b[32m", yellow: "\u001b[33m", red: "\u001b[31m", dim: "\u001b[2m" };

function stateColor(state: string): string | undefined {
  if (state === "HARVEST" || state === "NORMAL" || state === "UP") return ANSI.green;
  if (state === "CONSERVE" || state === "BUSY") return ANSI.yellow;
  if (state === "FREEZE" || state === "DOWN") return ANSI.red;
  if (state === "UNKNOWN" || state === "not enforced") return ANSI.dim;
  return undefined;
}

/** Colour is applied only after a line has been measured and clamped, so an
 * escape sequence never counts toward the terminal width and never gets cut
 * in half by a truncation. */
function colorizeState(line: string, state: string, color: boolean): string {
  const code = stateColor(state);
  if (!color || !state || !code || !line.endsWith(state)) return line;
  return `${line.slice(0, line.length - state.length)}${code}${state}${ANSI.reset}`;
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

export type StatusForm = "grouped" | "plain";

export interface StatusViewOptions {
  form: StatusForm;
  verbose: boolean;
  color: boolean;
  width: number;
  /** Whether the readings came from a one-shot direct read (no daemon). */
  direct: boolean;
}

export const STATUS_VIEW_FLAGS = ["--human", "--plain", "--agent", "--verbose", "-v", "--color", "--no-color"] as const;

/** The widest line the grouped form is allowed to produce when the terminal
 * width is unknown (a pipe, a CI log). Wide enough for a real principal and
 * meter name, narrow enough to survive a side-by-side diff. */
export const DEFAULT_STATUS_WIDTH = 100;

/**
 * The view is human-first only when a person is actually looking: stdout a
 * TTY, or `--human` asked for it. Everything else -- a pipe, a redirect, an
 * agent shelling out -- gets the dense form, which is also what `--agent`
 * and `--plain` name explicitly.
 */
export function statusViewOptions(argv: string[], isTty: boolean, environment: NodeJS.ProcessEnv = process.env, columns?: number): Omit<StatusViewOptions, "direct"> {
  const dense = argv.includes("--plain") || argv.includes("--agent");
  const human = argv.includes("--human");
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  if (dense && human) throw new Error("--human cannot be combined with --plain/--agent");
  if (dense && verbose) throw new Error("--verbose is a --human view flag; --plain/--agent print the dense one-line form");
  const form: StatusForm = dense ? "plain" : human || verbose || isTty ? "grouped" : "plain";
  const noColor = (environment.NO_COLOR ?? "") !== "";
  const width = Math.max(40, columns !== undefined && Number.isFinite(columns) ? columns : DEFAULT_STATUS_WIDTH);
  // --no-color is the one flag nothing overrides; --color beats NO_COLOR,
  // matching how `headroom statusline --render` already reads the two.
  const color = argv.includes("--no-color") ? false : argv.includes("--color") || (isTty && !noColor);
  return { form, verbose, color: form === "grouped" && color, width };
}

// ---------------------------------------------------------------------------
// The grouped (human) form
// ---------------------------------------------------------------------------

export interface StatusViewInput {
  observations: Observation[];
  policy: Policy;
  resetSeen?: Map<string, string>;
  freeResetUsed?: Map<string, string>;
  leases?: Map<string, Lease[]>;
  /** principal id -> vendor, from accounts.toml. Falls back to the vendor
   * implied by an observation's `source` when a principal is missing. */
  vendors?: Map<string, string>;
  now?: Date;
}

const SOURCE_VENDORS: Record<string, string> = { codexbar: "codex", "claude-statusline": "claude", paste: "claude", local: "local" };

function vendorOf(observations: Observation[], vendors: Map<string, string> | undefined): string {
  const named = vendors?.get(observations[0].principal_id);
  if (named) return named;
  const bare = observations[0].source.replace(/^(?:native|remote|engine):/, "").split(":")[0];
  return SOURCE_VENDORS[bare] ?? bare;
}

function planOf(observations: Observation[]): string | undefined {
  for (const item of observations) if (item.metadata?.plan) return item.metadata.plan;
  return undefined;
}

function shortMeter(observation: Observation): string {
  const prefix = `${observation.principal_id}:`;
  return observation.meter_id.startsWith(prefix) ? observation.meter_id.slice(prefix.length) : observation.meter_id;
}

/** One rendered window: the four columns plus whatever belongs underneath it.
 * `text` replaces all four for a meter with nothing to pace -- a credit
 * balance has no percentage, no pace state and no window to reset. */
interface Row {
  meter: string;
  text?: string;
  window: string;
  used: string;
  reset: string;
  resetCoarse: string;
  state: string;
  detail: string[];
  unknown?: UnknownExplanation;
  lease?: string;
}

function usedCell(observation: Observation, state: PaceState): string {
  if (state === "NOT_ENFORCED" || state === "UNKNOWN" || !observation.quantity) return "-";
  return `${Math.round(observation.quantity.used)}% used`;
}

/** A credit balance is a count with an expiry, not a window with a pace, so
 * it gets the whole row after the meter name instead of the four columns. */
function creditsCell(observation: Observation): string {
  const available = observation.quantity?.remaining ?? 0;
  const date = observation.resets_at ? new Date(observation.resets_at) : undefined;
  return `${available} available${date && !Number.isNaN(date.getTime()) ? `, expire ${formatDay(observation.resets_at)}` : ""}`;
}

/** Everything the default line deliberately leaves out: the reserve, the
 * exact reset time, burn against the sustainable pace, the reset evidence,
 * and the doubt marker on a vendor-reported idle window. */
function detailLine(observation: Observation, reservePercent: number, resetSeen: string | undefined, freeResetUsed: string | undefined, now: Date): string[] {
  const parts: string[] = [];
  if (observation.resets_at) parts.push(`resets at ${formatReset(observation.resets_at, now)}`);
  if (reservePercent > 0) parts.push(`reserve ${reservePercent}%`);
  const burn = observation.burn_percent_per_hour;
  if (burn !== null && burn !== undefined) {
    const sustainable = observation.sustainable_percent_per_hour;
    parts.push(`burn ${formatRatePercent(burn)}`);
    parts.push(`sustainable ${sustainable === null || sustainable === undefined ? "?" : formatRatePercent(sustainable)}`);
  }
  if (observation.empty_in_seconds !== null && observation.empty_in_seconds !== undefined) parts.push(`empty in ${formatResetsIn(observation.empty_in_seconds)}`);
  if (observation.truth === "estimated" && observation.reason === IDLE_WINDOW_REASON) parts.push("idle, unverified");
  if (resetSeen) {
    const decoded = decodeResetSeen(resetSeen);
    parts.push(`reset seen ${formatReset(decoded.at, now)}${decoded.unscheduled ? " (unscheduled)" : ""}`);
  }
  if (freeResetUsed) parts.push(`free reset ${formatReset(freeResetUsed, now)}`);
  parts.push(`${observation.truth} via ${observation.source}, read ${age(observation, now)} ago`);
  return [parts.join(", ")];
}

function wrap(text: string, width: number, indent: number): string[] {
  const room = Math.max(20, width - indent);
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) { current = word; continue; }
    if (current.length + 1 + word.length <= room) { current = `${current} ${word}`; continue; }
    lines.push(`${pad}${current}`);
    current = word;
  }
  if (current) lines.push(`${pad}${current}`);
  return lines;
}

/** A local pool has no percentage to pace, so it renders as one line naming
 * its state, its served model and its queue. */
function localLine(observation: Observation): { text: string; state: string } {
  const state = observation.metadata?.state ?? "DOWN";
  if (state === "DOWN") {
    const wake = observation.reason?.match(/(?:^|; )wake: (.+)$/)?.[1];
    // The probe's bare "down" reason only repeats the state word beside it.
    const why = wake ? `wake: ${wake}` : observation.reason === "down" ? "" : observation.reason ?? "";
    return { text: `${observation.principal_id}  DOWN${why ? `  ${why}` : ""}`, state: "DOWN" };
  }
  const model = observation.metadata?.model_ids?.[0] ?? "unknown";
  const running = observation.metadata?.running ?? observation.quantity?.used ?? 0;
  return { text: `${observation.principal_id}  ${state}  ${model}  ${running} running, ${observation.metadata?.waiting ?? 0} waiting`, state };
}

interface PrincipalBlock {
  name: string;
  local: Observation[];
  rows: Row[];
  header: string;
  unknownCount: number;
  causes: string[];
  /** Set when every UNKNOWN window under this principal is unknown for the
   * same reason, so the explanation is printed once instead of per window. */
  shared?: UnknownExplanation;
  /** One line per meter with an unscheduled reset (issue #20) still inside
   * resetSeen's own visibility window -- see buildBlocks. Printed under the
   * principal even outside --verbose, since an unscheduled reset changes
   * what a human reading this view should plan around, not just a detail. */
  notices: string[];
}

function buildBlocks(input: StatusViewInput, now: Date): PrincipalBlock[] {
  const { observations, policy } = input;
  const resetSeen = input.resetSeen ?? new Map<string, string>();
  const freeResetUsed = input.freeResetUsed ?? new Map<string, string>();
  const leases = input.leases ?? new Map<string, Lease[]>();
  const byPrincipal = new Map<string, Observation[]>();
  for (const item of observations) byPrincipal.set(item.principal_id, [...(byPrincipal.get(item.principal_id) ?? []), item]);
  return [...byPrincipal.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => {
    const local = items.filter(isLocalPool);
    const metered = items.filter((item) => !isLocalPool(item));
    const byMeter = new Map<string, Observation[]>();
    for (const item of metered) byMeter.set(item.meter_id, [...(byMeter.get(item.meter_id) ?? []), item]);
    const rows: Row[] = [];
    const explanations: UnknownExplanation[] = [];
    // One notice per meter with an unscheduled reset (issue #20) still
    // inside resetSeen's own visibility window, keyed by meter so a meter
    // with more than one windowed row (5h and weekly both carrying the
    // marker) only ever contributes its single most recent one.
    const unscheduledByMeter = new Map<string, { at: string; windowMinutes: number | null; usedPercent: number | null }>();
    for (const [meterId, windows] of [...byMeter.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ordered = orderWindows(windows);
      const active = leases.get(meterId) ?? [];
      ordered.forEach((observation, index) => {
        const decision = paceDecision(observation, policy, now);
        const seconds = resetsIn(observation.resets_at, now).resets_in_seconds;
        const countdown = seconds === null || decision.state === "UNKNOWN";
        const unknown = decision.state === "UNKNOWN" ? explainUnknown(observation.reason ?? decision.reason) : undefined;
        if (unknown) explanations.push(unknown);
        const rawResetSeen = resetSeen.get(windowKey(observation));
        const decodedResetSeen = rawResetSeen ? decodeResetSeen(rawResetSeen) : undefined;
        if (decodedResetSeen?.unscheduled) {
          const existing = unscheduledByMeter.get(meterId);
          if (!existing || Date.parse(decodedResetSeen.at) > Date.parse(existing.at)) {
            unscheduledByMeter.set(meterId, { at: decodedResetSeen.at, windowMinutes: observation.window?.minutes ?? null, usedPercent: observation.quantity?.unit === "percent" ? observation.quantity.used : null });
          }
        }
        // An UNKNOWN window has no countdown to show in the reset column, so
        // its last known reading (if any survived the 7-day lookback) takes
        // that column instead -- a trend beside the "-" used cell, not a
        // substitute for it.
        const known = decision.state === "UNKNOWN" && observation.last_known ? lastKnownCompact(observation.last_known) : "";
        rows.push({
          meter: index === 0 ? shortMeter(observation) : "",
          ...(isCredits(observation) ? { text: creditsCell(observation) } : {}),
          window: label(observation),
          used: usedCell(observation, decision.state),
          reset: countdown ? known : `resets in ${formatResetsIn(seconds as number)}`,
          resetCoarse: countdown ? known : `resets in ${formatResetsInCoarse(seconds as number)}`,
          state: isCredits(observation) ? "" : decision.state === "NOT_ENFORCED" ? "not enforced" : decision.state,
          detail: detailLine(observation, reserveFor(policy.reserve, observation.meter_id), resetSeen.get(windowKey(observation)), freeResetUsed.get(windowKey(observation)), now),
          unknown,
          // The lease belongs to the meter, not to one of its windows, so it
          // is attached to the meter's last row and printed once.
          lease: index === ordered.length - 1 && active.length ? `held by ${active.map((item) => item.owner).join(", ")}` : undefined,
        });
      });
    }
    const plan = planOf(items);
    const header = metered.length ? `${name}  ${vendorOf(items, input.vendors)}${plan ? `  ${plan}` : ""}  ${freshnessWord(metered)} ${age(newest(metered), now)}` : "";
    const shared = explanations.length > 1 && new Set(explanations.map((item) => item.text)).size === 1 ? explanations[0] : undefined;
    const notices = [...unscheduledByMeter.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([meterId, notice]) =>
      `Unscheduled reset on ${meterId} at ${formatClockTime(new Date(notice.at))}: the ${windowNoun(notice.windowMinutes)} is back to ${notice.usedPercent === null ? "0" : Math.round(notice.usedPercent)}%, plan again.`);
    return { name, local, rows, header, unknownCount: explanations.length, causes: [...new Set(explanations.map((item) => item.cause))], shared, notices };
  });
}

/** The one-line summary under everything: how much was read, how much of it
 * is unusable and why, and where the numbers came from. */
function footer(blocks: PrincipalBlock[], direct: boolean, observations: Observation[], now: Date): string {
  const parts = [`${blocks.length} principal${blocks.length === 1 ? "" : "s"}`];
  const unknownCount = blocks.reduce((sum, block) => sum + block.unknownCount, 0);
  if (unknownCount) parts.push(`${unknownCount} UNKNOWN (${[...new Set(blocks.flatMap((block) => block.causes))].join(", ")})`);
  if (direct) parts.push("direct read, no daemon");
  else if (!observations.length) parts.push("no readings yet");
  else parts.push(`daemon fresh ${age(newest(observations), now)} ago`);
  return parts.join(", ");
}

function groupedLines(input: StatusViewInput, options: StatusViewOptions): string[] {
  const now = input.now ?? new Date();
  const blocks = buildBlocks(input, now);
  const rows = blocks.flatMap((block) => block.rows);
  const indent = 2;
  const gap = 2;
  // A free-text row spans the columns rather than filling them, so it never
  // widens them: one long credit expiry used to push every percentage right.
  const columned = rows.filter((row) => row.text === undefined);
  const windowWidth = Math.max(0, ...columned.map((row) => row.window.length));
  const usedWidth = Math.max(0, ...columned.map((row) => row.used.length));
  const stateWidth = Math.max(0, ...columned.map((row) => row.state.length));
  const resetWidth = (useCoarse: boolean): number => Math.max(0, ...columned.map((row) => (useCoarse ? row.resetCoarse : row.reset).length));
  const total = (meters: number, resets: number): number => indent + meters + gap + windowWidth + gap + usedWidth + gap + resets + gap + stateWidth;
  // Widths adapt to the terminal: the countdown drops to its single largest
  // unit first (it is the least load-bearing column), then the meter-name
  // column gives up characters, before anything is truncated outright.
  let meterWidth = Math.max(0, ...rows.map((row) => row.meter.length));
  const coarse = total(meterWidth, resetWidth(false)) > options.width;
  const resets = resetWidth(coarse);
  if (total(meterWidth, resets) > options.width) meterWidth = Math.max(4, meterWidth - (total(meterWidth, resets) - options.width));
  const clamp = (line: string): string => line.length <= options.width ? line : line.slice(0, options.width);

  const blockLines = blocks.map((block) => {
    const lines: string[] = [];
    for (const observation of block.local) {
      const local = localLine(observation);
      lines.push(colorizeState(clamp(local.text), local.state, options.color));
      if (options.verbose) lines.push(...wrap(`${observation.truth} via ${observation.source}, read ${age(observation, now)} ago`, options.width, indent));
    }
    if (!block.rows.length) return lines;
    // The header's own spacing is load-bearing (it separates name, vendor,
    // plan and freshness), so it is wrapped only when it genuinely does not
    // fit -- a narrow terminal costs it a line break, never a cut-off name.
    lines.push(...(block.header.length <= options.width ? [block.header] : wrap(block.header, options.width, 0)));
    for (const row of block.rows) {
      const meter = row.meter.length > meterWidth ? row.meter.slice(0, meterWidth) : row.meter.padEnd(meterWidth);
      const cells = row.text === undefined
        ? [`${" ".repeat(indent)}${meter}`, row.window.padEnd(windowWidth), row.used.padStart(usedWidth), (coarse ? row.resetCoarse : row.reset).padEnd(resets), row.state]
        : [`${" ".repeat(indent)}${meter}`, row.text];
      lines.push(colorizeState(clamp(cells.join(" ".repeat(gap)).replace(/\s+$/, "")), row.state, options.color));
      if (options.verbose) for (const detail of row.detail) lines.push(...wrap(detail, options.width, indent + 4));
      if (!block.shared && row.unknown) lines.push(...wrap(`UNKNOWN: ${row.unknown.text}`, options.width, indent + 4));
      if (row.lease) lines.push(...wrap(row.lease, options.width, indent + 4));
    }
    // Printed once per principal rather than once per window: the dense form
    // repeats an identical reason on every meter, which is the noise this
    // view exists to remove.
    if (block.shared) lines.push(...wrap(`UNKNOWN: ${block.shared.text}`, options.width, indent));
    // An unscheduled reset (issue #20) changes what a human reading this
    // view should plan around, so it gets its own line under the principal
    // even outside --verbose, unlike the reset-seen detail wrap() folds into
    // --verbose above.
    for (const notice of block.notices) lines.push(...wrap(notice, options.width, indent));
    return lines;
  }).filter((lines) => lines.length);

  const body = blockLines.flatMap((lines, index) => index === 0 ? lines : ["", ...lines]);
  return [...body, ...(body.length ? [""] : []), ...wrap(footer(blocks, options.direct, input.observations, now), options.width, 0)];
}

/** The entry point cli.ts calls: one array of ready-to-print lines, in
 * whichever form the options selected. */
export function renderStatus(input: StatusViewInput, options: StatusViewOptions): string[] {
  if (options.form === "plain") return formatMeters(input.observations, input.policy, input.resetSeen, input.leases, input.freeResetUsed, input.now ?? new Date());
  return groupedLines(input, options);
}
