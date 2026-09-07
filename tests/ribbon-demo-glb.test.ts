// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-demo-glb.test.ts — the shipped demo slitter, loaded for real.
 *
 * The synthetic fixtures prove the mathematics; this file proves that the
 * document we actually ship is a machine the mathematics likes. It is the
 * regression gate for three modelling faults the demo had (plan-460 follow-up),
 * every one of which was invisible to the unit tests because they build their
 * own geometry:
 *
 *  1. `Dancer_B` sat BELOW the nip while `Dancer_A` sat above it, so the two
 *     strips turned opposite ways there. With `RibbonSide: Auto` that resolved
 *     the SHARED nip differently per strip, and the full-width web before the
 *     cut took two different tangent lines at once.
 *  2. The slit was taken at the DEPARTURE tangent point, so the two strips —
 *     which leave the nip at different angles — reported different slit points
 *     and the shared web overlapped one strip on the roller (z-fighting).
 *  3. `Idler_03` / `Idler_04` were 420 mm long while the strips run 400 mm wide
 *     in lanes at x = ±230, so each strip overhung both ends of its own idler.
 *
 * The band-inside-roller check (below) is the general form of 2 and 3: on a taut
 * web NO band vertex may ever be inside a roller it runs over.
 *
 * Regenerate the document with the private
 * `scripts/build-demo-ribbon-slitter.mjs`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Box3, Scene, Vector3 } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';
import type { RVRibbonPath } from '../src/core/engine/rv-ribbon-path';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

// plan-395: the demo lives in the private Development project and is absent from
// a public checkout, where this suite must report `skipped` rather than `passed`.
const DEV_ASSETS = await devAssetAvailable(DEV_GLB.ribbonSlitter);

const GLB_URL = DEV_GLB.ribbonSlitter;

/** mm — a band vertex may not be deeper than this inside a roller. */
const PENETRATION_TOLERANCE_MM = 0.1;

let result: LoadResult | null = null;
let paths: RVRibbonPath[] = [];

beforeAll(async () => {
  // The suite below is `skipIf`-ed without the private sibling, but a top-level
  // `beforeAll` runs anyway — and there the dev server answers `/private-assets/`
  // with the SPA fallback, whose bytes are not a GLB. Bail out here so the file
  // reports `skipped` instead of erroring.
  if (!DEV_ASSETS) return;
  const bytes = await (await fetch(GLB_URL)).arrayBuffer();
  const scene = new Scene();
  // preserveHierarchy: the merges would bake the roller nodes away, and this
  // test asks a question about the authored nodes.
  result = await loadGLB(GLB_URL, scene, { data: bytes, preserveHierarchy: true });
  scene.updateMatrixWorld(true);
  paths = result.registry.getAll<RVRibbonPath>('RibbonPath').map((p) => p.instance);
  paths.sort((a, b) => (a.node.name < b.node.name ? -1 : 1));
}, 60_000);

describe.skipIf(!DEV_ASSETS)('DemoRibbonSlitter.glb', () => {
  it('has two strips, both active, slit at the same roller', () => {
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path.isActive).toBe(true);
      expect(path.slitRoller).not.toBeNull();
    }
    expect(paths[0].slitRoller).toBe(paths[1].slitRoller);
    expect(paths[0].slitRoller!.node.name).toBe('Nip');
  });

  it('both strips are cut at the SAME point — the arrival tangent point of the nip', () => {
    const [a, b] = paths;
    expect(a.slitSampleIndex).toBeGreaterThan(0);
    expect(b.slitSampleIndex).toBeGreaterThan(0);

    /** World position of the band centre line at `path`'s slit sample. */
    const slitPoint = (path: RVRibbonPath): Vector3 => {
      const band = path.band!;
      band.mesh.updateMatrixWorld(true);
      const pos = band.mesh.geometry.getAttribute('position');
      const i = path.slitSampleIndex;
      return new Vector3(
        (pos.getX(2 * i) + pos.getX(2 * i + 1)) / 2,
        (pos.getY(2 * i) + pos.getY(2 * i + 1)) / 2,
        (pos.getZ(2 * i) + pos.getZ(2 * i + 1)) / 2,
      ).applyMatrix4(band.mesh.matrixWorld);
    };

    // The strips have different total lengths, but the sample grid is ABSOLUTE
    // (`i * step`), so the same physical point lands on the same index for both.
    expect(a.lengthMm).not.toBeCloseTo(b.lengthMm, 0);
    expect(a.slitSampleIndex).toBe(b.slitSampleIndex);
    const pa = slitPoint(a);
    const pb = slitPoint(b);
    // Compare in the wrap plane only: at the cut each strip steps into its own
    // lane along the roller axis (x), which is exactly what the slit is FOR. In
    // that plane the two points are the same point, to float noise.
    expect(Math.hypot(pa.y - pb.y, pa.z - pb.z) * MM_TO_METERS).toBeLessThan(0.01);

    // And that point is ON the nip, i.e. where the web arrives at it.
    const nip = a.slitRoller!;
    const centre = new Vector3().setFromMatrixPosition(nip.node.matrixWorld);
    const radialMm = Math.hypot(pa.y - centre.y, pa.z - centre.z) * MM_TO_METERS;
    expect(radialMm).toBeCloseTo(nip.radiusMm + a.RibbonThicknessMm / 2, 1);
  });

  it('both strips wrap every shared roller — the nip included — on the same side', () => {
    const [a, b] = paths;
    const slit = a.slitRoller!;
    for (let i = 0; i < a.rollers.length; i++) {
      const roller = a.rollers[i];
      const j = b.rollers.indexOf(roller);
      expect(j, `"${roller.node.name}" is shared, so both strips must list it`).toBeGreaterThanOrEqual(0);
      expect(
        a.resolvedSideAt(i),
        `"${roller.node.name}" is wrapped on opposite sides by the two strips`,
      ).toBe(b.resolvedSideAt(j));
      if (roller === slit) break;
    }
  });

  it('no band vertex lies inside a roller of its own path', () => {
    const centre = new Vector3();
    const axis = new Vector3();
    const point = new Vector3();
    const delta = new Vector3();
    const box = new Box3();

    for (const path of paths) {
      const band = path.band!;
      expect(band).toBeTruthy();
      band.mesh.updateMatrixWorld(true);
      const pos = band.mesh.geometry.getAttribute('position');

      for (const roller of path.rollers) {
        const node = roller.node;
        node.updateMatrixWorld(true);
        centre.setFromMatrixPosition(node.matrixWorld);
        // Every roller of this demo turns about its local X. The axis is taken
        // from the world matrix rather than assumed, so a rotated roller would
        // still be measured correctly.
        axis.set(1, 0, 0).transformDirection(node.matrixWorld).normalize();
        // World extent along the axis, so a band vertex running BESIDE a short
        // roller (in its own lane) is not compared against it. The face discs
        // widen the box by a fraction of a millimetre, which only makes the
        // gate stricter.
        box.setFromObject(node);
        const halfLenMm = (Math.abs(box.max.x - box.min.x) / 2) * MM_TO_METERS;
        const limitMm = roller.radiusMm - PENETRATION_TOLERANCE_MM;

        for (let i = 0; i < pos.count; i++) {
          point.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(band.mesh.matrixWorld);
          delta.subVectors(point, centre);
          const axialMm = delta.dot(axis) * MM_TO_METERS;
          if (Math.abs(axialMm) > halfLenMm) continue;      // beside the roller
          const radialMm = delta.addScaledVector(axis, -delta.dot(axis)).length() * MM_TO_METERS;
          expect(
            radialMm,
            `"${path.node.name}" vertex ${i} is ${(roller.radiusMm - radialMm).toFixed(2)} mm `
            + `inside "${node.name}" (r = ${roller.radiusMm.toFixed(2)} mm)`,
          ).toBeGreaterThanOrEqual(limitMm);
        }
      }
    }
  });

  it('every roller is long enough for the strips that run over it', () => {
    const box = new Box3();
    const centre = new Vector3();
    const axis = new Vector3();
    const point = new Vector3();
    const delta = new Vector3();

    for (const path of paths) {
      const band = path.band!;
      band.mesh.updateMatrixWorld(true);
      const pos = band.mesh.geometry.getAttribute('position');
      for (const roller of path.rollers) {
        const node = roller.node;
        centre.setFromMatrixPosition(node.matrixWorld);
        axis.set(1, 0, 0).transformDirection(node.matrixWorld).normalize();
        box.setFromObject(node);
        const halfLenMm = (Math.abs(box.max.x - box.min.x) / 2) * MM_TO_METERS;
        // The widest axial offset of a band vertex that actually touches this
        // roller — i.e. one on its contact circle, within a millimetre.
        let maxAxialMm = 0;
        let touched = false;
        for (let i = 0; i < pos.count; i++) {
          point.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(band.mesh.matrixWorld);
          delta.subVectors(point, centre);
          const axialMm = delta.dot(axis) * MM_TO_METERS;
          const radialMm = delta.addScaledVector(axis, -delta.dot(axis)).length() * MM_TO_METERS;
          if (Math.abs(radialMm - roller.radiusMm) > 5) continue;
          touched = true;
          maxAxialMm = Math.max(maxAxialMm, Math.abs(axialMm));
        }
        if (!touched) continue;
        expect(
          maxAxialMm,
          `"${path.node.name}" overhangs "${node.name}" (half length ${halfLenMm.toFixed(1)} mm)`,
        ).toBeLessThanOrEqual(halfLenMm);
      }
    }
  });
});
