// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-override-compat.test.ts — plan-444 §9.6.
 *
 * The plan's first draft put the transform INSIDE `byNodeId[nodeId]`, and the
 * review caught what that would have done: `byNodeId[nodeId]` IS the flat
 * `ComponentPatch` map, so `applyComponentPatch` would have walked a `trs` key
 * as a component type and written `extras.realvirtual.trs` onto every part it
 * touched — a fake component in every saved file, forever. The field is a
 * SIBLING because of that, and this file is the proof rather than the claim.
 *
 * Two properties, both stated against the real functions:
 *
 *  1. **Additivity.** A pre-existing `byNodeId` patch applies identically with
 *     and without a `trsByNodeId` block beside it, and `applyComponentPatch`
 *     never treats either name as a component type.
 *  2. **Survival across read-modify-write.** `writeOverride` reads the whole
 *     component, mutates one field and writes it back. A block it does not
 *     carry through is a block deleted by the next unrelated field edit —
 *     silent loss of every part the user had moved.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  applyAssetOverrides,
  applyComponentPatch,
  describeOrphanedOverride,
  getAssetOverrides,
  makeSubtreeResolvers,
  setAssetOverrides,
  type AssetOverrides,
  type ComponentPatch,
} from '../src/core/engine/rv-asset-reference';
import {
  readOverride,
  overriddenFieldsOf,
  revertComponentOverride,
  writeOverride,
} from '../src/core/ops/rv-reference-guard';
import { RV_NODE_ID_KEY } from '../src/core/engine/rv-node-id';

/** A subtree whose single child carries the NodeId the overrides address. */
function subtreeWithNode(nodeId: string): { root: Object3D; target: Object3D } {
  const root = new Object3D();
  root.name = 'Press';
  const target = new Object3D();
  target.name = 'Ram';
  target.userData.realvirtual = { [RV_NODE_ID_KEY]: nodeId };
  root.add(target);
  return { root, target };
}

/** The realistic legacy payload: one component field on one node. */
const LEGACY_PATCH: Record<string, ComponentPatch> = { n1: { rvTransport: { speed: 5 } } };

function applyTo(overrides: AssetOverrides): Record<string, unknown> {
  const { root, target } = subtreeWithNode('n1');
  applyAssetOverrides(overrides, makeSubtreeResolvers(root), { occurrence: 'occ', assetId: 'press' });
  return target.userData.realvirtual as Record<string, unknown>;
}

// ─── 1. The addition is genuinely additive ──────────────────────────────

describe('trsByNodeId neben einem Bestands-byNodeId-Patch', () => {
  it('wendet den Komponenten-Patch identisch an, mit und ohne trs-Block', () => {
    const without = applyTo({ byNodeId: LEGACY_PATCH });
    const withTrs = applyTo({
      byNodeId: LEGACY_PATCH,
      trsByNodeId: { n1: { position: [1, 2, 3] } },
    });

    expect(without.rvTransport).toEqual({ speed: 5 });
    expect(withTrs.rvTransport).toEqual(without.rvTransport);
  });

  it('schreibt weder "trs" noch "trsByNodeId" als Komponente in die extras', () => {
    const extras = applyTo({
      byNodeId: LEGACY_PATCH,
      trsByNodeId: { n1: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] } },
    });
    // The exact failure the sibling layout exists to prevent.
    expect(Object.keys(extras)).not.toContain('trs');
    expect(Object.keys(extras)).not.toContain('trsByNodeId');
  });

  it('bewegt den Knoten trotzdem', () => {
    const { root, target } = subtreeWithNode('n1');
    const result = applyAssetOverrides(
      { byNodeId: LEGACY_PATCH, trsByNodeId: { n1: { position: [1, 2, 3] } } },
      makeSubtreeResolvers(root),
      { occurrence: 'occ', assetId: 'press' },
    );
    expect(target.position.toArray()).toEqual([1, 2, 3]);
    expect(result.transformsApplied).toBe(1);
  });

  it('meldet transformsApplied = 0, wenn nur Komponenten gepatcht wurden', () => {
    const { root } = subtreeWithNode('n1');
    const result = applyAssetOverrides(
      { byNodeId: LEGACY_PATCH },
      makeSubtreeResolvers(root),
      { occurrence: 'occ', assetId: 'press' },
    );
    // The compose hook skips its `updateMatrixWorld` walk on this number, so a
    // wrong zero is a stale matrix and a wrong non-zero is wasted work.
    expect(result.transformsApplied).toBe(0);
    expect(result.applied).toBe(1);
  });

  it('behandelt "trs" in applyComponentPatch weiterhin nur als Komponentennamen', () => {
    // Stated directly: if some file really does carry a component called "trs",
    // it is a component and keeps behaving like one. Nothing here special-cases
    // the NAME — the separation is structural.
    const node = new Object3D();
    applyComponentPatch(node, { trs: { anything: 1 } });
    expect((node.userData.realvirtual as Record<string, unknown>).trs).toEqual({ anything: 1 });
    expect(node.position.toArray()).toEqual([0, 0, 0]);
  });
});

// ─── 2. Read-modify-write must not eat the block ────────────────────────

describe('writeOverride-Roundtrip', () => {
  function referenceNodeWithBoth(): Object3D {
    const node = new Object3D();
    setAssetOverrides(node, {
      byNodeId: { n1: { rvTransport: { speed: 5 } } },
      trsByNodeId: { n1: { position: [1, 2, 3] } },
    });
    return node;
  }

  it('lässt trsByNodeId bei einem Komponentenfeld-Edit unangetastet', () => {
    const node = referenceNodeWithBoth();
    writeOverride(node, 'n1', 'rvTransport', 'speed', 9);

    const after = getAssetOverrides(node)!;
    expect(after.byNodeId.n1).toEqual({ rvTransport: { speed: 9 } });
    expect(after.trsByNodeId).toEqual({ n1: { position: [1, 2, 3] } });
  });

  it('lässt es auch bei einem Edit auf einem ANDEREN Knoten stehen', () => {
    const node = referenceNodeWithBoth();
    writeOverride(node, 'n2', 'Drive', 'TargetSpeed', 100);
    expect(getAssetOverrides(node)!.trsByNodeId).toEqual({ n1: { position: [1, 2, 3] } });
  });

  it('überlebt ein vollständiges Revert der Komponenten-Overrides', () => {
    const node = referenceNodeWithBoth();
    revertComponentOverride(node, 'n1', 'rvTransport');

    const after = getAssetOverrides(node)!;
    // Every component override is gone — and the moved part is still moved.
    expect(after.byNodeId).toEqual({});
    expect(after.trsByNodeId).toEqual({ n1: { position: [1, 2, 3] } });
  });

  it('lässt byPath weiterhin ebenfalls stehen', () => {
    const node = new Object3D();
    setAssetOverrides(node, {
      byNodeId: {},
      byPath: { 'Press/Ram': { Drive: { TargetSpeed: 1 } } },
      trsByNodeId: { n1: { position: [1, 2, 3] } },
    });
    writeOverride(node, 'n1', 'Drive', 'TargetSpeed', 2);

    const after = getAssetOverrides(node)!;
    expect(after.byPath).toEqual({ 'Press/Ram': { Drive: { TargetSpeed: 1 } } });
    expect(after.trsByNodeId).toEqual({ n1: { position: [1, 2, 3] } });
  });

  it('hält den trs-Block für die Komponenten-Leser unsichtbar', () => {
    // The inspector's override badge reads through these two. A transform is
    // not a component field, so it must not light the badge for a component
    // the user never touched.
    const node = referenceNodeWithBoth();
    expect(readOverride(node, 'n1')).toEqual({ rvTransport: { speed: 5 } });
    expect(overriddenFieldsOf(node, 'n1', 'rvTransport')).toEqual(['speed']);
    expect(overriddenFieldsOf(node, 'n1', 'trs')).toEqual([]);
  });
});

// ─── 3. Orphan reporting ────────────────────────────────────────────────

describe('Verwaiste trs-Overrides', () => {
  it('werden gemeldet, nicht stillschweigend verworfen', () => {
    const { root } = subtreeWithNode('n1');
    const result = applyAssetOverrides(
      { byNodeId: {}, trsByNodeId: { gone: { position: [1, 2, 3] } } },
      makeSubtreeResolvers(root),
      { occurrence: 'occ', assetId: 'press' },
    );

    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0].addressing).toBe('trs');
    expect(result.orphaned[0].key).toBe('gone');
    expect(result.orphaned[0].componentTypes).toEqual([]);
  });

  it('bekommen eine eigene, lesbare Meldung', () => {
    const line = describeOrphanedOverride({
      addressing: 'trs', key: 'gone', occurrence: 'occ', assetId: 'press', componentTypes: [],
    });
    // Not "override → node ... no longer exists": a component override that
    // misses its target and a part that has vanished from the layout read
    // completely differently to whoever has to act on the line.
    expect(line).toContain('moved part');
    expect(line).toContain('press');
    expect(line).not.toContain('override →');
  });

  it('unterscheiden sich von einem verwaisten Komponenten-Override', () => {
    const { root } = subtreeWithNode('n1');
    const result = applyAssetOverrides(
      {
        byNodeId: { gone: { Drive: { TargetSpeed: 1 } } },
        trsByNodeId: { gone: { position: [1, 2, 3] } },
      },
      makeSubtreeResolvers(root),
      { occurrence: 'occ', assetId: 'press' },
    );

    expect(result.orphaned.map(o => o.addressing)).toEqual(['nodeId', 'trs']);
    expect(describeOrphanedOverride(result.orphaned[0]))
      .not.toBe(describeOrphanedOverride(result.orphaned[1]));
  });
});
