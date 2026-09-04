import { homedir } from "node:os";
import { lstat, realpath, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, win32 } from "node:path";

export interface PathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function values(options: PathOptions): Required<PathOptions> {
  return { platform: options.platform ?? process.platform, env: options.env ?? process.env, home: options.home ?? homedir() };
}

export function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : join(...parts);
}

export function headroomHome(options: PathOptions = {}): string {
  const { platform, env, home } = values(options);
  if (env.HEADROOM_HOME) return env.HEADROOM_HOME;
  if (platform === "win32") return joinForPlatform(platform, env.LOCALAPPDATA || joinForPlatform(platform, home, "AppData", "Local"), "headroom");
  return joinForPlatform(platform, home, ".headroom");
}

/** Move the pre-rename state exactly once, before anything creates its new home. */
export async function migrateLegacyHome(options: PathOptions = {}): Promise<boolean> {
  const { platform, env, home } = values(options);
  if (env.HEADROOM_HOME || platform === "win32") return false;
  const legacy = joinForPlatform(platform, home, [".", "ta", "lly"].join(""));
  const current = headroomHome({ platform, env, home });
  try {
    const currentStat = await lstat(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) return false;
    // Earlier migration runs could create ~/.headroom before moving the old
    // engine cache. Move that verified-cache directory independently instead
    // of making engine install re-download an already pinned binary.
    const legacyEngine = join(legacy, "engine");
    const currentEngine = join(current, "engine");
    try {
      const oldEngine = await lstat(legacyEngine);
      if (!oldEngine.isDirectory() || oldEngine.isSymbolicLink()) return false;
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await lstat(currentEngine); return false; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(legacyEngine, currentEngine); return true; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return false;
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    const stat = await lstat(legacy);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    await rename(legacy, current);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/** Refuse symlinks, foreign-owned, or group/world-writable executables. */
export async function executablePath(path: string, options: { repoRoot?: string; development?: boolean } = {}): Promise<string> {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing unsafe executable path");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing executable owned by another user");
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) throw new Error("Refusing group or world writable executable");
  if (options.development && options.repoRoot) {
    const repo = await realpath(options.repoRoot);
    if (relative(repo, canonical).startsWith("..")) throw new Error("Refusing development executable outside repository");
  }
  return canonical;
}

/**
 * Refuse a HEADROOM_HOME whose parent chain contains a directory owned by
 * neither root nor the current user, so a co-tenant on a shared machine
 * cannot plant a symlink somewhere above ~/.headroom to redirect Headroom's
 * state directory or its Unix socket into a location they control.
 *
 * `realpath()` on the nearest already-existing ancestor resolves an ordinary,
 * root-owned system symlink (macOS's `/var` -> `/private/var` is one) the
 * same way the OS would; the walk below then checks ownership of that
 * resolved chain's own segments, which by construction are no longer
 * symlinks themselves. Components that do not exist yet are left for the
 * caller's own `mkdir` to create with an explicit, safe mode.
 */
export interface AncestryOptions {
  platform?: NodeJS.Platform;
  /** Test seam only; production always reads the real process uid. */
  uid?: number;
  lstat?: typeof lstat;
  realpath?: typeof realpath;
}

export async function assertSafeAncestry(target: string, options: AncestryOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (options.uid === undefined && typeof process.getuid !== "function") return; // no meaningful uid model (Windows)
  const uid = options.uid ?? process.getuid!();
  const doLstat = options.lstat ?? lstat;
  const doRealpath = options.realpath ?? realpath;
  let probe = resolve(target);
  let base: string | undefined;
  for (;;) {
    try { await doLstat(probe); base = probe; break; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) break; // reached the filesystem root without finding an existing component
      probe = parent;
    }
  }
  if (base === undefined) return;
  const canonicalBase = await doRealpath(base);
  const segments = canonicalBase.split(sep).filter(Boolean);
  let current = platform === "win32" ? "" : sep;
  for (const segment of segments) {
    current = current === sep ? `${sep}${segment}` : join(current, segment);
    const info = await doLstat(current);
    if (info.uid !== uid && info.uid !== 0) throw new Error(`Refusing unsafe HEADROOM_HOME: ${current} is owned by another user`);
  }
}

export type VendorHome = "claude" | "codex" | "gemini";

export function vendorHome(vendor: VendorHome, options: PathOptions = {}): string {
  const { home } = values(options);
  return joinForPlatform(values(options).platform, home, `.${vendor}`);
}

/** Credential locations used by native TypeScript adapters. Claude uses the
 * macOS Keychain instead of this file when running on macOS. */
export function credentialPath(vendor: "claude" | "codex" | "antigravity", location?: string, options: PathOptions = {}): string {
  const directory = location || vendorHome(vendor === "antigravity" ? "gemini" : vendor, options);
  const filename = vendor === "claude" ? ".credentials.json" : vendor === "codex" ? "auth.json" : "oauth_creds.json";
  return joinForPlatform(values(options).platform, directory, filename);
}
