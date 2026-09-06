import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendDaemonLog } from "./logs.js";
import { headroomHome } from "./paths.js";
import { outboundFetch, redact } from "./security.js";
import { HeadroomStore } from "./store.js";
import type { EventKind, HeadroomEvent, NotifyDelivery } from "./types.js";

/** Telegram rejects a message body over 4096 characters. 3800 leaves room for
 * the batch header a combined quiet-hours message adds. */
export const CHUNK_LIMIT = 3800;
/** Every outbound notification call is bounded the same way a vendor read is. */
const TIMEOUT_MS = 5_000;
const RESPONSE_CAP_BYTES = 8 * 1024;
/** Attempts per event per channel before the ledger row stops being retried. */
export const MAX_ATTEMPTS = 3;
const TELEGRAM_ORIGIN = "https://api.telegram.org";
const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const WATERMARK_KEY = "notify_watermark";

export type ChannelName = "telegram" | "ntfy" | "webhook";
const CHANNEL_NAMES: readonly ChannelName[] = ["telegram", "ntfy", "webhook"];

const EVENT_KINDS: readonly EventKind[] = [
  "reset_seen", "free_reset_granted", "free_reset_used", "credits_changed", "plan_changed",
  "source_failed", "source_recovered", "lease_started", "lease_ended", "pace_projection_conserve", "model_new",
];
/** `threshold` is not a stored event kind: it is synthesized here from the
 * latest reading of every hard window, once per window instance. */
export const NOTIFY_EVENT_NAMES: readonly string[] = [...EVENT_KINDS, "threshold"];

/** What a `[notify] events` list defaults to: the changes an operator wants to
 * hear about, without the per-poll bookkeeping kinds (lease start/end, credit
 * counts) that would turn a phone into a ticker. */
export const DEFAULT_NOTIFY_EVENTS: readonly string[] = [
  "reset_seen", "free_reset_granted", "source_failed", "source_recovered", "pace_projection_conserve", "model_new", "threshold",
];

export interface QuietHours { start: number; end: number; }

export interface NotifyConfig {
  channels: ChannelName[];
  events: string[];
  threshold_percent: number | null;
  quiet_hours: QuietHours | null;
  telegram: { chat_id: string | null };
  ntfy: { topic: string | null; server: string };
  webhook: { url: string | null };
}

/** One queued notification: what the ledger stores, and what a channel renders. */
export interface NotifyItem {
  id: string;
  kind: string;
  meter: string | null;
  principal: string | null;
  at: string;
  text: string;
}

function invalid(detail: string): Error { return new Error(`Invalid Headroom notify config: ${detail}`); }

function stringValue(value: string): string | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
  return match ? JSON.parse(`"${match[1]}"`) as string : undefined;
}

function listValue(value: string): string[] | undefined {
  const match = /^\[(.*)\]$/.exec(value);
  return match ? [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => JSON.parse(`"${item[1]}"`) as string) : undefined;
}

/** "23:00-07:00" as minutes past local midnight, wrapping allowed. */
export function parseQuietHours(value: string): QuietHours {
  const match = /^([0-9]{2}):([0-9]{2})-([0-9]{2}):([0-9]{2})$/.exec(value.trim());
  if (!match) throw invalid(`quiet_hours must look like "23:00-07:00", got "${value}"`);
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) throw invalid(`quiet_hours is not a clock time: "${value}"`);
  return { start: startHour * 60 + startMinute, end: endHour * 60 + endMinute };
}

/** Local wall-clock membership, so an operator's "23:00-07:00" means their own
 * night wherever the machine is. An empty range (start equal to end) is never
 * quiet, rather than always quiet. */
export function inQuietHours(config: NotifyConfig, now = new Date()): boolean {
  if (!config.quiet_hours) return false;
  const { start, end } = config.quiet_hours;
  if (start === end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Reads only the `[notify]` tables out of policy.toml, the same deliberately
 * small hand-rolled TOML surface the rest of Headroom's config uses rather
 * than a general parser. Returns undefined when the file carries no notify
 * section at all, which is the "notifications are off" state.
 */
export function parseNotifyConfig(text: string): NotifyConfig | undefined {
  let section = "";
  let present = false;
  let channels: string[] | undefined;
  let events: string[] | undefined;
  let thresholdPercent: number | null = null;
  let quietHours: QuietHours | null = null;
  let chatId: string | null = null;
  let topic: string | null = null;
  let server = DEFAULT_NTFY_SERVER;
  let webhookUrl: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const header = /^\[([A-Za-z0-9_.]+)\]$/.exec(line);
    if (header) { section = header[1]; if (section === "notify" || section.startsWith("notify.")) present = true; continue; }
    if (section !== "notify" && !section.startsWith("notify.")) continue;
    const entry = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) throw invalid(line);
    const [, key, value] = entry;
    if (section === "notify") {
      if (key === "channels") { channels = listValue(value) ?? (() => { throw invalid(line); })(); continue; }
      if (key === "events") { events = listValue(value) ?? (() => { throw invalid(line); })(); continue; }
      if (key === "threshold_percent") { thresholdPercent = Number(value); continue; }
      if (key === "quiet_hours") { quietHours = parseQuietHours(stringValue(value) ?? value); continue; }
      throw invalid(`unknown [notify] key "${key}"`);
    }
    const scalar = stringValue(value);
    if (scalar === undefined) throw invalid(line);
    if (section === "notify.telegram" && key === "chat_id") { chatId = scalar; continue; }
    if (section === "notify.ntfy" && key === "topic") { topic = scalar; continue; }
    if (section === "notify.ntfy" && key === "server") { server = scalar.replace(/\/+$/, ""); continue; }
    if (section === "notify.webhook" && key === "url") { webhookUrl = scalar; continue; }
    throw invalid(`unknown key "${key}" in [${section}]`);
  }
  if (!present) return undefined;
  for (const channel of channels ?? []) if (!CHANNEL_NAMES.includes(channel as ChannelName)) throw invalid(`unknown channel "${channel}"`);
  for (const event of events ?? []) if (!NOTIFY_EVENT_NAMES.includes(event)) throw invalid(`unknown event "${event}"`);
  if (thresholdPercent !== null && (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100)) throw invalid("threshold_percent must be above 0 and at most 100");
  if (topic !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw invalid("ntfy topic must be 1 to 64 characters of letters, digits, hyphen or underscore");
  if (chatId !== null && !/^-?[0-9]{1,32}$|^@[A-Za-z0-9_]{1,64}$/.test(chatId)) throw invalid("telegram chat_id must be a numeric id or an @name");
  for (const [label, candidate] of [["ntfy server", server], ["webhook url", webhookUrl]] as const) {
    if (candidate === null) continue;
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { throw invalid(`${label} is not a URL`); }
    if (!/^https?:$/.test(parsed.protocol)) throw invalid(`${label} must be http or https`);
  }
  return {
    channels: (channels ?? []) as ChannelName[],
    events: events ? [...events] : [...DEFAULT_NOTIFY_EVENTS],
    threshold_percent: thresholdPercent,
    quiet_hours: quietHours,
    telegram: { chat_id: chatId },
    ntfy: { topic, server },
    webhook: { url: webhookUrl },
  };
}

export async function readNotifyConfig(home = headroomHome()): Promise<NotifyConfig | undefined> {
  let text: string;
  try { text = await readFile(join(home, "policy.toml"), "utf8"); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parseNotifyConfig(text);
}

/* -------------------------------------------------------------------------
 * Secrets. A channel credential is read from the OS secret store at send
 * time and never from a file: a missing store disables the channel with a
 * reason, and no code path here falls back to plaintext.
 * ---------------------------------------------------------------------- */

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const systemRunner: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true });
  return stdout;
};

export const TELEGRAM_SECRET = "headroom-telegram";
export const WEBHOOK_SECRET = "headroom-webhook";

/** Reads a generic Windows credential (the kind `cmdkey /generic:` stores)
 * through advapi32's CredRead. The service name is embedded literally, so
 * secretStoreCommand validates its shape first; no caller-supplied text ever
 * reaches this script, and the credential is spawned as an argument vector,
 * never as a shell string. */
function windowsCredentialScript(service: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class HeadroomCredential {",
    "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "  private struct Credential { public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment; public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }",
    "  [DllImport(\"advapi32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CredReadW(string target, int type, int flags, out IntPtr handle);",
    "  [DllImport(\"advapi32.dll\")] private static extern void CredFree(IntPtr handle);",
    "  public static string Read(string target) {",
    "    IntPtr handle;",
    "    if (!CredReadW(target, 1, 0, out handle)) { return null; }",
    "    try { Credential found = (Credential)Marshal.PtrToStructure(handle, typeof(Credential)); return Marshal.PtrToStringUni(found.Blob, found.BlobSize / 2); }",
    "    finally { CredFree(handle); }",
    "  }",
    "}",
    "'@",
    `$value = [HeadroomCredential]::Read('${service}')`,
    "if ($value -eq $null) { exit 1 }",
    "[Console]::Out.Write($value)",
  ].join("\n");
}

/** The read command for one platform's secret store, or undefined where
 * Headroom knows of none. Arguments are always a vector, never a shell
 * string, so a service name can never be interpreted as shell syntax. */
export function secretStoreCommand(service: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | undefined {
  if (!/^headroom-[a-z]+$/.test(service)) throw new Error("Refusing an unexpected secret name");
  if (platform === "darwin") return { command: "security", args: ["find-generic-password", "-a", "headroom", "-s", service, "-w"] };
  if (platform === "win32") return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", windowsCredentialScript(service)] };
  if (platform === "linux") return { command: "secret-tool", args: ["lookup", "service", service] };
  return undefined;
}

/** The command an operator runs once to put the credential in the store. */
export function secretStoreHint(service: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return `security add-generic-password -U -a headroom -s ${service} -w`;
  if (platform === "win32") return `cmdkey /generic:${service} /user:headroom /pass`;
  if (platform === "linux") return `secret-tool store --label=headroom service ${service}`;
  return `no OS secret store is supported on ${platform}`;
}

export interface SecretLookup { secret?: string; reason?: string; }

/**
 * Never returns the store command's own output on failure, and never logs
 * it: a secret store prints the secret on stdout, and an error path that
 * echoed stdout or an exec error's captured output would put the token into
 * a log line. Callers get either the secret or a reason built from constants.
 */
export async function readSecret(service: string, options: { platform?: NodeJS.Platform; run?: CommandRunner } = {}): Promise<SecretLookup> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? systemRunner;
  const command = secretStoreCommand(service, platform);
  if (!command) return { reason: `no OS secret store on ${platform}; ${service} cannot be read and the channel stays disabled` };
  let stdout: string;
  try { stdout = await run(command.command, command.args); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reason: `${command.command} is not installed, so ${service} cannot be read; install it or use a machine with a secret store` };
    return { reason: `${service} is not in the secret store; store it with: ${secretStoreHint(service, platform)}` };
  }
  const secret = stdout.trim();
  if (!secret) return { reason: `${service} is empty in the secret store; store it with: ${secretStoreHint(service, platform)}` };
  return { secret };
}

/** Replaces every known secret before redact() runs, so a token that matches
 * none of redact's vendor patterns still never reaches a log or an error. */
export function scrubSecrets(value: unknown, secrets: string[]): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) if (secret.length >= 4) message = message.split(secret).join("[REDACTED]");
  return redact(message);
}

/* -------------------------------------------------------------------------
 * Channels.
 * ---------------------------------------------------------------------- */

/** Reads at most RESPONSE_CAP_BYTES of a channel's reply. Only the first
 * bytes are ever needed (an error description), and a channel that answers
 * with an endless body must not be able to grow this process. */
async function boundedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < RESPONSE_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).subarray(0, RESPONSE_CAP_BYTES).toString("utf8");
}

async function send(fetcher: typeof fetch, url: string, init: RequestInit, allow: string[]): Promise<void> {
  const request = new Request(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const response = await outboundFetch(fetcher, request, { localBaseUrls: allow });
  const text = await boundedText(response);
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`.trim());
}

/** Splits on line boundaries where it can and mid-line only when a single
 * line is itself longer than the limit. */
export function chunkMessage(text: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > limit) {
      if (current) { chunks.push(current); current = ""; }
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > limit && current) { chunks.push(current); current = rest; }
    else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

/** One message for one event, or one batched message for everything a quiet
 * window held back. */
export function combineTexts(texts: string[]): string {
  if (texts.length === 1) return `Headroom: ${texts[0]}`;
  return [`Headroom: ${texts.length} events`, ...texts.map((text) => `- ${text}`)].join("\n");
}

export interface ChannelStatus {
  channel: ChannelName;
  ready: boolean;
  /** Where a ready channel delivers (never a secret), or why it is disabled. */
  detail: string;
}

interface PreparedChannel extends ChannelStatus {
  secrets: string[];
  deliver(items: NotifyItem[]): Promise<void>;
}

export interface NotifyOptions {
  home?: string;
  now?: Date;
  config?: NotifyConfig;
  fetcher?: typeof fetch;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  log?: (message: string) => Promise<void>;
}

/**
 * Resolves each configured channel into something that can send, or into a
 * doctor-style reason it cannot. A Telegram bot token is mandatory and its
 * absence disables the channel; a webhook bearer is optional and its absence
 * only means the POST carries no Authorization header.
 */
export async function prepareChannels(config: NotifyConfig, options: NotifyOptions = {}): Promise<ChannelStatus[]> {
  // Projected, not returned whole: the internal shape carries the resolved
  // credential, and a caller that prints or serializes this must not be able
  // to print it by accident.
  return (await prepareChannelsInternal(config, options)).map(({ channel, ready, detail }) => ({ channel, ready, detail }));
}

async function prepareChannelsInternal(config: NotifyConfig, options: NotifyOptions): Promise<PreparedChannel[]> {
  const fetcher = options.fetcher ?? fetch;
  const platform = options.platform ?? process.platform;
  const run = options.run;
  const prepared: PreparedChannel[] = [];
  for (const channel of config.channels) {
    if (channel === "telegram") {
      const chatId = config.telegram.chat_id;
      if (!chatId) { prepared.push({ channel, ready: false, detail: "no chat_id in [notify.telegram]", secrets: [], deliver: async () => undefined }); continue; }
      const lookup = await readSecret(TELEGRAM_SECRET, { platform, run });
      if (!lookup.secret) { prepared.push({ channel, ready: false, detail: lookup.reason ?? "no bot token", secrets: [], deliver: async () => undefined }); continue; }
      const token = lookup.secret;
      prepared.push({
        channel, ready: true, detail: `chat ${chatId}`, secrets: [token],
        deliver: async (items) => {
          for (const chunk of chunkMessage(combineTexts(items.map((item) => item.text)))) {
            await send(fetcher, `${TELEGRAM_ORIGIN}/bot${token}/sendMessage`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: chunk }),
            }, [TELEGRAM_ORIGIN]);
          }
        },
      });
      continue;
    }
    if (channel === "ntfy") {
      const topic = config.ntfy.topic;
      if (!topic) { prepared.push({ channel, ready: false, detail: "no topic in [notify.ntfy]", secrets: [], deliver: async () => undefined }); continue; }
      const url = `${config.ntfy.server}/${topic}`;
      prepared.push({
        channel, ready: true, detail: url, secrets: [],
        deliver: async (items) => {
          for (const chunk of chunkMessage(combineTexts(items.map((item) => item.text)))) {
            await send(fetcher, url, {
              method: "POST", headers: { "content-type": "text/plain; charset=utf-8", title: "Headroom" }, body: chunk,
            }, [config.ntfy.server]);
          }
        },
      });
      continue;
    }
    const url = config.webhook.url;
    if (!url) { prepared.push({ channel, ready: false, detail: "no url in [notify.webhook]", secrets: [], deliver: async () => undefined }); continue; }
    const bearer = await readSecret(WEBHOOK_SECRET, { platform, run });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer.secret) headers.authorization = `Bearer ${bearer.secret}`;
    prepared.push({
      channel, ready: true, detail: `${url}${bearer.secret ? " (bearer)" : " (no bearer stored)"}`, secrets: bearer.secret ? [bearer.secret] : [],
      deliver: async (items) => {
        // One POST per event even inside a batch: a webhook consumer wants
        // one structured record per event, not several folded into one text.
        for (const item of items) {
          await send(fetcher, url, {
            method: "POST", headers,
            body: JSON.stringify({ event: item.kind, meter: item.meter, principal: item.principal, at: item.at, text: item.text }),
          }, [url]);
        }
      },
    });
  }
  return prepared;
}

/* -------------------------------------------------------------------------
 * Delivery.
 * ---------------------------------------------------------------------- */

function encodeItem(item: NotifyItem): string { return JSON.stringify(item); }

function decodeItem(row: NotifyDelivery): NotifyItem {
  try {
    const parsed = JSON.parse(row.text) as Partial<NotifyItem>;
    if (parsed && typeof parsed.text === "string") {
      return { id: row.event_id, kind: String(parsed.kind ?? "event"), meter: parsed.meter ?? null, principal: parsed.principal ?? null, at: String(parsed.at ?? row.created_at), text: parsed.text };
    }
  } catch { /* A row written by an older build is still deliverable as text. */ }
  return { id: row.event_id, kind: "event", meter: null, principal: null, at: row.created_at, text: row.text };
}

function windowLabel(minutes: number | null | undefined): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : "-";
}

function eventText(event: HeadroomEvent): string {
  const subject = event.meter_id ?? event.principal_id ?? "-";
  return `${event.kind} ${subject}${event.reason ? `: ${event.reason}` : ""}`;
}

/**
 * A synthetic item per hard window already at or above the threshold. The id
 * carries the window's own reset timestamp, so the ledger's dedupe makes this
 * fire once per window instance: the next crossing only notifies after the
 * window has reset into a new one. A window whose reset is unknown notifies
 * once and then stays quiet, which is the safe direction.
 */
export function thresholdItems(store: HeadroomStore, threshold: number): NotifyItem[] {
  const items: NotifyItem[] = [];
  for (const observation of store.latestPerWindow()) {
    if (observation.freshness !== "fresh" || observation.quantity?.unit !== "percent") continue;
    if (observation.window?.enforcement !== "hard" || !observation.window.minutes) continue;
    if (observation.quantity.used < threshold) continue;
    const label = windowLabel(observation.window.minutes);
    items.push({
      id: `threshold:${observation.meter_id}:${observation.window.minutes}:${observation.resets_at ?? "unknown"}`,
      kind: "threshold", meter: observation.meter_id, principal: observation.principal_id, at: observation.fetched_at,
      text: `${observation.meter_id} ${label} at ${Math.round(observation.quantity.used)}% used (threshold ${threshold}%)`,
    });
  }
  return items;
}

function collectItems(store: HeadroomStore, config: NotifyConfig, since: string): NotifyItem[] {
  const wanted = new Set(config.events);
  const items: NotifyItem[] = store.events(since)
    .filter((event) => wanted.has(event.kind))
    .map((event) => ({ id: event.id, kind: event.kind, meter: event.meter_id, principal: event.principal_id, at: event.created_at, text: eventText(event) }));
  if (wanted.has("threshold") && config.threshold_percent !== null) items.push(...thresholdItems(store, config.threshold_percent));
  return items;
}

async function logDisabledOnce(store: HeadroomStore, log: (message: string) => Promise<void>, channel: ChannelStatus): Promise<void> {
  const key = `notify_disabled:${channel.channel}`;
  if (store.daemonState(key) === channel.detail) return;
  store.setDaemonState(key, channel.detail);
  await log(`notify ${channel.channel} disabled: ${channel.detail}`);
}

/** Sends everything queued for one channel as a single message (one POST per
 * event for a webhook), then marks the rows. A failure costs every row in the
 * batch one attempt and is logged on the first failure and on the give-up,
 * never once per poll for as long as the outage lasts. */
async function flushChannel(store: HeadroomStore, channel: PreparedChannel, log: (message: string) => Promise<void>, now: Date): Promise<number> {
  const rows = store.notifyPending(channel.channel, MAX_ATTEMPTS);
  if (!rows.length) return 0;
  const ids = rows.map((row) => row.id);
  try {
    await channel.deliver(rows.map(decodeItem));
    store.notifyDelivered(ids, now.toISOString());
    return rows.length;
  } catch (error: unknown) {
    const detail = scrubSecrets(error, channel.secrets);
    const firstFailure = rows.every((row) => row.attempts === 0);
    const exhausted = rows.filter((row) => row.attempts + 1 >= MAX_ATTEMPTS).length;
    store.notifyAttemptFailed(ids, detail, now.toISOString(), MAX_ATTEMPTS);
    if (firstFailure) await log(`notify ${channel.channel} failed for ${rows.length} event(s): ${detail}`);
    if (exhausted) await log(`notify ${channel.channel} gave up on ${exhausted} event(s) after ${MAX_ATTEMPTS} attempts: ${detail}`);
    return 0;
  }
}

export interface NotifyRun {
  configured: boolean;
  queued: number;
  sent: number;
  quiet: boolean;
  channels: ChannelStatus[];
}

/**
 * The daemon's per-poll notification pass. Events are read from the store
 * once, past a watermark the store itself keeps, and every (event, channel)
 * pair goes through the ledger, so nothing is delivered twice however often
 * this runs. The very first pass on a fresh install only sets the watermark:
 * an operator who turns notifications on does not want a week of backlog.
 */
export function deliverNotifications(store: HeadroomStore, options: NotifyOptions = {}): Promise<NotifyRun> {
  const home = options.home ?? headroomHome();
  const active = running.get(home);
  if (active) return active;
  const task = runDelivery(store, { ...options, home }).finally(() => { running.delete(home); });
  running.set(home, task);
  return task;
}

/** One pass per Headroom home at a time. Two overlapping passes would both
 * read the same pending ledger rows before either marked them sent, and the
 * batch would go out twice. */
const running = new Map<string, Promise<NotifyRun>>();

async function runDelivery(store: HeadroomStore, options: NotifyOptions): Promise<NotifyRun> {
  const now = options.now ?? new Date();
  const home = options.home ?? headroomHome();
  const config = options.config ?? await readNotifyConfig(home);
  if (!config || !config.channels.length) return { configured: false, queued: 0, sent: 0, quiet: false, channels: [] };
  const log = options.log ?? ((message: string) => appendDaemonLog(message, home));
  const channels = await prepareChannelsInternal(config, options);
  for (const channel of channels) if (!channel.ready) await logDisabledOnce(store, log, channel);
  const ready = channels.filter((channel) => channel.ready);
  const status = channels.map(({ channel, ready: isReady, detail }) => ({ channel, ready: isReady, detail }));
  if (!ready.length) return { configured: true, queued: 0, sent: 0, quiet: false, channels: status };
  const watermark = store.daemonState(WATERMARK_KEY);
  const items = watermark === undefined ? [] : collectItems(store, config, watermark);
  store.setDaemonState(WATERMARK_KEY, now.toISOString());
  for (const item of items) for (const channel of ready) store.notifyEnqueue(item.id, channel.channel, encodeItem(item), now.toISOString());
  if (inQuietHours(config, now)) return { configured: true, queued: items.length, sent: 0, quiet: true, channels: status };
  let sent = 0;
  for (const channel of ready) sent += await flushChannel(store, channel, log, now);
  return { configured: true, queued: items.length, sent, quiet: false, channels: status };
}

/* -------------------------------------------------------------------------
 * CLI.
 * ---------------------------------------------------------------------- */

export const NOTIFY_USAGE = "Usage: headroom notify (--test | --last <n>)";

/** Sends one message per configured channel and reports what happened.
 * Deliberately outside the ledger: a test message is not an event, and must
 * not be able to suppress a real delivery through the dedupe. */
export async function notifyTest(options: NotifyOptions = {}): Promise<number> {
  const home = options.home ?? headroomHome();
  const config = options.config ?? await readNotifyConfig(home);
  if (!config || !config.channels.length) { console.log(`No [notify] channels in ${join(home, "policy.toml")}. See docs/notifications.md.`); return 1; }
  const now = options.now ?? new Date();
  const channels = await prepareChannelsInternal(config, options);
  const item: NotifyItem = { id: `test:${now.toISOString()}`, kind: "test", meter: null, principal: null, at: now.toISOString(), text: "test notification" };
  let failures = 0;
  for (const channel of channels) {
    if (!channel.ready) { console.log(`${channel.channel.padEnd(8)} disabled  ${channel.detail}`); failures += 1; continue; }
    try { await channel.deliver([item]); console.log(`${channel.channel.padEnd(8)} sent      ${channel.detail}`); }
    catch (error: unknown) { console.log(`${channel.channel.padEnd(8)} failed    ${scrubSecrets(error, channel.secrets)}`); failures += 1; }
  }
  return failures === channels.length ? 1 : 0;
}

export function formatLedger(rows: NotifyDelivery[]): string[] {
  return rows.map((row) => {
    const text = decodeItem(row).text;
    const detail = row.status === "sent" || !row.detail ? "" : `  ${row.detail}`;
    return `${row.updated_at}  ${row.channel.padEnd(8)}  ${row.status.padEnd(7)}  ${row.attempts}  ${text.length > 80 ? `${text.slice(0, 77)}...` : text}${detail}`;
  });
}

export async function notifyLast(limit: number, home?: string): Promise<number> {
  const store = await HeadroomStore.open(home);
  try {
    const rows = store.notifyLedger(limit);
    store.audit("cli", "notify", null, "ok");
    if (!rows.length) { console.log("No notifications delivered yet."); return 0; }
    for (const line of formatLedger(rows)) console.log(line);
    return 0;
  } finally { store.close(); }
}

export async function notifyCommand(argv: string[]): Promise<number> {
  if (argv.includes("--test")) return notifyTest();
  const at = argv.indexOf("--last");
  if (at >= 0) {
    const limit = argv[at + 1] === undefined ? 20 : Number(argv[at + 1]);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error("--last takes a whole number of rows, 1 through 1000");
    return notifyLast(limit);
  }
  throw new Error(NOTIFY_USAGE);
}
