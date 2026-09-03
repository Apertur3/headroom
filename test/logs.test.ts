import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_LOG_MAX_BYTES, appendDaemonLog, daemonLogPath, tailDaemonLog } from "../src/logs.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("daemon logs", () => {
  it("rotates at 5 MiB and tails the active file", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-log-"));
    temporary.push(home);
    const path = daemonLogPath(home);
    await mkdir(join(home, "logs"));
    await writeFile(path, "x".repeat(DAEMON_LOG_MAX_BYTES));
    await appendDaemonLog("started", home);
    await appendDaemonLog("ready", home);
    await expect(tailDaemonLog(1, home)).resolves.toMatch(/ready$/);
    await expect(stat(`${path}.1`)).resolves.toMatchObject({ size: DAEMON_LOG_MAX_BYTES });
  });
});
