#!/usr/bin/env node
// Thin launcher kept separate from src/cli.ts: it must run before anything
// tries to `require("node:sqlite")`, which throws a raw stack trace on Node
// older than the version that ships that built-in unflagged. This file is
// hand-written, not compiled from src/, so it stays tiny and dependency-free.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function supportsBuiltinSqlite(version) {
  const [major, minor] = version.split(".").map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 4;
  if (major === 22) return minor >= 13;
  return false;
}

if (!supportsBuiltinSqlite(process.versions.node)) {
  process.stderr.write(
    `headroom requires Node.js 22.13+ or 23.4+ (node:sqlite ships unflagged from those releases on).\n` +
    `Detected Node.js ${process.versions.node}. Install a newer Node (nvm install 22, or 23.4+) and try again.\n`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "dist", "cli.js");
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`headroom error: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? (result.signal ? 1 : 0));
