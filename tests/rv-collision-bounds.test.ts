// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.3 / plan-781 — the per-tick union world box (F5), visibility
 * (F6/F12) and the exclusion of deformed and rewritten geometry (F17/F19).
 *
 * The articulation case is the regression test of plan-394: a cached box would
 * freeze the build pose, so a robot arm extending would keep the box of its
 * folded pose and the broadphase would drop real collisions forever. Since
 * plan-781 the body is BAKED (two mover chunks) and the box is re-derived from
 * fresh part poses.
 *
 * The plan-394 `aabbOnly` fallback is gone: a body part either has the pick
 * structure (chunk, or a keep mesh's KeepPick) or takes the brute-force path.
 * The only box-only case left is a live machining stock box
 * (`rv-collision-machining.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, SkinnedMesh, MathUtils } from 'three';
import type { BufferGeometry } from 'three';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { KEEP_BRUTE_TRIS } from '../src/core/engine/rv-pick-backend';
import { bakeCollisionScene, bodyNode, boxMesh, plainGroup } from './collision-fixture';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';

registerComponentSchema('TestCollisionDynGeo', {}, { bake: 'keep', dynamicGeometry: true });

const MAT = new MeshBasicMaterial();

/** Robot (mover) with an "upper arm" (mover) that can slide away from the root. */
async function articulatedBody() {
  const root = plainGroup('Asset',
    bodyNode('Robot', { role: 'Robot', mover: true },
      bodyNode('Arm', { role: 'Robot', mover: true })),
  );
  const s = await bakeCollisionScene(root);
  const robot = s.node('Robot');
  const arm = s.node('Arm');
  // Only the outer node carries the checked role (the arm's extras keep it alive).
  s.manager.register(robot, 'Robot');
  s.manager.rebuild();
  return { manager: s.manager, root: robot, arm, scene: s.scene };
}

function bodyOf(manager: RVCollisionManager, root: Object3D) {
  const b = manager.bodies.find((x) => x.root === root);
  if (!b) throw new Error('body not built');
  return b;
}

beforeEach(() => __resetCollisionAlertStore());
afterEach(() => vi.restoreAllMocks());

describe('body bounds', () => {
  it('grows when a child moves relative to the body root (articulation, F5)', async () => {
    const { manager, root, arm } = await articulatedBody();
    const body = bodyOf(manager, root);
    expect(body.parts).toHaveLength(2);                 // two mover chunks
    manager.updateBodyBounds(body);
    const folded = body.worldBox.max.x;

    arm.position.x += 5;                               // no updateMatrixWorld: fresh poses (F16)
    manager.updateBodyBounds(body);
    expect(body.moved).toBe(true);
    expect(body.worldBox.max.x).toBeGreaterThan(folded + 4);
  });

  it('tracks world scale applied on a parent', async () => {
    const { manager, root } = await articulatedBody();
    const body = bodyOf(manager, root);
    manager.updateBodyBounds(body);
    const before = body.worldBox.max.x - body.worldBox.min.x;

    root.scale.setScalar(2);
    manager.updateBodyBounds(body);
    const after = body.worldBox.max.x - body.worldBox.min.x;
    expect(after).toBeCloseTo(before * 2, 5);
  });

  it('tracks rotation of the body root (wider axis-aligned box at 45 deg)', async () => {
    const { manager, root } = await articulatedBody();
    const body = bodyOf(manager, root);
    manager.updateBodyBounds(body);
    const before = body.worldBox.max.x - body.worldBox.min.x;

    root.rotation.y = MathUtils.degToRad(45);
    manager.updateBodyBounds(body);
    const after = body.worldBox.max.x - body.worldBox.min.x;
    expect(after).toBeGreaterThan(before * 1.3);   // 1 -> sqrt(2)
  });

  it('does not move when nothing moved (motion stamp, F5)', async () => {
    const { manager, root } = await articulatedBody();
    const body = bodyOf(manager, root);
    manager.updateBodyBounds(body);
    manager.updateBodyBounds(body);
    expect(body.moved).toBe(false);
  });

  it('excludes parts hidden by an ancestor (F6)', async () => {
    const { manager, root, arm } = await articulatedBody();
    const body = bodyOf(manager, root);
    arm.position.x = 5;
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeGreaterThan(4);

    arm.visible = false;
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeLessThan(1);
  });

  it('excludes parts with layers.mask === 0 (renderer-masked sources, F6)', async () => {
    const { manager, root, arm } = await articulatedBody();
    const body = bodyOf(manager, root);
    arm.position.x = 5;
    const armPart = body.parts.find((p) => p.mesh.parent === arm)!;
    armPart.mesh.layers.mask = 0;
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeLessThan(1);
  });

  it('produces an empty box when every part is hidden (no phantom overlap)', async () => {
    const { manager, root } = await articulatedBody();
    const body = bodyOf(manager, root);
    root.visible = false;
    manager.updateBodyBounds(body);
    expect(body.worldBox.isEmpty()).toBe(true);
  });

  it('excludes SkinnedMesh / morph-target geometry and warns once (F17)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Chain';
    root.add(boxMesh({ name: 'Solid' }));

    const skinned = new SkinnedMesh(new BoxGeometry(1, 1, 1), MAT);
    skinned.name = 'Skinned';
    skinned.position.x = 20;
    root.add(skinned);

    const morph = new Mesh(new BoxGeometry(1, 1, 1), MAT);
    morph.name = 'Morph';
    morph.morphTargetInfluences = [0];
    morph.position.x = 40;
    root.add(morph);

    scene.add(root);
    scene.updateMatrixWorld(true);

    const manager = new RVCollisionManager();
    manager.register(root, 'Machine');
    manager.rebuild();
    const body = bodyOf(manager, root);

    expect(body.parts.map((p) => p.mesh.name)).toEqual(['Solid']);
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeLessThan(1);

    const deformWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('deformed mesh'));
    expect(deformWarnings).toHaveLength(1);

    // A second rebuild in the same model load must NOT warn again.
    manager.invalidate();
    manager.rebuild();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('deformed mesh'))).toHaveLength(1);
  });

  it('excludes keep meshes with rewritten geometry (dynamicGeometry, F19) and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = new Object3D();
    root.name = 'Machine';
    root.add(boxMesh({ name: 'Solid' }));
    const band = boxMesh({ name: 'Band', pos: [3, 0, 0] });
    band.userData.realvirtual = { TestCollisionDynGeo: { enabled: true } };
    root.add(band);
    const manager = new RVCollisionManager();
    manager.register(root, 'Machine');
    manager.rebuild();
    expect(bodyOf(manager, root).parts.map((p) => p.mesh.name)).toEqual(['Solid']);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('rewritten geometry'))).toHaveLength(1);
    manager.invalidate();
    manager.rebuild();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('rewritten geometry'))).toHaveLength(1);
  });

  it('a big keep mesh joins through its KeepPick; a small one is brute-forced — no boundsTree is built', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = new Object3D();
    root.name = 'Machine';
    const big = boxMesh({ name: 'Big', segments: 12 });            // 12·12·12 → 1728 triangles
    const small = boxMesh({ name: 'Small', pos: [3, 0, 0] });      // 12 triangles
    root.add(big, small);
    const manager = new RVCollisionManager();
    manager.register(root, 'Machine');
    manager.rebuild();
    const parts = bodyOf(manager, root).parts;
    const bigPart = parts.find((p) => p.mesh === big)!;
    const smallPart = parts.find((p) => p.mesh === small)!;
    expect(bigPart.triangles).toBeGreaterThan(KEEP_BRUTE_TRIS);
    expect(bigPart.pick).not.toBeNull();
    expect(smallPart.pick).toBeNull();
    expect((big.geometry as BufferGeometry).boundsTree).toBeUndefined();
    expect((small.geometry as BufferGeometry).boundsTree).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
