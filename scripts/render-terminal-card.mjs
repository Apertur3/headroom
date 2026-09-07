#!/usr/bin/env node
// Regenerates docs/assets/headroom-terminal.svg, the terminal card at the top
// of the README.
//
// The card is drawn from MOCK data by default -- no account of the maintainer's
// ever reaches a published asset -- and rendered through the CLI's own
// renderStatus() from dist/status-view.js, so the card cannot drift from what
// `headroom` actually prints. Run `npm run build` first.
//
// Usage:
//   node scripts/render-terminal-card.mjs                        # the mock card
//   headroom --json | node scripts/render-terminal-card.mjs "<can-line>"
//   node scripts/render-terminal-card.mjs "<can-line>" status.json
//
// <can-line> is the plain-text line `headroom can <action> --owner <x>` prints
// -- routing needs config this script does not read, so that line is supplied
// verbatim rather than recomputed here.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPolicy } from "../dist/policy.js";
import { renderStatus } from "../dist/status-view.js";

const COLORS = {
  bg: "#0f1117", dim: "#9aa4b2", text: "#e6edf3",
  HARVEST: "#3fb950", NORMAL: "#3fb950", CONSERVE: "#f0883e", FREEZE: "#f85149", UNKNOWN: "#d29922",
  UP: "#3fb950", BUSY: "#f0883e", DOWN: "#f85149",
};

const MOCK_CAN_LINE = "NO codex-main:main CONSERVE (wk 81% CONSERVE)";
const MOCK_NOW = new Date("2026-09-08T00:13:00Z");

/** Invented accounts on invented hosts: the card must never carry a real
 * principal, plan, model id or host name. */
function mockPayload() {
  const at = (minutes) => new Date(MOCK_NOW.getTime() + minutes * 60_000).toISOString();
  const sampled = new Date(MOCK_NOW.getTime() - 20_000).toISOString();
  const base = { observed_at: sampled, fetched_at: sampled, truth: "official", freshness: "fresh", confidence: 1, adapter_version: "mock", upstream_schema_version: "mock" };
  const percent = (used) => ({ used, limit: 100, remaining: 100 - used, unit: "percent" });
  return {
    observations: [
      { ...base, source: "native:claude", principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: percent(11), resets_at: at(194), metadata: { plan: "Max 20x" } },
      { ...base, source: "native:claude", principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: percent(3), resets_at: at(8054), metadata: { plan: "Max 20x" } },
      { ...base, source: "native:codex", principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: percent(81), resets_at: at(8054), metadata: { plan: "Plus" } },
      { ...base, source: "native:codex", principal_id: "codex-main", meter_id: "codex-main:credits", window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: 1, unit: "credits" }, resets_at: "2026-10-05T12:00:00Z" },
      { ...base, source: "native:local", principal_id: "gpu-box", meter_id: "gpu-box:capacity", window: { kind: "state", minutes: null, enforcement: "soft" }, quantity: { used: 0, limit: null, remaining: null, unit: "requests" }, resets_at: null, metadata: { state: "UP", model_ids: ["local-27b"], running: 0, waiting: 0 } },
    ],
    leases: [],
  };
}

function readInput(path) {
  return JSON.parse(path ? readFileSync(path, "utf8") : readFileSync(0, "utf8"));
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

function renderLine(raw) {
  let output = escapeXml(maskEmails(raw));
  output = output.replace(/\b(HARVEST|NORMAL|CONSERVE|FREEZE|UNKNOWN|UP|BUSY|DOWN)\b/g, (word) => `<tspan fill="${COLORS[word]}">${word}</tspan>`);
  return output.replace(/\bnot enforced\b/g, (word) => `<tspan fill="${COLORS.dim}">${word}</tspan>`);
}

function buildSvg(lines) {
  const promptFont = 'font-family="SFMono-Regular,Menlo,Consolas,monospace" font-size="14"';
  const longest = Math.max(...lines.map((line) => line.raw.length), 40);
  const width = Math.max(900, Math.round(longest * 8.4 + 48));
  let y = 62;
  const rows = [];
  for (const line of lines) {
    if (line.kind === "prompt") rows.push(`<text x="24" y="${y}" fill="${COLORS.dim}">$ <tspan fill="${COLORS.text}">${escapeXml(line.raw)}</tspan></text>`);
    else if (line.raw !== "") rows.push(`<text x="24" y="${y}" fill="${line.dim ? COLORS.dim : COLORS.text}" xml:space="preserve">${renderLine(line.raw)}</text>`);
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
  const canLine = args[0] ?? MOCK_CAN_LINE;
  const payload = args.length ? readInput(args[1]) : mockPayload();
  const now = args.length ? new Date() : MOCK_NOW;
  const status = renderStatus(
    { observations: payload.observations ?? [], policy: defaultPolicy, leases: new Map(), now },
    { form: "grouped", verbose: false, color: false, width: 100, direct: false },
  );
  // The footer is the last line and it summarises the whole read; on the card
  // it is the quiet line under the meters.
  const lines = [
    { kind: "prompt", raw: "headroom", gapAfter: 34 },
    ...status.map((raw, index) => ({ kind: "data", raw, dim: index === status.length - 1, gapAfter: raw === "" ? 12 : 26 })),
    { kind: "prompt", raw: "headroom can codex-build", gapAfter: 26 },
    { kind: "data", raw: canLine },
  ];
  lines[lines.length - 2].gapAfter = 26;
  lines[lines.length - 3].gapAfter = 44;
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets", "headroom-terminal.svg");
  writeFileSync(out, buildSvg(lines));
  process.stderr.write(`wrote ${out}\n`);
}

main();
