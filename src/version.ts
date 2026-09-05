import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves to the package root both from a repo checkout (src/version.ts,
 * one level down) and from the compiled npm package (dist/version.js, also
 * one level down) -- the same resolution config.ts's own packageRoot() uses
 * for examples/. package.json itself always ships in the npm tarball; npm
 * includes it regardless of the "files" allowlist. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

let cached: string | undefined;

/** package.json's version, read once and cached. Used by `headroom
 * version`/`--version` and doctor's version banner; never throws -- an
 * unreadable or malformed package.json (should never happen in a real
 * install) reads as "unknown" rather than crashing either caller. */
export async function headroomVersion(): Promise<string> {
  if (cached) return cached;
  try {
    const raw = await readFile(join(packageRoot(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    cached = typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
  } catch { cached = "unknown"; }
  return cached;
}
