// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * cad-glb-cache-converter-key.test.ts — plan-561 F5 (§9.3): the converter is part
 * of a CAD import's identity.
 *
 * Browser and CONNECT conversions of the SAME STEP file produce different trees, so
 * they must never share a cache entry: a CONNECT re-import would otherwise overwrite
 * the GLB an older browser draft replays from, and every later op of that draft
 * (addressed by name path) would miss. At the same time the browser key must stay
 * bit-identical to the pre-561 key, so no existing cache entry is orphaned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ opfsAvailable: true }));

// OPFS stays REAL (browser runner); only the availability probe is stubbed so the
// Cache-API tier is reachable too.
vi.mock('../src/core/storage/rv-opfs-blobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/storage/rv-opfs-blobs')>();
  return { ...actual, isOpfsSupported: () => state.opfsAvailable };
});

import { Scene, Group, Object3D, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import {
  cadGlbFileName,
  cadGlbOpfsKey,
  clearCadGlbCache,
  getCadGlb,
  putCadGlb,
} from '../src/core/import/rv-cad-glb-cache';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { registerCadProvider } from '../src/core/editor/rv-cad-provider';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import type { CADLinkExtras } from '../src/core/editor/rv-asset-ops';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const textOf = (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);

async function hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(async () => {
  state.opfsAvailable = true;
  await clearCadGlbCache();
});

// ─── Keys ────────────────────────────────────────────────────────────────

describe('converter in the cache key', () => {
  it('browser / undefined keep the LEGACY file name, bit for bit', () => {
    // Literal pre-561 shape: `<version>.<sha>.<quality>.glb`.
    expect(cadGlbFileName('abc', 'standard')).toBe('v2.abc.standard.glb');
    expect(cadGlbFileName('abc', 'standard', 'browser')).toBe('v2.abc.standard.glb');
    expect(cadGlbFileName('abc', 'standard', undefined)).toBe('v2.abc.standard.glb');
  });

  it('browser / undefined keep the LEGACY OPFS key (hash of `v2:<sha>:<quality>`)', async () => {
    const legacy = await hex('v2:abc:standard');
    expect(await cadGlbOpfsKey('abc', 'standard')).toBe(legacy);
    expect(await cadGlbOpfsKey('abc', 'standard', 'browser')).toBe(legacy);
  });

  it('connect gets its own file name and OPFS key', async () => {
    expect(cadGlbFileName('abc', 'standard', 'connect')).toBe('v2.abc.standard.connect.glb');
    expect(await cadGlbOpfsKey('abc', 'standard', 'connect')).not.toBe(await cadGlbOpfsKey('abc', 'standard'));
  });

  it('no quality preset can forge the connect token (dots are sanitised)', () => {
    expect(cadGlbFileName('abc', 'standard.connect')).not.toBe(cadGlbFileName('abc', 'standard', 'connect'));
  });

  it('plan-621: adding `solidcraft` leaves the browser and connect keys byte-identical', async () => {
    // Literal shapes, so a change in keyToken shows up as a diff here, not as orphaned entries.
    expect(cadGlbFileName('abc', 'standard')).toBe('v2.abc.standard.glb');
    expect(cadGlbFileName('abc', 'standard', 'connect')).toBe('v2.abc.standard.connect.glb');
    expect(await cadGlbOpfsKey('abc', 'standard', 'connect')).toBe(await hex('v2:abc:standard.connect'));
    expect(cadGlbFileName('abc', 'standard', 'solidcraft')).toBe('v2.abc.standard.solidcraft.glb');
    expect(await cadGlbOpfsKey('abc', 'standard', 'solidcraft')).toBe(await hex('v2:abc:standard.solidcraft'));
    expect(cadGlbFileName('abc', 'standard.solidcraft')).not.toBe(cadGlbFileName('abc', 'standard', 'solidcraft'));
  });
});

describe.each([
  ['OPFS tier', true],
  ['Cache-API tier', false],
])('%s', (_label, opfs) => {
  beforeEach(() => { state.opfsAvailable = opfs; });

  it('a connect entry does not overwrite the browser entry of the same (sha, quality)', async () => {
    await putCadGlb('shaX', 'standard', bytesOf('BROWSER'));
    await putCadGlb('shaX', 'standard', bytesOf('CONNECT'), 'connect');
    expect(textOf(await getCadGlb('shaX', 'standard'))).toBe('BROWSER');
    expect(textOf(await getCadGlb('shaX', 'standard', 'browser'))).toBe('BROWSER');
    expect(textOf(await getCadGlb('shaX', 'standard', 'connect'))).toBe('CONNECT');
  });

  it('a connect lookup never falls through to the browser entry', async () => {
    await putCadGlb('shaY', 'standard', bytesOf('BROWSER'));
    expect(await getCadGlb('shaY', 'standard', 'connect')).toBeNull();
  });

  it('plan-621: a solidcraft entry neither overwrites nor shadows browser / connect', async () => {
    await putCadGlb('shaZ', 'standard', bytesOf('BROWSER'));
    await putCadGlb('shaZ', 'standard', bytesOf('CONNECT'), 'connect');
    await putCadGlb('shaZ', 'standard', bytesOf('SOLIDCRAFT'), 'solidcraft');
    expect(textOf(await getCadGlb('shaZ', 'standard'))).toBe('BROWSER');
    expect(textOf(await getCadGlb('shaZ', 'standard', 'connect'))).toBe('CONNECT');
    expect(textOf(await getCadGlb('shaZ', 'standard', 'solidcraft'))).toBe('SOLIDCRAFT');
    await putCadGlb('shaW', 'standard', bytesOf('BROWSER'));
    expect(await getCadGlb('shaW', 'standard', 'solidcraft')).toBeNull();
  });
});

// ─── Draft replay after a converter switch ───────────────────────────────

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  registry.registerNode(NodeRegistry.computeNodePath(model), model);
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return { viewer, model };
}

function tree(children: string[]): Object3D {
  const root = new Group();
  root.name = 'Gearbox';
  for (const name of children) {
    const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    body.name = name;
    root.add(body);
  }
  return root;
}

function subtreeNames(model: Object3D, rootPath: string): string[] {
  const leaf = rootPath.split('/').pop()!;
  const root = model.children.find((c) => c.name === leaf);
  if (!root) return [];
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

const BROWSER: CADLinkExtras = {
  File: 'gearbox.step', Sha256: 'feedface', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true,
};
const CONNECT: CADLinkExtras = { ...BROWSER, Converter: 'connect' };

describe('browser draft survives a CONNECT re-import of the same file', () => {
  beforeEach(async () => {
    registerCadProvider('step', null); // replay must be a pure cache read
    await __clearDraftStoresForTests();
  });

  it('reopening the old draft rebuilds the identical browser tree', async () => {
    // 1. Browser import + a follow-up op that addresses a node by name path.
    const first = makeMockViewer();
    const doc = scratchAssetDocument(first.viewer);
    const rootPath = await doc.importCad({ glb: await objectToGlb(tree(['Housing', 'Shaft'])), cadlink: BROWSER });
    await doc.deleteNodes([`${rootPath}/Housing`]);
    await doc.whenIdle();
    const before = subtreeNames(first.model, rootPath);
    expect(before.slice(1)).toEqual(['Shaft']); // root is named after the file
    const ops = doc.toDraft().ops;
    doc.dispose();

    // 2. CONNECT import of the SAME file (same Sha256 + Quality) — a different tree.
    const second = makeMockViewer();
    const other = scratchAssetDocument(second.viewer);
    await other.importCad({ glb: await objectToGlb(tree(['Body_1', 'Body_2', 'Body_3'])), cadlink: CONNECT });
    await other.whenIdle();
    other.dispose();

    // 3. Reopen the old draft: same tree as before the CONNECT import.
    const third = makeMockViewer();
    const restored = new AssetDocument(third.viewer, {
      id: 'r', name: 'R', base: { kind: 'document', documentId: 'doc_scratch', path: 'scratch.glb', name: 'Scratch' },
    });
    await restored.replayOps(ops);
    await restored.whenIdle();
    expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
    expect(subtreeNames(third.model, rootPath)).toEqual(before);
    restored.dispose();
  });
});
