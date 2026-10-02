#!/usr/bin/env node
// Regenerates the README banners (docs/assets/banner-light.svg and
// banner-dark.svg), the social card (docs/assets/social-card.svg) and the
// 1280x640 social preview image (docs/assets/social-preview.png) from one
// definition, so wording and colours never drift apart. The PNG needs a local
// Chrome or Chromium (set CHROME to choose one); without it only the SVGs are
// written. The social preview is uploaded by hand in the repository settings.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "docs", "assets");
const FONT = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,monospace";
const TAGLINE = "A fuel gauge for AI coding agents.";
// The mark is a fuel gauge: an arc from empty (left) to full (right), a filled
// part up to the needle, tick marks and a hub. 120 x 72 box, centre (60,62).
const point = (deg, r) => [60 + r * Math.cos((deg * Math.PI) / 180), 62 - r * Math.sin((deg * Math.PI) / 180)].map((n) => n.toFixed(2));
const arc = (from, to, r) => `M${point(from, r)} A${r},${r} 0 0 1 ${point(to, r)}`;
const MARK = (ink, accent, track) => {
  const NEEDLE = 52; // degrees from the right edge: a gauge a little past half full
  const ticks = [180, 135, 90, 45, 0].map((deg) => { const [x1, y1] = point(deg, 36), [x2, y2] = point(deg, 42); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; }).join("");
  const [nx, ny] = point(NEEDLE, 40);
  return `<g fill="none" stroke-linecap="round">
    <path d="${arc(180, 0, 52)}" stroke="${track}" stroke-width="9"/>
    <path d="${arc(180, NEEDLE, 52)}" stroke="${accent}" stroke-width="9"/>
    <g stroke="${ink}" stroke-width="2.5">${ticks}</g>
    <line x1="60" y1="62" x2="${nx}" y2="${ny}" stroke="${ink}" stroke-width="5"/>
    <circle cx="60" cy="62" r="7" fill="${ink}" stroke="none"/>
  </g>`;
};

function banner({ ink, sub, accent, track, chipBg, chipLine }) {
  const chip = (x, label, dot, w) => `<g transform="translate(${x},182)"><rect width="${w}" height="34" rx="17" fill="${chipBg}" stroke="${chipLine}"/><circle cx="19" cy="17" r="5" fill="${dot}"/><text x="32" y="22.5" fill="${ink}" font-family="${MONO}" font-size="15" font-weight="700">${label}</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 240" width="900" height="240" role="img" aria-label="headroom: ${TAGLINE}">
  <g transform="translate(190,24) scale(1.3)">${MARK(ink, accent, track)}</g>
  <text x="352" y="104" fill="${ink}" font-family="${FONT}" font-size="84" font-weight="600" letter-spacing="-2">headroom</text>
  <text x="450" y="154" fill="${sub}" font-family="${FONT}" font-size="26" text-anchor="middle">${TAGLINE}</text>
  ${chip(282, "YES", "#2da44e", 92)}${chip(386, "NO", "#cf222e", 82)}${chip(480, "UNKNOWN", "#bf8700", 138)}
</svg>
`;
}

const card = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">
  <rect width="1280" height="640" fill="#0d1117"/>
  <g transform="translate(110,150) scale(2.6)">${MARK("#e6edf3", "#f0883e", "#30363d")}</g>
  <text x="440" y="300" fill="#e6edf3" font-family="${FONT}" font-size="120" font-weight="600" letter-spacing="-2">headroom</text>
  <text x="444" y="370" fill="#9da7b3" font-family="${FONT}" font-size="36">${TAGLINE}</text>
  <text x="444" y="430" fill="#9da7b3" font-family="${MONO}" font-size="28">can / gate / route, from your real plan limits</text>
  <text x="444" y="480" fill="#6e7681" font-family="${MONO}" font-size="24">Claude  Codex  Antigravity  Grok  Kimi  local pools</text>
</svg>
`;

writeFileSync(join(assets, "banner-light.svg"), banner({ ink: "#1f2328", sub: "#59636e", accent: "#d1570a", track: "#d0d7de", chipBg: "#f6f8fa", chipLine: "#d0d7de" }));
writeFileSync(join(assets, "banner-dark.svg"), banner({ ink: "#e6edf3", sub: "#9da7b3", accent: "#f0883e", track: "#30363d", chipBg: "#161b22", chipLine: "#30363d" }));
writeFileSync(join(assets, "social-card.svg"), card);

const chrome = [process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean).find((path) => existsSync(path));
if (!chrome) { console.log("SVGs written; no Chrome found, skipped social-preview.png (set CHROME)."); process.exit(0); }
const work = mkdtempSync(join(tmpdir(), "headroom-brand-"));
try {
  const png = join(assets, "social-preview.png");
  rmSync(png, { force: true });
  writeFileSync(join(work, "card.html"), `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#0d1117}svg{display:block}</style>${card}`);
  // Some headless builds write the file and then linger, so bound the run and judge by the file.
  spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,640", "--force-device-scale-factor=1",
    `--user-data-dir=${join(work, "profile")}`, `--screenshot=${png}`, `file://${join(work, "card.html")}`], { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
  if (!existsSync(png)) { console.error("The browser did not write the social preview."); process.exit(1); }
  console.log(png);
} finally { rmSync(work, { recursive: true, force: true }); }
