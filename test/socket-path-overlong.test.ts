/**
 * #105: an overlong HEADROOM_HOME makes the Unix socket path too long to bind.
 * The daemon and `headroom doctor` explain that; every client keeps treating
 * it as "no daemon" and falls back to a direct read, exactly as before.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { daemonRequest, HeadroomDaemon, socketPath } from "../src/daemon.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function overlongHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hr-overlong-")); temporary.push(root);
  const home = join(root, "a".repeat(110));
  await mkdir(home, { mode: 0o700 });
  return home;
}

describe.skipIf(process.platform === "win32")("overlong socket path", () => {
  it("lets status fall back to a direct read with one stderr hint, not an error", async () => {
    const home = await overlongHome();
    await writeFile(join(home, "accounts.toml"), "", { mode: 0o600 });
    vi.stubEnv("HEADROOM_HOME", home);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let code: number; let lines: string[];
    try {
      code = await main(["status", "--json"]);
      lines = stderr.mock.calls.map(([chunk]) => String(chunk));
    } finally { stderr.mockRestore(); stdout.mockRestore(); log.mockRestore(); }
    expect(code).toBe(0);
    expect(lines.filter((line) => line.includes("set HEADROOM_HOME to a shorter directory"))).toHaveLength(1);
    expect(lines.some((line) => line.includes("direct read, no daemon"))).toBe(true);
  });

  it("reports the path as an absent daemon to every client", async () => {
    const home = await overlongHome();
    await expect(daemonRequest(socketPath(home), "health", {}, 500, 500)).resolves.toEqual({ status: "absent" });
  });

  it("refuses to start the daemon with the explanation instead of a bare listen EINVAL", async () => {
    const home = await overlongHome();
    await expect(HeadroomDaemon.create({ home, poller: async () => ({ observations: [], failures: [] }) }))
      .rejects.toThrow(/Headroom socket path ".*headroom\.sock" is \d+ bytes; the limit is \d+ bytes on .*\. Set HEADROOM_HOME to a shorter directory\./);
  });
});
