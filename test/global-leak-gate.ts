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
  // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
  process.env.TMPDIR = runDirectory; process.env.TEMP = runDirectory; process.env.TMP = runDirectory;
  return () => {
    const found = process.platform === "win32" ? [] : survivors(needles);
    // Kill only what is provably this run's: an orphan (ppid 1, the shape a
    // leaked fixture takes) or a descendant of this process, re-checked just
    // before the signal. Anything else that merely mentions the directory
    // (someone tailing a file in it) is reported but never touched.
    const killed = found.filter((row) => row.owned && stillMatches(row.pid, needles));
    for (const { pid } of killed) kill(pid);
    try { rmSync(runDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    if (found.length) {
      // vitest only logs a teardown error ("error during close") and keeps the
      // run's exit code, so set it explicitly as well as throwing.
      process.exitCode = 1;
      throw new Error([
        `LEAK GATE: ${found.length} process(es) started under this test run's temp directory were still alive after it finished (${killed.length} SIGKILLed).`,
        "Every test that starts a process must stop it: use test/helpers/mortal-process.ts (writeMortalShim + track + useProcessReaper).",
        ...found.slice(0, 20).map(({ pid, ppid, owned, command }) => `  ${pid} (ppid ${ppid}${owned ? "" : ", not ours: left alone"}) ${command}`),
      ].join("\n"));
    }
  };
}

function safeRealpath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

interface Row { pid: number; ppid: number; command: string; owned: boolean }

function survivors(needles: string[]): Row[] {
  let stdout: string;
  try { stdout = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); }
  catch { console.warn("leak gate: ps unavailable, process scan skipped (fixtures still exit on their own)"); return []; }
  const rows = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  const descendsFromUs = (pid: number): boolean => {
    for (let current = parent.get(pid), hops = 0; current !== undefined && hops < 64; current = parent.get(current), hops += 1) if (current === process.pid) return true;
    return false;
  };
  return rows
    .filter((row) => row.pid !== process.pid && needles.some((needle) => row.command.includes(needle)))
    .map((row) => ({ ...row, owned: row.ppid === 1 || descendsFromUs(row.pid) }));
}

function stillMatches(pid: number, needles: string[]): boolean {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return needles.some((needle) => command.includes(needle));
  } catch { return false; }
}

function kill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ }
}
