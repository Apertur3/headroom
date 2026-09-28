/**
 * Orchestrator heartbeat leases and named wake-ups.
 * Covers store.ts's heartbeat/timer persistence and lapse/fire bookkeeping,
 * src/heartbeat.ts's inbox delivery, and the notifier picking up
 * heartbeat_lapsed/heartbeat_restored/timer_missed the same way it already
 * picks up every other event kind (quiet hours, one-message-per-lapse
 * dedupe).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import { fireDueTimers, parseTimerAt } from "../src/heartbeat.js";
import { readInbox, sendInboxMessage } from "../src/inbox.js";
import { handleMcp } from "../src/mcp.js";
import { deliverNotifications, parseNotifyConfig, type CommandRunner, type NotifyConfig, type NotifyOptions } from "../src/notify.js";
import { HeadroomStore } from "../src/store.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function tempHome(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return join(root, ".headroom");
}

async function openStore(prefix: string): Promise<{ store: HeadroomStore; home: string }> {
  const home = await tempHome(prefix);
  return { store: await HeadroomStore.open(home), home };
}

// ---------------------------------------------------------------------------
// store.ts: heartbeat record/refresh/stop
// ---------------------------------------------------------------------------

describe("heartbeat record/refresh/stop", () => {
  it("records, refreshes (keeping the resume sentence when omitted), and stops", async () => {
    const { store } = await openStore("headroom-heartbeat-basic-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const created = store.heartbeatBeat("orch-a", 5 * 60_000, "resume: check PR #78 CI", start);
      expect(created).toMatchObject({ owner: "orch-a", interval_ms: 300_000, resume_sentence: "resume: check PR #78 CI", started_at: start.toISOString(), last_beat_at: start.toISOString(), lapsed_since: null });

      const later = new Date(start.getTime() + 60_000);
      const refreshed = store.heartbeatBeat("orch-a", 300_000, undefined, later);
      expect(refreshed.resume_sentence).toBe("resume: check PR #78 CI");
      expect(refreshed.last_beat_at).toBe(later.toISOString());
      expect(refreshed.started_at).toBe(start.toISOString());

      const cleared = store.heartbeatBeat("orch-a", 300_000, null, later);
      expect(cleared.resume_sentence).toBeNull();

      expect(store.heartbeats()).toHaveLength(1);
      expect(store.heartbeatStop("orch-a")).toBe(true);
      expect(store.heartbeatStop("orch-a")).toBe(false);
      expect(store.heartbeats()).toHaveLength(0);
    } finally { store.close(); }
  });

  it("rejects a blank owner and a non-positive interval", async () => {
    const { store } = await openStore("headroom-heartbeat-invalid-");
    try {
      expect(() => store.heartbeatBeat("  ", 1000, null)).toThrow(/owner/);
      expect(() => store.heartbeatBeat("orch", 0, null)).toThrow(/interval/);
      expect(() => store.heartbeatBeat("orch", -1, null)).toThrow(/interval/);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: lapse detection with an injected clock
// ---------------------------------------------------------------------------

describe("heartbeat lapse detection", () => {
  it("does not lapse at exactly 2x the interval, but does the instant after", async () => {
    const { store } = await openStore("headroom-heartbeat-lapse-boundary-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 10 * 60_000;
      store.heartbeatBeat("orch-b", intervalMs, "resume: nothing to do", start);

      store.checkHeartbeatLapses(new Date(start.getTime() + 2 * intervalMs));
      expect(store.heartbeatLapsed("orch-b")).toBe(false);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_lapsed")).toHaveLength(0);

      store.checkHeartbeatLapses(new Date(start.getTime() + 2 * intervalMs + 1));
      expect(store.heartbeatLapsed("orch-b")).toBe(true);
      const lapsed = store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_lapsed");
      expect(lapsed).toHaveLength(1);
      expect(lapsed[0].metadata).toMatchObject({ owner: "orch-b", interval_ms: intervalMs, resume_sentence: "resume: nothing to do" });
    } finally { store.close(); }
  });

  it("never repeats the lapse event across later polls of the same open lapse", async () => {
    const { store } = await openStore("headroom-heartbeat-lapse-norepeat-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 5 * 60_000;
      store.heartbeatBeat("orch-c", intervalMs, null, start);
      const first = new Date(start.getTime() + 2 * intervalMs + 1_000);
      store.checkHeartbeatLapses(first);
      store.checkHeartbeatLapses(new Date(first.getTime() + 60_000));
      store.checkHeartbeatLapses(new Date(first.getTime() + 3_600_000));
      expect(store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_lapsed")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("a later beat closes the lapse and emits exactly one heartbeat_restored", async () => {
    const { store } = await openStore("headroom-heartbeat-restore-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 5 * 60_000;
      store.heartbeatBeat("orch-d", intervalMs, null, start);
      const lapsedAt = new Date(start.getTime() + 2 * intervalMs + 1_000);
      store.checkHeartbeatLapses(lapsedAt);
      expect(store.heartbeatLapsed("orch-d")).toBe(true);

      const resumeAt = new Date(lapsedAt.getTime() + 60_000);
      store.heartbeatBeat("orch-d", intervalMs, null, resumeAt);
      expect(store.heartbeatLapsed("orch-d")).toBe(false);

      const events = store.events(start.toISOString());
      expect(events.filter((event) => event.kind === "heartbeat_lapsed")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "heartbeat_restored")).toHaveLength(1);

      // Calling checkHeartbeatLapses again immediately after the restore must
      // not resurrect the closed lapse.
      store.checkHeartbeatLapses(new Date(resumeAt.getTime() + 1_000));
      expect(store.heartbeatLapsed("orch-d")).toBe(false);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "heartbeat_restored")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("an owner with no registered heartbeat is never considered lapsed", async () => {
    const { store } = await openStore("headroom-heartbeat-unregistered-");
    try {
      expect(store.heartbeatLapsed("nobody")).toBe(false);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// store.ts: timers
// ---------------------------------------------------------------------------

describe("timers", () => {
  it("sets, lists (pending only), and clears a named wake-up", async () => {
    const { store } = await openStore("headroom-timer-basic-");
    try {
      const createdAt = new Date("2026-09-28T12:00:00.000Z");
      const at = new Date("2026-09-28T12:05:00.000Z");
      const timer = store.setTimer("orch-e", "check-pr", at.toISOString(), "check PR #78 CI status", "notify", createdAt);
      expect(timer).toMatchObject({ owner: "orch-e", name: "check-pr", at: at.toISOString(), action: "check PR #78 CI status", if_missed: "notify", fired_at: null, cleared_at: null });

      expect(store.timers("orch-e")).toHaveLength(1);
      expect(store.timers()).toHaveLength(1);
      expect(store.dueTimers(new Date(at.getTime() - 60_000))).toHaveLength(0);
      expect(store.dueTimers(at)).toHaveLength(1);

      expect(store.clearTimer("orch-e", "check-pr")).toBe(true);
      expect(store.timers("orch-e")).toHaveLength(0);
      // Idempotent: clearing an already-cleared row is not an error.
      expect(store.clearTimer("orch-e", "check-pr")).toBe(true);
      expect(store.clearTimer("orch-e", "never-existed")).toBe(false);
    } finally { store.close(); }
  });

  it("re-setting the same owner+name replaces it and clears any prior fired/cleared state", async () => {
    const { store } = await openStore("headroom-timer-replace-");
    try {
      const now = new Date("2026-09-28T12:00:00.000Z");
      store.setTimer("orch-f", "wake", "2026-09-28T12:05:00.000Z", "first", "notify", now);
      store.clearTimer("orch-f", "wake");
      expect(store.timers("orch-f")).toHaveLength(0);
      const replaced = store.setTimer("orch-f", "wake", "2026-09-28T13:00:00.000Z", "second", "drop", now);
      expect(replaced).toMatchObject({ action: "second", if_missed: "drop", fired_at: null, cleared_at: null });
      expect(store.timers("orch-f")).toHaveLength(1);
    } finally { store.close(); }
  });
});

describe("parseTimerAt", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  it("accepts a relative duration", () => {
    expect(parseTimerAt("+30m", now)).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
    expect(parseTimerAt("+2h", now)).toBe(new Date(now.getTime() + 2 * 3_600_000).toISOString());
  });
  it("accepts and normalizes an ISO instant", () => {
    expect(parseTimerAt("2026-09-29T00:00:00Z", now)).toBe(new Date("2026-09-29T00:00:00Z").toISOString());
  });
  it("rejects anything else", () => {
    expect(() => parseTimerAt("tomorrow", now)).toThrow(/ISO instant or a relative duration/);
  });
});

// ---------------------------------------------------------------------------
// src/heartbeat.ts: fireDueTimers -- the daemon's async delivery pass
// ---------------------------------------------------------------------------

describe("fireDueTimers", () => {
  it("delivers exactly one inbox entry per due timer, and never twice", async () => {
    const { store, home } = await openStore("headroom-firedue-once-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-g", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));

      const firstPass = await fireDueTimers(store, home, at);
      expect(firstPass).toBe(1);
      const firstRead = await readInbox({ session: "orch-g", home, markRead: false });
      expect(firstRead.messages).toHaveLength(1);
      expect(firstRead.messages[0].body).toMatchObject({ timer: "wake", action: "check the deploy" });

      // The timer is now fired_at-marked; a later poll must not deliver it
      // again even though `at` is still in the past.
      const secondPass = await fireDueTimers(store, home, new Date(at.getTime() + 3_600_000));
      expect(secondPass).toBe(0);
      const secondRead = await readInbox({ session: "orch-g", home, markRead: false });
      expect(secondRead.messages).toHaveLength(1);
    } finally { store.close(); }
  });

  it("two overlapping passes with a slow inbox sender never deliver the same timer twice", async () => {
    const { store, home } = await openStore("headroom-firedue-overlap-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-overlap", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));

      let releaseFirst: () => void;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const sent: string[] = [];
      const slowSend: typeof sendInboxMessage = async (options) => {
        sent.push(options.to);
        await gate; // held open until the test explicitly releases it
        return sendInboxMessage(options);
      };

      // Started but not awaited: this pass claims the timer synchronously
      // (store.claimTimer runs before the first await inside slowSend) and
      // then blocks on the gate, exactly like a slow inbox write outlasting
      // the daemon's own 15s poll throttle.
      const firstPass = fireDueTimers(store, home, at, undefined, slowSend);
      // A second, independent pass starts while the first is still stuck in
      // its slow send. Its own dueTimers() scan must no longer see the
      // timer at all -- claimTimer already marked it fired_at the instant
      // the first pass claimed it -- so this resolves immediately without
      // ever touching slowSend.
      const secondPass = await fireDueTimers(store, home, at, undefined, slowSend);
      expect(secondPass).toBe(0);
      expect(sent).toEqual(["orch-overlap"]); // only the first pass ever called send

      releaseFirst!();
      expect(await firstPass).toBe(1);

      const inbox = await readInbox({ session: "orch-overlap", home, markRead: false });
      expect(inbox.messages).toHaveLength(1);
    } finally { store.close(); }
  });

  it("un-claims a timer whose inbox delivery fails, so a later pass can retry and succeed", async () => {
    const { store, home } = await openStore("headroom-firedue-retry-");
    try {
      const at = new Date("2026-09-28T12:05:00.000Z");
      store.setTimer("orch-retry", "wake", at.toISOString(), "check the deploy", "notify", new Date("2026-09-28T12:00:00.000Z"));

      const failingSend: typeof sendInboxMessage = async () => { throw new Error("simulated inbox write failure"); };
      const failedPass = await fireDueTimers(store, home, at, undefined, failingSend);
      expect(failedPass).toBe(0);
      // Un-claimed: the timer is pending again, not lost.
      expect(store.timers("orch-retry")).toHaveLength(1);
      expect((await readInbox({ session: "orch-retry", home, markRead: false })).messages).toHaveLength(0);

      const retryPass = await fireDueTimers(store, home, new Date(at.getTime() + 60_000));
      expect(retryPass).toBe(1);
      expect(store.timers("orch-retry")).toHaveLength(0);
      expect((await readInbox({ session: "orch-retry", home, markRead: false })).messages).toHaveLength(1);
    } finally { store.close(); }
  });

  it("still delivers the inbox entry with --if-missed drop, but raises no timer_missed event even while the owner's heartbeat is lapsed", async () => {
    const { store, home } = await openStore("headroom-firedue-drop-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 60_000;
      store.heartbeatBeat("orch-h", intervalMs, null, start);
      const at = new Date(start.getTime() + 2 * intervalMs + 5_000);
      store.checkHeartbeatLapses(at);
      expect(store.heartbeatLapsed("orch-h")).toBe(true);

      store.setTimer("orch-h", "silent-check", at.toISOString(), "check silently", "drop", start);
      const fired = await fireDueTimers(store, home, at);
      expect(fired).toBe(1);
      const inbox = await readInbox({ session: "orch-h", home, markRead: false });
      expect(inbox.messages).toHaveLength(1);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "timer_missed")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("raises one timer_missed event when --if-missed notify fires while the owner's heartbeat is lapsed, and none while it is not", async () => {
    const { store, home } = await openStore("headroom-firedue-notify-");
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 60_000;

      // Not lapsed: a due timer for an owner who is beating on schedule
      // raises no timer_missed at all.
      store.heartbeatBeat("orch-i", intervalMs, null, start);
      store.setTimer("orch-i", "on-time-check", start.toISOString(), "check on time", "notify", start);
      await fireDueTimers(store, home, start);
      expect(store.events(start.toISOString()).filter((event) => event.kind === "timer_missed")).toHaveLength(0);

      // Lapsed: a due timer for an owner whose heartbeat has lapsed raises
      // exactly one timer_missed.
      const lapsedAt = new Date(start.getTime() + 2 * intervalMs + 5_000);
      store.checkHeartbeatLapses(lapsedAt);
      expect(store.heartbeatLapsed("orch-i")).toBe(true);
      store.setTimer("orch-i", "missed-check", lapsedAt.toISOString(), "check while unattended", "notify", start);
      await fireDueTimers(store, home, lapsedAt);
      const missed = store.events(start.toISOString()).filter((event) => event.kind === "timer_missed");
      expect(missed).toHaveLength(1);
      // The owner is an orchestrator identity, not a vendor account: it
      // belongs in metadata/reason only, never in principal_id -- same
      // convention as heartbeat_lapsed/heartbeat_restored.
      expect(missed[0].principal_id).toBeNull();
      expect(missed[0].metadata).toMatchObject({ owner: "orch-i", timer_name: "missed-check", action: "check while unattended" });
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// notify.ts integration: heartbeat_lapsed/heartbeat_restored/timer_missed go
// through the exact same ledger dedupe and quiet-hours gate as every other
// event kind -- no bespoke delivery path.
// ---------------------------------------------------------------------------

const TOKEN = "1234567:AA-not-a-real-token";
const CONFIG = `
[notify]
channels = ["telegram"]
events = ["heartbeat_lapsed", "heartbeat_restored", "timer_missed"]

[notify.telegram]
chat_id = "555"
`;

function config(): NotifyConfig {
  const parsed = parseNotifyConfig(CONFIG);
  if (!parsed) throw new Error("expected a notify config");
  return parsed;
}

const secretStore: CommandRunner = async () => `${TOKEN}\n`;

interface Call { url: string; body: string; }
function recorder(): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input) => {
    const request = input as Request;
    calls.push({ url: request.url, body: await request.text() });
    return new Response("ok", { status: 200 });
  };
  return { calls, fetcher };
}

function options(extra: Partial<NotifyOptions> = {}): NotifyOptions {
  return { config: config(), platform: "darwin", run: secretStore, log: async () => undefined, ...extra };
}

describe("notify integration", () => {
  it("delivers one message for a lapse, never repeats it across polls, and delivers one restore message", async () => {
    const { store } = await openStore("headroom-notify-heartbeat-");
    const { calls, fetcher } = recorder();
    try {
      const start = new Date("2026-09-28T12:00:00.000Z");
      const intervalMs = 5 * 60_000;
      // Priming pass before anything exists: establishes the discovery
      // marker so only what happens after this counts as "new".
      await deliverNotifications(store, options({ fetcher, now: start }));
      expect(calls).toHaveLength(0);

      store.heartbeatBeat("orch-j", intervalMs, "resume: rerun the deploy", start);
      const lapsedAt = new Date(start.getTime() + 2 * intervalMs + 1_000);
      store.checkHeartbeatLapses(lapsedAt);

      const firstPass = await deliverNotifications(store, options({ fetcher, now: lapsedAt }));
      expect(firstPass.sent).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toContain("Heartbeat lapsed");
      expect(calls[0].body).toContain("orch-j");
      expect(calls[0].body).toContain("resume: rerun the deploy");

      // A later poll before anything changes must never resend it.
      const secondPass = await deliverNotifications(store, options({ fetcher, now: new Date(lapsedAt.getTime() + 60_000) }));
      expect(secondPass.sent).toBe(0);
      expect(calls).toHaveLength(1);

      const resumeAt = new Date(lapsedAt.getTime() + 120_000);
      store.heartbeatBeat("orch-j", intervalMs, null, resumeAt);
      const thirdPass = await deliverNotifications(store, options({ fetcher, now: resumeAt }));
      expect(thirdPass.sent).toBe(1);
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toContain("Heartbeat restored");
      expect(calls[1].body).toContain("orch-j");
    } finally { store.close(); }
  });

  it("holds a lapse message through quiet hours and sends it once quiet hours end", async () => {
    const { store } = await openStore("headroom-notify-heartbeat-quiet-");
    const { calls, fetcher } = recorder();
    try {
      const night = new Date(2026, 8, 28, 23, 30);
      const morning = new Date(2026, 8, 29, 8, 0);
      const quiet = { ...config(), quiet_hours: { start: 23 * 60, end: 7 * 60 } };
      await deliverNotifications(store, options({ config: quiet, fetcher, now: new Date(night.getTime() - 3_600_000) }));

      store.heartbeatBeat("orch-k", 60_000, "resume: nothing", new Date(night.getTime() - 200_000));
      store.checkHeartbeatLapses(new Date(night.getTime() - 60_000));

      const held = await deliverNotifications(store, options({ config: quiet, fetcher, now: night }));
      expect(held).toMatchObject({ quiet: true, sent: 0 });
      expect(calls).toHaveLength(0);
      expect(store.notifyPending("telegram")).toHaveLength(1);

      const sent = await deliverNotifications(store, options({ config: quiet, fetcher, now: morning }));
      expect(sent.sent).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toContain("Heartbeat lapsed");
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// mcp.ts: quota_heartbeat -- both the daemon-code-path wrapping (a stubbed
// `call`, no real socket) and the direct fallback (no daemon at all).
// ---------------------------------------------------------------------------

describe("quota_heartbeat", () => {
  it("wraps a daemon-sourced beat and stop reply the same shape as the direct fallback", async () => {
    const home = await tempHome("headroom-mcp-heartbeat-daemon-");
    await withHeadroomHome(home, async () => {
      const beat = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_heartbeat","arguments":{"owner":"triage-bot","interval_ms":300000,"resume_sentence":"rerun the deploy"}}}', async (method, params) => {
        expect(method).toBe("heartbeat_beat");
        expect(params).toMatchObject({ owner: "triage-bot", interval_ms: 300_000, resume_sentence: "rerun the deploy" });
        return { owner: "triage-bot", interval_ms: 300_000, resume_sentence: "rerun the deploy", started_at: "2026-09-28T12:00:00.000Z", last_beat_at: "2026-09-28T12:00:00.000Z", lapsed_since: null, updated_at: "2026-09-28T12:00:00.000Z" };
      });
      expect(beat).toMatchObject({ result: { structuredContent: { source: "daemon", heartbeat: { owner: "triage-bot", interval_ms: 300_000 } } } });

      const stop = await handleMcp('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quota_heartbeat","arguments":{"owner":"triage-bot","stop":true}}}', async (method, params) => {
        expect(method).toBe("heartbeat_stop");
        expect(params).toEqual({ owner: "triage-bot" });
        return { stopped: true };
      });
      expect(stop).toMatchObject({ result: { structuredContent: { source: "daemon", stopped: true } } });
    });
  });

  it("beats and stops directly with no daemon running, deriving an owner when none is given", async () => {
    const home = await tempHome("headroom-mcp-heartbeat-direct-");
    await withHeadroomHome(home, async () => {
      const beat = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_heartbeat","arguments":{"interval_ms":60000}}}', async () => undefined);
      const structured = (beat as { result: { structuredContent: { source: string; heartbeat: { owner: string; interval_ms: number } } } }).result.structuredContent;
      expect(structured.source).toBe("direct");
      expect(structured.heartbeat.interval_ms).toBe(60_000);
      expect(structured.heartbeat.owner).toMatch(/^mcp-client#/);

      const store = await HeadroomStore.open(home);
      try { expect(store.heartbeats()).toHaveLength(1); } finally { store.close(); }
    });
  });
});

// ---------------------------------------------------------------------------
// CLI/MCP parity: quota_status must carry heartbeats/due_timers exactly like
// `headroom status --json` does, over every path -- daemon, direct, and
// cache (the cache path is exercised in test/cached-reads.test.ts's own
// "quota_status is served from the read-only cache, flagged" test).
// ---------------------------------------------------------------------------

describe("quota_status daemon-path parity", () => {
  it("carries heartbeats and due_timers from a real (in-process) daemon's own store, via the heartbeats/timer_list RPCs quota_status now calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-mcp-status-parity-"));
    temporary.push(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: join(root, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
    try {
      const internal = daemon as unknown as { store: HeadroomStore };
      const now = new Date("2026-09-28T12:00:00.000Z");
      internal.store.heartbeatBeat("cadence", 60_000, "resume: rerun the deploy", new Date(now.getTime() - 3 * 60_000));
      internal.store.checkHeartbeatLapses(now);
      // mcp.ts's own due-timer filter (unlike the store methods above) uses
      // the real wall clock, since it runs inside production dispatch code
      // with no injected test clock -- the timer's `at` must therefore be
      // safely in the past relative to real now, not merely before the
      // fixture's own fixed `now`.
      internal.store.setTimer("cadence", "check-pr", "2020-01-01T00:00:00.000Z", "check PR CI status", "notify", new Date(now.getTime() - 60_000));
      // The "status" RPC's own poll() call fires any currently-due timer as
      // a real side effect (see daemon.ts's own throttled block) -- correct
      // production behavior, but it would otherwise consume this test's
      // timer before quota_status ever gets to read it back as "due".
      // Pre-claiming the same throttle key is exactly what a status call a
      // few seconds earlier would already have done, and isolates the
      // wiring this test is actually about: that quota_status's `due_timers`
      // reads from the same store this timer was seeded into.
      internal.store.claimDaemonInterval("heartbeat_timer_check", new Date(), 15_000);

      // A stand-in for daemonCall that dispatches to this same in-process
      // daemon's private handleLine() (authedHandleLine, the project's own
      // helper for exactly this) instead of dialing a real socket -- the
      // point here is exercising handleMcp's own daemon-array-normalization
      // path (mcp.ts's `method === "status" && Array.isArray(finalResult)`
      // branch, which now also calls "heartbeats"/"timer_list"), not the
      // socket transport itself.
      const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const reply = await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
      };
      const response = await handleMcp('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}', call);
      const structured = (response as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      expect(structured.heartbeats).toEqual([expect.objectContaining({ owner: "cadence", resume_sentence: "resume: rerun the deploy", lapsed_since: expect.any(String) })]);
      expect(structured.due_timers).toEqual([expect.objectContaining({ owner: "cadence", name: "check-pr", action: "check PR CI status" })]);
    } finally { await daemon.stop(); }
  });
});
