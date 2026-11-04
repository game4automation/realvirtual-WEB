// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-740 T2 (§9.2) — riding the agent's camera body.
 *
 * The attach is deliberately NOT a second tracking loop: it is the existing
 * `CameraManager` follow mode with a new {@link AgentEyeFollowSource}. So this
 * file runs the REAL CameraManager (from `camera-test-harness`, no WebGL) under
 * a stub viewer, and checks the three things that can only go wrong at the seam:
 *
 *   - the three auto-detach paths (user drag, programmatic flight, FPV/XR),
 *   - that the drag path coexists with the two `'start'` listeners that were
 *     already there (D-A6 / review A3), and that detaching fires no controls
 *     event of its own, so listener ORDER cannot matter,
 *   - that the `animateCameraTo` guard is not re-entrant — `stopFollowMode`
 *     restores by calling `animateCameraTo` again (R2-I-N1).
 *
 * Plus the ownership guards on `attach()` (the refusal that plan-740 moved OFF
 * the movement tools and onto this one) and the cone's exclusion from picking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Mesh, Scene, Vector3 } from 'three';
import { makeTestCameraManager, type TestCameraManager, type FakeOrbitControls } from './helpers/camera-test-harness';
import { AgentEyePlugin, AGENT_EYE_GIZMO_TIMEOUT_MS } from '../src/plugins/agent-eye-plugin';
import { recordAgentEyeEnvelope, resetAgentEyeMonitorForTest } from '../src/core/hmi/agent-eye-monitor-store';
import { AgentEyeFollowSource } from '../src/core/engine/rv-agent-eye-follow-source';
import { AgentEyeGizmo } from '../src/core/engine/rv-agent-eye-gizmo';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import type { RVViewer } from '../src/core/rv-viewer';

interface Harness {
  plugin: AgentEyePlugin;
  viewer: RVViewer;
  cm: TestCameraManager;
  controls: FakeOrbitControls;
  canvas: HTMLCanvasElement;
  scene: Scene;
  events: Map<string, Array<() => void>>;
  emit(name: string): void;
  state: { fpvActive: boolean; xrPresenting: boolean };
}

function makeHarness(): Harness {
  const cm = makeTestCameraManager();
  const controls = cm.controls;
  const scene = new Scene();
  const canvas = document.createElement('canvas');
  // jsdom/browser: clientWidth is 0 for a detached canvas, so give the gizmo a
  // frame to project into.
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(canvas);

  const events = new Map<string, Array<() => void>>();
  const state = { fpvActive: false, xrPresenting: false };

  const viewer = {
    scene,
    controls,
    get camera() { return cm.camera; },
    renderer: { domElement: canvas, get xr() { return { isPresenting: state.xrPresenting }; } },
    currentModelUrl: '/models/Harness.glb',
    get cameraFollowMode() { return cm.followMode; },
    get cameraFollowSource() { return cm.followSource; },
    startCameraFollow: (src: never, owner?: never) => cm.startFollow(src, owner),
    stopCameraFollow: (restore?: boolean) => cm.stopFollowMode(restore),
    getCameraState: () => ({ position: new Vector3(3, 2, 5), target: new Vector3(0, 0, 0) }),
    fov: 50,
    projection: 'perspective',
    markRenderDirty: () => {},
    getPlugin: (id: string) => (id === 'fpv' ? { id: 'fpv', isActive: state.fpvActive } : undefined),
    on: (name: string, fn: () => void) => {
      const list = events.get(name) ?? [];
      list.push(fn);
      events.set(name, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
  } as unknown as RVViewer;

  const plugin = new AgentEyePlugin();
  plugin.init(viewer);
  return {
    plugin, viewer, cm, controls, canvas, scene, events, state,
    emit: (name) => { for (const fn of [...(events.get(name) ?? [])]) fn(); },
  };
}

/** Dispatch a dblclick at a canvas-relative position, reporting whether it was stopped. */
function dblclickAt(canvas: HTMLCanvasElement, x: number, y: number): { stopped: boolean } {
  let reached = false;
  const tail = (): void => { reached = true; };
  // A bubble-phase listener stands in for the viewer's own focus handler: the
  // plugin listens in CAPTURE, so stopImmediatePropagation there must keep this
  // one from running.
  canvas.addEventListener('dblclick', tail);
  canvas.dispatchEvent(new MouseEvent('dblclick', {
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
  canvas.removeEventListener('dblclick', tail);
  return { stopped: !reached };
}

/** Screen-centre of the cone, so a test can double-click ON it. */
function coneCentre(h: Harness): { x: number; y: number } {
  const gizmo = h.plugin.gizmo!;
  const box = gizmo.screenRect(h.viewer.camera, h.canvas);
  expect(box, 'the cone must project into the canvas for this test').not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

describe('AgentEye attach', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('attaches through the existing follow machinery and hides the cone', () => {
    const h = makeHarness();
    h.plugin.eye!.ensure();
    expect(h.plugin.gizmo!.visible).toBe(true);

    expect(h.plugin.attach()).toEqual({ attached: true });
    expect(h.cm.followMode).toBe('follow');
    expect((h.cm as unknown as { _source: unknown })._source).toBeInstanceOf(AgentEyeFollowSource);
    expect(h.plugin.attached).toBe(true);
    // You are inside the cone while riding it — drawing it would be noise.
    expect(h.plugin.gizmo!.visible).toBe(false);

    h.plugin.detach();
    expect(h.cm.followMode).toBe('off');
    expect(h.plugin.gizmo!.visible).toBe(true);
  });

  it('converges the viewport on the agent target and keeps tracking a moving body', () => {
    const h = makeHarness();
    const eye = h.plugin.eye!;
    eye.ensure();
    eye.setPose({ px: 10, py: 4, pz: 10, tx: 6, ty: 0, tz: 6 });
    h.plugin.attach();

    for (let i = 0; i < 60; i++) h.cm.tickFollow(1 / 60);
    expect(h.controls.target.distanceTo(new Vector3(6, 0, 6))).toBeLessThan(0.001);

    // The agent walks on; the viewport must chase, monotonically.
    eye.setPose({ tx: 20, ty: 0, tz: 6 });
    let prev = h.controls.target.distanceTo(new Vector3(20, 0, 6));
    for (let i = 0; i < 20; i++) {
      h.cm.tickFollow(1 / 60);
      const now = h.controls.target.distanceTo(new Vector3(20, 0, 6));
      expect(now).toBeLessThan(prev);
      prev = now;
    }
  });

  it('detaches on the user\'s first drag, alongside the other start listeners', () => {
    const h = makeHarness();
    h.plugin.eye!.ensure();

    // Stand-ins for rv-viewer.ts (`_isOrbiting`) and GenericTooltipController,
    // registered BEFORE the plugin would be in production and after it here —
    // either way all three must run.
    const other = { orbiting: false, tooltipClosed: false };
    h.controls.addEventListener('start', () => { other.orbiting = true; });
    h.controls.addEventListener('start', () => { other.tooltipClosed = true; });

    h.plugin.attach();
    expect(h.cm.followMode).toBe('follow');

    h.controls.dispatchEvent({ type: 'start' });
    expect(h.cm.followMode).toBe('off');
    expect(h.plugin.attached).toBe(false);
    expect(h.plugin.gizmo!.visible).toBe(true);
    expect(other.orbiting).toBe(true);        // the foreign listeners still ran
    expect(other.tooltipClosed).toBe(true);
  });

  it('detaching fires no controls event, so listener order cannot matter', () => {
    const h = makeHarness();
    h.plugin.eye!.ensure();
    const spy = vi.fn();
    for (const t of ['start', 'change', 'end']) h.controls.addEventListener(t, spy);

    h.plugin.attach();
    h.plugin.detach();
    expect(spy).not.toHaveBeenCalled();
  });

  it('any programmatic camera flight detaches first, and the guard is not re-entrant', () => {
    const h = makeHarness();
    h.plugin.eye!.ensure();
    h.plugin.attach();

    // stopFollowMode(false) is the no-restore path, so a bookmark flight must
    // produce exactly ONE animateCameraTo — its own.
    const spy = vi.spyOn(h.cm as unknown as { animateCameraTo: (...a: never[]) => void }, 'animateCameraTo');
    (h.cm as unknown as { animateCameraTo: (p: Vector3, t: Vector3) => void })
      .animateCameraTo(new Vector3(1, 1, 1), new Vector3(0, 0, 0));
    expect(h.cm.followMode).toBe('off');
    expect(h.plugin.attached).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    // Without an attach the guard is inert.
    spy.mockClear();
    (h.cm as unknown as { animateCameraTo: (p: Vector3, t: Vector3) => void })
      .animateCameraTo(new Vector3(2, 2, 2), new Vector3(0, 0, 0));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('catches up when the follow is stopped by someone else entirely', () => {
    // The seam the animateCameraTo guard rides on: whoever ends the mode —
    // CameraFollowPlugin's Escape, the CameraBar toggle, the guard itself — the
    // source is told, so `attached` and the cone cannot go stale.
    const h = makeHarness();
    h.plugin.eye!.ensure();
    h.plugin.attach();

    h.cm.stopFollowMode(false);
    expect(h.plugin.attached).toBe(false);
    expect(h.plugin.gizmo!.visible).toBe(true);
  });

  it('detaches when FPV or an XR session takes the camera', () => {
    const fpv = makeHarness();
    fpv.plugin.eye!.ensure();
    fpv.plugin.attach();
    fpv.emit('fpv-enter');
    expect(fpv.plugin.attached).toBe(false);
    expect(fpv.cm.followMode).toBe('off');

    const xr = makeHarness();
    xr.plugin.eye!.ensure();
    xr.plugin.attach();
    xr.emit('xr-session-start');
    expect(xr.plugin.attached).toBe(false);
  });

  it('refuses to attach while something else owns the camera', () => {
    const fpv = makeHarness();
    fpv.state.fpvActive = true;
    expect(fpv.plugin.attach()).toEqual({ attached: false, refused: 'fpv' });
    expect(fpv.cm.followMode).toBe('off');

    const follow = makeHarness();
    follow.cm.startFollow({
      label: 'other', getWorldPosition: () => {}, getWorldQuaternion: () => {},
      getBounds: () => {}, isAlive: () => true,
    } as never);
    expect(follow.plugin.attach()).toEqual({ attached: false, refused: 'follow' });

    const xr = makeHarness();
    xr.state.xrPresenting = true;
    expect(xr.plugin.attach()).toEqual({ attached: false, refused: 'xr' });

    // Cone hidden by the Settings toggle: no affordance, no attach.
    const hidden = makeHarness();
    hidden.plugin.setShowAgentEye(false);
    expect(hidden.plugin.attach()).toEqual({ attached: false, refused: 'hidden' });
  });

  it('refuses to attach without OrbitControls — nothing could ever detach again', () => {
    const h = makeHarness();
    (h.viewer as unknown as { controls: unknown }).controls = undefined;
    expect(h.plugin.attach()).toEqual({ attached: false, refused: 'no-controls' });
  });

  it('double-click on the cone attaches and stops the event; elsewhere it detaches and lets it run', () => {
    const h = makeHarness();
    const eye = h.plugin.eye!;
    eye.ensure();
    // Put the body squarely in front of the viewport camera (which looks down
    // -Z from the origin) so the cone projects into the middle of the canvas.
    eye.setPose({ px: 0, py: 0, pz: -5, tx: 0, ty: 0, tz: -8 });

    const c = coneCentre(h);
    expect(dblclickAt(h.canvas, c.x, c.y).stopped).toBe(true);
    expect(h.plugin.attached).toBe(true);

    // Away from the cone while attached: detach, but the focus handler behind
    // us must still get its event.
    expect(dblclickAt(h.canvas, 790, 590).stopped).toBe(false);
    expect(h.plugin.attached).toBe(false);

    // And a miss while detached changes nothing at all.
    expect(dblclickAt(h.canvas, 790, 590).stopped).toBe(false);
    expect(h.plugin.attached).toBe(false);
  });

  it('does not attach on double-click while the cone is hidden', () => {
    const h = makeHarness();
    h.plugin.eye!.ensure();
    h.plugin.eye!.setPose({ px: 0, py: 0, pz: -5, tx: 0, ty: 0, tz: -8 });
    const c = coneCentre(h);
    h.plugin.setShowAgentEye(false);
    expect(dblclickAt(h.canvas, c.x, c.y).stopped).toBe(false);
    expect(h.plugin.attached).toBe(false);
  });

  it('drops the body on a model change and releases everything on dispose', () => {
    const h = makeHarness();
    h.plugin.eye!.ensure();
    h.plugin.attach();

    h.plugin.onModelCleared(h.viewer);
    expect(h.plugin.attached).toBe(false);
    expect(h.plugin.eye!.exists).toBe(false);
    expect(h.cm.followMode).toBe('off');

    const startListeners = h.controls.listenerCount('start');
    h.plugin.dispose();
    expect(h.controls.listenerCount('start')).toBe(startListeners - 1);
    expect(h.scene.children.some((o) => o.name === 'AgentEyeGizmo')).toBe(false);
  });

  it('keeps the cone out of picking: layer + exclude flag on every child', () => {
    const gizmo = new AgentEyeGizmo();
    let children = 0;
    gizmo.group.traverse((o) => {
      children++;
      // Layer 5 alone hides it from the agent's own renders; the userData flag
      // is what keeps `RaycastManager` (which enables ALL layers) off it.
      expect(o.layers.mask, `${o.type} must sit on the agent-eye layer only`).toBe(1 << 5);
      expect(o.userData._agentEyeOverlay).toBe(true);
    });
    expect(children).toBeGreaterThan(1);

    // The shipped filter list, not a re-implementation of it: `_isExcluded`
    // walks exactly the predicates the RaycastManager constructor installs.
    const rm = makeStubRaycastManager();
    const excluded = (rm as unknown as { _isExcluded: (o: object) => boolean })._isExcluded.bind(rm);
    expect(excluded(gizmo.group.children[0])).toBe(true);
    expect(excluded(new Mesh())).toBe(false);
    gizmo.dispose();
  });
});

/**
 * A RaycastManager built on stubs, purely to read back its default exclude
 * filters. It never raycasts here — the point is to assert against the REAL
 * constructor list rather than a copy of it in the test.
 */
function makeStubRaycastManager(): object {
  const el = document.createElement('canvas');
  return new RaycastManager(
    { domElement: el } as never,
    () => ({}) as never,
    new Scene() as never,
    {} as never,
    {} as never,
    { emit: () => {} } as never,
  );
}


describe('AgentEye gizmo timeout', () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    resetAgentEyeMonitorForTest();
    h = makeHarness();
  });
  afterEach(() => {
    h.plugin.dispose();
    h.canvas.remove();
    resetAgentEyeMonitorForTest();
    vi.useRealTimers();
  });

  function capture(): void {
    recordAgentEyeEnvelope(JSON.stringify({
      __rvImage: { data: 'AAAA', mimeType: 'image/jpeg', width: 16, height: 12 },
    }), 'web_eye');
    vi.advanceTimersByTime(0);
  }

  it('hides after five seconds and redraws the idle viewport', () => {
    expect(h.plugin.gizmo!.visible).toBe(false);
    h.plugin.eye!.ensure();
    capture();
    expect(h.plugin.gizmo!.visible).toBe(true);
    vi.advanceTimersByTime(AGENT_EYE_GIZMO_TIMEOUT_MS - 1);
    expect(h.plugin.gizmo!.visible).toBe(true);
    const dirty = vi.spyOn(h.viewer, 'markRenderDirty');
    vi.advanceTimersByTime(1);
    expect(h.plugin.gizmo!.visible).toBe(false);
    expect(dirty).toHaveBeenCalled();
    expect(h.plugin.gizmo!.screenRect(h.viewer.camera, h.canvas)).toBeNull();
    expect(h.plugin.showAgentEye).toBe(true);
  });

  it('restarts the timeout for captures at the same pose and shows the next capture', () => {
    h.plugin.eye!.ensure();
    capture();
    vi.advanceTimersByTime(4000);
    capture();
    vi.advanceTimersByTime(4000);
    expect(h.plugin.gizmo!.visible).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(h.plugin.gizmo!.visible).toBe(false);
    capture();
    expect(h.plugin.gizmo!.visible).toBe(true);
    vi.advanceTimersByTime(AGENT_EYE_GIZMO_TIMEOUT_MS);
    h.plugin.eye!.setPose({ px: 7 });
    expect(h.plugin.gizmo!.visible).toBe(true);
  });

  it('respects the visibility setting and clears its timer on model clear and disposal', () => {
    h.plugin.eye!.ensure();
    h.plugin.setShowAgentEye(false);
    capture();
    expect(h.plugin.gizmo!.visible).toBe(false);
    h.plugin.setShowAgentEye(true);
    expect(h.plugin.gizmo!.visible).toBe(true);
    h.plugin.onModelCleared(h.viewer);
    expect(h.plugin.gizmo!.visible).toBe(false);
    capture();
    expect(h.plugin.gizmo!.visible).toBe(false);
    h.plugin.eye!.ensure();
    h.plugin.dispose();
    const dirty = vi.spyOn(h.viewer, 'markRenderDirty');
    vi.advanceTimersByTime(AGENT_EYE_GIZMO_TIMEOUT_MS);
    capture();
    expect(dirty).not.toHaveBeenCalled();
  });
});
