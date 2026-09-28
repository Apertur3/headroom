import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { socketPath } from "../src/daemon.js";
import { handleMcp } from "../src/mcp.js";
import { HEARTBEATS_SCHEMA_VERSION } from "../src/migrations.js";
import { HeadroomStore } from "../src/store.js";
import { track, useProcessReaper } from "./helpers/mortal-process.js";

const { DatabaseSync: RawDatabase } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

/** Rolls a fully-migrated database file back to the schema shape a pre-0.2.0
 * daemon left on disk: the `heartbeats`/`timers` tables (migration
 * HEARTBEATS_SCHEMA_VERSION, ADD_HEARTBEATS_AND_TIMERS) dropped, and
 * `PRAGMA user_version` set one below that migration -- exactly what
 * `openReadOnly()`'s own doc comment describes as "a database a pre-0.2.0
 * daemon wrote and nothing has migrated since". */
function rollBackHeartbeatsSchema(root: string): void {
  const db = new RawDatabase(join(root, "headroom.db"));
  try {
    db.exec("DROP TABLE IF EXISTS heartbeats; DROP TABLE IF EXISTS timers;");
    db.exec(`PRAGMA user_version = ${HEARTBEATS_SCHEMA_VERSION - 1}`);
  } finally { db.close(); }
}

/** Rolls a fully-migrated database file back to exactly schema
 * HEARTBEATS_SCHEMA_VERSION (4): the `timers` table exists (with a real
 * pending row already in it, unlike rollBackHeartbeatsSchema's "table
 * doesn't exist at all" case above), but not yet the `attempts`/
 * `failed_at`/`claimed_at`/`claim_token` columns later migrations add. This
 * is the "rolling upgrade" shape store.ts's `timers()` must keep reading
 * correctly -- a schema-4 database has real pending timers on disk that a
 * naive `>= TIMER_DELIVERY_SCHEMA_VERSION ? full-query : []` gate would hide
 * entirely, even though `fired_at`/`cleared_at` (the only completion
 * markers this shape has) are enough to answer "is this one pending". */
function rollBackToSchema4(root: string): void {
  const db = new RawDatabase(join(root, "headroom.db"));
  try {
    db.exec("ALTER TABLE timers DROP COLUMN attempts; ALTER TABLE timers DROP COLUMN failed_at; ALTER TABLE timers DROP COLUMN claimed_at; ALTER TABLE timers DROP COLUMN claim_token;");
    db.exec(`PRAGMA user_version = ${HEARTBEATS_SCHEMA_VERSION}`);
  } finally { db.close(); }
}

/**
 * Part 2 (read-only cached fallback) and part 3 (never empty stdout on a
 * failed --json read) of the cached-reads work, exercised against a REAL,
 * separate process that never answers -- not an in-process synthetic delay,
 * which would also stall this test's own event loop and its client-side
 * timeouts along with it, making "the daemon is unresponsive" impossible to
 * reproduce deterministically in one process. The fake daemon below busy-
 * loops for `holdMs` (comfortably longer than the 2s health budget, twice
 * over) before ever replying to anything, so every health attempt -- with or
 * without cli.ts's one retry -- genuinely times out client-side, exactly the
 * "socket present, health did not respond within 2s" symptom from production.
 */

useProcessReaper();
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `hrs-${label}-`));
  temporary.push(root);
  return root;
}

/** A minimal JSON-RPC-over-socket server, real and out-of-process, that
 * never answers within the client's budget: it reads one request line per
 * connection, then busy-loops synchronously for `holdMs` before replying at
 * all (the reply's content never matters -- every real assertion below
 * depends on the client timing out first, never on what this eventually
 * sends back). */
function fakeUnresponsiveDaemonScript(): string {
  return [
    "import { createServer } from \"node:net\";",
    "const [, , path, holdMsRaw] = process.argv;",
    "const holdMs = Number(holdMsRaw);",
    "const server = createServer((socket) => {",
    "  socket.on(\"error\", () => {});",
    "  let buffer = \"\";",
    "  socket.on(\"data\", (chunk) => {",
    "    buffer += chunk.toString(\"utf8\");",
    "    const newline = buffer.indexOf(\"\\n\");",
    "    if (newline < 0) return;",
    "    const line = buffer.slice(0, newline);",
    "    buffer = buffer.slice(newline + 1);",
    "    let id = null;",
    "    try { id = JSON.parse(line).id ?? null; } catch {}",
    "    const until = Date.now() + holdMs;",
    "    while (Date.now() < until) { /* simulate the daemon's event loop held by a slow synchronous poll step */ }",
    "    try { socket.write(JSON.stringify({ jsonrpc: \"2.0\", id, result: { socket: path, in_flight: 0, backoff: [], keepalive: { running: false, pid: null, uptime_ms: null, login_state: \"unknown\", local_reads: {} } } }) + \"\\n\"); } catch {}",
    "  });",
    "});",
    "server.listen(path, () => { process.stdout.write(\"ready\\n\"); });",
    "process.on(\"SIGTERM\", () => process.exit(0));",
    "process.on(\"SIGINT\", () => process.exit(0));",
  ].join("\n") + "\n";
}

interface FakeDaemon { pid: number; stop: () => void }

async function startFakeUnresponsiveDaemon(root: string, holdMs: number): Promise<FakeDaemon> {
  const scriptPath = join(root, "fake-daemon.mjs");
  await writeFile(scriptPath, fakeUnresponsiveDaemonScript());
  const path = socketPath(root);
  const child = spawn(process.execPath, [scriptPath, path, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
  track(child.pid, root);
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const onData = (chunk: Buffer) => { out += chunk.toString("utf8"); if (out.includes("ready")) { child.stdout?.off("data", onData); resolve(); } };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fake daemon exited early (code ${code})`)));
    setTimeout(() => reject(new Error("fake daemon never became ready")), 5_000).unref();
  });
  return { pid: child.pid!, stop: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } } };
}

describe("cached read-only fallback against a genuinely unresponsive daemon", () => {
  it.skipIf(process.platform === "win32")("`status --json` is served from the read-only cache, flagged, within a bounded time", async () => {
    const root = await tempRoot("cache-status");
    // A real daemon's store file already exists by the time it can be
    // unresponsive; openReadOnly() (unlike open()) never creates a missing
    // file, so this test pre-creates it exactly like the daemon's own first
    // start would have.
    (await HeadroomStore.open(root)).close();
    // holdMs > 2 * the 2s health budget so BOTH the CLI's health attempt and
    // its one retry each time out client-side before this ever answers.
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const start = Date.now();
      const code = await runCli(["--json"]);
      const elapsed = Date.now() - start;
      expect(code).toBe(0);
      // Two health attempts at ~2s each, plus the read-only store open --
      // comfortably bounded, never the old thrown-error/empty-stdout outcome.
      expect(elapsed).toBeLessThan(10_000);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      const payload = JSON.parse(printed) as Record<string, unknown>;
      expect(payload.served_from).toBe("cache");
      expect(payload.daemon).toBe("unresponsive");
      expect(payload.observations).toEqual([]);
      expect(payload.leases).toEqual([]);
      // CLI/MCP parity (see mcp.ts's cacheStatus): the cache path carries
      // these two additive fields exactly like the daemon and direct paths.
      expect(payload.heartbeats).toEqual([]);
      expect(payload.due_timers).toEqual([]);
      // A one-line human-readable note lands on stderr regardless of --json,
      // the same convention the existing no-daemon direct-read notice uses.
      const stderrLines = errSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(stderrLines).toMatch(/served from cache/i);
    } finally {
      logSpy.mockRestore(); errSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  // P2 fix: openReadOnly() never migrates, so a database a
  // pre-0.2.0 daemon last wrote (no heartbeats/timers tables yet) hitting
  // this exact cached path used to throw "no such table" instead of serving
  // the rest of status with those two fields empty.
  it.skipIf(process.platform === "win32")("`status --json` still succeeds from the cache on a pre-heartbeats-migration database", async () => {
    const root = await tempRoot("cache-status-old-schema");
    (await HeadroomStore.open(root)).close();
    rollBackHeartbeatsSchema(root);
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runCli(["--json"]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      const payload = JSON.parse(printed) as Record<string, unknown>;
      expect(payload.served_from).toBe("cache");
      expect(payload.daemon).toBe("unresponsive");
      expect(payload.heartbeats).toEqual([]);
      expect(payload.due_timers).toEqual([]);
    } finally {
      logSpy.mockRestore(); errSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  // P2 fix: `timers()` used to gate on the FULL current schema
  // (TIMER_DELIVERY_SCHEMA_VERSION) even though its query only actually
  // needs `fired_at`/`cleared_at` to answer "is this one pending" on an
  // older shape -- a "rolling upgrade" database sitting on exactly schema 4
  // (the table exists, with a real pending timer in it, but not yet
  // `attempts`/`failed_at`) read as "no timers" entirely, hiding a genuinely
  // due one from status/timer list.
  it.skipIf(process.platform === "win32")("`status --json` still lists a real pending timer on a database sitting on exactly schema 4", async () => {
    const root = await tempRoot("cache-status-schema4");
    const seeded = await HeadroomStore.open(root);
    const at = new Date(Date.now() - 60_000); // already due
    seeded.setTimer("orch-schema4", "wake", at.toISOString(), "check the deploy", "notify", new Date(Date.now() - 120_000));
    seeded.close();
    rollBackToSchema4(root);
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runCli(["--json"]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      const payload = JSON.parse(printed) as { due_timers: Array<{ owner: string; name: string; attempts: number; failed_at: string | null }> };
      expect(payload.due_timers).toHaveLength(1);
      // attempts/failed_at synthesized (the columns do not exist on this schema).
      expect(payload.due_timers[0]).toMatchObject({ owner: "orch-schema4", name: "wake", attempts: 0, failed_at: null });
    } finally {
      logSpy.mockRestore(); errSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("`can --lease` (a dispatch path) still fails closed against the same unresponsive daemon", async () => {
    const root = await tempRoot("cache-lease-failclosed");
    await writeFile(join(root, "routing.toml"), '[consumes]\nreview = ["codex-main:main"]\n', { mode: 0o600 });
    await writeFile(join(root, "accounts.toml"), ["[[accounts]]", 'name = "codex-main"', 'vendor = "codex"', 'location = "/nonexistent/.codex"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    (await HeadroomStore.open(root)).close();
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await runCli(["can", "review", "--owner", "tester", "--lease", "--json"]);
      // Fail-closed: a dispatch path never falls back to a cached decision,
      // it stays exactly as it behaved before this work -- a thrown error,
      // non-zero exit.
      expect(code).toBe(1);
      // Part 3: even on this thrown-error path, --json must still print a
      // JSON error object to stdout, never leave it empty.
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed.length).toBeGreaterThan(0);
      const payload = JSON.parse(printed) as { error?: string };
      expect(payload.error).toMatch(/did not respond within 2s/);
      expect(errSpy.mock.calls.join("\n")).toMatch(/headroom error/);
    } finally {
      logSpy.mockRestore(); errSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("a plain advisory `can` (no --lease) is also served from cache against the same unresponsive daemon", async () => {
    const root = await tempRoot("cache-can-noleaes");
    await writeFile(join(root, "routing.toml"), '[consumes]\nreview = ["codex-main:main"]\n', { mode: 0o600 });
    await writeFile(join(root, "accounts.toml"), ["[[accounts]]", 'name = "codex-main"', 'vendor = "codex"', 'location = "/nonexistent/.codex"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    (await HeadroomStore.open(root)).close();
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await runCli(["can", "review", "--owner", "tester", "--json"]);
      // No stored readings at all for codex-main:main -> UNKNOWN, refused,
      // but that is a decision, not a failure: it must still come back served
      // from cache rather than throwing.
      expect(code).toBe(2);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      const payload = JSON.parse(printed) as Record<string, unknown>;
      expect(payload.served_from).toBe("cache");
      expect(payload.daemon).toBe("unresponsive");
    } finally {
      logSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);
});

describe("MCP cached read-only fallback against a genuinely unresponsive daemon", () => {
  it.skipIf(process.platform === "win32")("`quota_status` is served from the read-only cache, flagged", async () => {
    const root = await tempRoot("mcp-cache-status");
    (await HeadroomStore.open(root)).close();
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      // No injected call/fallback: handleMcp's own default `daemonCall` is
      // what dials the real socket, the only path cacheEligible ever engages.
      const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_status", arguments: {} } })) as { result: { structuredContent: Record<string, unknown> } };
      const content = reply.result.structuredContent;
      expect(content.source).toBe("cache");
      expect(content.daemon).toBe("unresponsive");
      expect(content.observations).toEqual([]);
      // CLI/MCP parity: quota_status's cache path carries these two
      // additive fields exactly like `headroom status --json` does.
      expect(content.heartbeats).toEqual([]);
      expect(content.due_timers).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  // P2 fix: src/mcp.ts's cacheStatus/heartbeatFields hit the
  // same openReadOnly() connection as the CLI's cached path above, so a
  // pre-heartbeats-migration database must not fail `quota_status` either.
  it.skipIf(process.platform === "win32")("`quota_status` still succeeds from the cache on a pre-heartbeats-migration database", async () => {
    const root = await tempRoot("mcp-cache-status-old-schema");
    (await HeadroomStore.open(root)).close();
    rollBackHeartbeatsSchema(root);
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_status", arguments: {} } })) as { result: { structuredContent: Record<string, unknown> } };
      const content = reply.result.structuredContent;
      expect(content.source).toBe("cache");
      expect(content.daemon).toBe("unresponsive");
      expect(content.heartbeats).toEqual([]);
      expect(content.due_timers).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("`quota_lease_start` (a write path) still fails closed against the same unresponsive daemon", async () => {
    const root = await tempRoot("mcp-cache-lease-failclosed");
    (await HeadroomStore.open(root)).close();
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_lease_start", arguments: { meter_id: "codex-main:main", owner: "tester" } } })) as { error?: { message: string } };
      expect(reply.error?.message).toMatch(/did not respond within 2s/);
    } finally {
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("`quota_can` with `lease: true` (a dispatch path) still fails closed against the same unresponsive daemon", async () => {
    const root = await tempRoot("mcp-cache-can-lease-failclosed");
    await writeFile(join(root, "routing.toml"), '[consumes]\nreview = ["codex-main:main"]\n', { mode: 0o600 });
    await writeFile(join(root, "accounts.toml"), ["[[accounts]]", 'name = "codex-main"', 'vendor = "codex"', 'location = "/nonexistent/.codex"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    (await HeadroomStore.open(root)).close();
    const fake = await startFakeUnresponsiveDaemon(root, 5_000);
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_can", arguments: { action_class: "review", owner: "tester", lease: true, expect_percent: 5 } } })) as { error?: { message: string } };
      expect(reply.error?.message).toMatch(/did not respond within 2s/);
    } finally {
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
      fake.stop();
    }
  }, 20_000);
});
