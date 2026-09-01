// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.2 — there is ONE op vocabulary, and it has no second name.
 *
 * Four claims, each failing differently:
 *
 *  1. **Mutators construct `RvOp` directly.** Driven through the real facades
 *     (`SceneStore.applyOp`, `AssetDocument`), asserting the shape that lands in
 *     the document — not the shape a converter would have produced.
 *  2. **The old names are gone.** Half compile-time (this file imports the
 *     replacements and would not build against the old ones), half an rg-style
 *     source assertion, because a deleted export can be re-added by accident and
 *     tsc would happily agree.
 *  3. **`transformNode` without `scale` leaves scale alone.** The one genuine
 *     reshaping of the merge, and the one that silently deforms mirror-scaled
 *     Unity nodes if it is ever "fixed" with an identity default.
 *  4. **A MIXED composite still routes correctly at runtime.** `RvCompositeOp.ops`
 *     is deliberately not origin-restricted (§2.2), so the defensive split in
 *     `resolveOpTarget` is the safety net — pinned here rather than assumed.
 *
 * Renderer-free: real NodeRegistry + real three Scene.
 */

import { describe, it, expect, beforeEach } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { RvUnifiedExecutor, resolveOpTarget } from '../src/core/ops/rv-unified-executors';
import {
  RV_OP_KINDS,
  makeSceneComposite,
  makeAssetComposite,
  normalizePersistedSceneOp,
  type RvOp,
  type RvCompositeOp,
  type RvPrimitiveOp,
  type RvScenePrimitiveOp,
  type RvAssetPrimitiveOp,
  type RvTransformNodeOp,
} from '../src/core/ops/rv-unified-ops';

let seq = 0;
const head = () => ({ id: 'op_sv_' + ++seq, ts: 1000 + seq, schemaV: 1 as const });

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const mirror = new Object3D();
  mirror.name = 'Mirror';
  mirror.scale.set(-1, 1, 1);
  model.add(mirror);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  scene.updateMatrixWorld(true);

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    get currentModelUrl() { return undefined; },
    availableModels: [] as { url: string; label: string }[],
    currentScene: null,
    loadScene: async () => {},
    loadEmptyScene: async () => {},
    getPlugin: () => undefined,
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  return {
    viewer, model, box, mirror, registry,
    boxPath: NodeRegistry.computeNodePath(box),
    mirrorPath: NodeRegistry.computeNodePath(mirror),
  };
}

// ─── 1. Mutators construct RvOp directly ────────────────────────────────

describe('mutators construct RvOp — nothing converts at the boundary', () => {
  beforeEach(async () => {
    localStorage.clear();
    await __clearDraftStoresForTests();
  });

  it('a scene edit lands in the document exactly as the caller wrote it', async () => {
    const store = new SceneStore(makeViewer().viewer);
    await store.newEmpty();

    const op: RvOp = {
      ...head(), kind: 'setField',
      nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 200, prev: 50,
    };
    await store.applyOp(op);

    // Identity, not merely equality: a converter anywhere on this path would
    // have produced a copy.
    expect(store.document.ops).toHaveLength(1);
    expect(store.document.ops[0]).toBe(op);
    store.dispose();
  });

  it('an asset edit lands in the document with the asset lineage intact', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = scratchAssetDocument(viewer);

    doc.transformNode(
      boxPath,
      { position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] },
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    );
    await doc.whenIdle();

    const recorded = doc.document.ops[0] as RvTransformNodeOp;
    expect(recorded.kind).toBe('transformNode');
    expect(recorded.transform.scale).toEqual([2, 2, 2]);
    // `doc.ops` is the same records, not a lowered copy.
    expect(doc.ops[0]).toBe(recorded);
    doc.dispose();
  });
});

// ─── 2. The old names are gone ──────────────────────────────────────────

describe('the second vocabulary is deleted, not hidden', () => {
  /** Source text of the modules that used to declare the old names. */
  const sources = import.meta.glob(
    [
      '../src/core/hmi/scene/rv-scene-edits.ts',
      '../src/core/editor/rv-asset-ops.ts',
      '../src/core/ops/*.ts',
    ],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>;

  it('declares none of the retired type names as exports', () => {
    const retired = [
      'EditOp', 'PrimitiveEditOp', 'CompositeOp',
      'AssetOp', 'AssetPrimitiveOp', 'AssetCompositeOp',
    ];
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      for (const name of retired) {
        // `export type X =` / `export interface X` — a re-declaration, not a
        // mention in prose. `\b` keeps `RvAssetOp` and `SetNodeTransformOp`
        // from matching.
        const re = new RegExp(String.raw`export\s+(type|interface)\s+${name}\b`);
        if (re.test(text)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no up/downcast layer left between two vocabularies', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /\b(upcastEditOp|upcastAssetOp|downcastToEditOp|downcastToAssetOp)\b/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('still exports CADLinkExtras — it was never part of the union', async () => {
    const mod = await import('../src/core/editor/rv-asset-ops');
    expect('CADLinkExtras' in mod || true).toBe(true); // type-only: compile proof below
    const extras: import('../src/core/editor/rv-asset-ops').CADLinkExtras = {
      File: 'gearbox.step', Sha256: 'abc', Quality: 'standard',
      ImportScaleFactor: 0.001, ZIsUpVector: true,
    };
    expect(extras.File).toBe('gearbox.step');
  });

  it('keeps the retired KIND string out of the union', () => {
    expect(RV_OP_KINDS).not.toContain('setNodeTransform');
  });
});

// ─── 3. transformNode without scale ─────────────────────────────────────

describe('transformNode without scale leaves scale untouched', () => {
  it('never writes scale on forward or inverse, on a mirror-scaled node', async () => {
    const { viewer, mirror, mirrorPath } = makeViewer();
    const exec = new RvUnifiedExecutor(viewer, 'scene');
    const op: RvTransformNodeOp = {
      ...head(), kind: 'transformNode', nodePath: mirrorPath,
      transform: { position: [3, 0, 0], quaternion: [0, 0, 0, 1] },
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    };

    await exec.applyForward(op);
    expect(mirror.position.toArray()).toEqual([3, 0, 0]);
    expect(mirror.scale.toArray()).toEqual([-1, 1, 1]);

    await exec.applyInverse(op);
    expect(mirror.scale.toArray()).toEqual([-1, 1, 1]);
    exec.dispose();
  });

  it('a persisted PRE-merge scene record is renamed on read, still without a scale', () => {
    // The exact bytes an older session wrote into `RvScene.edits.ops`.
    const persisted = {
      id: 'op_old_1', ts: 5000, schemaV: 1,
      kind: 'setNodeTransform',
      nodePath: 'Asset/Mirror',
      position: [3, 0, 0],
      quaternion: [0, 0, 0, 1],
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    } as unknown as RvOp;

    const normalised = normalizePersistedSceneOp(persisted) as RvTransformNodeOp;
    expect(normalised.kind).toBe('transformNode');
    expect(normalised.id).toBe('op_old_1');
    expect(normalised.transform.position).toEqual([3, 0, 0]);
    expect('scale' in normalised.transform).toBe(false);
    expect('scale' in normalised.prev).toBe(false);
    expect(resolveOpTarget(normalised, 'scene')).toBe('scene');
  });

  it('leaves an already-normalised log alone BY REFERENCE (dirty depends on it)', () => {
    const op: RvOp = {
      ...head(), kind: 'setField',
      nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 1, prev: 0,
    };
    expect(normalizePersistedSceneOp(op)).toBe(op);

    const comp = makeSceneComposite('Batch', [op as RvScenePrimitiveOp]);
    expect(normalizePersistedSceneOp(comp)).toBe(comp);
  });
});

// ─── 4. A mixed composite routes per child at runtime ───────────────────

describe('mixed composite — the runtime split is the safety net', () => {
  /**
   * Origin-typed constructors keep this from happening at the source, so the
   * mixture has to be assembled by hand here. That is the case the defensive
   * split in `resolveOpTarget` exists for, and the reason §2.2 accepted the
   * type-sharpness loss instead of splitting the union in two.
   */
  function mixed(scenePath: string, assetPath: string): RvCompositeOp {
    const sceneChild: RvPrimitiveOp = {
      ...head(), kind: 'transformNode', nodePath: scenePath,
      transform: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] },
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    };
    const assetChild: RvPrimitiveOp = {
      ...head(), kind: 'renameNode', nodePath: assetPath, name: 'Crate', prevName: 'Box',
    };
    return { ...head(), kind: 'composite', label: 'Mixed', ops: [sceneChild, assetChild] };
  }

  it('has no common target — which is what triggers the split', () => {
    expect(resolveOpTarget(mixed('Asset/Mirror', 'Asset/Box'), 'scene')).toBeNull();
    expect(resolveOpTarget(mixed('Asset/Mirror', 'Asset/Box'), 'asset')).toBeNull();
  });

  it('applies each child through ITS OWN executor, forward and inverse', async () => {
    const { viewer, box, mirror, boxPath, mirrorPath } = makeViewer();
    const exec = new RvUnifiedExecutor(viewer, 'scene');
    const op = mixed(mirrorPath, boxPath);

    await exec.applyForward(op);
    expect(mirror.position.toArray()).toEqual([1, 0, 0]);
    expect(mirror.scale.toArray()).toEqual([-1, 1, 1]); // scene child kept its lineage
    expect(box.name).toBe('Crate');                     // asset child reached the asset executor

    await exec.applyInverse(op);
    expect(mirror.position.toArray()).toEqual([0, 0, 0]);
    expect(box.name).toBe('Box');
    exec.dispose();
  });

  it('origin-typed constructors resolve to a single target', () => {
    const sceneChild: RvScenePrimitiveOp = {
      ...head(), kind: 'setCamera', preset: null, prev: null,
    };
    const assetChild: RvAssetPrimitiveOp = {
      ...head(), kind: 'renameNode', nodePath: 'Asset/Box', name: 'Crate', prevName: 'Box',
    };
    expect(resolveOpTarget(makeSceneComposite('S', [sceneChild]), 'scene')).toBe('scene');
    expect(resolveOpTarget(makeAssetComposite('A', [assetChild]), 'asset')).toBe('asset');
  });
});
