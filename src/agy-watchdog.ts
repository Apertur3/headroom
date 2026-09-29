import { launchEvidenceLocations, readKeepaliveState, waitUntilGroupGone } from "./antigravity-keepalive.js";
import { liveEngineGroupPids, terminateGroup } from "./engine/group-run.js";
import { sendInboxMessage } from "./inbox.js";
import { appendDaemonLog } from "./logs.js";
import { isProcessGroupAlive, killTree, processElapsedSeconds, processSignature, type ExecFile } from "./process-tree.js";

/**
 * Age watchdog for agy processes Headroom started. Run on every poll pass.
 *
 * A process counts as Headroom-started only by recorded evidence, never by
 * name: (1) a pid recorded in a keepalive launch directory (state.json, with
 * the command and start time `ps` reported at record time, which the live
 * process must still match, so a recycled pid or the user's own IDE and agy
 * are never touched), and (2) the leader of a live engine process group
 * (spawned by group-run.ts, which tracks it). One launch is exempt: the
 * daemon's own current keepalive, identified by its launch id.
 */

export const AGY_WATCHDOG_INBOX_SESSION = "headroom-watchdog";

export interface OverAgeProcess { pid: number; ageSeconds: number; command: string; source: "keepalive-launch" | "engine-group" }

export interface WatchdogOptions {
  home: string;
  maxAgeMs: number;
  /** Launch id of the daemon-owned keepalive, exempt from the watchdog. */
  exemptLaunchId?: string;
  execImpl?: ExecFile;
  /** Test seams. */
  kill?: (pid: number) => Promise<void>;
  engineGroupPids?: () => number[];
  log?: (message: string) => Promise<void>;
  send?: typeof sendInboxMessage;
}

/** Signature-verified, over-age processes recorded in non-exempt launch directories. */
export async function findOverAgeLaunchProcesses(options: Pick<WatchdogOptions, "home" | "maxAgeMs" | "exemptLaunchId" | "execImpl">): Promise<OverAgeProcess[]> {
  if (process.platform === "win32") return [];
  let locations;
  try { locations = await launchEvidenceLocations(options.home, options.exemptLaunchId); }
  catch { return []; } // invalid evidence is the sweep's fail-closed business, not a licence to guess here
  const found = new Map<number, OverAgeProcess>();
  for (const location of locations) {
    let state;
    try { state = await readKeepaliveState(location.statePath); } catch { continue; }
    if (!state) continue;
    const recorded: Array<{ pid: number; command?: string; startedAt?: string }> = [
      { pid: state.scriptPid, command: state.scriptCommand || undefined, startedAt: state.scriptStartedAt || undefined },
    ];
    if (state.agyPid !== undefined) recorded.push({ pid: state.agyPid, command: state.agyCommand, startedAt: state.agyStartedAt });
    for (const item of recorded.reverse()) { // agy first, so the report names agy rather than its script wrapper
      if (!item.command || !item.startedAt) continue; // unverified evidence is never enough to kill on
      const live = await processSignature(item.pid, options.execImpl);
      if (!live || live.command !== item.command || live.startedAt !== item.startedAt) continue;
      const age = await processElapsedSeconds(item.pid, options.execImpl);
      if (age === undefined || age * 1000 < options.maxAgeMs) continue;
      found.set(item.pid, { pid: item.pid, ageSeconds: age, command: live.command, source: "keepalive-launch" });
    }
  }
  return [...found.values()];
}

/** Every pid any keepalive launch directory (including the live one) has
 * recorded. Used only to keep Headroom's own processes from being mistaken for
 * someone else's server; never to decide a kill. */
export async function recordedLaunchPids(home: string): Promise<number[]> {
  if (process.platform === "win32") return [];
  const pids: number[] = [];
  try {
    for (const location of await launchEvidenceLocations(home)) {
      const state = await readKeepaliveState(location.statePath).catch(() => undefined);
      if (state) pids.push(state.scriptPid, ...(state.agyPid !== undefined ? [state.agyPid] : []));
    }
  } catch { /* invalid evidence: nothing recorded that can be trusted */ }
  return pids;
}

async function findOverAgeEngineGroups(options: WatchdogOptions): Promise<OverAgeProcess[]> {
  const found: OverAgeProcess[] = [];
  for (const pid of (options.engineGroupPids ?? liveEngineGroupPids)()) {
    const age = await processElapsedSeconds(pid, options.execImpl);
    if (age === undefined || age * 1000 < options.maxAgeMs) continue;
    const live = await processSignature(pid, options.execImpl);
    found.push({ pid, ageSeconds: age, command: live?.command ?? "unknown", source: "engine-group" });
  }
  return found;
}

function ageText(seconds: number): string {
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** Kills each over-age Headroom-started process by group and reports it to the
 * daemon log and the inbox. The report names the pid, age and binary path only
 * (`ps` comm), never arguments. Returns what it killed. */
export async function runAgyWatchdog(options: WatchdogOptions): Promise<OverAgeProcess[]> {
  const log = options.log ?? ((message: string) => appendDaemonLog(message, options.home));
  const send = options.send ?? sendInboxMessage;
  const candidates = [...await findOverAgeLaunchProcesses(options), ...await findOverAgeEngineGroups(options)];
  const killed: OverAgeProcess[] = [];
  for (const item of candidates) {
    // A sibling kill (script's tree includes agy) may already have taken it.
    if (!isProcessGroupAlive(item.pid)) continue;
    try {
      if (options.kill) await options.kill(item.pid);
      else if (item.source === "engine-group") await terminateGroup(item.pid);
      else { await killTree(item.pid); await waitUntilGroupGone(item.pid); }
    } catch (error) { await log(`agy watchdog: could not kill pid ${item.pid}: ${(error as Error).message}`).catch(() => undefined); continue; }
    killed.push(item);
    const text = `agy watchdog killed pid ${item.pid} (${item.source}, age ${ageText(item.ageSeconds)}, ${item.command}); Headroom-started agy must not outlive ${Math.round(options.maxAgeMs / 60_000)}m`;
    await log(text).catch(() => undefined);
    await send({ to: AGY_WATCHDOG_INBOX_SESSION, kind: "note", text, from: null, home: options.home }).catch(() => undefined);
  }
  return killed;
}
