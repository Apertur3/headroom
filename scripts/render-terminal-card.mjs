#!/usr/bin/env node
// Regenerates docs/assets/headroom-terminal.svg from a real `headroom --json`
// run, so the README's terminal card never drifts from what the tool
// actually prints (the old hand-authored SVG shipped the "wk UNKNOWN UNKNOWN"
// duplicate-state bug fixed elsewhere in this change).
//
// Usage:
//   headroom --json | node scripts/render-terminal-card.mjs "<can-line>"
//   node scripts/render-terminal-card.mjs "<can-line>" status.json
//
// <can-line> is the plain-text line `headroom can <action> --owner <x>`
// prints (e.g. from `headroom can codex-build --owner ci`) -- routing needs
// config this script does not read, so that line is supplied verbatim rather
// than recomputed here.
//
// Pace state (HARVEST/NORMAL/CONSERVE/FREEZE/UNKNOWN) is not itself present
// in the `--json` output -- it is derived the same way the real CLI derives
// it, by importing paceDecision from the built dist/policy.js (run `npm run
// build` first). Everything else in this file is a small, dependency-free
// re-implementation of the plain-text formatting in src/cli.ts, so this
// script never needs to import the heavier compiled CLI module graph.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paceDecision, defaultPolicy } from "../dist/policy.js";

const HERO_METERS = ["claude-main:all", "codex-main:main", "codex-main:credits", "workstation:capacity", "gpu-box:capacity"];

const COLORS = {
  bg: "#0f1117", dim: "#9aa4b2", text: "#e6edf3",
  HARVEST: "#3fb950", NORMAL: "#58a6ff", CONSERVE: "#f0883e", FREEZE: "#f85149", UNKNOWN: "#d29922",
  UP: "#3fb950", BUSY: "#f0883e", DOWN: "#f85149",
};

function usage() {
  process.stderr.write("Usage: headroom --json | node scripts/render-terminal-card.mjs \"<can-line>\" [input.json]\n");
  process.exit(1);
}

function readInput(path) {
  const raw = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  return JSON.parse(raw);
}

// No credential or token field ever appears in an Observation; this masks
// the one PII-shaped thing that could still slip through free-text reason
// strings from a live vendor response.
function maskEmails(text) {
  return text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (match) => {
    const [user, domain] = match.split("@");
    return `${user[0] ?? "*"}***@${domain}`;
  });
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorize(escapedText) {
  let output = escapedText.replace(/\b(HARVEST|NORMAL|CONSERVE|FREEZE|UNKNOWN|UP|BUSY|DOWN)\b/g, (word) => `<tspan fill="${COLORS[word]}">${word}</tspan>`);
  output = output.replace(/\bn\/a\b/g, (word) => `<tspan fill="${COLORS.dim}">${word}</tspan>`);
  return output;
}

function renderLine(raw) {
  return colorize(escapeXml(maskEmails(raw)));
}

function windowLabel(observation) {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

function formatReset(value, now) {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} ${time}`;
}

function age(observation, now) {
  const milliseconds = Math.max(0, now.getTime() - new Date(observation.fetched_at).getTime());
  return milliseconds < 60_000 ? "<1m" : `${Math.floor(milliseconds / 60_000)}m`;
}

function windowOrder(observation) {
  const minutes = observation.window?.minutes;
  if (minutes === 300) return 0;
  if (minutes === 10_080) return 1;
  return 2;
}

function formatWindow(observation, now) {
  if (observation.window?.kind === "count" && observation.quantity?.unit === "credits") {
    const available = observation.quantity.remaining ?? 0;
    const date = observation.resets_at ? new Date(observation.resets_at) : undefined;
    const expiry = date && !Number.isNaN(date.getTime()) ? ` (expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)})` : "";
    return `credits ${available} available${expiry}`;
  }
  const { state, reason } = paceDecision(observation, defaultPolicy, now);
  if (state === "NOT_ENFORCED") return `${windowLabel(observation)} n/a${observation.reason ? ` (${observation.reason})` : ""}`;
  if (!observation.quantity || state === "UNKNOWN") return `${windowLabel(observation)} UNKNOWN (${observation.reason ?? reason})`;
  return `${windowLabel(observation)} ${Math.round(observation.quantity.used)}% ↻${formatReset(observation.resets_at, now)} ${state}`;
}

function formatLocal(observation) {
  const state = observation.metadata?.state ?? "DOWN";
  if (state === "DOWN") return `DOWN${observation.reason ? ` (${observation.reason})` : ""}`;
  const model = observation.metadata?.model_ids?.[0] ?? "unknown";
  return `${state} model=${model} running=${observation.metadata?.running ?? observation.quantity?.used ?? 0} waiting=${observation.metadata?.waiting ?? 0}`;
}

function meterBody(windows, leases, meterId, now) {
  if (!windows.length) return "no data in input";
  const ordered = [...windows].sort((a, b) => windowOrder(a) - windowOrder(b) || (a.window?.minutes ?? Number.MAX_SAFE_INTEGER) - (b.window?.minutes ?? Number.MAX_SAFE_INTEGER));
  if (ordered.length === 1 && ordered[0].window?.kind === "state") return formatLocal(ordered[0]);
  const enforced = ordered.filter((item) => item.freshness !== "not_enforced");
  const freshness = !enforced.length ? "not enforced" : enforced.some((item) => item.freshness === "fresh") ? "fresh" : enforced.some((item) => item.freshness === "failed") ? "failed" : "stale";
  const active = (leases ?? []).filter((lease) => lease.meter_id === meterId && !lease.ended_at);
  const leaseLabel = active.length ? ` leases: ${active.length} (${active.map((item) => item.owner).join(", ")})` : "";
  return `${ordered.map((item) => formatWindow(item, now)).join(" | ")}  (${freshness} ${age(ordered[0], now)})${leaseLabel}`;
}

/** meter-name column padded to the widest hero row, matching the hand-authored card's alignment. */
function heroLines(payload, now) {
  const byMeter = new Map();
  for (const observation of payload.observations ?? []) {
    if (!HERO_METERS.includes(observation.meter_id)) continue;
    byMeter.set(observation.meter_id, [...(byMeter.get(observation.meter_id) ?? []), observation]);
  }
  const width = Math.max(...HERO_METERS.map((meterId) => meterId.length));
  return HERO_METERS.map((meterId) => `${meterId.padEnd(width)}  ${meterBody(byMeter.get(meterId) ?? [], payload.leases, meterId, now)}`);
}

function buildSvg(lines) {
  const promptFont = 'font-family="SFMono-Regular,Menlo,Consolas,monospace" font-size="14"';
  const longest = Math.max(...lines.flatMap((line) => line.raw.split("\n")).map((line) => line.length), 40);
  const width = Math.max(900, Math.round(longest * 8.4 + 48));
  let y = 62;
  const rows = [];
  for (const line of lines) {
    if (line.kind === "prompt") rows.push(`<text x="24" y="${y}" fill="${COLORS.dim}">$ <tspan fill="${COLORS.text}">${escapeXml(line.raw)}</tspan></text>`);
    else rows.push(`<text x="24" y="${y}" fill="${COLORS.text}">${renderLine(line.raw)}</text>`);
    y += line.gapAfter ?? 26;
  }
  const height = y - 26 + 30;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${promptFont}>`,
    `  <rect width="${width}" height="${height}" rx="12" fill="${COLORS.bg}"/>`,
    `  <circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>`,
    ...rows,
    `</svg>`,
    ``,
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const canLine = args[0];
  const inputPath = args[1];
  if (!canLine) usage();
  const payload = readInput(inputPath);
  const now = new Date();
  const lines = [
    { kind: "prompt", raw: "headroom", gapAfter: 34 },
    ...heroLines(payload, now).map((raw) => ({ kind: "data", raw, gapAfter: 26 })),
    { kind: "prompt", raw: "headroom can codex-build" },
    { kind: "data", raw: canLine },
  ];
  // The last hero row's gap before the second prompt is wider (44px, set on
  // the prompt line's own gapAfter above); every other row is 26px.
  const heroCount = HERO_METERS.length;
  lines[heroCount].gapAfter = 44;
  const svg = buildSvg(lines);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "..", "docs", "assets", "headroom-terminal.svg");
  writeFileSync(out, svg);
  process.stderr.write(`wrote ${out}\n`);
}

main();
