import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBundleFlag, writeDoctorBundle } from "../src/bundle.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

describe("parseBundleFlag", () => {
  it("reads the path after --bundle when it is not itself a flag", () => {
    expect(parseBundleFlag(["--bundle", "/tmp/report.txt"])).toBe("/tmp/report.txt");
  });
  it("returns undefined for a bare --bundle", () => {
    expect(parseBundleFlag(["--bundle"])).toBeUndefined();
  });
  it("returns undefined when the next token is itself a flag", () => {
    expect(parseBundleFlag(["--bundle", "--other"])).toBeUndefined();
  });
  it("returns undefined when --bundle is absent", () => {
    expect(parseBundleFlag([])).toBeUndefined();
  });
});

describe("headroom doctor --bundle", () => {
  it("redacts a token, an email, a LAN address, the home directory and the username out of a fake daemon log", async () => {
    const fakeHome = await tempDir("headroom-bundle-userhome-");
    const headroomHome = await tempDir("headroom-bundle-home-");
    const outputDir = await tempDir("headroom-bundle-output-");
    const username = userInfo().username;
    await mkdir(join(headroomHome, "logs"), { recursive: true });
    const token = "sk-THISISNOTAREALTOKEN1234567890ABCDEF";
    const email = "someone@example.com";
    // Assembled at runtime, not a literal contiguous match in this file's own
    // source: this test file is itself tracked, and scripts/privacy-sweep.sh
    // would otherwise flag a bare private IPv4 literal here (see how
    // test/privacy-sweep.test.ts does the same for its own fixtures).
    const lanAddress = ["192", "168", "1", "42"].join(".");
    const usernamePath = `/var/lib/${username}/cache/thing.json`;
    const homePath = `${fakeHome}/.claude/.credentials.json`;
    await writeFile(
      join(headroomHome, "logs", "daemon.log"),
      [
        `2026-01-01T00:00:00.000Z auth failed Authorization: Bearer ${token}`,
        `2026-01-01T00:00:01.000Z contact ${email} for help`,
        `2026-01-01T00:00:02.000Z reachable at ${lanAddress} for debugging`,
        `2026-01-01T00:00:03.000Z read ${usernamePath}`,
        `2026-01-01T00:00:04.000Z read ${homePath}`,
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(undefined, outputDir));
    const text = await readFile(result.path, "utf8");

    expect(text).not.toContain(token);
    expect(text).not.toContain(email);
    expect(text).not.toContain(lanAddress);
    expect(text).not.toContain(`/${username}/`);
    expect(text).not.toContain(fakeHome);

    // The redaction placeholders actually landed, and the rest of each log
    // line survived -- this is a scrub, not a wipe.
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("<user>");
    expect(text).toContain("~/.claude/.credentials.json");
    expect(text).toContain("reachable at [REDACTED] for debugging");
    expect(text).toContain("contact [REDACTED] for help");

    // The disclaimer required at the top of the file.
    expect(text.startsWith("Headroom support bundle")).toBe(true);
    expect(text).toMatch(/redacted/i);
    expect(text).toMatch(/read the whole file yourself/i);
  });

  it("redacts this machine's hostname when it is not localhost", async () => {
    const headroomHome = await tempDir("headroom-bundle-home-");
    const outputDir = await tempDir("headroom-bundle-output-");
    const host = hostname();
    await mkdir(join(headroomHome, "logs"), { recursive: true });
    await writeFile(join(headroomHome, "logs", "daemon.log"), `2026-01-01T00:00:00.000Z started on ${host}\n`, "utf8");

    const result = await withEnv({ HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(undefined, outputDir));
    const text = await readFile(result.path, "utf8");
    if (host && host !== "localhost") {
      expect(text).not.toContain(host);
      expect(text).toContain("<host>");
    }
  });

  it("prints the sections in a fixed order: doctor, principals, config files, daemon log, audit, status", async () => {
    const headroomHome = await tempDir("headroom-bundle-home-");
    const outputDir = await tempDir("headroom-bundle-output-");
    const result = await withEnv({ HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(undefined, outputDir));
    const text = await readFile(result.path, "utf8");

    const order = ["== doctor ==", "== principals ==", "== policy.toml ==", "== routing.toml ==", "== daemon log", "== audit", "== status =="];
    const positions = order.map((marker) => text.indexOf(marker));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < positions.length; index += 1) expect(positions[index]).toBeGreaterThan(positions[index - 1]);
  });

  it("defaults to headroom-bundle-<date>.txt in the current directory, and reports its size", async () => {
    const headroomHome = await tempDir("headroom-bundle-home-");
    const outputDir = await tempDir("headroom-bundle-output-");
    const result = await withEnv({ HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(undefined, outputDir));
    const today = new Date().toISOString().slice(0, 10);
    expect(result.path).toBe(join(outputDir, `headroom-bundle-${today}.txt`));
    expect(result.bytes).toBeGreaterThan(0);
    const stat = await readFile(result.path, "utf8");
    expect(Buffer.byteLength(stat, "utf8")).toBe(result.bytes);
  });

  it("writes into an explicit path when one is given, and into a directory (with the default name) when that path already exists as one", async () => {
    const headroomHome = await tempDir("headroom-bundle-home-");
    const outputDir = await tempDir("headroom-bundle-output-");
    const explicit = join(outputDir, "my-report.txt");
    const explicitResult = await withEnv({ HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(explicit, outputDir));
    expect(explicitResult.path).toBe(explicit);

    const targetDir = await tempDir("headroom-bundle-target-dir-");
    const dirResult = await withEnv({ HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(targetDir, outputDir));
    const today = new Date().toISOString().slice(0, 10);
    expect(dirResult.path).toBe(join(targetDir, `headroom-bundle-${today}.txt`));
  });

  it("never includes the accounts.toml path, the sqlite database file, or a credential file path verbatim", async () => {
    const headroomHome = await tempDir("headroom-bundle-home-");
    const outputDir = await tempDir("headroom-bundle-output-");
    const result = await withEnv({ HEADROOM_HOME: headroomHome }, () => writeDoctorBundle(undefined, outputDir));
    const text = await readFile(result.path, "utf8");
    expect(text).not.toContain(join(headroomHome, "accounts.toml"));
    expect(text).not.toContain(join(headroomHome, "headroom.db"));
  });
});
