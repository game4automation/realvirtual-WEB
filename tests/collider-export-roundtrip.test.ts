// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * collider-export-roundtrip.test.ts — plan-525 T3.
 *
 * Authored BoxColliders (one on an empty node, one on the `Collider` child a
 * mesh node gets) and a WebPhysicsZone survive save → reload with their
 * extras unchanged; the saved GLB carries no collider / zone gizmo; a second
 * save of the reloaded asset is byte-identical to the first.
 *
 * PRIVATE-DEPENDENT (the add rules live with the asset editor): listed in
 * `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { addColliderAwareComponent } from '@rv-private/plugins/asset-editor/collider-add-rules';

const rigs: AuthoringRig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) r.dispose(); });

function find(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

describe('BoxCollider / WebPhysicsZone save round trip (plan-525 T3)', () => {
  it('extras survive save → reload unchanged, no gizmo in the GLB, a re-save is byte-identical', async () => {
    const r = makeAuthoringRig();
    rigs.push(r);
    r.addNode('Plate');
    r.addNode('Chute', { mesh: true });
    r.addNode('Station');
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Plate', 'BoxCollider', {
      center: { x: 0.01, y: 0, z: 0 }, size: { x: 0.18, y: 0.004, z: 0.075 },
    });
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Chute', 'BoxCollider');
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');

    // The live gizmos exist in the editor scene …
    const plate = r.registry.getNode('Asset/Plate')!;
    expect(plate.children.some((c) => c.userData._rvGizmo === true)).toBe(true);
    const authored = {
      plate: JSON.parse(JSON.stringify(rvOf(plate))),
      collider: JSON.parse(JSON.stringify(rvOf(r.registry.getNode('Asset/Chute/Collider')))),
      station: JSON.parse(JSON.stringify(rvOf(r.registry.getNode('Asset/Station')))),
    };
    expect(authored.station.BoxCollider.size).toEqual({ x: 1, y: 1, z: 1 });
    expect(authored.station.WebPhysicsZone.WholeScene).toBe(false);

    const glb1 = await exportAssetGlb(r.root, 'Asset');
    const gltf = await new GLTFLoader().parseAsync(glb1, '');
    let gizmoNodes = 0;
    gltf.scene.traverse((n) => { if (n.userData?._rvGizmo) gizmoNodes++; });
    expect(gizmoNodes).toBe(0); // … and never reach the file

    const plate2 = find(gltf.scene, 'Plate')!;
    const collider2 = find(gltf.scene, 'Collider')!;
    const station2 = find(gltf.scene, 'Station')!;
    expect(plate2.children).toHaveLength(0);
    expect(rvOf(plate2)).toEqual(authored.plate);
    expect(rvOf(collider2)).toEqual(authored.collider);
    expect(rvOf(station2)).toEqual(authored.station);
    expect(collider2.parent?.name).toBe('Chute');

    // Save the reloaded asset again: the same bytes. (Plain GLTFLoader copies
    // the glTF node name into `userData.name`; the viewer's loader does not
    // hand that on, so it is dropped here to compare like with like.)
    const root2 = find(gltf.scene, 'Asset') ?? gltf.scene;
    root2.traverse((n) => { delete (n.userData as Record<string, unknown>).name; });
    const glb2 = await exportAssetGlb(root2, 'Asset');
    expect(new Uint8Array(glb2)).toEqual(new Uint8Array(glb1));
  });
});
