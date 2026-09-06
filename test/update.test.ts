import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions, fetchLatestVersion, fetchReleaseNotes, headroomCommand, isNewerVersion,
  npmCommand, npmInstallArgs, parseSemver, updateNoticeLine,
} from "../src/update.js";
import { allowedOutbound } from "../src/security.js";
import { defaultPolicy, parsePolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import { tailDaemonLog } from "../src/logs.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function seededHome(prefix = "headroom-update-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Records every request URL it was called with; the outbound allowlist
 * proof (fetchLatestVersion/fetchReleaseNotes must reach exactly the host
 * they say they reach) reads this back. */
function countingFetch(respond: (url: string) => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (input: Request | string | URL) => {
    const url = (input as Request).url ?? String(input);
    urls.push(url);
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, urls };
}

describe("version comparison", () => {
  it("parses plain and prerelease headroomd versions", () => {
    expect(parseSemver("0.1.0-beta.4")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ["beta", "4"] });
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("not-a-version")).toBeUndefined();
  });

  it("ranks a plain release above its own prereleases, and later prereleases above earlier ones", () => {
    expect(compareVersions("0.1.0", "0.1.0-beta.4")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-beta.4", "0.1.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("never calls an unparseable version newer than anything", () => {
    expect(isNewerVersion("0.1.0", "garbage")).toBe(false);
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false);
  });

  it("isNewerVersion agrees with the raw comparison direction", () => {
    expect(isNewerVersion("0.1.0-beta.4", "0.1.0-beta.5")).toBe(true);
    expect(isNewerVersion("0.1.0-beta.5", "0.1.0-beta.4")).toBe(false);
  });
});

describe("platform-specific executable names", () => {
  it("uses the .cmd shim on Windows for both npm and the freshly installed headroom binary", () => {
    expect(npmCommand("win32")).toBe("npm.cmd");
    expect(headroomCommand("win32")).toBe("headroom.cmd");
    expect(npmCommand("darwin")).toBe("npm");
    expect(npmCommand("linux")).toBe("npm");
    expect(headroomCommand("darwin")).toBe("headroom");
  });

  it("builds the exact npm install argument vector", () => {
    expect(npmInstallArgs("0.2.0")).toEqual(["install", "-g", "headroomd@0.2.0"]);
  });
});

describe("outbound allowlist", () => {
  it("allows the npm registry and the GitHub releases API, and nothing else new", () => {
    expect(() => allowedOutbound("https://registry.npmjs.org/headroomd/latest")).not.toThrow();
    expect(() => allowedOutbound("https://api.github.com/repos/Apertur3/headroom/releases/tags/v0.2.0")).not.toThrow();
    expect(() => allowedOutbound("https://registry.npmjs.org.evil.example/headroomd/latest")).toThrow("Outbound host is not allowed");
    expect(() => allowedOutbound("https://example.com/headroomd")).toThrow("Outbound host is not allowed");
  });
});

describe("fetchLatestVersion", () => {
  it("reaches exactly registry.npmjs.org/headroomd/latest and returns the version field", async () => {
    const { fetch: fake, urls } = countingFetch(() => json({ name: "headroomd", version: "0.2.0" }));
    await expect(fetchLatestVersion(fake)).resolves.toBe("0.2.0");
    expect(urls).toEqual(["https://registry.npmjs.org/headroomd/latest"]);
  });

  it("throws on a non-OK response instead of returning a bogus version", async () => {
    const fake = (async () => json({}, 500)) as unknown as typeof fetch;
    await expect(fetchLatestVersion(fake)).rejects.toThrow("500");
  });

  it("throws when the response carries no version field", async () => {
    const fake = (async () => json({ name: "headroomd" })) as unknown as typeof fetch;
    await expect(fetchLatestVersion(fake)).rejects.toThrow(/no version/);
  });

  it("refuses a redirect rather than following it", async () => {
    const fake = (async () => new Response("", { status: 302, headers: { location: "https://example.invalid/steal" } })) as unknown as typeof fetch;
    await expect(fetchLatestVersion(fake)).rejects.toThrow("redirect refused");
  });
});

describe("fetchReleaseNotes (--notes)", () => {
  it("reaches the exact GitHub releases-by-tag URL and returns the release body only", async () => {
    const { fetch: fake, urls } = countingFetch(() => json({ tag_name: "v0.2.0", body: "### Added\n- something new\n" }));
    await expect(fetchReleaseNotes("0.2.0", fake)).resolves.toBe("### Added\n- something new\n");
    expect(urls).toEqual(["https://api.github.com/repos/Apertur3/headroom/releases/tags/v0.2.0"]);
  });

  it("is undefined, not a thrown error, when the release does not exist yet", async () => {
    const fake = (async () => json({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    await expect(fetchReleaseNotes("9.9.9", fake)).resolves.toBeUndefined();
  });
});

describe("policy.update_check", () => {
  it("defaults to true and parses like the other scalars", () => {
    expect(defaultPolicy.update_check).toBe(true);
    expect(parsePolicy("update_check = false\n").update_check).toBe(false);
    expect(parsePolicy("update_check = true\n").update_check).toBe(true);
    expect(parsePolicy("").update_check).toBe(true);
  });
});

describe("updateNoticeLine (the status/doctor notice, 24h cached)", () => {
  it("checks once, caches the result in the store's daemon_state table, and makes no second request within 24 hours", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    const { fetch: fake, urls } = countingFetch(() => json({ version: "999.0.0" }));
    const t0 = new Date("2026-09-06T12:00:00Z");
    const first = await updateNoticeLine({ ...defaultPolicy }, { fetch: fake, store, now: () => t0 });
    expect(first).toBe("headroomd 999.0.0 is available; run: headroom update");
    expect(urls).toHaveLength(1);

    // Same day, a later call: no second registry request, same notice.
    const second = await updateNoticeLine({ ...defaultPolicy }, { fetch: fake, store, now: () => new Date(t0.getTime() + 60_000) });
    expect(second).toBe("headroomd 999.0.0 is available; run: headroom update");
    expect(urls).toHaveLength(1);

    // 25 hours later: the cache has expired, so it checks again.
    const third = await updateNoticeLine({ ...defaultPolicy }, { fetch: fake, store, now: () => new Date(t0.getTime() + 25 * 60 * 60 * 1000) });
    expect(third).toBe("headroomd 999.0.0 is available; run: headroom update");
    expect(urls).toHaveLength(2);
    store.close();
  });

  it("returns undefined and makes no request at all when the current version is already the latest", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    const { fetch: fake, urls } = countingFetch(() => json({ version: "0.0.0" }));
    await expect(updateNoticeLine({ ...defaultPolicy }, { fetch: fake, store })).resolves.toBeUndefined();
    expect(urls).toHaveLength(1); // the registry is still checked; only the notice is suppressed
    store.close();
  });

  it("update_check = false disables the check outright: no request at all", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    const { fetch: fake, urls } = countingFetch(() => json({ version: "999.0.0" }));
    await expect(updateNoticeLine({ ...defaultPolicy, update_check: false }, { fetch: fake, store })).resolves.toBeUndefined();
    expect(urls).toHaveLength(0);
    store.close();
  });

  it("a failed registry call is silent: no throw, undefined returned, at most a debug line in the daemon log", async () => {
    const home = await seededHome();
    const store = await HeadroomStore.open(home);
    const failing = (async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch;
    await expect(updateNoticeLine({ ...defaultPolicy }, { fetch: failing, store, home })).resolves.toBeUndefined();
    const tail = await tailDaemonLog(50, home);
    expect(tail).toContain("update check failed");
    store.close();
  });

  it("falls back to a JSON file in the Headroom home when the daemon_state table cannot be reached (no store opened for it)", async () => {
    // A home path that is itself a regular file, not a directory: HeadroomStore.open()
    // cannot create or open a database there, so updateNoticeLine must fall back to a
    // plain file-based cache instead of throwing.
    const root = await mkdtemp(join(tmpdir(), "headroom-update-fallback-"));
    temporary.push(root);
    const home = join(root, "not-a-directory");
    await writeFile(home, "not a directory");
    const { fetch: fake } = countingFetch(() => json({ version: "999.0.0" }));
    await expect(updateNoticeLine({ ...defaultPolicy }, { fetch: fake, home })).resolves.toBe("headroomd 999.0.0 is available; run: headroom update");
  });
});
