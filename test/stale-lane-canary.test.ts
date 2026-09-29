import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStaleLanes } from "../src/canary.js";
import { doctorChecks } from "../src/doctor.js";
import { readInbox } from "../src/inbox.js";
import { deliverNotifications, parseNotifyConfig, type NotifyConfig, type NotifyOptions } from "../src/notify.js";
import { parsePolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Account, Observation } from "../src/types.js";
import { withStatusInfo } from "../src/pace.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const HOUR = 3_600_000;
const T0 = new Date("2026-09-25T00:00:00Z");
const at = (hours: number): Date => new Date(T0.getTime() + hours * HOUR);

const ACCOUNTS: Account[] = [
  { name: "agy", vendor: "antigravity", location: "/tmp/agy", adapter: "native" },
  { name: "cx", vendor: "codex", location: "/tmp/cx", adapter: "native" },
];

function lane(principal: string, meter: string, minutes: number, when: Date, extra: Partial<Observation> = {}): Observation {
  return {
    principal_id: principal, meter_id: `${principal}:${meter}`, window: { kind: minutes === 300 ? "rolling" : "fixed", minutes, enforcement: "hard" },
    quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(when.getTime() + 300 * 60_000).toISOString(),
    observed_at: when.toISOString(), fetched_at: when.toISOString(), source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...extra,
  };
}

function failure(principal: string, meter: string, when: Date, reason: string): Observation {
  return { ...lane(principal, meter, 300, when), window: null, quantity: null, resets_at: null, freshness: "failed", truth: "estimated", confidence: 0, reason };
}

async function setup(): Promise<{ store: HeadroomStore; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "headroom-canary-"));
  temporary.push(root);
  const home = join(root, ".headroom");
  return { store: await HeadroomStore.open(home), home };
}

function options(home: string, now: Date, extra: Partial<NotifyOptions> = {}): NotifyOptions {
  return { home, now, platform: "darwin", log: async () => undefined, canary: { accounts: ACCOUNTS, staleAfterHours: 6, minIntervalMs: 0 }, ...extra };
}

async function inbox(home: string): Promise<Array<{ event: string; meter: string }>> {
  const result = await readInbox({ session: "headroom-canary", home, markRead: false });
  return result.messages.map((message) => message.body as { event: string; meter: string });
}

/** A healthy sibling lane keeps polling every hour so only the lane under test can go stale. */
function seedHealthy(store: HeadroomStore, from: number, to: number): void {
  for (let hour = from; hour <= to; hour += 1) store.insert(lane("cx", "main", 300, at(hour)));
}

describe("stale-lane canary", () => {
  it("alerts once when a lane passes the threshold, with age and last error", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    store.insert(failure("agy", "claude-gpt", at(3), "agy logged in; quota summary not ready"));
    seedHealthy(store, 0, 8);
    await deliverNotifications(store, options(home, at(5)));
    expect(await inbox(home)).toEqual([]);
    await deliverNotifications(store, options(home, at(7)));
    await deliverNotifications(store, options(home, at(8)));
    const alerts = await readInbox({ session: "headroom-canary", home, markRead: false });
    expect(alerts.messages).toHaveLength(1);
    expect(alerts.messages[0].body).toMatchObject({ event: "lane_stale", meter: "agy:claude-gpt", lane: "5h", last_error: "agy logged in; quota summary not ready" });
    expect(JSON.stringify(alerts.messages[0].body)).toContain("no fresh reading for 7h");
    store.close();
  });

  it("re-alerts after 24 hours while the lane stays stale, not before", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    await deliverNotifications(store, options(home, at(7)));
    await deliverNotifications(store, options(home, at(20)));
    expect(await inbox(home)).toHaveLength(1);
    await deliverNotifications(store, options(home, at(7 + 24)));
    expect((await inbox(home)).filter((message) => message.event === "lane_stale")).toHaveLength(2);
    store.close();
  });

  it("emits lane_recovered once after the lane is fresh again and stays fresh", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    await deliverNotifications(store, options(home, at(7)));
    store.insert(lane("agy", "claude-gpt", 300, at(9)));
    await deliverNotifications(store, options(home, at(9)));
    expect((await inbox(home)).map((message) => message.event)).toEqual(["lane_stale"]);
    store.insert(lane("agy", "claude-gpt", 300, at(9.25)));
    await deliverNotifications(store, options(home, at(9.25)));
    store.insert(lane("agy", "claude-gpt", 300, at(9.6)));
    await deliverNotifications(store, options(home, at(9.6)));
    await deliverNotifications(store, options(home, at(9.7)));
    expect((await inbox(home)).map((message) => message.event)).toEqual(["lane_stale", "lane_recovered"]);
    store.close();
  });

  it("is not silenced by events_off, and reaches a working channel while the inbox still gets it", async () => {
    const { store, home } = await setup();
    const config: NotifyConfig = { ...parseNotifyConfig('[notify]\nchannels = ["webhook"]\nevents_off = ["source_failed", "source_recovered"]\n[notify.webhook]\nurl = "https://example.com/hook"\n')! };
    expect(config.events).not.toContain("lane_stale");
    const posts: string[] = [];
    const fetcher: typeof fetch = async (input) => { posts.push(await (input as Request).text()); return new Response("ok", { status: 200 }); };
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    await deliverNotifications(store, options(home, at(7), { config, fetcher }));
    expect(posts.join("\n")).toContain("STALE LANE agy:claude-gpt 5h");
    expect(await inbox(home)).toHaveLength(1);
    store.close();
  });

  it("still writes the inbox when no channel is configured or every channel is broken", async () => {
    const { store, home } = await setup();
    const config = parseNotifyConfig('[notify]\nchannels = ["telegram"]\n[notify.telegram]\nchat_id = "1"\n')!;
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    store.insert(lane("cx", "main", 300, at(0)));
    const run = async (): Promise<string> => { throw new Error("not found"); };
    await deliverNotifications(store, options(home, at(7), { config, run }));
    expect((await inbox(home)).map((message) => message.meter).sort()).toEqual(["agy:claude-gpt", "cx:main"]);
    store.close();
  });

  it("does not alert for a lane whose latest accepted reading is an explicit not_enforced", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "gemini", 300, at(0)));
    store.insert(lane("agy", "gemini", 300, at(6), { freshness: "not_enforced", quantity: null, reason: "blocked by weekly" }));
    await deliverNotifications(store, options(home, at(11)));
    expect(await inbox(home)).toEqual([]);
    expect(findStaleLanes(store, ACCOUNTS, 6, at(13))).toHaveLength(1);
    store.close();
  });

  it("does not spam when readings flap around the threshold", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    let hour = 0;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      hour += 6.5; // stale just past the threshold
      await deliverNotifications(store, options(home, at(hour)));
      store.insert(lane("agy", "claude-gpt", 300, at(hour + 0.1)));
      await deliverNotifications(store, options(home, at(hour + 0.1)));
      hour += 0.2;
    }
    const events = (await inbox(home)).map((message) => message.event);
    expect(events.filter((event) => event === "lane_stale").length).toBeLessThanOrEqual(2);
    expect(events.filter((event) => event === "lane_recovered").length).toBeLessThanOrEqual(events.filter((event) => event === "lane_stale").length);
    // A lane that never reaches the threshold never alerts at all.
    const quiet = await setup();
    quiet.store.insert(lane("agy", "claude-gpt", 300, at(0)));
    for (let step = 1; step <= 11; step += 1) {
      await deliverNotifications(quiet.store, options(quiet.home, at(step * 0.5)));
      if (step % 5 === 0) quiet.store.insert(lane("agy", "claude-gpt", 300, at(step * 0.5)));
    }
    expect(await inbox(quiet.home)).toEqual([]);
    store.close(); quiet.store.close();
  });

  it("ignores disabled principals and retired lanes", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "claude-gpt", 300, at(0)));
    store.insert(lane("cx", "main", 300, at(0)));
    store.insert(lane("cx", "main", 300, at(1), { metadata: { retired: true } }));
    const accounts: Account[] = [{ ...ACCOUNTS[0], enabled: false }, ACCOUNTS[1]];
    await deliverNotifications(store, options(home, at(8), { canary: { accounts, staleAfterHours: 6, minIntervalMs: 0 } }));
    expect(await inbox(home)).toEqual([]);
    store.close();
  });

  it("makes doctor FAIL on a stale lane, naming its age and last error", async () => {
    const { store, home } = await setup();
    store.insert(lane("agy", "claude-gpt", 300, new Date(Date.now() - 30 * HOUR)));
    store.insert(failure("agy", "claude-gpt", new Date(Date.now() - 2 * HOUR), "engine exploded"));
    store.close();
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "accounts.toml"), '[[accounts]]\nname = "agy"\nvendor = "antigravity"\nlocation = "/tmp/agy"\nadapter = "native"\n');
      const checks = await doctorChecks();
      const stale = checks.find((item) => item.check.startsWith("lane agy:claude-gpt"));
      expect(stale?.level).toBe("FAIL");
      expect(stale?.detail).toMatch(/30h/);
      expect(stale?.detail).toContain("engine exploded");
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });

  it("marks a stale row not current, with its age, in the served status shape", () => {
    const old = lane("agy", "claude-gpt", 300, at(0));
    const [served] = withStatusInfo([old], new Map(), new Map(), 15, at(7));
    expect(served.freshness).toBe("stale");
    expect(served.stale).toBe(true);
    expect(served.stale_age_seconds).toBe(7 * 3600);
    const [fresh] = withStatusInfo([old], new Map(), new Map(), 15, new Date(at(0).getTime() + 60_000));
    expect(fresh.stale).toBeUndefined();
  });

  it("reads canary.stale_after_hours from policy.toml", () => {
    expect(parsePolicy("").canary_stale_after_hours).toBe(6);
    expect(parsePolicy("[canary]\nstale_after_hours = 12\n").canary_stale_after_hours).toBe(12);
    expect(() => parsePolicy("[canary]\nstale_after_hours = 0\n")).toThrow();
  });
});
