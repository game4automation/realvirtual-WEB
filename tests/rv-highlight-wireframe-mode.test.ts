// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene } from 'three';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';

function setup() {
  const scene = new Scene();
  const root = new Group();
  const part = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  part.name = 'part';
  root.add(part);
  scene.add(root);
  const h = new RVHighlightManager(scene);
  const overlays = () => scene.children.filter((c) => c.userData._highlightOverlay);
  return { root, h, overlays };
}

describe('RVHighlightManager wireframe mode', () => {
  it('solid mode: fill overlay plus an edge line mesh', () => {
    const { root, h, overlays } = setup();
    h.highlight(root);
    const objs = overlays();
    expect(objs.some((o) => (o as LineSegments).isLineSegments)).toBe(true);
    const fill = objs.find((o) => (o as Mesh).isMesh) as Mesh;
    expect((fill.material as MeshBasicMaterial).wireframe).toBe(false);
  });

  it('wireframe mode: hover and selection are the wires themselves, no edge mesh', () => {
    const { root, h, overlays } = setup();
    h.setWireframeMode(true);

    h.highlight(root);
    let objs = overlays();
    expect(objs.length).toBe(1);
    expect((objs[0] as LineSegments).isLineSegments).toBeFalsy();
    const hoverMat = (objs[0] as Mesh).material as MeshBasicMaterial;
    expect(hoverMat.wireframe).toBe(true);
    expect(hoverMat.color.getHex()).toBe(h.getHoverStyle().edgeColor);

    h.clear();
    h.highlightSelection([root]);
    objs = overlays();
    expect(objs.length).toBe(1);
    expect(((objs[0] as Mesh).material as MeshBasicMaterial).wireframe).toBe(true);
  });

  it('switching back restores fill + edges', () => {
    const { root, h, overlays } = setup();
    h.setWireframeMode(true);
    h.setWireframeMode(false);
    h.highlight(root);
    expect(overlays().some((o) => (o as LineSegments).isLineSegments)).toBe(true);
  });
});
