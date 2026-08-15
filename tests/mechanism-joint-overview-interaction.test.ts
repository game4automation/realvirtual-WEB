// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MechanismJointOverviewGizmo pointer behaviour (plan-405 §9.4).
 *
 * ── Why synthetic pointer events are acceptable HERE ────────────────────────
 * plan-404 deliberately kept synthetic mouse gestures out of the mechanism E2E
 * suite, because those raycasts go through the scene BVH and race its readiness.
 * None of that applies to this class: it owns a private raycaster that only ever
 * meets its own four meshes per joint, with no GLB and no BVH in the picture.
 * Both halves of the setup are established practice in this repo — a raycaster
 * against synthetic meshes (`rv-raycast-manager.test.ts`) and synthetic
 * PointerEvents against capture-phase window listeners
 * (`shiftless-chip-drag.test.tsx`); only their combination is new.
 *
 * What is pinned here is the part that can quietly break other tools: the claim.
 * Claiming too eagerly steals the click that arms an anchor pick or engages the
 * per-row axis gizmo; claiming too little re-selects the geometry behind the
 * glyph on every joint click.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import {
  MechanismJointOverviewGizmo, type OverviewTarget,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-joint-overview-gizmo';
import type { RVViewer } from '../src/core/rv-viewer';

const CANVAS_W = 400;
const CANVAS_H = 300;
/** Dead centre of the canvas — the ray through the joint origin (the anchor). */
const CENTRE_X = CANVAS_W / 2;
const CENTRE_Y = CANVAS_H / 2;
/** ~30 px up the +Y axis glyph — on the shaft's invisible pick proxy. */
const ON_AXIS_Y = CENTRE_Y - 30;
/** Far corner — nothing of ours is anywhere near it. */
const MISS_X = CANVAS_W - 10;
const MISS_Y = CANVAS_H - 10;

interface World {
  gizmo: MechanismJointOverviewGizmo;
  hover: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  /** Fires only when the gizmo did NOT claim the event. */
  downstream: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

const worlds: World[] = [];

function createWorld(): World {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, CANVAS_W / CANVAS_H, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  // Fixed at the viewport origin so getBoundingClientRect is deterministic.
  canvas.style.cssText =
    `position:fixed;left:0;top:0;width:${CANVAS_W}px;height:${CANVAS_H}px`;
  document.body.appendChild(canvas);

  const viewer = { scene, camera, renderer: { domElement: canvas }, markRenderDirty: vi.fn() };
  const hover = vi.fn();
  const select = vi.fn();
  const gizmo = new MechanismJointOverviewGizmo(viewer as unknown as RVViewer, hover, select);

  // Registered AFTER the gizmo, so `stopImmediatePropagation` in its handler is
  // exactly what keeps this one silent — the observable form of a claim.
  const downstream = vi.fn();
  window.addEventListener('pointerdown', downstream, true);

  const world: World = {
    gizmo, hover, select, downstream,
    dispose: () => {
      gizmo.dispose();
      window.removeEventListener('pointerdown', downstream, true);
      canvas.remove();
    },
  };
  worlds.push(world);
  return world;
}

function target(overrides: Partial<OverviewTarget> = {}): OverviewTarget {
  return {
    jointPath: '/Rig/Joint1',
    name: 'Achse_Z',
    jointType: 'Revolute',
    origin: [0, 0, 0],
    direction: [0, 1, 0],
    ...overrides,
  };
}

function pointer(type: 'pointerdown' | 'pointermove', x: number, y: number): void {
  window.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true,
  }));
}

/** Let the RAF loop apply the screen-space scale, so the glyph has real size. */
function frames(count = 3): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => { if (--left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

async function armed(targets: OverviewTarget[] = [target()]): Promise<World> {
  const w = createWorld();
  w.gizmo.setTargets(targets);
  await frames();
  return w;
}

afterEach(() => { while (worlds.length) worlds.pop()!.dispose(); });

describe('MechanismJointOverviewGizmo — click', () => {
  it('selects the joint and CLAIMS the event on a hit', async () => {
    const w = await armed();
    pointer('pointerdown', CENTRE_X, CENTRE_Y);
    expect(w.select).toHaveBeenCalledTimes(1);
    expect(w.select.mock.calls[0][0].jointPath).toBe('/Rig/Joint1');
    expect(w.downstream).not.toHaveBeenCalled();
  });

  it('hits the axis through its fat pick proxy, not just the anchor', async () => {
    const w = await armed();
    pointer('pointerdown', CENTRE_X, ON_AXIS_Y);
    expect(w.select).toHaveBeenCalledTimes(1);
  });

  it('does NOT claim a miss — the click reaches the rest of the app', async () => {
    const w = await armed();
    pointer('pointerdown', MISS_X, MISS_Y);
    expect(w.select).not.toHaveBeenCalled();
    expect(w.downstream).toHaveBeenCalledTimes(1);
  });

  it('does not claim a click on the joint that is hidden as "being edited"', async () => {
    const w = createWorld();
    w.gizmo.setTargets([target()], '/Rig/Joint1');
    await frames();
    pointer('pointerdown', CENTRE_X, CENTRE_Y);
    expect(w.select).not.toHaveBeenCalled();
    expect(w.downstream).toHaveBeenCalledTimes(1);
  });

  it('F8: a degenerate joint is still selectable by its anchor but has no axis to hit', async () => {
    const w = await armed([target({ direction: [0, 0, 0] })]);
    pointer('pointerdown', CENTRE_X, ON_AXIS_Y);
    expect(w.select).not.toHaveBeenCalled();   // hidden axis is not pickable
    expect(w.downstream).toHaveBeenCalledTimes(1);

    pointer('pointerdown', CENTRE_X, CENTRE_Y);
    expect(w.select).toHaveBeenCalledTimes(1); // the anchor still marks it
  });

  it('ignores non-primary buttons', async () => {
    const w = await armed();
    window.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: CENTRE_X, clientY: CENTRE_Y, button: 2, bubbles: true, cancelable: true,
    }));
    expect(w.select).not.toHaveBeenCalled();
  });
});

describe('MechanismJointOverviewGizmo — hover', () => {
  it('reports enter and leave exactly once each', async () => {
    const w = await armed();
    pointer('pointermove', CENTRE_X, CENTRE_Y);
    expect(w.hover).toHaveBeenCalledTimes(1);
    expect(w.hover.mock.calls[0][0].name).toBe('Achse_Z');

    pointer('pointermove', CENTRE_X, CENTRE_Y + 2);
    expect(w.hover).toHaveBeenCalledTimes(1);   // still the same joint — no churn

    pointer('pointermove', MISS_X, MISS_Y);
    expect(w.hover).toHaveBeenCalledTimes(2);
    expect(w.hover.mock.calls[1][0]).toBeNull();
  });

  it('does not report a hover for a pointer outside the canvas', async () => {
    const w = await armed();
    pointer('pointermove', CANVAS_W + 200, CENTRE_Y);
    expect(w.hover).not.toHaveBeenCalled();
  });
});

describe('MechanismJointOverviewGizmo — suppression (F5)', () => {
  it('neither claims nor hovers while suppressed, and recovers afterwards', async () => {
    const w = await armed();
    w.gizmo.setSuppressed(true);

    pointer('pointermove', CENTRE_X, CENTRE_Y);
    expect(w.hover).not.toHaveBeenCalled();

    pointer('pointerdown', CENTRE_X, CENTRE_Y);
    expect(w.select).not.toHaveBeenCalled();
    expect(w.downstream).toHaveBeenCalledTimes(1);   // the other tool gets its click

    w.gizmo.setSuppressed(false);
    pointer('pointermove', CENTRE_X, CENTRE_Y);
    pointer('pointerdown', CENTRE_X, CENTRE_Y);
    expect(w.hover).toHaveBeenCalledTimes(1);
    expect(w.select).toHaveBeenCalledTimes(1);
  });

  it('drops an active hover the moment suppression starts', async () => {
    const w = await armed();
    pointer('pointermove', CENTRE_X, CENTRE_Y);
    w.hover.mockClear();

    w.gizmo.setSuppressed(true);
    expect(w.hover).toHaveBeenCalledWith(null);
  });

  it('is inert after dispose', async () => {
    const w = await armed();
    w.gizmo.dispose();
    w.hover.mockClear();
    pointer('pointermove', CENTRE_X, CENTRE_Y);
    pointer('pointerdown', CENTRE_X, CENTRE_Y);
    expect(w.hover).not.toHaveBeenCalled();
    expect(w.select).not.toHaveBeenCalled();
    expect(w.downstream).toHaveBeenCalledTimes(1);
  });
});
