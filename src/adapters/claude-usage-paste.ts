/**
 * Claude Code's `/usage` panel, pasted in as text.
 *
 * The panel is a terminal rendering, not an API: a human can see a figure
 * Headroom cannot reach (a model-scoped weekly bar sitting at 95% while the
 * account-wide meter still looks free, say, or any window at all on a machine
 * where the probe is blocked). This adapter turns that screen into
 * observations so the number stops being trapped on it.
 *
 * The parser is deliberately forgiving, because the panel's exact text is a
 * moving target across Claude Code versions and plans: percentages may be
 * `12%` or `12% used`, on the label's own line or on a bar line under it;
 * resets may be relative (`Resets in 2h 14m`), absolute with a date
 * (`Resets Sep 13, 2:00pm`), absolute without one (`Resets at 14:00`), or
 * missing entirely; and box-drawing borders, progress bars and stray padding
 * are stripped before anything is matched. Whatever it cannot place is
 * reported back to the caller rather than silently dropped.
 *
 * Every time it reads is interpreted in the machine's LOCAL timezone. A
 * timezone annotation the panel prints in parentheses is stripped, not
 * honored, so a panel rendered against a different zone can be off by that
 * offset; the pasted reading is superseded by the next real poll anyway.
 */

import { modelSlug } from "./claude.js";
import type { Account, Observation } from "../types.js";
import { isLocalAccount } from "../types.js";

/** `source` on every observation this adapter produces: a human-mediated
 * reading, distinct from `native:claude` (the probe) and
 * `native:claude-statusline` (the snapshot file). */
export const PASTE_SOURCE = "paste";

/** The vendor's own displayed number, so `truth` stays `official`; the
 * confidence sits below a polled reading's because the panel is transcribed
 * through a screen and a human's copy buffer, and carries no machine-checked
 * timestamp of its own. */
export const PASTE_CONFIDENCE = 0.9;

const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10_080;

/** Box drawing, block elements (progress bars), geometric shapes and braille
 * spinners. Removed before any matching, so a bordered panel and a bare
 * copy-paste of the same panel parse identically. */
const DECORATION = /[\u2500-\u25FF\u2800-\u28FF]/g;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface ParsedUsageWindow {
  /** The panel's own label line, cleaned, for the caller's printed output. */
  label: string;
  /** Meter suffix: `all` for the session and the all-models week, else the
   * scoped model's slug. */
  meter: string;
  window_minutes: number;
  used_percent: number;
  resets_at: string | null;
  /** The reset text exactly as the panel worded it, or null when it had none. */
  reset_text: string | null;
}

export interface ParsedUsagePanel {
  windows: ParsedUsageWindow[];
  /** Lines that carried a percentage or a reset but could not be placed in a
   * window, plus any window label whose percentage was missing. */
  unparsed: string[];
}

function clean(line: string): string {
  return line.replace(DECORATION, " ").replace(/\s+/g, " ").trim();
}

/** A label line opens a window block: `Current session`, `Current week (all
 * models)`, `Week (Fable)`, `Session: 49% used`. */
function labelKind(line: string): "session" | "week" | undefined {
  if (/^(?:current\s+)?session\b/i.test(line)) return "session";
  if (/^(?:current\s+)?week\b/i.test(line)) return "week";
  return undefined;
}

/**
 * The meter suffix for a label's parenthesised scope, mapped exactly the way
 * claude.ts maps a `limits[]` entry's display name so a pasted reading lands
 * on the same meter the probe writes: `fable` and `routines` are named
 * families, anything else is that display name's slug. `all models` (and no
 * scope at all) is the account-wide meter. A trailing `only`, which the panel
 * uses to mean "this model's own allowance" rather than as part of the model
 * name, is dropped before slugging so `Sonnet only` and `Sonnet` are one
 * meter.
 */
export function scopeMeter(scope: string | undefined): string {
  const text = (scope ?? "").trim();
  if (!text || /^all(\s+models?)?$/i.test(text)) return "all";
  const lower = text.toLowerCase();
  if (lower.includes("fable")) return "fable";
  if (lower.includes("routine") || lower.includes("cowork")) return "routines";
  return modelSlug(text.replace(/\bonly\b/gi, " "));
}

function scopeOf(label: string): string | undefined {
  const match = /\(([^)]*)\)/.exec(label);
  return match ? match[1] : undefined;
}

function parseClock(text: string): { hours: number; minutes: number } | undefined {
  const withMinutes = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text);
  const hourOnly = /^(\d{1,2})\s*(am|pm)$/i.exec(text);
  const match = withMinutes ?? hourOnly;
  if (!match) return undefined;
  let hours = Number(match[1]);
  const minutes = withMinutes ? Number(match[2]) : 0;
  const meridiem = (withMinutes ? match[3] : match[2])?.toLowerCase();
  if (hours > 23 || minutes > 59) return undefined;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

/** `2h 14m`, `45m`, `2 hours 14 minutes`, `1d 3h`. Null when nothing in the
 * text reads as a duration at all. */
export function parseDurationMs(text: string): number | null {
  const pattern = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let total = 0;
  let seen = false;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    const unit = match[2].toLowerCase();
    const scale = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
    total += amount * scale;
    seen = true;
  }
  return seen ? Math.round(total) : null;
}

function isoOrNull(date: Date): string | null {
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

/**
 * The reset text that follows the panel's `Resets` word, resolved against
 * `now` in local time. Handles a relative countdown, an absolute clock time
 * with or without a date or weekday, and returns null for anything it cannot
 * read (including a bare date with no usable day).
 */
export function parseResetAt(text: string, now: Date): string | null {
  let value = text.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  value = value.replace(/^[:\-,]+\s*/, "").replace(/^(?:at|on)\s+/i, "").trim();
  value = value.replace(/^[()[\],.;]+/, "").replace(/[()[\],.;]+$/, "").trim();
  if (!value) return null;

  const relative = /^in\s+(.+)$/i.exec(value);
  if (relative) {
    const ms = parseDurationMs(relative[1]);
    return ms === null ? null : isoOrNull(new Date(now.getTime() + ms));
  }

  const monthFirst = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\.?,?\s*(.*)$/.exec(value);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3,9})\.?,?\s*(.*)$/.exec(value);
  const monthName = monthFirst ? monthFirst[1] : dayFirst ? dayFirst[2] : undefined;
  const monthIndex = monthName ? MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) : -1;
  if (monthIndex >= 0) {
    const day = Number(monthFirst ? monthFirst[2] : dayFirst![1]);
    const clock = parseClock((monthFirst ? monthFirst[3] : dayFirst![3]).trim()) ?? { hours: 0, minutes: 0 };
    if (day < 1 || day > 31) return null;
    let candidate = new Date(now.getFullYear(), monthIndex, day, clock.hours, clock.minutes, 0, 0);
    // A panel printed in late December naming a January reset means next
    // year; one day of slack keeps a reset that just passed in this year.
    if (candidate.getTime() < now.getTime() - 86_400_000) candidate = new Date(now.getFullYear() + 1, monthIndex, day, clock.hours, clock.minutes, 0, 0);
    return isoOrNull(candidate);
  }

  const weekday = /^([A-Za-z]{3,9})\.?,?\s*(.*)$/.exec(value);
  const weekdayIndex = weekday ? WEEKDAYS.indexOf(weekday[1].slice(0, 3).toLowerCase()) : -1;
  if (weekdayIndex >= 0) {
    const clock = parseClock(weekday![2].trim()) ?? { hours: 0, minutes: 0 };
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hours, clock.minutes, 0, 0);
    let ahead = (weekdayIndex - candidate.getDay() + 7) % 7;
    if (ahead === 0 && candidate.getTime() <= now.getTime()) ahead = 7;
    candidate.setDate(candidate.getDate() + ahead);
    return isoOrNull(candidate);
  }

  const clock = parseClock(value);
  if (clock) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hours, clock.minutes, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return isoOrNull(candidate);
  }
  return null;
}

function percentIn(line: string): number | undefined {
  const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function resetTextIn(line: string): string | undefined {
  const match = /resets?\b/i.exec(line);
  return match ? line.slice(match.index + match[0].length) : undefined;
}

/** True for a line that carries a figure worth reporting when it cannot be
 * placed: everything else in a pasted panel (headings, key hints, borders)
 * is decoration and is dropped without a warning. */
function meaningful(line: string): boolean {
  return percentIn(line) !== undefined || /resets?\b/i.test(line);
}

/**
 * Splits a pasted panel into window blocks and reads each one. A block runs
 * from a label line to the next label line, so the percentage and the reset
 * may sit on the label's own line or on any line beneath it.
 */
export function parseUsagePanel(text: string, now = new Date()): ParsedUsagePanel {
  const windows: ParsedUsageWindow[] = [];
  const unparsed: string[] = [];
  const seen = new Set<string>();
  let block: { kind: "session" | "week"; label: string; used?: number; resetText?: string } | undefined;

  const flush = (): void => {
    if (!block) return;
    const meter = scopeMeter(scopeOf(block.label));
    const minutes = block.kind === "session" ? FIVE_HOUR_MINUTES : WEEK_MINUTES;
    if (block.used === undefined || !meter) { unparsed.push(block.label); block = undefined; return; }
    const key = `${meter}:${minutes}`;
    if (seen.has(key)) { unparsed.push(block.label); block = undefined; return; }
    seen.add(key);
    const resetText = block.resetText?.trim() ? block.resetText.trim() : null;
    windows.push({ label: block.label, meter, window_minutes: minutes, used_percent: block.used, resets_at: resetText ? parseResetAt(resetText, now) : null, reset_text: resetText });
    block = undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    const kind = labelKind(line);
    if (kind) {
      flush();
      block = { kind, label: line, used: percentIn(line), resetText: resetTextIn(line) };
      continue;
    }
    if (!block) { if (meaningful(line)) unparsed.push(line); continue; }
    let used = false;
    const percent = percentIn(line);
    if (percent !== undefined && block.used === undefined) { block.used = percent; used = true; }
    const reset = resetTextIn(line);
    if (reset !== undefined && block.resetText === undefined) { block.resetText = reset; used = true; }
    if (!used && meaningful(line)) unparsed.push(line);
  }
  flush();
  return { windows, unparsed };
}

/** One observation per parsed window, shaped exactly like a polled Claude
 * reading so the store, the events, the pace states and every orchestrator
 * read treat it identically. The next successful poll supersedes it simply by
 * being newer. */
export function observationsFromUsagePaste(windows: ParsedUsageWindow[], principal: string, now = new Date()): Observation[] {
  const at = now.toISOString();
  return windows.map((item) => ({
    principal_id: principal,
    meter_id: `${principal}:${item.meter}`,
    window: { kind: item.resets_at ? "fixed" as const : "rolling" as const, minutes: item.window_minutes, enforcement: "hard" as const },
    quantity: { used: item.used_percent, limit: 100, remaining: Math.max(0, 100 - item.used_percent), unit: "percent" as const },
    resets_at: item.resets_at,
    observed_at: at,
    fetched_at: at,
    source: PASTE_SOURCE,
    truth: "official" as const,
    freshness: "fresh" as const,
    confidence: PASTE_CONFIDENCE,
    adapter_version: "native-ts",
    upstream_schema_version: "usage-panel",
    reason: "pasted from Claude Code's /usage panel",
  }));
}

/**
 * The Claude principal a pasted panel belongs to. `--principal` is required
 * whenever more than one Claude principal is configured, since a panel says
 * nothing about which login rendered it.
 */
export function resolveClaudePrincipal(accounts: Account[], requested?: string): string {
  const claude = accounts.filter((item) => !isLocalAccount(item) && item.vendor === "claude");
  if (requested) {
    if (!claude.some((item) => item.name === requested)) throw new Error(`${requested} is not a configured Claude principal`);
    return requested;
  }
  if (!claude.length) throw new Error("no Claude principal is configured; run: headroom accounts discover");
  if (claude.length > 1) throw new Error(`several Claude principals are configured; pass --principal <id> (${claude.map((item) => item.name).join(", ")})`);
  return claude[0].name;
}

/** The command that prints the clipboard on this platform, or an error naming
 * what to install. Nothing here is run through a shell. */
export function clipboardCommand(platform: NodeJS.Platform, present: (name: string) => boolean): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "pbpaste", args: [] };
  if (platform === "win32") return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"] };
  if (present("xclip")) return { command: "xclip", args: ["-selection", "clipboard", "-o"] };
  if (present("wl-paste")) return { command: "wl-paste", args: ["--no-newline"] };
  throw new Error("--clipboard needs xclip or wl-paste on this platform; pipe the panel into `headroom usage --paste` instead");
}
