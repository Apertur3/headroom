import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tallyHome } from "../../paths.js";
import { redact } from "../../security.js";
import type { Observation, ProviderAccount } from "../../types.js";
import { readEngineLock } from "../codexbar/install.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const devBinary = join(repoRoot, "engine", ".build", "release", "tally-engine");

export async function nativeEnginePath(): Promise<string | undefined> {
  const lock = await readEngineLock();
  const installedBinary = join(tallyHome(), "engine", "native", lock.native?.binary ?? "tally-engine");
  for (const path of [installedBinary, devBinary]) {
    try { await access(path); return path; } catch { /* try next */ }
  }
  return undefined;
}

export async function runNativeEngine(enginePath: string, accounts: ProviderAccount[]): Promise<Observation[]> {
  const directory = await mkdtemp(join(tmpdir(), "tally-principals-"));
  const principals = join(directory, "principals.json");
  try {
    await writeFile(principals, JSON.stringify(accounts.map(({ name, vendor, location }) => ({ id: name, vendor, location }))), { mode: 0o600 });
    await chmod(principals, 0o600);
    try {
      const { stdout } = await execFileAsync(enginePath, ["observe", "--principals", principals], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
      return parseObservations(stdout);
    } catch (error: unknown) {
      const result = error as { stdout?: string; stderr?: string; message?: string };
      if (result.stdout) return parseObservations(result.stdout);
      throw new Error(redact(result.stderr || result.message || "native engine failed"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseObservations(text: string): Observation[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every(isObservation)) throw new Error("Native engine returned invalid observation JSON");
  return value;
}

function isObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.principal_id === "string" && typeof item.meter_id === "string"
    && typeof item.freshness === "string" && typeof item.source === "string";
}
