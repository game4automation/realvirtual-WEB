// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Unit tests for freezeStaticMatrices (rv-freeze-static).
 *
 * Verifies the static/dynamic classification that gates the per-frame
 * updateMatrixWorld pruning: a node stays dynamic iff it, an ancestor, or a
 * descendant carries a mover component (Drive, Kinematic, Grip,
 * TransportSurface, Source, Sink, MU, Cam, SceneButtonMoveable); everything else
 * is frozen. The scenarios mirror the live cases — including a deep static mesh
 * under a Drive (the "Cylinder001" shape, where the moving mesh has
 * matrixAutoUpdate=false but sits below a Drive) and the plan-417 scene-button
 * cap, which this pass must recognise itself because it runs AFTER component
 * construction and would otherwise re-freeze what the component just thawed.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Mesh } from 'three';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';

/** Tag a node with an rv_extras component (truthy value = present). */
function withComponent<T extends Object3D>(node: T, key: string): T {
  node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), [key]: { enabled: true } };
  return node;
}

function named(name: string, mesh = false): Object3D {
  const n: Object3D = mesh ? new Mesh() : new Object3D();
  n.name = name;
  return n;
}

describe('freezeStaticMatrices', () => {
  it('freezes a fully static subtree', () => {
    const root = named('root');
    const a = named('a'); const b = named('b'); const c = named('c');
    root.add(a); a.add(b); b.add(c);

    const res = freezeStaticMatrices(root);

    // No movers anywhere → every node frozen.
    expect(res.frozen).toBe(4);
    expect([root, a, b, c].every((n) => n.matrixWorldAutoUpdate === false)).toBe(true);
  });

  it('keeps a Drive node, its ancestors and its whole subtree dynamic', () => {
    const root = named('root');
    const mid = named('mid');                       // ancestor of the drive
    const drive = withComponent(named('drive'), 'Drive');
    const child = named('child');                   // descendant of the drive
    const grandchild = named('grandchild', true);
    root.add(mid); mid.add(drive); drive.add(child); child.add(grandchild);

    freezeStaticMatrices(root);

    // Ancestors (root, mid) + drive + descendants (child, grandchild) all dynamic.
    for (const n of [root, mid, drive, child, grandchild]) {
      expect(n.matrixWorldAutoUpdate).toBe(true);
    }
  });

  it('keeps a deep static mesh under a Drive dynamic (matrixAutoUpdate=false case)', () => {
    // Mirrors the live "Cylinder001": a mesh the engine marked static
    // (matrixAutoUpdate=false) but which moves because a Drive sits above it.
    const root = named('root');
    const drive = withComponent(named('CAxis'), 'Drive');
    const inner = named('inner');
    const movingMesh = named('Cylinder001', true);
    movingMesh.matrixAutoUpdate = false; // engine-classified "static" leaf
    root.add(drive); drive.add(inner); inner.add(movingMesh);

    freezeStaticMatrices(root);

    expect(movingMesh.matrixWorldAutoUpdate).toBe(true); // NOT frozen — under a Drive
  });

  it('matches Drive_* variants (Drive_Cylinder, Drive_ErraticPosition, …)', () => {
    const root = named('root');
    const cyl = withComponent(named('cyl'), 'Drive_Cylinder');
    const part = named('part', true);
    root.add(cyl); cyl.add(part);

    freezeStaticMatrices(root);

    expect(cyl.matrixWorldAutoUpdate).toBe(true);
    expect(part.matrixWorldAutoUpdate).toBe(true);
  });

  it('keeps Source/Sink/Transport/Grip/MU subtrees dynamic (runtime MU carriers)', () => {
    for (const key of ['Source', 'Sink', 'TransportSurface', 'Grip', 'Kinematic', 'MU']) {
      const root = named('root');
      const carrier = withComponent(named(key), key);
      const child = named('child', true);
      root.add(carrier); carrier.add(child);

      freezeStaticMatrices(root);

      expect(carrier.matrixWorldAutoUpdate, `${key} carrier`).toBe(true);
      expect(child.matrixWorldAutoUpdate, `${key} child`).toBe(true);
    }
  });

  it('keeps a SceneButtonMoveable cap dynamic (plan-417 order bug)', () => {
    // This pass runs in loader Phase 11 — AFTER component construction — so the
    // thaw in RVSceneButtonMoveable._bind() (Phase 8) cannot survive it. The cap
    // has to be recognised HERE or the button animates only on paper.
    const root = named('root');
    const housing = named('SimpleButton');
    const cap = withComponent(named('Button', true), 'SceneButtonMoveable');
    const sibling = named('Base', true);              // the static button base
    root.add(housing); housing.add(cap); housing.add(sibling);

    freezeStaticMatrices(root);

    expect(cap.matrixWorldAutoUpdate).toBe(true);
    expect(housing.matrixWorldAutoUpdate).toBe(true);  // ancestor of a mover
    // The closure keeps the mover's ancestors and the mover's OWN subtree — a
    // sibling is not in it. The static button base is correctly frozen, and can
    // be: its dynamic parent still recurses into it, it just is not recomposed.
    expect(sibling.matrixWorldAutoUpdate).toBe(false);
  });

  it('keeps a cap marked only by _rvSceneButtonMesh dynamic (runtime placement)', () => {
    const root = named('root');
    const cap = named('Button', true);
    cap.userData._rvSceneButtonMesh = true;           // stamped by _bind()
    root.add(cap);

    freezeStaticMatrices(root);

    expect(cap.matrixWorldAutoUpdate).toBe(true);
  });

  it('freezes a SceneButtonBase-only subtree (not every scene-button key is a mover)', () => {
    const root = named('root');
    const branch = named('branch');
    const base = withComponent(named('Base', true), 'SceneButtonBase');
    root.add(branch); branch.add(base);

    freezeStaticMatrices(root);

    expect(base.matrixWorldAutoUpdate).toBe(false);
  });

  it('freezes a static sibling subtree while a Drive sibling stays dynamic', () => {
    const root = named('root');
    const driveBranch = withComponent(named('drive'), 'Drive');
    const driveMesh = named('driveMesh', true);
    const staticBranch = named('staticBranch');
    const staticMesh = named('staticMesh', true);
    root.add(driveBranch); driveBranch.add(driveMesh);
    root.add(staticBranch); staticBranch.add(staticMesh);

    freezeStaticMatrices(root);

    expect(root.matrixWorldAutoUpdate).toBe(true);          // ancestor of the drive
    expect(driveBranch.matrixWorldAutoUpdate).toBe(true);
    expect(driveMesh.matrixWorldAutoUpdate).toBe(true);
    expect(staticBranch.matrixWorldAutoUpdate).toBe(false); // disconnected static
    expect(staticMesh.matrixWorldAutoUpdate).toBe(false);
  });

  it('keeps a whole PlacementMeta subtree dynamic (baked planner placement)', () => {
    // A baked placement: drive subtree (rolls) plus a static frame sibling.
    // Freezing the frame made only the rolls follow a planner drag (2026-09-01,
    // DemoPlanner) — the placement root marks the ENTIRE subtree as movable.
    const root = named('root');
    const placement = withComponent(named('RollConveyor'), 'PlacementMeta');
    const drive = withComponent(named('drive'), 'Drive');
    const roll = named('roll', true);
    const frame = named('frame');
    const frameMesh = named('frameMesh', true);
    root.add(placement);
    placement.add(drive); drive.add(roll);
    placement.add(frame); frame.add(frameMesh);

    freezeStaticMatrices(root);

    expect(placement.matrixWorldAutoUpdate).toBe(true);
    expect(frame.matrixWorldAutoUpdate).toBe(true);
    expect(frameMesh.matrixWorldAutoUpdate).toBe(true);
  });

  it('leaves world transforms correct after freezing', () => {
    const root = named('root');
    const child = named('child', true);
    child.position.set(1, 2, 3);
    root.add(child);

    freezeStaticMatrices(root);

    // updateMatrixWorld(true) was run up front → world matrix reflects position.
    expect(child.matrixWorld.elements[12]).toBeCloseTo(1);
    expect(child.matrixWorld.elements[13]).toBeCloseTo(2);
    expect(child.matrixWorld.elements[14]).toBeCloseTo(3);
  });
});
