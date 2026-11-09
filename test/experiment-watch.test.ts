import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { experimentItems, experimentMarks } from "../src/experiment-watch.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// Synthetic IDs and a fake token: the watch must never echo more than three hex characters.
const slots = (atis: string) => JSON.stringify({ oauthAccount: { token: "secret-token" }, clientDataCacheSlots: { a: { model: "claude-opus-5-5", entrypoint: "cli", at: Date.parse("2026-11-09T13:20:00Z"), org: "org-x", data: { atis } } } });

it("alerts once when a profile enters a test, stays quiet while it holds, and once when it clears", async () => {
  const home = await mkdtemp(join(tmpdir(), "headroom-experiment-"));
  temporary.push(home);
  await mkdir(join(home, ".claude"));
  await writeFile(join(home, ".claude.json"), slots("v1.87b0297b.signed-part"));
  await mkdir(join(home, ".claude2", "projects", "p"), { recursive: true });
  await writeFile(join(home, ".claude2", "projects", "p", "s.jsonl"), '{"type":"atis-latch","atis":"","sessionId":"s-1"}\n{"type":"atis-latch","atis":"06bf11","sessionId":"s-1"}\n');
  const store = await HeadroomStore.open(join(home, ".headroom"));
  try {
    const now = new Date();
    const first = experimentItems(store, now, home).map((item) => item.text);
    expect(first).toEqual([expect.stringMatching(/^🧪 claude-opus-5-5 \(cli, claude\) is in test 87b since \d\d:\d\d$/), expect.stringMatching(/^🧪 Claude Code \(claude2\) is in test 06b since \d\d:\d\d$/)]);
    expect(JSON.stringify(first) + (store.daemonState("experiment_watch") ?? "")).not.toMatch(/secret|org-x|s-1|0297/);
    expect(experimentItems(store, new Date(now.getTime() + 60_000), home)).toEqual([]);
    expect(experimentItems(store, new Date(now.getTime() + 2 * 3_600_000), home)).toEqual([]);
    expect(experimentMarks(store)).toEqual(["claude-opus-5-5 (cli, claude) in test 87b", "Claude Code (claude2) in test 06b"]);
    await writeFile(join(home, ".claude.json"), slots(""));
    expect(experimentItems(store, new Date(now.getTime() + 4 * 3_600_000), home).map((item) => item.text)).toEqual(["🧪 claude-opus-5-5 (cli, claude) left test 87b"]);
    expect(experimentMarks(store)).toEqual(["Claude Code (claude2) in test 06b"]);
  } finally { store.close(); }
});
