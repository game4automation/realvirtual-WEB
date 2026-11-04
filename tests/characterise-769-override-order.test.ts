// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0 — characterisation: override precedence over two levels,
 * COMPOSE (authoring load) vs PLACEMENT (runtime load), at HEAD.
 *
 *   Part      Motor {Drive TargetSpeed 100, NodeId nid-motor}
 *   Assembly  Base + PartRef → Part      override byNodeId nid-motor → 200   (inner)
 *   Layout    AsmRef → Assembly          override byPath …/Motor   → 300   (outer)
 *
 * Unity rule (plan-769 §8, "instance override beats asset value"): the OUTER
 * value wins — 300. Since plan-769 Phase 4b both paths agree: compose and the
 * placement instancer apply every override set through `applyOverrideLayers`
 * (the outer file wins); the placement path routes the outer override into the
 * nested occurrence instead of refusing it as `nested-reference` (plan-757).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { compose, type ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import { setAssetOverrides } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { bootRealLoaderViewer, dataUrlOf, findByName, referenceNode, type Booted } from './helpers/nested-placement-fixture';

const material = new MeshStandardMaterial({ color: 0x808080 });

function partTree(): Group {
  const root = new Group();
  root.name = 'Part';
  const body = new Mesh(new BoxGeometry(1, 0.3, 1), material);
  body.name = 'Body';
  root.add(body);
  const motor = new Object3D();
  motor.name = 'Motor';
  motor.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };
  setNodeId(motor, 'nid-motor');
  motor.add(new Mesh(new BoxGeometry(0.2, 0.2, 0.2), material));
  root.add(motor);
  return root;
}

function assemblyTree(partUrl: string): Group {
  const root = new Group();
  root.name = 'Assembly';
  const base = new Mesh(new BoxGeometry(3, 0.5, 3), material);
  base.name = 'Base';
  root.add(base);
  const partRef = referenceNode('PartRef', 'nid-partref', partUrl, false, [0, 0.5, 0], 'part');
  setAssetOverrides(partRef, { byAddress: { '#nid-motor': { Drive: { TargetSpeed: 200 } } } });
  root.add(partRef);
  return root;
}

function layoutTree(assemblyUrl: string, outerPath: string): Group {
  const root = new Group();
  root.name = 'Layout';
  const asmRef = referenceNode('AsmRef', 'nid-asm', assemblyUrl, true, [5, 0, 0], 'assembly');
  setAssetOverrides(asmRef, { byAddress: {}, legacyByPath: { [outerPath]: { Drive: { TargetSpeed: 300 } } } });
  root.add(asmRef);
  return root;
}

function speedOf(node: Object3D | null): unknown {
  return (node?.userData.realvirtual as { Drive?: { TargetSpeed?: unknown } } | undefined)?.Drive?.TargetSpeed;
}

describe('plan-769 — override precedence, compose AND placement: the outer file wins', () => {
  let booted: Booted | null = null;
  afterEach(() => { booted?.h.dispose(); booted = null; resetProblemsForTests(); });

  it('compose: the OUTER override wins (300)', async () => {
    const partBytes = await objectToGlb(partTree());
    const asmBytes = await objectToGlb(assemblyTree('lib/part.glb'));
    const table: Record<string, { bytes: ArrayBuffer; url: string }> = {
      part: { bytes: partBytes, url: 'lib/part.glb' },
      assembly: { bytes: asmBytes, url: 'lib/assembly.glb' },
    };
    const resolve: ReferenceResolver = async (ref) => {
      const hit = table[ref.assetId];
      return hit ? { bytes: hit.bytes, url: hit.url, signatureState: 'none', signaturePresent: false } : null;
    };
    const layout = layoutTree('lib/assembly.glb', 'PartRef/Part/Motor');
    const result = await compose(layout, { baseUrl: 'layout.glb', resolve });
    expect(result.orphanedOverrides).toEqual([]);
    expect(speedOf(findByName(layout, 'Motor'))).toBe(300);
    result.dispose();
  });

  it('placement: the outer override is routed into the nested placement and wins (300) — no orphan', async () => {
    resetProblemsForTests();
    booted = await bootRealLoaderViewer();
    const { h } = booted;
    const partUrl = dataUrlOf(await objectToGlb(partTree()));
    const asmUrl = dataUrlOf(await objectToGlb(assemblyTree(partUrl)));
    await h.viewer.loadModel('layout.glb', { data: await objectToGlb(layoutTree(asmUrl, 'PartRef/Motor')) });
    await h.viewer.whenSceneReady();
    const root = h.viewer.currentModelRoot!;
    const motor = findByName(root, 'Motor');
    expect(motor, 'the nested Part materialised').not.toBeNull();
    expect(speedOf(motor)).toBe(300);
    expect(getProblems().filter((p) => p.code === 'override-orphaned')).toEqual([]);
  });
});
