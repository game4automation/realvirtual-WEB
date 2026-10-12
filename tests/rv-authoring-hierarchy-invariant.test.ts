// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-727 — the invariant guard: an AUTHORING load never mutates the GLB node
 * hierarchy.
 *
 * `applyKinematicParenting()` (loader Phase 8b) was the only structure-mutating
 * load phase without a gate, so every asset-editor reopen restructured the
 * live tree and the next save baked that into the GLB — after which the CAD
 * re-import silently lost the moved nodes.
 *
 * Since plan-757 Phase 3 commit B the guard is structural: the init has NO
 * re-parent pass left in any mode. Re-parenting happens exactly once, in
 * `prepare` of the recipe (the `Kinematic` pre-bake hook), on the throwaway
 * tree of a BAKED load — so a runtime load still moves the members (their
 * geometry rides the axis' mover chunk), while every load that does not bake
 * (the asset editor, a test session, a load without a bake registry) sees the
 * authored tree. The old counter-guard ("`preserveHierarchy` alone must keep
 * re-parenting, for the embed viewer") is history: the embed bakes since
 * plan-754 D20, and `preserveHierarchy` alone now means "authored tree, no
 * bake" — exactly what its only remaining setter, the asset editor, wants.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadGLB, processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { buildKinematicGroupGLB, buildKinematicParentGLB, buildKinematicParentWithMeshGLB } from './kinematic-fixture';

/** The runtime entry: a bake registry, inline pick port. */
function baked() {
  return { bakeRegistry: new BakeRegistry(), bakePickPort: createPickBuildPort({ createWorker: () => null }) };
}

/** Parse the fixture into a bare, unregistered subtree — the shape `processExtras` is for. */
async function loadSubtreeForProcessExtras(data: ArrayBuffer): Promise<{
  root: Object3D; scene: Scene; base: ReturnType<typeof buildInitContext>;
}> {
  const parsed = await new GLTFLoader().parseAsync(data, '');
  const scene = new Scene();
  scene.add(parsed.scene);
  return {
    root: parsed.scene,
    scene,
    // plan-757 F4: the shared context from the ONE builder; the authoring flag
    // stays per-source, exactly as before the signature migration.
    base: buildInitContext({
      registry: new NodeRegistry(), signalStore: new SignalStore(), transportManager: new RVTransportManager(), scene,
    }),
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

  it('runtime (baked) load: the member rides the axis — its geometry is the mover chunk of Kine', async () => {
    const data = await buildKinematicGroupGLB();
    const scene = new Scene();
    const r = await loadGLB('kin.glb', scene, { data, ...baked() });
    expect(r.bakedAsset).not.toBeNull();
    // `Part` carries only a `Group`: it survives as GEOMETRY, not as a node,
    // and the `Kinematic` hook moved it under `Kine` before the bake — so the
    // only chunk is the axis' mover chunk (partitioned by its group `G`,
    // plan-755); no static chunk exists.
    const keys = r.bakedAsset!.chunks.map((c) => c.key);
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith('mover:Kine')).toBe(true);
    expect(keys[0]).toContain('grp:G');
    expect(scene.getObjectByName('Part')).toBeUndefined();
    expect(scene.getObjectByName('Kine')).toBeDefined();
  });

  it('preserveHierarchy alone (no bake, no authoring flag) leaves the tree authored too — the init moves nothing', async () => {
    const data = await buildKinematicGroupGLB();
    const scene = new Scene();
    const r = await loadGLB('kin.glb', scene, { data, preserveHierarchy: true });
    expect(r.bakedAsset).toBeNull();
    expect(scene.getObjectByName('Part')?.parent?.name).toBe('CadRoot');
    // ...and the member is still dynamic (plan-727 F8 reclassification).
    expect(scene.getObjectByName('Part')?.matrixAutoUpdate).toBe(true);
  });

  it('KinematicParentEnable: authored under CadRoot without a bake, under Mount with one', async () => {
    const a = new Scene();
    await loadGLB('kin.glb', a, { data: await buildKinematicParentGLB(), preserveAuthoringHierarchy: true });
    expect(a.getObjectByName('Kine')?.parent?.name).toBe('CadRoot');

    // The baked runtime: the hook moves the axis under `Mount` on `tmp`, the
    // template arrives with it there. (The fixture needs geometry — a document
    // that draws nothing never runs the recipe, see the boundary case below.)
    const b = new Scene();
    const r = await loadGLB('kin.glb', b, { data: await buildKinematicParentWithMeshGLB(), ...baked() });
    expect(r.bakedAsset).not.toBeNull();
    expect(b.getObjectByName('Kine')?.parent?.name).toBe('Mount');
  });

  it('boundary: a document without any geometry never bakes, so nothing re-parents it either', async () => {
    // `buildKinematicParentGLB` has no mesh. The recipe is the ONLY re-parent
    // mechanism and it runs inside the bake, which a drawing-less document
    // skips (`meshCount > 0`); such a document keeps its authored tree.
    const s = new Scene();
    const r = await loadGLB('kin.glb', s, { data: await buildKinematicParentGLB(), ...baked() });
    expect(r.bakedAsset).toBeNull();
    expect(s.getObjectByName('Kine')?.parent?.name).toBe('CadRoot');
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

  // F3 — the second init site. Since commit B it re-parents in NO mode.
  it('processExtras with the authoring flag does not reparent (asset-editor path)', async () => {
    const { root, base } = await loadSubtreeForProcessExtras(await buildKinematicGroupGLB());
    processExtras(root, base, { preserveAuthoringHierarchy: true });
    expect(root.getObjectByName('Part')?.parent?.name).toBe('CadRoot');
  });

  it('processExtras without the flag does not reparent either — the names still flow', async () => {
    const { root, base } = await loadSubtreeForProcessExtras(await buildKinematicGroupGLB());
    const r = processExtras(root, base, {});
    expect(root.getObjectByName('Part')?.parent?.name).toBe('CadRoot');
    expect(r.kinematicGroupNames).toEqual(['G']);
  });
});
