import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tallyHome } from "../../paths.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const lockPath = join(repoRoot, "engine.lock.json");

export interface LockedAsset { name: string; sha256?: string; url?: string }
export interface EngineLock {
  tag: string;
  native?: { tag: string; binary: string };
  repository: string;
  releaseAssets: string[];
  assets: Record<string, LockedAsset>;
}

interface GitHubAsset { name: string; browser_download_url: string }
interface GitHubRelease { assets: GitHubAsset[] }

export function platformAssetName(tag: string, os = platform(), cpu = arch()): string {
  const suffix = os === "darwin"
    ? cpu === "arm64" ? "macos-arm64" : cpu === "x64" ? "macos-x86_64" : unsupported(os, cpu)
    : os === "linux"
      ? linuxTarget(cpu)
      : unsupported(os, cpu);
  return `CodexBarCLI-${tag}-${suffix}.tar.gz`;
}

function linuxTarget(cpu: string): string {
  const cpuTarget = cpu === "arm64" ? "aarch64" : cpu === "x64" ? "x86_64" : unsupported("linux", cpu);
  // Node exposes glibc only on glibc Linux. Standalone musl builds have separate release assets.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  return glibc ? `linux-${cpuTarget}` : `linux-musl-${cpuTarget}`;
}

function unsupported(os: string, cpu: string): never {
  throw new Error(`No CodexBarCLI release asset for ${os}/${cpu}`);
}

export async function readEngineLock(path = lockPath): Promise<EngineLock> {
  return JSON.parse(await fs.readFile(path, "utf8")) as EngineLock;
}

async function writeEngineLock(lock: EngineLock, path = lockPath): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function releaseAssets(lock: EngineLock): Promise<GitHubAsset[]> {
  const response = await fetch(`https://api.github.com/repos/${lock.repository}/releases/tags/${lock.tag}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "tallyq" },
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
  const release = await response.json() as GitHubRelease;
  if (!Array.isArray(release.assets)) throw new Error("GitHub release response did not contain assets");
  return release.assets;
}

function installRoot(tag: string): string { return join(tallyHome(), "engine", tag); }
function markerPath(tag: string): string { return join(installRoot(tag), ".tally-engine.json"); }

export async function installEngine(): Promise<{ tag: string; path: string; sha256: string; firstPin: boolean }> {
  const lock = await readEngineLock();
  const wanted = platformAssetName(lock.tag);
  const upstreamAssets = await releaseAssets(lock);
  const upstream = upstreamAssets.find((asset) => asset.name === wanted);
  if (!upstream) throw new Error(`Pinned release ${lock.tag} has no ${wanted}; assets: ${upstreamAssets.map((a) => a.name).join(", ")}`);

  // Retain the API-confirmed release inventory even if a later download fails.
  lock.releaseAssets = upstreamAssets.map((asset) => asset.name).sort();
  await writeEngineLock(lock);

  const response = await fetch(upstream.browser_download_url, { headers: { "User-Agent": "tallyq" } });
  if (!response.ok) throw new Error(`Engine download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const locked = lock.assets[wanted];
  const firstPin = !locked?.sha256;
  if (locked?.sha256 && locked.sha256 !== sha256) throw new Error(`SHA-256 mismatch for ${wanted}`);

  // A first pin is intentionally explicit in the returned result/report; later installs fail closed.
  lock.assets[wanted] = { name: wanted, sha256, url: upstream.browser_download_url };
  await writeEngineLock(lock);

  const root = installRoot(lock.tag);
  const staging = `${root}.staging-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const archive = join(staging, wanted);
  try {
    await fs.writeFile(archive, bytes, { mode: 0o600 });
    // Extraction happens only after the archive checksum matched the lock (or was pinned above).
    const { stdout: entries } = await execFileAsync("tar", ["-tzf", archive]);
    for (const entry of entries.split("\n").filter(Boolean)) {
      if (entry.startsWith("/") || entry.split("/").includes("..")) throw new Error("Engine archive contains an unsafe path");
    }
    await execFileAsync("tar", ["-xzf", archive, "-C", staging]);
    await fs.rm(archive, { force: true });
    const binary = await findEngineBinary(staging);
    await fs.chmod(binary, 0o700);
    const binarySha256 = await sha256File(binary);
    await fs.writeFile(join(staging, ".tally-engine.json"), JSON.stringify({ tag: lock.tag, asset: wanted, sha256, binarySha256 }), { mode: 0o600 });
    await fs.mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(staging, root);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { tag: lock.tag, path: await verifiedEnginePath(), sha256, firstPin };
}

async function findEngineBinary(root: string): Promise<string> {
  for (const name of ["codexbar", "CodexBarCLI"]) {
    const path = join(root, name);
    try { await fs.access(path); return path; } catch { /* try next */ }
  }
  throw new Error("Verified archive did not contain codexbar or CodexBarCLI");
}

export async function verifiedEnginePath(): Promise<string> {
  const lock = await readEngineLock();
  const marker = JSON.parse(await fs.readFile(markerPath(lock.tag), "utf8")) as { asset?: string; sha256?: string; binarySha256?: string };
  if (!marker.asset || !marker.sha256 || lock.assets[marker.asset]?.sha256 !== marker.sha256) {
    throw new Error("Engine is absent or no longer matches engine.lock.json; run tally engine install");
  }
  const binary = await findEngineBinary(installRoot(lock.tag));
  if (!marker.binarySha256 || marker.binarySha256 !== await sha256File(binary)) throw new Error("Engine binary changed after verification; run tally engine install");
  return binary;
}

export async function engineStatus(): Promise<{ tag: string; path: string; present: boolean }> {
  const lock = await readEngineLock();
  try { return { tag: lock.tag, path: await verifiedEnginePath(), present: true }; }
  catch { return { tag: lock.tag, path: join(installRoot(lock.tag), "codexbar"), present: false }; }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}
