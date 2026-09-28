import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { headroomHome } from "./paths.js";
import { isOrphanedAgentProcess, listProcesses, type ExecFile, type ProcessEntry } from "./process-tree.js";

const execFileAsync: ExecFile = promisify(execFile);

/**
 * One read of host pressure -- cheap, and never throwing: every probe that
 * fails (a missing binary, a denied sandbox call, an unsupported platform, a
 * timeout) reports its own measurement as `null` ("unknown"), and `state`
 * itself is never worse than "unknown" when every measurement is null. See
 * `classifyHostHealth` for the threshold logic and docs/concepts.md for what
 * each field means and why it exists (the 2026-09-27 PTY-leak incident:
 * .claude/INCIDENT-2026-09-27-pty-leak.md).
 */
export interface HostHealth {
  state: "ok" | "warn" | "refuse" | "unknown";
  /** One entry per threshold this reading crossed, each naming the
   * measurement and the `host_guard.*` policy key responsible -- empty for
   * "ok", and for "unknown" a single explanatory entry. */
  reasons: string[];
  /** `os.loadavg()[0] / os.cpus().length`. `null` on win32, where
   * `os.loadavg()` always reports zeros rather than a real reading. */
  load_ratio: number | null;
  /** In-use pseudo-terminals (POSIX only). `null` where the platform-specific
   * probe below is not defined (win32) or itself failed. */
  pty_used: number | null;
  /** The platform's configured pseudo-terminal ceiling (POSIX only). */
  pty_max: number | null;
  /** Count of processes with ppid 1 whose command is the leaked `agy`/`script`
   * shape (see `isOrphanedAgentProcess`). `null` on win32 (no PTY tree there
   * to walk); otherwise always a number -- `listProcesses()` itself never
   * throws, so this is 0 rather than unknown when `ps` cannot be read. */
  orphans: number | null;
}

/** Everything `run` (and only `run`) reads from `[host_guard]` in
 * policy.toml. Every other surface (`can`, `gate`, `doctor`) reports the same
 * measured `HostHealth` regardless of `mode` -- `mode` decides what a LOCAL
 * dispatch does about it, not what is true about the host. */
export interface HostGuardPolicy {
  mode: "off" | "warn" | "refuse";
  warn_load_ratio: number;
  refuse_load_ratio: number;
  warn_pty_percent: number;
  refuse_pty_percent: number;
}

export const defaultHostGuardPolicy: HostGuardPolicy = {
  mode: "refuse",
  warn_load_ratio: 2,
  refuse_load_ratio: 3,
  warn_pty_percent: 50,
  refuse_pty_percent: 75,
};

function invalid(detail: string): Error { return new Error(`Invalid Headroom policy: ${detail}`); }

/**
 * Reads only the `[host_guard]` table out of policy.toml's text, the same
 * deliberately small hand-rolled TOML surface every other section of this
 * file uses (see notify.ts's parseNotifyConfig for the identical pattern:
 * an independent single-pass scan over the same text, caring about one
 * section). Absent keys keep `defaultHostGuardPolicy`'s value.
 */
export function parseHostGuardPolicy(text: string): HostGuardPolicy {
  let section = "";
  let mode: HostGuardPolicy["mode"] | undefined;
  let warnLoad: number | undefined;
  let refuseLoad: number | undefined;
  let warnPty: number | undefined;
  let refusePty: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    if (section !== "host_guard") continue;
    const modeMatch = /^mode\s*=\s*"(off|warn|refuse)"\s*$/.exec(line);
    if (modeMatch) { mode = modeMatch[1] as HostGuardPolicy["mode"]; continue; }
    const numberMatch = /^(warn_load_ratio|refuse_load_ratio|warn_pty_percent|refuse_pty_percent)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (numberMatch) {
      const value = Number(numberMatch[2]);
      if (numberMatch[1] === "warn_load_ratio") warnLoad = value;
      else if (numberMatch[1] === "refuse_load_ratio") refuseLoad = value;
      else if (numberMatch[1] === "warn_pty_percent") warnPty = value;
      else refusePty = value;
      continue;
    }
    throw invalid(`unknown [host_guard] key "${line}"`);
  }
  const result: HostGuardPolicy = {
    mode: mode ?? defaultHostGuardPolicy.mode,
    warn_load_ratio: warnLoad ?? defaultHostGuardPolicy.warn_load_ratio,
    refuse_load_ratio: refuseLoad ?? defaultHostGuardPolicy.refuse_load_ratio,
    warn_pty_percent: warnPty ?? defaultHostGuardPolicy.warn_pty_percent,
    refuse_pty_percent: refusePty ?? defaultHostGuardPolicy.refuse_pty_percent,
  };
  if (!Number.isFinite(result.warn_load_ratio) || result.warn_load_ratio <= 0) throw invalid("host_guard.warn_load_ratio must be a positive number");
  if (!Number.isFinite(result.refuse_load_ratio) || result.refuse_load_ratio <= result.warn_load_ratio) throw invalid("host_guard.refuse_load_ratio must be greater than warn_load_ratio");
  if (!Number.isFinite(result.warn_pty_percent) || result.warn_pty_percent <= 0 || result.warn_pty_percent > 100) throw invalid("host_guard.warn_pty_percent must be above 0 and at most 100");
  if (!Number.isFinite(result.refuse_pty_percent) || result.refuse_pty_percent <= result.warn_pty_percent || result.refuse_pty_percent > 100) throw invalid("host_guard.refuse_pty_percent must be greater than warn_pty_percent and at most 100");
  return result;
}

export async function readHostGuardPolicy(home = headroomHome()): Promise<HostGuardPolicy> {
  let text: string;
  try { text = await readFile(join(home, "policy.toml"), "utf8"); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultHostGuardPolicy; throw error; }
  return parseHostGuardPolicy(text);
}

export type HostMeasurements = Omit<HostHealth, "state" | "reasons">;

/**
 * The threshold logic alone, over already-read measurements -- exercised
 * directly by tests for every threshold without needing to fake `os.loadavg`
 * or shell out at all. `null` never contributes to a warn/refuse verdict;
 * `state` is "unknown" only when every measurement is null (nothing at all
 * could be read), matching "every probe failure is unknown, and unknown
 * never refuses."
 */
export function classifyHostHealth(measurements: HostMeasurements, policy: HostGuardPolicy = defaultHostGuardPolicy): { state: HostHealth["state"]; reasons: string[] } {
  const { load_ratio, pty_used, pty_max, orphans } = measurements;
  const reasons: string[] = [];
  let refuse = false;
  let warn = false;
  if (load_ratio !== null) {
    if (load_ratio > policy.refuse_load_ratio) { refuse = true; reasons.push(`load_ratio ${load_ratio.toFixed(2)} exceeds host_guard.refuse_load_ratio (${policy.refuse_load_ratio})`); }
    else if (load_ratio > policy.warn_load_ratio) { warn = true; reasons.push(`load_ratio ${load_ratio.toFixed(2)} exceeds host_guard.warn_load_ratio (${policy.warn_load_ratio})`); }
  }
  if (pty_used !== null && pty_max !== null && pty_max > 0) {
    const percent = (pty_used / pty_max) * 100;
    if (percent > policy.refuse_pty_percent) { refuse = true; reasons.push(`pty use ${percent.toFixed(0)}% (${pty_used}/${pty_max}) exceeds host_guard.refuse_pty_percent (${policy.refuse_pty_percent}%)`); }
    else if (percent > policy.warn_pty_percent) { warn = true; reasons.push(`pty use ${percent.toFixed(0)}% (${pty_used}/${pty_max}) exceeds host_guard.warn_pty_percent (${policy.warn_pty_percent}%)`); }
  }
  // Orphans alone warn, never refuse: a user's own stray agy is not proof
  // the host is dying (see the spec's own rationale for this asymmetry).
  if (orphans !== null && orphans > 0) { warn = true; reasons.push(`${orphans} orphaned agy/script process(es) found (orphans alone never refuse)`); }
  if (refuse) return { state: "refuse", reasons };
  if (warn) return { state: "warn", reasons };
  if (load_ratio === null && pty_used === null && orphans === null) return { state: "unknown", reasons: ["no host pressure measurements available on this platform"] };
  return { state: "ok", reasons: [] };
}

/** `os.loadavg()[0] / os.cpus().length`; `null` on win32, where
 * `os.loadavg()` always reports zeros rather than a real reading, and `null`
 * for any non-finite input rather than propagating a `NaN`/`Infinity`. */
function loadRatio(loadavg: () => number[], cpuCount: () => number, platform: NodeJS.Platform): number | null {
  try {
    if (platform === "win32") return null;
    const load1 = loadavg()[0];
    const cpus = cpuCount();
    if (!Number.isFinite(load1) || !Number.isFinite(cpus) || cpus <= 0) return null;
    return load1 / cpus;
  } catch { return null; }
}

async function ptyUsage(platform: NodeJS.Platform, exec: ExecFile, readdirImpl: typeof readdir, readFileImpl: typeof readFile): Promise<{ used: number | null; max: number | null }> {
  try {
    if (platform === "darwin") {
      const max = await exec("sysctl", ["-n", "kern.tty.ptmx_max"], { timeout: 1000 })
        .then(({ stdout }) => { const value = Number(stdout.trim()); return Number.isFinite(value) && value > 0 ? value : null; })
        .catch(() => null);
      const used = await readdirImpl("/dev")
        .then((entries) => entries.filter((name) => /^ttys\d+$/.test(name)).length)
        .catch(() => null);
      return { used, max };
    }
    if (platform === "linux") {
      const readNumber = async (path: string): Promise<number | null> => {
        try { const value = Number((await readFileImpl(path, "utf8")).trim()); return Number.isFinite(value) ? value : null; }
        catch { return null; }
      };
      const [max, used] = await Promise.all([readNumber("/proc/sys/kernel/pty/max"), readNumber("/proc/sys/kernel/pty/nr")]);
      return { used, max };
    }
    return { used: null, max: null };
  } catch { return { used: null, max: null }; }
}

async function orphanCount(platform: NodeJS.Platform, list: (execImpl?: ExecFile) => Promise<ProcessEntry[]>, execImpl: ExecFile | undefined): Promise<number | null> {
  if (platform === "win32") return null; // no script/agy PTY tree there (see isOrphanedAgentProcess)
  try { return (await list(execImpl)).filter(isOrphanedAgentProcess).length; }
  catch { return null; }
}

/** Injectable probes, for tests only -- every real call site uses the
 * defaults (the real `os`, a real `sysctl`/`ps`, real `/proc` and `/dev`
 * reads). Never real load or a real PTY: every test fakes these. */
export interface HostHealthDeps {
  loadavg?: () => number[];
  cpuCount?: () => number;
  platform?: NodeJS.Platform;
  execImpl?: ExecFile;
  readdirImpl?: typeof readdir;
  readFileImpl?: typeof readFile;
  listProcessesImpl?: (execImpl?: ExecFile) => Promise<ProcessEntry[]>;
}

/** The one entry point: reads every probe (each individually fail-closed to
 * `null`/"unknown", never throwing and never blocking on a hung subprocess --
 * every subprocess probe carries its own short timeout), then classifies the
 * result against `policy`. */
export async function checkHostHealth(policy: HostGuardPolicy = defaultHostGuardPolicy, deps: HostHealthDeps = {}): Promise<HostHealth> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.execImpl ?? execFileAsync;
  const readdirImpl = deps.readdirImpl ?? readdir;
  const readFileImpl = deps.readFileImpl ?? readFile;
  const list = deps.listProcessesImpl ?? listProcesses;
  let load_ratio: number | null;
  let pty_used: number | null;
  let pty_max: number | null;
  let orphans: number | null;
  try { load_ratio = loadRatio(deps.loadavg ?? os.loadavg, deps.cpuCount ?? (() => os.cpus().length), platform); }
  catch { load_ratio = null; }
  try { ({ used: pty_used, max: pty_max } = await ptyUsage(platform, exec, readdirImpl, readFileImpl)); }
  catch { pty_used = null; pty_max = null; }
  try { orphans = await orphanCount(platform, list, deps.execImpl); }
  catch { orphans = null; }
  const measurements: HostMeasurements = { load_ratio, pty_used, pty_max, orphans };
  const { state, reasons } = classifyHostHealth(measurements, policy);
  return { state, reasons, ...measurements };
}

/**
 * `run`'s refusal reason, or `undefined` when it must not refuse: only ever
 * populated for `state: "refuse"` AND `mode: "refuse"` -- every other
 * combination (a lower state, or a mode that downgrades refusal to a
 * warning) launches. Names the measurement and the policy key, and points at
 * `headroom doctor` for the full reading, as the spec requires.
 */
export function hostGuardRefusal(health: HostHealth, mode: HostGuardPolicy["mode"]): string | undefined {
  if (mode !== "refuse" || health.state !== "refuse") return undefined;
  return `refused: host under pressure (${health.reasons.join("; ") || "see headroom doctor"}); set host_guard.mode = "warn" or "off" in policy.toml to change this`;
}

/**
 * `run`'s stderr warning, or `undefined` when nothing should be printed:
 * `mode: "off"` disables the guard outright (no message at all), and a
 * `state: "refuse"` reading under `mode: "warn"` is still surfaced as a
 * warning even though `run` proceeds -- an operator watching stderr should
 * still learn the host was actually over its refuse threshold.
 */
export function hostGuardWarning(health: HostHealth, mode: HostGuardPolicy["mode"]): string | undefined {
  if (mode === "off") return undefined;
  if (health.state === "warn" || (health.state === "refuse" && mode !== "refuse")) {
    return `host guard warning: ${health.reasons.join("; ") || "host pressure elevated"} (headroom doctor for the full reading)`;
  }
  return undefined;
}
