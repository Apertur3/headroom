import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { budgetPlanLeases, parseBudgetPlan } from "../src/budget-plan.js";
import { assertSessionId, readInbox, sendInboxMessage, sendInboxMessageAt, sessionDirectory, MAX_INBOX_MESSAGE_BYTES } from "../src/inbox.js";
import { handleMcp } from "../src/mcp.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-inbox-"));
  temporary.push(root);
  return join(root, ".headroom");
}

async function withHeadroomHome<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = path;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function capture(run: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => { logged.push(String(value)); });
  const errored = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try { await run(); } finally { log.mockRestore(); errored.mockRestore(); }
  return logged;
}

describe("assertSessionId", () => {
  it("accepts the allowed shape and refuses everything else", () => {
    expect(assertSessionId("session-a.1_2")).toBe("session-a.1_2");
    for (const bad of ["", " ", "a/b", "../escape", "..", ".", "a b", "sess:ion", "a\\b", "x".repeat(65), "é"]) {
      expect(() => assertSessionId(bad)).toThrow();
    }
  });
});

describe("inbox send and read", () => {
  it("writes a 0600 envelope named <epoch>-<kind>.json inside a 0700 session directory", async () => {
    const path = await home();
    const sent = await sendInboxMessage({ to: "session-b", kind: "handoff", text: '{"lane":"docs"}', from: "session-a", home: path, now: new Date(1_757_000_000_000) });
    expect(sent.file).toBe("1757000000000-handoff.json");
    const directory = join(path, "inbox", "session-b");
    expect(sent.path).toBe(join(directory, sent.file));
    const envelope = JSON.parse(await readFile(sent.path, "utf8")) as Record<string, unknown>;
    expect(envelope).toMatchObject({ version: 1, kind: "handoff", to: "session-b", from: "session-a", body: { lane: "docs" } });
    if (process.platform !== "win32") {
      expect((await lstat(sent.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(path, "inbox"))).mode & 0o777).toBe(0o700);
    }
  });

  it("returns messages oldest first and marks each read by renaming it", async () => {
    const path = await home();
    await sendInboxMessage({ to: "session-b", kind: "note", text: "second", home: path, now: new Date(2000) });
    await sendInboxMessage({ to: "session-b", kind: "budget", text: "first", home: path, now: new Date(1000) });
    const first = await readInbox({ session: "session-b", home: path });
    expect(first.messages.map((item) => [item.kind, item.body])).toEqual([["budget", "first"], ["note", "second"]]);
    expect(first.remaining).toBe(0);
    const names = (await readdir(join(path, "inbox", "session-b"))).sort();
    expect(names).toEqual(["1000-budget.json.read", "2000-note.json.read"]);
    // A second read finds nothing: a hand-off is delivered exactly once.
    expect((await readInbox({ session: "session-b", home: path })).messages).toEqual([]);
  });

  it("filters by --since epoch and leaves the older message queued", async () => {
    const path = await home();
    await sendInboxMessage({ to: "session-b", kind: "note", text: "old", home: path, now: new Date(1000) });
    await sendInboxMessage({ to: "session-b", kind: "note", text: "new", home: path, now: new Date(5000) });
    const result = await readInbox({ session: "session-b", home: path, since: 5000 });
    expect(result.messages.map((item) => item.body)).toEqual(["new"]);
    expect(await readdir(join(path, "inbox", "session-b"))).toContain("1000-note.json");
  });

  it("keeps two messages of the same kind written in the same millisecond", async () => {
    const path = await home();
    const first = await sendInboxMessage({ to: "session-b", kind: "note", text: "one", home: path, now: new Date(1000) });
    const second = await sendInboxMessage({ to: "session-b", kind: "note", text: "two", home: path, now: new Date(1000) });
    expect(first.file).toBe("1000-note.json");
    expect(second.file).toBe("1001-note.json");
  });

  it("skips a file it did not write and leaves it in place", async () => {
    const path = await home();
    const directory = await sessionDirectory("session-b", path);
    await writeFile(join(directory, "notes.txt"), "not a message", { mode: 0o600 });
    await sendInboxMessage({ to: "session-b", kind: "note", text: "real", home: path, now: new Date(1000) });
    const result = await readInbox({ session: "session-b", home: path });
    expect(result.messages.map((item) => item.body)).toEqual(["real"]);
    expect(await readdir(directory)).toContain("notes.txt");
  });

  it("refuses a bad session id and a traversal attempt, on both send and read", async () => {
    const path = await home();
    for (const bad of ["../../etc", "..", "a/b", "sess ion"]) {
      await expect(sendInboxMessage({ to: bad, kind: "note", text: "x", home: path })).rejects.toThrow(/session id/);
      await expect(readInbox({ session: bad, home: path })).rejects.toThrow(/session id/);
    }
    // Nothing was created outside the inbox root, nor an inbox root at all.
    await expect(lstat(join(path, "inbox"))).rejects.toThrow();
  });

  it("refuses an empty body, an unknown kind, and a body over the 64 KiB cap", async () => {
    const path = await home();
    await expect(sendInboxMessage({ to: "session-b", kind: "note", text: "", home: path })).rejects.toThrow(/empty/);
    await expect(sendInboxMessage({ to: "session-b", kind: "shout" as "note", text: "x", home: path })).rejects.toThrow(/kind must be one of/);
    await expect(sendInboxMessage({ to: "session-b", kind: "note", text: "x".repeat(MAX_INBOX_MESSAGE_BYTES + 1), home: path })).rejects.toThrow(/over the 65536 byte cap/);
  });
});

// ---------------------------------------------------------------------------
// sendInboxMessageAt: the idempotent-by-identity counterpart src/heartbeat.ts's
// fireDueTimers uses. Its predecessor derived the filename from a hash of the
// timer's own name/at (~1000 distinct values per owner per second) and shared
// that filename space with ordinary hand-offs sent via `headroom inbox send`
// -- two unrelated messages could land on the exact same path, and the old
// "a file already exists here" check alone would then treat the SECOND
// message's delivery as already done without ever writing it. `delivery_id`
// (a random, per-registration identity, both in the filename and in the
// envelope's own `delivery_id` field) removes the collision risk and lets
// this verify identity by content, not merely by path, before ever treating
// an existing file as a match.
// ---------------------------------------------------------------------------

describe("sendInboxMessageAt", () => {
  it("writes the envelope with a delivery_id field, named <delivery_id>-<kind>.json", async () => {
    const path = await home();
    const sent = await sendInboxMessageAt({ to: "session-c", kind: "handoff", text: '{"timer":"wake","at":"2026-09-28T12:00:00.000Z","action":"check"}', from: "headroom-timer", delivery_id: 123456789012345, home: path, now: new Date(1_757_000_000_000) });
    expect(sent.delivered).toBe(true);
    expect(sent.file).toBe("123456789012345-handoff.json");
    const envelope = JSON.parse(await readFile(sent.path, "utf8")) as Record<string, unknown>;
    expect(envelope).toMatchObject({ version: 1, kind: "handoff", to: "session-c", from: "headroom-timer", delivery_id: 123456789012345, body: { timer: "wake", action: "check" } });
  });

  it("is idempotent: a second call with the same delivery_id skips the write and reports delivered: false", async () => {
    const path = await home();
    const options = { to: "session-c", kind: "handoff" as const, text: '{"timer":"wake","at":"2026-09-28T12:00:00.000Z","action":"check"}', from: "headroom-timer", delivery_id: 42, home: path };
    const first = await sendInboxMessageAt({ ...options, now: new Date(1000) });
    expect(first.delivered).toBe(true);
    const second = await sendInboxMessageAt({ ...options, now: new Date(2000) });
    expect(second.delivered).toBe(false);
    expect(second.path).toBe(first.path);
    // Exactly one file, one message -- never a duplicate.
    const messages = await readdir(join(path, "inbox", "session-c"));
    expect(messages).toHaveLength(1);
  });

  it("still recognizes an already-read message (renamed .read) as delivered, not as free to overwrite", async () => {
    const path = await home();
    const options = { to: "session-c", kind: "handoff" as const, text: '{"timer":"wake","at":"2026-09-28T12:00:00.000Z","action":"check"}', from: "headroom-timer", delivery_id: 7, home: path, now: new Date(1000) };
    await sendInboxMessageAt(options);
    await readInbox({ session: "session-c", home: path }); // marks it read (renamed with .read)
    const retried = await sendInboxMessageAt(options);
    expect(retried.delivered).toBe(false);
    const messages = await readdir(join(path, "inbox", "session-c"));
    expect(messages).toEqual(["7-handoff.json.read"]);
  });

  // The blocker this whole mechanism exists to close: a path already
  // occupied by an UNRELATED message (here, written exactly the way an
  // ordinary `headroom inbox send` would -- ordinary hand-offs and timer
  // deliveries share the same directory and the same numeric filename
  // space) must never be silently treated as "this timer's delivery already
  // happened". Verified by content (the `delivery_id` field), not merely by
  // the file existing at the expected path.
  it("throws an identity collision rather than treating an unrelated message at the same path as already delivered", async () => {
    const path = await home();
    const directory = await sessionDirectory("orch-collide", path);
    const collidingId = 555_000_000_000_000;
    await writeFile(join(directory, `${collidingId}-handoff.json`), `${JSON.stringify({ version: 1, kind: "handoff", to: "orch-collide", from: "a-human", at: new Date().toISOString(), body: "an unrelated hand-off, not from any timer" }, null, 2)}\n`, { mode: 0o600 });
    await expect(sendInboxMessageAt({
      to: "orch-collide", kind: "handoff", from: "headroom-timer",
      text: JSON.stringify({ timer: "wake", at: new Date().toISOString(), action: "check the deploy" }),
      delivery_id: collidingId, home: path,
    })).rejects.toThrow(/identity collision/);
    // The unrelated message is untouched -- never overwritten.
    const stored = JSON.parse(await readFile(join(directory, `${collidingId}-handoff.json`), "utf8")) as { body: unknown };
    expect(stored.body).toBe("an unrelated hand-off, not from any timer");
  });

  it("an ordinary hand-off and a timer delivery with different delivery_ids never interfere, even for the same recipient", async () => {
    const path = await home();
    await sendInboxMessage({ to: "session-d", kind: "handoff", text: '{"note":"from a human"}', from: "a-human", home: path, now: new Date(9_000) });
    await sendInboxMessageAt({ to: "session-d", kind: "handoff", text: '{"timer":"wake","at":"2026-09-28T12:00:00.000Z","action":"check"}', from: "headroom-timer", delivery_id: 999_000_000_000_000, home: path, now: new Date(9_500) });
    const result = await readInbox({ session: "session-d", home: path });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((item) => item.from).sort()).toEqual(["a-human", "headroom-timer"]);
  });

  it("rejects a negative or non-integer delivery_id", async () => {
    const path = await home();
    await expect(sendInboxMessageAt({ to: "session-c", kind: "handoff", text: "{}", delivery_id: -1, home: path })).rejects.toThrow(/delivery_id/);
    await expect(sendInboxMessageAt({ to: "session-c", kind: "handoff", text: "{}", delivery_id: 1.5, home: path })).rejects.toThrow(/delivery_id/);
  });
});

describe("headroom inbox", () => {
  it("sends with --text and reads it back over the CLI, then reports an empty inbox", async () => {
    const path = await home();
    const logged = await capture(async () => {
      await withHeadroomHome(path, async () => {
        expect(await main(["inbox", "send", "--to", "session-b", "--kind", "budget", "--text", '{"weekly_share":40}', "--from", "session-a"])).toBe(0);
        expect(await main(["inbox", "--session", "session-b"])).toBe(0);
        expect(await main(["inbox", "--session", "session-b"])).toBe(0);
      });
    });
    expect(logged[0]).toMatch(/^sent \d+-budget\.json to session-b$/);
    expect(logged[1]).toContain("budget  from session-a  {\"weekly_share\":40}");
    expect(logged[2]).toBe("no unread messages for session-b");
  });

  it("sends the contents of --file and prints the queue as JSON", async () => {
    const path = await home();
    const payload = join(tmpdir(), `headroom-handoff-${process.pid}.json`);
    temporary.push(payload);
    await writeFile(payload, JSON.stringify({ lane: "docs", owner: "session-a" }), { mode: 0o600 });
    const logged = await capture(async () => {
      await withHeadroomHome(path, async () => {
        expect(await main(["inbox", "send", "--to", "session-b", "--kind", "handoff", "--file", payload])).toBe(0);
        expect(await main(["inbox", "--session", "session-b", "--json"])).toBe(0);
      });
    });
    const result = JSON.parse(logged[1]) as { session: string; messages: Array<{ kind: string; body: unknown }>; remaining: number };
    expect(result).toMatchObject({ session: "session-b", remaining: 0 });
    expect(result.messages[0]).toMatchObject({ kind: "handoff", body: { lane: "docs", owner: "session-a" } });
  });

  it("refuses both or neither of --file and --text", async () => {
    const path = await home();
    await withHeadroomHome(path, async () => {
      await expect(main(["inbox", "send", "--to", "session-b", "--kind", "note"])).rejects.toThrow(/exactly one of --file or --text/);
      await expect(main(["inbox", "send", "--to", "session-b", "--kind", "note", "--text", "x", "--file", "y"])).rejects.toThrow(/exactly one of --file or --text/);
      await expect(main(["inbox"])).rejects.toThrow(/--session/);
    });
  });
});

describe("quota_inbox", () => {
  it("reads a session's messages over MCP and never offers a way to send", async () => {
    const path = await home();
    await sendInboxMessage({ to: "session-b", kind: "note", text: "hello", home: path, now: new Date(1000) });
    const listed = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const names = ((listed?.result as { tools: Array<{ name: string }> }).tools).map((item) => item.name);
    expect(names).toContain("quota_inbox");
    expect(names.filter((name) => name.includes("inbox"))).toEqual(["quota_inbox"]);
    const reply = await withHeadroomHome(path, () => handleMcp(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quota_inbox", arguments: { session: "session-b" } } }),
      async () => undefined,
    ));
    const result = (reply?.result as { structuredContent: { messages: Array<{ body: unknown }> } }).structuredContent;
    expect(result.messages.map((item) => item.body)).toEqual(["hello"]);
  });

  it("refuses a session id that is not a plain path segment", async () => {
    const reply = await handleMcp(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quota_inbox", arguments: { session: "../../etc" } } }),
      async () => undefined,
    );
    expect((reply?.error as { message: string }).message).toMatch(/session id/);
  });
});

describe("parseBudgetPlan", () => {
  const window = { starts_at: "2026-09-06T09:00:00Z", ends_at: "2026-09-06T14:00:00Z", meter: "claude-main:all", shares: { "session-a": 60, "session-b": 20 } };

  it("accepts a well-formed plan", () => {
    expect(parseBudgetPlan(JSON.stringify({ windows: [window] }))).toEqual({
      windows: [{ starts_at: "2026-09-06T09:00:00.000Z", ends_at: "2026-09-06T14:00:00.000Z", meter: "claude-main:all", shares: [{ owner: "session-a", expect_percent: 60 }, { owner: "session-b", expect_percent: 20 }] }],
    });
  });

  it("names the field that made it invalid", () => {
    expect(() => parseBudgetPlan("not json")).toThrow(/not valid JSON/);
    expect(() => parseBudgetPlan(JSON.stringify({}))).toThrow(/windows array/);
    expect(() => parseBudgetPlan(JSON.stringify({ windows: [] }))).toThrow(/no windows/);
    expect(() => parseBudgetPlan(JSON.stringify({ windows: [{ ...window, ends_at: "2026-09-06T08:00:00Z" }] }))).toThrow(/ends_at must be after starts_at/);
    expect(() => parseBudgetPlan(JSON.stringify({ windows: [{ ...window, meter: "" }] }))).toThrow(/meter is required/);
    expect(() => parseBudgetPlan(JSON.stringify({ windows: [{ ...window, shares: { "../a": 10 } }] }))).toThrow(/invalid session id/);
    expect(() => parseBudgetPlan(JSON.stringify({ windows: [{ ...window, shares: { "session-a": 140 } }] }))).toThrow(/0 through 100/);
    expect(() => parseBudgetPlan(JSON.stringify({ windows: [{ ...window, shares: {} }] }))).toThrow(/shares is empty/);
  });

  it("skips a window that has already ended", () => {
    const plan = parseBudgetPlan(JSON.stringify({ windows: [window, { ...window, starts_at: "2026-09-06T14:00:00Z", ends_at: "2026-09-06T19:00:00Z" }] }));
    const leases = budgetPlanLeases(plan, new Date("2026-09-06T15:00:00Z"));
    expect(leases.map((item) => item.owner)).toEqual(["session-a", "session-b"]);
    expect(leases[0].ttl_ms).toBe(4 * 3_600_000);
    expect(leases[0].note).toBe("plan 2026-09-06T14:00:00.000Z/2026-09-06T19:00:00.000Z");
  });
});

describe("headroom plan import", () => {
  it("turns declared shares into advisory leases gate and spend can see", async () => {
    const path = await home();
    const file = join(tmpdir(), `headroom-plan-${process.pid}.json`);
    temporary.push(file);
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(file, JSON.stringify({ windows: [{ starts_at: new Date().toISOString(), ends_at: endsAt, meter: "claude-main:all", shares: { "session-a": 60, "session-b": 20 } }] }), { mode: 0o600 });
    const logged = await capture(async () => {
      await withHeadroomHome(path, async () => { expect(await main(["plan", "import", file])).toBe(0); });
    });
    expect(logged[logged.length - 1]).toBe("imported 2 advisory leases from 1 window");
    const store = await HeadroomStore.open(path);
    try {
      const leases = store.leases("claude-main:all", true);
      expect(leases.map((item) => [item.owner, item.expected_percent]).sort()).toEqual([["session-a", 60], ["session-b", 20]].sort());
      expect(leases.every((item) => item.note?.startsWith("plan "))).toBe(true);
    } finally { store.close(); }
  });

  it("imports nothing from a plan whose windows are all over", async () => {
    const path = await home();
    const file = join(tmpdir(), `headroom-plan-old-${process.pid}.json`);
    temporary.push(file);
    await writeFile(file, JSON.stringify({ windows: [{ starts_at: "2020-01-01T00:00:00Z", ends_at: "2020-01-01T05:00:00Z", meter: "claude-main:all", shares: { "session-a": 10 } }] }), { mode: 0o600 });
    const logged = await capture(async () => {
      await withHeadroomHome(path, async () => { expect(await main(["plan", "import", file])).toBe(0); });
    });
    expect(logged[0]).toContain("nothing imported");
  });

  it("refuses a missing file argument", async () => {
    const path = await home();
    await withHeadroomHome(path, async () => {
      await expect(main(["plan", "import"])).rejects.toThrow(/plan import <file>/);
    });
  });
});
