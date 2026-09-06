import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiCredentialPaths, observationsFromGeminiQuota, observeGemini } from "../src/adapters/gemini.js";
import { PROTECTED_STATUS_PATTERN, pollAccounts } from "../src/collector.js";
import { discoverAccounts } from "../src/registry.js";
import type { ProviderAccount } from "../src/types.js";

const gemini = { name: "gemini", vendor: "gemini", location: "/Users/test/.gemini", adapter: "native-ts" } as const satisfies ProviderAccount;
const at = new Date("2026-09-06T12:00:00Z");
const credential = JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-06T13:00:00Z", project: "stored-project" });
const fixture = async (name: string): Promise<unknown> => JSON.parse(await readFile(new URL(`./fixtures/gemini/${name}`, import.meta.url), "utf8"));

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function reads(fetcher: ReturnType<typeof vi.fn>): Request[] {
  return fetcher.mock.calls.map(([request]) => request as Request);
}

describe("Gemini CLI adapter", () => {
  it("maps each quota bucket's model family to its own meter", async () => {
    const rows = observationsFromGeminiQuota(await fixture("retrieve-user-quota.synthetic.json"), gemini, at);
    expect(rows).toEqual([
      expect.objectContaining({
        meter_id: "gemini:gemini-2.5-flash", source: "remote:gemini", freshness: "fresh", truth: "official",
        quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: "2026-09-07T00:00:00.000Z",
      }),
      expect.objectContaining({
        meter_id: "gemini:gemini-2.5-pro", quantity: { used: 38, limit: 100, remaining: 62, unit: "percent" },
      }),
    ]);
    // No bucket named a period, so no window length is invented for one.
    expect(rows.every((row) => row.window?.minutes === null)).toBe(true);
  });

  it("keeps the lowest remaining fraction when one family reports several token types, and names an unscoped bucket `all`", () => {
    const rows = observationsFromGeminiQuota({ buckets: [
      { modelId: "gemini-2.5-pro", remainingFraction: 0.9, resetTime: "2026-09-07T00:00:00Z", tokenType: "output" },
      { modelId: "gemini-2.5-pro", remainingFraction: 0.4, resetTime: "2026-09-07T00:00:00Z", tokenType: "input" },
      { remainingFraction: 0.75, resetTime: "2026-09-13T00:00:00Z", displayName: "Weekly requests" },
    ] }, gemini, at);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "gemini:gemini-2.5-pro", quantity: expect.objectContaining({ used: 60 }) }),
      expect.objectContaining({ meter_id: "gemini:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" }, quantity: expect.objectContaining({ used: 25 }) }),
    ]));
    expect(rows.filter((row) => row.meter_id === "gemini:gemini-2.5-pro")).toHaveLength(1);
  });

  it("announces the Gemini CLI's own ideType, sends no product token, and asks quota for the stored project", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: "ignored-when-stored" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(await fixture("retrieve-user-quota.synthetic.json"))));
    const rows = await observeGemini(gemini, { now: () => at, credentialPaths: () => ["gemini-oauth"], readFile: async () => credential, fetch: fetcher });
    expect(rows.every((row) => row.freshness === "fresh")).toBe(true);
    const requests = reads(fetcher);
    expect(requests.map((request) => request.url)).toEqual([
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ]);
    expect(await requests[0].text()).toBe(JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }));
    expect(requests[1].headers.get("User-Agent")).toBeNull();
    expect(await requests[1].text()).toBe(JSON.stringify({ project: "stored-project" }));
  });

  it("reports an availability-only answer as failed instead of as zero usage", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify(await fixture("retrieve-user-quota-availability-only.synthetic.json"))));
    const rows = await observeGemini(gemini, { now: () => at, credentialPaths: () => ["gemini-oauth"], readFile: async () => credential, fetch: fetcher });
    expect(rows).toEqual([expect.objectContaining({
      meter_id: "gemini:all", freshness: "failed", quantity: null, window: null,
      reason: "quota endpoint returned availability only",
    })]);
  });

  it("turns the free-tier 403 into a backed-off failed reading, never an exception", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: "stored-project" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(await fixture("retrieve-user-quota-403.synthetic.json")), { status: 403 }));
    const rows = await observeGemini(gemini, { now: () => at, credentialPaths: () => ["gemini-oauth"], readFile: async () => credential, fetch: fetcher });
    expect(rows).toEqual([expect.objectContaining({ freshness: "failed", quantity: null, reason: "quota endpoint not permitted for this account tier (403)" })]);
    // The reason has to stay inside the collector's protected-status pattern,
    // or the shared backoff would keep re-asking a settled question.
    expect(PROTECTED_STATUS_PATTERN.test(rows[0].reason ?? "")).toBe(true);
  });

  it("reports UNKNOWN with a finish-setup reason, and issues no further request, when no project can be resolved", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(await fixture("load-code-assist-no-project.synthetic.json"))));
    const rows = await observeGemini(gemini, {
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-06T13:00:00Z" }),
      fetch: fetcher,
    });
    expect(rows).toEqual([expect.objectContaining({ freshness: "failed", reason: "no Code Assist project; finish setup in the Gemini CLI" })]);
    // Exactly one request: onboarding an account is never Headroom's to do.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("names the recovery command when the credential is unreadable, and never puts the token in a reading", async () => {
    const missing = await observeGemini(gemini, { now: () => at, credentialPaths: () => ["absent"], readFile: async () => { throw new Error("ENOENT"); } });
    expect(missing).toEqual([expect.objectContaining({ freshness: "failed", reason: "no Gemini CLI OAuth credentials; run: gemini" })]);

    const secret = "ya29.token-value-that-must-never-be-reported";
    const rows = await observeGemini(gemini, {
      now: () => at, credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: secret, expiry_date: "2026-09-06T13:00:00Z", project: "stored-project" }),
      fetch: async () => new Response("nope", { status: 500 }),
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0].freshness).toBe("failed");
  });

  it("reads the credential from the principal's own Gemini home", () => {
    expect(geminiCredentialPaths("/Users/test/.gemini")).toEqual([join("/Users/test/.gemini", "oauth_creds.json")]);
  });
});

describe("Gemini CLI discovery", () => {
  it("adds a gemini principal for the default home, and a named one for a GEMINI_CLI_HOME override", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-gemini-registry-")); temporary.push(root);
    await mkdir(join(root, ".gemini"), { recursive: true });
    await writeFile(join(root, ".gemini", "oauth_creds.json"), credential, { mode: 0o600 });
    expect(await discoverAccounts(root, { PATH: "" })).toContainEqual(expect.objectContaining({
      name: "gemini", vendor: "gemini", location: join(root, ".gemini"), adapter: "native-ts",
    }));

    const alternate = join(root, "work");
    await mkdir(join(alternate, ".gemini"), { recursive: true });
    await writeFile(join(alternate, ".gemini", "oauth_creds.json"), credential, { mode: 0o600 });
    expect(await discoverAccounts(root, { PATH: "", GEMINI_CLI_HOME: alternate })).toContainEqual(expect.objectContaining({
      name: "gemini-work", vendor: "gemini", location: join(alternate, ".gemini"),
    }));
  });

  it("adds nothing when the Gemini CLI has never logged in", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-gemini-registry-")); temporary.push(root);
    await mkdir(join(root, ".gemini"), { recursive: true });
    expect((await discoverAccounts(root, { PATH: "" })).some((account) => account.name.startsWith("gemini"))).toBe(false);
  });
});

describe("pollAccounts: Gemini dispatch", () => {
  it("collects a configured gemini principal through its own adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-gemini-poll-")); temporary.push(root);
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    // A location with no credential file: the poll must still route this
    // principal to the Gemini adapter and come back with its reason, rather
    // than skipping it or handing it to the Swift engine.
    await writeFile(join(home, "accounts.toml"), [
      "[[accounts]]", 'name = "gemini"', 'vendor = "gemini"', `location = ${JSON.stringify(join(root, "nowhere", ".gemini"))}`, 'adapter = "native-ts"', "",
    ].join("\n"), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = home;
    try {
      const result = await pollAccounts();
      expect(result.observations).toEqual([expect.objectContaining({
        principal_id: "gemini", meter_id: "gemini:all", source: "remote:gemini",
        freshness: "failed", reason: "no Gemini CLI OAuth credentials; run: gemini",
      })]);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
    }
  });
});
