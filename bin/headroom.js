#!/usr/bin/env node
// Thin launcher kept separate from src/cli.ts: it must run before anything
// tries to `require("node:sqlite")`, which throws a raw stack trace on Node
// older than the version that ships that built-in unflagged. This file is
// hand-written, not compiled from src/, so it stays tiny and dependency-free.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function supportsBuiltinSqlite(version) {
  const [major, minor] = version.split(".").map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 4;
  if (major === 22) return minor >= 13;
  return false;
}

/**
 * node:sqlite is still marked experimental even on versions that ship it
 * unflagged, so every command prints an ExperimentalWarning (twice, once per
 * worker) unless it is silenced. `--disable-warning=<type>` silences only
 * that one warning type and leaves every other warning (deprecations, etc.)
 * visible; it shipped in Node 20.11/21.3, well before the 22.13/23.4 floor
 * this launcher already enforces above, so it is always available here. The
 * plain `--no-warnings=<type>` form below is kept only as a defensive
 * fallback for a hypothetical older runtime, where it silences everything
 * (Node treats `--no-warnings` as boolean and ignores the value) rather than
 * crashing on an unrecognized flag.
 */
export function warningSuppressionFlag(version) {
  const [major, minor] = version.split(".").map(Number);
  const supportsDisableWarning = major > 21 || (major === 21 && minor >= 3) || (major === 20 && minor >= 11);
  return supportsDisableWarning ? "--disable-warning=ExperimentalWarning" : "--no-warnings=ExperimentalWarning";
}

/**
 * Mirrors src/paths.ts's headroomHome() closely enough for this one lookup:
 * HEADROOM_HOME first, then the platform default. Deliberately not imported
 * from dist/ -- this launcher must keep working even when dist/ is stale or
 * absent (e.g. straight from a source checkout before a build).
 */
function headroomHome() {
  if (process.env.HEADROOM_HOME) return process.env.HEADROOM_HOME;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "headroom");
  return join(homedir(), ".headroom");
}

/**
 * A minimal, dependency-free read of just the `proxy` key from policy.toml --
 * enough to decide whether the launcher may leave ambient proxy variables in
 * place, not a full policy parse (src/policy.ts's parsePolicy does the real
 * validation once the CLI itself starts). Never throws: a missing or
 * unreadable policy.toml means no proxy is configured, the safe default.
 */
export function policyProxyConfigured(home = headroomHome()) {
  try {
    const text = readFileSync(join(home, "policy.toml"), "utf8");
    return text.split("\n").some((raw) => /^proxy\s*=\s*"[^"\\]+"\s*$/.test(raw.replace(/#.*/, "").trim()));
  } catch { return false; }
}

const PROXY_ENV_KEYS = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * Recent Node versions decide whether to install an env-driven proxy
 * dispatcher for the global fetch() from the *initial* process environment,
 * before any application code runs -- so src/security.ts's in-process
 * stripAmbientProxyEnvironment() (kept as defense in depth) is too late on
 * its own. Stripping these variables from the child's environment here,
 * before spawning node at all, means the child process never sees them in
 * the first place, unless the operator has explicitly opted in via
 * policy.toml's `proxy` key.
 */
export function childEnvironment(env = process.env, proxyConfigured = policyProxyConfigured()) {
  if (proxyConfigured) return env;
  const output = { ...env };
  for (const key of PROXY_ENV_KEYS) delete output[key];
  return output;
}

function main() {
  if (!supportsBuiltinSqlite(process.versions.node)) {
    process.stderr.write(
      `headroom requires Node.js 22.13+ or 23.4+ (node:sqlite ships unflagged from those releases on).\n` +
      `Detected Node.js ${process.versions.node}. Install a newer Node (nvm install 22, or 23.4+) and try again.\n`,
    );
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const target = join(here, "..", "dist", "cli.js");
  const result = spawnSync(process.execPath, [warningSuppressionFlag(process.versions.node), target, ...process.argv.slice(2)], { stdio: "inherit", env: childEnvironment() });
  if (result.error) {
    process.stderr.write(`headroom error: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

/**
 * `import.meta.url` is always the canonical (symlink-resolved) URL of this
 * file; `process.argv[1]` is the raw path the caller passed. On macOS these
 * diverge whenever invocation crosses a system alias (`/var` ->
 * `/private/var`, `/tmp` -> `/private/tmp`) -- e.g. any global npm prefix or
 * accounts/home directory under a default TMPDIR. A plain string compare
 * then always fails, main() never runs, and `headroom` silently exits 0 with
 * no output at all. Resolving argv[1] through the same realpath before
 * comparing matches what import.meta.url already went through.
 */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(realpathSync(argv1)).href; }
  catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) main();
