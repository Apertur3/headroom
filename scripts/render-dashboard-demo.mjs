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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const htmlArg = args.indexOf("--html");
const keepHtml = htmlArg >= 0 ? resolve(args[htmlArg + 1] ?? "") : undefined;
const pngPath = join(root, "docs", "assets", "dashboard.png");

const { HeadroomStore } = await import(join(root, "dist", "store.js"));

// Deterministic noise (mulberry32), so the picture does not change per run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;
const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const POLL = 10 * 60_000;
const SPAN = 3 * 24 * HOUR;

const home = mkdtempSync(join(tmpdir(), "headroom-demo-"));
try {
  const env = { ...process.env, HEADROOM_HOME: home, TZ: "UTC" };
  process.env.HEADROOM_HOME = home;

  writeFileSync(join(home, "accounts.toml"), [
    '[[accounts]]', 'name = "claude-main"', 'vendor = "claude"', 'location = "~/.claude"', 'adapter = "native-ts"', "",
    '[[accounts]]', 'name = "codex-main"', 'vendor = "codex"', 'location = "~/.codex"', 'adapter = "native-ts"', "",
    '[[accounts]]', 'name = "gpu-box"', 'kind = "local"', 'base_url = "http://192.0.2.20:8000"', 'adapter = "native"', "",
  ].join("\n"), { mode: 0o600 });

  const store = await HeadroomStore.open(home);
  const base = {
    truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "demo", upstream_schema_version: "demo",
  };
  const percent = (used) => ({ used: Math.round(used * 10) / 10, limit: 100, remaining: Math.round((100 - used) * 10) / 10, unit: "percent" });

  /**
   * One percent meter over three days. `resetAt` is the end of the window
   * that contains `now`; `burst(t, random)` gives the usage reached by fraction
   * `t` (0..1) of a window.
   */
  function series({ principal, meter, source, plan, windowMinutes, kind, resetAt, burst, seed }) {
    const random = rng(seed);
    const windowMs = windowMinutes * 60_000;
    for (let at = now.getTime() - SPAN; at <= now.getTime(); at += POLL) {
      // The window holding `at` ends on the same grid as `resetAt`.
      const windowEnd = resetAt - Math.floor((resetAt - at - 1) / windowMs) * windowMs;
      const start = windowEnd - windowMs;
      const t = (at - start) / windowMs;
      const level = burst(t, random);
      const stamp = new Date(at).toISOString();
      store.insert({
        ...base, principal_id: principal, meter_id: meter, source,
        window: { kind, minutes: windowMinutes, enforcement: "hard" },
        quantity: percent(level), resets_at: new Date(windowEnd).toISOString(),
        observed_at: stamp, fetched_at: stamp, metadata: { plan },
      });
    }
  }

  // A rising curve with small steps, restarted each window. `final` is the usage
  // reached at the end of a full window; the current window is cut off at `now`.
  const ramp = (final, jitter) => (t, random) => Math.min(99, Math.max(0, final * Math.pow(t, 1.15) + (random() - 0.5) * jitter));
  const reset5h = (hoursFromNow) => now.getTime() + hoursFromNow * HOUR;
  const resetWeek = now.getTime() + 2.4 * 24 * HOUR;

  series({ principal: "claude-main", meter: "claude-main:all", source: "native:claude", plan: "Max 20x", windowMinutes: 300, kind: "rolling", resetAt: reset5h(3.2), burst: ramp(58, 6), seed: 11 });
  series({ principal: "claude-main", meter: "claude-main:all", source: "native:claude", plan: "Max 20x", windowMinutes: 10_080, kind: "fixed", resetAt: resetWeek, burst: ramp(46, 2), seed: 12 });
  series({ principal: "codex-main", meter: "codex-main:main", source: "native:codex", plan: "Plus", windowMinutes: 300, kind: "fixed", resetAt: reset5h(1.4), burst: ramp(88, 7), seed: 21 });
  series({ principal: "codex-main", meter: "codex-main:main", source: "native:codex", plan: "Plus", windowMinutes: 10_080, kind: "fixed", resetAt: now.getTime() + 1.1 * 24 * HOUR, burst: ramp(82, 2), seed: 22 });

  const stamp = now.toISOString();
  store.insert({
    ...base, principal_id: "gpu-box", meter_id: "gpu-box:capacity", source: "native:local",
    window: { kind: "state", minutes: null, enforcement: "soft" },
    quantity: { used: 0, limit: null, remaining: null, unit: "requests" }, resets_at: null,
    observed_at: stamp, fetched_at: stamp,
    metadata: { state: "UP", model_ids: ["local-27b"], running: 1, waiting: 0 },
  });
  store.close();

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
