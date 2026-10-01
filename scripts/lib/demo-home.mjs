// Builds a throwaway Headroom home full of SYNTHETIC data: invented accounts
// (claude-main, codex-main, gpu-box), three days of generated readings, and a
// small policy and routing config. Used by the demo screenshot, the terminal
// demo card and the examples/ scripts. Nothing here reads a real home, a
// credential or the network (the examples use only cached reads: `can`,
// `gate`, `dashboard`; `headroom status` would try to poll the fake logins).
// Needs `npm run build` first (it imports dist/).
//
// The story it tells: claude-main has plenty left; codex-main is early in its
// week and already well ahead of an even pace, so `can codex-build` says NO
// and an agent should fall back to claude or wait.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
const POLL = 10 * 60_000;
const SPAN = 3 * 24 * HOUR;

export async function seedDemoHome(home, now = new Date(Math.floor(Date.now() / 60_000) * 60_000)) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.HEADROOM_HOME = home;
  // The examples/ scripts refuse to run unless this marker is present, so they
  // can never be pointed at a real home by accident.
  writeFileSync(join(home, ".headroom-demo-home"), "synthetic data; safe for examples/\n");
  const { HeadroomStore } = await import(join(root, "dist", "store.js"));

  // The credential locations point at directories that do not exist, so even
  // a command that polls can never reach a real login on this machine.
  writeFileSync(join(home, "accounts.toml"), [
    '[[accounts]]', 'name = "claude-main"', 'vendor = "claude"', `location = "${join(home, "no-login", ".claude")}"`, 'adapter = "native-ts"', "",
    '[[accounts]]', 'name = "codex-main"', 'vendor = "codex"', `location = "${join(home, "no-login", ".codex")}"`, 'adapter = "native-ts"', "",
    '[[accounts]]', 'name = "gpu-box"', 'kind = "local"', 'base_url = "http://192.0.2.20:8000"', 'adapter = "native"', "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(home, "routing.toml"), [
    "[consumes]",
    'claude-heavy = ["claude-main:all"]',
    'codex-build = ["codex-main:main"]',
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(home, "policy.toml"), "update_check = false\nantigravity_keepalive = false\n", { mode: 0o600 });

  const store = await HeadroomStore.open(home);
  const base = { truth: "official", freshness: "fresh", confidence: 1, adapter_version: "demo", upstream_schema_version: "demo" };
  const percent = (used) => ({ used: Math.round(used * 10) / 10, limit: 100, remaining: Math.round((100 - used) * 10) / 10, unit: "percent" });

  /** One percent meter over three days. `resetAt` ends the window that contains
   * `now`; `usageAt(t, random)` is the usage reached at fraction `t` (0..1) of
   * a window; `jitter` adds small deterministic noise. */
  function series({ principal, meter, source, plan, windowMinutes, kind, resetAt, nowUsage, jitter, seed }) {
    const random = rng(seed);
    const windowMs = windowMinutes * 60_000;
    const tNow = 1 - (resetAt - now.getTime()) / windowMs;
    for (let at = now.getTime() - SPAN; at <= now.getTime(); at += POLL) {
      const windowEnd = resetAt - Math.floor((resetAt - at - 1) / windowMs) * windowMs;
      const t = (at - (windowEnd - windowMs)) / windowMs;
      // Usage grows with the window and hits `nowUsage` at the current point of
      // the current window; earlier windows follow the same shape, capped.
      const level = Math.min(90, Math.max(0, nowUsage * Math.pow(t / tNow, 1.1) + (random() - 0.5) * jitter));
      const stamp = new Date(at).toISOString();
      store.insert({
        ...base, principal_id: principal, meter_id: meter, source,
        window: { kind, minutes: windowMinutes, enforcement: "hard" },
        quantity: percent(at === now.getTime() ? nowUsage : level), resets_at: new Date(windowEnd).toISOString(),
        observed_at: stamp, fetched_at: stamp, metadata: { plan },
      });
    }
  }

  const n = now.getTime();
  series({ principal: "claude-main", meter: "claude-main:all", source: "native:claude", plan: "Max 20x", windowMinutes: 300, kind: "rolling", resetAt: n + 3.2 * HOUR, nowUsage: 18, jitter: 4, seed: 11 });
  series({ principal: "claude-main", meter: "claude-main:all", source: "native:claude", plan: "Max 20x", windowMinutes: 10_080, kind: "fixed", resetAt: n + 2.4 * 24 * HOUR, nowUsage: 29, jitter: 1.5, seed: 12 });
  series({ principal: "codex-main", meter: "codex-main:main", source: "native:codex", plan: "Plus", windowMinutes: 300, kind: "fixed", resetAt: n + 1.4 * HOUR, nowUsage: 57, jitter: 5, seed: 21 });
  series({ principal: "codex-main", meter: "codex-main:main", source: "native:codex", plan: "Plus", windowMinutes: 10_080, kind: "fixed", resetAt: n + 5.4 * 24 * HOUR, nowUsage: 52, jitter: 1.5, seed: 22 });

  const stamp = now.toISOString();
  store.insert({
    ...base, principal_id: "gpu-box", meter_id: "gpu-box:capacity", source: "native:local",
    window: { kind: "state", minutes: null, enforcement: "soft" },
    quantity: { used: 0, limit: null, remaining: null, unit: "requests" }, resets_at: null,
    observed_at: stamp, fetched_at: stamp,
    metadata: { state: "UP", model_ids: ["local-27b"], running: 1, waiting: 0 },
  });
  store.close();
}
