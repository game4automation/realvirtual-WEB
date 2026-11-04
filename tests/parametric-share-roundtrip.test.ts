// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5b — the child-family bundle wired into the share export
 * (`exportAssetGlb` with share meta) and the import into the project library
 * (`importBundledChildFamilies`). Round trip: export → import into an empty
 * project → the child documents are byte-identical (DocHash unchanged), the
 * parent's family block is unchanged (same variant key), a stale or absent
 * child is reported, an existing family is never overwritten.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { sha256HexBytes } from '../src/core/engine/rv-parametric-hash';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { declaredUsesOf, unpackChildFamilies } from '../src/core/engine/rv-parametric-bundle';
import type { ChildFamilyImportIO } from '../src/core/editor/rv-parametric-share';

const library = new Map<string, Uint8Array>();
vi.mock('../src/core/engine/rv-glb-reference-resolver', () => ({
  createReferenceResolver: () => async (ref: { assetId?: string }) => {
    const bytes = ref.assetId ? library.get(ref.assetId) : undefined;
    return bytes ? { bytes: bytes.slice().buffer, url: `blob:${ref.assetId}` } : null;
  },
}));

const { exportAssetGlb } = await import('../src/core/editor/rv-asset-glb-export');
const {
  bundleChildFamiliesForShare, importBundledChildFamilies, libraryPathForChild,
} = await import('../src/core/editor/rv-parametric-share');
const { getProblems, clearAllProblems } = await import('../src/core/hmi/problems-store');

function family(famId: string, uses?: unknown[]): Group {
  const root = new Group();
  root.name = famId;
  const fam = new Group();
  fam.name = 'Fam';
  const m = new Mesh(new BoxGeometry(10, 10, 10), new MeshStandardMaterial({ name: 'steel' }));
  m.name = 'Body';
  fam.add(m);
  fam.userData.realvirtual = {
    ParametricComponent: {
      ApiVersion: 1, Params: [{ Name: 'S', Type: 'int', Min: 0, Max: 100, Default: 1 }], Values: { S: 3 },
      Code: 'function generate(v){return {instances:[]};}', CodeHash: 'c',
      ...(uses ? { Uses: uses } : {}),
    },
  };
  setNodeId(fam, `node-${famId}`);
  root.add(fam);
  return root;
}

function memoryProject(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  const rows = new Map<string, string>(Object.entries(initial)); // id -> path
  const io: ChildFamilyImportIO = {
    hasFamily: async (f) => rows.has(f),
    fileExists: async (p) => files.has(p),
    writeFile: async (p, b) => { if (files.has(p)) throw new Error('exists'); files.set(p, b); },
    addRows: async (list) => { for (const r of list) rows.set(r.id, r.path); },
  };
  return { files, rows, io };
}

function pcOf(glb: Uint8Array): unknown {
  const nodes = (readGlbJson(glb)?.nodes ?? []) as Array<{ extras?: { realvirtual?: { ParametricComponent?: unknown } } }>;
  return nodes.map((n) => n.extras?.realvirtual?.ParametricComponent).find(Boolean);
}

let grand: Uint8Array;
let mid: Uint8Array;

beforeEach(async () => {
  library.clear();
  clearAllProblems();
  grand = new Uint8Array(await objectToGlb(family('grand')));
  mid = new Uint8Array(await objectToGlb(family('mid', [
    { Family: 'lib:grand', FamilyNodeId: 'node-grand', DocHash: await sha256HexBytes(grand), Path: 'library/sensors/grand.glb' },
  ])));
  library.set('lib:mid', mid);
  library.set('lib:grand', grand);
});

describe('share export → library import round trip', () => {
  it('bundles transitively, imports verbatim, the parent variant key is unchanged', async () => {
    const parentRoot = family('parent', [{ Family: 'lib:mid', FamilyNodeId: 'node-mid', DocHash: await sha256HexBytes(mid) }]);
    const plain = new Uint8Array(await exportAssetGlb(parentRoot, 'Line'));
    const shared = new Uint8Array(await exportAssetGlb(parentRoot, 'Line', { v: 2, name: 'Line' } as never));

    // Only the SHARE export carries the bundle.
    expect(unpackChildFamilies(plain)).toEqual([]);
    expect(unpackChildFamilies(shared).map((c) => c.Family)).toEqual(['lib:mid', 'lib:grand']);
    expect(pcOf(shared)).toEqual(pcOf(plain));

    // Import into an EMPTY project (the sender's library is gone).
    library.clear();
    const project = memoryProject();
    const report = await importBundledChildFamilies(shared, project.io);
    expect(report.missing).toEqual([]);
    expect(report.written).toEqual([
      { family: 'lib:mid', path: 'library/parametric/lib_mid.glb' },
      { family: 'lib:grand', path: 'library/sensors/grand.glb' },
    ]);
    // DocHash unchanged: the written bytes ARE the declared documents.
    expect(await sha256HexBytes(project.files.get('library/parametric/lib_mid.glb')!)).toBe(await sha256HexBytes(mid));
    expect(project.files.get('library/sensors/grand.glb')).toEqual(grand);
    // Every declared Uses of parent and child resolves in the project, with the same hash.
    for (const u of [...declaredUsesOf(readGlbJson(shared)), ...declaredUsesOf(readGlbJson(mid))]) {
      const bytes = project.files.get(project.rows.get(u.Family)!)!;
      expect(await sha256HexBytes(bytes)).toBe(u.DocHash);
    }
  });

  it('a stale or unresolvable child is not bundled and is reported', async () => {
    const parentRoot = family('parent', [
      { Family: 'lib:mid', FamilyNodeId: 'node-mid', DocHash: 'not-the-hash' },
      { Family: 'lib:gone', FamilyNodeId: 'x', DocHash: 'h' },
    ]);
    const { report } = await bundleChildFamiliesForShare(new Uint8Array(await objectToGlb(parentRoot)));
    expect(report).toEqual({ bundled: [], missing: ['lib:gone'], stale: ['lib:mid'] });

    await exportAssetGlb(parentRoot, 'Line', { v: 2 } as never);
    {
      const ids = getProblems().filter((p) => p.code === 'parametric-child-missing').map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['parametric-child-missing:export:lib:gone', 'parametric-child-missing:export:lib:mid']));
    }
  });

  it('an existing family is kept, a taken path gets a suffix, missing children are listed', async () => {
    const parentRoot = family('parent', [
      { Family: 'lib:mid', FamilyNodeId: 'node-mid', DocHash: await sha256HexBytes(mid) },
      { Family: 'lib:gone', FamilyNodeId: 'x', DocHash: 'h' },
    ]);
    const { glb } = await bundleChildFamiliesForShare(new Uint8Array(await objectToGlb(parentRoot)));
    const project = memoryProject({ 'lib:mid': 'library/mine/mid.glb' });
    project.files.set('library/sensors/grand.glb', new Uint8Array([1, 2, 3]));
    const report = await importBundledChildFamilies(glb, project.io);
    expect(report.kept).toEqual(['lib:mid']);
    expect(report.written).toEqual([{ family: 'lib:grand', path: 'library/sensors/grand-2.glb' }]);
    expect(project.files.get('library/sensors/grand.glb')).toEqual(new Uint8Array([1, 2, 3]));
    expect(report.missing).toEqual(['lib:gone']);
  });

  it('libraryPathForChild accepts only a library GLB path', () => {
    expect(libraryPathForChild({ Family: 'a/b c', Path: 'library/x/y.glb' })).toBe('library/x/y.glb');
    expect(libraryPathForChild({ Family: 'a/b c', Path: '../evil.glb' })).toBe('library/parametric/a_b_c.glb');
    expect(libraryPathForChild({ Family: 'lib:s' })).toBe('library/parametric/lib_s.glb');
  });
});
