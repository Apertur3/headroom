import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Suite-level leak gate. Every temp directory the suite creates lives under
 * one run directory (`/tmp/hrt-XXXXXX`) (TMPDIR is pointed at it before any worker starts, and
 * workers inherit it), so after the run every process whose command line
 * still mentions that directory is, by construction, something this run
 * started and failed to stop. Those are SIGKILLed and the run FAILS: a leak
 * must turn `npm test` and CI red, never pass silently. This is the gate that
 * would have caught the 2026-09-27 PTY leak on its first run.
 *
 * Only this run's own directory is matched, so a concurrent suite in another
 * checkout is never touched. Where `ps` is unavailable (Windows, or a sandbox
 * that denies it) the scan is skipped with a warning; the shims' own
 * lifetime limit (test/helpers/mortal-process.ts) still bounds any leak.
 */
export default function setup(): () => void {
  // Short on purpose: tests bind Unix sockets under this directory and macOS
  // caps a socket path at 104 bytes, so the run directory must not lengthen
  // the default temp paths (/tmp/hrt-XXXXXX is shorter than macOS's own
  // per-user temp directory).
  const runDirectory = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "hrt-") : "/tmp/hrt-");
  const needles = [...new Set([runDirectory, safeRealpath(runDirectory)])];
  process.env.TMPDIR = runDirectory;
  return () => {
    const leaked = process.platform === "win32" ? [] : survivors(needles);
    for (const { pid } of leaked) kill(pid);
    try { rmSync(runDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    if (leaked.length) {
      // vitest only logs a teardown error ("error during close") and keeps the
      // run's exit code, so set it explicitly as well as throwing.
      process.exitCode = 1;
      throw new Error([
        `LEAK GATE: ${leaked.length} process(es) started by this test run were still alive after it finished (now SIGKILLed).`,
        "Every test that starts a process must stop it: use test/helpers/mortal-process.ts (writeMortalShim + track + useProcessReaper).",
        ...leaked.slice(0, 20).map(({ pid, command }) => `  ${pid} ${command}`),
      ].join("\n"));
    }
  };
}

function safeRealpath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function survivors(needles: string[]): { pid: number; command: string }[] {
  let stdout: string;
  try { stdout = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); }
  catch { console.warn("leak gate: ps unavailable, process scan skipped"); return []; }
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === process.pid || !needles.some((needle) => command.includes(needle))) return [];
    return [{ pid, command }];
  });
}

function kill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ }
}
