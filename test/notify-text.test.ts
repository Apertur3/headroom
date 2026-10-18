import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyCommand, notifyText, parseNotifyConfig, parseTextArgs, type CommandRunner, type NotifyConfig, type NotifyOptions } from "../src/notify.js";
import { HeadroomStore } from "../src/store.js";

const TOKEN = "9876543:AA-not-a-real-token";
const BASE = `
[notify]
channels = ["telegram"]

[notify.telegram]
chat_id = "123456"
`;
const QUIET = BASE.replace("[notify.telegram]", 'quiet_hours = "23:00-07:00"\n\n[notify.telegram]');

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const secretStore: CommandRunner = async (_command, args) => {
  if (args.includes("headroom-telegram")) return `${TOKEN}\n`;
  throw new Error("not found");
};

function config(text = BASE): NotifyConfig {
  const parsed = parseNotifyConfig(text);
  if (!parsed) throw new Error("expected a notify config");
  return parsed;
}

async function setup(text = BASE, status = 200) {
  const home = join(await mkdtemp(join(tmpdir(), "headroom-notify-text-")), ".headroom");
  temporary.push(join(home, ".."));
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (input) => { bodies.push(JSON.parse(await (input as Request).text()).text); return new Response("ok", { status }); };
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const run = async (argv: string[], at: string): Promise<number> => {
    const options: NotifyOptions = { home, config: config(text), fetcher, run: secretStore, platform: "darwin", now: new Date(at) };
    return notifyText(parseTextArgs(argv), options);
  };
  const ledger = async () => { const store = await HeadroomStore.open(home); try { return store.notifyLedger(10); } finally { store.close(); } };
  return { bodies, log, run, ledger };
}

describe("headroom notify --text", () => {
  it("sends the titled message once and records it in the ledger", async () => {
    const { bodies, run, ledger } = await setup();
    expect(await run(["--text", "disk is full", "--kind", "watchdog"], "2026-10-18T12:00:00")).toBe(0);
    expect(bodies).toEqual(["🚨 watchdog\ndisk is full"]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "telegram", status: "sent" });
    expect(rows[0].text).toContain("disk is full");
  });

  it("sends the bare message when no kind is given", async () => {
    const { bodies, run } = await setup();
    expect(await run(["--text", "hello"], "2026-10-18T12:00:00")).toBe(0);
    expect(bodies).toEqual(["hello"]);
  });

  it("suppresses inside the interval, then sends again after it", async () => {
    const { bodies, log, run } = await setup();
    expect(await run(["--text", "a", "--kind", "k", "--every", "30"], "2026-10-18T12:00:00")).toBe(0);
    expect(await run(["--text", "b", "--kind", "k", "--every", "30"], "2026-10-18T12:10:00")).toBe(3);
    expect(log).toHaveBeenCalledWith("suppressed: last k notice 10m ago");
    expect(await run(["--text", "c", "--kind", "k", "--every", "30"], "2026-10-18T12:30:00")).toBe(0);
    expect(bodies).toHaveLength(2);
  });

  it("rate limits each kind independently", async () => {
    const { bodies, run } = await setup();
    expect(await run(["--text", "a", "--kind", "one"], "2026-10-18T12:00:00")).toBe(0);
    expect(await run(["--text", "b", "--kind", "two"], "2026-10-18T12:01:00")).toBe(0);
    expect(await run(["--text", "c", "--kind", "one"], "2026-10-18T12:02:00")).toBe(3);
    expect(bodies).toHaveLength(2);
  });

  it("defers in quiet hours without using the rate limit, and the flag bypasses it", async () => {
    const { bodies, log, run } = await setup(QUIET);
    expect(await run(["--text", "a", "--kind", "k"], "2026-10-18T23:30:00")).toBe(4);
    expect(log).toHaveBeenCalledWith("deferred: quiet hours until 07:00");
    expect(bodies).toHaveLength(0);
    expect(await run(["--text", "a", "--kind", "k", "--ignore-quiet-hours"], "2026-10-18T23:31:00")).toBe(0);
    expect(await run(["--text", "a", "--kind", "k"], "2026-10-19T08:00:00")).toBe(0);
    expect(bodies).toHaveLength(2);
  });

  it("rejects bad arguments as usage errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const bad of [["--text", "x", "--kind", "Bad Kind"], ["--text", "x", "--kind", "a".repeat(41)], ["--text", "x", "--every", "soon"], ["--text", ""], ["--text", "x", "--nope"]]) {
      expect(await notifyCommand(bad)).toBe(2);
    }
    expect(parseTextArgs(["--text", "x", "--kind", "a-1"]).kind).toBe("a-1");
  });

  it("caps the message and scrubs secrets", async () => {
    const { bodies, run } = await setup();
    expect(await run(["--text", `${TOKEN} ${"x".repeat(5000)}`], "2026-10-18T12:00:00")).toBe(0);
    expect(bodies[0]).toHaveLength(3800);
    expect(bodies[0]).not.toContain(TOKEN);
  });

  it("exits 1 and does not start the rate limit when every channel fails", async () => {
    const { run, ledger } = await setup(BASE, 500);
    expect(await run(["--text", "a", "--kind", "k"], "2026-10-18T12:00:00")).toBe(1);
    expect((await ledger())[0].status).toBe("failed");
    expect(await run(["--text", "a", "--kind", "k"], "2026-10-18T12:01:00")).toBe(1);
  });
});
