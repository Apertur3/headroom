import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, safeSum } from '../src/usage-store.js';
import type { ClaudeUsageSnapshot } from '../src/usage-events.js';

// Synthetic fixtures only. No actual accounts, private paths, or endpoints.
const IDENTITY = 'a'.repeat(32);
const SOURCE = 'b'.repeat(32);
const PRINCIPAL = 'c'.repeat(32);
const MODEL = 'claude-sonnet-5';
const TS = Date.parse('2026-01-01T00:00:00Z');

function snapshot(overrides: Partial<ClaudeUsageSnapshot> = {}): ClaudeUsageSnapshot {
  return {
    identityKey: IDENTITY,
    sourceKey: SOURCE,
    principalKey: PRINCIPAL,
    model: MODEL,
    observedAtMs: TS,
    sequence: 0,
    usage: {
      input_tokens: { value: 10, diagnosis: null },
      output_tokens: { value: 20, diagnosis: null },
      cache_read_input_tokens: { value: 30, diagnosis: null },
      cache_creation_input_tokens: { value: 40, diagnosis: null },
      cache_creation_breakdown: null,
    },
    ...overrides,
  };
}

describe('UsageStore Regression', () => {
  let root: string;
  let store: UsageStore | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'usage-test-'));
    await chmod(root, 0o700);
  });

  afterEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('1. transaction rollback on error', async () => {
    store = await UsageStore.open({ home: root, create: true });
    const snap1 = snapshot();
    const snap2 = snapshot({ usage: { ...snap1.usage, input_tokens: { value: 99, diagnosis: null } } });

    expect(() => {
      store!.withTransaction(() => {
        store!.applyAndPersist(snap1);
        store!.applyAndPersist(snap2);
        throw new Error('Synthetic Fixed Error');
      });
    }).toThrow('Synthetic Fixed Error');

    expect(store!.groupedTotals()).toEqual([]);
    expect(store!.quarantineCount()).toBe(0);
  });

  it('2. repeated identical snapshot returns duplicate', async () => {
    store = await UsageStore.open({ home: root, create: true });
    const snap = snapshot();

    const outcome1 = store!.applyAndPersist(snap);
    expect(outcome1).toBe('accepted_new');

    const outcome2 = store!.applyAndPersist(snap);
    expect(outcome2).toBe('duplicate');

    const totals = store!.groupedTotals();
    expect(totals).toHaveLength(1);
    expect(totals[0].identityCount).toBe(1);
    expect(totals[0].inputTokens.total).toBe(10);
  });

  it('3. newer downward correction', async () => {
    store = await UsageStore.open({ home: root, create: true });
    const original = snapshot();
    const corrected = snapshot({
      observedAtMs: TS + 1000,
      usage: { ...original.usage, output_tokens: { value: 5, diagnosis: null } }
    });

    store!.applyAndPersist(original);
    const outcome = store!.applyAndPersist(corrected);
    expect(outcome).toBe('accepted_updated');

    store!.applyAndPersist(original);

    const totals = store!.groupedTotals();
    expect(totals).toHaveLength(1);
    expect(totals[0].outputTokens.total).toBe(5);
  });

  it('4. same timestamp conflict permanent quarantine', async () => {
    store = await UsageStore.open({ home: root, create: true });
    const snap1 = snapshot();
    const snap2 = snapshot({ usage: { ...snap1.usage, input_tokens: { value: 11, diagnosis: null } } });

    store!.applyAndPersist(snap1);
    const outcome2 = store!.applyAndPersist(snap2);
    expect(outcome2).toBe('quarantined_new');

    const filter = { sourceKeyHash: SOURCE, principalKeyHash: PRINCIPAL };
    expect(store!.quarantineCount(filter)).toBe(1);

    const snap3 = snapshot({ observedAtMs: TS + 1000, usage: { ...snap1.usage, input_tokens: { value: 12, diagnosis: null } } });
    const outcome3 = store!.applyAndPersist(snap3);
    expect(outcome3).toBe('quarantined_repeat');

    expect(store!.groupedTotals()).toEqual([]);
  });

  it('5. invalid snapshot model throws and does not persist', async () => {
    store = await UsageStore.open({ home: root, create: true });
    const invalidSnap = snapshot({ model: 'SECRET_CANARY_DO_NOT_PERSIST' });

    expect(() => {
      store!.applyAndPersist(invalidSnap);
    }).toThrow();

    expect(store!.groupedTotals()).toEqual([]);

    const dbPath = join(root, 'usage.db');
    const dbContent = await readFile(dbPath);
    const dbString = dbContent.toString('utf8');
    expect(dbString).not.toContain('SECRET_CANARY_DO_NOT_PERSIST');
  });

  it('6. safeSum behavior', () => {
    const res1 = safeSum([null, null]);
    expect(res1).toEqual({ total: null, overflow: false, known: 0, unknown: 2 });

    const res2 = safeSum([10, null]);
    expect(res2).toEqual({ total: 10, overflow: false, known: 1, unknown: 1 });

    const res3 = safeSum([Number.MAX_SAFE_INTEGER, 1]);
    expect(res3).toEqual({ total: null, overflow: true, known: 2, unknown: 0 });
  });
});