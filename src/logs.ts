import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { headroomHome, joinForPlatform } from "./paths.js";

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The active log plus four archives keeps at most five 5 MiB files. */
export const DAEMON_LOG_FILE_COUNT = 5;

// joinForPlatform, not a bare join(): service.ts calls this while generating
// another platform's service file (e.g. a Linux unit's log path from a
// macOS dry run), and a bare join() always uses the host's own separator.
export function daemonLogPath(home = headroomHome(), platform: NodeJS.Platform = process.platform): string {
  return joinForPlatform(platform, home, "logs", "daemon.log");
}

/** Rotate before appending so Headroom's own daemon messages never grow unbounded. */
export async function rotateDaemonLog(path = daemonLogPath()): Promise<void> {
  try {
    if ((await stat(path)).size < DAEMON_LOG_MAX_BYTES) return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(`${path}.${DAEMON_LOG_FILE_COUNT - 1}`, { force: true });
  for (let index = DAEMON_LOG_FILE_COUNT - 2; index >= 1; index -= 1) {
    try { await rename(`${path}.${index}`, `${path}.${index + 1}`); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await rename(path, `${path}.1`);
}

export async function appendDaemonLog(message: string, home = headroomHome()): Promise<void> {
  const path = daemonLogPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rotateDaemonLog(path);
  await writeFile(path, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

export async function tailDaemonLog(lines = 50, home = headroomHome()): Promise<string> {
  const path = daemonLogPath(home);
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
