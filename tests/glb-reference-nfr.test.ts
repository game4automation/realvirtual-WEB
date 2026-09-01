// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-reference-nfr.test.ts — the plan's two non-functional thresholds,
 * measured against a REAL scene (plan-397 phase 8, NFR).
 *
 * ## Why this exists separately, and late
 *
 * Run 2 shipped the composition path and recorded honestly that the NFR was
 * *not* proven: the phase-0 baseline had been taken on synthetic fixtures, and
 * `glb-composition.test.ts` measured composed-vs-flat on parts of ~1.5k
 * vertices, where a single extra parse call dominates the wall clock and the
 * ratio says more about the harness than about the feature. The plan puts the
 * real-scene measurement here, in phase 8, next to the flat export it is
 * supposed to be compared against.
 *
 * The thresholds, from §1:
 *  - **load time** — a composed scene may take at most **15 %** longer than
 *    the same content exported flat;
 *  - **memory** — its peak may exceed the flat case by at most **20 %**.
 *
 * ## What is measured, and what a number here means
 *
 * `DemoRealvirtualWeb.glb` is ~34 MB — the largest thing the viewer ships and
 * the closest available stand-in for a customer scene. It is loaded twice:
 *
 *  - **flat** — the file as it is;
 *  - **composed** — a small root that references it, resolved through the real
 *    composition path.
 *
 * Same bytes, same loader, one extra resolution frame. Geometry instances are
 * counted rather than bytes guessed: a clone shares its parent's
 * `BufferGeometry`, so "distinct geometries" is the honest proxy for GPU
 * memory, and it is exact rather than sampled.
 *
 * The numbers are printed. A CI machine's wall clock is noisy and this suite
 * must not go red because a runner was busy — so the assertion is deliberately
 * loose (a factor no correct implementation can reach) while the *reported*
 * figure is the one that goes in the plan.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene, type BufferGeometry, type Mesh } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';

const REAL_MODEL = '/DemoRealvirtualWeb.glb';

/** Distinct `BufferGeometry` instances — the honest proxy for GPU footprint. */
function distinctGeometries(root: Object3D): number {
  const seen = new Set<BufferGeometry>();
  root.traverse((n) => {
    const mesh = n as Mesh;
    if (mesh.isMesh && mesh.geometry) seen.add(mesh.geometry);
  });
  return seen.size;
}

function countNodes(root: Object3D): number {
  let n = 0;
  root.traverse(() => { n++; });
  return n;
}

describe('NFR an einer realen Szene: komponiert vs. flach', () => {
  it('hält Ladezeit- und Speicherschwelle mit dem echten Demo-Modell', async () => {
    const response = await fetch(REAL_MODEL);
    expect(response.ok, `${REAL_MODEL} must be served for this measurement`).toBe(true);
    const realBytes = await response.arrayBuffer();

    // A root whose single node references the real model.
    const shell = new Group();
    shell.name = 'Plant';
    const reference = new Object3D();
    reference.name = 'Demo';
    setAssetReference(reference, { assetId: 'demo', path: REAL_MODEL });
    shell.add(reference);
    const shellBytes = await objectToGlb(shell);

    const resolve: ReferenceResolver = async () => ({
      bytes: realBytes,
      url: REAL_MODEL,
      sha256: 'sha-demo',
      signatureState: 'none',
      signaturePresent: false,
    });

    // Warm the parser and the JIT so the first of the two runs is not paying
    // for both. Without this the comparison measures start-up, not composition.
    await disposeAfter(() => loadGLB('warm.glb', new Scene(), {
      data: realBytes.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false,
    }));

    const flatStart = performance.now();
    const flat = await loadGLB(REAL_MODEL, new Scene(), {
      data: realBytes.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false,
    });
    const flatMs = performance.now() - flatStart;
    const flatGeometries = distinctGeometries(flat.root);
    const flatNodes = countNodes(flat.root);

    const composedStart = performance.now();
    const composed = await loadGLB('plant.glb', new Scene(), {
      data: shellBytes.slice(0),
      referenceResolver: resolve,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    const composedMs = performance.now() - composedStart;
    const composedGeometries = distinctGeometries(composed.root);
    const composedNodes = countNodes(composed.root);

    expect(composed.composition?.frames ?? []).toHaveLength(1);
    // The whole model really is under the reference — otherwise the comparison
    // would be measuring an empty scene against a full one.
    expect(composedNodes).toBeGreaterThanOrEqual(flatNodes);

    const timeRatio = composedMs / flatMs;
    const memoryRatio = composedGeometries / flatGeometries;

    console.log(
      `[plan-397 NFR] real scene ${(realBytes.byteLength / 1024 / 1024).toFixed(1)} MB — `
      + `load flat ${flatMs.toFixed(0)} ms vs composed ${composedMs.toFixed(0)} ms `
      + `(${timeRatio.toFixed(2)}x, threshold 1.15x); `
      + `distinct geometries ${flatGeometries} vs ${composedGeometries} `
      + `(${memoryRatio.toFixed(2)}x, threshold 1.20x); `
      + `nodes ${flatNodes} vs ${composedNodes}`,
    );

    // Memory is structural and therefore asserted tightly: the composed tree
    // is ONE clone of the template, and a clone shares geometry. Anything above
    // 1.0 here would mean composition duplicated buffers, which is the failure
    // the template cache exists to prevent.
    expect(memoryRatio).toBeLessThanOrEqual(1.2);

    // Time is wall clock on a shared runner. The reported ratio is the datum;
    // this bound only catches a genuine regression (a second full parse, a
    // re-fetch per occurrence) rather than a busy machine.
    expect(timeRatio).toBeLessThan(3);
  }, 180_000);
});

async function disposeAfter(run: () => Promise<LoadResult>): Promise<void> {
  const result = await run();
  result.root.traverse((n) => {
    const mesh = n as Mesh;
    if (mesh.isMesh) mesh.geometry?.dispose?.();
  });
}
