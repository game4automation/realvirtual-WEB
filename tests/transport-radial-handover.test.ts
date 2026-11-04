// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-655 F6 — an MU circling over a closed ring of four 90° radial curves.
 *
 * Geometry like the Interroll RM 8320 curve (BF 620): inner radius 0.8 m, outer
 * 1.42 m, conveying plane 0.7 m high. Each curve is its own TransportSurface
 * whose node pivot is the arc centre (the transport rotation axis), its AABB
 * the quarter-ring's box — offset from the pivot, as on the real part. The four
 * curves are rotated 0/90/180/270° about the common centre.
 *
 * Asserts the ownership change at every seam (in rotation order), a constant
 * radius and height, no stop, both rotation directions, and that a stopped
 * neighbour holds the MU while a running neighbour PULLS it off a stopped curve
 * (separately driven neighbours).
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const dt = 1 / 60;
const R_IN = 0.8;
const R_OUT = 1.42;
const R_MID = (R_IN + R_OUT) / 2;
const TOP = 0.7;
const CENTER = new Vector3(3, 0, -2);

/** A quarter curve covering the angle range [startDeg, startDeg + 90] (XZ, from +X towards +Z). */
function curve(index: number, speedDegPerSec: number, center = CENTER): RVTransportSurface {
  const node = new Object3D();
  node.name = `Curve${index}`;
  node.position.copy(center).setY(TOP);
  // Rotating about +Y by -θ maps +X towards +Z for positive θ in this XZ convention.
  node.rotation.y = -index * Math.PI / 2;
  node.updateMatrixWorld(true);
  // The quarter ring of curve 0 spans x,z ∈ [0, R_OUT] around the pivot.
  const local = new Vector3(R_OUT / 2, -0.02, R_OUT / 2);
  const aabb = AABB.fromHalfSize(node, new Vector3(R_OUT / 2, 0.02, R_OUT / 2), local);
  const s = new RVTransportSurface(node, aabb);
  s.TransportDirection.set(0, 1, 0); // rotation axis (local up)
  s.Radial = true;
  s.reapplyConfig();
  s.initTransport();
  s.drive = { currentSpeed: speedDegPerSec, name: `drive${index}` } as never;
  return s;
}

function muAt(angleDeg: number, center = CENTER): RVMovingUnit {
  const node = new Object3D();
  node.name = 'Carton';
  const a = angleDeg * Math.PI / 180;
  node.position.set(center.x + R_MID * Math.cos(a), TOP + 0.1, center.z + R_MID * Math.sin(a));
  return new RVMovingUnit(node, 'test-source', new Vector3(0.15, 0.1, 0.2));
}

function ring(speeds: readonly number[]): { manager: RVTransportManager; curves: RVTransportSurface[] } {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  const curves = speeds.map((sp, i) => curve(i, sp));
  manager.surfaces.push(...curves);
  return { manager, curves };
}

/** Angle of the MU around the ring centre in degrees, 0..360. */
function angleOf(mu: RVMovingUnit): number {
  const p = mu.getPosition();
  const deg = Math.atan2(p.z - CENTER.z, p.x - CENTER.x) * 180 / Math.PI;
  return (deg + 360) % 360;
}
function radiusOf(mu: RVMovingUnit): number {
  const p = mu.getPosition();
  return Math.hypot(p.x - CENTER.x, p.z - CENTER.z);
}

/** Sequence of distinct owning surfaces (consecutive duplicates collapsed). */
function runAndTrace(manager: RVTransportManager, mu: RVMovingUnit, ticks: number): {
  owners: string[]; minR: number; maxR: number; minY: number; maxY: number; stalls: number;
} {
  const owners: string[] = [];
  let minR = Infinity; let maxR = -Infinity; let minY = Infinity; let maxY = -Infinity;
  let stalls = 0;
  let last = angleOf(mu);
  for (let i = 0; i < ticks; i++) {
    manager.update(dt);
    const owner = mu.currentSurface?.node.name ?? '-';
    if (owners[owners.length - 1] !== owner) owners.push(owner);
    const r = radiusOf(mu);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    const y = mu.getPosition().y;
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    const a = angleOf(mu);
    if (Math.abs(a - last) < 1e-6) stalls++;
    last = a;
  }
  return { owners, minR, maxR, minY, maxY, stalls };
}

describe('plan-655 F6 — radial handover around a ring of four curves', () => {
  it('keeps an MU circling (positive speed = clockwise seen from above, decreasing angle): ownership changes at every seam, in order, radius + height constant, never stops', () => {
    const { manager } = ring([45, 45, 45, 45]);
    const mu = muAt(45);
    manager.mus.push(mu);
    // 45°/s → 8 s per turn; 2 full turns + a bit.
    const t = runAndTrace(manager, mu, Math.round(17 / dt));
    expect(t.stalls).toBe(0);
    expect(t.maxR - t.minR).toBeLessThan(0.001);
    expect(t.maxY - t.minY).toBeLessThan(0.001);
    // Collapse to the visiting order and check it is the ring order, repeated.
    expect(t.owners.length).toBeGreaterThanOrEqual(9);
    const idx = t.owners.map((n) => Number(n.replace('Curve', '')));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe((idx[i - 1] + 3) % 4);
  });

  it('negative speed circles the other way round (increasing angle, ring order reversed)', () => {
    const { manager } = ring([-45, -45, -45, -45]);
    const mu = muAt(45);
    manager.mus.push(mu);
    const t = runAndTrace(manager, mu, Math.round(17 / dt));
    expect(t.stalls).toBe(0);
    expect(t.maxR - t.minR).toBeLessThan(0.001);
    const idx = t.owners.map((n) => Number(n.replace('Curve', '')));
    expect(idx.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe((idx[i - 1] + 1) % 4);
  });

  it('a STOPPED next curve holds the MU at the seam (separately driven neighbours)', () => {
    const { manager } = ring([-45, 0, -45, -45]);
    const mu = muAt(45);
    manager.mus.push(mu);
    runAndTrace(manager, mu, Math.round(6 / dt));
    // It got onto curve 1 (90..180°) and stays inside it — never reaches curve 2.
    const a = angleOf(mu);
    expect(a).toBeGreaterThan(80);
    expect(a).toBeLessThan(180);
    expect(mu.currentSurface?.node.name).toBe('Curve1');
  });

  it('a RUNNING next curve pulls the MU off a STOPPED curve at the seam', () => {
    // MU straddles the 90° seam: curve 0 (0..90°) stopped, curve 1 running.
    const { manager, curves } = ring([0, -45, -45, -45]);
    const mu = muAt(88);
    mu.currentSurface = curves[0];
    manager.mus.push(mu);
    const before = angleOf(mu);
    runAndTrace(manager, mu, Math.round(1 / dt));
    expect(angleOf(mu)).toBeGreaterThan(before + 20);
  });
});
