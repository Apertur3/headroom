import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import { appendDaemonLog } from "../src/logs.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";

/**
 * A full or read-only disk makes both the daemon log and the store's audit
 * row fail to write. Both are written from the daemon's own error paths and
 * from detached promises, so either failure used to surface as an unhandled
 * rejection, which ends a Node 22 process.
 */
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("a disk that cannot be written never ends the daemon", () => {
  it("appendDaemonLog resolves when the log cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-log-unwritable-")); temporary.push(root);
    const notADirectory = join(root, "file");
    await writeFile(notADirectory, "");
    await expect(appendDaemonLog("line", join(notADirectory, "home"))).resolves.toBeUndefined();
  });

  it("answers an RPC, success, error or rejection, with its own reply when its audit row cannot be written", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-daemon-audit-unwritable-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), "", { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    const store = (daemon as unknown as { store: { audit: (...args: unknown[]) => void } }).store;
    const audit = store.audit;
    try {
      store.audit = () => { throw new Error("database or disk is full"); };
      await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "leases", params: {} }))).resolves.toMatchObject({ result: [] });
      // A handler exception still gets its error reply.
      await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "lease_end", params: { id: "no-such-lease", owner: "nobody" } })))
        .resolves.toMatchObject({ error: { code: -32000 } });
      // A validation rejection keeps its own code and message.
      await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "history", params: {} })))
        .resolves.toMatchObject({ error: { code: -32602, message: "meter is required" } });
    } finally {
      store.audit = audit;
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });
});
