#!/usr/bin/env node
// Seeds a throwaway Headroom home with synthetic accounts and readings, and
// prints a shell line that points the CLI at it. The examples/ scripts use it.
//
//   eval "$(node scripts/demo-home.mjs)"     # sets HEADROOM_HOME for this shell
//   headroom can claude-heavy --owner demo
//
// Nothing real is read. Delete the printed directory when you are done.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDemoHome } from "./lib/demo-home.mjs";

const home = mkdtempSync(join(tmpdir(), "headroom-demo-"));
await seedDemoHome(home);
console.log(`export HEADROOM_HOME='${home}'`);
