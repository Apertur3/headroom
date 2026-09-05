import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headroomHome } from "./paths.js";
import { defaultPolicy, parsePolicy, type Policy } from "./policy.js";

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function readPolicy(): Promise<Policy> {
  const text = await optionalText(join(headroomHome(), "policy.toml"));
  return text === undefined ? defaultPolicy : parsePolicy(text);
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

async function writeSeededFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode is umask-masked; make the intent explicit
}

/**
 * Seeds ~/.headroom/policy.toml and routing.toml from examples/ the first
 * time either is absent, so `headroom can <class>` works from a fresh
 * `accounts discover` without an extra manual copy step. Never overwrites an
 * existing file. Returns one human-readable line per file actually written,
 * empty when both were already present (or examples/ is unexpectedly
 * missing, which never blocks discovery on its own).
 */
export async function seedExampleConfig(home = headroomHome()): Promise<string[]> {
  const root = packageRoot();
  const messages: string[] = [];
  const policyTarget = join(home, "policy.toml");
  if ((await optionalText(policyTarget)) === undefined) {
    const source = await optionalText(join(root, "examples", "policy.toml"));
    if (source !== undefined) {
      await writeSeededFile(policyTarget, source);
      messages.push(`Seeded ${policyTarget} from examples/policy.toml.`);
    }
  }
  const routingTarget = join(home, "routing.toml");
  if ((await optionalText(routingTarget)) === undefined) {
    const source = await optionalText(join(root, "examples", "routing.toml"));
    if (source !== undefined) {
      await writeSeededFile(routingTarget, source);
      const classes = Object.keys(parseRouting(source).consumes);
      messages.push(`Seeded ${routingTarget} from examples/routing.toml (action classes: ${classes.join(", ")}). Edit to match your accounts.`);
    }
  }
  return messages;
}
