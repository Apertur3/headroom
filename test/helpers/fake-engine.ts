import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeMortalShim } from "./mortal-process.js";

/**
 * Fake native engines for the process-hygiene tests. Neither ever starts a
 * real agy. Every script exits by itself well inside 30 seconds, whatever
 * happens to the test runner, and carries the fixture's unique temp directory
 * in its command line so survivors can be found in `ps` by that marker.
 */

/** An engine that spawns a SIGTERM-ignoring grandchild in the same process
 * group and then sleeps. Records both pids. Prints nothing and never exits on
 * its own before its lifetime is up, so only a group kill can end it early. */
export async function writeGrandchildEngine(root: string): Promise<{ engine: string; enginePidFile: string; grandchildPidFile: string }> {
  const grandchildPidFile = join(root, "grandchild.pid");
  const enginePidFile = join(root, "engine.pid");
  const grandchild = await writeMortalShim(join(root, "language_server_fake"), { pidFile: grandchildPidFile, ignoreTerm: true, lifetimeSeconds: 25 });
  const engine = join(root, "engine-fake");
  await writeFile(engine, [
    "#!/bin/sh",
    `echo $$ > '${enginePidFile}'`,
    `'${grandchild}' &`,
    "end=$(( $(date +%s) + 25 ))",
    'while [ "$(date +%s)" -lt "$end" ]; do sleep 1; done',
    "exit 0",
  ].join("\n") + "\n", { mode: 0o700 });
  await chmod(engine, 0o700);
  return { engine, enginePidFile, grandchildPidFile };
}

/** An engine that logs `start`/`end` lines to `log`, holds for `holdSeconds`
 * and prints an empty observation list. */
export async function writeCountingEngine(root: string, log: string, holdSeconds = 1): Promise<string> {
  const engine = join(root, "engine-counting");
  await writeFile(engine, [
    "#!/bin/sh",
    `echo start >> '${log}'`,
    `sleep ${holdSeconds}`,
    `echo end >> '${log}'`,
    "echo '[]'",
  ].join("\n") + "\n", { mode: 0o700 });
  await chmod(engine, 0o700);
  return engine;
}

/** Lines of `ps` whose command mentions `marker` (the fixture's temp directory). */
export function processesMentioning(marker: string): string[] {
  const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return out.split("\n").filter((line) => line.includes(marker) && !/\bps -Ao\b/.test(line));
}
