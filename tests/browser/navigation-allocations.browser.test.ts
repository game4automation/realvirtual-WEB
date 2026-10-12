// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 R3-5 — the wheel tick of the NavigationController and the
 * navigation mathematics allocate no object per tick (< MAX_BYTES_PER_TICK);
 * Phase 2: the same for one orbit and one pan DRAG tick.
 *
 * Measured with the V8 sampling heap profiler over CDP (`sampleAllocations`),
 * bytes aggregated per source module over EVERY sampled frame BEFORE any
 * top-N truncation. Without CDP the test is reported as SKIPPED with the reason
 * "not verified" — never silently green.
 *
 * Why a file of its own: V8 attributes an INLINED callee's allocations to the
 * physical caller frame, and the type feedback other tests leave behind (both
 * camera types, clipping changes, tweens) changes what gets inlined. A fresh
 * page measures this module's own steady state.
 *
 * Why a stand-in picker: the real pick pipeline allocates by design (plan-515
 * R2-7, ~1.2 KB per pick, reported below for information); inlined parts of it
 * would otherwise be booked on the controller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import type { SurfaceHit } from '../../src/core/engine/rv-raycast-manager';
import { sampleAllocations, bytesInModules } from '../helpers/heap-sampling';

const W = 640;
const H = 480;
const N = 2000;
/**
 * Pass threshold in bytes per wheel tick (average over the window).
 *
 * The claim is "the controller allocates no OBJECTS per tick". The smallest V8
 * heap object (a boxed HeapNumber) costs 12-16 B, a plain object or a typed
 * array far more, so one object per tick shows up as >= ~16 B/tick. Under 8 B
 * per tick on average therefore cannot be one object per tick - but it
 * tolerates what the sampler books on `_syncCamera` under CPU load: ~1 B/tick
 * of V8 number boxing inside inlined three.js code (a deopt / OSR materialising
 * a double), which is not an object the controller creates. An exact-0 rule was
 * red under load (1.05-1.16 B/tick) and green on an idle machine. The
 * self-check test below proves a real one-object-per-tick regression still
 * lands above this line at the same sampling interval.
 */
const MAX_BYTES_PER_TICK = 8;
/** Mean sampling interval of the heap profiler, bytes - below one object. */
const SAMPLING_INTERVAL = 32;
/** Keeps the self-check's allocation alive so escape analysis cannot remove it. */
let allocSink: Float64Array | null = null;

let handle: TestViewerHandle | null = null;

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: W, height: H });
  const root = new Group();
  root.name = 'AllocScene';
  const mat = new MeshStandardMaterial({ color: 0x8899aa });
  const floor = new Mesh(new BoxGeometry(4, 0.1, 4), mat);
  floor.position.set(0, -0.05, 0);
  root.add(floor);
  for (let i = 0; i < 9; i++) {
    const b = new Mesh(new SphereGeometry(0.15, 24, 12), mat);
    b.position.set((i % 3) - 1, 0.3, Math.floor(i / 3) - 1);
    root.add(b);
  }
  await handle.viewer.loadModel('nav-alloc.glb', { data: await objectToGlb(root) });
  for (let i = 0; i < 3; i++) await frame();
}, 60_000);

afterAll(() => {
  handle?.dispose();
  handle = null;
});

describe('plan-515 R3-5 — wheel tick allocations', () => {
  it(`controller + navigation math allocate < ${MAX_BYTES_PER_TICK} B per wheel tick (no object per tick)`, async (ctx) => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = (v as unknown as { _activeCamera: PerspectiveCamera })._activeCamera;
    cam.position.set(3, 2.5, 4);
    v.controls.target.set(0, 0.3, 0);
    v.controls.update();
    for (let i = 0; i < 4; i++) await frame();

    const r = v.renderer.domElement.getBoundingClientRect();
    const x = W / 2 + 40, y = H / 2 + 30; // off-centre, over the floor
    const rm = v.raycastManager!;
    const probe: SurfaceHit = {
      point: new Vector3(), distance: 0, blocked: false, path: null,
      ray: { origin: new Vector3(), direction: new Vector3() },
    };
    expect(rm.raycastSurface(r.left + x, r.top + y, probe), 'the probe pixel is over geometry').toBe(true);
    const fixedPoint = probe.point.clone();
    const fixedOrigin = probe.ray!.origin.clone();
    const fixedDir = probe.ray!.direction.clone();

    const n = nav as unknown as {
      _pendingNotches: number; _clientX: number; _clientY: number; _offX: number; _offY: number; _lastWheelMs: number;
    };
    // Wheel time stamp in the future: render frames that run between the
    // warm-up and the measurement must not end the gesture — 'start' / 'end'
    // are dispatched once per GESTURE by design (three copies the listener
    // array), and the window measures the ticks inside one gesture.
    const t0 = performance.now() + 1e9;
    const loop = (): void => {
      for (let i = 0; i < N; i++) {
        // A zoom-in run, then the same zoom-out run: the pose returns to its start.
        // (Real gestures are runs; a per-TICK direction flip is not an input the
        // wheel produces.) The steps stay below the 1 % clipping hysteresis, so
        // the measured window is the pure wheel tick — see the clipping check.
        // Every 4th frame is idle (no wheel) — like real frames, and so both
        // branches of tick() carry type feedback (a never-seen branch deopts).
        n._pendingNotches = i % 4 === 3 ? 0 : i < N / 2 ? 1e-5 : -1e-5;
        n._clientX = Math.round(r.left + x); n._clientY = Math.round(r.top + y); n._offX = x; n._offY = y;
        n._lastWheelMs = t0; // what the wheel handler stamps: ONE gesture, 'start' once
        nav.tick(t0);
      }
    };
    const warm = (): void => { for (let k = 0; k < 6; k++) loop(); };

    const stub = (_cx: number, _cy: number, out: SurfaceHit): boolean => {
      out.point.copy(fixedPoint);
      out.blocked = false;
      if (out.ray) { out.ray.origin.copy(fixedOrigin); out.ray.direction.copy(fixedDir); }
      return true;
    };
    // Up to three sampling runs; the BEST run must stay below MAX_BYTES_PER_TICK.
    // Taking the best run is sound: a real per-tick object (>= 16 B x 2000 ticks
    // = ~1000 samples at a 32-B interval) is present in EVERY run, while JIT
    // settling (a deopt materialising boxed doubles) is transient and load-
    // dependent. The loop stops at the first run below the threshold.
    const settle = async (): Promise<void> => {
      warm();
      await new Promise((res) => setTimeout(res, 100)); // let the concurrent compiler install
      warm();
    };
    (rm as unknown as { raycastSurface: typeof stub }).raycastSurface = stub; // own property shadows the prototype
    const runs: number[] = [];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let clip0 = 0;
        const rep = await sampleAllocations(loop, SAMPLING_INTERVAL, async () => { await settle(); clip0 = nav.stats.clippingUpdates; });
        if (!rep) {
          console.log('[plan-515] (e) NOT VERIFIED — CDP heap sampling unavailable in this browser');
          ctx.skip('not verified: CDP heap sampling unavailable (R3-5)');
          return;
        }
        expect(rep.byModule.size, 'the profiler saw the run').toBeGreaterThan(0);
        // Scope: no near/far change inside the window. A clipping update (> 1 %
        // change, at most once per frame) rebuilds the projection matrix through
        // three's `updateProjectionMatrix`, whose argument boxing is three's cost.
        expect(nav.stats.clippingUpdates - clip0, 'no clipping update inside the measured window').toBe(0);
        const mine = bytesInModules(rep, /^rv-navigation-(controller|math)\.ts$/);
        runs.push(mine);
        if (mine > 0) {
          console.log(`[plan-515] (e) attempt ${attempt + 1}: own frames ` + rep.allFrames
            .filter((f) => /rv-navigation-(controller|math)/.test(f.frame))
            .map((f) => `${f.frame} ${(f.bytes / N).toFixed(2)}B/tick`).join(' | '));
        }
        if (mine / N < MAX_BYTES_PER_TICK) break;
      }
    } finally {
      delete (rm as unknown as { raycastSurface?: unknown }).raycastSurface;
    }
    console.log(`[plan-515] (e) controller + math per ${N} wheel ticks: ` +
      `${runs.map((b) => `${b} B (${(b / N).toFixed(2)} B/tick)`).join(', ')} (stand-in picker)`);
    expect(Math.min(...runs) / N, `below ${MAX_BYTES_PER_TICK} B/tick - no object allocated per tick`)
      .toBeLessThan(MAX_BYTES_PER_TICK);

    // Information (R2-7): the same loop with the REAL pick pipeline.
    const real = await sampleAllocations(loop, SAMPLING_INTERVAL, settle);
    if (real) {
      const pick = bytesInModules(real, /^rv-(raycast-manager|pick-backend|pick-structure|pick-metrics)/);
      console.log(`[plan-515] (e) real picker: pick modules ~${(pick / N).toFixed(0)} B per wheel tick (R2-7, by design); ` +
        `top: ${real.top.slice(0, 6).map((t) => `${t.frame} ${(t.bytes / N).toFixed(0)}B`).join(' | ')}`);
    }
  });

  for (const kind of ['orbit', 'pan'] as const) {
    it(`Phase 2: controller + navigation math allocate < ${MAX_BYTES_PER_TICK} B per ${kind} DRAG tick`, async (ctx) => {
      const v = handle!.viewer;
      const nav = v.navController!;
      const cam = (v as unknown as { _activeCamera: PerspectiveCamera })._activeCamera;
      cam.position.set(3, 2.5, 4);
      v.controls.target.set(0, 0.3, 0);
      v.controls.update();
      for (let i = 0; i < 4; i++) await frame();
      const cv = v.renderer.domElement as HTMLCanvasElement;
      const r = cv.getBoundingClientRect();
      const x = W / 2 + 40, y = H / 2 + 30;
      const cap = cv.setPointerCapture;
      cv.setPointerCapture = () => {};
      // The gesture starts for real (default mode: no pick at mouse-down; any
      // gesture-start work stays outside the window) …
      const btn = kind === 'orbit' ? 2 : 1;
      cv.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse',
        button: btn, buttons: kind === 'orbit' ? 2 : 4, bubbles: true, cancelable: true,
      }));
      expect(nav.dragActive).toBe(true);
      // … and the window measures the per-frame drag ticks: pixel deltas as the
      // move handler accumulates them (a run one way, then back — the pose
      // returns; tiny steps, so no near/far change enters the window).
      const n = nav as unknown as { _accDX: number; _accDY: number; _ptrAX: number; _ptrAY: number };
      const baseX = r.left + x, baseY = r.top + y;
      const t0 = performance.now() + 1e9;
      const loop = (): void => {
        for (let i = 0; i < N; i++) {
          const d = i % 4 === 3 ? 0 : i < N / 2 ? 0.002 : -0.002;
          n._accDX = d; n._accDY = d * 0.5;
          n._ptrAX += d; n._ptrAY += d * 0.5;
          nav.tick(t0);
        }
        n._ptrAX = baseX; n._ptrAY = baseY;
      };
      const settle = async (): Promise<void> => {
        for (let k = 0; k < 6; k++) loop();
        await new Promise((res) => setTimeout(res, 100));
        for (let k = 0; k < 6; k++) loop();
      };
      const runs: number[] = [];
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          let clip0 = 0;
          const rep = await sampleAllocations(loop, SAMPLING_INTERVAL, async () => { await settle(); clip0 = nav.stats.clippingUpdates; });
          if (!rep) {
            console.log(`[plan-515] (e) ${kind} drag: NOT VERIFIED — CDP heap sampling unavailable in this browser`);
            ctx.skip('not verified: CDP heap sampling unavailable (R3-5)');
            return;
          }
          expect(nav.dragActive, 'still inside the drag').toBe(true);
          expect(nav.stats.clippingUpdates - clip0, 'no clipping update inside the measured window').toBe(0);
          const mine = bytesInModules(rep, /^rv-navigation-(controller|math)\.ts$/);
          runs.push(mine);
          if (mine > 0) {
            console.log(`[plan-515] (e) ${kind} drag attempt ${attempt + 1}: own frames ` + rep.allFrames
              .filter((f) => /rv-navigation-(controller|math)/.test(f.frame))
              .map((f) => `${f.frame} ${(f.bytes / N).toFixed(2)}B/tick`).join(' | '));
          }
          if (mine / N < MAX_BYTES_PER_TICK) break;
        }
      } finally {
        cv.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
        cv.setPointerCapture = cap;
      }
      console.log(`[plan-515] (e) ${kind} drag: controller + math per ${N} ticks: ` +
        `${runs.map((b) => `${b} B (${(b / N).toFixed(2)} B/tick)`).join(', ')}`);
      expect(nav.dragActive).toBe(false);
      expect(Math.min(...runs) / N, `below ${MAX_BYTES_PER_TICK} B/tick - no object allocated per ${kind} tick`)
        .toBeLessThan(MAX_BYTES_PER_TICK);
    });
  }

  it(`self-check: one Float64Array(2) per tick measures >= ${MAX_BYTES_PER_TICK} B/tick`, async (ctx) => {
    // Proves the threshold still catches a real regression at the same sampling
    // interval and the same per-module aggregation: a stand-in tick that
    // allocates ONE small object per call (kept alive via a module sink so
    // escape analysis cannot drop it) must be reported at or above the line.
    let acc = 0;
    const standInTick = (i: number): void => {
      const a = new Float64Array(2);
      a[0] = i; a[1] = acc;
      allocSink = a;
      acc += a[0] * 1e-9;
    };
    const loop = (): void => { for (let i = 0; i < N; i++) standInTick(i); };
    const warmup = async (): Promise<void> => {
      for (let k = 0; k < 6; k++) loop();
      await new Promise((res) => setTimeout(res, 100));
      for (let k = 0; k < 6; k++) loop();
    };
    const rep = await sampleAllocations(loop, SAMPLING_INTERVAL, warmup);
    if (!rep) {
      ctx.skip('not verified: CDP heap sampling unavailable (R3-5 self-check)');
      return;
    }
    const mine = bytesInModules(rep, /^navigation-allocations[.]browser[.]test[.]ts$/);
    console.log(`[plan-515] (e) self-check: injected Float64Array(2) per tick -> ${(mine / N).toFixed(2)} B/tick ` +
      `(threshold ${MAX_BYTES_PER_TICK})`);
    expect(allocSink).not.toBeNull();
    expect(mine / N, 'one object per tick must not hide below the threshold').toBeGreaterThanOrEqual(MAX_BYTES_PER_TICK);
  });
});
