import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { headroomHome, executablePath } from "../../paths.js";
import { createHash } from "node:crypto";
import { readPolicy } from "../../config.js";
import { outboundEnvironment, redact } from "../../security.js";
import type { Observation, ProviderAccount } from "../../types.js";
import { readEngineLock } from "../codexbar/install.js";
import { normalizeObservations } from "../observation.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const devBinary = join(repoRoot, "engine", ".build", "release", "headroom-engine");

export async function nativeEnginePath(): Promise<string | undefined> {
  const lock = await readEngineLock();
  const installedBinary = join(headroomHome(), "engine", "native", lock.native?.binary ?? "headroom-engine");
  if (lock.native) try {
    const marker = JSON.parse(await readFile(join(headroomHome(), "engine", "native", ".headroom-native-engine.json"), "utf8")) as { sha256?: string; binarySha256?: string; asset?: string };
    const asset = nativeAssetForCurrentPlatform(lock);
    // asset.sha256 is null while the lock entry is "unpinned" (a build/release
    // todo, never permission to trust a download). Requiring it truthy here,
    // not only equal, refuses a tampered marker crafted to match a null
    // asset.sha256 with its own null-ish sha256 field.
    if (asset.sha256 && asset.status !== "unpinned" && marker.asset === asset.name && marker.sha256 === asset.sha256 && marker.binarySha256 && marker.binarySha256 === await hash(installedBinary)) return await executablePath(installedBinary);
  } catch { /* use safe local development binary below */ }
  try { return await executablePath(devBinary, { repoRoot, development: true }); } catch { /* absent or unsafe */ }
  return undefined;
}

export async function runNativeEngine(enginePath: string, accounts: ProviderAccount[]): Promise<Observation[]> {
  const directory = await mkdtemp(join(tmpdir(), "headroom-principals-"));
  const principals = join(directory, "principals.json");
  try {
    await writeFile(principals, JSON.stringify(accounts.map(({ name, vendor, location }) => ({ id: name, vendor, location }))), { mode: 0o600 });
    await chmod(principals, 0o600);
    try {
      const { proxy } = await readPolicy();
      const { stdout } = await execFileAsync(enginePath, ["observe", "--principals", principals], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: outboundEnvironment(proxy, { PATH: process.env.PATH ?? "" }) });
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
  return normalizeObservations(value);
}

function isObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.principal_id === "string" && typeof item.meter_id === "string"
    && typeof item.freshness === "string" && typeof item.source === "string";
}

function nativeAssetForCurrentPlatform(lock: Awaited<ReturnType<typeof readEngineLock>>) {
  if (!lock.native) throw new Error("native engine is not pinned");
  const target = process.platform === "darwin" ? process.arch === "arm64" ? "macos-arm64" : "macos-x86_64" : process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  return lock.native.assets[target];
}
async function hash(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
