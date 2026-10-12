// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, MeshToonMaterial, Object3D } from 'three';
import { RVWireframeView } from '../src/core/rv-wireframe-view';

const noFixture = (): boolean => false;

function mesh(name: string, parent: Object3D, material = new MeshStandardMaterial()): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material);
  m.name = name;
  parent.add(m);
  return m;
}

describe('RVWireframeView', () => {
  it('puts the line material on document meshes for the frame and restores the originals', () => {
    const root = new Group();
    const a = mesh('a', root);
    const multi = new Mesh(new BoxGeometry(1, 1, 1), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    root.add(multi);
    const origA = a.material;
    const origMulti = multi.material;

    const view = new RVWireframeView();
    view.swapIn(root, noFixture);
    expect(a.material).toBe(view.material);
    expect(multi.material).toBe(view.material);
    expect(view.material.wireframe).toBe(true);

    view.swapOut();
    expect(a.material).toBe(origA);
    expect(multi.material).toBe(origMulti);
    expect(view.swappedCount).toBe(0);
  });

  it('leaves hidden subtrees, overlay-layer meshes, fixtures and ghosts alone', () => {
    const root = new Group();
    const hiddenParent = new Group();
    hiddenParent.visible = false;
    root.add(hiddenParent);
    const hidden = mesh('hidden', hiddenParent);
    const overlay = mesh('overlay', root);
    overlay.layers.set(3);
    const fixture = mesh('fixture', root);
    const ghost = mesh('ghost', root);
    ghost.userData._isGhostOverlay = true;
    const plain = mesh('plain', root);

    const view = new RVWireframeView();
    view.swapIn(root, (n) => n === fixture);
    expect(plain.material).toBe(view.material);
    for (const m of [hidden, overlay, fixture, ghost]) expect(m.material).not.toBe(view.material);
    expect(view.swappedCount).toBe(1);
    view.swapOut();
  });

  it('never leaks into state that changes between frames: assign, toon on, toon off', () => {
    const root = new Group();
    const a = mesh('a', root);
    const view = new RVWireframeView();

    // A material assigned between two frames is what the next restore returns.
    view.swapIn(root, noFixture); view.swapOut();
    const assigned = new MeshStandardMaterial({ color: 0xff0000 });
    a.material = assigned;
    view.swapIn(root, noFixture); view.swapOut();
    expect(a.material).toBe(assigned);

    // Toon swaps the mesh material underneath; either order ends on the original.
    const toon = new MeshToonMaterial();
    a.material = toon;                       // toon on while wireframe is on
    view.swapIn(root, noFixture); view.swapOut();
    expect(a.material).toBe(toon);
    a.material = assigned;                   // toon off while wireframe is on
    view.swapIn(root, noFixture); view.swapOut();
    expect(a.material).toBe(assigned);
  });

  it('ignores a second swapIn without swapOut instead of recording the line material as original', () => {
    const root = new Group();
    const a = mesh('a', root);
    const orig = a.material;
    const view = new RVWireframeView();
    view.swapIn(root, noFixture);
    view.swapIn(root, noFixture);
    view.swapOut();
    expect(a.material).toBe(orig);
  });
});
