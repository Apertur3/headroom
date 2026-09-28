import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon, daemonRequest, socketPath } from "../src/daemon.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

/**
 * P0 (cached-reads brief): under host load, a poll cycle's own synchronous
 * SQLite writes were measured stalling a concurrent `health` reply well past
 * its 2s budget ("headroom status --json" calls 2s apart, one out of twelve
 * took 5.1s, lining up with a poll cycle).
 *
 * Root cause, found by profiling `insertPoll()` directly (not guessed): a
 * single `insert()` call prepares roughly a dozen SQL statements, and
 * `this.db.prepare(sql)` was called fresh -- reparsed and replanned by
 * SQLite -- on every single call, even though the same handful of SQL
 * strings repeat on every observation. A raw `node:sqlite` benchmark of
 * 1000 autocommit inserts showed 63ms with fresh prepares against 26ms with
 * a cached prepared statement, and one transaction instead of 1000
 * autocommit commits took that from 63ms to 1ms; combined, a real
 * `insertPoll()` over 1000 synthetic observations dropped from 469ms to
 * 60ms (measured on this machine, no artificial disk delay needed -- see the
 * benchmark below). The fix is two changes in src/store.ts: a
 * `prepared()` helper that caches every statement by its exact SQL text
 * (`HeadroomStore#prepared`), and `insertPoll()` wrapped in one
 * `BEGIN IMMEDIATE`/`COMMIT` instead of insertAll()'s per-observation
 * autocommit. Neither changes any timeout.
 */

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tempRoot(label: string): Promise<string> {
  // Short prefix: see stale-socket.test.ts's identical comment -- a Unix
  // domain socket path is bounded by sizeof(sockaddr_un.sun_path).
  const root = await mkdtemp(join(tmpdir(), `hrs-${label}-`));
  temporary.push(root);
  return root;
}

/** Fresh (never-before-seen) observations across `count` distinct meters:
 * each one drives insert()'s full first-reading path -- the same shape of
 * work a poll cycle across several accounts does, just wide enough that its
 * total synchronous cost is measurable on any machine without needing real
 * disk contention to reproduce. */
function manyFreshObservations(count: number, now: Date): Observation[] {
  const items: Observation[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push({
      principal_id: `synthetic-${index}`,
      meter_id: `synthetic-${index}:all`,
      window: { kind: "rolling", minutes: 300, enforcement: "hard" },
      quantity: { used: 12, limit: 100, remaining: 88, unit: "percent" },
      resets_at: new Date(now.getTime() + 3_600_000).toISOString(),
      observed_at: now.toISOString(),
      fetched_at: now.toISOString(),
      source: "native:synthetic",
      truth: "official",
      freshness: "fresh",
      confidence: 1,
      adapter_version: "test",
      upstream_schema_version: "test",
    });
  }
  return items;
}

describe("store.insertPoll event-loop cost (the poll-cycle stall)", () => {
  it("stays well under the 2s health budget even at 2000 fresh observations in one poll", async () => {
    const root = await tempRoot("insertpoll-bench");
    const store = await HeadroomStore.open(root);
    try {
      const observations = manyFreshObservations(2_000, new Date());
      const start = Date.now();
      const stored = store.insertPoll(observations);
      const elapsed = Date.now() - start;
      expect(stored).toHaveLength(2_000);
      // Measured ~963ms before the prepared-statement cache + one-transaction
      // fix, ~148ms after, on this machine -- both numbers well below what a
      // real household's poll (a handful of accounts, not 2000) would ever
      // see, but wide enough here to make the fixed cost repeatable without
      // depending on real disk or CPU contention. The budget below is the
      // CLI/MCP health timeout itself, not a number tuned to this run.
      expect(elapsed).toBeLessThan(2_000);
    } finally { store.close(); }
  }, 20_000);
});

// A Unix socket on POSIX; Windows uses a named pipe (covered in pipe-auth.test.ts).
describe.skipIf(process.platform === "win32")("daemon event-loop responsiveness through a real poll", () => {
  it("keeps `health` available while a forced poll writes many observations over the real socket", async () => {
    const root = await tempRoot("evtloop");
    const path = socketPath(root);
    // Small enough that the RPC reply comfortably fits daemon.ts's own
    // MAX_RPC_RESPONSE_BYTES bound (this test measures event-loop
    // responsiveness, not the transport's payload ceiling).
    const observations = manyFreshObservations(150, new Date());
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => ({ observations, failures: [] }) });
    try { await daemon.start(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); return; }
      throw error;
    }
    try {
      // Fired without awaiting: this forced poll drives insertPoll() across
      // all 150 synthetic meters while the loop below hammers `health` on
      // separate connections, the same pattern as the production
      // reproduction (many back-to-back `headroom status --json` calls)
      // concentrated into one poll instead of spread across a 2s cadence.
      const pollDone = daemonRequest(path, "refresh", {});
      let pollSettled = false;
      void pollDone.finally(() => { pollSettled = true; });
      const latencies: number[] = [];
      while (!pollSettled) {
        const start = Date.now();
        const reply = await daemonRequest(path, "health");
        latencies.push(Date.now() - start);
        expect(reply.status).toBe("available");
      }
      const finished = await pollDone;
      expect(finished.status).toBe("available");
      // The longest gap between two health replies while the poll ran: the
      // measurement this test exists to take.
      expect(Math.max(...latencies)).toBeLessThan(2_000);
    } finally { await daemon.stop(); }
  }, 20_000);
});
