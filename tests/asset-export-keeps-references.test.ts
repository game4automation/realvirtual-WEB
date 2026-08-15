// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The asset editor's save must PRESERVE references, not melt them in
 * (plan-703, Lauf 11).
 *
 * `exportAssetGlb()` clones the LIVE tree — and by the time an asset is on
 * screen, `compose()` has already grafted every referenced subtree under its
 * reference node (`rv-glb-compose.ts:641`). Without a prune the save therefore
 * writes the child's geometry INTO the parent file, and the reference stops
 * being a reference: the connection to the child asset is gone, and a later
 * correction in the library reaches nothing.
 *
 * The scene bake never had this problem because it builds from the SOURCE bytes
 * (`rv-scene-glb-bake.ts`), where a reference node has no children in the first
 * place. This file holds the asset editor to the same contract.
 *
 * The rule that makes the prune safe is a documented property of the format,
 * not a guess about a particular file: rv-ODT §7d.8 — a reference node "carries
 * no subtree of its own", so everything under one is composed content.
 * `unflattenReferences()` (`rv-glb-flatten.ts:142`) already rests on exactly the
 * same invariant.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  exportAssetGlb,
  pruneComposedReferenceSubtrees,
} from '../src/core/editor/rv-asset-glb-export';
import {
  getAssetOverrides,
  getAssetReference,
  setAssetOverrides,
  setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import { buildMissingReferencePlaceholder } from '../src/core/engine/rv-missing-reference-placeholder';

// ─── Fixtures ───────────────────────────────────────────────────────────

function mesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  m.name = name;
  return m;
}

/**
 * What the asset editor actually holds after a load:
 *
 *   Cell
 *    +- Frame              <- the open file's OWN content
 *    +- GripperRef         <- AssetReference + AssetOverrides (this file's data)
 *       +- GripperContent  <- grafted by compose() from the CHILD file
 *          +- Finger
 */
function buildComposedAsset(): { root: Group; referenceNode: Object3D } {
  const root = new Group();
  root.name = 'Cell';
  root.add(mesh('Frame'));

  const referenceNode = new Object3D();
  referenceNode.name = 'GripperRef';
  referenceNode.position.set(0.5, 0, 0);
  setAssetReference(referenceNode, {
    assetId: 'gripper-asset-id',
    path: 'library/gripper.glb',
    sha256: 'deadbeef',
  });
  setAssetOverrides(referenceNode, {
    byNodeId: { 'n-finger': { Drive: { TargetSpeed: 250 } } },
  });
  root.add(referenceNode);

  // The composed clone — the child file's content, living only in the session.
  const content = new Group();
  content.name = 'GripperContent';
  content.add(mesh('Finger'));
  referenceNode.add(content);

  return { root, referenceNode };
}

async function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out.sort();
}

// ─── The defect ─────────────────────────────────────────────────────────

describe('exportAssetGlb preserves AssetReferences', () => {
  it('emits the reference node as a REFERENCE, not as its composed subtree', async () => {
    const { root } = buildComposedAsset();

    const reloaded = await parseGlb(await exportAssetGlb(root, 'Cell'));

    const ref = findByName(reloaded, 'GripperRef');
    expect(ref).not.toBeNull();

    // 1. The reference survives — this is the connection to the child asset.
    const parsed = getAssetReference(ref!);
    expect(parsed).not.toBeNull();
    expect(parsed!.assetId).toBe('gripper-asset-id');
    expect(parsed!.path).toBe('library/gripper.glb');
    // It must NOT be marked embedded: nothing was inlined, so claiming so would
    // stop composition from ever resolving it again.
    expect(parsed!.embedded).toBeUndefined();

    // 2. The child's geometry is NOT in the parent file.
    expect(findByName(reloaded, 'GripperContent')).toBeNull();
    expect(findByName(reloaded, 'Finger')).toBeNull();
    expect(ref!.children).toHaveLength(0);

    // 3. The open file's own content is untouched.
    expect(findByName(reloaded, 'Frame')).not.toBeNull();
  });

  it('keeps AssetOverrides — the only place an edit inside the child is stored', async () => {
    const { root } = buildComposedAsset();

    const reloaded = await parseGlb(await exportAssetGlb(root, 'Cell'));

    const overrides = getAssetOverrides(findByName(reloaded, 'GripperRef')!);
    expect(overrides).not.toBeNull();
    expect(overrides!.byNodeId['n-finger']).toEqual({ Drive: { TargetSpeed: 250 } });
  });

  it('keeps the reference node transform (it belongs to THIS file)', async () => {
    const { root } = buildComposedAsset();

    const reloaded = await parseGlb(await exportAssetGlb(root, 'Cell'));

    expect(findByName(reloaded, 'GripperRef')!.position.toArray()).toEqual([0.5, 0, 0]);
  });

  it('does not mutate the live tree — the session keeps its composed subtree', async () => {
    const { root, referenceNode } = buildComposedAsset();

    await exportAssetGlb(root, 'Cell');

    expect(referenceNode.children.map((c) => c.name)).toEqual(['GripperContent']);
    expect(findByName(root, 'Finger')).not.toBeNull();
  });

  it('never writes a missing-reference placeholder into the file', async () => {
    // An unresolvable reference gets a wireframe stand-in grafted under it
    // (`rv-glb-compose.ts:605`). It is a live-scene object; the file must show
    // the reference unresolved, not a box pretending to be the machine.
    const root = new Group();
    root.name = 'Cell';
    const referenceNode = new Object3D();
    referenceNode.name = 'MissingRef';
    setAssetReference(referenceNode, { assetId: 'nowhere', path: 'library/gone.glb' });
    referenceNode.add(buildMissingReferencePlaceholder({ label: 'gone.glb', assetId: 'nowhere' }));
    root.add(referenceNode);

    const reloaded = await parseGlb(await exportAssetGlb(root, 'Cell'));

    const ref = findByName(reloaded, 'MissingRef')!;
    expect(getAssetReference(ref)!.assetId).toBe('nowhere');
    expect(ref.children).toHaveLength(0);
    expect(findByName(reloaded, 'gone.glb')).toBeNull();
    reloaded.traverse((n) => {
      expect((n.userData.realvirtual as Record<string, unknown> | undefined)
        ?.MissingAssetPlaceholder).toBeUndefined();
    });
  });

  it('leaves an EMBEDDED reference alone — its children are real file content', async () => {
    // The flat export inlines the subtree and marks the reference `embedded`
    // (`rv-glb-flatten.ts:79`). Pruning that would delete authored content.
    const { root, referenceNode } = buildComposedAsset();
    setAssetReference(referenceNode, {
      assetId: 'gripper-asset-id',
      path: 'library/gripper.glb',
      embedded: true,
    });

    const reloaded = await parseGlb(await exportAssetGlb(root, 'Cell'));

    expect(getAssetReference(findByName(reloaded, 'GripperRef')!)!.embedded).toBe(true);
    expect(findByName(reloaded, 'Finger')).not.toBeNull();
  });

  it('prunes nested references too, without descending into what it removed', async () => {
    //   Cell / OuterRef -> [composed: Sub / InnerRef -> [composed: Bolt]]
    // The whole composed subtree goes; the inner reference went with the bytes
    // it came from, and the outer file must not learn about it.
    const root = new Group();
    root.name = 'Cell';
    const outer = new Object3D();
    outer.name = 'OuterRef';
    setAssetReference(outer, { assetId: 'assembly' });
    root.add(outer);

    const sub = new Group();
    sub.name = 'Sub';
    outer.add(sub);
    const inner = new Object3D();
    inner.name = 'InnerRef';
    setAssetReference(inner, { assetId: 'bolt' });
    sub.add(inner);
    inner.add(mesh('Bolt'));

    const reloaded = await parseGlb(await exportAssetGlb(root, 'Cell'));

    expect(getAssetReference(findByName(reloaded, 'OuterRef')!)!.assetId).toBe('assembly');
    expect(findByName(reloaded, 'Sub')).toBeNull();
    expect(findByName(reloaded, 'InnerRef')).toBeNull();
    expect(findByName(reloaded, 'Bolt')).toBeNull();
  });
});

// ─── An asset WITHOUT references must be untouched ──────────────────────

describe('pruneComposedReferenceSubtrees on a reference-free asset', () => {
  function buildPlainAsset(): Group {
    const root = new Group();
    root.name = 'Plain';
    const sub = new Group();
    sub.name = 'Sub';
    sub.userData.realvirtual = { Drive: { TargetSpeed: 100 } };
    sub.add(mesh('Part'));
    root.add(sub);
    root.add(mesh('Base'));
    return root;
  }

  it('is a strict no-op: nothing removed, structure identical', () => {
    const root = buildPlainAsset();
    const before = names(root);

    expect(pruneComposedReferenceSubtrees(root)).toBe(0);

    expect(names(root)).toEqual(before);
  });

  it('exports byte-identically across runs (the prune adds no nondeterminism)', async () => {
    const a = await exportAssetGlb(buildPlainAsset(), 'Plain');
    const b = await exportAssetGlb(buildPlainAsset(), 'Plain');

    expect(a.byteLength).toBe(b.byteLength);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
  });
});
