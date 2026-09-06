import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, deliverNotifications, formatLedger, parseNotifyConfig, type CommandRunner, type NotifyConfig, type NotifyOptions } from "../src/notify.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const TOKEN = "9876543:AA-not-a-real-token";
const CONFIG = `
[notify]
channels = ["telegram", "ntfy", "webhook"]
events = ["reset_seen", "source_failed", "model_new", "threshold"]
threshold_percent = 90

[notify.telegram]
chat_id = "123456"

[notify.ntfy]
topic = "headroom-example"

[notify.webhook]
url = "https://example.com/hook"
`;

function config(text = CONFIG): NotifyConfig {
  const parsed = parseNotifyConfig(text);
  if (!parsed) throw new Error("expected a notify config");
  return parsed;
}

const secretStore: CommandRunner = async (_command, args) => {
  if (args.includes("headroom-telegram")) return `${TOKEN}\n`;
  throw new Error("not found");
};

interface Call { url: string; method: string; headers: Record<string, string>; body: string; }

function recorder(responder?: (call: Call, index: number) => Response): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input) => {
    const request = input as Request;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const call = { url: request.url, method: request.method, headers, body: await request.text() };
    calls.push(call);
    return responder ? responder(call, calls.length - 1) : new Response("ok", { status: 200 });
  };
  return { calls, fetcher };
}

async function openStore(prefix: string): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

function weekly(used: number, fetchedAt: string, resetsAt: string, meterId = "claude-main:all"): Observation {
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

/** A reset the detector classifies as reset_seen: the reset timestamp moved a
 * full week forward while a minute of real time passed. */
function seedReset(store: HeadroomStore): void {
  store.insert(weekly(90, "2026-09-03T12:00:00Z", "2026-09-06T13:59:00Z"));
  store.insert(weekly(3, "2026-09-03T12:01:00Z", "2026-09-13T13:59:00Z"));
}

function options(extra: Partial<NotifyOptions> = {}): NotifyOptions {
  return { config: config(), platform: "darwin", run: secretStore, log: async () => undefined, ...extra };
}

const START = new Date("2026-09-03T11:00:00Z");
const AFTER = new Date("2026-09-03T12:05:00Z");
const LATER = new Date("2026-09-03T12:10:00Z");

describe("notification delivery", () => {
  it("sends nothing on the first pass, then one message per channel for a new event", async () => {
    const store = await openStore("headroom-notify-first-");
    const { calls, fetcher } = recorder();
    try {
      const first = await deliverNotifications(store, options({ fetcher, now: START }));
      expect(first).toMatchObject({ configured: true, queued: 0, sent: 0 });
      expect(calls).toHaveLength(0);
      seedReset(store);
      const second = await deliverNotifications(store, options({ fetcher, now: AFTER }));
      expect(second.sent).toBe(3);
      expect(calls).toHaveLength(3);

      const telegram = calls.find((call) => call.url.startsWith("https://api.telegram.org"));
      expect(telegram?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
      expect(JSON.parse(telegram?.body ?? "{}")).toEqual({ chat_id: "123456", text: "Headroom: reset_seen claude-main:all" });
      expect(telegram?.body).not.toContain("parse_mode");

      const ntfy = calls.find((call) => call.url === "https://ntfy.sh/headroom-example");
      expect(ntfy?.method).toBe("POST");
      expect(ntfy?.headers.title).toBe("Headroom");
      expect(ntfy?.body).toBe("Headroom: reset_seen claude-main:all");

      const webhook = calls.find((call) => call.url === "https://example.com/hook");
      expect(JSON.parse(webhook?.body ?? "{}")).toEqual({
        event: "reset_seen", meter: "claude-main:all", principal: "claude-main",
        at: "2026-09-03T12:01:00Z", text: "reset_seen claude-main:all",
      });
      expect(webhook?.headers.authorization).toBeUndefined();
    } finally { store.close(); }
  });

  it("never delivers the same event twice, however often the daemon polls", async () => {
    const store = await openStore("headroom-notify-dedupe-");
    const { calls, fetcher } = recorder();
    try {
      await deliverNotifications(store, options({ fetcher, now: START }));
      seedReset(store);
      await deliverNotifications(store, options({ fetcher, now: AFTER }));
      const afterFirst = calls.length;
      await deliverNotifications(store, options({ fetcher, now: LATER }));
      await deliverNotifications(store, options({ fetcher, now: new Date("2026-09-03T12:15:00Z") }));
      expect(calls).toHaveLength(afterFirst);
      const ledger = store.notifyLedger(20);
      expect(ledger).toHaveLength(3);
      for (const row of ledger) expect(row).toMatchObject({ status: "sent", attempts: 0 });
    } finally { store.close(); }
  });

  it("holds events through quiet hours and sends them as one batched message", async () => {
    const store = await openStore("headroom-notify-quiet-");
    const { calls, fetcher } = recorder();
    // Local wall-clock hours, so the range is built around the test clock's own
    // local time rather than a fixed UTC hour.
    const night = new Date(2026, 8, 3, 23, 30);
    const morning = new Date(2026, 8, 4, 8, 0);
    const quiet = { ...config(), channels: ["ntfy"] as NotifyConfig["channels"], quiet_hours: { start: 23 * 60, end: 7 * 60 } };
    try {
      await deliverNotifications(store, options({ config: quiet, fetcher, now: new Date(night.getTime() - 3_600_000) }));
      store.insert(weekly(90, new Date(night.getTime() - 120_000).toISOString(), "2026-09-06T13:59:00Z"));
      store.insert(weekly(3, new Date(night.getTime() - 60_000).toISOString(), "2026-09-13T13:59:00Z"));
      store.insert(weekly(80, new Date(night.getTime() - 30_000).toISOString(), "2026-09-13T13:59:00Z", "claude-main:fable"));
      const held = await deliverNotifications(store, options({ config: quiet, fetcher, now: night }));
      expect(held).toMatchObject({ quiet: true, sent: 0 });
      expect(calls).toHaveLength(0);
      expect(store.notifyPending("ntfy")).toHaveLength(2);

      const sent = await deliverNotifications(store, options({ config: quiet, fetcher, now: morning }));
      expect(sent.sent).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toContain("Headroom: 2 events");
      expect(calls[0].body).toContain("- reset_seen claude-main:all");
      expect(calls[0].body).toContain("- model_new claude-main:fable: fable");
    } finally { store.close(); }
  });

  it("notifies a threshold crossing once per window and again only after the window resets", async () => {
    const store = await openStore("headroom-notify-threshold-");
    const { calls, fetcher } = recorder();
    const only = { ...config(), channels: ["ntfy"] as NotifyConfig["channels"], events: ["threshold"] };
    try {
      await deliverNotifications(store, options({ config: only, fetcher, now: START }));
      store.insert(weekly(80, "2026-09-03T12:00:00Z", "2026-09-06T13:59:00Z"));
      expect((await deliverNotifications(store, options({ config: only, fetcher, now: AFTER }))).sent).toBe(0);

      store.insert(weekly(93, "2026-09-03T12:06:00Z", "2026-09-06T13:59:00Z"));
      expect((await deliverNotifications(store, options({ config: only, fetcher, now: LATER }))).sent).toBe(1);
      expect(calls[0].body).toBe("Headroom: claude-main:all wk at 93% used (threshold 90%)");

      store.insert(weekly(95, "2026-09-03T12:11:00Z", "2026-09-06T13:59:00Z"));
      await deliverNotifications(store, options({ config: only, fetcher, now: new Date("2026-09-03T12:15:00Z") }));
      expect(calls).toHaveLength(1);

      // The window reset and filled up again: a new window instance, so a new
      // crossing is worth a message.
      store.insert(weekly(91, "2026-09-06T14:05:00Z", "2026-09-13T13:59:00Z"));
      await deliverNotifications(store, options({ config: only, fetcher, now: new Date("2026-09-06T14:06:00Z") }));
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toContain("91% used");
    } finally { store.close(); }
  });

  it("chunks a long batch into several telegram messages under the size cap", async () => {
    const store = await openStore("headroom-notify-chunk-");
    const { calls, fetcher } = recorder();
    const only = { ...config(), channels: ["telegram"] as NotifyConfig["channels"], events: ["source_failed"] };
    try {
      await deliverNotifications(store, options({ config: only, fetcher, now: START }));
      // Long meter names, not a long reason: a failure reason only reaches the
      // event when the detector inferred it, so the meter is what makes these
      // lines long enough to need more than one message.
      for (let index = 0; index < 6; index += 1) {
        store.insert({
          ...weekly(10, `2026-09-03T12:0${index}:00Z`, "2026-09-06T13:59:00Z", `claude-main:pool-${index}-${"x".repeat(900)}`),
          quantity: null, freshness: "failed", reason: "no credentials",
        });
      }
      const run = await deliverNotifications(store, options({ config: only, fetcher, now: AFTER }));
      expect(run.sent).toBe(6);
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) expect((JSON.parse(call.body) as { text: string }).text.length).toBeLessThanOrEqual(3800);
    } finally { store.close(); }
  });

  it("retries a failing channel up to the attempt cap, keeps the secret out of the ledger and the log, then gives up", async () => {
    const store = await openStore("headroom-notify-retry-");
    const logged: string[] = [];
    const { calls, fetcher } = recorder(() => new Response(`bad token bot${TOKEN}`, { status: 401 }));
    const only = { ...config(), channels: ["telegram"] as NotifyConfig["channels"], events: ["reset_seen"] };
    const log = async (message: string) => { logged.push(message); };
    try {
      await deliverNotifications(store, options({ config: only, fetcher, log, now: START }));
      seedReset(store);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS + 2; attempt += 1) {
        await deliverNotifications(store, options({ config: only, fetcher, log, now: new Date(AFTER.getTime() + attempt * 60_000) }));
      }
      expect(calls).toHaveLength(MAX_ATTEMPTS);
      const [row] = store.notifyLedger(5);
      expect(row).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, channel: "telegram" });
      expect(row.detail).toContain("401");
      expect(row.detail).not.toContain(TOKEN);
      expect(logged).toHaveLength(2);
      expect(logged.join("\n")).not.toContain(TOKEN);
      expect(logged[1]).toContain("gave up");
      expect(formatLedger([row]).join("")).not.toContain(TOKEN);
    } finally { store.close(); }
  });

  it("refuses a redirect and a host outside the channel allowlist", async () => {
    const store = await openStore("headroom-notify-redirect-");
    const redirect = recorder(() => new Response("", { status: 302, headers: { location: "https://elsewhere.example/steal" } }));
    const only = { ...config(), channels: ["ntfy"] as NotifyConfig["channels"], events: ["reset_seen"] };
    try {
      await deliverNotifications(store, options({ config: only, fetcher: redirect.fetcher, now: START }));
      seedReset(store);
      await deliverNotifications(store, options({ config: only, fetcher: redirect.fetcher, now: AFTER }));
      expect(store.notifyLedger(5)[0].detail).toContain("redirect refused");

      // A response that reports a final URL on another host is refused too,
      // even when the request itself went to the configured server.
      const moved = recorder(() => Response.json({ ok: true }, { status: 200 }));
      const store2 = await openStore("headroom-notify-host-");
      const elsewhere = { ...only, ntfy: { topic: "headroom-example", server: "https://ntfy.example.com" } };
      await deliverNotifications(store2, options({ config: elsewhere, fetcher: moved.fetcher, now: START }));
      seedReset(store2);
      await deliverNotifications(store2, options({ config: elsewhere, fetcher: moved.fetcher, now: AFTER }));
      expect(moved.calls[0].url).toBe("https://ntfy.example.com/headroom-example");
      store2.close();
    } finally { store.close(); }
  });

  it("disables a channel with a reason logged once and delivers over the others", async () => {
    const store = await openStore("headroom-notify-disabled-");
    const logged: string[] = [];
    const { calls, fetcher } = recorder();
    const log = async (message: string) => { logged.push(message); };
    const noStore: CommandRunner = async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
    try {
      await deliverNotifications(store, options({ fetcher, log, run: noStore, now: START }));
      seedReset(store);
      const run = await deliverNotifications(store, options({ fetcher, log, run: noStore, now: AFTER }));
      await deliverNotifications(store, options({ fetcher, log, run: noStore, now: LATER }));
      expect(run.channels.find((channel) => channel.channel === "telegram")).toMatchObject({ ready: false });
      expect(logged.filter((line) => line.includes("notify telegram disabled"))).toHaveLength(1);
      expect(logged[0]).toContain("security is not installed");
      // ntfy and webhook still delivered; telegram never queued a row.
      expect(calls.map((call) => new URL(call.url).host).sort()).toEqual(["example.com", "ntfy.sh"]);
      expect(store.notifyLedger(10).every((row) => row.channel !== "telegram")).toBe(true);
    } finally { store.close(); }
  });

  it("does nothing at all when policy.toml has no notify section", async () => {
    const store = await openStore("headroom-notify-off-");
    const { calls, fetcher } = recorder();
    try {
      const root = await mkdtemp(join(tmpdir(), "headroom-notify-empty-home-"));
      temporary.push(root);
      const run = await deliverNotifications(store, { home: root, fetcher, now: START });
      expect(run).toMatchObject({ configured: false, sent: 0 });
      expect(calls).toHaveLength(0);
    } finally { store.close(); }
  });
});

describe("model_new", () => {
  it("records a bucket name the vendor has not reported before for a principal it already knows", async () => {
    const store = await openStore("headroom-notify-model-new-");
    try {
      store.insert(weekly(10, "2026-09-03T12:00:00Z", "2026-09-06T13:59:00Z"));
      // Every meter of a brand new principal is new; that is a first poll, not
      // a model release, and must stay quiet.
      expect(store.events("2026-09-01T00:00:00Z").filter((event) => event.kind === "model_new")).toHaveLength(0);
      store.insert(weekly(4, "2026-09-03T12:05:00Z", "2026-09-06T13:59:00Z", "claude-main:opus-6"));
      store.insert(weekly(6, "2026-09-03T12:10:00Z", "2026-09-06T13:59:00Z", "claude-main:opus-6"));
      const events = store.events("2026-09-01T00:00:00Z").filter((event) => event.kind === "model_new");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ meter_id: "claude-main:opus-6", principal_id: "claude-main", reason: "opus-6", origin: "vendor_reported" });
    } finally { store.close(); }
  });
});
