import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureNotifications, notifyTable, pickNotifications, rewriteNotifyTable } from "../src/notify-configure.js";
import { NOTIFY_EVENT_NAMES, parseNotifyConfig, resolveNotifyEvents, wantsEvent } from "../src/notify.js";
import type { HeadroomEvent } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const config = (lines = "") => parseNotifyConfig(`[notify]\n${lines}`)!;
const reset = (minutes: number | null, unscheduled = false) => ({ kind: "reset_seen", metadata: { window_minutes: minutes, unscheduled } }) as HeadroomEvent;
const failed = { kind: "source_failed" } as HeadroomEvent;
async function home(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "headroom-picker-")); temporary.push(value); return value; }
function script(answers: string[]) {
  return vi.fn(async (_question: string) => {
    if (!answers.length) throw new Error("Unexpected question");
    return answers.shift()!;
  });
}

describe("notification presets", () => {
  it("resolves all three presets with off winning a conflicting override", () => {
    expect(config().events).toEqual(["reset_unscheduled", "reset_scheduled_weekly", "free_reset_granted", "source_failed", "source_recovered", "threshold"]);
    expect(config('preset = "quiet"').events).toEqual(["reset_unscheduled", "source_failed", "threshold"]);
    expect(config('preset = "everything"').events).toContain("grant_lapsed");
    expect(config().threshold_percent).toBe(90);
    expect(resolveNotifyEvents("quiet", ["source_recovered", "model_new"], ["model_new", "source_failed"])).toEqual(["reset_unscheduled", "threshold", "source_recovered"]);
    expect(config('preset = "quiet"\nevents_on = ["model_new"]\nevents_off = ["source_failed"]').events).toContain("model_new");
    expect(wantsEvent(failed, config('events_off = ["source_failed"]'))).toBe(false);
    expect(() => config('preset = "loud"')).toThrow(/preset/);
    expect(() => config('events_off = ["typo"]')).toThrow(/unknown event/);
    expect(() => config('events_on = ["threshold", invalid]')).toThrow(/Invalid/);
  });

  it("classifies reset metadata without changing the stored event kind", () => {
    for (const preset of ["calm", "quiet", "everything"] as const) {
      const selected = config(`preset = "${preset}"`);
      expect(wantsEvent(reset(300, true), selected)).toBe(true);
      expect(wantsEvent(reset(10_080, true), selected)).toBe(true);
      expect(wantsEvent(reset(10_080), selected)).toBe(preset !== "quiet");
      expect(wantsEvent(reset(300), selected)).toBe(preset === "everything");
    }
    expect(wantsEvent(reset(300), config('events_on = ["reset_scheduled_short"]'))).toBe(true);
    expect(wantsEvent(reset(300), config('events = ["reset_seen"]\nnotify_scheduled_short = true'))).toBe(false);
    expect(wantsEvent(reset(300), config('events_on = ["reset_seen"]'))).toBe(false);
    expect(wantsEvent(reset(300), config('preset = "everything"\nevents_off = ["reset_scheduled_short"]'))).toBe(false);
    expect(wantsEvent(reset(300, true), config('events_off = ["reset_seen"]'))).toBe(false);
    expect(wantsEvent(reset(10_080), config('events_off = ["reset_scheduled_weekly"]'))).toBe(false);
    expect(wantsEvent(reset(null), config('preset = "everything"'))).toBe(true);
  });
});

describe("policy table rewrite", () => {
  it("edits existing notify tables in place and preserves other lines, comments and CRLF", () => {
    const original = '# Keep this\r\nfreeze_reserve_pct = 12 # floor\r\n[notify] # phone\r\n# chosen before\r\nchannels = ["ntfy"]\r\npreset = "quiet"\r\n\r\n[reserve]\r\n"*" = 7\r\n\r\n[notify.ntfy]\r\ntopic = "old"\r\n# Keep this too\r\n[principal.claude-main]\r\ninterval_minutes = 8';
    const table = '[notify]\nchannels = ["ntfy"]\npreset = "calm"\n\n[notify.ntfy]\ntopic = "new"\n';
    const output = rewriteNotifyTable(original, table);
    expect(output).toBe('# Keep this\r\nfreeze_reserve_pct = 12 # floor\r\n[notify] # phone\r\nchannels = ["ntfy"]\r\npreset = "calm"\r\n# chosen before\r\n\r\n[reserve]\r\n"*" = 7\r\n\r\n[notify.ntfy]\r\ntopic = "new"\r\n# Keep this too\r\n[principal.claude-main]\r\ninterval_minutes = 8');
    expect(parseNotifyConfig(output)?.ntfy.topic).toBe("new");
    expect(rewriteNotifyTable(output, table)).toBe(output);
  });

  it("appends a missing table without rewriting an existing section", () => {
    const original = '[reserve]\n"*" = 6';
    const output = rewriteNotifyTable(original, '[notify]\nchannels = []\n');
    expect(output).toBe(original + '\n[notify]\nchannels = []\n');
    expect(rewriteNotifyTable('', '[notify]\nchannels = []\n')).toBe('[notify]\nchannels = []\n');
  });
});

describe("scripted picker", () => {
  it("keeps current values on Enter and shows preset defaults on the event questions", async () => {
    const current = config('channels = ["ntfy"]\npreset = "quiet"\nevents_on = ["model_new"]\nquiet_hours = "22:00-06:00"\n[notify.ntfy]\ntopic = "fixture"');
    const answers = script(["", "", "", "", "y", ...NOTIFY_EVENT_NAMES.filter((name) => name !== "reset_seen").map(() => ""), ""]);
    const next = await pickNotifications(current, answers, () => undefined);
    expect(next).toEqual(current);
    expect(answers.mock.calls.some(([question]) => question.includes("New model buckets (preset: no) [Y/n]"))).toBe(true);
    expect(answers.mock.calls.some(([question]) => question.includes("Projected stalls (once per window, plus one escalation)"))).toBe(true);
  });

  it("writes choices using scripted answers and never reads a secret or sends when testing is declined", async () => {
    const root = await home();
    const original = '# untouched\n[reserve]\n"*" = 9\n';
    await writeFile(join(root, "policy.toml"), original);
    const run = vi.fn(async () => { throw new Error("Unexpected secret read"); });
    const fetcher = vi.fn(async () => { throw new Error("Unexpected notification"); });
    const ask = script(["ntfy", "fixture-topic", "", "quiet", "n", "23:00-07:00", "n"]);
    expect(await configureNotifications([], { home: root, ask, run, fetcher, print: () => undefined })).toBe(0);
    const written = await readFile(join(root, "policy.toml"), "utf8");
    expect(written.startsWith(original)).toBe(true);
    expect(parseNotifyConfig(written)).toMatchObject({ preset: "quiet", channels: ["ntfy"], quiet_hours: { start: 1380, end: 420 } });
    expect(run).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux", "win32"] as const)("dry run prints the %s storage command and writes or reads nothing", async (platform) => {
    const root = await home();
    const print = vi.fn();
    const run = vi.fn(async () => { throw new Error("Unexpected secret read"); });
    const fetcher = vi.fn(async () => { throw new Error("Unexpected notification"); });
    await configureNotifications(["--dry-run"], { home: root, platform, ask: script(["telegram", "123456", "calm", "n", "none"]), print, run, fetcher });
    expect(await readdir(root)).toEqual([]);
    const text = print.mock.calls.flat().join("\n");
    expect(text).toContain(platform === "darwin" ? "security add-generic-password -U -a headroom -s headroom-telegram -w" : platform === "linux" ? "secret-tool store --label=headroom service headroom-telegram" : "powershell -NoProfile -Command");
    expect(text).toContain('preset = "calm"');
    expect(run).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks readability before an explicitly requested test", async () => {
    const root = await home();
    const fetcher = vi.fn(async () => new Response("ok"));
    const run = vi.fn(async () => "");
    const options = { home: root, platform: "darwin" as const, ask: script(["telegram", "123456", "", "n", "none", "y"]), print: () => undefined, run, fetcher };
    expect(await configureNotifications([], options)).toBe(1);
    expect(run).toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await configureNotifications([], { ...options, ask: script(["", "", "", "n", "", "y"]), run: async () => "synthetic-fixture-token" })).toBe(0);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it("does not overwrite a concurrent edit or write an invalid destination", async () => {
    const root = await home();
    const path = join(root, "policy.toml");
    const answers = script(["ntfy", "fixture", "", "", "n", "none"]);
    await expect(configureNotifications([], { home: root, ask: async (question) => {
      if (question.startsWith("Quiet hours")) await writeFile(path, "# concurrent edit\n");
      return answers(question);
    }, print: () => undefined })).rejects.toThrow(/changed while configuring/);
    expect(await readFile(path, "utf8")).toBe("# concurrent edit\n");
    await expect(pickNotifications(config(), script(["ntfy", "bad topic", "", "", "n", "none"]), () => undefined)).rejects.toThrow(/ntfy topic/);
    expect(notifyTable(config())).not.toContain("notify_scheduled_short");
  });
});
