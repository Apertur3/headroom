#!/usr/bin/env node
// Regenerates docs/assets/headroom-flow-demo.svg: a terminal window showing the
// real flow an agent follows. It seeds a synthetic Headroom home (see
// scripts/lib/demo-home.mjs), runs the real CLI against it, and draws the
// output verbatim, so the card cannot drift from what `headroom` prints.
// Run `npm run build` first.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemoHome } from "./lib/demo-home.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "headroom-demo-"));
const COMMANDS = [
  ["Agent: may I start a Codex build?", ["can", "codex-build", "--owner", "builder"]],
  ["Codex is spending ahead of its weekly pace. Try Claude:", ["can", "claude-heavy", "--owner", "builder"]],
];

try {
  await seedDemoHome(home);
  const env = { ...process.env, HEADROOM_HOME: home, TZ: "UTC" };
  const blocks = COMMANDS.map(([comment, args]) => {
    const run = spawnSync(process.execPath, [join(root, "bin", "headroom.js"), ...args], { env, encoding: "utf8" });
    // First result line only: the second line repeats it per meter.
    const line = run.stdout.split("\n").find((text) => /^(YES|NO) /.test(text));
    if (!line) throw new Error(`no YES/NO line from: headroom ${args.join(" ")}\n${run.stdout}${run.stderr}`);
    return { comment, command: `headroom ${args.join(" ")}`, line };
  });

  const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const wrap = (text, max) => {
    const words = text.split(" "); const lines = []; let current = "";
    for (const word of words) { if ((current + " " + word).trim().length > max) { lines.push(current); current = "  " + word; } else current = (current + " " + word).trim(); }
    if (current) lines.push(current);
    return lines;
  };
  const LH = 22, X = 32, MAX = 74;
  let y = 84; const body = [];
  for (const block of blocks) {
    body.push(`<text x="${X}" y="${y}" fill="#6e7681" font-size="14"># ${esc(block.comment)}</text>`); y += LH;
    wrap(`$ ${block.command}`, MAX).forEach((text, i) => { body.push(`<text x="${X}" y="${y}" fill="#e6edf3" font-size="14">${i === 0 ? `<tspan fill="#8b949e">$</tspan>${esc(text.slice(1))}` : esc(text)}</text>`); y += LH; });
    const color = block.line.startsWith("YES") ? "#3fb950" : "#f85149";
    wrap(block.line, MAX).forEach((text, i) => {
      const word = i === 0 ? text.split(" ")[0] : "";
      body.push(`<text x="${X}" y="${y}" fill="#e6edf3" font-size="14" xml:space="preserve">${i === 0 ? `<tspan fill="${color}" font-weight="700">${word}</tspan>${esc(text.slice(word.length))}` : esc(text)}</text>`); y += LH;
    });
    y += 12;
  }
  const height = y + 12;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}" viewBox="0 0 760 ${height}" role="img" aria-label="Terminal: an agent asks headroom can, is told NO for the nearly full Codex week, and falls back to Claude">
  <title>headroom can: NO for the nearly full meter, YES for the one with room</title>
  <g font-family="SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace">
    <rect x="0.5" y="0.5" width="759" height="${height - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
    <path d="M0.5 10.5a10 10 0 0 1 10-10h739a10 10 0 0 1 10 10V40H0.5z" fill="#161b22"/>
    <circle cx="24" cy="21" r="6" fill="#ff5f56"/><circle cx="44" cy="21" r="6" fill="#ffbd2e"/><circle cx="64" cy="21" r="6" fill="#27c93f"/>
    <text x="380" y="26" fill="#8b949e" font-size="12" text-anchor="middle">headroom (synthetic data)</text>
    ${body.join("\n    ")}
  </g>
</svg>
`;
  const out = join(root, "docs", "assets", "headroom-flow-demo.svg");
  writeFileSync(out, svg);
  console.log(out);
} finally {
  rmSync(home, { recursive: true, force: true });
}
