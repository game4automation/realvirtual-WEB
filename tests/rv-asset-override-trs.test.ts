// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-override-trs.test.ts — plan-444 §9.1.
 *
 * `AssetOverrides.trsByNodeId` is the field that makes a part moved after a CAD
 * import saveable. It is read out of a FILE, which means every value in it was
 * written by somebody else's build — so the parser is the only thing standing
 * between a malformed entry and a NaN matrix that poisons picking for the rest
 * of the session with no error anywhere near the cause.
 *
 * What these cases pin:
 *
 *  - **Per-field defence, not all-or-nothing.** A broken rotation must not throw
 *    away the position the user actually dragged the part to.
 *  - **Degenerate values are REJECTED, never clamped.** A zero scale makes
 *    `matrixWorld` singular; a zero-length quaternion normalises to NaN. Both
 *    fall back to what the referenced asset itself says, which is the only
 *    answer that is not invented.
 *  - **Absent means absent.** A file written before this field existed parses to
 *    no override at all (F6), not to an identity transform that would quietly
 *    reset every part it names.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  applyTrsOverride,
  getAssetOverrides,
  parseTrsOverride,
  setAssetOverrides,
  type TrsOverride,
} from '../src/core/engine/rv-asset-reference';

/** A node carrying a raw `AssetOverrides` blob, as a file would deliver it. */
function nodeWithOverrides(raw: unknown): Object3D {
  const node = new Object3D();
  node.userData.realvirtual = { AssetOverrides: raw };
  return node;
}

describe('parseTrsOverride', () => {
  it('reads a full position / quaternion / scale entry', () => {
    expect(parseTrsOverride({
      position: [1, 2, 3],
      quaternion: [0, 0.7071, 0, 0.7071],
      scale: [2, 2, 2],
    })).toEqual({
      position: [1, 2, 3],
      quaternion: [0, 0.7071, 0, 0.7071],
      scale: [2, 2, 2],
    });
  });

  it('keeps a valid position when the rotation beside it is malformed', () => {
    // The half that survives is the half the user moved — dropping it because
    // its neighbour is broken would lose the actual edit.
    expect(parseTrsOverride({ position: [1, 2, 3], quaternion: [0, 0, 1] }))
      .toEqual({ position: [1, 2, 3] });
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['only unusable fields', { position: 'here', scale: [1, 2] }],
  ])('returns null for %s', (_label, raw) => {
    expect(parseTrsOverride(raw)).toBeNull();
  });

  it.each([
    ['a NaN component', [NaN, 0, 0]],
    ['an Infinity component', [0, Infinity, 0]],
    ['a string component', [0, '1', 0]],
    ['the wrong length', [1, 2]],
  ])('drops a position with %s', (_label, position) => {
    expect(parseTrsOverride({ position, scale: [1, 1, 1] })?.position).toBeUndefined();
  });

  it('drops a zero scale rather than clamping it', () => {
    // Clamping would silently give the part a size nobody asked for; the
    // asset's own scale is the honest fallback.
    expect(parseTrsOverride({ position: [1, 0, 0], scale: [1, 0, 1] }))
      .toEqual({ position: [1, 0, 0] });
  });

  it('drops a scale whose component is merely near zero', () => {
    expect(parseTrsOverride({ scale: [1, 1e-9, 1] })).toBeNull();
  });

  it('keeps a negative (mirror) scale — degenerate is zero, not negative', () => {
    expect(parseTrsOverride({ scale: [-1, 1, 1] })?.scale).toEqual([-1, 1, 1]);
  });

  it('drops a zero-length quaternion', () => {
    expect(parseTrsOverride({ position: [0, 1, 0], quaternion: [0, 0, 0, 0] }))
      .toEqual({ position: [0, 1, 0] });
  });
});

describe('applyTrsOverride', () => {
  it('sets only the fields the override carries', () => {
    const node = new Object3D();
    node.position.set(9, 9, 9);
    node.scale.set(3, 3, 3);

    expect(applyTrsOverride(node, { position: [1, 2, 3] })).toBe(true);
    expect(node.position.toArray()).toEqual([1, 2, 3]);
    // Untouched by an override that says nothing about it.
    expect(node.scale.toArray()).toEqual([3, 3, 3]);
  });

  it('refreshes the local matrix so a reader before the first frame sees it', () => {
    const node = new Object3D();
    node.matrixAutoUpdate = false;
    applyTrsOverride(node, { position: [4, 5, 6] });
    // elements[12..14] is the translation column.
    expect([node.matrix.elements[12], node.matrix.elements[13], node.matrix.elements[14]])
      .toEqual([4, 5, 6]);
  });

  it('never produces a non-finite matrix', () => {
    const node = new Object3D();
    const trs = parseTrsOverride({ position: [1, 1, 1], scale: [0, 0, 0], quaternion: [0, 0, 0, 0] });
    applyTrsOverride(node, trs as TrsOverride);
    node.updateMatrixWorld(true);
    expect(node.matrixWorld.elements.every(Number.isFinite)).toBe(true);
    expect(node.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('reports false for an override that sets nothing', () => {
    expect(applyTrsOverride(new Object3D(), {})).toBe(false);
  });
});

describe('getAssetOverrides / setAssetOverrides with trsByNodeId', () => {
  it('reads a transform-only override set (it is not "no overrides")', () => {
    const node = nodeWithOverrides({ trsByNodeId: { n1: { position: [1, 2, 3] } } });
    const overrides = getAssetOverrides(node);
    expect(overrides).not.toBeNull();
    expect(overrides!.trsByNodeId).toEqual({ n1: { position: [1, 2, 3] } });
    expect(overrides!.byNodeId).toEqual({});
  });

  it('drops unusable entries but keeps the usable ones beside them', () => {
    const node = nodeWithOverrides({
      trsByNodeId: { good: { position: [1, 2, 3] }, bad: { position: 'nope' } },
    });
    expect(getAssetOverrides(node)!.trsByNodeId).toEqual({ good: { position: [1, 2, 3] } });
  });

  it('reports no overrides when every trs entry is unusable', () => {
    expect(getAssetOverrides(nodeWithOverrides({ byNodeId: {}, trsByNodeId: { a: {} } })))
      .toBeNull();
  });

  it('leaves a file without the field exactly as it was (F6)', () => {
    const node = nodeWithOverrides({ byNodeId: { n1: { Drive: { TargetSpeed: 5 } } } });
    const overrides = getAssetOverrides(node)!;
    expect(overrides.trsByNodeId).toBeUndefined();
    expect('trsByNodeId' in overrides).toBe(false);
  });

  it('round-trips through set → get', () => {
    const node = new Object3D();
    setAssetOverrides(node, {
      byNodeId: {},
      trsByNodeId: { n1: { position: [7, 8, 9], quaternion: [0, 0, 0, 1] } },
    });
    expect(getAssetOverrides(node)!.trsByNodeId).toEqual({
      n1: { position: [7, 8, 9], quaternion: [0, 0, 0, 1] },
    });
  });

  it('removes the whole component when the last trs entry goes', () => {
    const node = new Object3D();
    setAssetOverrides(node, { byNodeId: {}, trsByNodeId: { n1: { position: [1, 1, 1] } } });
    setAssetOverrides(node, { byNodeId: {}, trsByNodeId: {} });
    expect((node.userData.realvirtual as Record<string, unknown>).AssetOverrides).toBeUndefined();
  });

  it('does not write an empty trsByNodeId key beside real component overrides', () => {
    const node = new Object3D();
    setAssetOverrides(node, { byNodeId: { n1: { Drive: { TargetSpeed: 5 } } }, trsByNodeId: {} });
    const written = (node.userData.realvirtual as Record<string, Record<string, unknown>>).AssetOverrides;
    expect('trsByNodeId' in written).toBe(false);
  });
});
