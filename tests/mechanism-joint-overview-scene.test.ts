// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MechanismJointOverviewGizmo scene contract (plan-405 §9.2).
 *
 * Mock-viewer pattern after `drive-axis-gizmo-plugin.test.ts`: a real Scene and
 * real cameras, a stub renderer holding a real canvas, no WebGL. What is worth
 * asserting here is everything that is invisible in a screenshot — the overlay
 * layer, the pool reusing its objects instead of rebuilding them, the NaN guard,
 * the orthographic branch of the scaler, and the render-on-demand gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Scene } from 'three';
import {
  MechanismJointOverviewGizmo, type OverviewTarget,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-joint-overview-gizmo';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';

const CANVAS_H = 600;

interface World {
  gizmo: MechanismJointOverviewGizmo;
  scene: Scene;
  camera: PerspectiveCamera;
  ortho: OrthographicCamera;
  viewer: { camera: PerspectiveCamera | OrthographicCamera; markRenderDirty: Mock<(...a: unknown[]) => void> };
  canvas: HTMLCanvasElement;
  hover: Mock<(target: OverviewTarget | null) => void>;
  dispose: () => void;
}

const worlds: World[] = [];

function createWorld(): World {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1.5, 0.1, 1000);
  camera.position.set(0, 0, 10);
  const ortho = new OrthographicCamera(-5, 5, 4, -4, 0.1, 1000);
  ortho.position.set(0, 0, 10);

  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = CANVAS_H;
  canvas.style.width = '900px';
  canvas.style.height = `${CANVAS_H}px`;
  document.body.appendChild(canvas);

  const viewer = {
    scene,
    camera: camera as PerspectiveCamera | OrthographicCamera,
    renderer: { domElement: canvas },
    markRenderDirty: vi.fn(),
  };
  const hover = vi.fn((t: OverviewTarget | null) => {
    // Wired exactly like the panel does it, so `dispose()` hiding the tooltip is
    // observable on the real store rather than only on a spy.
    if (!t) { tooltipStore.hide('mechanism-joint-overview'); return; }
    tooltipStore.show({
      id: 'mechanism-joint-overview', mode: 'world', priority: 10,
      worldAnchor: [t.origin[0], t.origin[1], t.origin[2]],
      data: { type: 'metadata', nodePath: t.jointPath, content: `<name>${t.name}</name>` },
    });
  });
  const gizmo = new MechanismJointOverviewGizmo(viewer as unknown as RVViewer, hover);
  const world: World = {
    gizmo, scene, camera, ortho, viewer, canvas, hover,
    dispose: () => { gizmo.dispose(); canvas.remove(); },
  };
  worlds.push(world);
  return world;
}

function target(i: number, overrides: Partial<OverviewTarget> = {}): OverviewTarget {
  return {
    jointPath: `/Rig/J${i}`,
    name: `J${i}`,
    jointType: 'Revolute',
    origin: [i, 0, 0],
    direction: [0, 0, 1],
    ...overrides,
  };
}

function targets(n: number): OverviewTarget[] {
  return Array.from({ length: n }, (_, i) => target(i));
}

/** Let the RAF scale loop run a couple of times. */
function frames(count = 3): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => { if (--left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

beforeEach(() => { tooltipStore.hideAll(); });

afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
  tooltipStore.hideAll();
});

describe('MechanismJointOverviewGizmo — scene contract', () => {
  it('creates one group per joint, all on HIGHLIGHT_OVERLAY_LAYER with overlay userData', () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(3));
    expect(w.gizmo.visibleCount).toBe(3);
    expect(w.gizmo.root.children).toHaveLength(3);
    expect(w.scene.children).toContain(w.gizmo.root);

    const expectedMask = 1 << HIGHLIGHT_OVERLAY_LAYER;
    for (const group of w.gizmo.root.children) {
      group.traverse((o) => {
        expect(o.layers.mask).toBe(expectedMask);
        expect(o.userData._highlightOverlay).toBe(true);
      });
    }
  });

  it('positions each glyph at its joint origin', () => {
    const w = createWorld();
    w.gizmo.setTargets([target(0, { origin: [4, -2, 7] })]);
    const group = w.gizmo.root.children[0];
    expect(group.position.toArray()).toEqual([4, -2, 7]);
  });

  it('reuses pool entries across 5 → 2 → 5 instead of destroying them', () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(5));
    const identity = [...w.gizmo.root.children];
    expect(w.gizmo.poolSize).toBe(5);

    w.gizmo.setTargets(targets(2));
    expect(w.gizmo.visibleCount).toBe(2);
    expect(w.gizmo.poolSize).toBe(5);           // pool grows, never shrinks
    expect(w.gizmo.root.children).toHaveLength(5);
    expect(identity[4].visible).toBe(false);     // hidden, not removed

    w.gizmo.setTargets(targets(5));
    expect(w.gizmo.visibleCount).toBe(5);
    // Same objects, in the same slots — no rebuild flicker.
    expect(w.gizmo.root.children).toEqual(identity);
  });

  it('leaves nothing visible when the target set empties (model change)', () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(5));
    w.gizmo.setTargets([]);
    expect(w.gizmo.visibleCount).toBe(0);
    expect(w.gizmo.root.visible).toBe(false);
    for (const group of w.gizmo.root.children) expect(group.visible).toBe(false);
  });

  it('hides exactly the hidden joint, and shows all of them again for null', () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(4), '/Rig/J2');
    expect(w.gizmo.visibleCount).toBe(3);
    expect(w.gizmo.root.children[2].visible).toBe(false);
    expect(w.gizmo.root.children[1].visible).toBe(true);

    w.gizmo.setTargets(targets(4), null);
    expect(w.gizmo.visibleCount).toBe(4);
  });

  it('F8: a near-zero axis leaves only the anchor and produces no NaN', () => {
    const w = createWorld();
    w.gizmo.setTargets([target(0, { direction: [0, 0, 0] }), target(1)]);
    const degenerate = w.gizmo.root.children[0];
    const healthy = w.gizmo.root.children[1];

    expect(degenerate.visible).toBe(true);            // anchor still marks the joint
    expect(degenerate.children[0].visible).toBe(true);  // anchor sphere
    expect(degenerate.children[1].visible).toBe(false); // axis sub-group
    expect(healthy.children[1].visible).toBe(true);

    w.gizmo.root.updateMatrixWorld(true);
    degenerate.traverse((o) => {
      for (const v of o.matrixWorld.elements) expect(Number.isNaN(v)).toBe(false);
    });
  });

  it('F8: a NaN axis takes the same safe branch', () => {
    const w = createWorld();
    w.gizmo.setTargets([target(0, { direction: [NaN, NaN, NaN] })]);
    expect(w.gizmo.root.children[0].children[1].visible).toBe(false);
  });

  it('keeps a constant screen size under a PERSPECTIVE camera', async () => {
    const w = createWorld();
    w.gizmo.setTargets([target(0, { origin: [0, 0, 0] })]);
    await frames();
    const near = w.gizmo.root.children[0].scale.x;

    w.camera.position.set(0, 0, 20);
    await frames();
    const far = w.gizmo.root.children[0].scale.x;

    // Twice the distance ⇒ twice the world size for the same pixel count.
    expect(far / near).toBeCloseTo(2, 2);
  });

  it('keeps a constant screen size under an ORTHOGRAPHIC camera (zoom, not distance)', async () => {
    const w = createWorld();
    w.viewer.camera = w.ortho;
    w.gizmo.setTargets([target(0, { origin: [0, 0, 0] })]);
    await frames();
    const atZoom1 = w.gizmo.root.children[0].scale.x;
    expect(atZoom1).toBeGreaterThan(0);

    // The distance formula would not move at all here — the ortho branch must.
    w.ortho.position.set(0, 0, 40);
    await frames();
    expect(w.gizmo.root.children[0].scale.x).toBeCloseTo(atZoom1, 6);

    w.ortho.zoom = 2;
    w.ortho.updateProjectionMatrix();
    await frames();
    expect(w.gizmo.root.children[0].scale.x).toBeCloseTo(atZoom1 / 2, 6);
  });

  it('change-gates markRenderDirty: an identical refresh renders nothing', () => {
    const w = createWorld();
    const set = targets(3);
    w.gizmo.setTargets(set);
    expect(w.viewer.markRenderDirty).toHaveBeenCalled();

    w.viewer.markRenderDirty.mockClear();
    w.gizmo.setTargets(set);                 // same array
    w.gizmo.setTargets(targets(3));          // equal values, fresh objects
    expect(w.viewer.markRenderDirty).not.toHaveBeenCalled();

    w.gizmo.setTargets([target(0, { origin: [9, 9, 9] }), target(1), target(2)]);
    expect(w.viewer.markRenderDirty).toHaveBeenCalled();
  });

  it('change-gates the hidden joint too', () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(3), '/Rig/J1');
    w.viewer.markRenderDirty.mockClear();
    w.gizmo.setTargets(targets(3), '/Rig/J1');
    expect(w.viewer.markRenderDirty).not.toHaveBeenCalled();

    w.gizmo.setTargets(targets(3), '/Rig/J2');
    expect(w.viewer.markRenderDirty).toHaveBeenCalled();
  });

  it('dispose removes everything from the scene, stops the loop and hides the tooltip', async () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(2));
    await frames();

    // Simulate the panel having a hover tooltip up when the section closes.
    w.hover(target(0));
    expect(tooltipStore.getSnapshot().visible.length).toBeGreaterThan(0);

    w.gizmo.dispose();
    expect(w.scene.children).not.toContain(w.gizmo.root);
    expect(tooltipStore.getSnapshot().visible).toHaveLength(0);

    w.viewer.markRenderDirty.mockClear();
    await frames(4);
    expect(w.viewer.markRenderDirty).not.toHaveBeenCalled(); // RAF really cancelled
  });

  it('dispose is idempotent (StrictMode double-unmount)', () => {
    const w = createWorld();
    w.gizmo.setTargets(targets(2));
    expect(() => { w.gizmo.dispose(); w.gizmo.dispose(); }).not.toThrow();
    expect(w.scene.children).not.toContain(w.gizmo.root);
  });

  it('ignores setTargets after dispose', () => {
    const w = createWorld();
    w.gizmo.dispose();
    expect(() => w.gizmo.setTargets(targets(3))).not.toThrow();
    expect(w.gizmo.visibleCount).toBe(0);
  });
});
