// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.5 — RollerSpin rate and phase (unit): linear v = 500 mm/s at
 * ρ = 25 mm; radial ω = 25 °/s at r_mid = 1135 mm, ρ = 34.3 mm; stop holds the
 * offset, reset rewinds; repeatU = 4 (offset = frac(−φ·4)); backwards speed;
 * no allocation in the tick.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, Object3D } from 'three';
import { bindRollerSpin, RV_ROLLER_SPIN_KEY, type RollerSpinData, type SpinSurface } from '../src/core/engine/rv-roller-spin';
import { spinMaterial } from './helpers/roller-spin-fixture';

function rig(radial: boolean, rhoMm: number, rMidMm: number, repeatU = 1): { root: Group; mesh: Mesh } {
  const root = new Group();
  const surface = new Object3D(); surface.name = 'Surface';
  const data: RollerSpinData = { radial, groups: [{ group: 0, rhoMm, rMidMm, k: radial ? rMidMm / rhoMm : 1 / rhoMm, count: 1 }], mixed: false, underSurface: 0, unmeasured: 0 };
  surface.userData[RV_ROLLER_SPIN_KEY] = data;
  root.add(surface);
  const mesh = new Mesh(new BoxGeometry(), spinMaterial(true, repeatU));
  root.add(mesh);
  return { root, mesh };
}

const frac = (x: number): number => x - Math.floor(x);

describe('plan-675 §9.5 roller spin rate', () => {
  it('linear: dU/s = v / (2πρ), backwards turns the other way', () => {
    const { root, mesh } = rig(false, 25, 0);
    const s: SpinSurface = { speed: 500, Radial: false };
    const b = bindRollerSpin(root, [mesh], { surfaceOf: () => s, problems: false })!;
    b.tick(0.01);
    const rate = 500 / (2 * Math.PI * 25);
    expect(b.phase).toBeCloseTo(rate * 0.01, 12);
    expect(b.maps[0].offset.x).toBeCloseTo(frac(-rate * 0.01), 12);
    (s as { speed: number }).speed = -500;
    b.tick(0.01);
    expect(b.phase).toBeCloseTo(0, 12);
    expect(b.maps[0].offset.x).toBeCloseTo(0, 12);
    b.dispose();
  });

  it('radial: ω = 25 °/s, r_mid = 1135 mm, ρ = 34.3 mm → dU/s = ω·r/(2πρ)', () => {
    const { root, mesh } = rig(true, 34.3, 1135);
    const s: SpinSurface = { speed: 25, Radial: true };
    const b = bindRollerSpin(root, [mesh], { surfaceOf: () => s, problems: false })!;
    for (let i = 0; i < 60; i++) b.tick(1 / 60);
    const rev = (25 * Math.PI / 180) * 1135 / 34.3 / (2 * Math.PI);
    expect(b.maps[0].offset.x).toBeCloseTo(frac(-rev), 9);
    b.dispose();
  });

  it('stop holds the offset (phase accumulated, no jump on restart); reset → 0', () => {
    const { root, mesh } = rig(false, 25, 0);
    const s = { speed: 300, Radial: false } as SpinSurface;
    const b = bindRollerSpin(root, [mesh], { surfaceOf: () => s, problems: false })!;
    b.tick(0.2);
    const held = b.maps[0].offset.x;
    (s as { speed: number }).speed = 0;
    b.tick(1);
    expect(b.maps[0].offset.x).toBe(held);
    (s as { speed: number }).speed = 300;
    b.tick(0.001);
    expect(Math.abs(b.maps[0].offset.x - held)).toBeLessThan(0.01);
    b.reset();
    expect(b.maps[0].offset.x).toBe(0);
    b.dispose();
  });

  it('R2-4: offset = frac(−φ · repeatU) with repeatU = 4 on every animated map', () => {
    const { root, mesh } = rig(false, 25, 0, 4);
    const s: SpinSurface = { speed: 100, Radial: false };
    const b = bindRollerSpin(root, [mesh], { surfaceOf: () => s, problems: false })!;
    b.tick(0.37);
    const phi = 100 * 0.37 / (2 * Math.PI * 25);
    for (const m of b.maps) expect(m.offset.x).toBeCloseTo(frac(-phi * 4), 10);
    b.dispose();
  });

  it('the tick allocates nothing (no new objects per call)', () => {
    const { root, mesh } = rig(true, 30, 900);
    const s: SpinSurface = { speed: 10, Radial: true };
    const b = bindRollerSpin(root, [mesh], { surfaceOf: () => s, problems: false })!;
    const src = b.tick.toString();
    expect(src).not.toMatch(/new |\[\]|\{\s*\}|\.map\(|\.filter\(|=>/);
    b.dispose();
  });
});
