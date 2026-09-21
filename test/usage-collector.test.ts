/**
 * usage-collector.ts invariants: incremental reading, replacement/truncation
 * detection, refusal of unsafe inputs, and the atomicity of what one run
 * commits.
 *
 * Every transcript here is synthetic -- the message ids, model ids, aliases
 * and canary strings are invented example values for the test and correspond
 * to no real account, session, path or credential.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod, mkdir, writeFile, appendFile, readFile, truncate, unlink, symlink, open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/usage-store.js";
import { collectUsageFile, canonicalInputDirectory, CollectInputError, type CollectResult } from "../src/usage-collector.js";
import { DEFAULT_IMPORT_BYTES, MIN_IMPORT_BYTES } from "../src/usage-import-options.js";

const notWindows = process.platform !== "win32";
/** Example-only canary: a made-up string that must never reach the database
 * or a result object. Not a credential of any kind. */
const CONTENT_CANARY = "CANARY-EXAMPLE-VALUE-0000";

interface LineOptions {
  id: string;
  ts?: string;
  model?: string;
  usage?: Record<string, unknown>;
  pad?: number;
  content?: string;
}

function line(options: LineOptions): string {
  const entry: Record<string, unknown> = {
    type: "assistant",
    timestamp: options.ts ?? "2026-01-01T00:00:00.000Z",
    message: {
      id: options.id,
      model: options.model ?? "claude-sonnet-5",
      usage: options.usage ?? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      content: options.content ?? "synthetic assistant text",
    },
  };
  if (options.pad) entry.pad = "p".repeat(options.pad);
  return `${JSON.stringify(entry)}\n`;
}

describe("collectUsageFile", () => {
  let root: string;
  let data: string;
  let store: UsageStore;
  let file: string;

  const collect = (overrides: Partial<Parameters<typeof collectUsageFile>[1]> = {}, target = store): Promise<CollectResult> =>
    collectUsageFile(target, { sourceAlias: "source-one", principalAlias: "principal-one", path: file, maxBytes: MIN_IMPORT_BYTES, ...overrides });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "usage-collect-"));
    await chmod(root, 0o700);
    data = join(root, "data");
    await mkdir(data, { mode: 0o700 });
    file = join(data, "session.jsonl");
    store = (await UsageStore.open({ home: join(root, "home"), create: true }))!;
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("imports, then repeats and restarts as a no-op", async () => {
    await writeFile(file, line({ id: "msg-1" }) + line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));

    const first = await collect();
    expect(first.kind).toBe("imported");
    expect(first.counters).toEqual({ accepted_new: 2 });
    expect(first.atEof).toBe(true);
    expect(first.pendingPartial).toBe(false);
    expect(first.budgetExhausted).toBe(false);

    const second = await collect();
    expect(second.counters).toEqual({});
    expect(second.byteOffset).toBe(first.byteOffset);

    // A fresh connection to the same database must resume, not re-import.
    store.close();
    store = (await UsageStore.open({ home: join(root, "home"), create: false }))!;
    const third = await collect();
    expect(third.counters).toEqual({});
    const totals = store.groupedTotals();
    expect(totals).toHaveLength(1);
    expect(totals[0].identityCount).toBe(2);
    expect(totals[0].inputTokens).toEqual({ total: 20, overflow: false, known: 2, unknown: 0 });
  });

  it("deduplicates the same origin's messages arriving from a copy", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    await collect();

    const copy = join(data, "copy.jsonl");
    await writeFile(copy, await readFile(file));
    const result = await collect({ path: copy });
    expect(result.counters).toEqual({ duplicate: 1 });
    expect(store.groupedTotals()[0].identityCount).toBe(1);
  });

  it("takes a newer downward correction and ignores a replayed older one", async () => {
    await writeFile(file, line({ id: "msg-1", usage: { input_tokens: 100, output_tokens: 200 } }));
    await collect();
    await appendFile(file, line({ id: "msg-1", ts: "2026-01-01T00:05:00.000Z", usage: { input_tokens: 7, output_tokens: 8 } }));
    await appendFile(file, line({ id: "msg-1", usage: { input_tokens: 100, output_tokens: 200 } }));

    const result = await collect();
    expect(result.counters).toEqual({ accepted_updated: 1, stale_ignored: 1 });
    expect(store.groupedTotals()[0].inputTokens.total).toBe(7);
  });

  it("keeps a quarantined identity quarantined across runs", async () => {
    const conflicting = line({ id: "msg-1", usage: { input_tokens: 1 } });
    await writeFile(file, line({ id: "msg-1", usage: { input_tokens: 2 } }) + conflicting);
    const first = await collect();
    expect(first.counters).toEqual({ accepted_new: 1, quarantined_new: 1 });

    await appendFile(file, conflicting);
    const second = await collect();
    expect(second.counters).toEqual({ quarantined_repeat: 1 });
    expect(store.groupedTotals()).toEqual([]);
    expect(store.quarantineCount()).toBe(1);
  });

  it("waits for a newline: an empty file, then a partial line, then the rest", async () => {
    await writeFile(file, "");
    const empty = await collect();
    expect(empty.kind).toBe("imported");
    expect(empty.byteOffset).toBe(0);
    expect(empty.atEof).toBe(true);
    expect(empty.pendingPartial).toBe(false);

    const complete = line({ id: "msg-1" });
    await writeFile(file, complete.slice(0, 20));
    const partial = await collect();
    expect(partial.counters).toEqual({});
    expect(partial.byteOffset).toBe(0);
    expect(partial.pendingPartial).toBe(true);
    expect(partial.atEof).toBe(true);

    await writeFile(file, complete);
    const finished = await collect();
    expect(finished.counters).toEqual({ accepted_new: 1 });
    expect(finished.pendingPartial).toBe(false);
    expect(finished.byteOffset).toBe(Buffer.byteLength(complete));
  });

  it("advances across budgets through one oversized line without parsing its tail", async () => {
    // The tail of the oversized line is itself a complete, valid-looking
    // record: if any run treated a mid-line suffix as a standalone line, this
    // identity would show up in the totals.
    const hidden = JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00.000Z", message: { id: "msg-hidden", model: "claude-sonnet-5", usage: { input_tokens: 999 } } });
    await writeFile(file, `${"A".repeat(700_000)}${hidden}\n${line({ id: "msg-after" })}`);

    const counters: Record<string, number> = {};
    const offsets: number[] = [];
    let runs = 0;
    for (;;) {
      const result = await collect();
      expect(result.kind).toBe("imported");
      offsets.push(result.byteOffset);
      for (const [kind, count] of Object.entries(result.counters)) counters[kind] = (counters[kind] ?? 0) + count;
      runs += 1;
      if (result.atEof && !result.discardPending && !result.pendingPartial) break;
      expect(runs).toBeLessThan(12); // must make progress, not spin
    }

    expect(runs).toBeGreaterThan(2); // the line really did span several budgets
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(counters).toEqual({ "rejected:line_too_large": 1, accepted_new: 1 });
    const totals = store.groupedTotals();
    expect(totals[0].identityCount).toBe(1);
    expect(totals[0].inputTokens.total).toBe(10);
  });

  it("rescans after truncation and after replacement without duplicating identities", async () => {
    await writeFile(file, line({ id: "msg-1" }) + line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));
    const first = await collect();
    expect(first.generation).toBe(1);

    await truncate(file, Buffer.byteLength(line({ id: "msg-1" })));
    const truncated = await collect();
    expect(truncated.generation).toBe(2);
    expect(truncated.counters).toEqual({ duplicate: 1 });
    expect(store.groupedTotals()[0].identityCount).toBe(2);

    await unlink(file);
    await writeFile(file, line({ id: "msg-3" }));
    const replaced = await collect();
    expect(replaced.generation).toBe(3);
    expect(replaced.counters).toEqual({ accepted_new: 1 });
    expect(store.groupedTotals()[0].identityCount).toBe(3);
  });

  it("rescans when the fixed prefix is rewritten in place under the same inode", async () => {
    await writeFile(file, line({ id: "msg-1" }) + line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));
    const before = await collect();

    const rewritten = line({ id: "msg-9" }) + line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" });
    expect(Buffer.byteLength(rewritten)).toBe(before.byteOffset); // same size, same inode
    await writeFile(file, rewritten);

    const after = await collect();
    expect(after.generation).toBe(2);
    expect(after.counters).toEqual({ accepted_new: 1, duplicate: 1 });
    expect(store.groupedTotals()[0].identityCount).toBe(3);
  });

  it("refuses to resume past an edit behind the cursor, committing nothing", async () => {
    // Long enough that the edited line sits past the fixed prefix window, so
    // this exercises the boundary check rather than the prefix check.
    let body = "";
    for (let i = 0; i < 8; i += 1) body += line({ id: `msg-${i}`, ts: `2026-01-01T00:0${i}:00.000Z`, pad: 900 });
    await writeFile(file, body);
    const first = await collect();
    expect(first.counters).toEqual({ accepted_new: 8 });

    const cursorBefore = store.getCursor(first.cursorKey)!;
    const countersBefore = store.counters();
    const edited = Buffer.from(body);
    edited.write("q", edited.length - 500); // same length, past the prefix, behind the cursor
    await writeFile(file, edited);

    const interruptedRun = await collect();
    expect(interruptedRun.kind).toBe("interrupted");
    expect(interruptedRun.interruptReason).toBe("boundary_changed");
    expect(interruptedRun.counters).toEqual({});
    expect(store.getCursor(first.cursorKey)).toEqual(cursorBefore);
    expect(store.counters()).toEqual(countersBefore);
  });

  it("commits nothing when another collector wrote the cursor during this run's reads", async () => {
    await writeFile(file, line({ id: "msg-1" }) + line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));
    const other = (await UsageStore.open({ home: join(root, "home"), create: false }))!;
    try {
      let racingResult: CollectResult | undefined;
      // Deterministic seam: the second collector runs to completion inside the
      // first one's window between "finished reading" and "started writing".
      const first = await collect({
        afterRead: async () => {
          if (!racingResult) racingResult = await collect({}, other);
        },
      });

      expect(racingResult!.kind).toBe("imported");
      expect(racingResult!.counters).toEqual({ accepted_new: 2 });
      expect(first.kind).toBe("interrupted");
      expect(first.interruptReason).toBe("concurrent_update");
      expect(first.counters).toEqual({});

      const cursor = store.getCursor(racingResult!.cursorKey)!;
      expect(cursor.revision).toBe(1);
      expect(cursor.byteOffset).toBe(racingResult!.byteOffset);
      expect(store.counters().filter((c) => c.kind === "accepted_new")).toEqual([{ cursorKey: cursor.cursorKey, kind: "accepted_new", count: 2 }]);
      expect(store.groupedTotals()[0].identityCount).toBe(2);

      // A retry after losing the race is an ordinary resumed run.
      const retry = await collect();
      expect(retry.kind).toBe("imported");
      expect(retry.counters).toEqual({});
      expect(retry.byteOffset).toBe(cursor.byteOffset);
      expect(store.groupedTotals()[0].identityCount).toBe(2);
    } finally {
      other.close();
    }
  });

  it("commits nothing when the bytes it is reading are rewritten mid-scan", async () => {
    let body = "";
    for (let i = 0; i < 120; i += 1) body += line({ id: `msg-${i}`, ts: "2026-01-01T00:00:00.000Z", pad: 900 });
    await writeFile(file, body);

    let rewrites = 0;
    const result = await collect({
      afterChunk: async () => {
        if (rewrites > 0) return;
        rewrites += 1;
        // Same inode, same length, different bytes: the file is rewritten
        // underneath a scan that has already consumed part of it.
        await writeFile(file, body.replace(/"msg-1"/, '"msg-X"'));
      },
    });

    expect(rewrites).toBe(1);
    expect(result.kind).toBe("interrupted");
    expect(result.interruptReason).toBe("changed_during_scan");
    expect(result.counters).toEqual({});
    expect(store.allCursors()).toEqual([]);
    expect(store.groupedTotals()).toEqual([]);
    expect(store.counters()).toEqual([]);
  });

  it("detects a rewrite of consumed bytes that leaves the file's head intact", async () => {
    // ~10KB: past the fixed prefix, inside one chunk, so the edit lands after
    // the bytes were consumed and is caught by comparing the consumed tail
    // against what is on disk -- not by the prefix anchor.
    let body = "";
    for (let i = 0; i < 10; i += 1) body += line({ id: `msg-${i}`, ts: "2026-01-01T00:00:00.000Z", pad: 900 });
    await writeFile(file, body);

    let edits = 0;
    const result = await collect({
      afterChunk: async () => {
        if (edits > 0) return;
        edits += 1;
        const edited = Buffer.from(body);
        edited.write("q", edited.length - 300);
        await writeFile(file, edited);
      },
    });

    expect(result.kind).toBe("interrupted");
    expect(result.interruptReason).toBe("changed_during_scan");
    expect(store.allCursors()).toEqual([]);
    expect(store.groupedTotals()).toEqual([]);
  });

  it("detects a same-length rewrite in the middle of the range it is ingesting", async () => {
    // ~120KB across two read chunks. The edit lands at byte 20000: past the
    // fixed 4KiB prefix anchor, far before the trailing 4KiB anchor, same
    // length, same inode -- so only validating the whole consumed range can
    // catch it.
    let body = "";
    for (let i = 0; i < 120; i += 1) body += line({ id: `msg-${i}`, ts: "2026-01-01T00:00:00.000Z", pad: 900 });
    expect(body.length).toBeGreaterThan(100_000);
    const edited = Buffer.from(body);
    edited.write("q", 20_000);
    expect(edited.subarray(0, 4096).equals(Buffer.from(body).subarray(0, 4096))).toBe(true);
    expect(edited.subarray(edited.length - 4096).equals(Buffer.from(body).subarray(body.length - 4096))).toBe(true);
    expect(edited.length).toBe(Buffer.byteLength(body));

    await writeFile(file, body);
    let rewrites = 0;
    const result = await collect({
      afterChunk: async () => {
        if (rewrites > 0) return;
        rewrites += 1;
        await writeFile(file, edited);
      },
    });

    expect(rewrites).toBe(1);
    expect(result.kind).toBe("interrupted");
    expect(result.interruptReason).toBe("changed_during_scan");
    expect(result.counters).toEqual({});
    expect(store.allCursors()).toEqual([]);
    expect(store.groupedTotals()).toEqual([]);
    expect(store.counters()).toEqual([]);
  });

  it("reports the file being replaced at its path while the read descriptor is open", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    const result = await collect({
      afterRead: async () => {
        await unlink(file);
        await writeFile(file, line({ id: "msg-2" }));
      },
    });

    expect(result.kind).toBe("interrupted");
    expect(result.interruptReason).toBe("changed_during_scan");
    expect(store.allCursors()).toEqual([]);
    expect(store.groupedTotals()).toEqual([]);

    // The retry sees only the file that is actually there now.
    const retry = await collect();
    expect(retry.kind).toBe("imported");
    expect(retry.counters).toEqual({ accepted_new: 1 });
  });

  it("still commits when the only concurrent change is an append past the read range", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    const result = await collect({
      afterRead: async () => {
        await appendFile(file, line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));
      },
    });

    expect(result.kind).toBe("imported");
    expect(result.counters).toEqual({ accepted_new: 1 });
    const next = await collect();
    expect(next.counters).toEqual({ accepted_new: 1 });
    expect(store.groupedTotals()[0].identityCount).toBe(2);
  });

  it("caps per-batch work on a file of very short lines and resumes without loss", async () => {
    const tiny = '{"type":"user"}\n';
    await writeFile(file, tiny.repeat(25_000) + line({ id: "msg-1" }));

    const counters: Record<string, number> = {};
    const offsets: number[] = [];
    let runs = 0;
    let sawCappedRun = false;
    for (;;) {
      const result = await collect({ maxBytes: DEFAULT_IMPORT_BYTES });
      expect(result.kind).toBe("imported");
      offsets.push(result.byteOffset);
      for (const [kind, count] of Object.entries(result.counters)) counters[kind] = (counters[kind] ?? 0) + count;
      runs += 1;
      if (result.atEof && !result.pendingPartial && !result.discardPending) break;
      expect(result.budgetExhausted).toBe(true);
      sawCappedRun = true;
      expect(runs).toBeLessThan(10);
    }

    expect(sawCappedRun).toBe(true);
    expect(runs).toBe(3); // 25001 lines, 10000 per batch
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(counters).toEqual({ "skipped:unrecognized_record_type": 25_000, accepted_new: 1 });
    expect(store.groupedTotals()[0].identityCount).toBe(1);
  });

  it("refuses to re-attribute an already-imported file to another source or principal", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    await collect();
    const totalsBefore = store.groupedTotals();

    const otherSource = await collect({ sourceAlias: "source-two" });
    expect(otherSource.kind).toBe("source_conflict");
    expect(otherSource.counters).toEqual({});

    const otherPrincipal = await collect({ principalAlias: "principal-two" });
    expect(otherPrincipal.kind).toBe("principal_conflict");

    expect(store.allCursors()).toHaveLength(1);
    expect(store.allCursors()[0].revision).toBe(1);
    expect(store.groupedTotals()).toEqual(totalsBefore);
  });

  it("withholds a job claim when one identity is claimed by two jobs", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    const first = await collect({ jobAlias: "job-alpha" });
    expect(first.jobConflictIdentities).toBe(0);
    expect(store.jobConflictCount()).toBe(0);

    const copy = join(data, "copy.jsonl");
    await writeFile(copy, await readFile(file));
    const second = await collect({ path: copy, jobAlias: "job-beta" });
    expect(second.kind).toBe("imported");
    expect(second.jobConflictIdentities).toBe(1);
    expect(store.jobConflictCount()).toBe(1);
    // The numeric data is untouched: a disputed label is not a disputed count.
    expect(store.groupedTotals()[0].identityCount).toBe(1);
    expect(store.groupedTotals()[0].inputTokens.total).toBe(10);
  });

  it("withholds a second job claim on one file without overwriting the first", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    const first = await collect({ jobAlias: "job-alpha" });
    const boundJob = store.getCursor(first.cursorKey)!.jobKey;

    await appendFile(file, line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));
    const second = await collect({ jobAlias: "job-beta" });
    expect(second.jobConflict).toBe(true);
    expect(second.counters).toEqual({ accepted_new: 1 });
    expect(store.getCursor(first.cursorKey)!.jobKey).toBe(boundJob);
    expect(store.getCursor(first.cursorKey)!.jobConflict).toBe(true);
  });

  it("reports missing counters as unknown rather than zero", async () => {
    await writeFile(file, line({ id: "msg-1", usage: {} }));
    const result = await collect();
    expect(result.counters).toEqual({ accepted_new: 1 });
    const totals = store.groupedTotals()[0];
    expect(totals.inputTokens).toEqual({ total: null, overflow: false, known: 0, unknown: 1 });
    expect(totals.outputTokens.total).toBeNull();
  });

  it("keeps transcript content, unknown model ids and the input path out of the database and the result", async () => {
    const pathCanary = join(data, "CANARY-PATH-SEGMENT");
    await mkdir(pathCanary, { mode: 0o700 });
    const canaryFile = join(pathCanary, "session.jsonl");
    await writeFile(canaryFile,
      line({ id: "msg-1", content: CONTENT_CANARY }) +
      line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z", model: "claude-internal-CANARY-MODEL" }) +
      `{"type":"assistant","timestamp":"2026-01-01T00:02:00.000Z","message":{"id":"msg-3","model":"claude-sonnet-5","usage":"${CONTENT_CANARY}"}}\n`);

    const result = await collect({ path: canaryFile });
    expect(result.counters).toMatchObject({ accepted_new: 1, "rejected:unknown_model": 1 });
    expect(JSON.stringify(result)).not.toContain("CANARY");

    store.close();
    const bytes = await readFile(join(root, "home", "usage.db"), "utf8");
    store = (await UsageStore.open({ home: join(root, "home"), create: false }))!;
    for (const canary of [CONTENT_CANARY, "CANARY-MODEL", "CANARY-PATH-SEGMENT", "synthetic assistant text"]) {
      expect(bytes).not.toContain(canary);
    }
  });

  it("refuses a directory and a missing file with fixed reasons", async () => {
    await expect(collect({ path: data })).rejects.toMatchObject({ reason: "is_directory" });
    await expect(collect({ path: join(data, "absent.jsonl") })).rejects.toMatchObject({ reason: "not_found" });
    await expect(collect({ path: join(data, "absent.jsonl") })).rejects.toBeInstanceOf(CollectInputError);
  });

  it.skipIf(!notWindows)("refuses a symlinked leaf and a user-owned symlinked parent directory", async () => {
    await writeFile(file, line({ id: "msg-1" }));

    const linkLeaf = join(data, "link.jsonl");
    await symlink(file, linkLeaf);
    await expect(collect({ path: linkLeaf })).rejects.toMatchObject({ reason: "symlink_refused" });
    // The symlink's target is untouched by the refusal.
    expect(await readFile(file, "utf8")).toBe(line({ id: "msg-1" }));

    const linkDir = join(root, "linkdir");
    await symlink(data, linkDir);
    await expect(collect({ path: join(linkDir, "session.jsonl") })).rejects.toMatchObject({ reason: "parent_symlink_refused" });

    expect(store.allCursors()).toEqual([]);
  });

  it.skipIf(!notWindows)("refuses a group or world writable input file", async () => {
    await writeFile(file, line({ id: "msg-1" }));
    await chmod(file, 0o666);
    await expect(collect()).rejects.toMatchObject({ reason: "unsafe_permissions" });
    await chmod(file, 0o600);
    expect((await collect()).kind).toBe("imported");
  });

  it.skipIf(!notWindows)("refuses an input whose parent directory is world writable without the sticky bit", async () => {
    const loose = join(root, "loose");
    await mkdir(loose, { mode: 0o777 });
    await chmod(loose, 0o777);
    const target = join(loose, "session.jsonl");
    await writeFile(target, line({ id: "msg-1" }), { mode: 0o600 });
    await expect(collect({ path: target })).rejects.toMatchObject({ reason: "unsafe_ancestry" });
  });

  it("resolves two spellings of the same file to one cursor", async () => {
    // On macOS the temp root also sits under the root-owned /var alias, which
    // is the one intermediary link shape this collector follows.
    await writeFile(file, line({ id: "msg-1" }));
    const first = await collect();
    const viaDots = join(data, "..", "data", "session.jsonl");
    const second = await collect({ path: viaDots });
    expect(second.cursorKey).toBe(first.cursorKey);
    expect(second.counters).toEqual({});
    expect(store.allCursors()).toHaveLength(1);
  });

  it("rolls the whole batch back when persistence fails mid-transaction", async () => {
    await writeFile(file, line({ id: "msg-1" }) + line({ id: "msg-2", ts: "2026-01-01T00:01:00.000Z" }));
    const failing = Object.create(store) as UsageStore;
    let calls = 0;
    Object.defineProperty(failing, "applyAndPersist", {
      value: (snapshot: Parameters<UsageStore["applyAndPersist"]>[0]) => {
        calls += 1;
        if (calls === 2) throw new Error("synthetic persistence failure");
        return store.applyAndPersist(snapshot);
      },
    });

    await expect(collect({}, failing)).rejects.toThrow("synthetic persistence failure");
    expect(store.groupedTotals()).toEqual([]);
    expect(store.allCursors()).toEqual([]);
    expect(store.counters()).toEqual([]);

    const retry = await collect();
    expect(retry.counters).toEqual({ accepted_new: 2 });
  });

  it.skipIf(process.platform !== "win32")("refuses a parent junction on Windows", async () => {
    // Junctions need no elevation, which is exactly why they have to be
    // refused rather than skipped. Runs only on a Windows host.
    await writeFile(file, line({ id: "msg-1" }));
    const junction = join(root, "junctiondir");
    await symlink(data, junction, "junction");
    await expect(collect({ path: join(junction, "session.jsonl") })).rejects.toMatchObject({ reason: "parent_symlink_refused" });
    expect(store.allCursors()).toEqual([]);
  });

  it("refuses a path that became a directory", async () => {
    const handle = await openFile(file, "w", 0o600);
    await handle.close();
    await rm(file);
    await mkdir(file, { mode: 0o700 });
    await expect(collect()).rejects.toMatchObject({ reason: "is_directory" });
  });
});

/**
 * The ancestry policy itself, driven through its injectable filesystem so the
 * Windows branch is exercised from any host: reparse points cannot be
 * simulated with real files on POSIX, and a Windows CI run is the only place
 * the native case above executes.
 */
describe("canonicalInputDirectory", () => {
  const entry = (kind: "dir" | "link", uid = 501): unknown => ({
    isSymbolicLink: () => kind === "link",
    isDirectory: () => kind === "dir",
    uid,
  });

  const walk = (path: string, platform: NodeJS.Platform, entries: Record<string, unknown>, links: Record<string, string> = {}) =>
    canonicalInputDirectory(path, {
      platform,
      lstat: (async (target: string) => {
        const found = entries[String(target)];
        if (!found) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return found;
      }) as never,
      realpath: (async (target: string) => links[String(target)] ?? target) as never,
    });

  it("refuses every parent reparse point on Windows, junction or symlink", async () => {
    await expect(walk("C:\\Users\\you\\linked\\session.jsonl", "win32", {
      "C:\\Users": entry("dir"),
      "C:\\Users\\you": entry("dir"),
      // A junction reports as a symbolic link; on Windows uid is meaningless,
      // so a root-owned exception must not be honoured here.
      "C:\\Users\\you\\linked": entry("link", 0),
    })).rejects.toMatchObject({ reason: "parent_symlink_refused" });
  });

  it("walks from the drive root and returns the canonical Windows directory", async () => {
    const result = await walk("C:\\Users\\you\\logs\\session.jsonl", "win32", {
      "C:\\Users": entry("dir"),
      "C:\\Users\\you": entry("dir"),
      "C:\\Users\\you\\logs": entry("dir"),
    });
    expect(result).toBe("C:\\Users\\you\\logs");
  });

  it("walks from a UNC share root without treating the share as a component", async () => {
    const result = await walk("\\\\server\\share\\logs\\session.jsonl", "win32", {
      "\\\\server\\share\\logs": entry("dir"),
    });
    expect(result).toBe("\\\\server\\share\\logs");
  });

  it("follows a root-owned system alias on POSIX and refuses a user-owned one", async () => {
    const entries = {
      "/var": entry("link", 0),
      "/private/var/data": entry("dir"),
      "/private/var": entry("dir"),
    };
    expect(await walk("/var/data/session.jsonl", "linux", entries, { "/var": "/private/var" })).toBe("/private/var/data");

    await expect(walk("/var/data/session.jsonl", "linux", { ...entries, "/var": entry("link", 501) }, { "/var": "/private/var" }))
      .rejects.toMatchObject({ reason: "parent_symlink_refused" });
  });
});
