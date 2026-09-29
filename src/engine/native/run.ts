import { chmod, lstat, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headroomHome, executablePath } from "../../paths.js";
import { createHash } from "node:crypto";
import { readPolicy } from "../../config.js";
import { outboundEnvironment, redact } from "../../security.js";
import type { Observation, ProviderAccount } from "../../types.js";
import { readEngineLock } from "../codexbar/install.js";
import { normalizeObservations } from "../observation.js";
import { runInGroup } from "../group-run.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const devBinary = join(repoRoot, "engine", ".build", "release", "headroom-engine");

/** The native reader's maximum budget for one daemon poll. Callers that make
 * a retry pass the remaining portion of this same budget, rather than
 * granting a second full timeout. */
export const NATIVE_ENGINE_TIMEOUT_MS = 90_000;

export class NativeEngineVerificationError extends Error {}

/** The immutable npm artifact supplies both the reader and its digest. A
 * present but corrupt reader must never fall through to an unverified build. */
export async function verifiedPackagedNativeEngine(root = repoRoot, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform !== "darwin") return undefined;
  const packageRoot = await realpath(root);
  const directory = join(packageRoot, "bin", "engine", "darwin");
  try { await lstat(directory); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const binary = join(directory, "headroom-engine");
  const digest = join(directory, "SHA256");
  try {
    for (const path of [packageRoot, join(packageRoot, "bin"), join(packageRoot, "bin", "engine"), directory, binary, digest]) {
      const info = await lstat(path);
      const file = path === binary || path === digest;
      if (info.isSymbolicLink() || (file ? !info.isFile() : !info.isDirectory())) throw new Error("unsafe file type");
      if (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0) throw new Error("foreign owner");
      if ((info.mode & 0o022) !== 0) throw new Error("writable by others");
      if (path === digest && info.size > 128) throw new Error("oversized digest");
      if (path === binary && (info.size > 128 * 1024 * 1024 || !(info.mode & 0o111))) throw new Error("invalid executable");
    }
    // Global npm installs may be root-owned. The package-specific checks
    // above admit root as well as the current user, unlike development paths.
    const verified = await realpath(binary);
    const recorded = (await readFile(digest, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(recorded) || recorded !== await hash(verified)) throw new Error("digest mismatch");
    return verified;
  } catch {
    throw new NativeEngineVerificationError("Packaged native reader failed integrity or permission checks; reinstall headroomd");
  }
}

export async function nativeEnginePath(): Promise<string | undefined> {
  const packaged = await verifiedPackagedNativeEngine();
  if (packaged) return packaged;
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

interface EngineFlight { key: string; promise: Promise<Observation[]> }
/** The one engine read that may run right now (see runNativeEngine). */
let engineFlight: EngineFlight | undefined;

/**
 * At most ONE native engine read runs at a time, process-wide: the engine can
 * start agy, and two overlapping reads doubled the agy trees on the host. A
 * caller asking for the same accounts while one is in flight shares its
 * result; a caller asking for different accounts waits its turn, and that wait
 * counts against its own timeout.
 */
export async function runNativeEngine(enginePath: string, accounts: ProviderAccount[], options: { timeoutMs?: number } = {}): Promise<Observation[]> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? NATIVE_ENGINE_TIMEOUT_MS, NATIVE_ENGINE_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const key = `${enginePath}\0${JSON.stringify(accounts.map(({ name, vendor, location }) => [name, vendor, location]))}`;
  for (;;) {
    const current = engineFlight;
    if (!current) break;
    if (current.key === key) return current.promise;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("native engine busy with another read");
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); });
    try { await Promise.race([current.promise.then(() => undefined, () => undefined), expired]); }
    finally { clearTimeout(timer); }
    if (engineFlight === current) { if (Date.now() >= deadline) throw new Error("native engine busy with another read"); }
  }
  const flight: EngineFlight = { key, promise: undefined as unknown as Promise<Observation[]> };
  flight.promise = readNativeEngine(enginePath, accounts, Math.max(1, deadline - Date.now()))
    .finally(() => { if (engineFlight === flight) engineFlight = undefined; });
  engineFlight = flight;
  return flight.promise;
}

async function readNativeEngine(enginePath: string, accounts: ProviderAccount[], timeoutMs: number): Promise<Observation[]> {
  const directory = await mkdtemp(join(tmpdir(), "headroom-principals-"));
  const principals = join(directory, "principals.json");
  try {
    await writeFile(principals, JSON.stringify(accounts.map(({ name, vendor, location }) => ({ id: name, vendor, location }))), { mode: 0o600 });
    await chmod(principals, 0o600);
    try {
      const { proxy } = await readPolicy();
      const { stdout } = await runInGroup(enginePath, ["observe", "--principals", principals], { timeoutMs, maxBuffer: 2 * 1024 * 1024, env: outboundEnvironment(proxy, { PATH: process.env.PATH ?? "" }) });
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
