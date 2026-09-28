/**
 * Safe, targeted edits to policy.toml's reserve-related keys: the dated
 * `[reserve."<meter>"]` sub-tables, the plain bare `[reserve]` entries, and
 * `freeze_reserve_pct`'s own optional `[freeze_reserve]` metadata table.
 * Deliberately NOT a general TOML writer -- like policy.ts's own reader,
 * this only ever touches the handful of keys `headroom policy set/clear`
 * exposes, and always by name: every other line (comments, [notify], the
 * rest of [reserve], anything else) survives untouched, in place.
 */
import type { ReserveEntry } from "./policy.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Double-quoted, JSON-escaped -- the same quoting parsePolicy's own regexes
 * (`"([^"\\]+)"`) expect for a meter id or a `"*"` default key. */
function quoteTomlKey(key: string): string {
  return JSON.stringify(key);
}

function toLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function fromLines(lines: string[], newline: string): string {
  return lines.length ? lines.join(newline) + newline : "";
}

const ANY_HEADER_RE = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;

interface SectionRange { header: number; bodyStart: number; bodyEnd: number; }

/** Locates a section by its EXACT rendered name (`"reserve"`,
 * `"freeze_reserve"`) -- body runs until the next `[...]` header or EOF. */
function findNamedSection(lines: string[], name: string): SectionRange | undefined {
  const headerRe = new RegExp(`^\\s*\\[${escapeRegExp(name)}\\]\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_HEADER_RE.test(lines[end])) end += 1;
    return { header: i, bodyStart: i + 1, bodyEnd: end };
  }
  return undefined;
}

/** Locates `[reserve."<meter>"]` (or the bare-word form, when the meter id
 * happens to be a plain word) -- a sibling of `[reserve]`, never nested in it. */
function findReserveEntrySection(lines: string[], meter: string): SectionRange | undefined {
  const escaped = escapeRegExp(meter);
  const headerRe = new RegExp(`^\\s*\\[reserve\\.(?:"${escaped}"|${escaped})\\]\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_HEADER_RE.test(lines[end])) end += 1;
    return { header: i, bodyStart: i + 1, bodyEnd: end };
  }
  return undefined;
}

/** Removes this meter's own plain `"<meter>" = N` line from inside `[reserve]`
 * (if any), so `policy set reserve` never leaves a stale bare entry
 * shadowing (or shadowed by) the fresh dated one it writes. Every other line
 * of `[reserve]` -- other meters, `"*"`, comments -- is untouched. */
function removeBareReserveLine(lines: string[], meter: string): string[] {
  const section = findNamedSection(lines, "reserve");
  if (!section) return lines;
  const keyRe = new RegExp(`^\\s*(?:"${escapeRegExp(meter)}"|${escapeRegExp(meter)})\\s*=`);
  const kept = lines.slice(section.bodyStart, section.bodyEnd).filter((line) => !keyRe.test(line.replace(/#.*/, "")));
  return [...lines.slice(0, section.bodyStart), ...kept, ...lines.slice(section.bodyEnd)];
}

function renderReserveEntryLines(entry: ReserveEntry): string[] {
  const lines = [`percent = ${entry.percent}`];
  if (entry.reason !== undefined) lines.push(`reason = ${JSON.stringify(entry.reason)}`);
  if (entry.set_at !== undefined) lines.push(`set_at = ${JSON.stringify(entry.set_at)}`);
  if (entry.until !== undefined) lines.push(`until = ${JSON.stringify(entry.until)}`);
  if (entry.unless !== undefined) lines.push(`unless = ${JSON.stringify(entry.unless)}`);
  return lines;
}

/** Upserts a dated/reasoned `[reserve."<meter>"]` table: replaces its body in
 * place if the section already exists (keeping its own header line and
 * everything else in the file untouched), otherwise appends a new section
 * at the end. Also strips any plain bare-form line for the same meter out of
 * `[reserve]`, so the two forms never silently disagree. */
export function upsertReserveEntry(original: string, meter: string, entry: ReserveEntry): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let lines = removeBareReserveLine(toLines(original), meter);
  const range = findReserveEntrySection(lines, meter);
  const body = renderReserveEntryLines(entry);
  const headerLine = `[reserve.${quoteTomlKey(meter)}]`;
  lines = range
    ? [...lines.slice(0, range.bodyStart), ...body, ...lines.slice(range.bodyEnd)]
    : [...(lines.length && lines[lines.length - 1] !== "" ? [...lines, ""] : lines), headerLine, ...body];
  return fromLines(lines, newline);
}

/** Removes a meter's reserve entirely: both the bare `[reserve]` line and
 * any dated `[reserve."<meter>"]` sub-table, whichever (or both) exist.
 * Every other key and comment in the file is untouched. */
export function clearReserveEntry(original: string, meter: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let lines = removeBareReserveLine(toLines(original), meter);
  const range = findReserveEntrySection(lines, meter);
  if (range) lines = [...lines.slice(0, range.header), ...lines.slice(range.bodyEnd)];
  return fromLines(lines, newline);
}

function findRootScalarLine(lines: string[], key: string): number | undefined {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i].replace(/#.*/, ""))) return i;
  return undefined;
}

/** Updates the plain `freeze_reserve_pct = N` line in place (or inserts it at
 * the top of the file when absent), and, only when `meta` is given, upserts
 * its own `[freeze_reserve]` metadata table (reason/set_at/until) the same
 * way upsertReserveEntry does for a per-meter one. Omitting `meta` leaves
 * whatever `[freeze_reserve]` table already exists untouched -- a bare
 * `policy set freeze_reserve_pct <n>` with no --reason/--until never erases
 * an earlier one. */
export function setFreezeReservePct(original: string, percent: number, meta?: { reason?: string; set_at?: string; until?: string }): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let lines = toLines(original);
  const existing = findRootScalarLine(lines, "freeze_reserve_pct");
  const newLine = `freeze_reserve_pct = ${percent}`;
  lines = existing !== undefined ? [...lines.slice(0, existing), newLine, ...lines.slice(existing + 1)] : [newLine, ...lines];
  if (meta) {
    const body: string[] = [];
    if (meta.reason !== undefined) body.push(`reason = ${JSON.stringify(meta.reason)}`);
    if (meta.set_at !== undefined) body.push(`set_at = ${JSON.stringify(meta.set_at)}`);
    if (meta.until !== undefined) body.push(`until = ${JSON.stringify(meta.until)}`);
    const range = findNamedSection(lines, "freeze_reserve");
    lines = range
      ? [...lines.slice(0, range.bodyStart), ...body, ...lines.slice(range.bodyEnd)]
      : [...(lines.length && lines[lines.length - 1] !== "" ? [...lines, ""] : lines), "[freeze_reserve]", ...body];
  }
  return fromLines(lines, newline);
}

/** `+<n><unit>` (m/h/d/w, relative to `now`) or a plain ISO instant/date.
 * Thrown message matches --until's usage across the other reserve-editing
 * flags. */
export function parseUntil(value: string, now: Date): string {
  const relative = /^\+([0-9]+)(m|h|d|w)$/.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "m" ? 60_000 : relative[2] === "h" ? 3_600_000 : relative[2] === "d" ? 86_400_000 : 604_800_000;
    return new Date(now.getTime() + amount * unitMs).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`--until must be an ISO instant, a date, or a relative duration like +7d: ${value}`);
  return new Date(parsed).toISOString();
}
