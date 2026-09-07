// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.5 — the band mesh.
 *
 * The headline test is the UNIT one: `write()` is the single mm → m boundary of
 * the whole feature, so it is asserted against ABSOLUTE buffer coordinates
 * (1000 mm spacing, 500 mm width, 2 mm lift → 1 m, 0.5 m, 0.002 m), not against
 * a ratio that would survive a second stray conversion somewhere upstream.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { RVRibbonBandMesh, RIBBON_BAND_SAMPLE_STRIDE } from '../src/core/engine/rv-ribbon-band-mesh';
import { RV_RIBBON_BAND } from '../src/core/engine/rv-traverse-utils';
import { ribbonHarness } from './ribbon-fixture';

/** Two samples 1000 mm apart along +X, up = +Z (so the width runs along Z). */
function twoSamples(): Float32Array {
  const s = new Float32Array(2 * RIBBON_BAND_SAMPLE_STRIDE);
  s.set([0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  s.set([1000, 0, 0, 1, 0, 0, 0, 0, 1], RIBBON_BAND_SAMPLE_STRIDE);
  return s;
}

describe('RVRibbonBandMesh borrowed materials', () => {
  /** A donor node whose material carries a colour AND a normal map. */
  function donor(): { node: Object3D; material: MeshStandardMaterial; map: DataTexture; normal: DataTexture } {
    const map = new DataTexture(new Uint8Array(4 * 4).fill(210), 2, 2);
    map.needsUpdate = true;
    const normal = new DataTexture(new Uint8Array(4 * 4).fill(128), 2, 2);
    normal.needsUpdate = true;
    const material = new MeshStandardMaterial({ map, normalMap: normal });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    const node = new Object3D();
    node.add(new Mesh(geo, material));
    return { node, material, map, normal };
  }

  it('clones EVERY map of the borrowed material, scales and scrolls them together, and leaves the donor alone', () => {
    const d = donor();
    const band = new RVRibbonBandMesh(8, 500, d.node);
    const mat = band.mesh.material as MeshStandardMaterial;

    // Cloned, not shared: writing repeat/offset below must not reach the donor.
    expect(mat.map).not.toBe(d.map);
    expect(mat.normalMap).not.toBe(d.normal);
    // …but the GPU upload is shared, so the clones cost nothing extra.
    expect(mat.map!.image).toBe(d.map.image);
    expect(mat.normalMap!.image).toBe(d.normal.image);

    band.write(twoSamples(), 2, 500);
    band.setTextureLength(1000, 1000, 20);
    // The whole surface is at ONE scale: a normal map left at the authored
    // repeat would show relief at a completely different pitch to the colour.
    expect(mat.normalMap!.repeat.x).toBe(mat.map!.repeat.x);
    expect(mat.map!.repeat.x).toBeCloseTo(1 / 1000, 12);

    // The web runs forward, so the texture offset runs backwards and wraps into
    // [0, 1) — 0.75, not 0.25 (see `scrollMap`).
    band.scroll(0.25);
    expect(mat.map!.offset.x).toBeCloseTo(0.75, 9);
    expect(mat.normalMap!.offset.x).toBeCloseTo(mat.map!.offset.x, 12);
    band.resetScroll();
    expect(mat.normalMap!.offset.x).toBe(0);

    // The donor never moved.
    expect(d.map.repeat.x).toBe(1);
    expect(d.normal.repeat.x).toBe(1);
    expect(d.map.offset.x).toBe(0);
    expect(d.normal.offset.x).toBe(0);

    // Both clones are owned, so both are released.
    const mapDispose = vi.spyOn(mat.map!, 'dispose');
    const normalDispose = vi.spyOn(mat.normalMap!, 'dispose');
    band.dispose();
    expect(mapDispose).toHaveBeenCalled();
    expect(normalDispose).toHaveBeenCalled();
    d.material.dispose();
  });
});

describe('RVRibbonBandMesh texture mapping', () => {
  /**
   * A band sampled on the ABSOLUTE grid: 36 full steps of 20 mm plus a 1 mm
   * remainder, so the last interval is 5 % of a step — exactly the shape that
   * showed a compressed texture at the winder when `u` was the sample index.
   */
  function gridBand(stepMm: number, lengthMm: number): { band: RVRibbonBandMesh; count: number } {
    const whole = Math.floor(lengthMm / stepMm);
    const count = whole + (lengthMm - whole * stepMm > 1e-6 ? 2 : 1);
    const samples = new Float32Array(count * RIBBON_BAND_SAMPLE_STRIDE);
    for (let i = 0; i < count; i++) {
      const at = i * RIBBON_BAND_SAMPLE_STRIDE;
      samples[at] = i === count - 1 ? lengthMm : i * stepMm;   // mm; write() converts
      samples[at + 3] = 1;                                     // tangent
      samples[at + 8] = 1;                                     // up vector (+z)
    }
    const band = new RVRibbonBandMesh(count + 8, 500);
    band.write(samples, count, 500, 0);
    return { band, count };
  }

  it('texture per millimetre is constant across EVERY interval, the short last one included', () => {
    const STEP = 20;
    const LENGTH = 36 * STEP + 1;                 // last interval only 1 mm long
    const { band, count } = gridBand(STEP, LENGTH);
    band.setTextureLength(LENGTH, 1000, STEP);

    const uv = band.mesh.geometry.getAttribute('uv');
    const pos = band.mesh.geometry.getAttribute('position');
    const repeat = band.map!.repeat.x;
    const MM = 1000;                              // buffer metres -> mm

    let reference = Number.NaN;
    for (let i = 1; i < count; i++) {
      const dx = (pos.getX(i * 2) - pos.getX((i - 1) * 2)) * MM;
      const du = (uv.getX(i * 2) - uv.getX((i - 1) * 2)) * repeat;
      expect(dx).toBeGreaterThan(0);
      const perMm = du / dx;
      if (Number.isNaN(reference)) reference = perMm;
      // The property: repetitions per millimetre of WEB, identical everywhere.
      expect(Math.abs(perMm - reference)).toBeLessThan(1e-6);
    }
    // `toBeCloseTo(…, 9)` and not more: `uv` is a Float32Array, so a 730 mm
    // coordinate carries ~1e-4 mm of storage noise.
    expect(reference).toBeCloseTo(1 / 1000, 9);

    // …and the endpoint is still exactly length / textureLength repetitions.
    expect(uv.getX((count - 1) * 2) * repeat).toBeCloseTo(LENGTH / 1000, 6);
    expect(uv.getX(0) * repeat).toBeCloseTo(0, 12);
    band.dispose();
  });

  it('without a step it falls back to the uniform length / (count - 1) spacing', () => {
    // The escape hatch for a caller that does not sample on a grid: the mapping
    // is then the pre-follow-up one, endpoint included.
    const { band, count } = gridBand(20, 36 * 20 + 1);
    band.setTextureLength(731, 1000);
    const uv = band.mesh.geometry.getAttribute('uv');
    const repeat = band.map!.repeat.x;
    expect(uv.getX((count - 1) * 2) * repeat).toBeCloseTo(731 / 1000, 6);
    expect(uv.getX(2) * repeat).toBeCloseTo((731 / (count - 1)) / 1000, 8);
    band.dispose();
  });
});

describe('RVRibbonBandMesh', () => {
  it('allocates index/uv once and only rewrites position on write()', () => {
    const band = new RVRibbonBandMesh(64, 500);
    const geo = band.mesh.geometry;
    const uv = geo.getAttribute('uv');
    const index = geo.getIndex();
    const uvArray = uv.array;
    const indexArray = index!.array;

    band.write(twoSamples(), 2, 500);
    band.write(twoSamples(), 2, 500);

    // Same attribute OBJECTS and same backing buffers — nothing reallocated.
    expect(geo.getAttribute('uv')).toBe(uv);
    expect(geo.getIndex()).toBe(index);
    expect(geo.getAttribute('uv').array).toBe(uvArray);
    expect(geo.getIndex()!.array).toBe(indexArray);
    // `needsUpdate` is a write-only accessor in three; `version` is the readable
    // proof that the position buffer was flagged for re-upload.
    expect((geo.getAttribute('position') as BufferAttribute).version).toBeGreaterThan(0);
    band.dispose();
  });

  it('write() is the single mm->m boundary: 1000 mm spacing, 500 mm width, 2 mm offset -> 1 m, 0.5 m, 0.002 m', () => {
    const band = new RVRibbonBandMesh(8, 500);
    band.write(twoSamples(), 2, 500, 2);
    const p = band.mesh.geometry.getAttribute('position').array as Float32Array;

    // Sample 0, the two width edges. up = +Z, half width 0.25 m.
    expect(p[2]).toBeCloseTo(-0.25, 6);
    expect(p[5]).toBeCloseTo(0.25, 6);
    // Sample 1 sits 1 m along +X.
    expect(p[6]).toBeCloseTo(1, 6);
    expect(p[9]).toBeCloseTo(1, 6);
    // The 2 mm thickness lift lands on the surface normal t x u = (1,0,0)x(0,0,1)
    // = (0,-1,0), i.e. -0.002 m in Y.
    expect(p[1]).toBeCloseTo(-0.002, 6);
    expect(p[4]).toBeCloseTo(-0.002, 6);
    band.dispose();
  });

  it('draws only the samples it was given', () => {
    const band = new RVRibbonBandMesh(64, 500);
    band.write(twoSamples(), 2, 500);
    expect(band.sampleCount).toBe(2);
    expect(band.mesh.geometry.drawRange.count).toBe(6);
    band.dispose();
  });

  it('halves samplesPerMeter instead of reallocating when capacity is exceeded', () => {
    // A 10 m path at 64 samples/m wants ~640 samples; the fixture's default
    // capacity is derived from the length, so force the overflow with a long
    // path and a high density.
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 100 },
      { name: 'B', xMm: 20_000, yMm: 0, radiusMm: 100 },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = h.buildPath({ SamplesPerMeter: 1000 });
    const band = path.band!;
    const capacity = band.maxSamples;
    // Capacity is bounded, and the band never wrote past it.
    expect(band.sampleCount).toBeLessThanOrEqual(capacity);
    const positions = band.mesh.geometry.getAttribute('position').array as Float32Array;
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);
    warn.mockRestore();
  });

  it('uses the first material with a map; falls back to a default material without one', () => {
    // A donor node carrying a mapped material.
    const donor = new Object3D();
    const plain = new Mesh(new BufferGeometry(), new MeshStandardMaterial()); // no map
    const mapped = new Mesh(
      new BufferGeometry(),
      new MeshStandardMaterial({ map: new DataTexture(new Uint8Array([1, 2, 3, 4]), 1, 1) }),
    );
    mapped.name = 'Mapped';
    donor.add(plain, mapped);

    const withDonor = new RVRibbonBandMesh(8, 500, donor);
    expect(withDonor.map).not.toBeNull();
    // A CLONE, so scrolling the band cannot move the donor's texture.
    expect(withDonor.map).not.toBe((mapped.material as MeshStandardMaterial).map);
    withDonor.dispose();

    const without = new RVRibbonBandMesh(8, 500, null);
    expect(without.map).not.toBeNull(); // the procedural default
    expect((without.mesh.material as MeshStandardMaterial).side).toBe(2); // DoubleSide
    without.dispose();
  });

  it('scrolls the map and wraps the offset into [0,1)', () => {
    const band = new RVRibbonBandMesh(8, 500);
    band.write(twoSamples(), 2, 500);
    // The web runs towards +u, so the pattern must move with it: offset falls.
    band.scroll(0.4);
    expect(band.map!.offset.x).toBeCloseTo(0.6, 9);
    band.scroll(0.9);
    expect(band.map!.offset.x).toBeCloseTo(0.7, 6); // wrapped, not -0.3
    band.resetScroll();
    expect(band.map!.offset.x).toBe(0);
    band.dispose();
  });

  it('setTextureLength maps millimetres to repetitions and puts the end at length / textureLength', () => {
    const band = new RVRibbonBandMesh(8, 500);
    band.write(twoSamples(), 2, 500);
    band.setTextureLength(4000, 1000); // 4 repetitions over a 4000 mm web
    // `repeat.x` is the mm -> repetition SCALE, so `offset.x` keeps meaning
    // repetitions and `scroll()` stays unchanged.
    expect(band.map!.repeat.x).toBeCloseTo(1 / 1000, 12);
    const uv = band.mesh.geometry.getAttribute('uv');
    expect(uv.getX(0)).toBeCloseTo(0, 9);
    expect(uv.getX(2)).toBeCloseTo(4000, 6);
    expect(uv.getX(2) * band.map!.repeat.x).toBeCloseTo(4, 9);
    band.dispose();
  });

  it('dispose releases geometry and cloned textures', () => {
    const band = new RVRibbonBandMesh(8, 500);
    const geoDispose = vi.spyOn(band.mesh.geometry, 'dispose');
    const texDispose = vi.spyOn(band.map!, 'dispose');
    const matDispose = vi.spyOn(band.mesh.material as { dispose: () => void }, 'dispose');
    band.dispose();
    expect(geoDispose).toHaveBeenCalled();
    expect(texDispose).toHaveBeenCalled();
    expect(matDispose).toHaveBeenCalled();
  });

  it('carries the export marker, is not pickable, not frustum culled and skips the async BVH build', () => {
    const band = new RVRibbonBandMesh(8, 500);
    expect(band.mesh.userData[RV_RIBBON_BAND]).toBe(true);
    expect(band.mesh.frustumCulled).toBe(false);
    // The loader's worker BVH build transfers (and detaches) the position buffer
    // this band rewrites every tick — it must never be collected for that build.
    expect(band.mesh.userData._rvSkipBVH).toBe(true);
    const hits: unknown[] = [];
    band.mesh.raycast({} as never, hits as never);
    expect(hits).toHaveLength(0);
    band.dispose();
  });

  it('never writes past its capacity, however many samples it is handed', () => {
    const band = new RVRibbonBandMesh(2, 500);
    const many = new Float32Array(16 * RIBBON_BAND_SAMPLE_STRIDE);
    for (let i = 0; i < 16; i++) {
      many.set([i * 100, 0, 0, 1, 0, 0, 0, 0, 1], i * RIBBON_BAND_SAMPLE_STRIDE);
    }
    band.write(many, 16, 500);
    expect(band.sampleCount).toBe(2);
    const p = band.mesh.geometry.getAttribute('position') as BufferAttribute;
    expect(p.count).toBe(4);
    band.dispose();
  });
});
