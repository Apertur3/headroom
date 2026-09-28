import { readFile, writeFile, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headroomHome } from "./paths.js";
import { defaultPolicy, parsePolicy, type Policy } from "./policy.js";

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
 * Creates `path` exclusively (`open(..., "wx")`, O_EXCL) and writes `text`
 * to it, returning whether this call actually created it. `EEXIST` -- the
 * file was already there, whether from an earlier seed or a concurrent
 * `accounts discover`/`policy set` racing this one -- is treated as "already
 * seeded", not an error: unlike a check-then-write (`optionalText(path) ===
 * undefined` followed by a plain `writeFile`), this can never overwrite a
 * file a concurrent writer created in the gap between the two. A failed
 * write or close after a successful create removes the partial file before
 * rethrowing, so it can never wedge every future seed attempt.
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
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  return true;
}

/**
 * Seeds ~/.headroom/policy.toml and routing.toml from examples/ the first
 * time either is absent, so `headroom can <class>` works from a fresh
 * `accounts discover` without an extra manual copy step. Never overwrites an
 * existing file -- exclusive creation (see seedFileExclusive) makes this
 * race-free against a concurrent writer, unlike an earlier check-then-write
 * version of this function. Returns one human-readable line per file
 * actually written, empty when both were already present (or examples/ is
 * unexpectedly missing, which never blocks discovery on its own).
 */
export async function seedExampleConfig(home = headroomHome()): Promise<string[]> {
  const root = packageRoot();
  const messages: string[] = [];
  const policySource = await optionalText(join(root, "examples", "policy.toml"));
  if (policySource !== undefined) {
    const policyTarget = join(home, "policy.toml");
    if (await seedFileExclusive(policyTarget, policySource)) messages.push(`Seeded ${policyTarget} from examples/policy.toml.`);
  }
  const routingSource = await optionalText(join(root, "examples", "routing.toml"));
  if (routingSource !== undefined) {
    const routingTarget = join(home, "routing.toml");
    if (await seedFileExclusive(routingTarget, routingSource)) {
      const classes = Object.keys(parseRouting(routingSource).consumes);
      messages.push(`Seeded ${routingTarget} from examples/routing.toml (action classes: ${classes.join(", ")}). Edit to match your accounts.`);
    }
  }
  return messages;
}
