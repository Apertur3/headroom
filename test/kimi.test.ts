import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isKimiCliCredential, kimiCliCredentialPath, kimiCodePlanName, kimiCreditsPath, kimiPlanName,
  kimiTokenExpired, kimiTokenPath, kimiWindowMinutes, observationFromMoonshotBalance,
  observationsFromKimiCodeUsage, observationsFromKimiUsage, observeKimi, readKimiCliCredential,
  readKimiToken,
} from "../src/adapters/kimi.js";
import { PROTECTED_STATUS_PATTERN } from "../src/collector.js";
import { allowedOutbound } from "../src/security.js";
import { discoverAccounts } from "../src/registry.js";
import type { Observation, ProviderAccount } from "../src/types.js";

const posix = process.platform !== "win32";
const kimi = { name: "kimi", vendor: "kimi", location: "/Users/test/.kimi/auth.token", adapter: "native-ts" } as const;
const at = new Date("2026-09-06T12:00:00Z");

// Every fixture under test/fixtures/kimi is synthetic and labelled as such in
// its own `_fixture` field: hand-written from the endpoint contract, never a
// live capture, so no real token, account or balance is in the repository.
const fixture = async (name: string): Promise<unknown> => JSON.parse(await readFile(new URL(`./fixtures/kimi/${name}.synthetic.json`, import.meta.url), "utf8"));

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function tokenFile(contents: string, mode = 0o600, name = "auth.token"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-kimi-"));
  temporary.push(root);
  const path = join(root, name);
  await writeFile(path, contents, "utf8");
  await chmod(path, mode);
  return path;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers each gateway path from the synthetic fixtures and records every
 * request the adapter made, so a test can assert on hosts and headers. */
function gateway(bodies: Record<string, unknown>, status: Record<string, number> = {}): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetcher = (async (input: Request | string | URL): Promise<Response> => {
    const request = input as Request;
    requests.push(request);
    const key = [...Object.keys(bodies)].find((name) => request.url.includes(name)) ?? "";
    return json(bodies[key] ?? {}, status[key] ?? 200);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, requests };
}

describe("Kimi response mapping (synthetic fixtures)", () => {
  it("maps the allowance, the rate-limit window, the shared pool and the plan", async () => {
    const rows = observationsFromKimiUsage(await fixture("usages"), await fixture("subscription-stats"), await fixture("subscription"), kimi, at);
    const main = rows.filter((row) => row.meter_id === "kimi:main");
    expect(main).toEqual(expect.arrayContaining([
      // 640/2000 requests over the vendor's 7-day allowance period.
      expect.objectContaining({ window: expect.objectContaining({ kind: "fixed", minutes: 10_080 }), quantity: expect.objectContaining({ used: 32, unit: "percent" }), resets_at: "2026-09-10T00:00:00.000Z", freshness: "fresh", truth: "official", source: "native:kimi" }),
      // 50/200 requests over the 5-hour window the response itself declares.
      expect.objectContaining({ window: expect.objectContaining({ kind: "fixed", minutes: 300 }), quantity: expect.objectContaining({ used: 25 }), resets_at: "2026-09-06T18:00:00.000Z" }),
    ]));
    expect(rows.find((row) => row.meter_id === "kimi:total")).toMatchObject({
      quantity: { used: 41.25, limit: 100, remaining: 58.75, unit: "percent" },
      window: { kind: "fixed", minutes: null, enforcement: "hard" },
      resets_at: "2026-10-01T00:00:00.000Z", freshness: "fresh",
    });
    // The membership 7-day Code ratio genuinely diverges here (90% vs 32%).
    expect(rows.find((row) => row.meter_id === "kimi:code-7d")).toMatchObject({ quantity: expect.objectContaining({ used: 90 }), window: expect.objectContaining({ minutes: 10_080 }) });
    expect(rows.every((row) => row.metadata?.plan === "Allegro")).toBe(true);
    expect(rows.every((row) => row.adapter_version === "native-ts" && row.principal_id === "kimi")).toBe(true);
  });

  it("drops the membership 7-day row when it only duplicates the allowance lane", async () => {
    const stats = { subscriptionBalance: { amountUsedRatio: 0.1, expireTime: "2026-10-01T00:00:00Z" }, ratelimitCode7d: { ratio: 0.32, enabled: true, resetTime: "2026-09-10T00:02:00Z" } };
    const rows = observationsFromKimiUsage(await fixture("usages"), stats, undefined, kimi, at);
    expect(rows.some((row) => row.meter_id === "kimi:code-7d")).toBe(false);
    // A disabled membership limit is not a reading either.
    const disabled = observationsFromKimiUsage(await fixture("usages"), { ratelimitCode7d: { ratio: 0.9, enabled: false } }, undefined, kimi, at);
    expect(disabled.some((row) => row.meter_id === "kimi:code-7d")).toBe(false);
  });

  it("falls back to remaining, and fails rather than reporting an invented 0% when no counter is usable", () => {
    const fromRemaining = observationsFromKimiUsage({ usages: [{ scope: "FEATURE_CODING", detail: { limit: "100", remaining: "25" } }] }, undefined, undefined, kimi, at);
    expect(fromRemaining.find((row) => row.meter_id === "kimi:main")).toMatchObject({ quantity: expect.objectContaining({ used: 75 }), window: expect.objectContaining({ kind: "rolling" }) });
    const unusable = observationsFromKimiUsage({ usages: [{ scope: "FEATURE_CODING", detail: { limit: "100", used: "not-a-number" } }] }, undefined, undefined, kimi, at);
    expect(unusable.find((row) => row.meter_id === "kimi:main")).toMatchObject({ freshness: "failed", truth: "estimated", confidence: 0, quantity: null, reason: "vendor returned no usable allowance counters" });
    // The shared pool is its own meter: absent stats fail it instead of
    // letting the last good value go quietly stale.
    expect(unusable.find((row) => row.meter_id === "kimi:total")).toMatchObject({ freshness: "failed", reason: "vendor returned no subscription balance" });
  });

  it("takes window kind and minutes from the response, and skips a bucket whose window it cannot read", () => {
    expect(kimiWindowMinutes({ duration: 5, timeUnit: "TIME_UNIT_HOUR" })).toBe(300);
    expect(kimiWindowMinutes({ duration: 30, timeUnit: "TIME_UNIT_MINUTE" })).toBe(30);
    expect(kimiWindowMinutes({ duration: 7, timeUnit: "TIME_UNIT_DAY" })).toBe(10_080);
    expect(kimiWindowMinutes({ duration: 1, timeUnit: "TIME_UNIT_FORTNIGHT" })).toBeUndefined();
    const rows = observationsFromKimiUsage({ usages: [{ scope: "FEATURE_CODING", detail: { limit: "10", used: "1" }, limits: [{ window: { duration: 1, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { limit: "10", used: "5" } }] }] }, undefined, undefined, kimi, at);
    expect(rows.filter((row) => row.meter_id === "kimi:main")).toHaveLength(1);
  });

  it("names a plan only for an active subscription, and rejects a response with no coding scope", () => {
    expect(kimiPlanName({ subscription: { active: true, status: "SUBSCRIPTION_STATUS_ACTIVE", goods: { title: "Moderato" } } })).toBe("Moderato");
    expect(kimiPlanName({ subscription: { active: false, status: "SUBSCRIPTION_STATUS_ACTIVE", goods: { title: "Moderato" } } })).toBeUndefined();
    expect(kimiPlanName({ subscription: { active: true, status: "SUBSCRIPTION_STATUS_EXPIRED", goods: { title: "Moderato" } } })).toBeUndefined();
    expect(() => observationsFromKimiUsage({ usages: [{ scope: "FEATURE_CHAT", detail: { limit: "1" } }] }, undefined, undefined, kimi, at)).toThrow(/FEATURE_CODING/);
  });

  it("reads the Moonshot platform balance as an informational credits meter", async () => {
    expect(observationFromMoonshotBalance(await fixture("moonshot-balance"), kimi, at)).toMatchObject({
      meter_id: "kimi:credits", source: "native:kimi:moonshot", freshness: "fresh",
      window: { kind: "count", minutes: null, enforcement: "hard" },
      quantity: { used: 0, limit: null, remaining: 12.5, unit: "credits" },
    });
    expect(observationFromMoonshotBalance({ code: 1, scode: "0x1", status: false }, kimi, at)).toMatchObject({ freshness: "failed", quantity: null });
  });
});

describe("Kimi token file", () => {
  it("reads a 0600 regular file holding only the token", async () => {
    const path = await tokenFile("  synthetic-token-value\n");
    expect(await readKimiToken(path)).toBe("synthetic-token-value");
  });

  it("refuses a file that is not the bare token, and a symlink", async () => {
    await expect(readKimiToken(await tokenFile('{"token": "synthetic"}'))).rejects.toThrow(/only the token/);
    await expect(readKimiToken(await tokenFile(""))).rejects.toThrow(/only the token/);
    const real = await tokenFile("synthetic-token-value");
    const link = `${real}.link`;
    await symlink(real, link);
    await expect(readKimiToken(link)).rejects.toThrow(/regular file/);
  });

  it.skipIf(!posix)("refuses a token file anyone but its owner can read", async () => {
    await expect(readKimiToken(await tokenFile("synthetic-token-value", 0o644))).rejects.toThrow(/group or other/);
  });

  it("detects an expired JWT without spending a request, and tolerates an opaque token", () => {
    const jwt = (exp: number): string => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");
    expect(kimiTokenExpired(jwt(Math.floor(at.getTime() / 1000) - 60), at)).toBe(true);
    expect(kimiTokenExpired(jwt(Math.floor(at.getTime() / 1000) + 3600), at)).toBe(false);
    expect(kimiTokenExpired("synthetic-opaque-token", at)).toBe(false);
    expect(kimiTokenExpired("not.a.jwt", at)).toBe(false);
  });

  it("defaults to ~/.kimi/auth.token and puts the optional Moonshot key beside it", () => {
    expect(kimiTokenPath(undefined, "/Users/test")).toBe(join("/Users/test", ".kimi", "auth.token"));
    expect(kimiTokenPath("/elsewhere/kimi.token", "/Users/test")).toBe("/elsewhere/kimi.token");
    expect(kimiCreditsPath("/elsewhere/kimi.token")).toBe(join("/elsewhere", "moonshot.key"));
  });
});

describe("observeKimi", () => {
  async function account(contents = "synthetic-opaque-token", mode = 0o600): Promise<ProviderAccount> {
    return { name: "kimi", vendor: "kimi", location: await tokenFile(contents, mode), adapter: "native-ts" };
  }

  it("calls only allowlisted hosts, sends the token, and never leaks it into an observation", async () => {
    const target = await account();
    const { fetch: fetcher, requests } = gateway({
      GetUsages: await fixture("usages"),
      GetSubscriptionStats: await fixture("subscription-stats"),
      GetSubscription: await fixture("subscription"),
    });
    const rows = await observeKimi(target, { fetch: fetcher, now: () => at });
    expect(requests.map((request) => new URL(request.url).hostname)).toEqual(["www.kimi.com", "www.kimi.com", "www.kimi.com"]);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-opaque-token");
      expect(() => allowedOutbound(request.url)).not.toThrow();
    }
    expect(rows.filter((row) => row.freshness === "fresh").length).toBeGreaterThan(0);
    // Token canary: the credential is used and then dropped -- it appears in
    // no meter id, reason, metadata or any other serialized field.
    expect(JSON.stringify(rows)).not.toContain("synthetic-opaque-token");
    // No Moonshot key beside the token file, so no credits meter at all.
    expect(rows.some((row) => row.meter_id === "kimi:credits")).toBe(false);
  });

  it("fails with the vendor's own login step on 401, and routes 403/429 through the protected-status backoff", async () => {
    const target = await account();
    for (const status of [401, 403, 429]) {
      const { fetch: fetcher } = gateway({ GetUsages: {} }, { GetUsages: status });
      const rows = await observeKimi(target, { fetch: fetcher, now: () => at });
      expect(rows.map((row) => row.meter_id).sort()).toEqual(["kimi:main", "kimi:total"]);
      expect(rows.every((row) => row.freshness === "failed" && row.truth === "estimated" && row.confidence === 0)).toBe(true);
      expect(PROTECTED_STATUS_PATTERN.test(rows[0].reason ?? "")).toBe(true);
      if (status !== 429) expect(rows[0].reason).toContain("sign in at https://www.kimi.com/code/console");
      expect(JSON.stringify(rows)).not.toContain("synthetic-opaque-token");
    }
  });

  it("refuses a redirect instead of following the token to another host", async () => {
    const target = await account();
    const fetcher = (async () => new Response("", { status: 302, headers: { location: "https://example.invalid/steal" } })) as unknown as typeof fetch;
    const rows = await observeKimi(target, { fetch: fetcher, now: () => at });
    expect(rows[0]).toMatchObject({ freshness: "failed", reason: "redirect refused" });
  });

  it("never calls the vendor for a missing or expired credential", async () => {
    let called = 0;
    const fetcher = (async () => { called += 1; return json({}); }) as unknown as typeof fetch;
    const missing = await observeKimi({ ...kimi, location: join(tmpdir(), "headroom-kimi-absent", "auth.token") }, { fetch: fetcher, now: () => at });
    expect(missing[0].reason).toMatch(/no Kimi token file .*; sign in at https:\/\/www\.kimi\.com\/code\/console/);
    const expired = ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(at.getTime() / 1000) - 60 })).toString("base64url"), "sig"].join(".");
    const rows = await observeKimi(await account(expired), { fetch: fetcher, now: () => at });
    expect(rows[0].reason).toMatch(/^Kimi token expired; sign in at https:\/\/www\.kimi\.com\/code\/console/);
    expect(called).toBe(0);
  });

  it("adds the credits meter only when a Moonshot key file sits beside the token", async () => {
    const target = await account();
    const keyPath = kimiCreditsPath(target.location);
    await writeFile(keyPath, "synthetic-moonshot-key\n", "utf8");
    await chmod(keyPath, 0o600);
    const { fetch: fetcher, requests } = gateway({
      GetUsages: await fixture("usages"),
      GetSubscriptionStats: await fixture("subscription-stats"),
      GetSubscription: await fixture("subscription"),
      balance: await fixture("moonshot-balance"),
    });
    const rows = await observeKimi(target, { fetch: fetcher, now: () => at });
    expect(requests.map((request) => new URL(request.url).hostname)).toContain("api.moonshot.ai");
    expect(rows.find((row) => row.meter_id === "kimi:credits")).toMatchObject({ freshness: "fresh", quantity: expect.objectContaining({ remaining: 12.5, unit: "credits" }) });
    expect(JSON.stringify(rows)).not.toContain("synthetic-moonshot-key");
  });

  it("keeps a failed credits read from taking the subscription read down with it", async () => {
    const target = await account();
    const keyPath = kimiCreditsPath(target.location);
    await writeFile(keyPath, "synthetic-moonshot-key\n", "utf8");
    await chmod(keyPath, 0o600);
    const { fetch: fetcher } = gateway({
      GetUsages: await fixture("usages"),
      GetSubscriptionStats: await fixture("subscription-stats"),
      GetSubscription: await fixture("subscription"),
      balance: {},
    }, { balance: 401 });
    const rows = await observeKimi(target, { fetch: fetcher, now: () => at });
    expect(rows.find((row) => row.meter_id === "kimi:main")).toMatchObject({ freshness: "fresh" });
    expect(rows.find((row) => row.meter_id === "kimi:credits")).toMatchObject({ freshness: "failed", reason: expect.stringContaining("Moonshot rejected the API key (401)") });
  });

  it("still reports the allowance when the optional membership calls fail", async () => {
    const target = await account();
    const { fetch: fetcher } = gateway({ GetUsages: await fixture("usages"), GetSubscriptionStats: {}, GetSubscription: {} }, { GetSubscriptionStats: 500, GetSubscription: 500 });
    const rows = await observeKimi(target, { fetch: fetcher, now: () => at });
    expect(rows.find((row) => row.meter_id === "kimi:main")).toMatchObject({ freshness: "fresh", quantity: expect.objectContaining({ used: 32 }) });
    expect(rows.find((row) => row.meter_id === "kimi:total")).toMatchObject({ freshness: "failed" });
    expect(rows.every((row) => row.metadata === undefined)).toBe(true);
  });
});

describe("Kimi discovery and outbound allowlist", () => {
  it("adds a kimi principal when the token file exists in a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-kimi-home-"));
    temporary.push(home);
    expect((await discoverAccounts(home, { PATH: "" })).some((item) => item.name === "kimi")).toBe(false);
    await mkdir(join(home, ".kimi"));
    await writeFile(join(home, ".kimi", "auth.token"), "synthetic-opaque-token", "utf8");
    expect(await discoverAccounts(home, { PATH: "" })).toContainEqual(expect.objectContaining({
      name: "kimi", vendor: "kimi", adapter: "native-ts", location: join(home, ".kimi", "auth.token"),
    }));
  });

  it("allows the gateway and the balance host, and nothing else Kimi-shaped", () => {
    expect(() => allowedOutbound("https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages")).not.toThrow();
    expect(() => allowedOutbound("https://api.moonshot.ai/v1/users/me/balance")).not.toThrow();
    expect(() => allowedOutbound("https://kimi.com/apiv2/x")).toThrow(/not allowed/);
    expect(() => allowedOutbound("https://api.moonshot.cn/v1/users/me/balance")).toThrow(/not allowed/);
  });
});

describe("Kimi Code CLI credential source", () => {
  const seconds = (offset: number): number => Math.floor(at.getTime() / 1000) + offset;

  /** Writes a `~/.kimi-code`-shaped tree under a temporary home and returns
   * that home plus the credential path inside it. */
  async function cliHome(body: unknown, mode = 0o600): Promise<{ home: string; path: string }> {
    const home = await mkdtemp(join(tmpdir(), "headroom-kimi-cli-"));
    temporary.push(home);
    const path = kimiCliCredentialPath(home, {});
    await mkdir(join(home, ".kimi-code", "credentials"), { recursive: true });
    await writeFile(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
    await chmod(path, mode);
    return { home, path };
  }

  const credential = (expires: number | undefined = seconds(3600)): Record<string, unknown> => ({
    access_token: "synthetic-cli-access-token",
    refresh_token: "synthetic-cli-refresh-token",
    ...(expires === undefined ? {} : { expires_at: expires }),
  });

  const cliAccount = (path: string): ProviderAccount => ({ name: "kimi", vendor: "kimi", location: path, adapter: "native-ts" });

  it("maps the CLI usages response onto the meters the gateway path already emits", async () => {
    const rows = observationsFromKimiCodeUsage(await fixture("code-usages"), kimi, at);
    expect(rows.map((row) => row.meter_id)).toEqual(["kimi:main", "kimi:main"]);
    expect(rows).toEqual(expect.arrayContaining([
      // 512/2048 requests over the vendor's documented 7-day allowance period,
      // which this response declares no window of its own for.
      expect.objectContaining({ window: expect.objectContaining({ kind: "fixed", minutes: 10_080 }), quantity: expect.objectContaining({ used: 25, limit: 100, unit: "percent" }), resets_at: "2026-09-10T00:00:00.000Z", freshness: "fresh", truth: "official", source: "native:kimi" }),
      // 50/200 requests over the 5-hour window the response does declare.
      expect.objectContaining({ window: expect.objectContaining({ kind: "fixed", minutes: 300 }), quantity: expect.objectContaining({ used: 25 }), resets_at: "2026-09-06T18:00:00.000Z" }),
    ]));
    // The CLI endpoint reports no shared pool and no membership 7-day ratio.
    expect(rows.some((row) => row.meter_id === "kimi:total" || row.meter_id === "kimi:code-7d")).toBe(false);
    // The plan comes from the response's own membership level, no web call.
    expect(rows.every((row) => row.metadata?.plan === "Allegro")).toBe(true);
  });

  it("reads the plan level, skips an unreadable bucket, and fails rather than inventing 0%", () => {
    expect(kimiCodePlanName({ user: { membership: { level: "LEVEL_BASIC" } }, version: "GOODS_VERSION_V1" })).toBe("Moderato");
    // An unknown level, and an unknown catalog version, keep the vendor's own spelling.
    expect(kimiCodePlanName({ user: { membership: { level: "LEVEL_FUTURE" } } })).toBe("LEVEL_FUTURE");
    expect(kimiCodePlanName({ user: { membership: { level: "LEVEL_ADVANCED" } }, version: "GOODS_VERSION_FUTURE" })).toBe("LEVEL_ADVANCED");
    expect(kimiCodePlanName({ user: { membership: { level: "LEVEL_UNSPECIFIED" } } })).toBeUndefined();
    const rows = observationsFromKimiCodeUsage({ usage: { limit: "100", used: "not-a-number" }, limits: [{ window: { duration: 1, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { limit: "10", used: "5" } }] }, kimi, at);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ freshness: "failed", truth: "estimated", confidence: 0, quantity: null, reason: "vendor returned no usable allowance counters" });
    expect(() => observationsFromKimiCodeUsage({ limits: [] }, kimi, at)).toThrow(/Kimi usage response invalid/);
  });

  it("gives a bucket the response names for itself its own meter", () => {
    // Forward compatibility: the shape seen today carries only unnamed
    // rate-limit windows, which share `main`.
    const rows = observationsFromKimiCodeUsage({ usage: { limit: "100", used: "10" }, limits: [{ scope: "FEATURE_OPUS_LANE", window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "40", used: "10" } }] }, kimi, at);
    expect(rows.map((row) => row.meter_id)).toEqual(["kimi:main", "kimi:feature-opus-lane"]);
    expect(rows[1]).toMatchObject({ window: expect.objectContaining({ minutes: 1440 }), quantity: expect.objectContaining({ used: 25 }) });
  });

  it("calls only the CLI endpoint, sends the access token, and never leaks either token", async () => {
    const { home, path } = await cliHome(credential());
    const { fetch: fetcher, requests } = gateway({ "coding/v1/usages": await fixture("code-usages") });
    const rows = await observeKimi(cliAccount(path), { fetch: fetcher, now: () => at, home });
    expect(requests.map((request) => new URL(request.url).hostname)).toEqual(["api.kimi.com"]);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.get("authorization")).toBe("Bearer synthetic-cli-access-token");
    expect(requests[0].headers.get("x-msh-platform")).toBe("kimi_code_cli");
    // No machine identity travels with the request, and no cookie is involved.
    expect(requests[0].headers.get("cookie")).toBeNull();
    expect(requests[0].headers.get("x-msh-device-id")).toBeNull();
    expect(() => allowedOutbound(requests[0].url)).not.toThrow();
    expect(rows.every((row) => row.freshness === "fresh")).toBe(true);
    // Token canary: neither the access token nor the refresh token appears in
    // any meter id, reason, metadata or other serialized field.
    expect(JSON.stringify(rows)).not.toContain("synthetic-cli-access-token");
    expect(JSON.stringify(rows)).not.toContain("synthetic-cli-refresh-token");
  });

  it("never calls the vendor for an expired, missing or unusable CLI credential", async () => {
    let called = 0;
    const fetcher = (async () => { called += 1; return json({}); }) as unknown as typeof fetch;
    const expired = await cliHome(credential(seconds(-60)));
    const rows = await observeKimi(cliAccount(expired.path), { fetch: fetcher, now: () => at, home: expired.home });
    expect(rows.map((row) => row.meter_id)).toEqual(["kimi:main"]);
    expect(rows[0]).toMatchObject({ freshness: "failed", truth: "estimated", confidence: 0, quantity: null });
    expect(rows[0].reason).toBe("Kimi CLI credential expired; run: kimi login (Headroom never refreshes it)");
    // A credential that expires inside the grace window is already expired.
    const expiring = await cliHome(credential(seconds(30)));
    expect((await observeKimi(cliAccount(expiring.path), { fetch: fetcher, now: () => at, home: expiring.home }))[0].reason).toContain("run: kimi login");
    // No recorded expiry: the token's own JWT expiry still decides.
    const jwt = ["e30", Buffer.from(JSON.stringify({ exp: seconds(-60) })).toString("base64url"), "sig"].join(".");
    const stale = await cliHome({ access_token: jwt, refresh_token: "synthetic-cli-refresh-token" });
    expect((await observeKimi(cliAccount(stale.path), { fetch: fetcher, now: () => at, home: stale.home }))[0].reason).toContain("run: kimi login");
    const absent = join(tmpdir(), "headroom-kimi-absent", "credentials", "kimi-code.json");
    const missing = await observeKimi(cliAccount(absent), { fetch: fetcher, now: () => at, home: tmpdir() });
    expect(missing[0].reason).toMatch(/^no Kimi CLI credential .*; run: kimi login$/);
    expect(called).toBe(0);
  });

  it("refuses a CLI credential anyone else can read, or one that is not the CLI's own shape", async () => {
    const { path } = await cliHome({ refresh_token: "synthetic-cli-refresh-token" });
    await expect(readKimiCliCredential(path)).rejects.toThrow(/no access token/);
    const broken = await cliHome("{not-json");
    await expect(readKimiCliCredential(broken.path)).rejects.toThrow(/not valid JSON/);
    const good = await cliHome(credential());
    expect(await readKimiCliCredential(good.path)).toEqual({ token: "synthetic-cli-access-token", expires_at: seconds(3600) * 1000 });
    if (posix) {
      const shared = await cliHome(credential(), 0o644);
      await expect(readKimiCliCredential(shared.path)).rejects.toThrow(/group or other/);
      const rows = await observeKimi(cliAccount(shared.path), { now: () => at, home: shared.home });
      expect(rows[0].reason).toMatch(/readable by group or other .*; chmod 600 that file, or run: kimi login/);
    }
  });

  it("names the CLI's login command on 401, backs off on 403 and 429, and refuses a redirect", async () => {
    const { home, path } = await cliHome(credential());
    for (const status of [401, 403, 429]) {
      const { fetch: fetcher } = gateway({ "coding/v1/usages": {} }, { "coding/v1/usages": status });
      const rows = await observeKimi(cliAccount(path), { fetch: fetcher, now: () => at, home });
      expect(rows.map((row) => row.meter_id)).toEqual(["kimi:main"]);
      expect(PROTECTED_STATUS_PATTERN.test(rows[0].reason ?? "")).toBe(true);
      if (status !== 429) expect(rows[0].reason).toBe(`Kimi rejected the CLI credential (${status}); run: kimi login`);
      expect(JSON.stringify(rows)).not.toContain("synthetic-cli-access-token");
    }
    const redirect = (async () => new Response("", { status: 302, headers: { location: "https://example.invalid/steal" } })) as unknown as typeof fetch;
    expect((await observeKimi(cliAccount(path), { fetch: redirect, now: () => at, home }))[0]).toMatchObject({ freshness: "failed", reason: "redirect refused" });
  });

  it("prefers the CLI credential over the manual token file, and allows only the CLI host", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-kimi-both-"));
    temporary.push(home);
    await mkdir(join(home, ".kimi"));
    await writeFile(join(home, ".kimi", "auth.token"), "synthetic-opaque-token", "utf8");
    expect(await discoverAccounts(home, { PATH: "" })).toContainEqual(expect.objectContaining({ name: "kimi", location: join(home, ".kimi", "auth.token") }));
    await mkdir(join(home, ".kimi-code", "credentials"), { recursive: true });
    await writeFile(kimiCliCredentialPath(home, {}), JSON.stringify(credential()), "utf8");
    const discovered = (await discoverAccounts(home, { PATH: "" })).filter((item) => item.name === "kimi");
    // One kimi principal, pointing at the preferred source.
    expect(discovered).toEqual([expect.objectContaining({ name: "kimi", vendor: "kimi", adapter: "native-ts", location: kimiCliCredentialPath(home, {}) })]);
    expect(isKimiCliCredential(kimiCliCredentialPath(home, {}))).toBe(true);
    expect(isKimiCliCredential(join(home, ".kimi", "auth.token"))).toBe(false);
    expect(kimiCliCredentialPath("/Users/test", { KIMI_CODE_HOME: "/elsewhere/kimi-code" })).toBe(join("/elsewhere/kimi-code", "credentials", "kimi-code.json"));
    expect(() => allowedOutbound("https://api.kimi.com/coding/v1/usages")).not.toThrow();
    expect(() => allowedOutbound("https://api.kimi.cn/coding/v1/usages")).toThrow(/not allowed/);
  });
});

describe("collector dispatch", () => {
  it("polls a kimi principal from accounts.toml through the Kimi adapter", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-kimi-collector-"));
    temporary.push(home);
    // The token file is deliberately absent, so the poll proves dispatch
    // without ever making a vendor request.
    await writeFile(join(home, "accounts.toml"), [
      "[[accounts]]", 'name = "kimi"', 'vendor = "kimi"',
      `location = ${JSON.stringify(join(home, "auth.token"))}`, 'adapter = "native-ts"', "",
    ].join("\n"), "utf8");
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try {
      const { pollAccounts } = await import("../src/collector.js");
      const result = await pollAccounts("kimi");
      const rows: Observation[] = result.observations;
      expect(rows.map((row) => row.meter_id).sort()).toEqual(["kimi:main", "kimi:total"]);
      expect(rows.every((row) => row.source === "native:kimi" && row.freshness === "failed")).toBe(true);
      expect(rows[0].reason).toContain("no Kimi token file");
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });
});
