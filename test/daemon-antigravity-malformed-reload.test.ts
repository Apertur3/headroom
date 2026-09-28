import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

/**
 * Proves that currentAccounts()/readPolicy() inside
 * maybeStartKeepalive() can reject on a malformed reload, and the poll
 * path calls maybeStartKeepalive() fire-and-forget with no rejection
 * handler of its own. Both scenarios corrupt the relevant config file
 * from inside a custom poller callback -- so the corruption lands exactly
 * between poll()'s own successful earlier read (the one that decided a
 * keepalive attempt is warranted) and the fresh re-read maybeStartKeepalive()
 * does for itself moments later, which is the actual race the finding
 * describes. A real process-level `unhandledRejection` listener is the
 * proof: if the fix regresses, this fires for real (and, separately,
 * vitest's own default unhandled-error handling would also fail the run).
 */
const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

const accountsToml = (enabled: boolean, agyPath: string): string => [
  "[[accounts]]", 'name = "antigravity"', `enabled = ${enabled}`,
  'vendor = "antigravity"', 'location = "agy"', 'adapter = "native-ts"', `agy_path = "${agyPath}"`, "",
].join("\n");

async function withUnhandledRejectionCapture<T>(run: () => Promise<T>): Promise<{ result: T; rejections: unknown[] }> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    const result = await run();
    // A fire-and-forget call's rejection can surface on a later microtask
    // than the one this function's own await settles on -- give the event
    // loop a few turns before concluding none arrived.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { result, rejections };
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

describe.skipIf(process.platform === "win32")("HeadroomDaemon: a malformed config reload during a poll never produces an unhandled rejection", () => {
  it("survives accounts.toml turning malformed between poll()'s own read and maybeStartKeepalive()'s fresh re-read", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-malformed-accounts-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    // Disabled at start: daemon.start()'s own maybeStartKeepalive() call
    // must not construct a supervisor yet, so this test's poll() call
    // below is the one actually exercising the race.
    await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemonFor(root, path, async () => {
      // Corrupts accounts.toml WHILE this poll is in flight -- after
      // poll()'s own currentAccounts() read already succeeded and decided
      // an antigravity keepalive attempt is warranted, but before the
      // fresh re-read maybeStartKeepalive() does for itself.
      await writeFile(join(root, "accounts.toml"), "[[accounts]\nnot valid toml", { mode: 0o600 });
      return { observations: [], failures: [] };
    });
    try {
      const internal = daemon as unknown as {
        keepalive: { running: boolean } | undefined;
        poll(principal: string | undefined, forced: boolean): Promise<unknown>;
      };
      await daemon.start();
      expect(internal.keepalive).toBeUndefined();
      // Real re-enable, exactly like a live accounts.toml edit -- now
      // poll() itself will see an enabled antigravity account and decide
      // an attempt is warranted.
      await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
      const { rejections } = await withUnhandledRejectionCapture(() => internal.poll(undefined, true));
      expect(rejections).toEqual([]);
      // The malformed file means the fresh re-read inside maybeStartKeepalive()
      // could not confirm anything is still enabled: no supervisor should
      // have been constructed off the stale, pre-corruption snapshot.
      expect(internal.keepalive).toBeUndefined();
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);

  it("survives policy.toml turning malformed between poll()'s own read and maybeStartKeepalive()'s fresh re-read", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-daemon-agy-malformed-policy-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    // Disabled at start, same reason as the accounts.toml test above:
    // daemon.start() must not already own a supervisor by the time this
    // test's own poll() call runs.
    await writeFile(join(root, "accounts.toml"), accountsToml(false, fakeAgy), { mode: 0o600 });
    await writeFile(join(root, "policy.toml"), "antigravity_keepalive = true\n", { mode: 0o600 });
    const path = testSocketPath(root, "headroom");
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = root;
    const daemon = await HeadroomDaemonFor(root, path, async () => {
      // Corrupts policy.toml WHILE this poll is in flight, same race as
      // the accounts.toml case above but on the policy side. parsePolicy()
      // silently ignores most unrecognized lines (a deliberate leniency
      // for forward-compat unknown keys), so this specifically targets one
      // of its explicit throw paths: a `pacing =` line whose value is
      // neither "even" nor "none".
      await writeFile(join(root, "policy.toml"), 'antigravity_keepalive = true\npacing = "not-a-real-pacing-value"\n', { mode: 0o600 });
      return { observations: [], failures: [] };
    });
    try {
      const internal = daemon as unknown as {
        keepalive: { running: boolean } | undefined;
        poll(principal: string | undefined, forced: boolean): Promise<unknown>;
      };
      await daemon.start();
      expect(internal.keepalive).toBeUndefined();
      await writeFile(join(root, "accounts.toml"), accountsToml(true, fakeAgy), { mode: 0o600 });
      const { rejections } = await withUnhandledRejectionCapture(() => internal.poll(undefined, true));
      expect(rejections).toEqual([]);
      expect(internal.keepalive).toBeUndefined();
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  }, 15_000);
});

async function HeadroomDaemonFor(root: string, path: string, poller: () => Promise<{ observations: never[]; failures: never[] }>) {
  const { HeadroomDaemon } = await import("../src/daemon.js");
  return HeadroomDaemon.create({ home: root, path, poller });
}
