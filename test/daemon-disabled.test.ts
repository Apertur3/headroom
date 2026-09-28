import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomDaemon } from "../src/daemon.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";
import { authedHandleLine } from "./helpers/daemon-rpc.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
  try { return await run(); } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

const accounts = (enabled: boolean): string => [
  "[[accounts]]", 'name = "claude-2"', `enabled = ${enabled}`,
  'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', "",
].join("\n");

describe("daemon disabled scheduling", () => {
  it("excludes disabled-only aggregate rate and credits, and rejects credit writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-daemon-disabled-current-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), accounts(false), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try {
      const now = new Date();
      store.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: new Date(now.getTime() + 3_600_000).toISOString(), observed_at: now.toISOString(), fetched_at: now.toISOString(), source: "fixture", truth: "official", freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture" });
      store.recordManualCredits("claude-2", 1, new Date(now.getTime() + 86_400_000).toISOString());
    } finally { store.close(); }
    await withHome(home, async () => {
      const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller: async () => ({ observations: [], failures: [] }) });
      try {
        await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rate", params: {} }))).resolves.toMatchObject({ result: [] });
        await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "credits", params: {} }))).resolves.toMatchObject({ result: [] });
        const expires = new Date(Date.now() + 86_400_000).toISOString();
        await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "credits_set", params: { principal: "claude-2", available: 1, expires } }))).resolves.toMatchObject({ error: { message: expect.stringContaining("disabled") } });
        await expect(authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "credits_clear", params: { principal: "claude-2" } }))).resolves.toMatchObject({ error: { message: expect.stringContaining("disabled") } });
      } finally { await daemon.stop(); }
    });
  });

  it("does not poll or schedule a disabled principal, then schedules it on the next reload after enabling", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-daemon-disabled-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), accounts(false), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    const poller = vi.fn(async () => ({ observations: [] as Observation[], failures: ["claude-2 source failed: should not be recorded"] }));
    const daemon = await HeadroomDaemon.create({ home, path: join(home, "headroom.sock"), poller });
    const internal = daemon as unknown as {
      schedulingStarted: boolean; schedulers: Map<string, ReturnType<typeof setTimeout>>;
      currentAccounts(): Promise<unknown>; schedulePrincipals(): Promise<void>; poll(principal: string | undefined, forced: boolean): Promise<unknown>;
    };
    let historicalFailureEvents = 0;
    try {
      internal.schedulingStarted = true;
      await internal.schedulePrincipals();
      expect(internal.schedulers.has("claude-2")).toBe(false);
      await internal.poll(undefined, true);
      expect(poller).not.toHaveBeenCalled();
      const store = await HeadroomStore.open(home);
      try {
        store.insert({ principal_id: "claude-2", meter_id: "claude-2:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, quantity: null, resets_at: null, observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), source: "native:claude", truth: "official", freshness: "failed", confidence: 1, adapter_version: "test", upstream_schema_version: "test", reason: "historical failure" });
        historicalFailureEvents = store.events("1970-01-01T00:00:00.000Z").filter((event) => event.kind === "source_failed" && event.principal_id === "claude-2").length;
      }
      finally { store.close(); }
      // The daemon's own "status" RPC stays a plain Observation[] array under
      // the 1.x JSON contract (docs/json-contract.md) -- it never grows a
      // `disabled_principals` field of its own; disabled principals are
      // still excluded from capacity, just by dropping their rows from this
      // array rather than by an additive field the CLI/MCP layers derive
      // separately from the registry.
      const reply = (await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: {} }))).result as Observation[];
      expect(reply).toEqual([]);
      const afterStatus = await HeadroomStore.open(home);
      try { expect(afterStatus.events("1970-01-01T00:00:00.000Z").filter((event) => event.kind === "source_failed" && event.principal_id === "claude-2")).toHaveLength(historicalFailureEvents); }
      finally { afterStatus.close(); }

      await writeFile(join(home, "accounts.toml"), accounts(true), { mode: 0o600 });
      await internal.currentAccounts();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(internal.schedulers.has("claude-2")).toBe(true);
      await writeFile(join(home, "accounts.toml"), accounts(false), { mode: 0o600 });
      await internal.currentAccounts();
      expect(internal.schedulers.has("claude-2")).toBe(false);
    } finally { await daemon.stop(); if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
