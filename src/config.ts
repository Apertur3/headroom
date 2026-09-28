import { readFile, writeFile, mkdir, lstat, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headroomHome } from "./paths.js";
import { defaultPolicy, parsePolicy, type Policy } from "./policy.js";
import { withPolicyLock } from "./security.js";

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** policy.toml's own mtime, ISO -- null when it does not exist. Read
 * alongside the file's text so a reserve refusal that names no reason/set_at
 * of its own can still say when the file itself last changed (see
 * policy.ts's reserveAttributionSuffix). */
async function optionalMtime(path: string): Promise<string | null> {
  try { return (await stat(path)).mtime.toISOString(); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readPolicy(): Promise<Policy> {
  const path = join(headroomHome(), "policy.toml");
  const [text, mtime] = await Promise.all([optionalText(path), optionalMtime(path)]);
  if (text === undefined) return defaultPolicy;
  const now = new Date();
  return { ...parsePolicy(text, now), policy_mtime: mtime };
}

export type LocalPreference = "fallback" | "prefer" | "never";
export interface RoutingCost { percent: number; duration_minutes: number; }
export interface Routing {
  consumes: Record<string, string[]>;
  local_preference: LocalPreference;
  /** From [cost.<class>] sections: fill's per-class "how many fit" list. A
   * learned median (when samples exist) always overrides this static number
   * at the point of use; this is only the config-declared fallback. */
  costs: Record<string, RoutingCost>;
  /** Absent only when parseRouting() built this literal directly; readRouting() always sets it. */
  present?: boolean;
}

/** Parse Headroom's deliberately small routing surface without accepting arbitrary
 * TOML features into a security-sensitive local config. */
export function parseRouting(text: string): Routing {
  const consumes: Record<string, string[]> = {};
  const costs: Record<string, RoutingCost> = {};
  let localPreference: LocalPreference = "fallback";
  let section: "none" | "consumes" | "cost" = "none";
  let costClass: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const preference = /^local_preference\s*=\s*"(fallback|prefer|never)"\s*$/.exec(line);
    if (preference) { localPreference = preference[1] as LocalPreference; continue; }
    if (/^\[consumes\]$/.test(line)) { section = "consumes"; continue; }
    const cost = /^\[cost\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (cost) { section = "cost"; costClass = cost[1]; costs[costClass] ??= { percent: 0, duration_minutes: 0 }; continue; }
    if (/^\[.*\]$/.test(line)) { section = "none"; costClass = undefined; continue; }
    if (section === "cost" && costClass) {
      const percent = /^percent\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
      if (percent) { costs[costClass].percent = Number(percent[1]); continue; }
      const duration = /^duration_minutes\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
      if (duration) { costs[costClass].duration_minutes = Number(duration[1]); continue; }
      continue;
    }
    if (section !== "consumes") continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*\[(.*)\]$/.exec(line);
    if (!match) throw new Error(`Invalid consumes entry: ${line}`);
    const meters = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => JSON.parse(`"${item[1]}"`) as string);
    if (!meters.length) throw new Error(`Consumes entry ${match[1]} has no meters`);
    consumes[match[1]] = meters;
  }
  return { consumes, local_preference: localPreference, costs };
}

export function parseConsumes(text: string): Record<string, string[]> { return parseRouting(text).consumes; }

export async function readConsumes(): Promise<Record<string, string[]>> {
  return (await readRouting()).consumes;
}

export async function readRouting(): Promise<Routing> {
  const path = process.env.HEADROOM_ROUTING ?? join(headroomHome(), "routing.toml");
  const text = await optionalText(path);
  return text === undefined ? { consumes: {}, local_preference: "fallback", costs: {}, present: false } : { ...parseRouting(text), present: true };
}

/** Resolves to the package root both from a repo checkout (src/config.ts, one
 * level down) and from the compiled npm package (dist/config.js, also one
 * level down): examples/ ships in both, per package.json's `files`. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Best-effort cleanup for a file `seedFileExclusive` itself just created
 * via `open(..., "wx")`, after a later write or close on it failed. Proves
 * ownership before deleting anything: `handle`'s own fstat (taken while its
 * fd is still open, so it reflects the exact inode this call created,
 * regardless of whether the write/close that follows succeeds) is compared
 * against an `lstat` of `path` right before the unlink. Only a match is
 * removed -- if they differ, some other writer has since replaced `path`
 * (e.g. a concurrent `headroom policy set`'s `writeFileAtomic`, whose
 * `rename()` does not care what previously sat at the destination), and
 * deleting it would silently destroy that writer's already-committed edit
 * instead of the failed, empty-or-partial file this call actually owns.
 * Every step here is swallowed: a cleanup failure must never mask the
 * original write/close error this is already being called to handle.
 */
async function cleanupOwnFailedSeed(handle: FileHandle, path: string): Promise<void> {
  let ownInfo: Awaited<ReturnType<FileHandle["stat"]>> | undefined;
  try { ownInfo = await handle.stat(); } catch { /* fd already unusable: nothing to prove ownership with -- leave the file rather than risk deleting someone else's */ }
  await handle.close().catch(() => {});
  if (!ownInfo) return;
  try {
    const currentInfo = await lstat(path);
    if (currentInfo.dev === ownInfo.dev && currentInfo.ino === ownInfo.ino) await unlink(path);
  } catch { /* ENOENT (already gone) or any other lstat/unlink failure: nothing more to do */ }
}

/**
 * Creates `path` exclusively (`open(..., "wx")`, O_EXCL) and writes `text`
 * to it, returning whether this call actually created it. `EEXIST` -- the
 * file was already there, whether from an earlier seed or a concurrent
 * `accounts discover`/`policy set` racing this one -- is treated as "already
 * seeded", not an error: unlike a check-then-write (`optionalText(path) ===
 * undefined` followed by a plain `writeFile`), this can never overwrite a
 * file a concurrent writer created in the gap between the two. A failed
 * write or close after a successful create cleans up (see
 * cleanupOwnFailedSeed) rather than leaving a partial file behind to wedge
 * every future seed attempt -- callers additionally hold the shared policy
 * lock for `policy.toml` (see seedExampleConfig) so a concurrent
 * `headroom policy` writer's own write can never even attempt to land in
 * this same window.
 */
async function seedFileExclusive(path: string, text: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(text, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    await cleanupOwnFailedSeed(handle, path);
    throw error;
  }
}

/**
 * Seeds ~/.headroom/policy.toml and routing.toml from examples/ the first
 * time either is absent, so `headroom can <class>` works from a fresh
 * `accounts discover` without an extra manual copy step. Never overwrites an
 * existing file -- exclusive creation (see seedFileExclusive) makes this
 * race-free against a concurrent writer, unlike an earlier check-then-write
 * version of this function. Runs under the same shared policy lock every
 * other `policy.toml` writer (headroom policy set/clear, notify configure)
 * takes, held from the exclusive create through any cleanup: without it, a
 * concurrent `policy set` could rename its own completed policy.toml over
 * this call's exclusively-created (but not yet written) one, and a
 * subsequent write/close failure here would then delete that writer's
 * already-committed reserve instead of this call's own empty file.
 * Returns one human-readable line per file actually written, empty when
 * both were already present (or examples/ is unexpectedly missing, which
 * never blocks discovery on its own).
 */
export async function seedExampleConfig(home = headroomHome()): Promise<string[]> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const root = packageRoot();
  const policySource = await optionalText(join(root, "examples", "policy.toml"));
  const routingSource = await optionalText(join(root, "examples", "routing.toml"));
  return withPolicyLock(home, async () => {
    const messages: string[] = [];
    if (policySource !== undefined) {
      const policyTarget = join(home, "policy.toml");
      if (await seedFileExclusive(policyTarget, policySource)) messages.push(`Seeded ${policyTarget} from examples/policy.toml.`);
    }
    if (routingSource !== undefined) {
      const routingTarget = join(home, "routing.toml");
      if (await seedFileExclusive(routingTarget, routingSource)) {
        const classes = Object.keys(parseRouting(routingSource).consumes);
        messages.push(`Seeded ${routingTarget} from examples/routing.toml (action classes: ${classes.join(", ")}). Edit to match your accounts.`);
      }
    }
    return messages;
  });
}
