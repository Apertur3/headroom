#!/usr/bin/env node
// Narrow compatibility patch for pinned CodexBar v0.56.4. Its summary path
// already fetches GetUserStatus, but retains only identity from that response.
// Remove when upstream CodexBar exposes that read's full model list.
import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = '// Headroom model catalog preservation v1';
const replacements = [
  ['    public let modelQuotas: [AntigravityModelQuota]',
   `    ${marker}\n    public let modelCatalog: [AntigravityModelQuota]?\n    public let modelQuotas: [AntigravityModelQuota]`],
  ['        source: AntigravityModelQuotaSource = .remote)',
   '        source: AntigravityModelQuotaSource = .remote,\n        modelCatalog: [AntigravityModelQuota]? = nil)'],
  ['        self.modelQuotas = modelQuotas',
   '        self.modelCatalog = modelCatalog\n        self.modelQuotas = modelQuotas'],
  ['        source: AntigravityModelQuotaSource = .local)\n    {\n        self.modelQuotas = []',
   '        source: AntigravityModelQuotaSource = .local,\n        modelCatalog: [AntigravityModelQuota]? = nil)\n    {\n        self.modelCatalog = modelCatalog\n        self.modelQuotas = []'],
  ['                accountPlan: accountPlan,\n                source: self.source)',
   '                accountPlan: accountPlan,\n                source: self.source,\n                modelCatalog: snapshot.modelCatalog)'],
  ['            accountPlan: planName,\n            source: .local)',
   '            accountPlan: planName,\n            source: .local,\n            modelCatalog: modelConfigs.isEmpty ? nil : modelConfigs.map {\n                AntigravityModelQuota(label: $0.label, modelId: $0.modelOrAlias.model,\n                    remainingFraction: nil, resetTime: nil, resetDescription: nil)\n            })'],
];

function snapshotConstructions(source) {
  return [...source.matchAll(/\bAntigravityStatusSnapshot\s*\(/g)].length;
}

export function patchSource(source) {
  // Initializers have optional catalogs for summary/remote-only reads. Guard
  // every construction path so upstream additions cannot silently default nil.
  if (snapshotConstructions(source) !== 4) throw new Error('Unexpected Antigravity snapshot construction paths');
  if (source.includes(marker)) {
    if (!replacements.every(([, patched]) => source.split(patched).length === 2)) throw new Error('Incomplete model catalog patch');
    return source;
  }
  for (const [original, patched] of replacements) {
    if (source.split(original).length !== 2) throw new Error('CodexBar model catalog patch does not match pinned source');
    source = source.replace(original, patched);
  }
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkout = process.argv[2] ?? 'engine/.build/checkouts/codexbar';
  const sources = resolve(checkout, 'Sources');
  const expected = new Map([
    ['CodexBarCore/Providers/Antigravity/AntigravityStatusProbe.swift', 4],
    ['CodexBarCore/Providers/Antigravity/AntigravityQuotaSummaryParser.swift', 1],
    ['CodexBarCore/Providers/Antigravity/AntigravityRemoteUsageFetcher.swift', 1],
  ]);
  for (const path of await readdir(sources, { recursive: true })) {
    if (!path.endsWith('.swift')) continue;
    const count = snapshotConstructions(await readFile(resolve(sources, path), 'utf8'));
    const key = path.replaceAll('\\', '/');
    if (count !== (expected.get(key) ?? 0)) throw new Error(`Unexpected Antigravity snapshot construction paths in ${key}`);
    expected.delete(key);
  }
  if (expected.size) throw new Error('Missing Antigravity snapshot construction sources');
  const file = resolve(sources, 'CodexBarCore/Providers/Antigravity/AntigravityStatusProbe.swift');
  const original = await readFile(file, 'utf8');
  const patched = patchSource(original);
  if (patched !== original) {
    const mode = (await stat(file)).mode;
    const temporary = `${file}.tmp.${process.pid}`;
    try {
      await writeFile(temporary, patched, { flag: 'wx', mode });
      await chmod(temporary, mode);
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
}
