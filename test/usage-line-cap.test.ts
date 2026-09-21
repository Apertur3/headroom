// All inputs in this test are synthetic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore } from '../src/usage-store.js';
import { collectUsageFile } from '../src/usage-collector.js';
import { MAX_LINE_BYTES } from '../src/usage-events.js';
import { DEFAULT_IMPORT_BYTES } from '../src/usage-import-options.js';

describe('usage-collector regression', () => {
  let root: string;
  let home: string;
  let file: string;
  let store: UsageStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'usage-test-'));
    await chmod(root, 0o700);
    home = join(root, 'home');
    file = join(root, 'session.jsonl');
    store = (await UsageStore.open({ home, create: true }))!;
    const content = '{"type":"user"}\n'.repeat(9999) + 'x'.repeat(MAX_LINE_BYTES * 2) + '\n' + JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id: 'msg-after', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
    await writeFile(file, content);
  });

  afterAll(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('caps events at MAX_BATCH_EVENTS and resumes correctly', async () => {
    const request = { sourceAlias: 'local', principalAlias: 'main', path: file, maxBytes: DEFAULT_IMPORT_BYTES };
    const first = await collectUsageFile(store, request);
    expect(first.kind).toBe('imported');
    expect(first.budgetExhausted).toBe(true);
    expect(first.discardPending).toBe(true);
    expect(first.counters['skipped:unrecognized_record_type']).toBe(9999);
    expect(first.counters['rejected:line_too_large']).toBe(1);
    expect(first.counters.accepted_new).toBeUndefined();
    expect(Object.values(first.counters).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(store.groupedTotals()).toHaveLength(0);

    const second = await collectUsageFile(store, request);
    expect(second.kind).toBe('imported');
    expect(second.counters.accepted_new).toBe(1);
    expect(second.atEof).toBe(true);
    expect(second.discardPending).toBe(false);
    expect(store.groupedTotals()).toHaveLength(1);
    expect(store.groupedTotals()[0].identityCount).toBe(1);
    expect(store.counters().find(c => c.kind === 'rejected:line_too_large')?.count).toBe(1);
  });
});