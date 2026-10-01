#!/usr/bin/env node
// Regenerates docs/assets/dashboard.png, the browser dashboard shown at the top
// of the README, from SYNTHETIC data only.
//
// It builds a throwaway Headroom home with invented accounts (claude-main,
// codex-main, gpu-box) and three days of generated readings, then runs the real
// `headroom dashboard --html` against that home and screenshots the file with a
// headless Chromium-family browser. Nothing is read from your real home, your
// credentials or the network. Run `npm run build` first.
//
// Usage:
//   node scripts/render-dashboard-demo.mjs                  # writes docs/assets/dashboard.png
//   node scripts/render-dashboard-demo.mjs --html out.html  # keep the HTML, skip the screenshot
//   CHROME=/path/to/chrome node scripts/render-dashboard-demo.mjs
//
// The curves come from a fixed seed, so every run draws the same shapes;
// timestamps are relative to the moment you run it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const htmlArg = args.indexOf("--html");
const keepHtml = htmlArg >= 0 ? resolve(args[htmlArg + 1] ?? "") : undefined;
const pngPath = join(root, "docs", "assets", "dashboard.png");

const { seedDemoHome } = await import("./lib/demo-home.mjs");

const home = mkdtempSync(join(tmpdir(), "headroom-demo-"));
try {
  const env = { ...process.env, HEADROOM_HOME: home, TZ: "UTC" };

  await seedDemoHome(home);

  const out = keepHtml ?? join(home, "report.html");
  const run = spawnSync(process.execPath, [join(root, "bin", "headroom.js"), "dashboard", "--html", out, "--force"], { env, encoding: "utf8" });
  if (run.status !== 0) { console.error(run.stdout, run.stderr); process.exit(1); }
  if (keepHtml) { console.log(keepHtml); process.exit(0); }

  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const chrome = candidates.find((path) => existsSync(path));
  if (!chrome) { console.error("No Chrome or Chromium found. Set CHROME=/path/to/browser, or pass --html to keep the HTML."); process.exit(1); }
  mkdirSync(dirname(pngPath), { recursive: true });
  rmSync(pngPath, { force: true });
  // Some headless builds write the screenshot and then linger, so the run is
  // bounded by a timeout and judged by whether the file appeared.
  spawnSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    "--window-size=1280,940", "--virtual-time-budget=4000",
    `--user-data-dir=${join(home, "chrome-profile")}`, `--screenshot=${pngPath}`, `file://${out}`,
  ], { stdio: "ignore", env, timeout: 45_000, killSignal: "SIGKILL" });
  if (!existsSync(pngPath)) { console.error("The browser did not write a screenshot."); process.exit(1); }
  console.log(pngPath);
} finally {
  rmSync(home, { recursive: true, force: true });
}
