// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-673 — a `FreeBody` / `Movable` node must stay matrix-dynamic, so that the
 * pose the MuJoCo mirror writes actually reaches the DRAWN geometry.
 *
 * The measured defect (live walker demo, `obs_cube_s2` over 40.8 s): MuJoCo
 * qpos advanced +506.0 mm, the node's `position` advanced +506.0 mm, and the
 * node's `matrixWorld` — and with it the drawn chunk mesh — moved 0.0000 mm.
 * Cause: `processMeshes()` classified the obstacle meshes as static (their only
 * components, `FreeBody` and `Movable`, were in neither motion key list), the
 * bake copied that `matrixAutoUpdate = false` into the template, and Three.js
 * never re-composes a local matrix with that flag off. The physics and the
 * collision were fine the whole time — the robot walked through the PICTURE of
 * the cube. The causal control on `obs_cube_s1` (+0.3 m plus
 * `updateMatrixWorld(true)`, read at the drawn chunk) was 0.00 mm with the flag
 * off against 300.00 mm with it on.
 *
 * Every assertion here therefore hangs on the BAKED, PLACED result — a test on
 * the authoring tree would be green and blind (the authored tree moves fine; it
 * is not what is drawn). And the chunk mesh is looked up by `traverse` on its
 * `mover:` name, never through the registry and never through the node that was
 * written to: the oracle must not take the same path as the subject.
 */
import { describe, it, expect } from 'vitest';
import { Mesh, MeshStandardMaterial, Object3D } from 'three';
// Side effect: component capabilities + schemas, `FreeBody` / `Movable` among
// them (rv-scene-loader imports './rv-free-body').
import '../src/core/engine/rv-scene-loader';
import { processMeshes } from '../src/core/engine/rv-scene-loader';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { bakeAndPlace, group, texturedMesh, withComponent } from './fixtures/bake-fixture';

/** Translation x of a node's world matrix. */
function worldX(node: Object3D): number {
  return node.matrixWorld.elements[12];
}

/**
 * The DRAWN chunk mesh whose name starts with `mover:` and that belongs to
 * `ownerName` — found by walking the placed tree and reading names, which is
 * deliberately NOT how the production code addresses it.
 */
function drawnMoverChunk(placed: Object3D, ownerName: string): Mesh {
  let found: Mesh | null = null;
  placed.traverse((n) => {
    if (found) return;
    const m = n as Mesh;
    if (!m.isMesh) return;
    if (!m.name.startsWith('mover:')) return;
    // `mover:<nodePath>` (plus an optional `|tex:…` / `|grp:…` suffix).
    const path = m.name.slice('mover:'.length).split('|')[0];
    if (path === ownerName || path.endsWith('/' + ownerName)) found = m;
  });
  if (!found) {
    const names: string[] = [];
    placed.traverse((n) => { if ((n as Mesh).isMesh) names.push(n.name); });
    throw new Error(`no drawn mover chunk for "${ownerName}" — meshes: ${names.join(', ')}`);
  }
  return found;
}

/** The one drawn static chunk mesh (`static` / `tex:<uuid>`). */
function drawnStaticChunk(placed: Object3D): Mesh {
  let found: Mesh | null = null;
  placed.traverse((n) => {
    if (found) return;
    const m = n as Mesh;
    if (m.isMesh && !m.name.startsWith('mover:')) found = m;
  });
  if (!found) throw new Error('no drawn static chunk');
  return found;
}

/** Find a surviving template node by name. */
function nodeByName(placed: Object3D, name: string): Object3D {
  let found: Object3D | null = null;
  placed.traverse((n) => { if (!found && n.name === name) found = n; });
  if (!found) throw new Error(`node "${name}" did not survive the bake`);
  return found;
}

/**
 * The walker's shape: a physics body that the mirror poses (`FreeBody`), a body
 * the user may drag (`Movable`), and a genuinely static wall that carries no
 * motion-bearing component at all.
 */
function buildWalkerLikeTree(): Object3D {
  const root = group('walker_scene');
  const cube = withComponent(
    texturedMesh('obs_cube_s1', new MeshStandardMaterial({ color: 0xaa4422 }), [0, 0, 0]),
    'FreeBody',
    { Shape: 'Box', Mass: 1 },
  );
  const crate = withComponent(
    texturedMesh('drag_crate', new MeshStandardMaterial({ color: 0x4488aa }), [2, 0, 0]),
    'Movable',
    { Axes: 'XZ' },
  );
  const structure = group('hall');
  const wall = texturedMesh('wall', new MeshStandardMaterial({ color: 0x888888 }), [0, 0, 4]);
  structure.add(wall);
  root.add(cube, crate, structure);
  return root;
}

describe('plan-673 — FreeBody / Movable stay matrix-dynamic through the bake', () => {
  it('processMeshes does NOT classify a FreeBody / Movable mesh as static', () => {
    const root = buildWalkerLikeTree();

    processMeshes(root);

    // The direct, narrowest assertion on the production classifier.
    expect(nodeByName(root, 'obs_cube_s1').matrixAutoUpdate, 'FreeBody mesh').toBe(true);
    expect(nodeByName(root, 'drag_crate').matrixAutoUpdate, 'Movable mesh').toBe(true);
  });

  it('NEGATIVE DIRECTION: a mesh without a motion-bearing component is still frozen', () => {
    // Without this the fix buys motion by losing the static optimisation for
    // every mesh in every document, and nobody would notice.
    const root = buildWalkerLikeTree();

    processMeshes(root);

    expect(nodeByName(root, 'wall').matrixAutoUpdate, 'plain static wall').toBe(false);
  });

  it('a pose written on a baked FreeBody node reaches the DRAWN chunk mesh', async () => {
    const root = buildWalkerLikeTree();
    // The production order: classify, bake destructively, place, then freeze.
    processMeshes(root);
    const reg = new BakeRegistry();
    const { template } = await bakeAndPlace(root, reg);
    freezeStaticMatrices(template);

    const chunk = drawnMoverChunk(template, 'obs_cube_s1');
    template.updateMatrixWorld(true);
    const before = worldX(chunk);

    // Exactly what `RVMuJoCoMirror` does: write the node pose, let three
    // recompose. +0.3 m is the causal control's amount.
    const node = nodeByName(template, 'obs_cube_s1');
    node.position.x += 0.3;
    template.updateMatrixWorld(true);

    // 300.00 mm at the DRAWN mesh, not 0.00 mm.
    expect(worldX(chunk) - before).toBeCloseTo(0.3, 5);
  });

  it('a pose written on a baked Movable node reaches the DRAWN chunk mesh', async () => {
    const root = buildWalkerLikeTree();
    processMeshes(root);
    const reg = new BakeRegistry();
    const { template } = await bakeAndPlace(root, reg);
    freezeStaticMatrices(template);

    const chunk = drawnMoverChunk(template, 'drag_crate');
    template.updateMatrixWorld(true);
    const before = worldX(chunk);

    nodeByName(template, 'drag_crate').position.x += 0.3;
    template.updateMatrixWorld(true);

    expect(worldX(chunk) - before).toBeCloseTo(0.3, 5);
  });

  it('NEGATIVE DIRECTION: the static chunk keeps matrixAutoUpdate = false after the freeze', async () => {
    const root = buildWalkerLikeTree();
    processMeshes(root);
    const reg = new BakeRegistry();
    const { template } = await bakeAndPlace(root, reg);
    freezeStaticMatrices(template);

    const staticChunk = drawnStaticChunk(template);
    expect(staticChunk.matrixAutoUpdate, 'static chunk mesh').toBe(false);

    // And the optimisation is real: a write to a frozen node changes nothing.
    template.updateMatrixWorld(true);
    const before = worldX(staticChunk);
    staticChunk.position.x += 0.3;
    template.updateMatrixWorld(true);
    expect(worldX(staticChunk) - before).toBeCloseTo(0, 6);
  });
});

describe('plan-673 — freezeStaticMatrices FORCES matrixAutoUpdate on a local mover', () => {
  it('thaws a mover node an earlier pass had frozen (the structural net)', async () => {
    // The future-proofing half: whatever froze a local mover earlier — a
    // classifier whose key list does not yet know the next pose-writing
    // component type, or a template copied from such a node — this pass is the
    // last word and turns the flag back on. Simulated here by freezing the
    // mover node BEFORE the freeze pass, exactly as the defect did.
    const root = buildWalkerLikeTree();
    processMeshes(root);
    const reg = new BakeRegistry();
    const { template } = await bakeAndPlace(root, reg);

    const node = nodeByName(template, 'obs_cube_s1');
    node.matrixAutoUpdate = false;            // the defect, reproduced
    const chunk = drawnMoverChunk(template, 'obs_cube_s1');
    chunk.matrixAutoUpdate = false;

    freezeStaticMatrices(template);

    expect(node.matrixAutoUpdate, 'mover node thawed').toBe(true);

    template.updateMatrixWorld(true);
    const before = worldX(chunk);
    node.position.x += 0.3;
    template.updateMatrixWorld(true);
    expect(worldX(chunk) - before).toBeCloseTo(0.3, 5);
  });

  it('a Drive node frozen by an earlier pass is thawed too (not a FreeBody special case)', () => {
    const root = new Object3D();
    root.name = 'root';
    const drive = withComponent(new Object3D(), 'Drive');
    drive.name = 'Axis';
    drive.matrixAutoUpdate = false;
    const part = new Mesh();
    part.name = 'part';
    root.add(drive);
    drive.add(part);

    freezeStaticMatrices(root);

    expect(drive.matrixAutoUpdate).toBe(true);
    // A descendant of a mover rides along; its own local matrix is constant, so
    // it stays frozen — that is the Mauser-scale saving and must not regress.
    expect(part.matrixAutoUpdate).toBe(false);
  });
});
