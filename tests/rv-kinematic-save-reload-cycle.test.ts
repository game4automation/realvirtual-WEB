// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-727 — the reported bug itself: open → save → reopen → save must be a
 * FIXPOINT of the node hierarchy.
 *
 * Before the fix the second load re-parented the group member, the second
 * export wrote that restructuring into the GLB, and every further cycle carried
 * it. `hierarchySignature` compares structure AND transforms AND
 * `matrixAutoUpdate`, so a "same shape but frozen" tree cannot pass either.
 *
 * `exportAssetGlb(r.root, 'kin')` — the CONTENT ROOT plus a name, as every real
 * call site does. Handing it the outer `Scene` without a name makes the export
 * fall back to naming the scene 'Asset' while the fixture scene stays unnamed,
 * and the signatures then differ by a pure naming artefact.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Vector3, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { DriveDragPreview } from '@rv-private/plugins/asset-editor/drive-drag-preview';
import { resolveEditorDriveGizmoSource } from '@rv-private/plugins/asset-editor/editor-drive-gizmo-source';
import { buildKinematicGroupGLB, hierarchySignature } from './kinematic-fixture';

const AUTHORING = { preserveHierarchy: true, preserveAuthoringHierarchy: true } as const;

describe('kinematic save/reload cycle (plan-727)', () => {
  it('open -> save -> reopen -> save keeps the CAD hierarchy AND stays jog-capable', async () => {
    const data = await buildKinematicGroupGLB();

    const s1 = new Scene();
    const r1 = await loadGLB('kin.glb', s1, { data, ...AUTHORING });
    const sig1 = hierarchySignature(r1.root);
    expect(s1.getObjectByName('Part')?.parent?.name).toBe('CadRoot');
    // F7 precondition: a frozen member never rebuilds its matrix from the
    // quaternion a drive writes — the drive would "run" while nothing moves.
    expect(s1.getObjectByName('Part')?.matrixAutoUpdate).toBe(true);

    const glb1 = await exportAssetGlb(r1.root, 'kin');
    const s2 = new Scene();
    const r2 = await loadGLB('kin.glb', s2, { data: glb1, ...AUTHORING });
    expect(hierarchySignature(r2.root)).toEqual(sig1);

    const glb2 = await exportAssetGlb(r2.root, 'kin');
    const s3 = new Scene();
    const r3 = await loadGLB('kin.glb', s3, { data: glb2, ...AUTHORING });
    expect(hierarchySignature(r3.root)).toEqual(sig1);
  });

  it('the member is not frozen out of the per-frame matrix recursion either', async () => {
    // Phase 11 (freezeStaticMatrices) asks the same physical-parent-chain
    // question and would otherwise gate the member — and its CAD ancestors,
    // which ARE the recursion gate — out of scene.updateMatrixWorld().
    const s = new Scene();
    await loadGLB('kin.glb', s, { data: await buildKinematicGroupGLB(), ...AUTHORING });
    const part = s.getObjectByName('Part')!;
    expect(part.matrixWorldAutoUpdate).toBe(true);
    for (let p: Object3D | null = part.parent; p && p !== s; p = p.parent) {
      expect(p.matrixWorldAutoUpdate).toBe(true);
    }
  });

  it('jogging the axis visibly moves a non-reparented group member', async () => {
    const s = new Scene();
    const r = await loadGLB('kin.glb', s, { data: await buildKinematicGroupGLB(), ...AUTHORING });
    const part = s.getObjectByName('Part')!;
    const axis = s.getObjectByName('Kine')!;

    const viewer = {
      groups: r.groups,
      registry: r.registry,
      on: () => () => {},
      markRenderDirty() {},
      markShadowsDirty() {},
    } as unknown as RVViewer;

    const axisPath = r.registry.getPathForNode(axis)!;
    const source = resolveEditorDriveGizmoSource(viewer, axisPath)!;
    const driver = new DriveDragPreview(viewer);

    const before = part.getWorldPosition(new Vector3()).clone();
    driver.preview({ viewer, source, node: axis, position: -1000 });
    s.updateMatrixWorld(true);
    const during = part.getWorldPosition(new Vector3()).clone();
    // Not merely "the drive reports a position": the member actually moved.
    expect(during.distanceTo(before)).toBeGreaterThan(0.5);

    driver.cancel({ viewer, source, node: axis, position: 0 });
    s.updateMatrixWorld(true);
    expect(part.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-6);
  });
});
