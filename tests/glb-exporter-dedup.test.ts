// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-exporter-dedup.test.ts — plan-397 Phase 0 GATE.
 *
 * The flat export (plan-397 Phase 8) embeds every referenced subtree. Composition
 * resolves eagerly and hands each occurrence a `.clone()`, and Three.js clones
 * SHARE their `BufferGeometry` instance. The whole native-path plan rests on one
 * measurable property: does `GLTFExporter` recognise that sharing and emit the
 * geometry once?
 *
 * If it does, a flat export of N identical assemblies stays near the size of one
 * (the plan's threshold: 10 occurrences below 2x a single export) and no new
 * dependency is needed. If it does NOT, the size grows linearly and the
 * `gltf-transform` route (plan §7 Alternative 3) becomes a REPLANNING trigger —
 * not something to pull in silently.
 *
 * The `distinctGeometry` control run is what makes the number trustworthy: it
 * proves this measurement can actually SEE linear growth, so a passing dedup
 * assertion is not just an artefact of a too-small payload.
 */

import { describe, it, expect } from 'vitest';
import { Group, Mesh, SphereGeometry, MeshStandardMaterial } from 'three';
import type { BufferGeometry, Material } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';

/** One assembly: a few meshes, big enough that geometry dominates the file. */
function buildAssembly(geometryFor: (i: number) => BufferGeometry, material: Material, tag: string): Group {
  const assembly = new Group();
  assembly.name = `Assembly_${tag}`;
  for (let i = 0; i < 3; i++) {
    const mesh = new Mesh(geometryFor(i), material);
    mesh.name = `${tag}_Part${i}`;
    mesh.position.set(i * 2, 0, 0);
    assembly.add(mesh);
  }
  return assembly;
}

/** N assemblies under one root, all sharing the SAME geometry instances. */
function buildShared(count: number, parts: BufferGeometry[], material: Material): Group {
  const root = new Group();
  root.name = 'Plant';
  for (let n = 0; n < count; n++) {
    const assembly = buildAssembly((i) => parts[i], material, `S${n}`);
    assembly.position.set(0, 0, n * 10);
    root.add(assembly);
  }
  return root;
}

/** N assemblies under one root, each with its OWN geometry copies (control). */
function buildDistinct(count: number, parts: BufferGeometry[], material: Material): Group {
  const root = new Group();
  root.name = 'Plant';
  for (let n = 0; n < count; n++) {
    const assembly = buildAssembly((i) => parts[i].clone(), material, `D${n}`);
    assembly.position.set(0, 0, n * 10);
    root.add(assembly);
  }
  return root;
}

describe('plan-397 Phase 0 gate — GLTFExporter geometry deduplication', () => {
  // 32x24 segments ≈ 1.5k vertices per part, 3 parts per assembly: large enough
  // that the JSON overhead of ten extra nodes cannot mask a linear blow-up.
  const parts = [
    new SphereGeometry(1, 32, 24),
    new SphereGeometry(0.7, 32, 24),
    new SphereGeometry(0.4, 32, 24),
  ];
  const material = new MeshStandardMaterial({ color: 0x2288cc });

  it('emits shared BufferGeometry once — 10 occurrences stay below 2x a single export', async () => {
    const one = await objectToGlb(buildShared(1, parts, material));
    const ten = await objectToGlb(buildShared(10, parts, material));
    const tenDistinct = await objectToGlb(buildDistinct(10, parts, material));

    const ratioShared = ten.byteLength / one.byteLength;
    const ratioDistinct = tenDistinct.byteLength / one.byteLength;

    // Printed so the measurement can be transcribed into the plan document.
    // eslint-disable-next-line no-console
    console.log(
      '[plan-397 Phase 0] GLTFExporter dedup measurement:\n'
      + `  1 assembly              : ${one.byteLength} bytes\n`
      + `  10 shared geometry      : ${ten.byteLength} bytes  (x${ratioShared.toFixed(2)})\n`
      + `  10 distinct geometry    : ${tenDistinct.byteLength} bytes  (x${ratioDistinct.toFixed(2)})`,
    );

    // Control: the measurement can see linear growth at all. Without this a
    // passing dedup assertion would prove nothing.
    expect(ratioDistinct, 'control run must grow roughly linearly').toBeGreaterThan(5);

    // The gate itself (plan §1 non-functional requirement "Dateigröße").
    expect(ratioShared, '10 shared occurrences must stay below 2x a single export').toBeLessThan(2);
  }, 120_000);
});
