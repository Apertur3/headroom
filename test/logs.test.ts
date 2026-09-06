import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_LOG_FILE_COUNT, DAEMON_LOG_MAX_BYTES, appendDaemonLog, daemonLogPath, rotateDaemonLog, tailDaemonLog } from "../src/logs.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "headroom-log-"));
  temporary.push(home);
  await mkdir(join(home, "logs"));
  return home;
}

describe("daemon logs", () => {
  it("rotates at 5 MiB and tails the active file", async () => {
    const home = await freshHome();
    const path = daemonLogPath(home);
    await writeFile(path, "x".repeat(DAEMON_LOG_MAX_BYTES));
    await appendDaemonLog("started", home);
    await appendDaemonLog("ready", home);
    await expect(tailDaemonLog(1, home)).resolves.toMatch(/ready$/);
    await expect(stat(`${path}.1`)).resolves.toMatchObject({ size: DAEMON_LOG_MAX_BYTES });
  });

  it("shifts every archive down a generation and drops the oldest", async () => {
    const home = await freshHome();
    const path = daemonLogPath(home);
    await writeFile(path, "x".repeat(DAEMON_LOG_MAX_BYTES));
    const archiveCount = DAEMON_LOG_FILE_COUNT - 1;
    for (let index = 1; index <= archiveCount; index += 1) await writeFile(`${path}.${index}`, `gen${index}`);
    await appendDaemonLog("rotated", home);
    // The oversized active file becomes .1; every existing archive moves down
    // one generation; the last one (gen<archiveCount>) falls off the end.
    await expect(stat(`${path}.1`)).resolves.toMatchObject({ size: DAEMON_LOG_MAX_BYTES });
    for (let index = 2; index <= archiveCount; index += 1) {
      await expect(readFile(`${path}.${index}`, "utf8")).resolves.toBe(`gen${index - 1}`);
    }
    await expect(stat(`${path}.${archiveCount + 1}`)).rejects.toThrow();
  });

  it("keeps the new active file at mode 0600 even when the rotated-out file was looser", async () => {
    const home = await freshHome();
    const path = daemonLogPath(home);
    await writeFile(path, "x".repeat(DAEMON_LOG_MAX_BYTES), { mode: 0o644 });
    await appendDaemonLog("rotated", home);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never exposes a partially-rotated file to a concurrent tail", async () => {
    const home = await freshHome();
    const path = daemonLogPath(home);
    await writeFile(path, "x".repeat(DAEMON_LOG_MAX_BYTES));
    // Rotation renames the oversized file to .1 first and only creates the new
    // active file afterwards. Reading right in between must see "no file yet",
    // never a truncated or half-written one.
    await rotateDaemonLog(path);
    await expect(tailDaemonLog(1, home)).resolves.toBe("");
    await expect(stat(`${path}.1`)).resolves.toMatchObject({ size: DAEMON_LOG_MAX_BYTES });

    // A tail racing the full append-triggered rotation (rename, then append)
    // must resolve to a clean read, never throw, and never come back with a
    // mix of old and new content.
    const second = await freshHome();
    const secondPath = daemonLogPath(second);
    await writeFile(secondPath, "y".repeat(DAEMON_LOG_MAX_BYTES));
    const [, tailed] = await Promise.all([appendDaemonLog("after rotation", second), tailDaemonLog(1, second)]);
    // Whichever moment the read lands on, it must be one whole state: still
    // the pre-rotation file, nothing (the gap between rename and create), or
    // the fully-written post-rotation line -- never a mix of the two.
    expect(tailed === "" || /^y+$/.test(tailed) || /after rotation$/.test(tailed)).toBe(true);
  });
});
