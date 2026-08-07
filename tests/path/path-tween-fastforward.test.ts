// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.8 — the `path` tween flavour (Phase 3), FastForward regression
 * anchor: `TweenRegistry.onRender(simNow, 'fastforward')` writes NO transform
 * for a still-running path record (No-Write, identical to the other tween
 * flavours), and `settle()` releases cleanly — the end state is the ARC-LENGTH
 * end position of the path, not a chord lerp. This suite also anchors the
 * exhaustive-switch extension of the tween kinds (a path record must never be
 * mis-handled by the pos/drive branches).
 *
 * Headless: a real `RVPath` (quarter arc — sampling the arc is DISTINGUISHABLE
 * from lerping the chord) against a recording target; no DOM/GLB/runner.
 */

import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TweenRegistry } from '../../src/core/material-flow/tween-registry';
import { ArcSegment, RVPath } from '../../src/core/engine/rv-path';

/** Quarter circle in the ground plane: radius 10 m, (10,0,0) → (0,0,10). */
function quarterArcPath(): RVPath {
  return new RVPath('Arc', [
    new ArcSegment(new Vector3(0, 0, 0), 10, 0, 90, false, 'XZ'),
  ]);
}

/** A target that records every position/quaternion write (clones — safe). */
function makeTarget(withQuaternion = true): {
  positions: Vector3[];
  quats: Quaternion[];
  setPosition(v: Vector3): void;
  setQuaternion?(q: Quaternion): void;
} {
  const positions: Vector3[] = [];
  const quats: Quaternion[] = [];
  const t: ReturnType<typeof makeTarget> = {
    positions,
    quats,
    setPosition(v: Vector3): void { positions.push(v.clone()); },
  };
  if (withQuaternion) {
    t.setQuaternion = (q: Quaternion): void => { quats.push(q.clone()); };
  }
  return t;
}

describe('path tween — FastForward No-Write + settle end state (§9.8)', () => {
  it('fastforward mid-window: NO transform write, the record stays active', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget();
    const h = reg.addPath(path, target, 0, path.length, 0, 10);
    expect(h).toBeGreaterThanOrEqual(0);

    reg.onRender(5, 'fastforward'); // mid-window — still running
    expect(target.positions.length).toBe(0); // No-Write (plan-268 §9.8)
    expect(target.quats.length).toBe(0);
    expect(reg.activeCount).toBe(1);
  });

  it('settle() after a fastforward run writes the ARC-LENGTH end position and reaps', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget();
    reg.addPath(path, target, 0, path.length, 0, 10);

    reg.onRender(5, 'fastforward');   // No-Write
    reg.settle(12);                   // past t1 — unconditional exact write + reap

    expect(target.positions.length).toBe(1);
    const end = path.getAbsPosition(path.length, new Vector3()); // (0,0,10)
    expect(target.positions[0].distanceTo(end)).toBeLessThan(1e-9);
    expect(reg.activeCount).toBe(0);  // released cleanly
  });

  it('a path tween that FINISHES during a fastforward pass still writes its final value', () => {
    // Parity with the pos/drive flavours: the final write on reap keeps every
    // finished part at its correct end position (clean FF exit).
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget();
    reg.addPath(path, target, 0, path.length, 0, 10);

    reg.onRender(11, 'fastforward'); // past t1 in ONE pass
    expect(target.positions.length).toBe(1);
    const end = path.getAbsPosition(path.length, new Vector3());
    expect(target.positions[0].distanceTo(end)).toBeLessThan(1e-9);
    expect(reg.activeCount).toBe(0);
  });

  it('animated render samples the ARC (arc-length address), not the chord', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget();
    reg.addPath(path, target, 0, path.length, 0, 10);

    reg.onRender(5, 'animated'); // half the window → s = L/2 (arc midpoint, 45°)
    expect(target.positions.length).toBe(1);
    const arcMid = path.getAbsPosition(path.length / 2, new Vector3()); // ≈ (7.07,0,7.07)
    expect(target.positions[0].distanceTo(arcMid)).toBeLessThan(1e-9);
    // A straight pos-lerp would land on the CHORD midpoint (5,0,5) — clearly off.
    const chordMid = new Vector3(5, 0, 5);
    expect(target.positions[0].distanceTo(chordMid)).toBeGreaterThan(1);
  });

  it('orients the target along the travel tangent (optional setQuaternion)', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget(true);
    reg.addPath(path, target, 0, path.length, 0, 10);

    reg.onRender(5, 'animated');
    expect(target.quats.length).toBe(1);
    // lookRotation(tangent, up): local +Z maps onto the world tangent at s.
    const tangent = path.getAbsDirection(path.length / 2, new Vector3());
    const fwd = new Vector3(0, 0, 1).applyQuaternion(target.quats[0]);
    expect(fwd.distanceTo(tangent)).toBeLessThan(1e-6);
  });

  it('a position-only target (no setQuaternion) works — translation only, no crash', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget(false);
    reg.addPath(path, target, 0, path.length, 0, 10);

    reg.onRender(5, 'animated');
    expect(target.positions.length).toBe(1);
    expect(target.quats.length).toBe(0);
  });

  it('interpolates the arc ADDRESS fromS→toS (partial legs, e.g. a mid-path start)', () => {
    const path = quarterArcPath();
    const L = path.length;
    const reg = new TweenRegistry(4);
    const target = makeTarget();
    reg.addPath(path, target, L / 2, L, 0, 10); // second half of the arc only

    reg.onRender(5, 'animated'); // half window → s = 3/4 L
    expect(target.positions.length).toBe(1);
    const expected = path.getAbsPosition((3 * L) / 4, new Vector3());
    expect(target.positions[0].distanceTo(expected)).toBeLessThan(1e-9);
  });

  it('V4 guards: null sampler / null target → handle −1, nothing registered', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    expect(reg.addPath(null, makeTarget(), 0, 1, 0, 1)).toBe(-1);
    expect(reg.addPath(path, null, 0, 1, 0, 1)).toBe(-1);
    expect(reg.activeCount).toBe(0);
  });

  it('cancel frees the path record — no further writes', () => {
    const path = quarterArcPath();
    const reg = new TweenRegistry(4);
    const target = makeTarget();
    const h = reg.addPath(path, target, 0, path.length, 0, 10);

    reg.cancel(h);
    expect(reg.activeCount).toBe(0);
    reg.onRender(5, 'animated');
    expect(target.positions.length).toBe(0);
  });
});
