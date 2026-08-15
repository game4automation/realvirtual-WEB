// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Structural classification of AssetOps — drives the post-apply notifications
 * in rv-asset-executors (`editor-structure-changed` event + grouped-BVH
 * rebuild). The truth table here is the contract: a wrong entry either leaves
 * the hierarchy panel stale or triggers needless BVH rebuilds.
 */
import { describe, it, expect } from 'vitest';
import {
  assetOpTouchesHierarchy,
  classifyAssetOpRaycastImpact,
} from '../src/core/editor/rv-asset-ops';
import type { RvAssetOp, RvAssetPrimitiveOp } from '../src/core/ops/rv-unified-ops';

/** Minimal op stub — the predicates only inspect `kind`, `nodePath` and `ops`. */
function op(kind: RvAssetPrimitiveOp['kind'], nodePath = 'Root/Node'): RvAssetOp {
  return { kind, nodePath } as unknown as RvAssetOp;
}

function composite(...ops: RvAssetOp[]): RvAssetOp {
  return { kind: 'composite', ops } as unknown as RvAssetOp;
}

describe('assetOpTouchesHierarchy', () => {
  it.each([
    ['importCad', true],
    ['deleteNode', true],
    ['setNodeVisible', true],   // eye-icon state re-renders via structure event
    ['renameNode', true],
    ['addComponent', true],
    ['removeComponent', true],
    ['createNode', true],
    ['reparentNode', true],
    ['transformNode', false],
    ['setField', false],
    ['unsetField', false],
  ] as Array<[RvAssetPrimitiveOp['kind'], boolean]>)('%s → %s', (kind, expected) => {
    expect(assetOpTouchesHierarchy(op(kind))).toBe(expected);
  });

  it('composite recurses into children', () => {
    expect(assetOpTouchesHierarchy(composite(op('setField'), op('transformNode')))).toBe(false);
    expect(assetOpTouchesHierarchy(composite(op('setField'), op('renameNode')))).toBe(true);
    // Re-import shape: deleteNode + importCad + addComponent.
    expect(assetOpTouchesHierarchy(composite(op('deleteNode'), op('importCad'), op('addComponent')))).toBe(true);
    expect(assetOpTouchesHierarchy(composite())).toBe(false);
  });
});

describe('classifyAssetOpRaycastImpact', () => {
  it.each([
    ['importCad', true],
    ['deleteNode', true],
    ['setNodeVisible', true],   // stamps rv.Hidden — the BVH build EXCLUDES hidden meshes
    ['renameNode', true],       // FaceRange.objectPath stores registry paths
    ['addComponent', true],     // can flip the static/kinematic partition (Drive)
    ['removeComponent', true],
    ['createNode', true],       // conservative: redo-restore may re-attach a subtree
    ['reparentNode', true],     // BVH bakes world positions AND registry paths
  ] as Array<[RvAssetPrimitiveOp['kind'], boolean]>)('%s → full rebuild', (kind) => {
    expect(classifyAssetOpRaycastImpact(op(kind))).toEqual({ rebuild: true, refitPaths: [] });
  });

  it('transformNode → position-refit fast path with the node path', () => {
    expect(classifyAssetOpRaycastImpact(op('transformNode', 'Root/A'))).toEqual({
      rebuild: false,
      refitPaths: ['Root/A'],
    });
  });

  it('pure field edits → no raycast impact', () => {
    expect(classifyAssetOpRaycastImpact(op('setField'))).toEqual({ rebuild: false, refitPaths: [] });
    expect(classifyAssetOpRaycastImpact(op('unsetField'))).toEqual({ rebuild: false, refitPaths: [] });
  });

  it('transform-only composite collects every node path (multi-drag commit)', () => {
    expect(classifyAssetOpRaycastImpact(
      composite(op('transformNode', 'Root/A'), op('transformNode', 'Root/B'), op('setField')),
    )).toEqual({ rebuild: false, refitPaths: ['Root/A', 'Root/B'] });
  });

  it('a structural child supersedes the refit paths (rebuild covers them)', () => {
    expect(classifyAssetOpRaycastImpact(
      composite(op('transformNode', 'Root/A'), op('deleteNode')),
    )).toEqual({ rebuild: true, refitPaths: [] });
    expect(classifyAssetOpRaycastImpact(composite())).toEqual({ rebuild: false, refitPaths: [] });
  });
});
