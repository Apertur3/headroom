import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod, lstat, symlink, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageDatabase } from "../src/usage-db.js";

describe("openUsageDatabase", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "usage-db-test-"));
    await chmod(tempDir, 0o700);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns undefined if home is absent and create is false", async () => {
    const nonExistentHome = join(tempDir, "non-existent");
    const db = await openUsageDatabase({ home: nonExistentHome, create: false });
    expect(db).toBeUndefined();

    let dirExists = true;
    try {
      await lstat(nonExistentHome);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        dirExists = false;
      }
    }
    expect(dirExists).toBe(false);
  });

  it("creates usage.db with 0600 permissions when create is true", async () => {
    const home = join(tempDir, "home");
    const db = await openUsageDatabase({ home, create: true });
    expect(db).toBeDefined();

    const stat = await lstat(join(home, "usage.db"));
    expect(stat.isFile()).toBe(true);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);

    db!.close();
  });

  it("reopens existing DB and retains data", async () => {
    const home = join(tempDir, "home");

    const db1 = await openUsageDatabase({ home, create: true });
    db1!.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    db1!.prepare("INSERT INTO test (value) VALUES (?)").run("hello");
    db1!.close();

    const db2 = await openUsageDatabase({ home, create: false });
    expect(db2).toBeDefined();
    const row = db2!.prepare("SELECT value FROM test WHERE id = 1").get();
    expect(row).toEqual({ value: "hello" });
    db2!.close();
  });

  it("does not create quota DB when create is false and DB exists", async () => {
    const home = join(tempDir, "home");

    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "usage.db"), "");
    await chmod(join(home, "usage.db"), 0o600);

    const db = await openUsageDatabase({ home, create: false });
    expect(db).toBeDefined();

    const files = await readdir(home);
    expect(files).toEqual(["usage.db"]);

    db!.close();
  });

  it.skipIf(process.platform === "win32")("refuses unsafe db symlink and never modifies the link target's content", async () => {
    const home = join(tempDir, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });

    const targetPath = join(tempDir, "target.db");
    // Synthetic fixture content, not a real database -- only used to prove
    // the symlink target is never opened, read, or written through.
    const targetContent = "synthetic-fixture-content-unchanged";
    await writeFile(targetPath, targetContent);

    await symlink(targetPath, join(home, "usage.db"));

    let error: Error | undefined;
    try {
      await openUsageDatabase({ home, create: false });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toBe("Unsafe usage database");

    const targetStat = await lstat(targetPath);
    expect(targetStat.isFile()).toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe(targetContent);
  });

  it.skipIf(process.platform === "win32")("refuses world-readable db", async () => {
    const home = join(tempDir, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });

    const dbPath = join(home, "usage.db");
    await writeFile(dbPath, "");
    await chmod(dbPath, 0o644); // World readable

    let error: Error | undefined;
    try {
      await openUsageDatabase({ home, create: false });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toBe("Unsafe usage database");
  });

  it.skipIf(process.platform === "win32")("refuses unsafe journal symlink", async () => {
    const home = join(tempDir, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });

    await writeFile(join(home, "usage.db"), "");
    await chmod(join(home, "usage.db"), 0o600);

    const targetPath = join(tempDir, "target-journal");
    await writeFile(targetPath, "");

    await symlink(targetPath, join(home, "usage.db-journal"));

    let error: Error | undefined;
    try {
      await openUsageDatabase({ home, create: false });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toBe("Unsafe usage database");
  });

  it.skipIf(process.platform === "win32")("refuses home symlink", async () => {
    const realHome = join(tempDir, "real-home");
    await mkdir(realHome, { recursive: true, mode: 0o700 });

    const symlinkHome = join(tempDir, "symlink-home");
    await symlink(realHome, symlinkHome);

    let error: Error | undefined;
    try {
      await openUsageDatabase({ home: symlinkHome, create: true });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toMatch(/Unsafe|Refusing/);
  });

  it.skipIf(process.platform === "win32")("refuses a hard-linked db file", async () => {
    const home = join(tempDir, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const dbPath = join(home, "usage.db");
    await writeFile(dbPath, "");
    await chmod(dbPath, 0o600);
    const { link } = await import("node:fs/promises");
    await link(dbPath, join(tempDir, "hardlink.db"));

    let error: Error | undefined;
    try {
      await openUsageDatabase({ home, create: false });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toBe("Unsafe usage database");
  });

  it("exceptions exclude the home path and db filename", async () => {
    // Synthetic canary segment embedded in the path itself -- proves the
    // thrown message never echoes the path it refused, not just that it
    // omits an unrelated string.
    const home = join(tempDir, "CANARY_SECRET_PATH_MARKER", "home");
    await mkdir(home, { recursive: true, mode: 0o700 });

    // Create a directory at the db path to trigger a deterministic
    // "not a regular file" error on all platforms, avoiding platform-specific
    // permission checks or file handle leaks.
    const dbPath = join(home, "usage.db");
    await mkdir(dbPath);

    let error: Error | undefined;
    try {
      await openUsageDatabase({ home, create: false });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toBe("Unsafe usage database");
    expect(error!.message).not.toContain("usage.db");
    expect(error!.message).not.toContain(home);
    expect(error!.message).not.toContain("CANARY_SECRET_PATH_MARKER");
  });
});
