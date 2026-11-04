// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.1 — the binary resource store and the ONE GLB parse wrapper.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  binaryResources,
  collectFmuEmbeds,
  collectGlbResources,
  extractGlbBufferViews,
  parseGlbCollectingResources,
  readGlbJson,
  rebuildGlbAppendingBufferViews,
  BinaryResourceStore,
} from '../src/core/engine/rv-binary-resources';
import { buildGlbWithBufferView, buildFmuGlb } from './helpers/glb-fixture';

function fmuRecord(sha: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    StepSize: 0.01,
    FmuEmbed: { fileName: 'x.fmu', sha256: sha, guid: '{g}', fmiVersion: '2.0', byteLength: 0, bufferView: -1 },
    FmuVariables: [],
    ...extra,
  };
}

describe('extractGlbBufferViews', () => {
  it('slices exactly byteLength from a padded bufferView', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const { glb, viewIndex } = buildGlbWithBufferView(payload);
    const [res] = extractGlbBufferViews(glb, [{ bufferView: viewIndex, byteLength: 5, sha256: 'x' }]);
    expect(Array.from(res.bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(res.byteLength).toBe(5);
  });

  it('returns a copy, not a view into the GLB buffer', () => {
    const payload = new Uint8Array([9, 8, 7]);
    const { glb, viewIndex } = buildGlbWithBufferView(payload);
    const [res] = extractGlbBufferViews(glb, [{ bufferView: viewIndex, byteLength: 3, sha256: 'x' }]);
    expect(res.bytes.buffer).not.toBe(glb);
    expect(res.bytes.buffer.byteLength).toBe(3);
  });

  it('returns [] with a warning for out-of-range views and wrong magic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { glb } = buildGlbWithBufferView(new Uint8Array([1, 2, 3]));
    expect(extractGlbBufferViews(glb, [{ bufferView: 7, byteLength: 3, sha256: 'x' }])).toEqual([]);
    // Declared length longer than the view → refused, not over-read.
    expect(extractGlbBufferViews(glb, [{ bufferView: 1, byteLength: 4096, sha256: 'x' }])).toEqual([]);
    const bad = new Uint8Array(glb.slice(0));
    bad[0] = 0x00;
    expect(extractGlbBufferViews(bad, [{ bufferView: 1, byteLength: 3, sha256: 'x' }])).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('collectFmuEmbeds', () => {
  it('finds Fmu and Fmu_N records with a stored bufferView, one per SHA', () => {
    const json = {
      nodes: [
        { name: 'A', extras: { realvirtual: { Fmu: { FmuEmbed: { sha256: 'aa', bufferView: 0, byteLength: 3 } } } } },
        { name: 'B', extras: { realvirtual: { Fmu_1: { FmuEmbed: { sha256: 'bb', bufferView: 1, byteLength: 4 } } } } },
        { name: 'C', extras: { realvirtual: { Fmu: { FmuEmbed: { sha256: 'aa', bufferView: 0, byteLength: 3 } } } } },
        { name: 'D', extras: { realvirtual: { Fmu: { FmuEmbed: { sha256: 'dd', bufferView: -1, byteLength: 3 } } } } },
        { name: 'E', extras: { realvirtual: { FmuLike: { FmuEmbed: { sha256: 'ee', bufferView: 2 } } } } },
      ],
    };
    expect(collectFmuEmbeds(json).map((w) => w.sha256)).toEqual(['aa', 'bb']);
  });
});

describe('BinaryResourceStore', () => {
  it('put/get/retain/releaseDocument free an entry only when no document holds it', () => {
    const store = new BinaryResourceStore();
    store.put('s1', new Uint8Array([1]), 'docA');
    expect(store.retain('s1', 'docB')).toBe(true);
    expect(store.retain('unknown', 'docB')).toBe(false);
    expect(store.releaseDocument('docA')).toBe(0);
    expect(store.get('s1')?.bytes[0]).toBe(1);
    expect(store.releaseDocument('docB')).toBe(1);
    expect(store.has('s1')).toBe(false);
  });

  it('a second put of the same SHA keeps the first bytes and adds the document', () => {
    const store = new BinaryResourceStore();
    const first = new Uint8Array([1, 2]);
    store.put('s', first, 'a');
    store.put('s', new Uint8Array([1, 2]), 'b');
    expect(store.get('s')!.bytes).toBe(first);
    expect([...store.get('s')!.documentIds].sort()).toEqual(['a', 'b']);
  });
});

describe('parseGlbCollectingResources', () => {
  beforeEach(() => binaryResources._resetForTesting());

  it('puts every embedded FMU package into the store BEFORE the loader parses', async () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
    const glb = buildFmuGlb([{ name: 'Hyd', fmu: fmuRecord('sha-1'), payload }]);
    let seenAtParse = false;
    const loader = {
      parseAsync: async (data: ArrayBuffer) => {
        seenAtParse = binaryResources.has('sha-1');
        return { bytes: data.byteLength };
      },
    };
    const result = await parseGlbCollectingResources(glb, 'doc-1', loader);
    expect(result.bytes).toBe(glb.byteLength);
    expect(seenAtParse).toBe(true);
    const entry = binaryResources.get('sha-1')!;
    expect(Array.from(entry.bytes)).toEqual(Array.from(payload));
    expect([...entry.documentIds]).toEqual(['doc-1']);
  });

  it('a GLB without FMUs puts nothing and still parses', async () => {
    const { glb } = buildGlbWithBufferView(new Uint8Array([1]));
    const parse = vi.fn(async () => 'ok');
    await expect(parseGlbCollectingResources(glb, 'd', { parseAsync: parse })).resolves.toBe('ok');
    expect(parse).toHaveBeenCalledOnce();
    expect(binaryResources.size).toBe(0);
    expect(collectGlbResources(new ArrayBuffer(4), 'd')).toBe(0);
  });

  it('two FMU nodes sharing a SHA produce one store entry', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const glb = buildFmuGlb([
      { name: 'A', fmu: fmuRecord('same'), payload },
      { name: 'B', fmu: fmuRecord('same'), payload },
    ]);
    expect(readGlbJson(glb)!.bufferViews).toHaveLength(1);
    expect(collectGlbResources(glb, 'doc')).toBe(1);
    expect(binaryResources.size).toBe(1);
  });
});

describe('rebuildGlbAppendingBufferViews', () => {
  it('appends 4-byte aligned views, keeps the old BIN data and lets the caller patch the JSON', () => {
    const { glb } = buildGlbWithBufferView(new Uint8Array([1, 2, 3, 4, 5]));
    const before = readGlbJson(glb)!;
    const a = new Uint8Array([7, 7, 7]);
    const b = new Uint8Array([8, 8, 8, 8, 8]);
    const out = rebuildGlbAppendingBufferViews(glb, [a, b], (json, idx) => {
      json.asset = { ...(json.asset as object), extras: { realvirtual: { fmuBufferViews: idx } } };
    });
    const json = readGlbJson(out)!;
    const views = json.bufferViews as Array<{ byteOffset: number; byteLength: number }>;
    expect(views).toHaveLength((before.bufferViews as unknown[]).length + 2);
    const [ia, ib] = ((json.asset as Record<string, any>).extras.realvirtual.fmuBufferViews) as number[];
    expect(views[ia].byteOffset % 4).toBe(0);
    expect(views[ib].byteOffset % 4).toBe(0);
    const [ra, rb] = extractGlbBufferViews(out, [
      { bufferView: ia, byteLength: 3, sha256: 'a' },
      { bufferView: ib, byteLength: 5, sha256: 'b' },
    ]);
    expect(Array.from(ra.bytes)).toEqual([7, 7, 7]);
    expect(Array.from(rb.bytes)).toEqual([8, 8, 8, 8, 8]);
    // Original payload still where it was.
    const [orig] = extractGlbBufferViews(out, [{ bufferView: 1, byteLength: 5, sha256: 'o' }]);
    expect(Array.from(orig.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('creates a BIN chunk and buffers[0] for a GLB without one', () => {
    const glb = buildFmuGlb([{ name: 'A', fmu: fmuRecord('x') }]);
    expect(readGlbJson(glb)!.buffers).toBeUndefined();
    const out = rebuildGlbAppendingBufferViews(glb, [new Uint8Array([4, 2])], () => {});
    const [res] = extractGlbBufferViews(out, [{ bufferView: 0, byteLength: 2, sha256: 'x' }]);
    expect(Array.from(res.bytes)).toEqual([4, 2]);
    expect((readGlbJson(out)!.buffers as Array<{ byteLength: number }>)[0].byteLength).toBe(2);
  });
});

// ─── Lint: no second GLB parse path ─────────────────────────────────────

const rawSources = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * `parseAsync(` sites that are NOT a GLB load and therefore stay outside the
 * wrapper, each with its reason:
 *  - `rv-binary-resources.ts` — the wrapper itself.
 *  - `rv-import-object.ts` — `GLTFExporter.parseAsync`, a WRITE.
 *  - `rv-scene-glb-bake.ts` — the scene writer re-parses its OWN intermediate
 *    bytes only to re-export them (structural scene save); it loads nothing
 *    into the viewer. The FMU packages that re-export would drop are taken
 *    from the source bytes and appended again (`embedFmuBufferViews`,
 *    `tests/rv-scene-glb-bake-fmu.test.ts`).
 *  - `runtime-stage-export.ts` — `USDZExporter.parseAsync` (plan-637 USD live
 *    link), a WRITE: it serialises the running scene to `.usdz` bytes for Kit
 *    and parses no GLB.
 */
const ALLOWED = new Set([
  'rv-binary-resources.ts', 'rv-import-object.ts', 'rv-scene-glb-bake.ts', 'runtime-stage-export.ts',
]);

describe('plan-498 lint — every GLB load goes through parseGlbCollectingResources', () => {
  it('the scan is real', () => {
    expect(Object.keys(rawSources).length).toBeGreaterThan(200);
  });

  it('no parseAsync( in src/ outside the wrapper (and the named writers)', () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(rawSources)) {
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!/\.parseAsync\(|\bparseAsync\(/.test(text)) continue;
      const base = path.split('/').pop()!;
      // The model cache names `parseAsync` only as the loader seam it hands
      // TO the wrapper; any other occurrence there is an offender too.
      if (base === 'rv-model-cache.ts') {
        const withoutSeam = text
          .replace(/parseAsync\?\(data: ArrayBuffer, path: string\)/g, '')
          .replace(/typeof loader\.parseAsync === 'function'/g, '')
          .replace(/parseAsync: \(data, path\) => loader\.parseAsync!\(data, path\)/g, '');
        if (/parseAsync\(/.test(withoutSeam)) offenders.push(base);
        continue;
      }
      if (!ALLOWED.has(base)) offenders.push(base);
    }
    expect(offenders).toEqual([]);
  });

  it('the three load entries call the wrapper', () => {
    const find = (name: string) => Object.entries(rawSources).find(([p]) => p.endsWith(`/${name}`))![1];
    expect(find('rv-scene-loader.ts')).toContain('parseGlbCollectingResources(');
    expect(find('rv-model-cache.ts')).toContain('parseGlbCollectingResources(');
    expect(find('rv-glb-parse.ts')).toContain('parseGlbCollectingResources(');
  });
});
