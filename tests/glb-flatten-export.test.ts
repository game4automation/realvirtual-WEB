// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-flatten-export.test.ts — plan-397 §9.5, phase 8.
 *
 * The flat export is what makes a referencing scene shareable: one file that
 * runs anywhere, still knowing what it was built from. Four things have to
 * hold, and the third is the one the whole design rests on:
 *
 *  1. every referenced subtree is actually in the file;
 *  2. each one records its origin (`assetId` + `sha256`, `embedded: true`);
 *  3. **it does not grow linearly with the number of occurrences** — ten
 *     identical assemblies stay under twice a single export. Phase 0 measured
 *     1.02x; this turns that measurement into a regression;
 *  4. it can be taken apart again, so a flat file is not a one-way door.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  getAssetReference,
  setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import {
  estimateFlattenedSize,
  formatBytes,
  markReferencesEmbedded,
  unflattenReferences,
  unmarkReferencesEmbedded,
} from '../src/core/engine/rv-glb-flatten';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';

const material = new MeshStandardMaterial({ color: 0x556677 });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  // A non-trivial mesh: with 4 segments the geometry is big enough that
  // duplicating it ten times would be plainly visible in the byte count.
  const mesh = new Mesh(new BoxGeometry(1, 1, 1, 4, 4, 4), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** The referenced asset. */
function buildAssembly(): Group {
  const g = new Group();
  g.name = 'Assembly';
  g.add(meshNamed('Ram', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
  g.add(meshNamed('Housing'));
  return g;
}

/** A scene with `count` references to the same assembly. */
function buildPlant(count: number): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor'));
  for (let i = 0; i < count; i++) {
    const node = new Object3D();
    node.name = `Press_${i}`;
    node.position.set(i * 1000, 0, 0);
    setAssetReference(node, { assetId: 'assembly', path: 'lib/assembly.glb' });
    plant.add(node);
  }
  return plant;
}

let assemblyBytes: ArrayBuffer;

const resolver: ReferenceResolver = async () => ({
  bytes: assemblyBytes,
  url: 'lib/assembly.glb',
  sha256: 'sha-assembly',
  signatureState: 'none',
  signaturePresent: false,
});

async function load(bytes: ArrayBuffer): Promise<LoadResult> {
  return loadGLB('plant.glb', new Scene(), {
    data: bytes.slice(0),
    referenceResolver: resolver,
    preserveHierarchy: true,
    loadKinematicsSidecar: false,
    sourceSha256: 'sha-plant',
  });
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

beforeEach(async () => {
  assemblyBytes = await objectToGlb(buildAssembly());
});

// ─── Embedding ──────────────────────────────────────────────────────────

describe('Flach-Export', () => {
  it('bettet alle referenzierten Teilbäume ein', async () => {
    const plant = await objectToGlb(buildPlant(2));
    const loaded = await load(plant);
    const frames = loaded.composition?.frames ?? [];
    expect(frames).toHaveLength(2);

    markReferencesEmbedded(frames);
    const flat = await objectToGlb(loaded.root);

    // Reloading WITHOUT a resolver must still show the assembly: the content
    // is in the file, and nothing tries to fetch it a second time.
    const reloaded = await loadGLB('flat.glb', new Scene(), {
      data: flat,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
    });
    expect(findByName(reloaded.root, 'Ram')).toBeTruthy();
    expect(reloaded.composition?.frames ?? []).toHaveLength(0);
    expect(reloaded.composition?.missing ?? []).toHaveLength(0);
  });

  it('vermerkt Herkunft je Teilbaum (assetId + sha256, embedded: true)', async () => {
    const plant = await objectToGlb(buildPlant(1));
    const loaded = await load(plant);
    const result = markReferencesEmbedded(loaded.composition!.frames);

    expect(result.embedded).toEqual([
      { assetId: 'assembly', sha256: 'sha-assembly', url: 'lib/assembly.glb' },
    ]);

    const node = findByName(loaded.root, 'Press_0')!;
    const ref = getAssetReference(node)!;
    expect(ref.embedded).toBe(true);
    expect(ref.assetId).toBe('assembly');
    // The hash of what was ACTUALLY embedded — that is what makes the note
    // usable for deciding whether the file is stale.
    expect(ref.sha256).toBe('sha-assembly');
  });

  it('markiert eine nicht auflösbare Referenz NICHT als eingebettet', async () => {
    const plant = new Group();
    plant.name = 'Plant';
    const node = new Object3D();
    node.name = 'Missing';
    setAssetReference(node, { assetId: 'nope' });
    plant.add(node);

    const loaded = await loadGLB('plant.glb', new Scene(), {
      data: await objectToGlb(plant),
      referenceResolver: async () => null,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
    });
    markReferencesEmbedded(loaded.composition?.frames ?? []);

    // Claiming "embedded" for content the file does not contain is the one
    // lie that would make a flat export silently empty.
    expect(getAssetReference(findByName(loaded.root, 'Missing')!)?.embedded).toBeUndefined();
  });
});

// ─── The size threshold ─────────────────────────────────────────────────

describe('Größenschwelle', () => {
  it('wächst bei 10 identischen Baugruppen nicht linear', async () => {
    const one = await flatten(1);
    const ten = await flatten(10);

    // The plan's threshold. Ten occurrences share one BufferGeometry and the
    // exporter dedups it — phase 0 measured 1.02x.
    expect(ten.byteLength).toBeLessThan(one.byteLength * 2);

    // Control: without the sharing the same ten WOULD grow linearly. Without
    // it the assertion above could pass on a payload too small to show growth.
    const distinct = await flattenDistinctGeometry(10);
    expect(distinct.byteLength).toBeGreaterThan(one.byteLength * 5);
  });

  it('schätzt die Größe über DISTINKTE Assets, nicht über Vorkommen', async () => {
    const plant = await objectToGlb(buildPlant(10));
    const loaded = await load(plant);
    const estimate = estimateFlattenedSize(plant.byteLength, loaded.composition!.frames);

    expect(estimate.occurrences).toBe(10);
    expect(estimate.distinctAssets).toBe(1);
    // Counting occurrences would tell the user the file is about to be ten
    // times bigger than it will be.
    expect(estimate.referencedBytes).toBe(assemblyBytes.byteLength);
    expect(estimate.totalBytes).toBe(plant.byteLength + assemblyBytes.byteLength);
  });

  it('formatiert Größen lesbar', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

// ─── The way back ───────────────────────────────────────────────────────

describe('Rückweg in Referenzen', () => {
  it('lässt sich wieder in Referenzen zerlegen', async () => {
    const plant = await objectToGlb(buildPlant(2));
    const loaded = await load(plant);
    markReferencesEmbedded(loaded.composition!.frames);
    const flat = await objectToGlb(loaded.root);

    const flatLoaded = await loadGLB('flat.glb', new Scene(), {
      data: flat, preserveHierarchy: true, loadKinematicsSidecar: false,
    });
    expect(findByName(flatLoaded.root, 'Ram')).toBeTruthy();

    const result = unflattenReferences(flatLoaded.root);

    expect(result.restored).toHaveLength(2);
    expect(result.restored[0].assetId).toBe('assembly');
    expect(result.removedNodes).toBeGreaterThan(0);
    // The content is gone and the reference is a reference again.
    expect(findByName(flatLoaded.root, 'Ram')).toBeNull();
    const node = findByName(flatLoaded.root, 'Press_0')!;
    expect(getAssetReference(node)?.embedded).toBeUndefined();
    expect(getAssetReference(node)?.assetId).toBe('assembly');
  });

  it('der zerlegte Baum löst beim nächsten Laden wieder normal auf', async () => {
    const plant = await objectToGlb(buildPlant(1));
    const loaded = await load(plant);
    markReferencesEmbedded(loaded.composition!.frames);
    const flat = await objectToGlb(loaded.root);

    const flatLoaded = await loadGLB('flat.glb', new Scene(), {
      data: flat, preserveHierarchy: true, loadKinematicsSidecar: false,
    });
    unflattenReferences(flatLoaded.root);
    const roundTripped = await objectToGlb(flatLoaded.root);

    // Full circle: reference → flat → reference → resolved again.
    const again = await load(roundTripped);
    expect(again.composition?.frames ?? []).toHaveLength(1);
    expect(findByName(again.root, 'Ram')).toBeTruthy();
  });

  it('nimmt die Markierung von der LEBENDEN Szene wieder ab', async () => {
    const plant = await objectToGlb(buildPlant(1));
    const loaded = await load(plant);
    markReferencesEmbedded(loaded.composition!.frames);

    const cleared = unmarkReferencesEmbedded(loaded.composition!.frames);

    // Otherwise the running session would believe its references are already
    // inlined, and the next save would write exactly that.
    expect(cleared).toBe(1);
    expect(getAssetReference(findByName(loaded.root, 'Press_0')!)?.embedded).toBeUndefined();
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function flatten(count: number): Promise<ArrayBuffer> {
  const loaded = await load(await objectToGlb(buildPlant(count)));
  markReferencesEmbedded(loaded.composition?.frames ?? []);
  return objectToGlb(loaded.root);
}

/**
 * The control: `count` copies of the same assembly, each with its OWN geometry.
 *
 * Proves the measurement can see linear growth at all — without it, "ten
 * occurrences cost 1.02x" might only mean the payload was too small to matter.
 */
async function flattenDistinctGeometry(count: number): Promise<ArrayBuffer> {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor'));
  for (let i = 0; i < count; i++) {
    const copy = buildAssembly();
    copy.name = `Assembly_${i}`;
    copy.traverse((n) => {
      const mesh = n as Mesh;
      if (mesh.isMesh) mesh.geometry = mesh.geometry.clone();
    });
    copy.position.set(i * 1000, 0, 0);
    plant.add(copy);
  }
  return objectToGlb(plant);
}
