#!/usr/bin/env node
// Thin launcher kept separate from src/cli.ts: it must run before anything
// tries to `require("node:sqlite")`, which throws a raw stack trace on Node
// older than the version that ships that built-in unflagged. This file is
// hand-written, not compiled from src/, so it stays tiny and dependency-free.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

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
  const result = spawnSync(process.execPath, [warningSuppressionFlag(process.versions.node), target, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`headroom error: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
