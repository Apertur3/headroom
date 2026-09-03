import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tallyHome } from "./paths.js";
import { defaultPolicy, parsePolicy, type Policy } from "./policy.js";

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function readPolicy(): Promise<Policy> {
  const text = await optionalText(join(tallyHome(), "policy.toml"));
  return text === undefined ? defaultPolicy : parsePolicy(text);
}

/** Parse the only TOML construct routing needs: [consumes] string arrays. */
export function parseConsumes(text: string): Record<string, string[]> {
  const consumes: Record<string, string[]> = {};
  let inConsumes = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (/^\[consumes\]$/.test(line)) { inConsumes = true; continue; }
    if (/^\[.*\]$/.test(line)) { inConsumes = false; continue; }
    if (!inConsumes) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*\[(.*)\]$/.exec(line);
    if (!match) throw new Error(`Invalid consumes entry: ${line}`);
    const meters = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => JSON.parse(`"${item[1]}"`) as string);
    if (!meters.length) throw new Error(`Consumes entry ${match[1]} has no meters`);
    consumes[match[1]] = meters;
  }
  return consumes;
}

export async function readConsumes(): Promise<Record<string, string[]>> {
  const path = process.env.TALLY_ROUTING ?? join(tallyHome(), "routing.toml");
  const text = await optionalText(path);
  return text === undefined ? {} : parseConsumes(text);
}
