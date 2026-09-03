import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
export interface Routing { consumes: Record<string, string[]>; local_preference: LocalPreference; }

/** Parse Headroom's deliberately small routing surface without accepting arbitrary
 * TOML features into a security-sensitive local config. */
export function parseRouting(text: string): Routing {
  const consumes: Record<string, string[]> = {};
  let localPreference: LocalPreference = "fallback";
  let inConsumes = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const preference = /^local_preference\s*=\s*"(fallback|prefer|never)"\s*$/.exec(line);
    if (preference) { localPreference = preference[1] as LocalPreference; continue; }
    if (/^\[consumes\]$/.test(line)) { inConsumes = true; continue; }
    if (/^\[.*\]$/.test(line)) { inConsumes = false; continue; }
    if (!inConsumes) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*\[(.*)\]$/.exec(line);
    if (!match) throw new Error(`Invalid consumes entry: ${line}`);
    const meters = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => JSON.parse(`"${item[1]}"`) as string);
    if (!meters.length) throw new Error(`Consumes entry ${match[1]} has no meters`);
    consumes[match[1]] = meters;
  }
  return { consumes, local_preference: localPreference };
}

export function parseConsumes(text: string): Record<string, string[]> { return parseRouting(text).consumes; }

export async function readConsumes(): Promise<Record<string, string[]>> {
  return (await readRouting()).consumes;
}

export async function readRouting(): Promise<Routing> {
  const path = process.env.HEADROOM_ROUTING ?? join(headroomHome(), "routing.toml");
  const text = await optionalText(path);
  return text === undefined ? { consumes: {}, local_preference: "fallback" } : parseRouting(text);
}
