import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HeadroomDaemon, rpc, socketPath } from "../src/daemon.js";
import { deliverNotifications, parseNotifyConfig } from "../src/notify.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

it.each([false, true])("delivers a confirmed reset once, including a delayed confirmation insert (%s)", async (delayed) => {
  const home = await mkdtemp(join(tmpdir(), "headroom-reset-alert-"));
  let store = await HeadroomStore.open(join(home, "state"));
  const delivered: unknown[] = [];
  const config = parseNotifyConfig('[notify]\nchannels = ["webhook"]\npreset = "quiet"\n[notify.webhook]\nurl = "https://example.com/notify"\n')!;
  const poll = (at: string) => deliverNotifications(store, {
    home, config, now: new Date(at),
    run: async () => { throw new Error("no test credential"); },
    fetcher: async (input) => { delivered.push(JSON.parse(await (input as Request).text())); return new Response("ok"); },
    log: async () => undefined,
  });
  const reading = (used: number, at: string, reset: string): Observation => ({
    principal_id: "codex-main", meter_id: "codex-main:main",
    window: { kind: "fixed", minutes: 10080, enforcement: "hard" },
    quantity: { used, remaining: 100 - used, limit: 100, unit: "percent" },
    fetched_at: at, observed_at: at, resets_at: reset,
    source: "synthetic", truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "fixture", upstream_schema_version: "fixture",
  });
  try {
    store.insert(reading(82, "2026-09-12T08:07:00Z", "2026-09-15T09:55:00Z"));
    await poll("2026-09-12T08:07:01Z");
    store.insert(reading(0, "2026-09-12T08:12:00Z", "2026-09-19T08:09:00Z"));
    await poll("2026-09-12T08:12:01Z");
    expect(delivered).toHaveLength(0);
    // A faster principal finishes while this confirmation fetch is in flight.
    // Both occurrence and confirming fetched_at now precede the old watermark.
    if (delayed) await poll("2026-09-12T08:17:05Z");
    store.insert(reading(0, "2026-09-12T08:17:00Z", "2026-09-19T08:09:00Z"));
    expect(store.events("2026-09-12T08:00:00Z").find(event => event.kind === "reset_seen")).toMatchObject({
      created_at: "2026-09-12T08:12:00Z", metadata: { unscheduled: true },
    });
    store.close();
    store = await HeadroomStore.open(join(home, "state"));
    await poll("2026-09-12T08:17:10Z");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ event: "reset_seen", meter: "codex-main:main" });
    await poll("2026-09-12T08:22:01Z");
    expect(delivered).toHaveLength(1);
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});

it("queues ledger rows and advances discovery atomically, then retries after an enqueue failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "headroom-reset-atomic-"));
  const store = await HeadroomStore.open(join(home, "state"));
  let sent = 0;
  const config = parseNotifyConfig('[notify]\nchannels = ["webhook"]\nevents = ["lease_started"]\n[notify.webhook]\nurl = "https://example.com/notify"\n')!;
  const poll = () => deliverNotifications(store, {
    home, config, run: async () => { throw new Error("no test credential"); },
    fetcher: async () => { sent++; return new Response("ok"); }, log: async () => undefined,
  });
  try {
    // A legacy timestamp does not replay historical events on upgrade.
    store.setDaemonState("notify_watermark", "2000-01-01T00:00:00Z");
    store.startLease("fixture", "codex-main:main", 1, 60_000, null);
    await poll();
    expect(sent).toBe(0);
    store.startLease("fixture", "codex-main:spark", 1, 60_000, null);
    const enqueue = store.notifyEnqueue.bind(store);
    vi.spyOn(store, "notifyEnqueue").mockImplementationOnce((...args) => {
      enqueue(...args);
      throw new Error("synthetic crash after ledger insert");
    });
    await expect(poll()).rejects.toThrow("synthetic crash");
    expect(store.notifyLedger(20)).toHaveLength(0);
    expect(sent).toBe(0);
    await poll();
    await poll();
    expect(sent).toBe(1);
    expect(store.notifyLedger(20)).toHaveLength(1);
  } finally { vi.restoreAllMocks(); store.close(); await rm(home, { recursive: true, force: true }); }
});

it("keeps discovery durable across event cleanup and VACUUM without exposing its marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "headroom-reset-cursor-"));
  const store = await HeadroomStore.open(home);
  const raw = new DatabaseSync(join(home, "headroom.db"));
  try {
    store.startLease("fixture", "codex-main:main", 1, 60_000, null);
    store.enqueueNotificationEvents((events) => { expect(events).toBeUndefined(); return 0; });
    raw.exec("DELETE FROM events");
    store.startLease("fixture", "codex-main:spark", 1, 60_000, null);
    raw.exec("VACUUM");
    store.initializeNotificationEvents(); // restart must not swallow this row
    store.enqueueNotificationEvents((events) => {
      expect(events).toEqual([expect.objectContaining({ kind: "lease_started", meter_id: "codex-main:spark" })]);
      return 1;
    });
    raw.exec("DELETE FROM events");
    raw.exec("VACUUM");
    store.insert({
      principal_id: "codex-main", meter_id: "codex-main:main", window: null, quantity: null, resets_at: null,
      observed_at: "2026-09-12T08:00:00Z", fetched_at: "2026-09-12T08:00:00Z",
      source: "synthetic", truth: "official", freshness: "failed", confidence: 0,
      adapter_version: "fixture", upstream_schema_version: "fixture", reason: "synthetic failure",
    });
    store.enqueueNotificationEvents((events) => {
      expect(events).toEqual([expect.objectContaining({ kind: "source_failed" })]);
      return 1;
    });
    expect(store.events("2000-01-01")[0]?.metadata).toBeUndefined();
  } finally { raw.close(); store.close(); await rm(home, { recursive: true, force: true }); }
});

it.each([true, false])("delivers the first daemon reset after startup or enabling notifications (configured at startup: %s)", async (configuredAtStartup) => {
  // The daemon canonicalizes its home before deriving the Windows pipe name
  // and notification coalescing key. Use the same spelling on the client:
  // Windows TEMP can contain an 8.3 alias such as RUNNER~1.
  const home = await realpath(await mkdtemp(join(tmpdir(), "headroom-reset-startup-")));
  const previousHome = process.env.HEADROOM_HOME;
  const priorSighup = process.listeners("SIGHUP");
  const store = await HeadroomStore.open(home);
  let daemon: HeadroomDaemon | undefined;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  const now = Date.now();
  const reading = (used: number, at: number, reset: number): Observation => ({
    principal_id: "codex-main", meter_id: "codex-main:main",
    window: { kind: "fixed", minutes: 10080, enforcement: "hard" },
    quantity: { used, remaining: 100 - used, limit: 100, unit: "percent" },
    fetched_at: new Date(at).toISOString(), observed_at: new Date(at).toISOString(), resets_at: new Date(reset).toISOString(),
    source: "synthetic", truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "fixture", upstream_schema_version: "fixture",
  });
  try {
    process.env.HEADROOM_HOME = home;
    const configure = () => writeFile(join(home, "policy.toml"), '[notify]\nchannels = ["ntfy"]\npreset = "calm"\n[notify.ntfy]\ntopic = "synthetic-fixture"\n');
    if (configuredAtStartup) await configure();
    store.insert(reading(82, now - 120_000, now - 60_000));
    store.setDaemonState("notify_watermark", new Date(now - 100_000).toISOString());
    const poller = vi.fn(async () => ({ observations: [reading(0, now, now + 7 * 86_400_000)], failures: [] }));
    daemon = await HeadroomDaemon.create({ home, poller });
    await daemon.start();
    expect(fetcher).not.toHaveBeenCalled();
    if (!configuredAtStartup) await configure();
    expect(await rpc(socketPath(home), "refresh")).toMatchObject({
      observations: [expect.objectContaining({ quantity: expect.objectContaining({ used: 0 }) })], failures: [],
    });
    expect(poller).toHaveBeenCalledOnce();
    // Join the daemon's in-flight delivery; no real transport or credentials.
    await deliverNotifications(store, { home });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(store.notifyLedger(20)).toEqual([expect.objectContaining({ status: "sent" })]);
    expect(store.events("2000-01-01").find((event) => event.kind === "reset_seen")?.metadata).toMatchObject({ window_minutes: 10080 });
    expect(JSON.stringify(store.events("2000-01-01"))).not.toContain("_notify_seen");
  } finally {
    if (daemon) await daemon.stop();
    for (const listener of process.listeners("SIGHUP")) if (!priorSighup.includes(listener)) process.removeListener("SIGHUP", listener);
    if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
    vi.restoreAllMocks(); store.close(); await rm(home, { recursive: true, force: true });
  }
});
