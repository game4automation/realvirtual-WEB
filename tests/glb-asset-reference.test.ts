// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-asset-reference.test.ts — plan-397 Phase 2.
 *
 * The three rv-ODT components that let one GLB reference another, plus the two
 * rules that decide what a composed scene actually shows:
 *
 *  - **Strength ordering** — the outer file always wins. Without a fixed order,
 *    nested references make the winning value unpredictable (the lesson USD paid
 *    for with LIVERPS).
 *  - **Orphan reporting** — an override whose target vanished is REPORTED, never
 *    dropped. That was an explicit user decision, and a silently-swallowing API
 *    would make it unimplementable further up.
 *
 * `SceneCamera` is checked field-for-field against `ModelCameraStart` because
 * the plan review caught the first draft losing `duration`/`savedAt`/`source` on
 * the way into the file.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D } from 'three';
import type { ModelCameraStart } from '../src/core/hmi/camera-startpos-types';
import {
  OVERRIDE_STRENGTH,
  applyAssetOverrides,
  applyComponentPatch,
  applyOverrideLayers,
  cameraStartFromSceneCamera,
  collectReferenceNodes,
  describeOrphanedOverride,
  getAssetOverrides,
  getAssetReference,
  getSceneCamera,
  isUnresolvedReferenceNode,
  makeSubtreeResolvers,
  sceneCameraFromCameraStart,
  setAssetOverrides,
  setAssetReference,
  setSceneCamera,
} from '../src/core/engine/rv-asset-reference';
import { applyOverlayByNodeId, applyOverlayToNode } from '../src/core/engine/rv-extras-overlay-store';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';
import { setNodeId } from '../src/core/engine/rv-node-id';

function rv(node: Object3D): Record<string, Record<string, unknown>> {
  return (node.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
}

/** A referenced subtree as composition would have grafted it in. */
function buildReferencedSubtree(): Group {
  const root = new Group();
  root.name = 'Press';
  setNodeId(root, 'press-root');

  const gripper = new Group();
  gripper.name = 'Gripper';
  setNodeId(gripper, 'gripper');
  root.add(gripper);

  const motor = new Object3D();
  motor.name = 'Motor';
  // Components first, id second: `setNodeId` writes INTO the extras bag, so
  // assigning `userData.realvirtual` afterwards would wipe the id again.
  motor.userData.realvirtual = { Drive: { TargetSpeed: 100, Acceleration: 50 } };
  setNodeId(motor, 'motor');
  gripper.add(motor);

  return root;
}

describe('AssetReference', () => {
  it('round-trips through extras', () => {
    const node = new Object3D();
    setAssetReference(node, {
      assetId: 'press-500t', providerId: 'library', sourceId: 'std',
      path: '../assemblies/press.glb', sha256: 'deadbeef',
    });
    expect(getAssetReference(node)).toEqual({
      assetId: 'press-500t', providerId: 'library', sourceId: 'std',
      path: '../assemblies/press.glb', sha256: 'deadbeef',
    });
  });

  it('omits empty optional fields instead of writing empty strings', () => {
    const node = new Object3D();
    setAssetReference(node, { assetId: 'a' });
    expect(rv(node).AssetReference).toEqual({ assetId: 'a' });
  });

  it('rejects a reference that can never resolve (no assetId and no path)', () => {
    const node = new Object3D();
    node.userData.realvirtual = { AssetReference: { sha256: 'abc' } };
    expect(getAssetReference(node)).toBeNull();
  });

  it('accepts a path-only reference', () => {
    const node = new Object3D();
    setAssetReference(node, { assetId: '', path: './part.glb' });
    expect(getAssetReference(node)?.path).toBe('./part.glb');
  });

  it('treats an embedded reference as already resolved', () => {
    const node = new Object3D();
    setAssetReference(node, { assetId: 'a', embedded: true });
    expect(getAssetReference(node)?.embedded).toBe(true);
    // A flat export inlined the subtree; resolving again would graft a second copy.
    expect(isUnresolvedReferenceNode(node)).toBe(false);
  });

  it('collects unresolved reference nodes and skips embedded ones', () => {
    const root = new Group();
    const live = new Object3D(); live.name = 'Live';
    setAssetReference(live, { assetId: 'live' });
    const inlined = new Object3D(); inlined.name = 'Inlined';
    setAssetReference(inlined, { assetId: 'inlined', embedded: true });
    root.add(live, inlined);

    expect(collectReferenceNodes(root).map((r) => r.ref.assetId)).toEqual(['live']);
  });
});

describe('AssetOverrides', () => {
  it('round-trips and drops an empty override set', () => {
    const node = new Object3D();
    setAssetOverrides(node, { byNodeId: { motor: { Drive: { TargetSpeed: 250 } } } });
    expect(getAssetOverrides(node)).toEqual({ byNodeId: { motor: { Drive: { TargetSpeed: 250 } } } });

    setAssetOverrides(node, { byNodeId: {} });
    expect(getAssetOverrides(node)).toBeNull();
    expect(rv(node).AssetOverrides).toBeUndefined();
  });

  it('applies by NodeId and leaves the rest of the subtree alone', () => {
    const subtree = buildReferencedSubtree();
    const result = applyAssetOverrides(
      { byNodeId: { motor: { Drive: { TargetSpeed: 999 } } } },
      makeSubtreeResolvers(subtree),
      { occurrence: 'ref-1', assetId: 'press-500t' },
    );

    expect(result.applied).toBe(1);
    expect(result.orphaned).toEqual([]);
    const motor = subtree.getObjectByName('Motor')!;
    expect(rv(motor).Drive).toEqual({ TargetSpeed: 999, Acceleration: 50 });
  });

  it('deletes a field with null (RFC 7396)', () => {
    const subtree = buildReferencedSubtree();
    applyAssetOverrides(
      { byNodeId: { motor: { Drive: { Acceleration: null } } } },
      makeSubtreeResolvers(subtree),
      { occurrence: '', assetId: 'press-500t' },
    );
    expect(rv(subtree.getObjectByName('Motor')!).Drive).toEqual({ TargetSpeed: 100 });
  });

  it('falls back to byPath, relative to the reference node', () => {
    const subtree = buildReferencedSubtree();
    const result = applyAssetOverrides(
      { byNodeId: {}, byPath: { 'Gripper/Motor': { Drive: { TargetSpeed: 42 } } } },
      makeSubtreeResolvers(subtree),
      { occurrence: '', assetId: 'press-500t' },
    );
    expect(result.applied).toBe(1);
    expect(rv(subtree.getObjectByName('Motor')!).Drive.TargetSpeed).toBe(42);
  });

  it('reports an override whose target is gone instead of dropping it', () => {
    const subtree = buildReferencedSubtree();
    const result = applyAssetOverrides(
      { byNodeId: { 'removed-node': { Drive: { TargetSpeed: 7 } } } },
      makeSubtreeResolvers(subtree),
      { occurrence: 'ref-1', assetId: 'press-500t' },
    );

    expect(result.applied).toBe(0);
    expect(result.orphaned).toEqual([{
      addressing: 'nodeId',
      key: 'removed-node',
      occurrence: 'ref-1',
      assetId: 'press-500t',
      componentTypes: ['Drive'],
    }]);
    expect(describeOrphanedOverride(result.orphaned[0]))
      .toContain('no longer exists in asset "press-500t"');
  });

  it('never writes into the referenced file — only into the grafted subtree', () => {
    // The subtree the parent overrides is a per-occurrence CLONE; the reference
    // node itself carries the override, so nothing here can reach the source.
    const referenceNode = new Object3D();
    setAssetReference(referenceNode, { assetId: 'press-500t' });
    setAssetOverrides(referenceNode, { byNodeId: { motor: { Drive: { TargetSpeed: 1 } } } });

    const overrides = getAssetOverrides(referenceNode)!;
    const a = buildReferencedSubtree();
    const b = buildReferencedSubtree();
    applyAssetOverrides(overrides, makeSubtreeResolvers(a), { occurrence: 'r1', assetId: 'press-500t' });

    expect(rv(a.getObjectByName('Motor')!).Drive.TargetSpeed).toBe(1);
    expect(rv(b.getObjectByName('Motor')!).Drive.TargetSpeed).toBe(100);   // untouched
  });
});

describe('Strength ordering', () => {
  it('lets the outer referencing file beat the inner one and the file itself', () => {
    const node = new Object3D();
    node.userData.realvirtual = { Drive: { TargetSpeed: 100 } };

    applyOverrideLayers(node, [
      // Deliberately supplied strongest-first: the function must order them.
      { strength: OVERRIDE_STRENGTH.OUTER_REFERENCE, patch: { Drive: { TargetSpeed: 300 } } },
      { strength: OVERRIDE_STRENGTH.INNER_REFERENCE, patch: { Drive: { TargetSpeed: 200 } } },
      { strength: OVERRIDE_STRENGTH.REFERENCED_FILE, patch: { Drive: { TargetSpeed: 100 } } },
    ]);
    expect(rv(node).Drive.TargetSpeed).toBe(300);
  });

  it('lets the session beat every file layer', () => {
    const node = new Object3D();
    applyOverrideLayers(node, [
      { strength: OVERRIDE_STRENGTH.SESSION, patch: { Drive: { TargetSpeed: 999 } } },
      { strength: OVERRIDE_STRENGTH.OUTER_REFERENCE, patch: { Drive: { TargetSpeed: 300 } } },
    ]);
    expect(rv(node).Drive.TargetSpeed).toBe(999);
  });

  it('orders two nested referencing files by depth — the shallower wins', () => {
    const node = new Object3D();
    applyOverrideLayers(node, [
      { strength: OVERRIDE_STRENGTH.INNER_REFERENCE, depth: 3, patch: { Drive: { TargetSpeed: 3 } } },
      { strength: OVERRIDE_STRENGTH.INNER_REFERENCE, depth: 1, patch: { Drive: { TargetSpeed: 1 } } },
      { strength: OVERRIDE_STRENGTH.INNER_REFERENCE, depth: 2, patch: { Drive: { TargetSpeed: 2 } } },
    ]);
    expect(rv(node).Drive.TargetSpeed).toBe(1);
  });
});

describe('Overlay store shares the merge implementation', () => {
  it('applyOverlayToNode still honours RFC 7396', () => {
    const node = new Object3D();
    node.userData.realvirtual = { Drive: { TargetSpeed: 100, Acceleration: 50 } };
    const overlay: RVExtrasOverlay = {
      $schema: 'rv-extras-overlay/1.0',
      $source: 'test',
      nodes: { 'Cell/Motor': { Drive: { TargetSpeed: 250, Acceleration: null } } },
    };
    expect(applyOverlayToNode(node, 'Cell/Motor', overlay)).toBe(true);
    expect(rv(node).Drive).toEqual({ TargetSpeed: 250 });
    // Unchanged re-application reports no change.
    expect(applyOverlayToNode(node, 'Cell/Motor', overlay)).toBe(false);
  });

  it('applyOverlayByNodeId resolves by id and reports orphans', () => {
    const subtree = buildReferencedSubtree();
    const resolvers = makeSubtreeResolvers(subtree);
    const result = applyOverlayByNodeId(
      { motor: { Drive: { TargetSpeed: 5 } }, ghost: { Drive: { TargetSpeed: 6 } } },
      resolvers.byNodeId,
      { occurrence: 'ref-1', assetId: 'press-500t' },
    );
    expect(result.applied).toBe(1);
    expect(result.orphaned.map((o) => o.key)).toEqual(['ghost']);
  });

  it('applyComponentPatch ignores a non-object component entry', () => {
    const node = new Object3D();
    // A malformed patch must not throw mid-composition and abort the load.
    expect(applyComponentPatch(node, { Drive: 42 as unknown as Record<string, unknown> })).toBe(false);
  });
});

describe('SceneCamera', () => {
  const preset: ModelCameraStart = {
    px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6,
    duration: 2.5, savedAt: 1_700_000_000_000, source: 'user',
  };

  it('carries duration, savedAt and source into the file and back out', () => {
    const root = new Group();
    setSceneCamera(root, sceneCameraFromCameraStart(preset));
    const back = cameraStartFromSceneCamera(getSceneCamera(root)!);
    expect(back).toEqual(preset);
  });

  it('round-trips a preset that carries only the six coordinates', () => {
    const minimal: ModelCameraStart = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
    const root = new Group();
    setSceneCamera(root, sceneCameraFromCameraStart(minimal));
    expect(cameraStartFromSceneCamera(getSceneCamera(root)!)).toEqual(minimal);
  });

  it('rejects a preset with a non-finite coordinate', () => {
    const root = new Group();
    root.userData.realvirtual = { SceneCamera: { px: NaN, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 } };
    expect(getSceneCamera(root)).toBeNull();
  });

  it('drops a non-positive duration and an unknown source rather than passing them on', () => {
    const root = new Group();
    root.userData.realvirtual = {
      SceneCamera: { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, duration: 0, source: 'robot' },
    };
    const cam = getSceneCamera(root)!;
    expect(cam.duration).toBeUndefined();
    expect(cam.source).toBeUndefined();
  });

  it('removes the component when cleared', () => {
    const root = new Group();
    setSceneCamera(root, sceneCameraFromCameraStart(preset));
    setSceneCamera(root, null);
    expect(getSceneCamera(root)).toBeNull();
    expect(rv(root).SceneCamera).toBeUndefined();
  });
});
