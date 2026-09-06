/**
 * Snapshots the FIELD SHAPE (which fields exist, and each one's JSON type)
 * of every in-scope --json CLI output and MCP tool result against a fixture
 * under test/fixtures/json-contract/. A field silently renamed or removed
 * changes the shape and fails this test -- see docs/json-contract.md for
 * what each field means and the compatibility promise these fixtures stand
 * behind.
 *
 * Shapes, not raw values: a fixture never contains a real timestamp, a
 * temporary directory path, or any other value that would make the snapshot
 * flaky or machine-specific. Every leaf is reduced to its JSON type
 * ("string", "number", "boolean", or "null") before it is written or
 * compared, so `generated_at: "2026-09-06T12:00:00.000Z"` and
 * `generated_at: "2026-09-07T03:11:59.000Z"` are the same fixture line:
 * `"generated_at": "string"`.
 *
 * To add a field on purpose: run with UPDATE_JSON_CONTRACT_FIXTURES=1 once,
 * inspect the diff under test/fixtures/json-contract/, and commit it
 * alongside the doc update it should come with.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, printEventsOutput } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";
import { HeadroomStore } from "../src/store.js";
import type { HeadroomEvent, Observation } from "../src/types.js";

const FIXTURE_DIR = new URL("./fixtures/json-contract/", import.meta.url);

// ---- shape extraction --------------------------------------------------

type Shape = string | Shape[] | { [key: string]: Shape };

/** Merges the shapes of an array's elements into one, since two rows of the
 * same array (e.g. a synthetic "reason"-only RateLine beside a normal one)
 * can legitimately carry different optional fields -- the merged shape is
 * the union of everything seen, which is exactly what a reader of the
 * contract doc needs to know is possible. */
function unionShape(shapes: Shape[]): Shape {
  if (!shapes.length) return "unknown (empty array in the fixture data)";
  if (shapes.every((item) => typeof item === "string")) return [...new Set(shapes as string[])].sort().join(" | ");
  if (shapes.every((item) => Array.isArray(item))) return [unionShape((shapes as Shape[][]).flat())];
  const keys = new Set<string>();
  for (const item of shapes) if (item && typeof item === "object" && !Array.isArray(item)) for (const key of Object.keys(item)) keys.add(key);
  const merged: Record<string, Shape> = {};
  for (const key of [...keys].sort()) {
    const values = shapes.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, Shape>)[key] : undefined)).filter((item): item is Shape => item !== undefined);
    merged[key] = unionShape(values);
  }
  return merged;
}

function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [unionShape(value.map(shapeOf))] : ["unknown (empty array in the fixture data)"];
  if (typeof value === "object") {
    const out: Record<string, Shape> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = shapeOf((value as Record<string, unknown>)[key]);
    return out;
  }
  return typeof value;
}

async function compareToFixture(name: string, actual: unknown): Promise<void> {
  const shape = shapeOf(actual);
  const path = new URL(`${name}.json`, FIXTURE_DIR);
  if (process.env.UPDATE_JSON_CONTRACT_FIXTURES) {
    await writeFile(path, `${JSON.stringify(shape, null, 2)}\n`, "utf8");
    return;
  }
  if (!existsSync(path)) throw new Error(`no fixture at test/fixtures/json-contract/${name}.json -- run with UPDATE_JSON_CONTRACT_FIXTURES=1 to create it, then check the diff by hand`);
  const fixture = JSON.parse(await readFile(path, "utf8")) as Shape;
  expect(shape, `${name} --json's field shape changed. If this is an intentional, additive change, update docs/json-contract.md and regenerate this fixture with UPDATE_JSON_CONTRACT_FIXTURES=1. If it renamed or removed a field, that breaks the compatibility promise in docs/json-contract.md.`).toEqual(fixture);
}

// ---- fixtures -----------------------------------------------------------

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function newHome(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `headroom-json-contract-${prefix}-`));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function fiveHour(used: number, fetchedAtOffsetMs: number, resetsAtOffsetMs: number, now: Date): Observation {
  const fetchedAt = new Date(now.getTime() + fetchedAtOffsetMs).toISOString();
  return {
    principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: new Date(now.getTime() + resetsAtOffsetMs).toISOString(),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function weekly(used: number, now: Date): Observation {
  const fetchedAt = now.toISOString();
  return {
    principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

/** One claude-main principal, routing.toml with a "claude-fable" action
 * class (and a static per-class cost, so `fill`'s class breakdown carries a
 * real row), a fresh 5h window with two samples (a real burn rate), a fresh
 * weekly window, and one ended lease under "claude-fable" (a learned-cost
 * sample) -- enough for can/gate/plan/fill/route/rate/cost to all succeed
 * against the same store. */
async function seedBasic(home: string, now = new Date()): Promise<void> {
  await writeFile(join(home, "routing.toml"), ["[consumes]", 'claude-fable = ["claude-main:all"]', "", "[cost.claude-fable]", "percent = 5", "duration_minutes = 10", ""].join("\n"), { mode: 0o600 });
  await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
  const store = await HeadroomStore.open(home);
  try {
    store.insert(fiveHour(10, -20 * 60_000, 4 * 3_600_000, now));
    store.insert(fiveHour(30, 0, 4 * 3_600_000, now));
    store.insert(weekly(40, now));
    // The lease's spent_percent is booked from the usage delta observed
    // while it is active, not from its own --expect: without a fresh
    // reading between start and end, an immediately-ended lease spends
    // nothing and learnedCost's median would be a flat, uninformative 0.
    const lease = store.startLease("cadence", "claude-main:all", 5, 3_600_000, null, now, "claude-fable");
    store.insert(fiveHour(35, 5 * 60_000, 4 * 3_600_000, now));
    store.endLease(lease.id, "cadence");
  } finally { store.close(); }
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

// ---- CLI --json outputs ---------------------------------------------------

describe("CLI --json field shapes", () => {
  // No accounts.toml here (unlike seedBasic): with no daemon, plain `status`
  // also polls every configured non-local account live to refresh it, which
  // would immediately overwrite these seeded rows with a real probe's
  // failed/grant-needed reading against the fake "/nonexistent/.claude"
  // location -- fine for can/gate/plan/fill/route (none of them poll on a
  // direct read), wrong here, where the point is the rich, fully-populated
  // observation shape.
  it("status", async () => {
    const home = await newHome("status");
    await writeFile(join(home, "accounts.toml"), "");
    const store = await HeadroomStore.open(home);
    try {
      const now = new Date();
      store.insert(fiveHour(30, 0, 4 * 3_600_000, now));
      store.insert(weekly(40, now));
    } finally { store.close(); }
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["--json"])); } finally { restore(); }
    await compareToFixture("cli-status", JSON.parse(logs[0]));
  });

  it("status --threshold", async () => {
    const home = await newHome("status-threshold");
    await writeFile(join(home, "accounts.toml"), "");
    const store = await HeadroomStore.open(home);
    try {
      const now = new Date();
      store.insert(fiveHour(30, 0, 4 * 3_600_000, now));
      store.insert(weekly(40, now));
    } finally { store.close(); }
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["--json", "--threshold", "50"])); } finally { restore(); }
    await compareToFixture("cli-status-threshold", JSON.parse(logs[0]));
  });

  it("status --models", async () => {
    const home = await newHome("status-models");
    const claudeConfigDir = join(home, "..", ".claude");
    await mkdir(join(claudeConfigDir, "projects", "-project"), { recursive: true });
    await writeFile(join(claudeConfigDir, "projects", "-project", "session.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-fable-5-1", usage: { input_tokens: 10, output_tokens: 20 } } }));
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', `location = ${JSON.stringify(claudeConfigDir)}`, 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try { store.insert(fiveHour(20, 0, 4 * 3_600_000, new Date())); } finally { store.close(); }
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["--principal", "claude-main", "--models", "--json"])); } finally { restore(); }
    await compareToFixture("cli-status-models", JSON.parse(logs[0]));
  });

  it("can", async () => {
    const home = await newHome("can");
    await seedBasic(home);
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["can", "claude-fable", "--owner", "cadence", "--json"])); } finally { restore(); }
    await compareToFixture("cli-can", JSON.parse(logs[0]));
  });

  it("gate", async () => {
    const home = await newHome("gate");
    await seedBasic(home);
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["gate", "--need", "5h:1", "--meter", "claude-main:all", "--class", "claude-fable", "--owner", "cadence", "--json"])); } finally { restore(); }
    await compareToFixture("cli-gate", JSON.parse(logs[0]));
  });

  it("plan", async () => {
    const home = await newHome("plan");
    await seedBasic(home);
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["plan", "--meter", "claude-main:all", "--until", "reset", "--json"])); } finally { restore(); }
    await compareToFixture("cli-plan", JSON.parse(logs[0]));
  });

  it("fill", async () => {
    const home = await newHome("fill");
    await seedBasic(home);
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["fill", "--meter", "claude-main:all", "--until-reset", "--lane-cost", "5", "--owner", "cadence", "--plan-share", "50", "--json"])); } finally { restore(); }
    await compareToFixture("cli-fill", JSON.parse(logs[0]));
  });

  // A low, just-started window (still in its grace period) rather than
  // seedBasic's: routeFor only assigns a winning principal in NORMAL or
  // HARVEST, and the point of this fixture is the winning shape (a real
  // `principal` string), not the "no candidate fits" refusal.
  it("route", async () => {
    const home = await newHome("route");
    await writeFile(join(home, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:all"]\n', { mode: 0o600 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try { const now = new Date(); store.insert(fiveHour(5, 0, 5 * 3_600_000, now)); store.insert(weekly(10, now)); } finally { store.close(); }
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["route", "--class", "claude-fable", "--owner", "cadence", "--json"])); } finally { restore(); }
    await compareToFixture("cli-route", JSON.parse(logs[0]));
  });

  it("inbox", async () => {
    const home = await newHome("inbox");
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        await main(["inbox", "send", "--to", "session-b", "--kind", "note", "--text", "hello"]);
        await main(["inbox", "--session", "session-b", "--json"]);
      });
    } finally { restore(); }
    await compareToFixture("cli-inbox", JSON.parse(logs[1]));
  });

  it("lease list", async () => {
    const home = await newHome("lease-list");
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        await main(["lease", "start", "--owner", "cadence", "--meter", "claude-main:all", "--expect", "5", "--note", "test"]);
        await main(["lease", "list", "--json"]);
      });
    } finally { restore(); }
    await compareToFixture("cli-lease-list", JSON.parse(logs[1]));
  });

  it("cost (bare array, no envelope -- see docs/json-contract.md)", async () => {
    const home = await newHome("cost");
    await seedBasic(home);
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["cost", "claude-fable", "--json"])); } finally { restore(); }
    await compareToFixture("cli-cost", JSON.parse(logs[0]));
  });

  it("rate (bare array, no envelope -- see docs/json-contract.md)", async () => {
    const home = await newHome("rate");
    await seedBasic(home);
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["rate", "--meter", "claude-main:all", "--json"])); } finally { restore(); }
    await compareToFixture("cli-rate", JSON.parse(logs[0]));
  });

  it("spend (bare array, no envelope -- see docs/json-contract.md)", async () => {
    const home = await newHome("spend");
    const now = new Date();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour(10, 0, 4 * 3_600_000, now));
      store.startLease("session-a", "claude-main:all", null, 30 * 86_400_000, null, now);
      store.insert(fiveHour(25, 30 * 60_000, 4 * 3_600_000, now));
    } finally { store.close(); }
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["spend", "--since", "365d", "--json"])); } finally { restore(); }
    await compareToFixture("cli-spend", JSON.parse(logs[0]));
  });

  it("events (bare array, no envelope -- see docs/json-contract.md)", () => {
    const event: HeadroomEvent = {
      id: "reset_seen:1", kind: "reset_seen", origin: "inferred", confidence: 0.9, evidence_observation_ids: [1, 2],
      created_at: "2026-09-03T12:00:00.000Z", corrected_by: null, meter_id: "claude-main:all", principal_id: "claude-main", reason: null, last_seen_at: null,
    };
    const { logs, restore } = captureLog();
    try { printEventsOutput([event], false); } finally { restore(); }
    return compareToFixture("cli-events", JSON.parse(logs[0]));
  });

  it("contract (plain text, not JSON -- see docs/json-contract.md)", async () => {
    const home = await newHome("contract");
    const { logs, restore } = captureLog();
    try { await withHeadroomHome(home, () => main(["contract"])); } finally { restore(); }
    expect(logs[0]).toBe("contract 1.0");
    expect(logs[1]).toBe("docs/json-contract.md");
  });
});

// ---- MCP tool results ------------------------------------------------

describe("MCP tool result field shapes (direct, no daemon)", () => {
  const noDaemon = async (): Promise<undefined> => undefined;

  // Parses the same `content[0].text` a real MCP client reads, not the
  // in-process `structuredContent` object directly: only the text has been
  // through JSON.stringify, which is what actually decides a field's shape
  // on the wire (an `undefined` value drops the key entirely; a plain object
  // reference would not).
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), noDaemon);
    const text = (reply as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    return JSON.parse(text);
  }

  // No accounts.toml (unlike seedBasic): directStatus() polls every
  // configured non-local account live, which would overwrite these seeded
  // rows with a real probe's failed/grant-needed reading -- see the same
  // note on the CLI "status" test above.
  it("quota_status", async () => {
    const home = await newHome("mcp-status");
    await writeFile(join(home, "accounts.toml"), "");
    const store = await HeadroomStore.open(home);
    try {
      const now = new Date();
      store.insert(fiveHour(30, 0, 4 * 3_600_000, now));
      store.insert(weekly(40, now));
    } finally { store.close(); }
    const result = await withHeadroomHome(home, () => call("quota_status", {}));
    await compareToFixture("mcp-quota_status", result);
  });

  it("quota_can", async () => {
    const home = await newHome("mcp-can");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_can", { action_class: "claude-fable", owner: "cadence" }));
    await compareToFixture("mcp-quota_can", result);
  });

  it("quota_events", async () => {
    const home = await newHome("mcp-events");
    const result = await withHeadroomHome(home, () => call("quota_events", {}));
    await compareToFixture("mcp-quota_events", result);
  });

  it("quota_lease_start and quota_lease_end", async () => {
    const home = await newHome("mcp-lease");
    const started = await withHeadroomHome(home, () => call("quota_lease_start", { meter_id: "claude-main:all", owner: "cadence", expected_percent: 5 })) as { lease: { id: string } };
    await compareToFixture("mcp-quota_lease_start", started);
    const ended = await withHeadroomHome(home, () => call("quota_lease_end", { id: started.lease.id, owner: "cadence" }));
    await compareToFixture("mcp-quota_lease_end", ended);
  });

  it("quota_leases", async () => {
    const home = await newHome("mcp-leases");
    await withHeadroomHome(home, () => call("quota_lease_start", { meter_id: "claude-main:all", owner: "cadence", expected_percent: 5 }));
    const result = await withHeadroomHome(home, () => call("quota_leases", {}));
    await compareToFixture("mcp-quota_leases", result);
  });

  it("quota_cost", async () => {
    const home = await newHome("mcp-cost");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_cost", { action_class: "claude-fable" }));
    await compareToFixture("mcp-quota_cost", result);
  });

  it("quota_rate", async () => {
    const home = await newHome("mcp-rate");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_rate", { meter: "claude-main:all" }));
    await compareToFixture("mcp-quota_rate", result);
  });

  it("quota_spend", async () => {
    const home = await newHome("mcp-spend");
    const now = new Date();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour(10, 0, 4 * 3_600_000, now));
      store.startLease("session-a", "claude-main:all", null, 30 * 86_400_000, null, now);
      store.insert(fiveHour(25, 30 * 60_000, 4 * 3_600_000, now));
    } finally { store.close(); }
    const result = await withHeadroomHome(home, () => call("quota_spend", {}));
    await compareToFixture("mcp-quota_spend", result);
  });

  it("quota_inbox", async () => {
    const home = await newHome("mcp-inbox");
    await withHeadroomHome(home, () => main(["inbox", "send", "--to", "session-b", "--kind", "note", "--text", "hello"]));
    const result = await withHeadroomHome(home, () => call("quota_inbox", { session: "session-b" }));
    await compareToFixture("mcp-quota_inbox", result);
  });

  it("quota_plan", async () => {
    const home = await newHome("mcp-plan");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_plan", { meter: "claude-main:all" }));
    await compareToFixture("mcp-quota_plan", result);
  });

  it("quota_gate", async () => {
    const home = await newHome("mcp-gate");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_gate", { needs: ["5h:1"], meter: "claude-main:all", owner: "cadence", action_class: "claude-fable" }));
    await compareToFixture("mcp-quota_gate", result);
  });

  it("quota_wait", async () => {
    const home = await newHome("mcp-wait");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_wait", { meter: "claude-main:all" }));
    await compareToFixture("mcp-quota_wait", result);
  });

  it("quota_fill", async () => {
    const home = await newHome("mcp-fill");
    await seedBasic(home);
    const result = await withHeadroomHome(home, () => call("quota_fill", { meter: "claude-main:all", lane_cost_percent: 5, owner: "cadence", plan_share_percent: 50 }));
    await compareToFixture("mcp-quota_fill", result);
  });

  it("quota_route", async () => {
    const home = await newHome("mcp-route");
    await writeFile(join(home, "routing.toml"), '[consumes]\nclaude-fable = ["claude-main:all"]\n', { mode: 0o600 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    try { const now = new Date(); store.insert(fiveHour(5, 0, 5 * 3_600_000, now)); store.insert(weekly(10, now)); } finally { store.close(); }
    const result = await withHeadroomHome(home, () => call("quota_route", { action_class: "claude-fable", owner: "cadence" }));
    await compareToFixture("mcp-quota_route", result);
  });

  it("quota_usage_paste", async () => {
    const home = await newHome("mcp-usage-paste");
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const panel = await readFile(new URL("./fixtures/usage-paste/plain.txt", import.meta.url), "utf8");
    const result = await withHeadroomHome(home, () => call("quota_usage_paste", { text: panel }));
    await compareToFixture("mcp-quota_usage_paste", result);
  });
});
