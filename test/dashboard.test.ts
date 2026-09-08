import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { ReadStream, WriteStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand, dashboardOptions, ENTER_DASHBOARD, handleDashboardKey, LEAVE_DASHBOARD, renderDashboard, type DashboardIO } from "../src/dashboard.js";
import { burnBuckets, dashboardSnapshot, readDashboardStore, type DashboardModel } from "../src/dashboard-data.js";
import { defaultPolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const now = new Date("2026-09-08T12:00:00Z");
function row(overrides: Partial<Observation> = {}): Observation {
  return { principal_id: "account-a", meter_id: "account-a:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-08T16:00:00Z", observed_at: "2026-09-08T11:59:30Z", fetched_at: "2026-09-08T11:59:30Z", source: "native:claude", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "synthetic", upstream_schema_version: "synthetic", metadata: { plan: "Max" }, burn_percent_per_hour: 2, sustainable_percent_per_hour: 20, ...overrides };
}
function fixedModel(): DashboardModel {
  return {
    now, version: "0.1.0", direct: false, policy: { ...defaultPolicy, reserve: { "account-a:all": 10 } }, vendors: new Map([["account-a", "claude"]]),
    observations: [row(), row({ window: { kind: "rolling", minutes: 10080, enforcement: "hard" }, quantity: { used: 98, remaining: 2, limit: 100, unit: "percent" }, resets_at: "2026-09-09T12:00:00Z" }), row({ principal_id: "account-b", meter_id: "account-b:main", quantity: null, freshness: "failed", reason: "cached read failed", metadata: {}, last_known: { used_percent: 41, observed_at: "2026-09-08T11:30:00Z", age_seconds: 1800, resets_at: null } }), row({ principal_id: "gpu-box", meter_id: "gpu-box:capacity", window: { kind: "state", minutes: null, enforcement: "hard" }, metadata: { state: "BUSY", model_ids: ["local-27b"], running: 2, waiting: 1 } }), row({ meter_id: "account-a:credits", window: { kind: "count", minutes: null, enforcement: "soft" }, quantity: { used: 0, remaining: 12, limit: 12, unit: "credits" }, resets_at: null })],
    burns: { "account-a:all:300": [null, 0, 1, 2, 3, 4, 5, 6, 7, 4, 2, 1] }, resetSeen: {},
    events: [{ id: "event-1", kind: "reset_seen", created_at: "2026-09-08T11:50:00Z", principal_id: "account-a", meter_id: "account-a:all", reason: null, origin: "inferred", confidence: 0.8, evidence_observation_ids: [], corrected_by: null, last_seen_at: null, metadata: { unscheduled: true } }],
    leases: [{ id: "lease-1", owner: "worker", meter_id: "account-a:all", expected_percent: 5, spent_percent: 1, started_at: "2026-09-08T11:50:00Z", expires_at: "2026-09-08T12:20:00Z", ended_at: null, ended_reason: null, note: null, action_class: null }],
    notices: ["Capacity appeared; re-plan"],
  };
}
function terminal(tty = true) {
  const writes: string[] = [], errors: string[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: tty, isRaw: false, setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; return this; }) });
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } }), { isTTY: tty, columns: 120, rows: 40 });
  const io: DashboardIO = { input: input as unknown as ReadStream, output: output as unknown as WriteStream, errors: { write: (text: string) => { errors.push(text); return true; } } as DashboardIO["errors"], signals: new EventEmitter(), environment: {}, gather: vi.fn(async () => fixedModel()) };
  return { io, input, output, writes, errors };
}
afterEach(() => vi.useRealTimers());

describe("dashboard frames (synthetic data)", () => {
  it("renders the exact wide frame", () => {
    expect(renderDashboard(fixedModel(), { width: 120, height: 40, verbose: false, eventsWide: false }).join("\n")).toMatchInlineSnapshot(`
      "Headroom 0.1.0 | daemon fresh 30 s ago | 12:00:00 UTC

      account-a  claude  Max  fresh <1m
        all        5h  [####................]  20% resets in 4h NORMAL ·▁▂▃▄▅▆▇█▅▃▂
        all        wk  [####################]  98% resets in 24h FREEZE
        credits  12 available

      account-b  claude  failed <1m
        main       5h  [????????????????????]   - resets in ? UNKNOWN
          cached read failed; last 41% at 11:30:00 UTC

      gpu-box  local
        capacity  BUSY  model=local-27b  queue=1  running=2

      EVENTS (last 8)                                            | LEASES / RESERVES / PACING
      11:50:00 !unscheduled reset_seen account-a:all             | worker account-a:all 5% held, 1.0% spent, 20m left
                                                                 | reserve account-a:all: 10%
                                                                 | Capacity appeared; re-plan
      q quit  p pause  v verbose  e events  ? help"
    `);
  });
  it("renders the exact narrow frame", () => {
    expect(renderDashboard(fixedModel(), { width: 78, height: 24, verbose: false, eventsWide: false }).join("\n")).toMatchInlineSnapshot(`
      "Headroom 0.1.0 | daemon fresh 30 s ago | 12:00:00 UTC

      account-a  claude  Max  fresh <1m
        all        5h  [####................]  20% resets in 4h NORMAL
        all        wk  [####################]  98% resets in 24h FREEZE
        credits  12 available

      account-b  claude  failed <1m
        main       5h  [????????????????????]   - resets in ? UNKNOWN
          cached read failed; last 41% at 11:30:00 UTC

      gpu-box  local
        capacity  BUSY  model=local-27b  queue=1  running=2

      EVENTS (last 8)
      11:50:00 !unscheduled reset_seen account-a:all

      LEASES / RESERVES / PACING
      worker account-a:all 5% held, 1.0% spent, 20m left
      reserve account-a:all: 10%
      Capacity appeared; re-plan
      q quit  p pause  v verbose  e events  ? help"
    `);
  });
  it("bounds tiny, short and unicode frames without terminal controls", () => {
    const model = fixedModel(); model.observations[0].metadata = { plan: "宽屏\x1b[2J\nplan" };
    model.observations[2].reason = "读取失败";
    for (const width of [1, 20, 79, 80, 120]) for (const height of [1, 2, 8, 24]) {
      const lines = renderDashboard(model, { width, height, verbose: true, eventsWide: false });
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => [...line].length <= width)).toBe(true);
      expect(lines.every((line) => !/[\x1b\n\r]/.test(line))).toBe(true);
    }
  });
  it("shows details and uses the full width for events", () => {
    const lines = renderDashboard(fixedModel(), { width: 120, height: 40, verbose: true, eventsWide: true });
    expect(lines.join("\n")).toContain("burn 2%/h, sustainable 20%/h, reset seen -, idle no");
    expect(lines.find((line) => line.startsWith("11:50"))).toBe("11:50:00 !unscheduled reset_seen account-a:all");
  });
});

describe("dashboard terminal", () => {
  it("toggles pause, verbose, events and help through the key handler", () => {
    const initial = { paused: false, verbose: false, eventsWide: false, help: false, quit: false };
    for (const [key, field] of [["p", "paused"], ["v", "verbose"], ["e", "eventsWide"], ["?", "help"]] as const) {
      const toggled = handleDashboardKey(initial, key); expect(toggled[field]).toBe(true);
      expect(handleDashboardKey(toggled, key)).toEqual(initial);
    }
  });
  it.each([true, false])("prints one grouped frame, TTY=%s", async (tty) => {
    const fake = terminal(tty);
    expect(await dashboardCommand(tty ? ["--once", "--no-color"] : [], fake.io)).toBe(0);
    expect(fake.io.gather).toHaveBeenCalledTimes(1);
    expect(fake.writes.join("")).toContain("account-a  claude  Max");
    expect(fake.writes.join("")).not.toContain("\x1b");
    expect(fake.input.setRawMode).not.toHaveBeenCalled();
  });
  it("only uses color on a TTY and respects both color opt-outs", async () => {
    expect(dashboardOptions([], false, {}).color).toBe(false);
    expect(dashboardOptions([], true, {}).color).toBe(true);
    expect(dashboardOptions([], true, { NO_COLOR: "" }).color).toBe(false);
    expect(dashboardOptions(["--no-color"], true, {}).color).toBe(false);
    const fake = terminal(); await dashboardCommand(["--once"], fake.io);
    expect(fake.writes.join("")).toContain("\x1b[32m[####................]\x1b[0m");
    expect(fake.writes.join("")).toContain("\x1b[31m[####################]\x1b[0m");
    expect(fake.writes.join("")).toContain("\x1b[90m[????????????????????]\x1b[0m");
  });
  it.each(["q", "SIGINT", "SIGTERM", "error"])("restores the terminal on %s", async (exit) => {
    const fake = terminal();
    const run = dashboardCommand([], fake.io); await Promise.resolve();
    expect(fake.writes[0]).toBe(ENTER_DASHBOARD);
    if (exit === "q") fake.input.emit("keypress", "q", {});
    else if (exit === "error") fake.input.emit("error", new Error("read failed"));
    else fake.io.signals.emit(exit);
    expect(await run).toBe(exit === "error" ? 1 : 0);
    expect(fake.writes.at(-1)).toBe(LEAVE_DASHBOARD);
    expect(fake.input.isRaw).toBe(false);
    expect(fake.input.isPaused()).toBe(true);
    expect(fake.input.listenerCount("keypress")).toBe(0);
    expect(fake.io.signals.listenerCount("SIGINT")).toBe(0);
    expect(fake.output.listenerCount("resize")).toBe(0);
    if (exit === "error") expect(fake.errors.join("")).toContain("read failed");
  });
  it("pauses reads, redraws on resize, and resumes with current verbose state", async () => {
    vi.useFakeTimers(); const fake = terminal(); const run = dashboardCommand([], fake.io);
    await vi.advanceTimersByTimeAsync(0);
    fake.input.emit("keypress", "p", {}); fake.input.emit("keypress", "v", {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.io.gather).toHaveBeenCalledTimes(1);
    expect(fake.writes.at(-1)).toContain("burn 2%/h");
    expect(fake.writes.at(-1)).toContain("PAUSED");
    fake.output.columns = 78; fake.output.emit("resize");
    expect(fake.writes.at(-1)).not.toContain("▁▂");
    fake.input.emit("keypress", "p", {}); await vi.advanceTimersByTimeAsync(0);
    expect(fake.io.gather).toHaveBeenCalledTimes(2);
    fake.input.emit("keypress", "q", {}); await run;
    await vi.advanceTimersByTimeAsync(10_000); expect(fake.io.gather).toHaveBeenCalledTimes(2);
  });
  it("restores before printing a gather error and quits during an in-flight read", async () => {
    const fake = terminal(); fake.io.gather = async () => { throw new Error("gather failed"); };
    fake.io.errors.write = ((text: string) => { expect(fake.writes.at(-1)).toBe(LEAVE_DASHBOARD); fake.errors.push(text); return true; }) as typeof fake.io.errors.write;
    expect(await dashboardCommand([], fake.io)).toBe(1);
    const pending = terminal(); let complete!: (model: DashboardModel) => void;
    pending.io.gather = () => new Promise((resolve) => { complete = resolve; });
    const run = dashboardCommand([], pending.io); pending.input.emit("keypress", "q", {});
    expect(await run).toBe(0); complete(fixedModel()); await Promise.resolve();
    expect(pending.writes).toEqual([ENTER_DASHBOARD, LEAVE_DASHBOARD]);
  });
  it("validates intervals and supports alias help without reading data", async () => {
    expect(dashboardOptions([], false, {}).interval).toBe(5000);
    expect(dashboardOptions(["--interval", "2"], true, {}).interval).toBe(2000);
    for (const value of ["1", "NaN", "Infinity", "", "2147484"]) expect(() => dashboardOptions(["--interval", value], true, {})).toThrow();
    const fake = terminal(); expect(await dashboardCommand(["--help"], fake.io)).toBe(0); expect(fake.io.gather).not.toHaveBeenCalled();
  });
});

describe("dashboard cached data", () => {
  it.skipIf(process.platform === "win32")("bounds a trickling socket response and closes it before fallback", async () => {
    const { daemonRequest } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-dashboard-socket-"));
    const path = join(root, "test.sock"), sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket); socket.on("error", () => {});
      let drip: ReturnType<typeof setInterval> | undefined;
      socket.on("close", () => { if (drip) clearInterval(drip); sockets.delete(socket); });
      socket.once("data", (data) => {
        if (JSON.parse(data.toString()).method === "health") socket.end('{"jsonrpc":"2.0","id":1,"result":{}}\n');
        else drip = setInterval(() => socket.write(" "), 10);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
      const started = Date.now();
      const reply = await daemonRequest(path, "dashboard", {}, 50, 80);
      expect(reply.status).toBe("unresponsive");
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses a socket snapshot and falls back for absent, old and broken daemons", async () => {
    const fallback = vi.fn(async () => fixedModel());
    expect((await dashboardSnapshot({ request: async () => ({ status: "available", result: { result: fixedModel() } }), fallback })).direct).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    for (const reply of [{ status: "absent" }, { status: "unresponsive" }, { status: "available", result: { error: { message: "Method not found" } } }]) expect((await dashboardSnapshot({ request: async () => reply, fallback })).direct).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(3);
  });
  it("does not interpret reset drops or failures as burn", () => {
    const reading = (minute: number, used: number, freshness: Observation["freshness"] = "fresh") => row({ fetched_at: new Date(now.getTime() - (60 - minute) * 60_000).toISOString(), freshness, quantity: { used, remaining: 100 - used, limit: 100, unit: "percent" } });
    const buckets = burnBuckets([reading(0, 20), reading(5, 25), reading(10, 0), reading(15, 4, "failed"), reading(20, 6)], now);
    expect(buckets[1]).toBe(60); expect(buckets[2]).toBeNull(); expect(buckets[3]).toBeNull(); expect(buckets[4]).toBeNull();
  });
  it("reads the store and serves the daemon dashboard without invoking its poller", async () => {
    const { HeadroomDaemon } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-dashboard-"));
    const store = await HeadroomStore.open(root); store.insertAll([row()]);
    expect(readDashboardStore(store, now).observations[0].quantity?.used).toBe(20); store.close();
    const poller = vi.fn(async () => { throw new Error("must not poll"); });
    const daemon = await HeadroomDaemon.create({ home: root, poller });
    try {
      const internal = daemon as unknown as { accounts: Array<{ name: string }>; sessionToken: string; handleLine(line: string, nonce: string): Promise<{ replyLine: string }> };
      internal.accounts = [{ name: "account-a" }]; internal.sessionToken = "synthetic-local-test-token";
      const nonce = "synthetic-nonce", proof = createHmac("sha256", internal.sessionToken).update(`headroom-pipe-auth-v1:${nonce}`).digest("hex");
      const reply = await internal.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "dashboard", params: { _proof: proof } }), nonce);
      expect(JSON.parse(reply.replyLine).result.observations[0].quantity.used).toBe(20); expect(poller).not.toHaveBeenCalled();
    } finally { await daemon.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
