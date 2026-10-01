#!/usr/bin/env node
// Regenerates the README hero banners (docs/assets/hero-light.svg and
// hero-dark.svg), the social card (docs/assets/social-card.svg) and the
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
const TAGLINE = "Your agents check the meter before they spend it.";
const MARK = (stroke, accent) => `<g stroke="${stroke}" stroke-width="7" stroke-linecap="round" fill="none">
    <line x1="10" y1="12" x2="54" y2="12" stroke="${accent}"/>
    <line x1="18" y1="24" x2="18" y2="56"/>
    <line x1="46" y1="24" x2="46" y2="56"/>
    <line x1="18" y1="42" x2="46" y2="42"/>
  </g>`;

function hero({ ink, sub, accent }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 120" width="760" height="120" role="img" aria-label="Headroom: ${TAGLINE}">
  <g transform="translate(236,8) scale(1.1)">${MARK(ink, accent)}</g>
  <text x="312" y="58" fill="${ink}" font-family="${FONT}" font-size="48" font-weight="600" letter-spacing="-1">headroom</text>
  <text x="380" y="100" fill="${sub}" font-family="${FONT}" font-size="19" text-anchor="middle">${TAGLINE}</text>
</svg>
`;
}

const card = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">
  <rect width="1280" height="640" fill="#0d1117"/>
  <g transform="translate(120,150) scale(3.4)">${MARK("#e6edf3", "#f0883e")}</g>
  <text x="380" y="300" fill="#e6edf3" font-family="${FONT}" font-size="120" font-weight="600" letter-spacing="-2">headroom</text>
  <text x="384" y="370" fill="#9da7b3" font-family="${FONT}" font-size="36">${TAGLINE}</text>
  <text x="384" y="430" fill="#9da7b3" font-family="${MONO}" font-size="28">can / gate / route, from your real plan limits</text>
  <text x="384" y="480" fill="#6e7681" font-family="${MONO}" font-size="24">Claude  Codex  Antigravity  Grok  Kimi  local pools</text>
</svg>
`;

writeFileSync(join(assets, "hero-light.svg"), hero({ ink: "#1f2328", sub: "#59636e", accent: "#d1570a" }));
writeFileSync(join(assets, "hero-dark.svg"), hero({ ink: "#e6edf3", sub: "#9da7b3", accent: "#f0883e" }));
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
