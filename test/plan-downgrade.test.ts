import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDashboard, type DashboardModel } from "../src/dashboard.js";
import { defaultPolicy } from "../src/policy.js";
import { deliverNotifications, type NotifyConfig, type NotifyOptions } from "../src/notify.js";
import { handleMcp } from "../src/mcp.js";
import { renderStatus } from "../src/status-view.js";
import { formatClockTime } from "../src/resets.js";
import { HeadroomStore, type PlanDowngrade } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function store(): Promise<HeadroomStore> {
  const root = await mkdtemp(join(tmpdir(), "headroom-plan-downgrade-"));
  temporary.push(root);
  return HeadroomStore.open(join(root, ".headroom"));
}

function reading(plan: string, at: string, meter = "codex-main:main", credits?: number): Observation {
  const credit = credits !== undefined;
  return {
    principal_id: "codex-main", meter_id: credit ? "codex-main:credits" : meter,
    window: credit ? { kind: "count", minutes: null, enforcement: "hard" } : { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: credit ? { used: 0, limit: null, remaining: credits, unit: "credits" } : { used: 10, limit: 100, remaining: 90, unit: "percent" },
    resets_at: null, observed_at: at, fetched_at: at, source: "native:codex", truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "test", upstream_schema_version: "test", metadata: { plan },
  };
}

const quietWebhook: NotifyConfig = {
  channels: ["webhook"], preset: "quiet", events_on: [], events_off: [], events: [], threshold_percent: 90,
  quiet_hours: { start: 23 * 60, end: 7 * 60 }, telegram: { chat_id: null }, ntfy: { topic: null, server: "https://ntfy.sh" }, webhook: { url: "https://example.com/hook" }, notify_scheduled_short: false,
};

function notifications(calls: string[], now = new Date()): NotifyOptions {
  return {
    config: quietWebhook, now, log: async () => undefined,
    fetcher: async (input) => { calls.push(await (input as Request).text()); return new Response("ok", { status: 200 }); },
  };
}

describe("plan downgrade protection", () => {
  it("refuses dispatches until acknowledgement and clears the refusal on restoration", async () => {
    const db = await store();
    try {
      db.insert(reading("prolite", "2026-09-09T13:12:00Z"));
      db.insert(reading("prolite", "2026-09-09T13:12:00Z", undefined, 2));
      db.insert(reading("free", "2026-09-09T13:13:00Z"));
      db.insert(reading("free", "2026-09-09T13:13:00Z", undefined, 2));
      expect(db.planDowngrades()).toEqual([{ principal: "codex-main", from: "prolite", to: "free", since: "2026-09-09T13:13:00Z", acknowledged: false }]);
      expect(db.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "plan_changed")).toHaveLength(1);
      expect(db.dispatchBlockForPrincipal("codex-main")).toContain("plan downgraded to free");
      db.acknowledgePlan("codex-main");
      expect(db.dispatchBlockForPrincipal("codex-main")).toBeUndefined();
      db.insert(reading("prolite", "2026-09-09T16:17:00Z"));
      expect(db.planDowngrades()).toEqual([]);
      expect(db.dispatchBlockForPrincipal("codex-main")).toBeUndefined();
      expect(db.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "plan_changed" && event.metadata?.restored)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("sends one downgrade alarm outside quiet hours, one 24-hour reminder, and no reminder after restoration", async () => {
    const db = await store();
    const calls: string[] = [];
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-09T15:12:00Z")); // 17:12 in the shared Europe/Amsterdam test zone.
      await deliverNotifications(db, notifications(calls));
      db.insert(reading("prolite", "2026-09-09T15:12:00Z"));
      db.insert(reading("free", "2026-09-09T15:13:00Z"));
      vi.setSystemTime(new Date("2026-09-09T15:14:00Z"));
      const alarm = await deliverNotifications(db, notifications(calls));
      expect(alarm).toMatchObject({ quiet: false, sent: 1 });
      expect(JSON.parse(calls[0]).text).toBe(`🚨 PLAN DOWNGRADED: Codex is now on the free plan (was prolite) since ${formatClockTime(new Date("2026-09-09T15:13:00Z"))}. Do NOT use a reset credit. Dispatches are refused until you run: headroom ack plan codex-main`);
      vi.setSystemTime(new Date("2026-09-10T15:14:00Z"));
      await deliverNotifications(db, notifications(calls));
      expect(JSON.parse(calls[1]).text).toContain("PLAN DOWNGRADED REMINDER");
      expect(db.planDowngrades()).toHaveLength(1);
      db.insert(reading("prolite", "2026-09-10T16:00:00Z"));
      expect(db.events("2000-01-01T00:00:00Z").filter((event) => event.kind === "plan_changed")).toHaveLength(2);
      vi.setSystemTime(new Date("2026-09-10T16:01:00Z"));
      await deliverNotifications(db, notifications(calls));
      expect(calls).toHaveLength(3);
      expect(JSON.parse(calls[2]).text).toContain("📈 plan restored");
      vi.setSystemTime(new Date("2026-09-12T16:00:00Z"));
      await deliverNotifications(db, notifications(calls));
      expect(calls).toHaveLength(3);
    } finally { db.close(); }
  });

  it("sends a downgrade alarm immediately inside quiet hours", async () => {
    const db = await store();
    const calls: string[] = [];
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-09T22:12:00Z")); // 00:12 in Europe/Amsterdam, inside 23:00-07:00.
      await deliverNotifications(db, notifications(calls));
      db.insert(reading("prolite", "2026-09-09T22:12:00Z"));
      db.insert(reading("free", "2026-09-09T22:13:00Z"));
      vi.setSystemTime(new Date("2026-09-09T22:14:00Z"));
      const alarm = await deliverNotifications(db, notifications(calls));
      expect(alarm).toMatchObject({ quiet: true, sent: 1 });
      expect(JSON.parse(calls[0]).text).toContain("🚨 PLAN DOWNGRADED");
    } finally { db.close(); }
  });

  it("warns immediately when a reset credit is spent while the plan is free", async () => {
    const db = await store();
    const calls: string[] = [];
    try {
      db.insert(reading("free", "2026-09-09T15:00:00Z", undefined, 2));
      await deliverNotifications(db, notifications(calls, new Date("2026-09-09T15:00:00Z")));
      db.insert(reading("free", "2026-09-09T16:17:00Z", undefined, 1));
      const result = await deliverNotifications(db, notifications(calls, new Date("2026-09-09T16:18:00Z")));
      expect(result).toMatchObject({ quiet: false, sent: 1 });
      expect(JSON.parse(calls[0]).text).toBe("🚨 A reset credit was just spent on the free plan");
    } finally { db.close(); }
  });

  it("does not send the 24-hour reminder after acknowledgement", async () => {
    const db = await store();
    const calls: string[] = [];
    try {
      await deliverNotifications(db, notifications(calls, new Date("2026-09-09T15:12:00Z")));
      db.insert(reading("prolite", "2026-09-09T15:12:00Z"));
      db.insert(reading("free", "2026-09-09T15:13:00Z"));
      await deliverNotifications(db, notifications(calls, new Date("2026-09-09T15:14:00Z")));
      db.acknowledgePlan("codex-main");
      await deliverNotifications(db, notifications(calls, new Date("2026-09-10T15:14:00Z")));
      expect(calls).toHaveLength(1);
    } finally { db.close(); }
  });

  it("shows the warning at the top of status, dashboard, and quota_status", async () => {
    const downgrade: PlanDowngrade = { principal: "codex-main", from: "prolite", to: "free", since: "2026-09-09T15:13:00Z", acknowledged: false };
    const row = reading("free", "2026-09-09T15:14:00Z");
    expect(renderStatus({ observations: [row], policy: defaultPolicy, planDowngraded: [downgrade], now: new Date("2026-09-09T15:14:00Z") }, { form: "plain", verbose: false, color: false, width: 120, direct: false })[0]).toBe(`PLAN DOWNGRADED: codex-main free since ${formatClockTime(new Date(downgrade.since))} (ack: headroom ack plan codex-main)`);
    const model: DashboardModel = { observations: [row], events: [], leases: [], resetSeen: {}, burns: {}, notices: [], planDowngraded: [downgrade], now: new Date("2026-09-09T15:14:00Z"), version: "test", direct: false, policy: defaultPolicy, vendors: new Map([["codex-main", "codex"]]) };
    expect(renderDashboard(model, { width: 120, height: 30, verbose: false, eventsWide: false })[0]).toContain(`PLAN DOWNGRADED: codex-main free since ${formatClockTime(new Date(downgrade.since))}`);
    const response = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_status", arguments: {} } }), async (method) => method === "status" ? [row] : [downgrade]);
    expect(response?.result).toBeDefined();
    const payload = response?.result as { structuredContent: { plan_downgraded: PlanDowngrade } };
    expect(payload.structuredContent.plan_downgraded).toEqual(downgrade);
  });
});
