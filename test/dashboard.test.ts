import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { ReadStream, WriteStream } from "node:tty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand, dashboardOptions, dashboardPanelOffset, dashboardRead, decodeDashboardKeys, filterDashboardPrincipals, gatherDashboard, readDashboardGraphs, renderBurndown, renderWeekly, type DashboardModel, ENTER_DASHBOARD, handleDashboardKey, LEAVE_DASHBOARD, renderDashboard, type DashboardIO } from "../src/dashboard.js";
import { burnBuckets, dashboardSnapshot, gatherDashboard as gatherCachedDashboard, readDashboardStore } from "../src/dashboard-data.js";
import { daemonRequest, HeadroomDaemon, socketPath } from "../src/daemon.js";
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
const dateTimeFormat = Intl.DateTimeFormat;
beforeEach(() => {
  // Fix the ambient locale and local zone so frames are portable across hosts.
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation((_locale, options) => new dateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", ...options }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function snapshotFrame(lines: string[]): string {
  return lines.map((line) => /^ +\|[A-Z][a-z]{2}(?: |$)/.test(line) ? "  <local day ticks>" : line).join("\n");
}

describe("dashboard frames (synthetic data)", () => {
  it("keeps the overview first, scrolls a full screen, and Enter reaches the focused panel", () => {
    const model = fixedModel();
    for (let index = 0; index < 18; index++) model.observations.push(row({ principal_id: `mock-${index}`, meter_id: `mock-${index}:all`, resets_at: "2026-09-08T16:00:00Z" }));
    const initial = renderDashboard(model, { width: 80, height: 24, verbose: false, eventsWide: false, scroll: 0 });
    const next = handleDashboardKey({ paused: false, verbose: false, eventsWide: false, help: false, quit: false, scroll: 0 }, "pagedown", 22);
    const paged = renderDashboard(model, { width: 80, height: 24, verbose: false, eventsWide: false, scroll: next.scroll });
    expect(initial.slice(0, 7).join("\n")).toMatchInlineSnapshot(`
      "Headroom 0.1.0 | daemon fresh 30s ago | 14:00:00░
      OVERVIEW█
      > account-a        [####################]  98% resets in 24h FREEZE stop█
        account-b        [????????????????????]   - resets in ? UNKNOWN unknown█
        gpu-box          BUSY  local-27b  2 running, 1 waiting  busy█
        mock-0           [####................]  20% resets in 4h NORMAL ok░
        mock-1           [####................]  20% resets in 4h NORMAL ok░"
    `);
    expect(initial.join("\n")).toMatchInlineSnapshot(`
      "Headroom 0.1.0 | daemon fresh 30s ago | 14:00:00░
      OVERVIEW█
      > account-a        [####################]  98% resets in 24h FREEZE stop█
        account-b        [????????????????????]   - resets in ? UNKNOWN unknown█
        gpu-box          BUSY  local-27b  2 running, 1 waiting  busy█
        mock-0           [####................]  20% resets in 4h NORMAL ok░
        mock-1           [####................]  20% resets in 4h NORMAL ok░
        mock-10          [####................]  20% resets in 4h NORMAL ok░
        mock-11          [####................]  20% resets in 4h NORMAL ok░
        mock-12          [####................]  20% resets in 4h NORMAL ok░
        mock-13          [####................]  20% resets in 4h NORMAL ok░
        mock-14          [####................]  20% resets in 4h NORMAL ok░
        mock-15          [####................]  20% resets in 4h NORMAL ok░
        mock-16          [####................]  20% resets in 4h NORMAL ok░
        mock-17          [####................]  20% resets in 4h NORMAL ok░
        mock-2           [####................]  20% resets in 4h NORMAL ok░
        mock-3           [####................]  20% resets in 4h NORMAL ok░
        mock-4           [####................]  20% resets in 4h NORMAL ok░
        mock-5           [####................]  20% resets in 4h NORMAL ok░
        mock-6           [####................]  20% resets in 4h NORMAL ok░
        mock-7           [####................]  20% resets in 4h NORMAL ok░
        mock-8           [####................]  20% resets in 4h NORMAL ok░
      ▼ 100 more rows  scroll: wheel / ↑↓ / PgDn░
      q quit  p pause  v verbose  e events  g graphs  ↑↓/PgDn scroll  ? help░"
    `);
    expect(paged.join("\n")).toMatchInlineSnapshot(`
      "Headroom 0.1.0 | daemon fresh 30s ago | 14:00:00░
      1 event in the last hour, 1 lease active, next reset account-a 5h in 4h░
      ░
      account-a  claude  Max  fresh <1m░
        all        5h  [####................]  20% ● resets in 4h NORMAL░
        collecting readings█
        all        wk  [####################]  98% 🛑 resets in 24h FREEZE█
        collecting readings█
        credits  12 available█
        WEEKLY account-a:all | last 7 days | F free reset  ! unsch░
        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁░
           |Wed     |Thu    |Fri    |Sat    |Sun    |Mon    |Tue !░
      ░
      account-b  claude  failed <1m░
        UNKNOWN: cached read failed.░
        main       5h  [????????????????????]   - ? resets in ? UNKNOWN░
          last 41% at 13:30:00░
      ░
      gpu-box  local░
        gpu-box  BUSY  local-27b  2 running, 1 waiting  busy░
      ░
      mock-0  claude  Max  fresh <1m░
      ▼ 78 more rows  scroll: wheel / ↑↓ / PgDn░
      q quit  p pause  v verbose  e events  g graphs  ↑↓/PgDn scroll  ? help░"
    `);
    expect(paged.join("\n")).not.toEqual(initial.join("\n"));
    expect(paged.at(-1)).toContain("q quit");
    const focus = 2, panel = dashboardPanelOffset(model, { width: 80, height: 24, verbose: false, eventsWide: false }, focus);
    expect(renderDashboard(model, { width: 80, height: 24, verbose: false, eventsWide: false, scroll: panel, focus }).join("\n")).toContain("gpu-box  local");
  });
  it("renders the same overview viewport at 145 columns and keeps a scrollbar for overflow", () => {
    const model = fixedModel();
    for (let index = 0; index < 30; index++) model.observations.push(row({ principal_id: `mock-${index}`, meter_id: `mock-${index}:all` }));
    const first = renderDashboard(model, { width: 145, height: 68, verbose: false, eventsWide: false });
    const page = renderDashboard(model, { width: 145, height: 68, verbose: false, eventsWide: false, scroll: 65 });
    expect(first[3]).toBe("OVERVIEW█");
    expect(first.join("\n")).toContain("mock-29");
    expect(first.join("\n")).not.toContain("EVENTS (last 8)");
    expect(page.join("\n")).not.toEqual(first.join("\n"));
    expect(page.at(-1)).toContain("q quit");
  });
  it("renders the exact first overview frame", () => {
    expect(snapshotFrame(renderDashboard(fixedModel(), { width: 80, height: 24, verbose: false, eventsWide: false }))).toMatchInlineSnapshot(`
      "Headroom 0.1.0 | daemon fresh 30s ago | 14:00:00░
      OVERVIEW█
      > account-a        [####################]  98% resets in 24h FREEZE stop█
        account-b        [????????????????????]   - resets in ? UNKNOWN unknown█
        gpu-box          BUSY  local-27b  2 running, 1 waiting  busy█
      1 event in the last hour, 1 lease active, next reset account-a 5h in 4h█
      █
      account-a  claude  Max  fresh <1m█
        all        5h  [####................]  20% ● resets in 4h NORMAL█
        collecting readings█
        all        wk  [####################]  98% 🛑 resets in 24h FREEZE█
        collecting readings█
        credits  12 available█
        WEEKLY account-a:all | last 7 days | F free reset  ! unsch█
        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁█
        <local day ticks>
      ░
      account-b  claude  failed <1m░
        UNKNOWN: cached read failed.░
        main       5h  [????????????????????]   - ? resets in ? UNKNOWN░
          last 41% at 13:30:00░
      ░
      ▼ 10 more rows  scroll: wheel / ↑↓ / PgDn░
      q quit  p pause  v verbose  e events  g graphs  ↑↓/PgDn scroll  ? help░"
    `);
  });
  it("uses compact local-pool and credit summaries instead of percentage bars", () => {
    const model = fixedModel();
    model.observations = [
      row({ principal_id: "hydra", meter_id: "hydra:capacity", window: { kind: "state", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: null, unit: "requests" }, metadata: { state: "UP", model_ids: ["coder"], running: 0, waiting: 0 } }),
      row({ principal_id: "credits", meter_id: "credits:credits", window: { kind: "count", minutes: null, enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: 1, unit: "credits" }, resets_at: "2026-10-05T12:00:00Z" }),
    ];
    const frame = renderDashboard(model, { width: 100, height: 30, verbose: false, eventsWide: false }).join("\n");
    expect(frame).toContain("hydra            UP  coder  0 running, 0 waiting  ok");
    expect(frame).toMatch(/credits\s+1 available, expire (?:Oct 5|5 Oct)/);
    expect(frame).not.toMatch(/hydra\s+\[[#.?]{20}\]|credits\s+\[[#.?]{20}\]/);
  });
  it("renders the exact wide overview frame", () => {
    expect(renderDashboard(fixedModel(), { width: 145, height: 68, verbose: false, eventsWide: false }).join("\n")).toMatchInlineSnapshot(`
      "╷ ╷ ╭── ╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭─╮ ╭╮╭╮
      ├─┤ ├─  ├─┤ │ │ ├┬╯ │ │ │ │ │╰╯│  Headroom 0.1.0 | daemon fresh 30s ago | 14:00:00
      ╵ ╵ ╰── ╵ ╵ ╰─╯ ╵╰╴ ╰─╯ ╰─╯ ╵  ╵
      OVERVIEW
      > account-a        [####################]  98% resets in 24h FREEZE stop
        account-b        [????????????????????]   - resets in ? UNKNOWN unknown
        gpu-box          BUSY  local-27b  2 running, 1 waiting  busy
      1 event in the last hour, 1 lease active, next reset account-a 5h in 4h

      account-a  claude  Max  fresh <1m
        all        5h  [####................]  20% ● resets in 4h NORMAL ·▁▂▃▄▅▆▇█▅▃▂
        collecting readings
        all        wk  [####################]  98% 🛑 resets in 24h FREEZE
        collecting readings
        credits  12 available
        WEEKLY account-a:all | last 7 days | F free reset  ! unsch
        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁
           |Wed     |Thu    |Fri    |Sat    |Sun    |Mon    |Tue !

      account-b  claude  failed <1m
        UNKNOWN: cached read failed.
        main       5h  [????????????????????]   - ? resets in ? UNKNOWN
          last 41% at 13:30:00

      gpu-box  local
        gpu-box  BUSY  local-27b  2 running, 1 waiting  busy

      EVENTS (last 8)                                                        | LEASES / RESERVES / PACING
      13:50:00 !unscheduled reset_seen account-a:all                         | worker account-a:all 5% held, 1.0% spent, 20m left
                                                                             | reserve account-a:all: 10%
                                                                             | Capacity appeared; re-plan
      q quit  p pause  v verbose  e events  g graphs  ↑↓/PgDn scroll  ? help"
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
    expect(lines.find((line) => line.startsWith("13:50"))).toBe("13:50:00 !unscheduled reset_seen account-a:all");
  });
});

describe("dashboard terminal", () => {
  it("decodes terminal cursor and mouse input, including batched wheel reports", () => {
    expect(decodeDashboardKeys("\x1b[A\x1bOA\x1b[B\x1bOB")).toEqual(["up", "up", "down", "down"]);
    expect(decodeDashboardKeys("\x1b[5~\x1b[6~\x1b[H\x1b[1~\x1bOH\x1b[F\x1b[4~\x1bOF")).toEqual(["pageup", "pagedown", "home", "home", "home", "end", "end", "end"]);
    expect(decodeDashboardKeys("\x1b[<65;10;4M\x1b[<65;10;5M\x1b[<65;10;6M")).toEqual(["wheeldown", "wheeldown", "wheeldown"]);
    expect(decodeDashboardKeys("\x1b[<0;10;4M\x1b[<64;10;4m\x1b[Mabc")).toEqual([]);
    expect(handleDashboardKey({ paused: false, verbose: false, eventsWide: false, help: false, quit: false, scroll: 10 }, "wheelup").scroll).toBe(7);
  });
  it("advertises scroll controls and the rows below the fold in the default footer", () => {
    const top = renderDashboard(fixedModel(), { width: 80, height: 24, verbose: false, eventsWide: false });
    expect(top.join("\n")).toMatch(/▼ \d+ more rows  scroll: wheel \/ ↑↓ \/ PgDn/);
    expect(top.at(-1)).toContain("↑↓/PgDn scroll");
    expect(top.at(-1)).toContain("? help");
    const bottom = renderDashboard(fixedModel(), { width: 80, height: 24, verbose: false, eventsWide: false, scroll: Number.MAX_SAFE_INTEGER });
    expect(bottom.join("\n")).toContain("▲ back to top: Home");
    expect(renderDashboard(fixedModel(), { width: 80, height: 24, verbose: false, eventsWide: false, ascii: true }).join("\n")).toMatch(/v \d+ more rows  scroll: wheel \/ up\/down \/ PgDn/);
  });
  it("enables SGR mouse reporting on entry and disables it on exit", () => {
    expect(ENTER_DASHBOARD).toContain("\x1b[?1000h\x1b[?1006h");
    expect(LEAVE_DASHBOARD).toContain("\x1b[?1006l\x1b[?1000l");
  });
  it("uses an explicit one-based cursor origin for every redraw", async () => {
    const fake = terminal(); const run = dashboardCommand([], fake.io); await Promise.resolve();
    expect(fake.writes.at(-1)).toMatch(/^\x1b\[1;1H/);
    fake.input.emit("keypress", "q", {}); await run;
  });
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
  it("hides principals retained in the store but absent from accounts", () => {
    const snapshot = fixedModel();
    snapshot.observations.push(row({ principal_id: "claude2", meter_id: "claude2:all" }));
    expect(filterDashboardPrincipals(snapshot, new Set(["account-a", "account-b", "gpu-box"])).observations.map((row) => row.principal_id)).not.toContain("claude2");
  });
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
  it.skipIf(process.platform === "win32")("uses a real daemon snapshot within the interactive budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-dashboard-live-"));
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    await writeFile(join(root, "accounts.toml"), [
      "[[accounts]]",
      'name = "account-a"',
      'vendor = "codex"',
      'location = "/nonexistent/.codex"',
      'adapter = "native-ts"',
      "",
    ].join("\n"), { mode: 0o600 });
    const daemon = await HeadroomDaemon.create({ home: root, poller: async () => ({ observations: [], failures: [] }) });
    try {
      try { await daemon.start(); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      const store = await HeadroomStore.open(root);
      store.insert(row({ observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString() }));
      store.close();
      await expect(daemonRequest(socketPath(root), "status", {}, 50, 50)).resolves.toMatchObject({ status: "available" });
      await expect(daemonRequest(socketPath(root), "dashboard", {}, 50, 500)).resolves.toMatchObject({ status: "available", result: { observations: [expect.objectContaining({ meter_id: "account-a:all" })] } });
      const model = await gatherCachedDashboard(root);
      expect(model.direct).toBe(false);
      expect(renderDashboard(model, { width: 80, height: 24, verbose: false, eventsWide: false })[0]).toMatch(/daemon fresh \d+s ago/);
    } finally {
      await daemon.stop();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
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

function graphModel(): DashboardModel {
  const history = [[0, 0], [60, 12], [150, 38]].map(([minute, used]) => row({
    observed_at: new Date(Date.parse("2026-09-08T09:30:00Z") + minute * 60_000).toISOString(),
    fetched_at: new Date(Date.parse("2026-09-08T09:30:00Z") + minute * 60_000).toISOString(),
    resets_at: "2026-09-08T14:30:00Z", quantity: { used, remaining: 100 - used, limit: 100, unit: "percent" },
  }));
  return { ...fixedModel(), observations: [history[2]], history: { "account-a:all": history } };
}

describe("dashboard graphs (synthetic data)", () => {
  it("renders the exact 60-column braille burndown", () => {
    const model = graphModel();
    expect(renderBurndown(model.observations[0], model, 60).join("\n")).toMatchInlineSnapshot(`
      "100%│░░░░░░░░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░░░░⢀⣀⡠⠤⠒⠒⠉│
          │                           │             ⣀⡠⠤⠔⠒⠉⠁      │
          │                           │      ⣀⡠⠤⠔⠒⠉⠉             │
          │                           ⣀⡠⠤⠔⠒⠉⠉                    │
          │                    ⣀⣀⠤⠔⠒⠊⣉⡀                          │
          │             ⣀⣀⠤⠔⠒⣊⣉⠤⠤⠒⠒⠉⠉ │                          │
          │      ⢀⣀⠤⢔⣒⣊⠭⠤⠒⠒⠉⠉         │                          │
        0%│⣀⡤⠤⠶⠚⠛⠓⠉⠉⠁                 │                          │
      08/09, 11:30                              08/09, 16:30 reset
      38% used, 2h 30m left, under pace, HARVEST"
    `);
  });
  it("fits a 40-column panel with six plot rows and a compact summary", () => {
    const model = graphModel(), graph = renderBurndown(model.observations[0], model, 40);
    expect(graph).toHaveLength(8);
    expect(graph.every((line) => [...line].length <= 40)).toBe(true);
    expect(graph.slice(0, 6).every((line) => [...line].length === 40)).toBe(true);
    expect(graph[7]).toBe("38%, 2h 30m, under pace, HARVEST");
    expect(graph[0]).toMatch(/^100%│/); expect(graph[5]).toMatch(/^  0%│/);
  });
  it("puts the linear plan at 50 percent at half time, ending at 100", () => {
    const model = graphModel();
    for (const reading of model.history!["account-a:all"]) reading.quantity!.used = 0;
    const graph = renderBurndown(model.observations[0], model, 60);
    const dot = (x: number, y: number): boolean => {
      const char = [...graph[Math.floor(y / 4)]][5 + Math.floor(x / 2)];
      return /[\u2800-\u28ff]/.test(char) && Boolean((char.codePointAt(0)! - 0x2800) & [[1, 8], [2, 16], [4, 32], [64, 128]][y % 4][x % 2]);
    };
    // The dotted sample nearest halfway is (52, 16) on a 108 by 32 grid.
    expect(dot(52, 16)).toBe(true); expect(dot(52, 0)).toBe(false);
    expect(dot(107, 0)).toBe(true); expect(dot(0, 31)).toBe(true);
    expect([...graph[0]][32]).toBe("│");
  });
  it.each([0, 1])("collects until two distinct readings, with %s stored", (count) => {
    const model = graphModel();
    model.history!["account-a:all"] = model.history!["account-a:all"].slice(-count || 3);
    expect(renderBurndown(model.observations[0], model, 60)).toEqual(["  collecting readings"]);
  });
  it("keeps the prior graph after a reset instead of calling it collecting", () => {
    const model = graphModel(), current = model.observations[0];
    const reset = "2026-09-08T15:30:00Z";
    model.now = new Date("2026-09-08T15:35:00Z");
    model.observations[0] = { ...current, resets_at: reset, observed_at: "2026-09-08T15:34:00Z", fetched_at: "2026-09-08T15:34:00Z", quantity: { used: 1, remaining: 99, limit: 100, unit: "percent" } };
    const graph = renderBurndown(model.observations[0], model, 60).join("\n");
    expect(graph).toContain("new period, 1 reading");
    expect(graph).not.toContain("collecting readings");
  });
  it("dims a prior-period graph while the new period is collecting", async () => {
    const model = graphModel(), current = model.observations[0];
    model.now = new Date("2026-09-08T15:35:00Z");
    model.observations[0] = { ...current, resets_at: "2026-09-08T15:30:00Z", observed_at: "2026-09-08T15:34:00Z", fetched_at: "2026-09-08T15:34:00Z", quantity: { used: 1, remaining: 99, limit: 100, unit: "percent" } };
    const fake = terminal(); fake.io.gather = async () => model;
    await dashboardCommand(["--once"], fake.io);
    expect(fake.writes.join("")).toContain("new period, 1 reading so far");
    expect(fake.writes.join("")).toContain("\x1b[2m100%│");
  });
  it("does not count refetches, other windows, old resets, failed or future readings", () => {
    const model = graphModel(), current = model.observations[0];
    model.history![current.meter_id] = [current, { ...current, fetched_at: now.toISOString() },
      row({ observed_at: "2026-09-08T10:00:00Z" }),
      { ...current, window: { kind: "rolling", minutes: 10080, enforcement: "hard" }, observed_at: "2026-09-08T10:00:00Z" },
      { ...current, freshness: "failed", observed_at: "2026-09-08T10:30:00Z" },
      { ...current, observed_at: "2026-09-08T12:01:00Z" },
    ];
    expect(renderBurndown(current, model, 60)).toEqual(["  new period, 1 reading so far"]);
  });
  it("uses the earliest reading when duration is unavailable", () => {
    const model = graphModel();
    for (const reading of model.history!["account-a:all"]) reading.window!.minutes = null;
    const graph = renderBurndown(model.observations[0], model, 60);
    expect(graph[8]).toContain("08/09, 11:30");
    expect(graph[9]).toContain("pace unknown");
  });
  it("uses half blocks without braille with --ascii or TERM=dumb", async () => {
    const model = graphModel(), graph = renderBurndown(model.observations[0], model, 60, true).join("\n");
    expect(graph).toMatch(/[▀▄█]/); expect(graph).not.toMatch(/[\u2800-\u28ff]/);
    expect(graph).toContain(":"); expect(graph).toContain("."); expect(graph).toContain("|");
    expect(dashboardOptions(["--ascii"], true, {}).ascii).toBe(true);
    expect(dashboardOptions([], true, { TERM: "dumb" }).ascii).toBe(true);
    expect(dashboardOptions([], true, {}).ascii).toBe(false);
    const fake = terminal(); fake.io.gather = async () => model;
    await dashboardCommand(["--once", "--ascii", "--no-color"], fake.io);
    expect(fake.writes.join("")).toMatch(/[▀▄█]/); expect(fake.writes.join("")).not.toMatch(/[\u2800-\u28ff]/);
  });
  it("shades only a configured reserve and reports exact pacing points", () => {
    const model = graphModel(), current = model.observations[0];
    expect(renderBurndown(current, model, 60)[0]).toContain("░");
    model.policy = { ...model.policy, reserve: {} };
    expect(renderBurndown(current, model, 60).join("\n")).not.toContain("░");
    current.quantity!.used = 62;
    expect(renderBurndown(current, model, 60)[9]).toBe("62% used, 2h 30m left, over pace by 12 points");
    current.quantity!.used = 50;
    expect(renderBurndown(current, model, 60)[9]).toBe("50% used, 2h 30m left, on pace");
    current.freshness = "stale";
    expect(renderBurndown(current, model, 60).at(-1)).not.toContain("50% used");
  });
  it("keeps historical graphs when the current reading fails, without reporting current capacity", () => {
    const model = graphModel();
    model.observations = [{ ...model.observations[0], freshness: "failed", quantity: null }];
    const frame = renderDashboard(model, { width: 100, height: 40, verbose: false, eventsWide: false }).join("\n");
    expect(frame).toMatch(/[\u2800-\u28ff]/);
    expect(frame).toContain("?% used, 2h 30m left, pace unknown");
  });
  it("renders the weekly sparkline and day ticks with one marked event", () => {
    const model = fixedModel(), weekly = model.observations[1];
    model.history = { [weekly.meter_id]: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ ...weekly,
      observed_at: new Date(now.getTime() - (7 - day) * 86_400_000).toISOString(),
      quantity: { used: day * 12, remaining: 100 - day * 12, limit: 100, unit: "percent" as const },
    })) };
    model.events = [{ ...model.events[0], created_at: "2026-09-05T12:00:00Z", metadata: { unscheduled: true, window_minutes: 10080 } }];
    expect(renderWeekly(weekly, model, 100)[2].match(/\|[A-Z][a-z]{2}/g)).toEqual(["|Wed", "|Thu", "|Fri", "|Sat", "|Sun", "|Mon", "|Tue"]);
    const weeklyLines = renderWeekly(weekly, model, 100);
    expect(weeklyLines[1]).toMatch(/^[ \u2800-\u28ff]+$/);
    expect(weeklyLines[1]).not.toMatch(/[▁▂▃▄▅▆▇█]/);
    model.observations = [weekly];
    expect(renderDashboard(model, { width: 100, height: 60, verbose: false, eventsWide: false }).join("\n")).toContain("WEEKLY account-a:all");
    expect(renderDashboard(model, { width: 99, height: 60, verbose: false, eventsWide: false }).join("\n")).toContain("WEEKLY");
  });
  it("marks free resets and filters corrected, other-meter and other-window events", () => {
    const model = fixedModel(), weekly = model.observations[1], event = model.events[0];
    model.graphEvents = [
      { ...event, kind: "free_reset_used", created_at: "2026-09-04T12:00:00Z" },
      { ...event, kind: "free_reset_granted", created_at: "2026-09-05T12:00:00Z" },
      { ...event, corrected_by: "correction", created_at: "2026-09-06T12:00:00Z" },
      { ...event, meter_id: "account-b:main", created_at: "2026-09-07T12:00:00Z" },
      { ...event, metadata: { unscheduled: true, window_minutes: 300 } },
    ];
    const line = renderWeekly(weekly, model, 100)[2];
    expect(line).toContain("F"); expect(line).not.toContain("!");
    model.graphEvents.push({ ...event, created_at: "2026-09-04T12:00:00Z" });
    expect(renderWeekly(weekly, model, 100)[2]).toContain("*");
  });
  it("shows art only at 100 columns and 30 terminal rows, with local clocks", async () => {
    const model = fixedModel();
    const frame = (width: number, height: number) => renderDashboard(model, { width, height, verbose: false, eventsWide: false });
    expect(frame(120, 40)[0]).toMatch(/^╷ ╷/);
    expect(frame(80, 24)[0]).toMatch(/^Headroom 0.1.0 \| daemon fresh 30s ago \| 14:00:00/);
    expect(frame(120, 29)[0]).toMatch(/^Headroom/);
    expect(frame(99, 40)[0]).toMatch(/^Headroom/);
    expect(frame(100, 30)[0]).toMatch(/^╷ ╷/);
    expect(frame(120, 40).join("\n")).not.toContain(" UTC");
    expect(Intl.DateTimeFormat).toHaveBeenCalledWith(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const fake = terminal(); fake.output.rows = 24;
    await dashboardCommand(["--once"], fake.io);
    expect(fake.writes[0]).toMatch(/^Headroom/);
  });
  it("puts every pace glyph beside the percent without requiring color", () => {
    const model = graphModel(), current = model.observations[0];
    for (const [used, glyph, state] of [[50, "●", "NORMAL"], [30, "↗", "HARVEST"], [70, "⚠", "CONSERVE"], [98, "🛑", "FREEZE"]] as const) {
      current.quantity!.used = used;
      const frame = renderDashboard(model, { width: 100, height: 40, verbose: false, eventsWide: false, graphs: false }).join("\n");
      expect(frame).toContain(`${used}% ${glyph}`); expect(frame).toContain(state);
    }
    current.freshness = "failed";
    expect(renderDashboard(model, { width: 100, height: 40, verbose: false, eventsWide: false, graphs: false }).join("\n")).toContain("- ? resets in ? UNKNOWN");
  });
  it("prints shared UNKNOWN explanations once below the title and retains last readings", () => {
    const model = fixedModel(), failed = model.observations[2];
    failed.reason = "keychain grant needed; run: headroom keychain grant --principal account-b";
    model.observations = [failed, { ...failed, window: { kind: "rolling", minutes: 10080, enforcement: "hard" } }];
    const lines = renderDashboard(model, { width: 40, height: 40, verbose: false, eventsWide: false });
    expect(lines.find((line) => line.includes("UNKNOWN: macOS has not let Headroom"))).toBeDefined();
    expect(lines.join("\n").match(/macOS has not/g)).toHaveLength(1);
    expect(lines.join("\n").match(/last 41%/g)).toHaveLength(2);
    expect(lines.every((line) => [...line].length <= 40)).toBe(true);
    model.observations[1].reason = "separate failure";
    const distinct = renderDashboard(model, { width: 100, height: 40, verbose: false, eventsWide: false }).join("\n");
    expect(distinct).toContain("macOS has not let Headroom"); expect(distinct).not.toContain("separate failure");
  });
  it("toggles graphs with g, redraws without gathering, and saves rows", async () => {
    const model = graphModel(), state = { paused: false, verbose: false, eventsWide: false, help: false, quit: false, graphs: true };
    expect(handleDashboardKey(state, "g").graphs).toBe(false);
    expect(handleDashboardKey(handleDashboardKey(state, "g"), "g")).toEqual(state);
    const view = { width: 120, height: 40, verbose: false, eventsWide: false };
    expect(renderDashboard(model, { ...view, graphs: false }).length).toBeLessThan(renderDashboard(model, view).length);
    const fake = terminal(); fake.io.gather = vi.fn(async () => model);
    const run = dashboardCommand([], fake.io); await Promise.resolve();
    expect(fake.writes.at(-1)).toMatch(/[\u2800-\u28ff]/);
    fake.input.emit("keypress", "g", {});
    expect(fake.writes.at(-1)).not.toMatch(/[\u2800-\u28ff]/);
    fake.input.emit("keypress", "g", {});
    expect(fake.writes.at(-1)).toMatch(/[\u2800-\u28ff]/);
    expect(fake.io.gather).toHaveBeenCalledTimes(1);
    fake.input.emit("keypress", "q", {}); await run;
  });
});

describe("dashboard graph gathering", () => {
  it.skipIf(process.platform === "win32")("recognizes an older live daemon without requesting status or polling", async () => {
    const { daemonRequest } = await import("../src/daemon.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-dashboard-old-"));
    const path = join(root, "test.sock"), methods: string[] = [];
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (data) => {
        const request = JSON.parse(data.toString()); methods.push(request.method);
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(request.method === "health" ? { result: { alive: true } } : { error: { code: -32601, message: "Method not found" } }) }) + "\n");
      });
    });
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
      const fallback = vi.fn(async () => fixedModel());
      const result = await dashboardRead({ request: () => daemonRequest(path, "dashboard", {}, 250, 250), fallback });
      expect(result.direct).toBe(false); expect(fallback).toHaveBeenCalledTimes(1);
      expect(methods).toEqual(["health", "dashboard"]);
      expect(renderDashboard({ ...fixedModel(), ...result.snapshot, direct: result.direct }, { width: 80, height: 24, verbose: false, eventsWide: false })[0]).toContain("daemon fresh 30s ago");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps malformed replies, unrelated errors and absent daemons on direct reads", async () => {
    const fallback = vi.fn(async () => fixedModel());
    for (const reply of [{ status: "absent" }, { status: "unresponsive" }, { status: "available", result: {} }, { status: "available", result: { error: { code: -32001 } } }]) {
      expect((await dashboardRead({ request: async () => reply, fallback })).direct).toBe(true);
    }
    expect((await dashboardRead({ request: async () => { throw new Error("socket failed"); }, fallback })).direct).toBe(true);
    fallback.mockClear();
    expect((await dashboardRead({ request: async () => ({ status: "available", result: { result: fixedModel() } }), fallback })).direct).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("reads each meter once across windows and retains older weekly events", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-dashboard-history-")), store = await HeadroomStore.open(root);
    try {
      const model = graphModel();
      store.insertAll(model.history!["account-a:all"]);
      const history = vi.spyOn(store, "history"), events = vi.spyOn(store, "events").mockReturnValue(Array.from({ length: 12 }, (_, i) => ({ ...model.events[0], id: `synthetic-${i}` })));
      const graph = readDashboardGraphs(store, [...model.observations, fixedModel().observations[1]], now);
      expect(history).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledWith("account-a:all", "2026-09-01T12:00:00.000Z");
      expect(graph.history!["account-a:all"]).toHaveLength(3);
      expect(graph.graphEvents).toHaveLength(12);
      expect(events).toHaveBeenCalledWith("2026-09-01T12:00:00.000Z");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("gathers graphs with the cached socket snapshot and closes the history store", async () => {
    const daemon = await import("../src/daemon.js"), config = await import("../src/config.js"), registry = await import("../src/registry.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-dashboard-gather-")), store = await HeadroomStore.open(root);
    const model = graphModel(); store.insertAll(model.history!["account-a:all"]);
    const request = vi.spyOn(daemon, "daemonRequest").mockResolvedValue({ status: "available", result: { result: model } });
    vi.spyOn(config, "readPolicy").mockResolvedValue(model.policy);
    vi.spyOn(registry, "readAccounts").mockResolvedValue([]);
    vi.spyOn(HeadroomStore, "open").mockResolvedValue(store);
    const close = vi.spyOn(store, "close"), latest = vi.spyOn(store, "latestPerWindow");
    try {
      vi.useFakeTimers(); vi.setSystemTime(now);
      const gathered = await gatherDashboard();
      expect(gathered.direct).toBe(false); expect(gathered.history!["account-a:all"]).toHaveLength(3);
      expect(request).toHaveBeenCalledWith(expect.stringMatching(/headroom\.sock$|^\\\\\.\\pipe\\headroom-/), "dashboard", {}, 50, 500);
      expect(latest).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
    } finally { if (!close.mock.calls.length) store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
