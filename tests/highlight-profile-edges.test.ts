// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 F6 — `HighlightProfile.edges`.
 *
 * A profile with `edges: false` (the editor) builds fill-only overlay pairs:
 * no `LineSegments`, no `EdgesGeometry`, on every channel — hover, selection,
 * the per-call selection styles that carry `showEdges: true` (kinematic /
 * group preview), coloured aux sets and flashes. Every other profile keeps
 * its edges (default `true`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import {
  EDITOR_GROUP_SELECTION_STYLE,
  EDITOR_KINEMATIC_SELECTION_STYLE,
  MODE_HIGHLIGHT_PROFILES,
} from '../src/core/engine/rv-highlight-profiles';

function makeRoot(): Object3D {
  const root = new Object3D();
  root.name = 'Root';
  for (let i = 0; i < 3; i++) {
    const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    m.name = `Part${i}`;
    m.position.x = i * 2;
    root.add(m);
  }
  root.updateMatrixWorld(true);
  return root;
}

interface OverlayCensus { fills: number; lines: number }

/** Overlay objects the manager added (fill meshes vs. any line object). */
function census(scene: Scene): OverlayCensus {
  const c: OverlayCensus = { fills: 0, lines: 0 };
  scene.traverse((o) => {
    if (!o.userData?._highlightOverlay || !o.parent) return;
    const flags = o as unknown as { isLine?: boolean; isLineSegments?: boolean; isMesh?: boolean };
    if (flags.isLine || flags.isLineSegments) c.lines++;
    else if (flags.isMesh) c.fills++;
  });
  return c;
}

let hl: RVHighlightManager | null = null;
afterEach(() => { hl?.dispose(); hl = null; });

function setup(mode: 'editor' | 'hmi') {
  const scene = new Scene();
  const root = makeRoot();
  scene.add(root);
  hl = new RVHighlightManager(scene);
  hl.setProfile(MODE_HIGHLIGHT_PROFILES[mode]);
  return { scene, root, hl };
}

describe('HighlightProfile.edges = false (editor)', () => {
  it('hover overlay is fill-only', () => {
    const { scene, root, hl } = setup('editor');
    hl.highlight(root);
    const c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBe(0);
  });

  it('selection overlay is fill-only', () => {
    const { scene, root, hl } = setup('editor');
    hl.highlightSelection([root]);
    const c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBe(0);
  });

  it('per-call styles with showEdges=true are overridden by the profile flag', () => {
    expect(EDITOR_KINEMATIC_SELECTION_STYLE.showEdges).toBe(true);
    const { scene, root, hl } = setup('editor');
    hl.highlightSelection([root], { style: EDITOR_KINEMATIC_SELECTION_STYLE, visual: 'overlay' });
    let c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBe(0);

    hl.highlightSelection([root], { style: EDITOR_GROUP_SELECTION_STYLE, visual: 'overlay' });
    c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBe(0);
  });

  it('coloured aux sets and flashes are fill-only', () => {
    const { scene, root, hl } = setup('editor');
    hl.setAuxEmphasis('err', [root], { color: 0xff0000 });
    hl.flash([root], { color: 0x00ff00, durationMs: 10_000 });
    hl.update();
    const c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBe(0);
  });
});

describe('HighlightProfile.edges default (HMI)', () => {
  it('HMI hover and selection still carry crease edges', () => {
    const { scene, root, hl } = setup('hmi');
    expect(MODE_HIGHLIGHT_PROFILES.hmi.edges).toBeUndefined();
    hl.highlight(root);
    hl.highlightSelection([root]);
    const c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBeGreaterThan(0);
  });

  it('switching HMI → editor drops the edges on the next highlight', () => {
    const { scene, root, hl } = setup('hmi');
    hl.highlightSelection([root]);
    expect(census(scene).lines).toBeGreaterThan(0);
    hl.setProfile(MODE_HIGHLIGHT_PROFILES.editor);
    hl.highlightSelection([root]);
    const c = census(scene);
    expect(c.fills).toBeGreaterThan(0);
    expect(c.lines).toBe(0);
  });
});
