import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROK_BILLING_ENDPOINT, GROK_SETTINGS_ENDPOINT, grokAuthPath, grokLoginCommand, grokPlanName,
  grokWindowMinutes, observationsFromGrokBilling, observeGrok, parseGrokCredential,
} from "../src/adapters/grok.js";
import { PROTECTED_STATUS_PATTERN } from "../src/collector.js";
import { pollAccounts } from "../src/collector.js";
import { discoverAccounts } from "../src/registry.js";
import { allowedOutbound } from "../src/security.js";
import type { ProviderAccount } from "../src/types.js";

const grok = { name: "grok", vendor: "grok", location: "/Users/test/.grok", adapter: "native-ts" } as const satisfies ProviderAccount;
const at = new Date("2026-09-03T17:26:36Z");
// Same reasoning as native-adapters.test.ts: build the expected GROK_HOME
// wording through resolve() so the assertion holds on Windows too.
const grok2Dir = resolve("/Users/test/.grok2");
// observeGrok() builds its hint against the real home directory, so a fixture
// path always renders the explicit GROK_HOME form; only grokLoginCommand's own
// unit test can pass a home and see the plain "run: grok login" wording.
const grokDir = resolve("/Users/test/.grok");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/grok/${name}`, import.meta.url), "utf8"));
}

async function authFixture(): Promise<string> {
  return readFile(new URL("./fixtures/grok/auth.synthetic.json", import.meta.url), "utf8");
}

describe("Grok credential file", () => {
  it("prefers the OIDC scope entry and reports a live token", async () => {
    expect(parseGrokCredential(await authFixture(), at)).toEqual({ token: "synthetic-oidc-value-not-a-real-credential", expired: false });
  });

  it("falls back to the legacy sign-in scope, and skips an entry carrying no key", () => {
    const legacyOnly = JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "legacy-value" } });
    expect(parseGrokCredential(legacyOnly, at).token).toBe("legacy-value");
    const staleOidc = JSON.stringify({ "https://auth.x.ai::client": { key: "" }, "https://accounts.x.ai/sign-in": { key: "legacy-value" } });
    expect(parseGrokCredential(staleOidc, at).token).toBe("legacy-value");
  });

  it("marks a past expiry expired and rejects a body with no usable entry", () => {
    const expired = JSON.stringify({ "https://auth.x.ai::client": { key: "value", expires_at: "2026-09-03T17:26:35Z" } });
    expect(parseGrokCredential(expired, at).expired).toBe(true);
    expect(() => parseGrokCredential("{}", at)).toThrow("Grok auth invalid");
    expect(() => parseGrokCredential("not json", at)).toThrow("Grok auth invalid");
  });

  it("accepts a location naming either the token file or the directory holding it", () => {
    expect(grokAuthPath("/Users/test/.grok", "/Users/test")).toBe(join("/Users/test/.grok", "auth.json"));
    expect(grokAuthPath("/Users/test/.grok/auth.json", "/Users/test")).toBe("/Users/test/.grok/auth.json");
    expect(grokAuthPath(undefined, "/Users/test")).toBe(join("/Users/test", ".grok", "auth.json"));
  });

  it("names GROK_HOME only for a non-default location", () => {
    expect(grokLoginCommand(grok, "/Users/test")).toBe("run: grok login");
    expect(grokLoginCommand({ ...grok, location: "/Users/test/.grok2" }, "/Users/test")).toBe(`run: GROK_HOME=${grok2Dir} grok login`);
  });
});

describe("Grok billing parsing", () => {
  it("maps the weekly allowance onto a percent meter with the published window and reset", async () => {
    const rows = observationsFromGrokBilling(await fixture("billing-weekly.synthetic.json"), await fixture("settings.synthetic.json"), grok, at);
    expect(rows).toContainEqual(expect.objectContaining({
      meter_id: "grok:main", source: "native:grok", truth: "official", freshness: "fresh", confidence: 1,
      window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
      quantity: { used: 12.5, limit: 100, remaining: 87.5, unit: "percent" },
      resets_at: "2026-09-07T00:00:00.000Z",
      metadata: { plan: "SuperGrok Heavy" },
    }));
  });

  it("reports the on-demand balance as an informational credits meter", async () => {
    const rows = observationsFromGrokBilling(await fixture("billing-weekly.synthetic.json"), undefined, grok, at);
    expect(rows).toContainEqual(expect.objectContaining({
      meter_id: "grok:credits", freshness: "fresh",
      window: { kind: "count", minutes: null, enforcement: "hard" },
      quantity: { used: 250, limit: 1000, remaining: 750, unit: "credits" },
    }));
    // The plan name lives on the settings endpoint; the billing tier is the fallback.
    expect(rows[0].metadata).toEqual({ plan: "SuperGrok" });
  });

  it("derives the percent from the on-demand cap when the vendor publishes no percentage", async () => {
    const rows = observationsFromGrokBilling(await fixture("billing-credits-only.synthetic.json"), undefined, grok, at);
    const main = rows.find((row) => row.meter_id === "grok:main");
    expect(main).toMatchObject({ freshness: "fresh", quantity: { used: 25.05, limit: 100, remaining: 74.95, unit: "percent" }, resets_at: null });
    expect(main?.window).toEqual({ kind: "rolling", minutes: null, enforcement: "hard" });
    expect(rows.some((row) => row.meter_id === "grok:credits")).toBe(true);
  });

  it("treats a billing period with no usage figure as unknown, not as zero used", async () => {
    const rows = observationsFromGrokBilling(await fixture("billing-period-only.synthetic.json"), undefined, grok, at);
    expect(rows).toEqual([expect.objectContaining({
      meter_id: "grok:main", freshness: "failed", truth: "estimated", confidence: 0,
      quantity: null, resets_at: "2026-09-30T00:00:00.000Z", reason: "vendor returned no usage percentage",
    })]);
  });

  it("clamps a percentage the vendor reports outside 0-100", () => {
    const over = observationsFromGrokBilling({ config: { creditUsagePercent: 104.2 } }, undefined, grok, at);
    const under = observationsFromGrokBilling({ config: { creditUsagePercent: -3.5 } }, undefined, grok, at);
    expect(over[0].quantity?.used).toBe(100);
    expect(under[0].quantity?.used).toBe(0);
  });

  it("measures the window from the published period, never from the time left until reset", () => {
    expect(grokWindowMinutes({ start: "2026-08-31T00:00:00Z", end: "2026-09-07T00:00:00Z" })).toBe(10_080);
    expect(grokWindowMinutes({ type: "USAGE_PERIOD_TYPE_DAILY" })).toBe(1440);
    expect(grokWindowMinutes({ type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-09-30T00:00:00Z" })).toBeNull();
    expect(grokWindowMinutes(undefined)).toBeNull();
  });

  it("normalizes the two consumer plan labels and keeps anything else verbatim", () => {
    expect(grokPlanName("SUPERGROK_HEAVY")).toBe("SuperGrok Heavy");
    expect(grokPlanName("supergrok")).toBe("SuperGrok");
    expect(grokPlanName("Enterprise Trial")).toBe("Enterprise Trial");
    expect(grokPlanName("  ")).toBeNull();
  });

  it("rejects a body with no billing config at all", () => {
    expect(() => observationsFromGrokBilling({}, undefined, grok, at)).toThrow("Grok billing response invalid");
  });
});

describe("observeGrok", () => {
  it("calls both CLI-proxy endpoints with the CLI's own bearer headers", async () => {
    const requests: Request[] = [];
    const rows = await observeGrok(grok, {
      now: () => at,
      readFile: authFixture,
      fetch: async (input) => {
        const request = input as Request;
        requests.push(request);
        const body = request.url === GROK_SETTINGS_ENDPOINT
          ? await readFile(new URL("./fixtures/grok/settings.synthetic.json", import.meta.url), "utf8")
          : await readFile(new URL("./fixtures/grok/billing-weekly.synthetic.json", import.meta.url), "utf8");
        return new Response(body, { status: 200 });
      },
    });
    expect(requests.map((request) => request.url).sort()).toEqual([GROK_BILLING_ENDPOINT, GROK_SETTINGS_ENDPOINT].sort());
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-oidc-value-not-a-real-credential");
      expect(request.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
      expect(request.headers.get("accept")).toBe("application/json");
    }
    expect(rows.find((row) => row.meter_id === "grok:main")).toMatchObject({ freshness: "fresh", metadata: { plan: "SuperGrok Heavy" } });
  });

  it("keeps the usage reading when the optional settings call fails", async () => {
    const rows = await observeGrok(grok, {
      now: () => at,
      readFile: authFixture,
      fetch: async (input) => (input as Request).url === GROK_SETTINGS_ENDPOINT
        ? new Response("{}", { status: 500 })
        : new Response(await readFile(new URL("./fixtures/grok/billing-weekly.synthetic.json", import.meta.url), "utf8"), { status: 200 }),
    });
    expect(rows.find((row) => row.meter_id === "grok:main")).toMatchObject({ freshness: "fresh", metadata: { plan: "SuperGrok" } });
  });

  it("names the login command for a 401, and keeps the status for a 403 so the collector backs off", async () => {
    const responses = async (status: number) => observeGrok({ ...grok, location: "/Users/test/.grok2" }, {
      now: () => at, readFile: authFixture, fetch: async () => new Response("{}", { status }),
    });
    const rejected401 = await responses(401);
    const rejected403 = await responses(403);
    const limited = await responses(429);
    expect(rejected401.every((row) => row.freshness === "failed" && row.confidence === 0)).toBe(true);
    expect(rejected401[0].reason).toBe(`Grok rejected the token; run: GROK_HOME=${grok2Dir} grok login`);
    expect(rejected403[0].reason).toBe(`Grok rejected the token (403); run: GROK_HOME=${grok2Dir} grok login`);
    expect(PROTECTED_STATUS_PATTERN.test(rejected403[0].reason ?? "")).toBe(true);
    expect(limited[0].reason).toBe("Grok usage request failed (429)");
    expect(PROTECTED_STATUS_PATTERN.test(limited[0].reason ?? "")).toBe(true);
  });

  it("reports an expired token and a missing credential file with the exact fix", async () => {
    const expired = await observeGrok(grok, {
      now: () => at,
      readFile: async () => JSON.stringify({ "https://auth.x.ai::client": { key: "value", expires_at: "2026-09-03T17:26:35Z" } }),
    });
    expect(expired[0].reason).toBe(`token expired; run: GROK_HOME=${grokDir} grok login`);
    const missing = await observeGrok(grok, { now: () => at, readFile: async () => { throw new Error("Grok auth unavailable"); } });
    expect(missing[0].reason).toBe(`no credentials for this config dir; run: GROK_HOME=${grokDir} grok login`);
    expect(missing.map((row) => row.meter_id)).toEqual(["grok:main", "grok:credits"]);
  });

  it("refuses a redirect off the allowlisted host instead of following it", async () => {
    const rows = await observeGrok(grok, {
      now: () => at, readFile: authFixture,
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://example.invalid/v1/billing" } }),
    });
    expect(rows.every((row) => row.freshness === "failed")).toBe(true);
    expect(rows[0].reason).toBe("Grok usage unavailable");
  });

  it("allows only the Grok CLI chat proxy through the outbound guard", () => {
    expect(() => allowedOutbound(GROK_BILLING_ENDPOINT)).not.toThrow();
    expect(() => allowedOutbound(GROK_SETTINGS_ENDPOINT)).not.toThrow();
    expect(() => allowedOutbound("https://grok.com/v1/billing")).toThrow("Outbound host is not allowed");
  });

  it("does not leak the token from auth.json through rows, reasons, or logs", async () => {
    const secret = "eyJ.fake-canary-token.never-log";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejectedFetch = async () => { throw new Error(secret); };
    const rows = await observeGrok(grok, {
      now: () => at,
      readFile: async () => JSON.stringify({ "https://auth.x.ai::client": { key: secret, expires_at: "2026-09-07T00:00:00Z" } }),
      fetch: rejectedFetch,
    });
    const output = JSON.stringify([rows, log.mock.calls]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("Bearer");
    log.mockRestore();
  });
});

describe("Grok discovery and collection", () => {
  it("adds a grok principal only once the CLI has written its token file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-grok-discover-")); temporary.push(root);
    expect(await discoverAccounts(root, { PATH: "" })).not.toContainEqual(expect.objectContaining({ vendor: "grok" }));
    await mkdir(join(root, ".grok"), { recursive: true });
    await writeFile(join(root, ".grok", "auth.json"), await authFixture(), { mode: 0o600 });
    expect(await discoverAccounts(root, { PATH: "" })).toContainEqual({ name: "grok", vendor: "grok", location: join(root, ".grok"), adapter: "native-ts" });
  });

  it("honors GROK_HOME when the CLI was pointed at another directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-grok-home-")); temporary.push(root);
    const custom = join(root, "grok-work");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, "auth.json"), await authFixture(), { mode: 0o600 });
    expect(await discoverAccounts(root, { PATH: "", GROK_HOME: custom })).toContainEqual(expect.objectContaining({ vendor: "grok", location: custom }));
  });

  it("dispatches a configured grok principal through the collector", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-grok-poll-")); temporary.push(root);
    const grokHome = join(root, ".grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(join(grokHome, "auth.json"), await authFixture(), { mode: 0o600 });
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "grok"', 'vendor = "grok"', `location = ${JSON.stringify(grokHome)}`, 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const billing = await readFile(new URL("./fixtures/grok/billing-weekly.synthetic.json", import.meta.url), "utf8");
    vi.stubGlobal("fetch", async (input: Request) => new Response(input.url === GROK_SETTINGS_ENDPOINT ? "{}" : billing, { status: 200 }));
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try {
      const result = await pollAccounts();
      expect(result.observations.map((row) => row.meter_id).sort()).toEqual(["grok:credits", "grok:main"]);
      expect(result.observations.find((row) => row.meter_id === "grok:main")).toMatchObject({ freshness: "fresh", source: "native:grok" });
      expect(result.failures).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });

  it("reports a rate-limited grok principal as a collector failure so it backs off", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-grok-429-")); temporary.push(root);
    const grokHome = join(root, ".grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(join(grokHome, "auth.json"), await authFixture(), { mode: 0o600 });
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "grok"', 'vendor = "grok"', `location = ${JSON.stringify(grokHome)}`, 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try {
      const result = await pollAccounts();
      expect(result.failures).toEqual(["grok source failed: Grok usage request failed (429)"]);
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });
});
