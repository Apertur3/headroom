import { launchEvidenceLocations, readKeepaliveState } from "./antigravity-keepalive.js";
import { liveEngineGroups, terminateEngineGroup } from "./engine/group-run.js";
import { sendInboxMessage } from "./inbox.js";
import { appendDaemonLog } from "./logs.js";
import { killVerifiedTree, processElapsedSeconds, processSignature, type ExecFile, type VerifiedKillResult } from "./process-tree.js";

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
 *
 * Finding a candidate and killing it are separated by awaits (other
 * candidates' `ps` reads, earlier kills), during which a verified process can
 * exit and its pid be recycled. So the finding never licenses a signal on its
 * own: every signal re-verifies identity immediately before it is sent
 * (killVerifiedTree for launches, group-run's own verified path for engine
 * groups).
 */

export const AGY_WATCHDOG_INBOX_SESSION = "headroom-watchdog";

export interface OverAgeProcess {
  pid: number;
  ageSeconds: number;
  command: string;
  source: "keepalive-launch" | "engine-group";
  /** The recorded `ps` start time (keepalive launches), re-checked before every signal. */
  startedAt?: string;
}

export interface WatchdogOptions {
  home: string;
  maxAgeMs: number;
  /** Launch id of the daemon-owned keepalive, exempt from the watchdog. */
  exemptLaunchId?: string;
  execImpl?: ExecFile;
  /** Test seams. */
  kill?: (item: OverAgeProcess) => Promise<VerifiedKillResult>;
  engineGroups?: () => Array<{ pid: number; ageMs: number; command?: string }>;
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
      found.set(item.pid, { pid: item.pid, ageSeconds: age, command: item.command, startedAt: item.startedAt, source: "keepalive-launch" });
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

/** Engine groups are aged by group-run's own spawn clock, not by a `ps`
 * lookup of a pid that could have changed hands. */
function findOverAgeEngineGroups(options: WatchdogOptions): OverAgeProcess[] {
  return (options.engineGroups ?? liveEngineGroups)()
    .filter((group) => group.ageMs >= options.maxAgeMs)
    .map((group) => ({ pid: group.pid, ageSeconds: Math.floor(group.ageMs / 1000), command: group.command ?? "unknown", source: "engine-group" as const }));
}

async function killCandidate(item: OverAgeProcess, options: WatchdogOptions): Promise<VerifiedKillResult> {
  if (options.kill) return options.kill(item);
  if (item.source === "engine-group") return (await terminateEngineGroup(item.pid)) ? "killed" : "not-ours";
  if (!item.startedAt) return "not-ours";
  return killVerifiedTree({ pid: item.pid, command: item.command, startedAt: item.startedAt }, { execImpl: options.execImpl });
}

function ageText(seconds: number): string {
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** Kills each over-age Headroom-started process by group and reports it to the
 * daemon log and the inbox. The report names the pid, age and recorded command
 * only (`comm`: the binary path on macOS, the process name on Linux), never
 * arguments. Returns what it killed. */
export async function runAgyWatchdog(options: WatchdogOptions): Promise<OverAgeProcess[]> {
  const log = options.log ?? ((message: string) => appendDaemonLog(message, options.home));
  const send = options.send ?? sendInboxMessage;
  const candidates = [...await findOverAgeLaunchProcesses(options), ...findOverAgeEngineGroups(options)];
  const killed: OverAgeProcess[] = [];
  for (const item of candidates) {
    let outcome: VerifiedKillResult;
    try { outcome = await killCandidate(item, options); }
    catch (error) { await log(`agy watchdog: could not kill pid ${item.pid}: ${(error as Error).message}`).catch(() => undefined); continue; }
    // Gone already (a sibling kill took it: script's tree includes agy), or
    // the pid is no longer the recorded process: nothing was signalled.
    if (outcome === "not-ours") continue;
    if (outcome === "survived") { await log(`agy watchdog: pid ${item.pid} (${item.source}) still alive after SIGKILL`).catch(() => undefined); continue; }
    killed.push(item);
    const text = `agy watchdog killed pid ${item.pid} (${item.source}, age ${ageText(item.ageSeconds)}, ${item.command}); Headroom-started agy must not outlive ${Math.round(options.maxAgeMs / 60_000)}m`;
    await log(text).catch(() => undefined);
    await send({ to: AGY_WATCHDOG_INBOX_SESSION, kind: "note", text, from: null, home: options.home }).catch(() => undefined);
  }
  return killed;
}
