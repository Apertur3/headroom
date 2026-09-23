import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon, daemonRequest } from "../src/daemon.js";

// Issue #62: after a reboot (or a `kill -9`), the daemon's POSIX socket
// *file* survives even though nothing is listening on it anymore -- a
// listening socket's file does not vanish with its process the way a
// Windows named pipe does. Startup used to treat "the file exists" as
// meaning "another daemon might be alive" and refused to touch it, so it
// crash-looped forever under a supervisor. These tests exercise the fixed
// startup sequence directly against real sockets, never the real
// ~/.headroom.

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tempRoot(label: string): Promise<string> {
  // Short prefix, deliberately: a Unix domain socket path is bounded by
  // sizeof(sockaddr_un.sun_path) (104 bytes on macOS), and this file binds
  // two live sockets at "<root>/headroom.sock" side by side -- a longer,
  // more descriptive tmpdir prefix plus a real macOS $TMPDIR (already ~50
  // bytes) was enough on its own to push listen() over that limit and fail
  // with a misleading EINVAL that has nothing to do with the code under test.
  const root = await mkdtemp(join(tmpdir(), `hrs-${label}-`));
  temporary.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Leaves a socket *file* on disk with nothing listening on it -- exactly
 * what a stale headroom.sock looks like after a hard reboot or a `kill -9`
 * that never got to run the daemon's own unlink-on-stop. A real net.Server
 * that binds and then closes reproduces this precisely: Node does not
 * unlink a Unix domain socket's file on close() (this codebase's own
 * HeadroomDaemon.stop() has to do it explicitly), so the file outlives the
 * listener exactly the way it would after a crash. */
async function leaveStaleSocketFile(path: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  await chmod(path, 0o600); // matches the mode a real daemon's own start() leaves behind
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function fakePoller() { return async () => ({ observations: [], failures: [] }); }

describe("stale socket at startup (issue #62)", () => {
  it("unlinks a stale socket file with no listener and starts and serves", async () => {
    if (process.platform === "win32") return; // named pipes have no on-disk file to go stale
    const root = await tempRoot("nolist");
    const path = join(root, "headroom.sock");
    await leaveStaleSocketFile(path);

    const daemon = await HeadroomDaemon.create({ home: root, path, poller: fakePoller() });
    await daemon.start();
    try {
      const reply = await daemonRequest(path, "health");
      expect(reply.status).toBe("available");
    } finally {
      await daemon.stop();
    }
  });

  it("does not unlink a socket with a live listener, and fails closed with a clear message", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("live");
    const path = join(root, "headroom.sock");

    const first = await HeadroomDaemon.create({ home: root, path, poller: fakePoller() });
    await first.start();
    try {
      const second = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: fakePoller() });
      await expect(second.start()).rejects.toThrow("Headroom daemon is already running");
      // The live daemon is still answering on the very same socket file --
      // it was never unlinked out from under it.
      const reply = await daemonRequest(path, "health");
      expect(reply.status).toBe("available");
    } finally {
      await first.stop();
    }
  });

  it("refuses a non-socket file at the path and never deletes it", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("nonsock");
    const path = join(root, "headroom.sock");
    await writeFile(path, "not a socket\n", { mode: 0o600 });

    const daemon = await HeadroomDaemon.create({ home: root, path, poller: fakePoller() });
    await expect(daemon.start()).rejects.toThrow("Refusing unsafe headroom socket");
    expect(await readFile(path, "utf8")).toBe("not a socket\n");
  });

  it("survives a concurrent start race over the same stale socket without looping", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("race");
    const path = join(root, "headroom.sock");
    await leaveStaleSocketFile(path);

    const daemonA = await HeadroomDaemon.create({ home: root, path, poller: fakePoller() });
    const daemonB = await HeadroomDaemon.create({ home: root, path, poller: fakePoller() });
    const results = await Promise.allSettled([daemonA.start(), daemonB.start()]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    // Exactly one of the two racing starts wins the bind; the other backs off
    // cleanly (either it saw the winner already alive, or it lost the bind
    // itself and re-probed into that same "already running" outcome) rather
    // than spinning or crashing.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/already running/);

    const reply = await daemonRequest(path, "health");
    expect(reply.status).toBe("available");

    await Promise.all([daemonA.stop(), daemonB.stop()]);
  });
});
