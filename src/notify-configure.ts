import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { headroomHome, assertSafeAncestry } from "./paths.js";
import { readBoundedRegularFile, safeOutputDirectory, writeFileAtomic } from "./security.js";
import {
  NOTIFY_EVENT_NAMES, PRESET_EVENTS, TELEGRAM_SECRET, notifyTest, parseNotifyConfig,
  parseQuietHours, prepareChannels, resolveNotifyEvents, secretStoreHint, wantsEvent,
  type ChannelName, type NotifyConfig, type NotifyOptions, type NotifyPreset,
} from "./notify.js";
import type { HeadroomEvent } from "./types.js";

export type Ask = (question: string) => Promise<string>;
export interface ConfigureOptions extends NotifyOptions {
  ask?: Ask;
  print?: (text: string) => void;
}

export const PRESET_DESCRIPTIONS: Record<NotifyPreset, string> = {
  calm: "Useful changes: unexpected and weekly resets, reset credits, outages, recoveries and thresholds.",
  quiet: "Only unexpected resets, source failures and thresholds.",
  everything: "Every event, including scheduled 5h resets, stalls, new buckets and grant lapses.",
};
const EVENT_LABELS: Record<string, string> = {
  reset_unscheduled: "Unscheduled resets (any window)", reset_scheduled_weekly: "Weekly resets",
  reset_scheduled_short: "Scheduled 5h resets", free_reset_granted: "Free reset credits granted",
  free_reset_used: "Free resets used", credits_changed: "Credit balance changes", plan_changed: "Plan changes",
  source_failed: "Source failures", source_recovered: "Source recoveries", threshold: "Threshold crossings",
  pace_projection_conserve: "Projected stalls (once per window, plus one escalation)", model_new: "New model buckets", grant_lapsed: "Keychain grant lapses",
  lease_started: "Leases started", lease_ended: "Leases ended", vendor_inconsistent: "Vendor readings inconsistent", reset_seen: "Other scheduled resets",
};

function clock(minutes: number): string { return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }
function quietText(config: NotifyConfig): string { return config.quiet_hours ? `${clock(config.quiet_hours.start)}-${clock(config.quiet_hours.end)}` : "none"; }

export function notifyTable(config: NotifyConfig): string {
  const lines = ["[notify]", `channels = ${JSON.stringify(config.channels)}`, `preset = ${JSON.stringify(config.preset)}`,
    `events_on = ${JSON.stringify(config.events_on)}`, `events_off = ${JSON.stringify(config.events_off)}`];
  if (config.threshold_percent !== null) lines.push(`threshold_percent = ${config.threshold_percent}`);
  if (config.quiet_hours) lines.push(`quiet_hours = ${JSON.stringify(quietText(config))}`);
  if (config.telegram.chat_id) lines.push("", "[notify.telegram]", `chat_id = ${JSON.stringify(config.telegram.chat_id)}`);
  if (config.ntfy.topic) lines.push("", "[notify.ntfy]", `topic = ${JSON.stringify(config.ntfy.topic)}`, `server = ${JSON.stringify(config.ntfy.server)}`);
  if (config.webhook.url) lines.push("", "[notify.webhook]", `url = ${JSON.stringify(config.webhook.url)}`);
  return `${lines.join("\n")}\n`;
}

/** Replace notify settings at their existing headers, retaining all other lines verbatim. */
export function rewriteNotifyTable(original: string, table: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const sections = new Map<string, string[]>();
  let section = "";
  for (const line of table.trimEnd().split("\n")) {
    const header = /^\[(notify(?:\.[\w]+)?)\]$/.exec(line);
    if (header) { section = header[1]; sections.set(section, []); }
    else if (line) sections.get(section)?.push(line);
  }
  let inNotify = false;
  let output = "";
  for (const raw of original.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = raw.replace(/\r?\n$/, "");
    const header = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1].trim();
      inNotify = section === "notify" || section.startsWith("notify.");
      if (inNotify) {
        const settings = sections.get(section);
        if (settings) {
          output += raw.endsWith("\n") ? raw : raw + newline;
          output += settings.map((setting) => setting + newline).join("");
          sections.delete(section);
        }
        continue;
      }
    }
    if (!inNotify || !line.trim() || line.trimStart().startsWith("#")) output += raw;
  }
  for (const [name, settings] of sections) {
    if (output && !output.endsWith("\n")) output += newline;
    output += `[${name}]${newline}${settings.join(newline)}${newline}`;
  }
  return output;
}

async function answer(ask: Ask, label: string, current: string): Promise<string> {
  return (await ask(`${label} [${current}] `)).trim() || current;
}

async function yesNo(ask: Ask, label: string, current = false): Promise<boolean> {
  for (;;) {
    const value = (await ask(`${label} [${current ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    if (!value) return current;
    if (["y", "yes", "n", "no"].includes(value)) return value === "y" || value === "yes";
  }
}

export async function pickNotifications(current: NotifyConfig, ask: Ask, print: (text: string) => void = console.log): Promise<NotifyConfig> {
  const next: NotifyConfig = structuredClone(current);
  const channels = await answer(ask, "Channels (telegram, ntfy, webhook; comma separated, or none)", current.channels.join(", ") || "none");
  next.channels = channels === "none" ? [] : [...new Set(channels.split(",").map((value) => value.trim()))] as ChannelName[];
  for (const channel of next.channels) {
    if (channel === "telegram") next.telegram.chat_id = await answer(ask, "Telegram chat ID", current.telegram.chat_id ?? "");
    else if (channel === "ntfy") {
      next.ntfy.topic = await answer(ask, "ntfy topic", current.ntfy.topic ?? "");
      next.ntfy.server = await answer(ask, "ntfy server", current.ntfy.server);
    } else if (channel === "webhook") next.webhook.url = await answer(ask, "Webhook URL (no credentials)", current.webhook.url ?? "");
    else throw new Error(`Unknown notification channel: ${channel}`);
  }
  for (const [preset, description] of Object.entries(PRESET_DESCRIPTIONS)) print(`${preset}: ${description}`);
  const preset = await answer(ask, "Preset", current.preset);
  if (preset !== "calm" && preset !== "quiet" && preset !== "everything") throw new Error("Preset must be calm, quiet or everything");
  next.preset = preset;
  // Retain existing choices on Enter, including policies using the older events list.
  const selected = new Set(preset === current.preset ? current.events : PRESET_EVENTS[preset]);
  if (preset === current.preset) {
    for (const [name, minutes, unscheduled] of [["reset_unscheduled", 300, true], ["reset_scheduled_weekly", 10_080, false], ["reset_scheduled_short", 300, false]] as const) {
      if (wantsEvent({ kind: "reset_seen", metadata: { window_minutes: minutes, unscheduled } } as HeadroomEvent, current)) selected.add(name);
      else selected.delete(name);
    }
  }
  selected.delete("reset_seen");
  if (await yesNo(ask, "Adjust individual events?")) {
    for (const name of NOTIFY_EVENT_NAMES.filter((name) => name !== "reset_seen")) {
      const enabled = await yesNo(ask, `${EVENT_LABELS[name]} (preset: ${PRESET_EVENTS[preset].includes(name) ? "yes" : "no"})`, selected.has(name));
      if (enabled) selected.add(name); else selected.delete(name);
    }
  }
  next.events_on = [...selected].filter((name) => !PRESET_EVENTS[preset].includes(name));
  next.events_off = PRESET_EVENTS[preset].filter((name) => !selected.has(name));
  if (preset === current.preset && current.events_off.includes("reset_seen") && ![...selected].some((name) => name.startsWith("reset_"))) next.events_off.push("reset_seen");
  next.events = resolveNotifyEvents(preset, next.events_on, next.events_off);
  const quiet = await answer(ask, "Quiet hours (local HH:MM-HH:MM, or none)", quietText(current));
  next.quiet_hours = quiet === "none" ? null : parseQuietHours(quiet);
  const checked = parseNotifyConfig(notifyTable(next))!;
  for (const channel of checked.channels) {
    if (channel === "telegram" && !checked.telegram.chat_id || channel === "ntfy" && !checked.ntfy.topic || channel === "webhook" && !checked.webhook.url) throw new Error(`Missing ${channel} destination`);
  }
  return checked;
}

export async function configureNotifications(argv: string[], options: ConfigureOptions = {}): Promise<number> {
  if (argv.some((arg) => arg !== "--dry-run")) throw new Error("Usage: headroom notify configure [--dry-run]");
  const dryRun = argv.includes("--dry-run");
  const print = options.print ?? console.log;
  const home = options.home ?? headroomHome();
  const path = join(home, "policy.toml");
  await assertSafeAncestry(home);
  let original = "";
  try { original = await readBoundedRegularFile(path); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const current = parseNotifyConfig(original) ?? parseNotifyConfig("[notify]\n")!;
  const rl = options.ask ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl && !process.stdin.isTTY ? rl[Symbol.asyncIterator]() : undefined;
  const ask: Ask = options.ask ?? (async (question) => {
    if (!lines) return rl!.question(question);
    print(question);
    const line = await lines.next();
    if (line.done && !dryRun && !question.startsWith("Send a test message")) throw new Error("Input ended; notification settings were not written");
    return line.value ?? "";
  });
  try {
    const config = await pickNotifications(current, ask, print);
    const table = notifyTable(config);
    print(`${dryRun ? "Would write" : "Notification settings for"} ${path}:\n${table}`);
    if (config.channels.includes("telegram")) print(`Store the bot token in another terminal (hidden prompt):\n${secretStoreHint(TELEGRAM_SECRET, options.platform)}`);
    if (dryRun) { print("Dry run: no file write, secret lookup or test delivery."); return 0; }
    // A long-running picker must not overwrite an edit made while it was open.
    let latest = "";
    try { latest = await readBoundedRegularFile(path); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (latest !== original) throw new Error("policy.toml changed while configuring; run the picker again");
    await safeOutputDirectory(home);
    await writeFileAtomic(path, rewriteNotifyTable(original, table), 0o600);
    print(`Wrote ${path}.`);
    if (config.channels.length && await yesNo(ask, "Send a test message now?")) {
      const status = await prepareChannels(config, options);
      for (const channel of status) print(`${channel.channel}: ${channel.ready ? "ready" : channel.detail}`);
      if (status.some((channel) => !channel.ready)) { print("Store missing credentials, then run: headroom notify --test"); return 1; }
      return notifyTest({ ...options, config });
    }
    print("Test later: headroom notify --test");
    return 0;
  } finally { rl?.close(); }
}
