// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 §9.2 — SceneScale: bounds + invalidation (unit, fake source), and
 * §9.7 "real simulation run": a drive without limits carries a part far
 * outside the load bounds — after <= 500 ms it is inside far, without any
 * layout event (R3-1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import {
  SceneScale, bindSceneScaleEvents, MIN_SCENE_RADIUS, MOVING_RECOMPUTE_MS,
  SCENE_SCALE_INVALIDATING_EVENTS, computeContentBoundsInto, type SceneScaleSource,
} from '../src/core/engine/rv-scene-scale';
import { AgentEyeGizmo } from '../src/core/engine/rv-agent-eye-gizmo';
import { EventEmitter } from '../src/core/rv-events';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { group, withComponent } from './fixtures/bake-fixture';
import type { RVDrive } from '../src/core/engine/rv-drive';

/** A scriptable source: content box + moving box, counting every walk. */
function fakeSource(): SceneScaleSource & {
  content: Box3; moving: Box3 | null; walks: number; movingWalks: number;
} {
  const src = {
    content: new Box3(new Vector3(-1, 0, -1), new Vector3(1, 1, 1)),
    moving: null as Box3 | null,
    walks: 0,
    movingWalks: 0,
    computeContentBounds(out: Box3): void { src.walks++; out.copy(src.content); },
    computeMovingBounds(out: Box3): boolean {
      src.movingWalks++;
      if (!src.moving) return false;
      out.copy(src.moving);
      return true;
    },
  };
  return src;
}

describe('computeContentBoundsInto — F-key framing (plan-515 F framing finding)', () => {
  /** A 1 m box far from the origin, like a real machine placed at x 4, z -5. */
  function sceneWithModel(): Scene {
    const scene = new Scene();
    const model = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    model.position.set(4, 0.5, -5);
    scene.add(model);
    return scene;
  }

  it('ignores a mesh whose own flag is on but whose ancestor is hidden', () => {
    const scene = sceneWithModel();
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial())); // at the origin
    scene.add(hidden);
    const box = computeContentBoundsInto(scene, new Box3());
    expect(box.min.x).toBeCloseTo(3.5, 5);
    expect(box.max.z).toBeCloseTo(-4.5, 5);
  });

  it('never counts the agent-eye cone, hidden (at the origin) or shown elsewhere', () => {
    const scene = sceneWithModel();
    const gizmo = new AgentEyeGizmo();
    scene.add(gizmo.group);
    // hidden, before the first spawn: it sits at the origin
    let box = computeContentBoundsInto(scene, new Box3());
    expect(box.min.x).toBeCloseTo(3.5, 5);
    expect(box.max.z).toBeCloseTo(-4.5, 5);
    // shown at a far-away agent camera pose
    gizmo.group.visible = true;
    gizmo.group.position.set(-20, 5, 20);
    gizmo.group.updateMatrixWorld(true);
    box = computeContentBoundsInto(scene, new Box3());
    expect(box.min.x).toBeCloseTo(3.5, 5);
    expect(box.max.z).toBeCloseTo(-4.5, 5);
    gizmo.dispose();
  });
});

describe('SceneScale (plan-515 §2.3)', () => {
  it('computes centre / radius / maxDim once and never walks without an invalidation', () => {
    const src = fakeSource();
    const sc = new SceneScale(src);
    const s = sc.get();
    expect(s.empty).toBe(false);
    expect(s.center.toArray()).toEqual([0, 0.5, 0]);
    expect(s.maxDim).toBe(2);
    expect(s.radius).toBeCloseTo(Math.sqrt(4 + 1 + 4) / 2, 12);
    for (let i = 0; i < 100; i++) sc.get();
    expect(src.walks).toBe(1);
  });

  it('several invalidations in one frame cost ONE walk on the next get()', () => {
    const src = fakeSource();
    const sc = new SceneScale(src);
    sc.get();
    sc.invalidate(); sc.invalidate(); sc.invalidate();
    expect(src.walks).toBe(1);
    sc.get(); sc.get();
    expect(src.walks).toBe(2);
  });

  it('re-computes after model-loaded, grows on layout-content-added, catches a moved placement, empties on model-cleared', () => {
    const src = fakeSource();
    const sc = new SceneScale(src);
    const events = new EventEmitter<Record<string, unknown>>();
    const off = bindSceneScaleEvents(sc, events);
    sc.get();

    // model-loaded: a new, larger model
    src.content.set(new Vector3(-10, 0, -10), new Vector3(10, 2, 10));
    events.emit('model-loaded', {});
    expect(sc.get().maxDim).toBe(20);

    // layout-content-added: a placement far to the right → the bounds grow
    src.content.max.x = 50;
    events.emit('layout-content-added', {});
    expect(sc.get().maxDim).toBe(60);

    // layout-transform-update: the placement is moved outside the old bounds
    src.content.min.x = -200;
    events.emit('layout-transform-update', {});
    const moved = sc.get();
    expect(moved.center.x).toBeCloseTo(-75, 9);
    expect(moved.radius).toBeGreaterThan(125);

    // layout-drag-end
    src.content.max.z = 300;
    events.emit('layout-drag-end', {});
    expect(sc.get().maxDim).toBeGreaterThanOrEqual(310);

    // model-cleared: nothing draws
    src.content.makeEmpty();
    events.emit('model-cleared', undefined);
    const cleared = sc.get();
    expect(cleared.empty).toBe(true);
    expect(cleared.radius).toBe(MIN_SCENE_RADIUS);

    off();
    src.content.set(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
    events.emit('model-loaded', {});
    expect(sc.get().empty).toBe(true); // unsubscribed: no invalidation any more
    expect(SCENE_SCALE_INVALIDATING_EVENTS).toEqual([
      'model-loaded', 'layout-content-added', 'layout-transform-update', 'layout-drag-end', 'model-cleared',
    ]);
  });

  it('radius never below 0.5 mm; a non-finite box counts as empty', () => {
    const src = fakeSource();
    src.content.set(new Vector3(0, 0, 0), new Vector3(0, 0, 0));
    const sc = new SceneScale(src);
    expect(sc.get().radius).toBe(MIN_SCENE_RADIUS);
    src.content.set(new Vector3(0, 0, 0), new Vector3(Number.NaN, 1, 1));
    sc.invalidate();
    expect(sc.get().empty).toBe(true);
  });

  it('while the simulation runs: throttled (500 ms), grow-only; full recompute on stop (R3-1)', () => {
    const src = fakeSource();
    const sc = new SceneScale(src);
    const r0 = sc.get().radius;

    sc.tick(0, true);                      // simulation starts
    src.moving = new Box3(new Vector3(40, 0, 0), new Vector3(41, 1, 1));
    sc.tick(100, true);
    sc.tick(MOVING_RECOMPUTE_MS - 1, true);
    expect(src.movingWalks).toBe(0);        // throttled
    expect(sc.get().radius).toBe(r0);

    sc.tick(MOVING_RECOMPUTE_MS, true);     // 500 ms after the start
    expect(src.movingWalks).toBe(1);
    const grown = sc.get();
    expect(grown.radius).toBeGreaterThan(20);
    expect(grown.center.x).toBeGreaterThan(19);
    expect(src.walks).toBe(1);              // no full walk for the moving content

    // The part comes back: grow-only — the bounds do NOT shrink while running.
    src.moving = new Box3(new Vector3(0, 0, 0), new Vector3(0.5, 0.5, 0.5));
    sc.tick(2 * MOVING_RECOMPUTE_MS, true);
    expect(sc.get().radius).toBe(grown.radius);

    // Stop → full recompute on the next get(): the box shrinks back.
    sc.tick(2 * MOVING_RECOMPUTE_MS + 16, false);
    const stopped = sc.get();
    expect(src.walks).toBe(2);
    expect(stopped.radius).toBeCloseTo(r0, 12);
  });

  it('onChange fires after a recompute that changed the snapshot, not after an unchanged one', () => {
    const src = fakeSource();
    const sc = new SceneScale(src);
    let calls = 0;
    const off = sc.onChange(() => { calls++; });
    sc.get();
    expect(calls).toBe(1);
    sc.invalidate(); sc.get();
    expect(calls).toBe(1);                  // same bounds
    src.content.max.x = 5;
    sc.invalidate(); sc.get();
    expect(calls).toBe(2);
    off();
  });
});

// ─── §9.7: a REAL simulation run in the real viewer ──────────────────────

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

describe('SceneScale in the viewer — real simulation run (plan-515 §9.7, R3-1)', () => {
  it('a drive without limits carries a part far outside the load bounds: inside far after <= 500 ms, no layout event', async () => {
    handle = await createTestViewer('webgl', { width: 480, height: 360 });
    const v = handle.viewer;
    const root = group('SimScene');
    const base = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshStandardMaterial({ color: 0x777777 }));
    base.name = 'Base';
    root.add(base);
    // 200 m/s, no limits (TargetSpeed in mm/s).
    const slide = withComponent(group('Slide'), 'Drive', { Direction: 'LinearX', TargetSpeed: 200_000, JogForward: true });
    slide.position.set(0, 0.3, 0);
    const part = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x33aa33 }));
    part.name = 'Part';
    slide.add(part);
    root.add(slide);
    await v.loadModel('sim-scale.glb', { data: await objectToGlb(root) });
    for (let i = 0; i < 2; i++) await frame();

    const layoutEvents: string[] = [];
    for (const name of ['layout-content-added', 'layout-transform-update', 'layout-drag-end', 'model-loaded', 'model-cleared'] as const) {
      v.on(name as 'model-loaded', () => { layoutEvents.push(name); });
    }
    const loadRadius = v.sceneScale.get().radius;
    const drive = v.drives.find((d) => d.node.name === 'Slide') as RVDrive | undefined;
    expect(drive, 'the drive was built').toBeTruthy();
    expect(v.isSimulationPaused).toBe(false);

    // Let it run until the part is far outside the load bounds, then stop it there.
    const partWorld = new Vector3();
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      await frame();
      drive!.node.getWorldPosition(partWorld);
      if (partWorld.length() > 50) break;
    }
    drive!.jogForward = false;
    drive!.stop();
    await frame();
    drive!.node.getWorldPosition(partWorld);
    expect(partWorld.length(), "the part left the load bounds by far").toBeGreaterThan(50);
    const movingBefore = v.sceneScale.stats.movingComputes;

    // <= 500 ms (plus one frame) later the scene scale contains it — while
    // the simulation keeps running, with no layout event at all.
    const tStop = performance.now();
    while (performance.now() - tStop < 560) await frame();
    const s = v.sceneScale.get();
    const cam = (v as unknown as { _activeCamera: { position: Vector3; far: number } })._activeCamera;
    console.log(`[plan-515] sim run: part at x=${partWorld.x.toFixed(1)} m; scene radius ${loadRadius.toFixed(3)} → ${s.radius.toFixed(2)} m; ` +
      `far ${cam.far.toFixed(1)} m; camera→part ${cam.position.distanceTo(partWorld).toFixed(1)} m; moving recomputes +${v.sceneScale.stats.movingComputes - movingBefore}`);
    expect(layoutEvents).toEqual([]);
    expect(v.sceneScale.stats.movingComputes).toBeGreaterThan(movingBefore);
    expect(s.center.distanceTo(partWorld)).toBeLessThanOrEqual(s.radius + 1e-6);
    expect(cam.far).toBeGreaterThan(cam.position.distanceTo(partWorld));
  }, 30_000);
});
