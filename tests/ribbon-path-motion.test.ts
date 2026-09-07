// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.3 / plan-460 §9.2 — a `RibbonPath` in motion: roller speed,
 * direction, and the dirty gate that decides when the geometry is rebuilt at all.
 *
 * Since plan-460 the web is moved by a rotational drive on a ROLLER, so each
 * fixture marks one roller `driven` and the tests use `h.step(dt)` — the
 * production order (drives first, then the web).
 *
 * The dirty-gate tests are the load-bearing ones. Two of them exist because the
 * SOL review rejected a scalar signature: a compensating pose change and a
 * rotation about the roller's OWN axis are the two cases a checksum gets wrong
 * in opposite directions.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, type RollerSpec } from './ribbon-fixture';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';

/** Unwinder — three idlers — rewinder, all Left, on one Z axis. */
const LINE: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 250, winder: true, driven: true },
  { name: 'Idler_01', xMm: 1000, yMm: 400, radiusMm: 60 },
  { name: 'Nip', xMm: 2000, yMm: 400, radiusMm: 80 },
  { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 200, winder: true },
];

/** Two equal rollers 1 m apart — the analytic case (path length exactly 1 m). */
const PAIR: RollerSpec[] = [
  { name: 'A', xMm: 0, yMm: 0, radiusMm: 100 },
  { name: 'B', xMm: 1000, yMm: 0, radiusMm: 100, driven: true },
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('RibbonPath motion', () => {
  it('builds an open path over four rollers and registers with the manager', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    expect(path.isActive).toBe(true);
    expect(path.rollers).toHaveLength(4);
    expect(h.ribbonManager.size).toBe(1);
    // Longer than the straight 3 m span, because of the wraps and the offsets.
    expect(path.lengthMm).toBeGreaterThan(3000);
    expect(path.band).not.toBeNull();
    expect(h.path.children).toContain(path.band!.mesh);
  });

  it('a follower rotates by v/r * dt per fixed step; the DRIVEN roller is not turned by the path', () => {
    const h = ribbonHarness(PAIR);
    const path = h.buildPath();
    h.drive.jog(500);
    const dt = 1 / 60;
    h.step(dt);
    // omega = v / r; the half caliper rides on the CONTACT radius and belongs
    // to the path geometry, not to how fast a roller spins.
    const expected = (500 / 100) * dt;
    expect(path.rollers[0].angle).toBeCloseTo(expected, 6);
    // B carries the drive: its own drive turns the node, so the path must keep
    // its hands off it (turning it too would double the rotation).
    expect(path.rollers[1].isDriven).toBe(true);
    expect(path.rollers[1].angle).toBe(0);
    expect(path.rollers[1].surfaceSpeedMmPerS).toBeCloseTo(500, 6);
  });

  it('reversing the drive reverses roller rotation and texture scroll', () => {
    const h = ribbonHarness(PAIR);
    const path = h.buildPath();
    const dt = 1 / 60;

    h.drive.jog(500);
    h.step(dt);
    const forwardAngle = path.rollers[0].angle;
    const forwardOffset = path.band!.map!.offset.x;
    expect(forwardAngle).toBeGreaterThan(0);

    h.drive.jog(-500);
    h.step(dt);
    expect(path.rollers[0].angle).toBeCloseTo(0, 6);
    // The offset wraps into [0,1), so compare the un-wrapped delta.
    const back = path.band!.map!.offset.x;
    expect(back).not.toBeCloseTo(forwardOffset, 6);
  });

  it('a smaller roller spins faster than a larger one at the same web speed', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    h.drive.jog(1000);
    h.step(1 / 60);
    const idler = path.rollers[1];   // r = 60
    const nip = path.rollers[2];     // r = 80
    expect(idler.angle).toBeGreaterThan(nip.angle);
    expect(idler.angle / nip.angle).toBeCloseTo(80.05 / 60.05, 3);
  });

  it('does not rewrite the sample table while no winder radius / transform changed', () => {
    const h = ribbonHarness(PAIR);
    const path = h.buildPath();
    const write = vi.spyOn(path.band!, 'write');
    h.drive.jog(500);
    for (let i = 0; i < 10; i++) h.step(1 / 60);
    expect(write).not.toHaveBeenCalled();
  });

  it('moving a roller node rebuilds the path (transform signature)', () => {
    const h = ribbonHarness(PAIR);
    const path = h.buildPath();
    const write = vi.spyOn(path.band!, 'write');
    const before = path.lengthMm;

    h.nodes.get('B')!.position.x += 500 / MM_TO_METERS;
    h.scene.updateMatrixWorld(true);
    h.ribbonManager.update(1 / 60);

    expect(write).toHaveBeenCalledTimes(1);
    expect(path.lengthMm).toBeCloseTo(before + 500, 3);
  });

  it('compensating transform change (same element sum, different pose) still rebuilds', () => {
    const h = ribbonHarness(PAIR);
    const path = h.buildPath();
    const write = vi.spyOn(path.band!, 'write');

    // x + d, y - d: every scalar CHECKSUM of the pose is unchanged, the pose is
    // not. This is the case SOL round-2 finding 5 is about.
    const d = 300 / MM_TO_METERS;
    const b = h.nodes.get('B')!;
    b.position.x += d;
    b.position.y -= d;
    h.scene.updateMatrixWorld(true);
    h.ribbonManager.update(1 / 60);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('rotating a roller about a non-web axis or scaling it rebuilds; rotating about its own axis does not', () => {
    const h = ribbonHarness(PAIR);
    const path = h.buildPath();
    const write = vi.spyOn(path.band!, 'write');
    const b = h.nodes.get('B')!;

    // Rotating about the WEB axis (Z here) is exactly what a running roller
    // does every tick — it must never trigger a rebuild.
    b.rotation.z += 0.7;
    h.scene.updateMatrixWorld(true);
    h.ribbonManager.update(1 / 60);
    expect(write).not.toHaveBeenCalled();

    // Tilting it out of the plane is a real geometry change.
    b.rotation.x += 0.2;
    h.scene.updateMatrixWorld(true);
    h.ribbonManager.update(1 / 60);
    expect(write).toHaveBeenCalledTimes(1);

    // …and so is scaling it. Both changes land in ONE tick, so they cost one
    // rebuild between them — the gate answers "did anything move", not "how
    // many things moved".
    b.rotation.x -= 0.2;
    b.scale.setScalar(1.5);
    h.scene.updateMatrixWorld(true);
    h.ribbonManager.update(1 / 60);
    expect(write).toHaveBeenCalledTimes(2);

    // And a settled scene rebuilds nothing at all.
    h.ribbonManager.update(1 / 60);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('parent with non-uniform scale: measured radius is in local mm', () => {
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 0 },        // 0 => measure it
      { name: 'B', xMm: 1000, yMm: 0, radiusMm: 100 },
    ]);
    // The fixture builds A's mesh from `radiusMm: 0`, so it is degenerate on
    // purpose: the component must fall back rather than emit a NaN path. The
    // scaled root is there so a world-space measurement would be visibly wrong.
    h.root.scale.set(3, 3, 1);
    h.scene.updateMatrixWorld(true);

    const path = h.buildPath();
    // A's mesh was built for radiusMm 0 -> degenerate; the component falls back
    // to 50 mm and warns rather than producing a NaN path.
    expect(path.rollers[0].radiusMm).toBeCloseTo(50, 6);
    // B's authored radius is untouched by the parent scale.
    expect(path.rollers[1].radiusMm).toBeCloseTo(100, 6);
  });

  it('a measured roller reports its LOCAL radius under a scaled parent', () => {
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 120 },
      { name: 'B', xMm: 1000, yMm: 0, radiusMm: 120 },
    ]);
    h.root.scale.set(4, 4, 1);
    h.scene.updateMatrixWorld(true);
    // Re-declare A with RadiusMm 0 so it has to measure its own 120 mm mesh.
    const a = h.nodes.get('A')!;
    a.userData.realvirtual = undefined;
    const path = h.buildPath();
    expect(path.rollers[0].radiusMm).toBeCloseTo(120, 3);
  });
});

// ── Slit strips (plan-459 /fix 2026-09-05) ───────────────────────────────
import { transformRef as slitRef } from './ribbon-fixture';

const SLITTER: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 1200, radiusMm: 400, winder: true },
  { name: 'Idler_01', xMm: 1000, yMm: 1700, radiusMm: 200, extras: { RibbonSide: 'Auto' } },
  { name: 'Nip', xMm: 2000, yMm: 1200, radiusMm: 190, extras: { RibbonSide: 'Auto' } },
  { name: 'Rewinder_A', xMm: 3200, yMm: 1500, radiusMm: 90, winder: true },
  { name: 'Rewinder_B', xMm: 3200, yMm: 700, radiusMm: 90, winder: true },
];

/**
 * The same slitter with both rewinders BELOW the nip, so the two strips take the
 * same turn there and `RibbonSide: Auto` resolves every shared roller the same
 * way for both — the physically sound layout, and the one the slit-point
 * assertions need. (`SLITTER` above straddles the nip on purpose; that is the
 * shared-side conflict `ribbon-sections.test.ts` asserts the warning for.)
 *
 * `Rewinder_B` is deliberately TWO METRES further downstream than `Rewinder_A`:
 * the two strips must have clearly different TOTAL lengths, because that is what
 * a `length / (count - 1)` sample grid would round differently and an absolute
 * `i * step` grid must not.
 */
const SAME_TURN_SLITTER: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 1200, radiusMm: 400, winder: true },
  { name: 'Idler_01', xMm: 1000, yMm: 1700, radiusMm: 200, extras: { RibbonSide: 'Auto' } },
  { name: 'Nip', xMm: 2000, yMm: 1200, radiusMm: 190, extras: { RibbonSide: 'Auto' } },
  { name: 'Rewinder_A', xMm: 3200, yMm: 700, radiusMm: 90, winder: true },
  { name: 'Rewinder_B', xMm: 5200, yMm: 700, radiusMm: 90, winder: true },
];

describe('slit strips', () => {
  it('draws the full web before the slit roller and the strip after it, with the second strip hiding the shared part', () => {
    const h = ribbonHarness(SLITTER);
    const common = ['Unwinder', 'Idler_01', 'Nip'];
    const a = h.addPath('Ribbon_A', [...common, 'Rewinder_A'], { RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: slitRef('Root/Nip') });
    const b = h.addPath('Ribbon_B', [...common, 'Rewinder_B'], { RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: slitRef('Root/Nip') });

    expect(a.slitRoller).toBe(a.rollers[2]);
    expect(a.slitSampleIndex).toBeGreaterThan(0);
    expect(a.slitSampleIndex).toBeLessThan(a.band!.sampleCount - 1);
    expect(h.ribbonManager.groups).toHaveLength(1);
    expect(a.drawsPreSlit).toBe(true);
    expect(b.drawsPreSlit).toBe(false);

    // Width across the band, before and after the slit sample.
    const pos = a.band!.mesh.geometry.getAttribute('position');
    const width = (i: number) => Math.hypot(
      pos.getX(i * 2 + 1) - pos.getX(i * 2), pos.getY(i * 2 + 1) - pos.getY(i * 2), pos.getZ(i * 2 + 1) - pos.getZ(i * 2),
    ) * MM_TO_METERS;
    expect(width(0)).toBeCloseTo(860, 3);
    expect(width(a.slitSampleIndex)).toBeCloseTo(400, 3);

    // B starts drawing at its slit sample; A draws everything.
    expect(a.band!.mesh.geometry.drawRange.start).toBe(0);
    expect(b.band!.mesh.geometry.drawRange.start).toBe(b.slitSampleIndex * 6);
  });

  it('cuts at the ARRIVAL tangent point of the slit roller, so every strip reports the same slit point', () => {
    const h = ribbonHarness(SAME_TURN_SLITTER);
    const common = ['Unwinder', 'Idler_01', 'Nip'];
    const opts = {
      RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: slitRef('Root/Nip'), SamplesPerMeter: 48,
    };
    const a = h.addPath('Ribbon_A', [...common, 'Rewinder_A'], opts);
    const b = h.addPath('Ribbon_B', [...common, 'Rewinder_B'], opts);

    // mm — distance of the band centre line at sample `i` from the nip centre.
    // The contact radius is `radius + thickness / 2`, so a sample ON the wrap arc
    // sits at exactly that distance and one on the incoming straight run further out.
    const CONTACT_MM = 190 + 0.1 / 2;
    const nip = h.nodes.get('Nip')!.position;
    const distAt = (path: typeof a, i: number): number => {
      const pos = path.band!.mesh.geometry.getAttribute('position');
      return Math.hypot(
        (pos.getX(2 * i) + pos.getX(2 * i + 1)) / 2 - nip.x,
        (pos.getY(2 * i) + pos.getY(2 * i + 1)) / 2 - nip.y,
      ) * MM_TO_METERS;
    };

    // The sample grid is absolute (`i * step`), so the index rounds to within
    // half a step of the true tangent point — up to ~0.3 mm of radial slack on a
    // 190 mm roller, which is what the tolerance below is.
    for (const path of [a, b]) {
      const s = path.slitSampleIndex;
      expect(s).toBeGreaterThan(10);
      // The slit sample is at the roller — the arc has begun…
      expect(Math.abs(distAt(path, s) - CONTACT_MM)).toBeLessThan(0.5);
      expect(Math.abs(distAt(path, s + 1) - CONTACT_MM)).toBeLessThan(0.5);
      // …and ten samples earlier the web is still on the straight run towards it,
      // which is what makes this the arc START and not the arc END.
      expect(distAt(path, s - 10)).toBeGreaterThan(CONTACT_MM + 20);
    }

    // The two strips have clearly different TOTAL lengths (Rewinder_B is 2 m
    // further downstream), so a `length / (count - 1)` grid would give them
    // different sample positions for the same physical point. On the absolute
    // grid the shared part is sampled identically: same index…
    expect(a.lengthMm).not.toBeCloseTo(b.lengthMm, 0);
    expect(a.band!.sampleCount).not.toBe(b.band!.sampleCount);
    expect(a.slitSampleIndex).toBe(b.slitSampleIndex);

    // …and the same point in space, to within float noise rather than a sample.
    const midAt = (path: typeof a, i: number): [number, number, number] => {
      const pos = path.band!.mesh.geometry.getAttribute('position');
      return [
        ((pos.getX(2 * i) + pos.getX(2 * i + 1)) / 2) * MM_TO_METERS,
        ((pos.getY(2 * i) + pos.getY(2 * i + 1)) / 2) * MM_TO_METERS,
        ((pos.getZ(2 * i) + pos.getZ(2 * i + 1)) / 2) * MM_TO_METERS,
      ];
    };
    const dist3 = (p: [number, number, number], q: [number, number, number]): number =>
      Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    expect(dist3(midAt(a, a.slitSampleIndex), midAt(b, b.slitSampleIndex))).toBeLessThan(0.01);
    // Every shared sample, not only the slit one — the whole pre-slit web.
    for (let i = 0; i <= a.slitSampleIndex; i++) {
      expect(dist3(midAt(a, i), midAt(b, i))).toBeLessThan(0.01);
    }
    // …and they wrap the shared nip on the same side, so nothing warns.
    expect(a.resolvedSideAt(2)).toBe(b.resolvedSideAt(2));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('opposite');
  });

  it('a path that outgrows its sample buffer coarsens the GRID and still samples the whole web', () => {
    // 200 m of web at the default 64 samples/m wants 12 800 samples and the
    // buffer is capped at 4096 — an overflow that PERSISTS after the one-shot
    // halving to 32/m (which still wants 6400). Truncating the count — what the
    // first absolute-grid version did — keeps the interior samples one step
    // apart and jumps only the LAST one to the path end, so everything past
    // sample `capacity - 2` collapses into a straight run and the slit, at 195 m,
    // clamps to the end of the web.
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Cutter', xMm: 195_000, yMm: 800, radiusMm: 100, extras: { RibbonSide: 'Auto' } },
      { name: 'Rewinder', xMm: 200_000, yMm: 0, radiusMm: 400, winder: true },
    ]);
    const path = h.buildPath({
      RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: slitRef('Root/Cutter'),
    });
    expect(path.isActive).toBe(true);
    expect(path.lengthMm).toBeGreaterThan(199_000);

    // The grid was coarsened by an INTEGER factor of the requested 1000/64 mm,
    // and `sampleStepMm` reports the one actually used.
    const requested = 1000 / 64;
    expect(path.sampleStepMm).toBeGreaterThan(requested);
    expect(path.sampleStepMm / requested).toBeCloseTo(Math.round(path.sampleStepMm / requested), 9);

    // The whole web is covered: no gap between consecutive band samples is
    // bigger than the step it reports.
    const band = path.band!;
    const pos = band.mesh.geometry.getAttribute('position');
    // The CENTRE line: the two edge vertices step sideways at the slit, where
    // the band narrows from the full web to this strip.
    const mid = (i: number, get: 'getX' | 'getY' | 'getZ'): number =>
      (pos[get](i * 2) + pos[get](i * 2 + 1)) / 2;
    let maxGapMm = 0;
    for (let i = 1; i < band.sampleCount; i++) {
      maxGapMm = Math.max(maxGapMm, Math.hypot(
        mid(i, 'getX') - mid(i - 1, 'getX'),
        mid(i, 'getY') - mid(i - 1, 'getY'),
        mid(i, 'getZ') - mid(i - 1, 'getZ'),
      ) * MM_TO_METERS);
    }
    expect(maxGapMm).toBeLessThanOrEqual(path.sampleStepMm * 1.001);

    // …and the slit boundary is strictly INSIDE the web, not clamped to its end.
    expect(path.slitSampleIndex).toBeGreaterThan(0);
    expect(path.slitSampleIndex).toBeLessThan(band.sampleCount - 1);
    // It is where the web meets the cutter, i.e. at ~195 m of a ~200 m path.
    expect(path.slitSampleIndex * path.sampleStepMm).toBeGreaterThan(190_000);
  });

  it('ignores a slit on an end roller or without FullWidthMm, with a warning', () => {
    const h = ribbonHarness(SLITTER);
    const end = h.addPath('Ribbon_A', ['Unwinder', 'Idler_01', 'Nip', 'Rewinder_A'], { FullWidthMm: 860, SlitAtRoller: slitRef('Root/Unwinder') });
    expect(end.slitRoller).toBeNull();
    const noWidth = h.addPath('Ribbon_B', ['Unwinder', 'Idler_01', 'Nip', 'Rewinder_B'], { SlitAtRoller: slitRef('Root/Nip') });
    expect(noWidth.slitRoller).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
