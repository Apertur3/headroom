#!/usr/bin/env node
// Regenerates docs/assets/headroom-demo.svg: an animated terminal showing the
// flow an agent follows (ask `can`, get NO, ask the next class, get YES, run a
// job under a reservation). It seeds a synthetic Headroom home (see
// scripts/lib/demo-home.mjs), runs the real CLI against it and draws the
// output verbatim, so the card cannot drift from what `headroom` prints.
// Run `npm run build` first.
//
// The animation is plain CSS inside the SVG. A viewer that does not run it, or
// that prefers reduced motion, shows the finished terminal: that is the
// static fallback, there is no separate file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemoHome } from "./lib/demo-home.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "headroom-demo-"));
const STEPS = [
  ["An agent asks before it starts a Codex build", ["can", "codex-build", "--owner", "builder"]],
  ["Codex is ahead of its weekly pace, so try Claude", ["can", "claude-heavy", "--owner", "builder"]],
  ["Reserve the capacity, run the job, release it", ["run", "--meter", "claude-main:all", "--need", "wk:10", "--owner", "builder", "--", "echo", "ok"]],
];

try {
  await seedDemoHome(home);
  const env = { ...process.env, HEADROOM_HOME: home, TZ: "UTC" };
  const blocks = STEPS.map(([comment, args]) => {
    const run = spawnSync(process.execPath, [join(root, "bin", "headroom.js"), ...args], { env, encoding: "utf8", timeout: 20_000 });
    const lines = run.stdout.split("\n");
    // `can` prints the verdict first and repeats it per meter; keep the first line.
    const out = args[0] === "can" ? lines.find((text) => /^(YES|NO) /.test(text)) : lines.find((text) => text.trim());
    if (!out) throw new Error(`no output from: headroom ${args.join(" ")}\n${run.stdout}${run.stderr}`);
    return { comment, command: `headroom ${args.join(" ")}`, out };
  });

  const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const LH = 22, X = 28, WIDTH = 720, TOP = 146;
  const TOTAL = 17; // seconds per loop
  const pct = (seconds) => Math.round((seconds / TOTAL) * 10000) / 100;
  let y = TOP, t = 2.6; const body = [], css = [];
  let n = 0;

  const reveal = (id, start) => {
    css.push(`@keyframes ${id}{0%,${pct(start)}%{opacity:0}${pct(start + 0.15)}%,94%{opacity:1}98%,100%{opacity:0}}#${id}{animation:${id} ${TOTAL}s infinite}`);
  };
  const type = (id, start, chars) => {
    const dur = Math.max(0.5, chars * 0.035);
    css.push(`@keyframes ${id}{0%,${pct(start)}%{width:0}${pct(start + dur)}%,94%{width:${WIDTH}px}98%,100%{width:0}}#${id}-clip rect{animation:${id} ${TOTAL}s infinite steps(${chars})}`);
    return start + dur;
  };


  // Fuel gauge strip: each bar drains from full to what is left of the week, as
  // read from the real `can` output above (wk N% is the share used).
  const GAUGE_X = 236, GAUGE_W = 300;
  const fuel = [["codex-main:main", blocks[0].out, "#f0883e"], ["claude-main:all", blocks[1].out, "#3fb950"]].map(([name, line, color], i) => {
    const used = Number(/wk (\d+)%/.exec(line)?.[1]); const state = /\b(HARVEST|NORMAL|CONSERVE|FREEZE|UNKNOWN)\b/.exec(line)?.[1];
    if (!Number.isFinite(used) || !state) throw new Error(`cannot read the week from: ${line}`);
    return { name, left: 100 - used, state, color, y: 66 + i * 26 };
  });
  fuel.forEach((row, i) => {
    const id = `f${i}`, lid = `fl${i}`, w = Math.round((GAUGE_W * row.left) / 100);
    css.push(`@keyframes ${id}{0%,2%{width:${GAUGE_W}px}10%,94%{width:${w}px}98%,100%{width:${GAUGE_W}px}}#${id}{animation:${id} ${TOTAL}s infinite cubic-bezier(.2,.7,.2,1)}`);
    reveal(lid, 1.8);
    body.push(`<text x="${X}" y="${row.y + 4}" fill="#8b949e" font-size="14">${row.name} wk</text>`);
    body.push(`<rect x="${GAUGE_X}" y="${row.y - 7}" width="${GAUGE_W}" height="14" rx="7" fill="#21262d"/>`);
    body.push(`<rect id="${id}" x="${GAUGE_X}" y="${row.y - 7}" width="${w}" height="14" rx="7" fill="${row.color}"/>`);
    body.push(`<text id="${lid}" x="${GAUGE_X + GAUGE_W + 14}" y="${row.y + 4}" fill="#e6edf3" font-size="14" xml:space="preserve"><tspan font-weight="700">${row.left}% left</tspan> <tspan fill="${row.color}">${row.state}</tspan></text>`);
  });

  for (const block of blocks) {
    const cid = `c${n++}`, kid = `k${n++}`, oid = `o${n++}`;
    reveal(cid, t); body.push(`<text id="${cid}" x="${X}" y="${y}" fill="#6e7681" font-size="14"># ${esc(block.comment)}</text>`); y += LH; t += 0.5;
    const cmd = `$ ${block.command}`;
    const typed = type(kid, t, cmd.length);
    body.push(`<clipPath id="${kid}-clip"><rect x="0" y="${y - 16}" width="${WIDTH}" height="22"/></clipPath>`);
    body.push(`<text id="" x="${X}" y="${y}" fill="#e6edf3" font-size="14" clip-path="url(#${kid}-clip)" xml:space="preserve"><tspan fill="#8b949e">$</tspan>${esc(cmd.slice(1))}</text>`);
    y += LH; t = typed + 0.35;
    const verdict = block.out.split(" ")[0];
    const color = verdict === "YES" ? "#3fb950" : verdict === "NO" ? "#f85149" : "#e6edf3";
    const rest = color === "#e6edf3" ? esc(block.out) : esc(block.out.slice(verdict.length));
    reveal(oid, t);
    body.push(`<text id="${oid}" x="${X}" y="${y}" fill="#e6edf3" font-size="14" xml:space="preserve">${color === "#e6edf3" ? rest : `<tspan fill="${color}" font-weight="700">${verdict}</tspan>${rest}`}</text>`);
    y += LH + 14; t += 1.6;
  }
  if (t > TOTAL - 1) throw new Error(`timeline ${t}s does not fit the ${TOTAL}s loop`);
  const height = y + 4;
  // The clip rect needs its own animated width; give every clipPath rect the right selector.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="Terminal: an agent asks headroom can, is told NO because the Codex week is ahead of pace, is told YES for Claude, and runs a job under a reservation">
  <title>headroom can: NO for the meter that is ahead of pace, YES for the one with room</title>
  <style>
    ${css.join("\n    ")}
    @media (prefers-reduced-motion: reduce){text,rect{animation:none!important}clipPath rect{width:${WIDTH}px!important}}
  </style>
  <g font-family="SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace">
    <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
    <path d="M0.5 10.5a10 10 0 0 1 10-10h${WIDTH - 21}a10 10 0 0 1 10 10V40H0.5z" fill="#161b22"/>
    <circle cx="24" cy="21" r="6" fill="#ff5f56"/><circle cx="44" cy="21" r="6" fill="#ffbd2e"/><circle cx="64" cy="21" r="6" fill="#27c93f"/>
    <text x="${WIDTH / 2}" y="26" fill="#8b949e" font-size="12" text-anchor="middle">headroom (synthetic data)</text>
    ${body.join("\n    ").replace(/ id=""/g, "")}
  </g>
</svg>
`;
  const out = join(root, "docs", "assets", "headroom-demo.svg");
  writeFileSync(out, svg);
  console.log(out);
} finally {
  rmSync(home, { recursive: true, force: true });
}
