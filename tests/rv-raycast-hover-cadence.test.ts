// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Hover cadence per backend (plan-756 F7 / Q10, §9.4a).
 *
 * The baked `PickBackend` answers a ray in ~0.03 ms, so it declares
 * `hoverCadence: 'frame'`: at most ONE hover ray per animation frame, and none
 * without pointer movement. The editor's instance pick index keeps the historical
 * 50 ms (`'throttled'`), and with both installed each keeps its own cadence.
 *
 * What is pinned here:
 *   - ≤ 1 ray per frame no matter how many pointermove events arrive
 *   - no ray at all when the pointer did not move since the last one
 *   - a pick never asks for a frame of its own (render-on-demand): the only
 *     `requestAnimationFrame` is the one that PACES the sample, and an unchanged
 *     hover result touches the highlighter not at all
 *   - a throttled-only backend behaves exactly as before (50 ms)
 *   - both cadences side by side, on one ray stream
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Mesh, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { Intersection, Object3D, Raycaster } from 'three';
import { RaycastManager, type RaycastBackend } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';

// ─── Harness ────────────────────────────────────────────────────────

/** Manual frame queue: nothing runs until `flushFrame()` is called. */
class FrameClock {
  rafCalls = 0;
  private queue: (() => void)[] = [];
  private _now = 1_000;

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      this.rafCalls++;
      this.queue.push(cb);
      return this.rafCalls;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(performance, 'now').mockImplementation(() => this._now);
  }

  /** Run every callback scheduled so far (one browser frame). */
  flushFrame(): void {
    const due = this.queue;
    this.queue = [];
    for (const cb of due) cb();
  }

  advance(ms: number): void { this._now += ms; }
  get pending(): number { return this.queue.length; }
}

function makeCountingBackend(cadence?: 'frame' | 'throttled'): { backend: RaycastBackend; calls: () => number } {
  let calls = 0;
  const backend: RaycastBackend = {
    raycast(_raycaster: Raycaster, _out: Intersection<Object3D>[]): void { calls++; },
    resolvePath(): string | null { return null; },
  };
  if (cadence) (backend as { hoverCadence?: string }).hoverCadence = cadence;
  return { backend, calls: () => calls };
}

function makeHarness() {
  const canvas = document.createElement('canvas');
  const registry = new NodeRegistry();
  const highlighter = { highlight: vi.fn(), highlightInstancedMU: vi.fn(), clear: vi.fn() };
  const rm = new RaycastManager(
    { domElement: canvas } as unknown as { readonly domElement: HTMLCanvasElement },
    () => new PerspectiveCamera(), new Scene(), registry,
    highlighter as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
  const move = (x = 10, y = 10): void => {
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
  };
  const down = (x = 10, y = 10): void => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y }));
  };
  return { rm, move, down, highlighter, registry };
}

let clock: FrameClock;

beforeEach(() => {
  clock = new FrameClock();
  clock.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Frame cadence ──────────────────────────────────────────────────

describe('hover cadence — frame-paced backend (plan-756 F7)', () => {
  it('coalesces many pointermove events into ONE ray per frame', () => {
    const { rm, move } = makeHarness();
    const pick = makeCountingBackend('frame');
    rm.addBackend(pick.backend);

    for (let i = 0; i < 8; i++) { move(10 + i, 10); clock.advance(1); }
    // Nothing yet: the sample is paced by the frame, not by the event.
    expect(pick.calls()).toBe(0);

    clock.flushFrame();
    expect(pick.calls()).toBe(1);

    for (let i = 0; i < 5; i++) { move(30 + i, 10); clock.advance(1); }
    clock.flushFrame();
    expect(pick.calls()).toBe(2);
    rm.dispose();
  });

  it('never rays without pointer movement — extra frames are free', () => {
    const { rm, move } = makeHarness();
    const pick = makeCountingBackend('frame');
    rm.addBackend(pick.backend);

    move();
    clock.flushFrame();
    expect(pick.calls()).toBe(1);

    // Frames keep coming (camera damping, simulation) but the pointer stands
    // still: no further pointermove, therefore no further ray — which is also
    // exactly what happened before plan-756 when only the camera moved.
    for (let i = 0; i < 10; i++) { clock.advance(16); clock.flushFrame(); }
    expect(pick.calls()).toBe(1);
    expect(clock.pending).toBe(0);
    rm.dispose();
  });

  it('a pick never forces a frame of its own (render-on-demand)', () => {
    const { rm, move, highlighter, registry } = makeHarness();
    const pick = makeCountingBackend('frame');
    rm.addBackend(pick.backend);

    move();
    const afterScheduling = clock.rafCalls;
    expect(afterScheduling).toBe(1); // the pacing frame, nothing else
    clock.flushFrame();
    // The ray found nothing and changed nothing: no new frame was requested and
    // the highlighter was not asked to draw anything.
    expect(clock.rafCalls).toBe(afterScheduling);
    expect(highlighter.highlight).not.toHaveBeenCalled();

    // A second burst schedules exactly one more pacing frame, never two.
    move(20, 20);
    move(21, 20);
    expect(clock.rafCalls).toBe(afterScheduling + 1);
    rm.dispose();
  });

  it('a tap flushes the pending sample so the click path sees fresh hover', () => {
    const { rm, move, down } = makeHarness();
    const pick = makeCountingBackend('frame');
    rm.addBackend(pick.backend);

    // Move and click within the same frame (a fast tap): the ray must have run
    // BEFORE the click handlers read `hoveredNode`.
    move(40, 40);
    expect(pick.calls()).toBe(0);
    down(40, 40);
    expect(pick.calls()).toBe(1);

    // The frame that was already scheduled becomes a no-op — still one ray.
    clock.flushFrame();
    expect(pick.calls()).toBe(1);

    // A second tap without any movement spends no ray at all.
    down(40, 40);
    expect(pick.calls()).toBe(1);
    rm.dispose();
  });

  it('a pending sample does not survive dispose', () => {
    const { rm, move } = makeHarness();
    const pick = makeCountingBackend('frame');
    rm.addBackend(pick.backend);
    move();
    rm.dispose();
    clock.flushFrame();
    expect(pick.calls()).toBe(0);
  });

  it('the baked PickBackend is the backend that asks for it', () => {
    expect(new PickBackend(new BakeRegistry()).hoverCadence).toBe('frame');
  });
});

// ─── Throttled cadence (unchanged behaviour) ────────────────────────

describe('hover cadence — throttled backend keeps 50 ms', () => {
  it('samples at most every 50 ms and needs no frame at all', () => {
    const { rm, move } = makeHarness();
    const editor = makeCountingBackend(); // no declaration = 'throttled'
    rm.setBackend(editor.backend);

    move();
    expect(editor.calls()).toBe(1);        // synchronous, as before plan-756
    expect(clock.rafCalls).toBe(0);        // no frame pacing on this path

    clock.advance(20); move();
    clock.advance(20); move();
    expect(editor.calls()).toBe(1);        // still inside the 50 ms window

    clock.advance(20); move();
    expect(editor.calls()).toBe(2);
    rm.dispose();
  });
});

// ─── Both at once ───────────────────────────────────────────────────

describe('hover cadence — two backends, two cadences', () => {
  it('paces the baked backend per frame and the editor backend at 50 ms', () => {
    const { rm, move } = makeHarness();
    const editor = makeCountingBackend('throttled');
    const baked = makeCountingBackend('frame');
    rm.setBackend(editor.backend);
    rm.addBackend(baked.backend);

    // Ten 16 ms frames with the pointer moving in each of them.
    for (let f = 0; f < 10; f++) {
      move(10 + f, 10);
      clock.flushFrame();
      clock.advance(16);
    }

    // One ray per frame for the frame-paced backend …
    expect(baked.calls()).toBe(10);
    // … and one per 50 ms window for the throttled one (t = 0, 64, 128 ms).
    expect(editor.calls()).toBe(3);
    rm.dispose();
  });

  it('a frame-paced backend does not make the throttled one skip a click', () => {
    // Cadence is a HOVER rule only: an explicit ray answers from every backend.
    const { rm } = makeHarness();
    const editor = makeCountingBackend('throttled');
    const baked = makeCountingBackend('frame');
    rm.setBackend(editor.backend);
    rm.addBackend(baked.backend);

    rm.raycastForRVNodeDetailed({ clientX: 5, clientY: 5 });
    rm.raycastForRVNodeDetailed({ clientX: 5, clientY: 5 });
    expect(editor.calls()).toBe(2);
    expect(baked.calls()).toBe(2);
    rm.dispose();
  });
});

// ─── Skipped backend ≠ empty space ──────────────────────────────────

describe('hover cadence — a skipped throttled backend does not clear the hover', () => {
  /** A backend whose ray always hits `mesh` while `hitting()` is true. */
  function makeHittingBackend(
    mesh: Object3D, path: string, cadence: 'frame' | 'throttled', hitting: () => boolean,
  ): RaycastBackend {
    const backend: RaycastBackend = {
      raycast(_raycaster: Raycaster, out: Intersection<Object3D>[]): void {
        if (hitting()) out.push({ object: mesh, distance: 1, point: new Vector3() } as Intersection<Object3D>);
      },
      resolvePath(m: Object3D): string | null { return m === mesh ? path : null; },
    };
    (backend as { hoverCadence?: string }).hoverCadence = cadence;
    return backend;
  }

  it('keeps the highlight across the frames the editor backend is not asked (2026-09-22 flicker)', () => {
    const { rm, move, highlighter, registry } = makeHarness();
    const part = new Mesh();
    part.name = 'Part';
    registry.registerNode('Part', part);
    let overPart = true;
    const editor = makeHittingBackend(part, 'Part', 'throttled', () => overPart);
    const baked = makeCountingBackend('frame');
    rm.setBackend(editor);
    rm.addBackend(baked.backend);

    // Pointer moving on the part for ten 16 ms frames: the editor backend answers
    // only every 50 ms, the baked one every frame with no hit of its own.
    for (let f = 0; f < 10; f++) {
      move(10 + f, 10);
      clock.flushFrame();
      clock.advance(16);
    }
    expect(highlighter.highlight).toHaveBeenCalledTimes(1);
    expect(highlighter.clear).not.toHaveBeenCalled();
    expect(rm.hoveredNode).toBe(part);

    // Pointer leaves the part: the next sample that ASKS the editor backend clears.
    overPart = false;
    clock.advance(50);
    move(200, 200);
    clock.flushFrame();
    expect(highlighter.clear).toHaveBeenCalledTimes(1);
    expect(rm.hoveredNode).toBeNull();
    rm.dispose();
  });
});
