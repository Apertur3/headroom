import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blockedWithResetItems } from "../src/notify-blocked.js";
import { deliverNotifications, type NotifyConfig } from "../src/notify.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function store(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-blocked-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

const base = { principal_id: "codex-main", source: "native:codex", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "test", upstream_schema_version: "test" } as const;
function weekly(used: number, at: Date): Observation {
  const stamp = at.toISOString();
  return { ...base, meter_id: "codex-main:main", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2099-11-09T00:00:00Z", observed_at: stamp, fetched_at: stamp };
}
function credits(remaining: number, at: Date): Observation {
  const stamp = at.toISOString();
  return { ...base, meter_id: "codex-main:credits", window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining, unit: "credits" }, resets_at: "2099-12-01T00:00:00Z", observed_at: stamp, fetched_at: stamp };
}
const hour = 3_600_000;

describe("blocked with a reset available", () => {
  it("alerts once, repeats every two hours with the time blocked, and stops when the reading drops", async () => {
    const db = await store();
    try {
      const t0 = new Date("2026-11-02T13:50:00Z");
      db.insert(weekly(100, t0)); db.insert(credits(2, t0));
      expect(blockedWithResetItems(db, t0).map((item) => item.text)).toEqual(["🚨 codex-main is at 100% of its weekly window; 2 resets available (expires Dec 1). Redeem one to unblock it."]);
      expect(blockedWithResetItems(db, new Date(t0.getTime() + hour))).toEqual([]);
      const repeat = blockedWithResetItems(db, new Date(t0.getTime() + 2 * hour));
      expect(repeat.map((item) => item.text)).toEqual(["🚨 codex-main has been at 100% of its weekly window for 2 h; 2 resets available (expires Dec 1). Redeem one to unblock it."]);
      expect(repeat[0].id).not.toBe(blockedWithResetItems(db, new Date(t0.getTime() + 4 * hour))[0].id);

      const t1 = new Date(t0.getTime() + 5 * hour);
      db.insert(weekly(3, t1));
      expect(blockedWithResetItems(db, t1)).toEqual([]);
      db.insert(weekly(99, new Date(t1.getTime() + 1000)));
      expect(blockedWithResetItems(db, new Date(t1.getTime() + 2000))[0].text).toContain("is at 99%");
    } finally { db.close(); }
  });

  it("stays quiet without an available reset", async () => {
    const db = await store();
    try {
      const at = new Date("2026-11-02T13:50:00Z");
      db.insert(weekly(100, at)); db.insert(credits(0, at));
      expect(blockedWithResetItems(db, at)).toEqual([]);
    } finally { db.close(); }
  });

  it("is delivered by the notifier", async () => {
    const db = await store();
    try {
      const at = new Date("2026-11-02T13:50:00Z");
      const config: NotifyConfig = {
        channels: ["webhook"], preset: "quiet", events_on: [], events_off: [], events: [], threshold_percent: null, quiet_hours: null,
        telegram: { chat_id: null }, ntfy: { topic: null, server: "https://ntfy.sh" }, webhook: { url: "https://example.com/hook" }, notify_scheduled_short: false,
        source_health_min_polls: 2, source_health_min_minutes: 15,
      };
      const calls: string[] = [];
      const options = { config, log: async () => undefined, fetcher: async (input: RequestInfo | URL) => { calls.push(await (input as Request).text()); return new Response("ok", { status: 200 }); } };
      await deliverNotifications(db, { ...options, now: at }); // first run only initializes the notifier
      db.insert(weekly(100, at)); db.insert(credits(1, at));
      await deliverNotifications(db, { ...options, now: new Date(at.getTime() + 60_000) });
      expect(calls.join("\n")).toContain("1 reset available (expires Dec 1). Redeem one to unblock it.");
    } finally { db.close(); }
  });
});
