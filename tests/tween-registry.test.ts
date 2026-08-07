// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * tween-registry.test.ts — Plan 194 §3 / P5 / V3 / V4.
 *
 * Verifies the central sim-time interpolator:
 *  - progress = (simNow − t0)/duration is monotonic and clamped to [0,1].
 *  - Animated position tween is 1:1 to linear motion (lerpVectors).
 *  - Drive tween writes from + (to−from)·p.
 *  - FastForward sub-mode writes NO transform.
 *  - duration=0 is robust (no NaN), null visual / null drive are skipped.
 *  - cancelled tweens stop animating and free their pool slot.
 *  - the pool does NOT allocate a new record per event (V3).
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  TweenRegistry,
  type PositionTweenTarget,
  type DriveTweenTarget,
} from '../src/core/material-flow/tween-registry';

// ─── Fakes ───────────────────────────────────────────────────────────────

function makePosTarget(): PositionTweenTarget & { pos: Vector3; writes: number } {
  return {
    pos: new Vector3(),
    writes: 0,
    setPosition(v: Vector3): void {
      this.pos.copy(v);
      this.writes++;
    },
  };
}

function makeDriveTarget(): DriveTweenTarget & { value: number; writes: number } {
  return {
    value: NaN,
    writes: 0,
    setPosition(v: number): void {
      this.value = v;
      this.writes++;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('TweenRegistry — position tween (Animated = 1:1)', () => {
  it('interpolates linearly between from and to over the duration', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const from = new Vector3(0, 0, 0);
    const to = new Vector3(10, 0, 0);
    reg.addPosition(t, from, to, 0, 2); // t0=0, duration=2s

    reg.onRender(0, 'animated');
    expect(t.pos.x).toBeCloseTo(0);
    reg.onRender(0.5, 'animated');
    expect(t.pos.x).toBeCloseTo(2.5); // 0.5/2 = 25%
    reg.onRender(1, 'animated');
    expect(t.pos.x).toBeCloseTo(5); // 50%
    reg.onRender(2, 'animated');
    expect(t.pos.x).toBeCloseTo(10); // 100%
  });

  it('progress is monotonic and clamped past the end', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(0, 0, 100), 1, 1);
    reg.onRender(0.5, 'animated'); // before t0 → clamp 0
    expect(t.pos.z).toBeCloseTo(0);
    reg.onRender(1.5, 'animated'); // mid
    expect(t.pos.z).toBeCloseTo(50);
    reg.onRender(5, 'animated'); // far past end → clamp 1, then reaped
    expect(t.pos.z).toBeCloseTo(100);
  });

  it('does not mutate the caller-supplied from/to vectors', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const from = new Vector3(1, 2, 3);
    const to = new Vector3(4, 5, 6);
    reg.addPosition(t, from, to, 0, 1);
    reg.onRender(0.5, 'animated');
    expect(from.toArray()).toEqual([1, 2, 3]);
    expect(to.toArray()).toEqual([4, 5, 6]);
  });
});

describe('TweenRegistry — drive tween', () => {
  it('writes from + (to − from) · progress', () => {
    const reg = new TweenRegistry(8);
    const d = makeDriveTarget();
    reg.addDrive(d, 0, 90, 0, 3); // 0° → 90° over 3s
    reg.onRender(0, 'animated');
    expect(d.value).toBeCloseTo(0);
    reg.onRender(1, 'animated');
    expect(d.value).toBeCloseTo(30);
    reg.onRender(3, 'animated');
    expect(d.value).toBeCloseTo(90);
  });
});

describe('TweenRegistry — FastForward (no transform write)', () => {
  it('does not write any transform in fastforward sub-mode', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const d = makeDriveTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(99, 0, 0), 0, 2);
    reg.addDrive(d, 0, 99, 0, 2);

    reg.onRender(1, 'fastforward');
    expect(t.writes).toBe(0);
    expect(d.writes).toBe(0);
    expect(t.pos.x).toBe(0);

    // ...but a finished tween is still reaped (no leak), even in fastforward.
    reg.onRender(2, 'fastforward');
    expect(reg.activeCount).toBe(0);
  });
});

describe('TweenRegistry — settle (leaving FastForward)', () => {
  it('writes running tweens at simNow even though fastforward would skip them', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);

    // FastForward left the part stranded (no write for the still-running tween).
    reg.onRender(1, 'fastforward');
    expect(t.writes).toBe(0);
    expect(t.pos.x).toBe(0);

    // settle() snaps it to the exact sim position (50% → x=5) and keeps it alive.
    reg.settle(1);
    expect(t.pos.x).toBeCloseTo(5);
    expect(reg.activeCount).toBe(1);
  });

  it('reaps finished tweens at their final value', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);
    reg.settle(2); // at/after end → final value + reaped
    expect(t.pos.x).toBeCloseTo(10);
    expect(reg.activeCount).toBe(0);
  });
});

describe('TweenRegistry — robustness (V4)', () => {
  it('duration=0 never produces NaN', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 0);
    reg.onRender(0, 'animated');
    expect(Number.isNaN(t.pos.x)).toBe(false);
    // At/after the (clamped) end the tween reaches its target and is reaped.
    reg.onRender(0.01, 'animated');
    expect(t.pos.x).toBeCloseTo(10);
    expect(reg.activeCount).toBe(0);
  });

  it('null visual / null drive are skipped (no crash, handle = −1)', () => {
    const reg = new TweenRegistry(8);
    const h1 = reg.addPosition(null, new Vector3(), new Vector3(), 0, 1);
    const h2 = reg.addDrive(null, 0, 1, 0, 1);
    expect(h1).toBe(-1);
    expect(h2).toBe(-1);
    expect(reg.activeCount).toBe(0);
    expect(() => reg.onRender(0.5, 'animated')).not.toThrow();
  });

  it('cancelled tween stops animating and frees its slot', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const h = reg.addPosition(t, new Vector3(0, 0, 0), new Vector3(100, 0, 0), 0, 10);
    reg.onRender(1, 'animated');
    expect(t.pos.x).toBeCloseTo(10);
    const writesBefore = t.writes;
    reg.cancel(h);
    expect(reg.activeCount).toBe(0);
    reg.onRender(5, 'animated'); // would be 50 if still active
    expect(t.writes).toBe(writesBefore); // no further write
    expect(t.pos.x).toBeCloseTo(10);
  });

  it('double-cancel and stale handle are ignored', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    const h = reg.addPosition(t, new Vector3(), new Vector3(1, 0, 0), 0, 1);
    reg.cancel(h);
    expect(() => reg.cancel(h)).not.toThrow();
    expect(reg.activeCount).toBe(0);
  });
});

describe('TweenRegistry — headless MU records (plan-262 Phase 3)', () => {
  it('null target WITHOUT muId keeps the legacy behaviour (no record, handle −1)', () => {
    const reg = new TweenRegistry(8);
    expect(reg.addPosition(null, new Vector3(), new Vector3(1, 0, 0), 0, 1)).toBe(-1);
    expect(reg.activeCount).toBe(0);
  });

  it('null target WITH muId creates a record: no write, window kept, reaped normally', () => {
    const reg = new TweenRegistry(8);
    const h = reg.addPosition(null, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2, 7);
    expect(h).not.toBe(-1);
    expect(reg.activeCount).toBe(1);

    // Rendering a headless record must not crash and must not write anything.
    expect(() => reg.onRender(1, 'animated')).not.toThrow();
    expect(reg.activeCount).toBe(1); // still running

    // Finished → reaped like any other record (no leak).
    reg.onRender(2.5, 'animated');
    expect(reg.activeCount).toBe(0);
  });

  it('activeWindowForMu returns the containing window; the LATEST-starting one wins; null otherwise', () => {
    const reg = new TweenRegistry(8);
    reg.addPosition(null, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 10, 7);   // belt transit
    reg.addPosition(null, new Vector3(5, 0, 0), new Vector3(5, 0, 9), 4, 4, 7);     // later ride
    reg.addPosition(null, new Vector3(99, 0, 0), new Vector3(99, 0, 9), 0, 10, 8);  // other MU

    // t=2: only the transit window contains it.
    const w2 = reg.activeWindowForMu(7, 2);
    expect(w2).not.toBeNull();
    expect(w2!.t0).toBe(0);
    expect(w2!.to.x).toBeCloseTo(10);

    // t=5: both windows contain it → the later-starting ride wins.
    const w5 = reg.activeWindowForMu(7, 5);
    expect(w5!.t0).toBe(4);
    expect(w5!.to.z).toBeCloseTo(9);

    // Unknown MU / time outside every window / untracked id → null.
    expect(reg.activeWindowForMu(99, 5)).toBeNull();
    expect(reg.activeWindowForMu(7, 20)).toBeNull();
    expect(reg.activeWindowForMu(-1, 5)).toBeNull();
  });

  it('attachTargetForMu re-targets running headless records; subsequent renders write the visual', () => {
    const reg = new TweenRegistry(8);
    const t = makePosTarget();
    reg.addPosition(null, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2, 7);

    expect(reg.attachTargetForMu(7, t)).toBe(1);
    reg.onRender(1, 'animated');
    expect(t.pos.x).toBeCloseTo(5); // the tween now moves the materialised visual

    // Records that already carry a target are left alone; unknown ids attach nothing.
    expect(reg.attachTargetForMu(7, makePosTarget())).toBe(0);
    expect(reg.attachTargetForMu(42, t)).toBe(0);
  });

  it('a reused pool record does not leak the previous muId', () => {
    const reg = new TweenRegistry(1); // force reuse of the same slot
    reg.addPosition(null, new Vector3(), new Vector3(1, 0, 0), 0, 1, 7);
    reg.onRender(2, 'animated'); // reap
    expect(reg.activeCount).toBe(0);

    const t = makePosTarget();
    reg.addPosition(t, new Vector3(), new Vector3(1, 0, 0), 2, 1); // no muId
    expect(reg.activeWindowForMu(7, 2.5)).toBeNull(); // stale id must not resolve
  });
});

describe('TweenRegistry — pool (V3, no per-event allocation)', () => {
  it('reuses pooled records across many finished tweens', () => {
    const reg = new TweenRegistry(4);
    const initialPool = reg.poolSize;
    // Run far more tweens than the pool size, finishing each before the next,
    // so the pool must recycle rather than grow.
    for (let i = 0; i < 100; i++) {
      const t = makePosTarget();
      reg.addPosition(t, new Vector3(), new Vector3(1, 0, 0), i, 0.001);
      reg.onRender(i + 1, 'animated'); // finishes + reaps immediately
    }
    expect(reg.activeCount).toBe(0);
    // The pool never grew because each tween finished before the next started.
    expect(reg.poolSize).toBe(initialPool);
  });

  it('clear() frees all active tweens', () => {
    const reg = new TweenRegistry(8);
    for (let i = 0; i < 5; i++) {
      reg.addPosition(makePosTarget(), new Vector3(), new Vector3(1, 0, 0), 0, 10);
    }
    expect(reg.activeCount).toBe(5);
    reg.clear();
    expect(reg.activeCount).toBe(0);
  });
});
