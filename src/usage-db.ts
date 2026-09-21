/**
 * Safe open/create for the private `usage.db` SQLite file under
 * `~/.headroom/`. This mirrors store.ts's own file-trust checks (owned,
 * regular, 0600, not a symlink) for a second, independent database file --
 * see usage-store.ts for the schema and higher-level operations built on top.
 * Never touches `headroom.db` or its schema.
 */
import { createRequire } from "node:module";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { safeHeadroomDirectory } from "./store.js";
import { headroomHome } from "./paths.js";

export interface UsageDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

type DatabaseConstructor = new (path: string) => UsageDatabase;
// Node ships SQLite as a built-in. createRequire keeps this repo's ESM/Vitest
// setup from trying to resolve "node:sqlite" as a browser module, matching
// store.ts's own DatabaseSync import.
const DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: DatabaseConstructor }).DatabaseSync;

const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

function sidecarsFor(dbPath: string): string[] {
  return SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`);
}

/** One error message for every unsafe-file outcome: never echoes the path or
 * the offending filename, so a caller cannot use a thrown message to learn
 * which sidecar or db file failed a check. */
const UNSAFE_USAGE_DATABASE = "Unsafe usage database";

/** lstat + ownership + mode + hard-link check for one candidate file. Returns
 * whether it exists at all; throws UNSAFE_USAGE_DATABASE for anything present
 * but not a plain, owned, 0600, single-link regular file. A symlink leaf is
 * refused outright -- never dereferenced, never followed, never chmod'd. */
async function assertSafeUsageFile(path: string): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(UNSAFE_USAGE_DATABASE);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(UNSAFE_USAGE_DATABASE);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(UNSAFE_USAGE_DATABASE);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) throw new Error(UNSAFE_USAGE_DATABASE);
    // A second directory entry pointing at the same inode (a hard link) could
    // let another path silently share -- or replace -- these bytes outside
    // Headroom's own view of the file; refuse rather than trust a single link
    // count of exactly one.
    if (stat.nlink !== 1) throw new Error(UNSAFE_USAGE_DATABASE);
  }
  return true;
}

/** Validates the primary db file plus every sidecar; returns whether the
 * primary file exists. Every candidate is checked (not just the first
 * present one) so an attacker cannot plant an unsafe sidecar behind a safe
 * primary file. */
async function assertSafeUsageFiles(dbPath: string): Promise<boolean> {
  const primaryExists = await assertSafeUsageFile(dbPath);
  for (const sidecar of sidecarsFor(dbPath)) await assertSafeUsageFile(sidecar);
  return primaryExists;
}

export async function openUsageDatabase(options: { home?: string; create: boolean }): Promise<UsageDatabase | undefined> {
  const home = options.home ?? headroomHome();
  const dbPath = join(home, "usage.db");

  // Checked before anything creates a directory: a missing home with
  // create:false must leave the filesystem untouched.
  const dbExists = await assertSafeUsageFiles(dbPath);
  if (!options.create && !dbExists) return undefined;

  let safeHome: string;
  try {
    safeHome = await safeHeadroomDirectory(home);
  } catch {
    throw new Error(UNSAFE_USAGE_DATABASE);
  }
  const finalDbPath = join(safeHome, "usage.db");

  if (!dbExists) {
    try {
      const handle = await open(finalDbPath, "wx", 0o600);
      await handle.close();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Unable to open usage database");
      // Concurrent creation by another process -- fall through to the
      // revalidation pass below, which covers this case too.
    }
  }

  // Revalidate the canonical path and every sidecar immediately before
  // SQLite opens the file, closing the window between the existence check
  // (or creation) above and the open call below.
  await assertSafeUsageFiles(finalDbPath);

  try {
    return new DatabaseSync(finalDbPath);
  } catch {
    throw new Error("Unable to open usage database");
  }
}
