import { describe, expect, it } from "vitest";
import {
  CHUNK_LIMIT, DEFAULT_NOTIFY_EVENTS, TELEGRAM_SECRET, chunkMessage, combineTexts, inQuietHours,
  parseNotifyConfig, parseQuietHours, prepareChannels, readSecret, scrubSecrets, secretStoreCommand, secretStoreHint,
  type CommandRunner, type NotifyConfig,
} from "../src/notify.js";

const FULL_CONFIG = `
freeze_reserve_pct = 10

[notify]
channels = ["telegram", "ntfy", "webhook"]
events = ["reset_seen", "source_failed", "threshold"]
threshold_percent = 90
quiet_hours = "23:00-07:00"

[notify.telegram]
chat_id = "123456"

[notify.ntfy]
topic = "headroom-example"

[notify.webhook]
url = "https://example.com/hook"
`;

function config(text = FULL_CONFIG): NotifyConfig {
  const parsed = parseNotifyConfig(text);
  if (!parsed) throw new Error("expected a notify config");
  return parsed;
}

describe("notify config", () => {
  it("reads the notify tables and leaves the rest of policy.toml alone", () => {
    const parsed = config();
    expect(parsed.channels).toEqual(["telegram", "ntfy", "webhook"]);
    expect(parsed.events).toEqual(["reset_seen", "source_failed", "threshold"]);
    expect(parsed.threshold_percent).toBe(90);
    expect(parsed.quiet_hours).toEqual({ start: 23 * 60, end: 7 * 60 });
    expect(parsed.telegram.chat_id).toBe("123456");
    expect(parsed.ntfy).toEqual({ topic: "headroom-example", server: "https://ntfy.sh" });
    expect(parsed.webhook.url).toBe("https://example.com/hook");
  });

  it("is absent when policy.toml has no notify section, and defaults its event list", () => {
    expect(parseNotifyConfig("freeze_reserve_pct = 10\n[principal.claude-main]\ninterval_minutes = 5\n")).toBeUndefined();
    expect(config('[notify]\nchannels = ["ntfy"]\n[notify.ntfy]\ntopic = "t"\n').events).toEqual([...DEFAULT_NOTIFY_EVENTS]);
  });

  it("refuses an unknown channel, an unknown event, an unknown key and an out-of-range threshold", () => {
    expect(() => parseNotifyConfig('[notify]\nchannels = ["pager"]\n')).toThrow(/unknown channel/);
    expect(() => parseNotifyConfig('[notify]\nevents = ["reset_seeen"]\n')).toThrow(/unknown event/);
    expect(() => parseNotifyConfig("[notify]\nthreshold_pct = 90\n")).toThrow(/unknown \[notify\] key/);
    expect(() => parseNotifyConfig("[notify]\nthreshold_percent = 140\n")).toThrow(/threshold_percent/);
    expect(() => parseNotifyConfig('[notify]\n[notify.webhook]\nurl = "ftp://example.com/hook"\n')).toThrow(/http or https/);
    expect(() => parseNotifyConfig('[notify]\n[notify.ntfy]\ntopic = "not a topic!"\n')).toThrow(/ntfy topic/);
  });

  it("takes an overridden ntfy server without its trailing slash", () => {
    expect(config('[notify]\n[notify.ntfy]\ntopic = "t"\nserver = "https://ntfy.example.com/"\n').ntfy.server).toBe("https://ntfy.example.com");
  });
});

describe("quiet hours", () => {
  it("wraps across midnight and treats an empty range as never quiet", () => {
    const wrapping = config();
    expect(inQuietHours(wrapping, new Date(2026, 8, 3, 23, 30))).toBe(true);
    expect(inQuietHours(wrapping, new Date(2026, 8, 3, 3, 0))).toBe(true);
    expect(inQuietHours(wrapping, new Date(2026, 8, 3, 7, 0))).toBe(false);
    expect(inQuietHours(wrapping, new Date(2026, 8, 3, 12, 0))).toBe(false);
    expect(inQuietHours({ ...wrapping, quiet_hours: { start: 60, end: 60 } }, new Date(2026, 8, 3, 1, 0))).toBe(false);
    expect(inQuietHours({ ...wrapping, quiet_hours: null }, new Date(2026, 8, 3, 23, 30))).toBe(false);
  });

  it("refuses a range that is not a clock time", () => {
    expect(() => parseQuietHours("23:00")).toThrow(/quiet_hours/);
    expect(() => parseQuietHours("25:00-07:00")).toThrow(/clock time/);
  });
});

describe("message shaping", () => {
  it("keeps every chunk under the limit and splits a single overlong line", () => {
    const long = `${"a".repeat(CHUNK_LIMIT * 2 + 11)}\nshort tail`;
    const chunks = chunkMessage(long);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT);
    expect(chunks.join("").replace(/\n/g, "")).toContain("short tail");
  });

  it("packs whole lines together and only breaks between them", () => {
    const line = "b".repeat(1000);
    const chunks = chunkMessage(Array.from({ length: 8 }, () => line).join("\n"));
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT);
  });

  it("labels a single event and folds a batch into one message", () => {
    expect(combineTexts(["reset_seen claude-main:all"])).toBe("Headroom: reset_seen claude-main:all");
    expect(combineTexts(["one", "two"])).toBe("Headroom: 2 events\n- one\n- two");
  });
});

describe("secret store", () => {
  it("builds an argument vector per platform and never a shell string", () => {
    expect(secretStoreCommand(TELEGRAM_SECRET, "darwin")).toEqual({ command: "security", args: ["find-generic-password", "-a", "headroom", "-s", "headroom-telegram", "-w"] });
    expect(secretStoreCommand(TELEGRAM_SECRET, "linux")).toEqual({ command: "secret-tool", args: ["lookup", "service", "headroom-telegram"] });
    const windows = secretStoreCommand(TELEGRAM_SECRET, "win32");
    expect(windows?.command).toBe("powershell");
    expect(windows?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(windows?.args[3]).toContain("headroom-telegram");
    expect(secretStoreCommand(TELEGRAM_SECRET, "freebsd")).toBeUndefined();
    expect(() => secretStoreCommand("headroom-telegram; rm -rf /", "darwin")).toThrow(/unexpected secret name/);
    expect(secretStoreHint(TELEGRAM_SECRET, "darwin")).toContain("security add-generic-password");
  });

  it("returns a reason instead of the store's own output when the lookup fails", async () => {
    const secret = "9876543:AA-not-a-real-token";
    const leaky: CommandRunner = async () => { throw new Error(`security: ${secret} could not be verified`); };
    const missing: CommandRunner = async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
    const failed = await readSecret(TELEGRAM_SECRET, { platform: "darwin", run: leaky });
    expect(failed.secret).toBeUndefined();
    expect(failed.reason).not.toContain(secret);
    expect(failed.reason).toContain("security add-generic-password");
    expect((await readSecret(TELEGRAM_SECRET, { platform: "darwin", run: missing })).reason).toContain("security is not installed");
    expect((await readSecret(TELEGRAM_SECRET, { platform: "freebsd" })).reason).toContain("no OS secret store on freebsd");
    expect((await readSecret(TELEGRAM_SECRET, { platform: "darwin", run: async () => "  \n" })).reason).toContain("empty");
  });

  it("scrubs a token that matches none of the vendor redaction patterns", () => {
    const secret = "9876543:AA-not-a-real-token";
    expect(scrubSecrets(new Error(`POST failed for bot${secret}`), [secret])).toBe("POST failed for bot[REDACTED]");
    expect(scrubSecrets("mailed owner@example.com", [])).toContain("[REDACTED]");
  });
});

describe("channel readiness", () => {
  const token = "9876543:AA-not-a-real-token";
  const store: CommandRunner = async (command, args) => {
    if (args.includes(TELEGRAM_SECRET)) return `${token}\n`;
    throw new Error("not found");
  };

  it("disables a channel with a doctor-style reason instead of falling back to a file", async () => {
    const channels = await prepareChannels(config(), { platform: "darwin", run: async () => { throw new Error("not found"); } });
    expect(channels.find((channel) => channel.channel === "telegram")).toMatchObject({ ready: false });
    expect(channels.find((channel) => channel.channel === "telegram")?.detail).toContain("security add-generic-password");
    // ntfy needs no credential, and a webhook without a stored bearer still
    // posts, unauthenticated and saying so.
    expect(channels.find((channel) => channel.channel === "ntfy")).toMatchObject({ ready: true, detail: "https://ntfy.sh/headroom-example" });
    expect(channels.find((channel) => channel.channel === "webhook")).toMatchObject({ ready: true });
    expect(channels.find((channel) => channel.channel === "webhook")?.detail).toContain("no bearer stored");
  });

  it("disables a channel whose own config half is missing", async () => {
    const channels = await prepareChannels(config('[notify]\nchannels = ["telegram", "ntfy", "webhook"]\n'), { platform: "darwin", run: store });
    expect(channels.map((channel) => [channel.channel, channel.ready])).toEqual([["telegram", false], ["ntfy", false], ["webhook", false]]);
    expect(channels[0].detail).toContain("no chat_id");
    expect(channels[1].detail).toContain("no topic");
    expect(channels[2].detail).toContain("no url");
  });

  it("never puts the bot token in a channel's own description", async () => {
    const channels = await prepareChannels(config(), { platform: "darwin", run: store });
    expect(channels.find((channel) => channel.channel === "telegram")).toMatchObject({ ready: true, detail: "chat 123456" });
    expect(JSON.stringify(channels)).not.toContain(token);
  });
});
