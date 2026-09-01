// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-727 — the invariant guard: an AUTHORING load never mutates the GLB node
 * hierarchy.
 *
 * `applyKinematicParenting()` (Phase 8b) was the only structure-mutating load
 * phase without a gate, so every asset-editor reopen restructured the live tree
 * and the next save baked that into the GLB — after which the CAD re-import
 * silently lost the moved nodes.
 *
 * The counter-guard matters just as much: `preserveHierarchy` ALONE must keep
 * re-parenting, because `RVEmbedViewer` is a simulating production runtime that
 * sets it purely for pickability. Gating Phase 8b on that flag would freeze
 * embedded kinematics with no error and no log.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadGLB, processExtras } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { buildKinematicGroupGLB, buildKinematicParentGLB } from './kinematic-fixture';

/** Parse the fixture into a bare, unregistered subtree — the shape `processExtras` is for. */
async function loadSubtreeForProcessExtras(data: ArrayBuffer): Promise<{
  root: Object3D; scene: Scene; args: [NodeRegistry, SignalStore, RVTransportManager, Scene];
}> {
  const parsed = await new GLTFLoader().parseAsync(data, '');
  const scene = new Scene();
  scene.add(parsed.scene);
  return {
    root: parsed.scene,
    scene,
    args: [new NodeRegistry(), new SignalStore(), new RVTransportManager(), scene],
  };
}

describe('authoring load never mutates the GLB hierarchy (plan-727)', () => {
  it('preserveAuthoringHierarchy:true leaves the member under its CAD parent', async () => {
    const data = await buildKinematicGroupGLB();
    const scene = new Scene();
    await loadGLB('kin.glb', scene, {
      data, preserveHierarchy: true, preserveAuthoringHierarchy: true,
    });
    expect(scene.getObjectByName('Part')?.parent?.name).toBe('CadRoot');
  });

  it('runtime load reparents — unchanged behaviour', async () => {
    const data = await buildKinematicGroupGLB();
    const scene = new Scene();
    await loadGLB('kin.glb', scene, { data });
    expect(scene.getObjectByName('Part')?.parent?.name).toBe('Kine');
  });

  // F2 — the embed-viewer regression guard. preserveHierarchy alone must NOT gate.
  it('preserveHierarchy WITHOUT the authoring flag still reparents (embed viewer)', async () => {
    const data = await buildKinematicGroupGLB();
    const scene = new Scene();
    await loadGLB('kin.glb', scene, { data, preserveHierarchy: true });
    expect(scene.getObjectByName('Part')?.parent?.name).toBe('Kine');
  });

  it('KinematicParentEnable is skipped in authoring mode too', async () => {
    const data = await buildKinematicParentGLB();

    const a = new Scene();
    await loadGLB('kin.glb', a, { data, preserveAuthoringHierarchy: true });
    expect(a.getObjectByName('Kine')?.parent?.name).toBe('CadRoot');

    const b = new Scene();
    await loadGLB('kin.glb', b, { data });
    expect(b.getObjectByName('Kine')?.parent?.name).toBe('Mount');
  });

  // F9 — names must still flow so isKinematic() keeps working in the editor UI
  // (listGroupNamesForMenu filters on it to build the group-assignment menu).
  it('kinematicGroupNames is populated even when re-parenting is skipped', async () => {
    const data = await buildKinematicGroupGLB();
    const scene = new Scene();
    const r = await loadGLB('kin.glb', scene, { data, preserveAuthoringHierarchy: true });
    expect(r.kinematicGroupNames).toContain('G');
    expect(r.groups?.isKinematic('G')).toBe(true);
  });

  // F3 — both processExtras callers (the second re-parenting site).
  it('processExtras with the authoring flag does not reparent (asset-editor path)', async () => {
    const { root, args } = await loadSubtreeForProcessExtras(await buildKinematicGroupGLB());
    processExtras(root, ...args, undefined, undefined, undefined, undefined,
      { preserveAuthoringHierarchy: true });
    expect(root.getObjectByName('Part')?.parent?.name).toBe('CadRoot');
  });

  it('processExtras without the flag DOES reparent (layout-planner path)', async () => {
    const { root, args } = await loadSubtreeForProcessExtras(await buildKinematicGroupGLB());
    processExtras(root, ...args, undefined, undefined, undefined, undefined, {});
    expect(root.getObjectByName('Part')?.parent?.name).toBe('Kine');
  });
});
