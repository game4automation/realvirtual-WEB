// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Root-level rv_extras must survive the asset save/load round trip (plan-715 F7).
 *
 * Since plan-715 the GLB root is an addressable, selectable node and the anchor
 * for asset-level metadata (plan-714 builds on this). Two real leaks made that
 * anchor unreliable, and both are pinned here as FIXED POINTS over repeated
 * export→parse cycles — a single round trip would have passed even while the
 * data was quietly being moved to a place the next save drops:
 *
 *  1. a wrapper-shaped root name (`AuxScene`, `__root__`, empty) made
 *     `collapseWrapperChain` descend past the root, so the export read the
 *     CHILD's userData and the root's extras vanished;
 *  2. a root with a non-identity transform ships as a child of the exported
 *     scene, so root extras existed twice — once as scene extras, once on that
 *     child — and came back doubled.
 */
import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb, mergeWrapperChainUserData } from '../src/core/editor/rv-asset-glb-export';

const KNOWLEDGE = { Note: 'hello', Author: 'plan-715' };

/** An asset root named `rootName` with one mesh child and root-level extras. */
function buildRootedAsset(rootName: string): Group {
  const root = new Group();
  root.name = rootName;
  root.userData.realvirtual = { NodeKnowledge: { ...KNOWLEDGE } };
  // Runtime bookkeeping — must NEVER reach the file (it is re-stamped on load).
  root.userData._rvModelRoot = true;

  const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  body.name = 'Body';
  body.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };
  root.add(body);
  return root;
}

async function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, '');
  return gltf.scene;
}

function rvOf(node: Object3D): Record<string, any> {
  return (node.userData?.realvirtual ?? {}) as Record<string, any>;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

/** Every node BELOW the root that carries a `NodeKnowledge` block. */
function descendantsWithKnowledge(root: Object3D): string[] {
  const hits: string[] = [];
  for (const child of root.children) {
    child.traverse((n) => { if (rvOf(n).NodeKnowledge) hits.push(n.name); });
  }
  return hits;
}

describe('mergeWrapperChainUserData', () => {
  it('is a plain shallow copy when nothing collapsed (root === content)', () => {
    const root = buildRootedAsset('Turntable');
    expect(mergeWrapperChainUserData(root, root)).toEqual({ ...root.userData });
  });

  it('merges every collapsed wrapper level, content winning on a key clash', () => {
    const wrapper = new Group();
    wrapper.name = 'AuxScene';
    wrapper.userData.realvirtual = { NodeKnowledge: { ...KNOWLEDGE }, Classification: { Kind: 'asset' } };
    wrapper.userData.topLevelNote = 'from wrapper';
    const content = new Group();
    content.name = 'Turntable';
    content.userData.realvirtual = { Classification: { Kind: 'scene' } };
    wrapper.add(content);

    const merged = mergeWrapperChainUserData(wrapper, content) as Record<string, any>;
    // Root-only key survives the descent…
    expect(merged.realvirtual.NodeKnowledge).toEqual(KNOWLEDGE);
    expect(merged.topLevelNote).toBe('from wrapper');
    // …and the more specific content value wins where both set the same key.
    expect(merged.realvirtual.Classification).toEqual({ Kind: 'scene' });
  });

  it('refuses to merge upwards when content is not inside root', () => {
    const a = buildRootedAsset('A');
    const b = buildRootedAsset('B');
    expect(mergeWrapperChainUserData(a, b)).toEqual({ ...b.userData });
  });
});

describe('root rv_extras round-trip (identity root)', () => {
  it('survives four export/parse rounds and never leaks the runtime tag', async () => {
    let root: Object3D = buildRootedAsset('Turntable');
    for (let i = 0; i < 4; i++) {
      const glb = await exportAssetGlb(root, 'Turntable');
      root = await parseGlb(glb);
      expect(rvOf(root).NodeKnowledge, `round ${i + 1}`).toEqual(KNOWLEDGE);
      expect(root.userData._rvModelRoot, `round ${i + 1}`).toBeUndefined();
      // The child's own component is untouched by the root lift.
      expect(rvOf(findByName(root, 'Body')!).Drive?.TargetSpeed).toBe(100);
    }
  });
});

describe('root rv_extras round-trip (non-identity root transform)', () => {
  it('survives four rounds WITHOUT duplicating onto the content child', async () => {
    let root: Object3D = buildRootedAsset('Turntable');
    root.position.set(0, 0.5, 0);

    for (let i = 0; i < 4; i++) {
      const glb = await exportAssetGlb(root, 'Turntable');
      root = await parseGlb(glb);
      expect(rvOf(root).NodeKnowledge, `round ${i + 1}`).toEqual(KNOWLEDGE);
      // The whole point: exactly ONE copy in the file, on the scene.
      expect(descendantsWithKnowledge(root), `round ${i + 1}`).toEqual([]);
      expect(rvOf(findByName(root, 'Body')!).Drive?.TargetSpeed).toBe(100);
    }
  });

  it('keeps the transform-carrying content node (nothing is flattened away)', async () => {
    const root = buildRootedAsset('Turntable');
    root.position.set(0, 0.5, 0);
    const reloaded = await parseGlb(await exportAssetGlb(root, 'Turntable'));
    expect(findByName(reloaded, 'Body')).not.toBeNull();
    // Content level preserved with its offset — the reason the branch exists.
    expect(reloaded.children[0].position.y).toBeCloseTo(0.5, 5);
  });
});

describe('root rv_extras round-trip (wrapper-shaped and edge-case root names)', () => {
  for (const rootName of ['AuxScene', 'AuxScene_1', '__root__', '']) {
    it(`does not lose root userData or geometry for a root named "${rootName}"`, async () => {
      let root: Object3D = buildRootedAsset(rootName);
      for (let i = 0; i < 4; i++) {
        const glb = await exportAssetGlb(root, 'MyAsset');
        root = await parseGlb(glb);
        expect(rvOf(root).NodeKnowledge, `round ${i + 1}`).toEqual(KNOWLEDGE);
        // A wrapper name never reaches the file: the scene carries the asset name.
        expect(root.name, `round ${i + 1}`).toBe('MyAsset');
        // The content itself must still be there. A wrapper root over a single
        // LEAF used to collapse onto that leaf, whose (empty) child list then
        // became the whole exported scene — the asset saved as nothing.
        expect(findByName(root, 'Body'), `round ${i + 1}`).not.toBeNull();
        expect(rvOf(findByName(root, 'Body')!).Drive?.TargetSpeed, `round ${i + 1}`).toBe(100);
      }
    });
  }

  it('still collapses a DEEP wrapper chain down to the real content level', async () => {
    // AuxScene_1 → AuxScene → Hub → [Body]: the shape an old editor↔planner
    // round trip left behind. One save must heal it to a single scene level.
    const outer = new Group(); outer.name = 'AuxScene_1';
    const inner = new Group(); inner.name = 'AuxScene';
    const hub = new Group(); hub.name = 'Hub';
    const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    body.name = 'Body';
    hub.add(body); inner.add(hub); outer.add(inner);
    outer.userData.realvirtual = { NodeKnowledge: { ...KNOWLEDGE } };

    const reloaded = await parseGlb(await exportAssetGlb(outer, 'Healed'));
    expect(reloaded.name).toBe('Healed');
    expect(reloaded.children.map((c) => c.name)).toEqual(['Body']);
    // …and the extras from the outermost wrapper came along for the ride.
    expect(rvOf(reloaded).NodeKnowledge).toEqual(KNOWLEDGE);
  });

  it('treats the generic name "Scene" as literal content, not as a wrapper', async () => {
    // Blender's default root name. `isGltfWrapperName` deliberately does NOT
    // match it, so it must round-trip as an ordinary name.
    let root: Object3D = buildRootedAsset('Scene');
    for (let i = 0; i < 2; i++) {
      const glb = await exportAssetGlb(root);
      root = await parseGlb(glb);
      expect(root.name, `round ${i + 1}`).toBe('Scene');
      expect(rvOf(root).NodeKnowledge, `round ${i + 1}`).toEqual(KNOWLEDGE);
    }
  });
});
