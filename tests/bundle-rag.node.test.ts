// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateExtraConfig,
  validateExtraDiagnosis,
  validateSeedIndex,
  verifyPair,
} from '../../realvirtual-Connect~/tools/bundle-rag.mjs';

// packRagZip/tarExecutable are not declared in bundle-rag.d.mts; the non-literal specifier keeps
// tsc out of the module while vitest resolves it normally.
const bundleRagModule = async () => (await import(
  new URL('../../realvirtual-Connect~/tools/bundle-rag.mjs', import.meta.url).href
)) as {
  canonicalizeSummary: (summaryPath: string) => void;
  packRagZip: (stage: string, ragZip: string) => string;
  tarExecutable: () => string;
};

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('RAG delivery schema and seed provenance', () => {
  it('accepts and canonicalizes the final pilot preset fields', () => {
    expect(validateExtraDiagnosis({
      _comment: 'delivery notes',
      Tools: 'TrUe',
      ToolCapableModels: ['policy/diagnose'],
      GlobalContext: 'FALSE',
      TopK: 8,
    })).toEqual({
      Tools: 'true',
      ToolCapableModels: ['policy/diagnose'],
      GlobalContext: 'false',
      TopK: 8,
    });
    expect(validateExtraDiagnosis({ Tools: false, GlobalContext: true })).toEqual({
      Tools: 'false',
      GlobalContext: 'true',
    });
    expect(() => validateExtraDiagnosis({ BaseUrl: 'https://wrong.invalid' })).toThrow(/Unknown/);
    expect(() => validateExtraDiagnosis({ Tools: { _comment: 'nested note', enabled: true } })).toThrow(/boolean/);
  });

  it('rejects model, dimension, or document-manifest drift before indexing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-rag-seed-test-'));
    temporary.push(root);
    const docs = join(root, 'docs');
    mkdirSync(docs);
    const bytes = Buffer.from('fixture-pdf');
    writeFileSync(join(docs, 'manual.pdf'), bytes);
    const index = join(root, 'vector-index.json');
    const valid = {
      meta: { embeddingModel: 'model-a', dimension: 3, version: 3 },
      manifest: { 'manual.pdf': createHash('sha256').update(bytes).digest('hex') },
      chunks: [{ vector: [1, 0, 0] }],
    };
    writeFileSync(index, JSON.stringify(valid));
    expect(() => validateSeedIndex(index, docs, 'model-a')).not.toThrow();
    expect(() => validateSeedIndex(index, docs, 'model-b')).toThrow(/model/);
    writeFileSync(index, JSON.stringify({ ...valid, chunks: [{ vector: [1, 0] }] }));
    expect(() => validateSeedIndex(index, docs, 'model-a')).toThrow(/dimension/);
    writeFileSync(index, JSON.stringify({ ...valid, manifest: { 'manual.pdf': '0'.repeat(64) } }));
    expect(() => validateSeedIndex(index, docs, 'model-a')).toThrow(/hash/);
  });

  it('two runs on identical input produce a byte-identical rag.zip (same sha256)', async () => {
    const { canonicalizeSummary, packRagZip, tarExecutable } = await bundleRagModule();
    const root = mkdtempSync(join(tmpdir(), 'rv-rag-determinism-test-'));
    temporary.push(root);
    const files: Record<string, string> = {
      'docs/b-manual.pdf': 'fixture-pdf-b',
      'docs/a-manual.pdf': 'fixture-pdf-a',
      'docs/sub/c-manual.pdf': 'fixture-pdf-c',
      'runtime/vector-index.json': '{"chunks":[]}',
      'runtime/vector-index.summary.json': '{}',
    };
    const shas: string[] = [];
    for (const [run, index] of [['first', 0], ['second', 1]] as const) {
      const stage = join(root, run, 'zip-stage');
      // Reverse creation order on the second run: entry order must come from sorting,
      // never from readdir/creation order.
      const names = index === 0 ? Object.keys(files) : Object.keys(files).reverse();
      for (const name of names) {
        const path = join(stage, name);
        mkdirSync(join(path, '..'), { recursive: true });
        // The indexer stamps lastSuccessfulSyncUtc with the build wall clock — deliberately
        // different per run; canonicalization must null it away before packing.
        const content = name === 'runtime/vector-index.summary.json'
          ? JSON.stringify({
              version: 3, docs: 3, chunks: 0, dim: 0, embeddingModel: 'model-a',
              lastSuccessfulSyncUtc: new Date(1_700_000_000_000 + index * 3_600_000).toISOString(),
            })
          : files[name];
        writeFileSync(path, content);
        // Deliberately different mtimes per run — packing must normalize them away.
        const stamp = new Date(Date.now() + index * 60_000);
        utimesSync(path, stamp, stamp);
      }
      const summaryPath = join(stage, 'runtime', 'vector-index.summary.json');
      canonicalizeSummary(summaryPath);
      const canonical = JSON.parse(readFileSync(summaryPath, 'utf8'));
      expect(canonical.lastSuccessfulSyncUtc).toBeNull();
      expect(canonical.embeddingModel).toBe('model-a');
      const ragZip = join(root, run, 'rag.zip');
      const sha = packRagZip(stage, ragZip);
      expect(sha).toBe(createHash('sha256').update(readFileSync(ragZip)).digest('hex'));
      shas.push(sha);
    }
    expect(shas[0]).toBe(shas[1]);
    const listing = spawnSync(tarExecutable(), ['-tf', join(root, 'first', 'rag.zip')], { encoding: 'utf8' });
    expect(listing.status).toBe(0);
    expect(listing.stdout.split(/\r?\n/).filter(Boolean)).toEqual(Object.keys(files).sort());
    // The deterministic writer must still satisfy the full delivery pair contract.
    const config = join(root, 'first', 'project-config.json');
    writeFileSync(config, JSON.stringify({
      Diagnosis: { Project: 'project-test', BundleId: 'bundle-test', RagSha256: shas[0] },
    }));
    expect(() => verifyPair(join(root, 'first', 'rag.zip'), config, 'project-test', 'bundle-test')).not.toThrow();
  });

  it('keeps Diagnosis-only input compatible and validates the Diagnosis plus Agents pair', async () => {
    expect(validateExtraConfig({ Tools: true })).toEqual({ Diagnosis: { Tools: 'true' } });
    expect(validateExtraConfig({
      Diagnosis: { TopK: 6 },
      Agents: {
        DefaultBackend: 'cloud-eu-france',
        ClassBackends: { report: 'cloud-eu-france' },
        DeliveredApiKeys: { 'cloud-eu-france': 'synthetic-delivered-key' },
      },
    })).toEqual({
      Diagnosis: { TopK: 6 },
      Agents: {
        DefaultBackend: 'cloud-eu-france',
        ClassBackends: { report: 'cloud-eu-france' },
        DeliveredApiKeys: { 'cloud-eu-france': 'synthetic-delivered-key' },
      },
    });
    expect(() => validateExtraConfig({ Agents: { Backends: { injected: {} } } })).toThrow(/Unknown Agents/);
    expect(() => validateExtraConfig({ Agents: { ApiKey: 'forbidden' } })).toThrow(/Unknown Agents/);

    const root = mkdtempSync(join(tmpdir(), 'rv-rag-pair-test-'));
    temporary.push(root);
    const stage = join(root, 'stage');
    mkdirSync(join(stage, 'docs'), { recursive: true });
    mkdirSync(join(stage, 'runtime'), { recursive: true });
    writeFileSync(join(stage, 'docs', 'manual.pdf'), 'fixture');
    writeFileSync(join(stage, 'runtime', 'vector-index.json'), '{}');
    writeFileSync(join(stage, 'runtime', 'vector-index.summary.json'), '{}');
    const ragZip = join(root, 'rag.zip');
    const { tarExecutable } = await bundleRagModule();
    expect(spawnSync(tarExecutable(), ['-a', '-c', '-f', ragZip, '-C', stage, 'docs', 'runtime']).status).toBe(0);
    const config = join(root, 'project-config.json');
    const bundleId = 'bundle-test';
    writeFileSync(config, JSON.stringify({
      Diagnosis: {
        Project: 'project-test',
        BundleId: bundleId,
        RagSha256: createHash('sha256').update(Buffer.from(requireBytes(ragZip))).digest('hex'),
      },
      Agents: {
        DefaultBackend: 'cloud-eu-france',
        ClassBackends: { report: 'cloud-eu-france' },
        DeliveredApiKeys: { 'cloud-eu-france': 'synthetic-delivered-key' },
      },
    }));
    expect(() => verifyPair(ragZip, config, 'project-test', bundleId)).not.toThrow();
  });
});

function requireBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
