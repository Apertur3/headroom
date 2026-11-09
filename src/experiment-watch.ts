import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigJsonPath } from "./doctor.js";
import type { NotifyItem } from "./notify.js";
import type { HeadroomStore } from "./store.js";

const HOUR = 3_600_000;
type Seen = Record<string, { id: string; since: string }>;

/** The first three hex characters of a server-side test ID ("v1.87b0…" or
 * "87b0…"): enough to tell tests apart, never the full value. */
const short = (value: unknown): string | undefined => typeof value === "string" ? /^(?:v\d+\.)?([0-9a-f]{3})/i.exec(value)?.[1]?.toLowerCase() : undefined;
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const json = (path: string): unknown => { try { return parse(readFileSync(path, "utf8")); } catch { return undefined; } };

/** Every Claude Code profile (~/.claude, ~/.claude2, ...) mapped to the test it
 * is in now: per model and entrypoint from `clientDataCacheSlots`, and the
 * newest `atis-latch` line in transcripts written since `since`. Reads only
 * those fields: the same files hold account data and tokens. */
export function readExperiments(home: string, since: number): Map<string, { id: string; at?: number }> {
  const found = new Map<string, { id: string; at?: number }>();
  let dirs: string[] = [];
  try { dirs = readdirSync(home).filter((name) => /^\.claude\d*$/.test(name) && statSync(join(home, name)).isDirectory()); } catch { return found; }
  for (const dir of dirs) {
    const profile = dir.slice(1);
    const slots = (json(claudeConfigJsonPath(join(home, dir), home)) as { clientDataCacheSlots?: Record<string, { model?: string; entrypoint?: string; at?: number; data?: { atis?: unknown; experimentKey?: unknown } }> } | undefined)?.clientDataCacheSlots ?? {};
    for (const slot of Object.values(slots)) {
      const id = short(slot?.data?.atis) ?? short(slot?.data?.experimentKey) ?? "";
      if (slot?.model) found.set(`${slot.model} (${slot.entrypoint ?? "?"}, ${profile})`, { id, at: slot.at });
    }
    let newest: { id: string; at: number } | undefined;
    for (const project of safeList(join(home, dir, "projects"))) for (const file of safeList(join(home, dir, "projects", project))) {
      const path = join(home, dir, "projects", project, file);
      const at = file.endsWith(".jsonl") ? statSync(path).mtimeMs : 0;
      if (at < since || (newest && at < newest.at)) continue;
      const latch = readFileSync(path, "utf8").split("\n").filter((line) => line.includes('"type":"atis-latch"')).pop();
      if (latch) newest = { id: short((parse(latch) as { atis?: unknown } | undefined)?.atis) ?? "", at };
    }
    if (newest) found.set(`Claude Code (${profile})`, newest);
  }
  return found;
}
function safeList(path: string): string[] { try { return readdirSync(path); } catch { return []; } }

/** "claude-opus-5-5 (cli, claude) in test 87b": the agent line names an active test next to the burn rates. */
export function experimentMarks(store: HeadroomStore): string[] {
  try { return Object.entries((JSON.parse(store.daemonState("experiment_watch") ?? "{}") as { seen?: Seen }).seen ?? {}).map(([key, { id }]) => `${key} in test ${id}`); } catch { return []; }
}

/** Hourly: one alert when a model or profile enters a test, one when it leaves. */
export function experimentItems(store: HeadroomStore, now: Date, home = homedir()): NotifyItem[] {
  const state = (() => { try { return JSON.parse(store.daemonState("experiment_watch") ?? "{}") as { checked?: number; seen?: Seen }; } catch { return {}; } })();
  if (state.checked && now.getTime() - state.checked < HOUR) return [];
  const seen: Seen = { ...state.seen }; const items: NotifyItem[] = [];
  const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const push = (key: string, text: string) => items.push({ id: `experiment:${key}:${now.toISOString()}`, kind: "experiment", meter: null, principal: null, at: now.toISOString(), delivery_identity: `experiment:${key}:${now.toISOString()}`, text });
  for (const [key, { id, at }] of readExperiments(home, state.checked ?? now.getTime() - HOUR)) {
    if (id && seen[key]?.id !== id) { seen[key] = { id, since: new Date(at ?? now.getTime()).toISOString() }; push(key, `🧪 ${key} is in test ${id} since ${clock(at ?? now.getTime())}`); }
    else if (!id && seen[key]) { push(key, `🧪 ${key} left test ${seen[key].id}`); delete seen[key]; }
  }
  store.setDaemonState("experiment_watch", JSON.stringify({ checked: now.getTime(), seen }));
  return items;
}
