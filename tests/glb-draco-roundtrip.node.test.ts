// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-draco-roundtrip.node.test.ts — plan-749 phase 2 (T8-T12, T15-T17).
 *
 * Covers `scripts/compress-glb.mjs`: that Draco compression declares itself,
 * preserves the metadata realvirtual actually depends on (node identity by
 * PATH, `extras`, hierarchy, transforms, material extensions), that the
 * geometry survives a REAL Draco decode, and that compressing before signing
 * keeps the signature chain intact.
 *
 * **Runner: `npm run test:node`, never `npm test`.** `npm test` is the browser
 * config and `vite.config.ts` excludes `tests/**\/*.node.test.ts` from it — it
 * would run green without executing a single test in this file.
 *
 * ## Why the fixture and not `DemoRealvirtualWeb.glb`
 *
 * The asset step replaces the demo GLB in place, so after it a checkout holds
 * only the Draco fassung and has no "before" left to compare against
 * (plan-749, finding R2-2). `tests/fixtures/draco-roundtrip-source.glb` is the
 * versioned raw source instead — 163 KB, generated deterministically by
 * `scripts/build-draco-fixture.mjs`, and built to carry every structural
 * property of the demo that this transform could plausibly break: `extras` on
 * every node, duplicate node names at different paths, indexed TRIANGLES with
 * POSITION/NORMAL/TEXCOORD_0/TANGENT/COLOR_0, and the demo's three material
 * extensions. The full asset is accepted once, manually (plan §9.3 A2/A3).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { describe, it, expect, beforeAll } from 'vitest';

import type { Document, Node as GltfNode, Scene } from '@gltf-transform/core';

import {
  compressGlbBytes,
  hasDraco,
  isSigned,
  readGlbJson,
  getIO,
  DRACO_EXTENSION,
  DEFAULT_DRACO_OPTIONS,
} from '../scripts/compress-glb.mjs';
import { signGlbBytes, verifyGlbBytes } from '../scripts/rv-sign-glb.mjs';

const FIXTURE = resolve(__dirname, 'fixtures/draco-roundtrip-source.glb');

// ---------------------------------------------------------------------------
// Path-indexed view of a document.
//
// [F7] The comparison key is the HIERARCHY PATH, not the name. A name set
// collapses duplicates and loses the assignment, and the assignment is exactly
// what signal resolution and classification read (`rv-glb-parse.ts:99-123`).
// The fixture has 24 nodes sharing 5 names for precisely this reason.
// ---------------------------------------------------------------------------

interface NodeView {
  extras: unknown;
  translation: number[];
  rotation: number[];
  scale: number[];
  mesh: string | null;
  primitives: number;
  children: string[];
}

function segmentsOf(children: GltfNode[]): string[] {
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.getName(), (counts.get(child.getName()) ?? 0) + 1);
  const seen = new Map<string, number>();
  return children.map((child) => {
    const name = child.getName();
    if ((counts.get(name) ?? 0) <= 1) return name;
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    return `${name}#${index}`;
  });
}

function viewOf(node: GltfNode, childPaths: string[]): NodeView {
  const mesh = node.getMesh();
  return {
    extras: node.getExtras() ?? null,
    translation: [...node.getTranslation()],
    rotation: [...node.getRotation()],
    scale: [...node.getScale()],
    mesh: mesh ? mesh.getName() : null,
    primitives: mesh ? mesh.listPrimitives().length : 0,
    children: childPaths,
  };
}

function indexByPath(document: Document): Map<string, NodeView> {
  const out = new Map<string, NodeView>();

  const walk = (children: GltfNode[], prefix: string): string[] => {
    const segments = segmentsOf(children);
    return children.map((child, i) => {
      const path = `${prefix}/${segments[i]}`;
      const childPaths = walk(child.listChildren(), path);
      out.set(path, viewOf(child, childPaths));
      return path;
    });
  };

  for (const scene of document.getRoot().listScenes() as Scene[]) {
    walk(scene.listChildren(), scene.getName());
  }
  return out;
}

/**
 * Draco welds and REORDERS vertices, so `A[i]` vs `B[i]` compares unrelated
 * points — an index-wise check reports errors as large as the whole model and
 * proves nothing. The honest measure is, for every decoded vertex, the distance
 * to the nearest vertex of the original, via a uniform grid.
 */
function maxNearestNeighbourDistance(original: ArrayLike<number>, decoded: ArrayLike<number>, cell: number): number {
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < original.length; i += 3) {
    const k = key(original[i], original[i + 1], original[i + 2]);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  let worst = 0;
  for (let j = 0; j < decoded.length; j += 3) {
    const x = decoded[j];
    const y = decoded[j + 1];
    const z = decoded[j + 2];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const d = (original[i] - x) ** 2 + (original[i + 1] - y) ** 2 + (original[i + 2] - z) ** 2;
            if (d < best) best = d;
          }
        }
      }
    }
    // Infinity means the decoded point has no original within one cell ring —
    // that is a real failure and must surface, not be skipped.
    const distance = Math.sqrt(best);
    if (!(distance <= worst)) worst = distance;
  }
  return worst;
}

// ---------------------------------------------------------------------------

let sourceBytes: Buffer;
let compressedBytes: Buffer;
let sourceDoc: Document;
let decodedDoc: Document;
let sourceIndex: Map<string, NodeView>;
let decodedIndex: Map<string, NodeView>;
let compressionFactor = 0;

beforeAll(async () => {
  sourceBytes = readFileSync(FIXTURE);
  const result = await compressGlbBytes(sourceBytes);
  compressedBytes = result.bytes;
  compressionFactor = result.bytesBefore / result.bytesAfter;

  const io = await getIO();
  sourceDoc = await io.readBinary(sourceBytes);
  // Reading the compressed bytes IS the Draco decode: the IO has
  // `draco3d.decoder` registered, so the accessors below hold real, decoded
  // float geometry rather than the compressed bufferViews.
  decodedDoc = await io.readBinary(compressedBytes);

  sourceIndex = indexByPath(sourceDoc);
  decodedIndex = indexByPath(decodedDoc);

  // eslint-disable-next-line no-console
  console.log(
    `[T12] fixture ${result.bytesBefore} -> ${result.bytesAfter} B`
    + ` (-${((1 - result.ratio) * 100).toFixed(1)} %, factor ${compressionFactor.toFixed(2)}x)`,
  );
}, 120_000);

describe('the fixture itself', () => {
  it('is the RAW source, not an already-compressed GLB', () => {
    // If someone ever regenerates the fixture from the compressed asset, every
    // comparison below would silently become "Draco vs Draco" and pass while
    // testing nothing. This is the guard against that.
    expect(hasDraco(sourceBytes)).toBe(false);
    expect(isSigned(sourceBytes)).toBe(false);
  });

  it('actually contains the duplicate names that make T9 a path test', () => {
    const paths = [...sourceIndex.keys()];
    const names = paths.map((path) => path.slice(path.lastIndexOf('/') + 1));
    expect(paths.length).toBeGreaterThan(20);
    // Far fewer distinct names than nodes: a name-set comparison could not
    // distinguish these, which is the whole point of comparing by path.
    expect(new Set(names).size).toBeLessThan(paths.length);
  });
});

describe('T8 — draco_output_declares_the_extension', () => {
  it('lists KHR_draco_mesh_compression in extensionsUsed and extensionsRequired', () => {
    const json = readGlbJson(compressedBytes) as { extensionsUsed?: string[]; extensionsRequired?: string[] };
    expect(json.extensionsUsed).toContain(DRACO_EXTENSION);
    // Required as well: a viewer without a Draco decoder must fail loudly
    // rather than render an empty scene.
    expect(json.extensionsRequired).toContain(DRACO_EXTENSION);
    expect(hasDraco(compressedBytes)).toBe(true);
  });

  it('puts the compressed payload on every primitive', () => {
    const json = readGlbJson(compressedBytes) as { meshes: { primitives: { extensions?: Record<string, unknown> }[] }[] };
    const primitives = json.meshes.flatMap((mesh) => mesh.primitives);
    expect(primitives.length).toBeGreaterThan(0);
    for (const primitive of primitives) {
      expect(primitive.extensions?.[DRACO_EXTENSION]).toBeDefined();
    }
  });
});

describe('T9 — node_identity_survives_the_transform', () => {
  it('preserves every hierarchy path, one for one', () => {
    expect([...decodedIndex.keys()].sort()).toEqual([...sourceIndex.keys()].sort());
  });

  it('keeps each path pointing at the same mesh assignment', () => {
    for (const [path, before] of sourceIndex) {
      const after = decodedIndex.get(path);
      expect(after, `missing path ${path}`).toBeDefined();
      expect(after!.mesh, `mesh at ${path}`).toBe(before.mesh);
      expect(after!.primitives, `primitive count at ${path}`).toBe(before.primitives);
    }
  });
});

describe('T10 — extras_survive_the_transform', () => {
  it('keeps every extras object deep-equal, matched by path', () => {
    let compared = 0;
    for (const [path, before] of sourceIndex) {
      expect(decodedIndex.get(path)!.extras, `extras at ${path}`).toEqual(before.extras);
      compared += 1;
    }
    // Guard: the fixture has extras on every node, so a transform that dropped
    // them all would otherwise make this loop vacuously true.
    expect(compared).toBe(sourceIndex.size);
    expect([...sourceIndex.values()].every((view) => view.extras !== null)).toBe(true);
  });
});

describe('T11 — hierarchy_and_transforms_are_preserved', () => {
  it('keeps parentage identical', () => {
    for (const [path, before] of sourceIndex) {
      expect(decodedIndex.get(path)!.children.sort(), `children of ${path}`).toEqual([...before.children].sort());
    }
  });

  it('keeps translation, rotation and scale identical', () => {
    // Node TRS is glTF JSON, not Draco payload — it must come back bit-exact,
    // so this is an exact comparison and not a tolerance.
    for (const [path, before] of sourceIndex) {
      const after = decodedIndex.get(path)!;
      expect(after.translation, `translation at ${path}`).toEqual(before.translation);
      expect(after.rotation, `rotation at ${path}`).toEqual(before.rotation);
      expect(after.scale, `scale at ${path}`).toEqual(before.scale);
    }
  });
});

describe('T12 — output_is_smaller_than_input', () => {
  it('is strictly smaller, and the factor is logged rather than asserted as a threshold', () => {
    expect(compressedBytes.length).toBeLessThan(sourceBytes.length);
    // eslint-disable-next-line no-console
    console.log(`[T12] measured factor: ${compressionFactor.toFixed(2)}x`);
  });
});

describe('T15 — geometry_survives_an_actual_draco_decode', () => {
  it('decodes with the real Draco decoder, not a passthrough', () => {
    // The file on disk declares Draco, but the document read back does not:
    // that difference is the proof the decoder ran. Without it every check
    // below would be comparing the source to itself.
    expect(hasDraco(compressedBytes)).toBe(true);
    const primitives = decodedDoc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
    expect(primitives.length).toBeGreaterThan(0);
    for (const primitive of primitives) {
      expect(primitive.getExtension(DRACO_EXTENSION)).toBeNull();
      expect(primitive.getAttribute('POSITION')!.getArray()!.length).toBeGreaterThan(0);
    }
  });

  it('keeps every decoded vertex within the quantization step of the original', () => {
    const sourceMeshes = sourceDoc.getRoot().listMeshes();
    const decodedMeshes = decodedDoc.getRoot().listMeshes();
    expect(decodedMeshes.length).toBe(sourceMeshes.length);

    let checked = 0;
    let worstRelative = 0;

    for (let m = 0; m < sourceMeshes.length; m += 1) {
      const before = sourceMeshes[m].listPrimitives();
      const after = decodedMeshes[m].listPrimitives();
      expect(after.length, `primitive count of mesh ${m}`).toBe(before.length);

      for (let p = 0; p < before.length; p += 1) {
        const original = before[p].getAttribute('POSITION')!;
        const decoded = after[p].getAttribute('POSITION')!;
        const min = original.getMin([0, 0, 0]) as number[];
        const max = original.getMax([0, 0, 0]) as number[];
        const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
        expect(extent).toBeGreaterThan(0);

        const worst = maxNearestNeighbourDistance(
          original.getArray()!,
          decoded.getArray()!,
          Math.max(extent / 64, 1e-9),
        );
        worstRelative = Math.max(worstRelative, worst / extent);
        checked += 1;
      }
    }

    // The tolerance is DERIVED, not picked: Draco quantizes positions over each
    // primitive's own bounding box, so one step is extent / 2^quantizePosition.
    // Two steps allows for the rounding at both ends and nothing more.
    const tolerance = 2 / 2 ** DEFAULT_DRACO_OPTIONS.quantizePosition;
    // eslint-disable-next-line no-console
    console.log(
      `[T15] ${checked} primitives, worst displacement ${worstRelative.toExponential(3)} of extent`
      + ` (tolerance ${tolerance.toExponential(3)})`,
    );
    expect(checked).toBeGreaterThan(0);
    expect(worstRelative).toBeLessThanOrEqual(tolerance);
  });

  it('keeps the triangle count, except for triangles that were already degenerate', () => {
    const sourceMeshes = sourceDoc.getRoot().listMeshes();
    const decodedMeshes = decodedDoc.getRoot().listMeshes();
    for (let m = 0; m < sourceMeshes.length; m += 1) {
      const before = sourceMeshes[m].listPrimitives();
      const after = decodedMeshes[m].listPrimitives();
      for (let p = 0; p < before.length; p += 1) {
        const beforeCount = before[p].getIndices()!.getArray()!.length / 3;
        const afterCount = after[p].getIndices()!.getArray()!.length / 3;
        // The fixture has no degenerate triangles, so here it is exact. The real
        // demo asset does (4 zero-area triangles, which Draco drops) — the
        // manual acceptance records that, this fixture pins the clean case.
        expect(afterCount, `triangles of mesh ${m} primitive ${p}`).toBe(beforeCount);
      }
    }
  });

  it('keeps every attribute semantic the source had', () => {
    const sourceMeshes = sourceDoc.getRoot().listMeshes();
    const decodedMeshes = decodedDoc.getRoot().listMeshes();
    for (let m = 0; m < sourceMeshes.length; m += 1) {
      const before = sourceMeshes[m].listPrimitives();
      const after = decodedMeshes[m].listPrimitives();
      for (let p = 0; p < before.length; p += 1) {
        expect(after[p].listSemantics().sort()).toEqual(before[p].listSemantics().sort());
      }
    }
  });
});

describe('T16 — existing_material_and_texture_extensions_survive', () => {
  const EXPECTED = [
    'KHR_texture_transform',
    'KHR_materials_emissive_strength',
    'KHR_materials_unlit',
  ];

  it('still declares the demo asset\'s three material extensions', () => {
    const json = readGlbJson(compressedBytes) as { extensionsUsed?: string[]; extensionsRequired?: string[] };
    for (const extension of EXPECTED) expect(json.extensionsUsed).toContain(extension);
    // Draco must be ADDED to extensionsRequired, not replace what was there.
    expect(json.extensionsRequired).toContain('KHR_materials_unlit');
  });

  it('keeps the extension VALUES, not just the declarations', () => {
    const materials = decodedDoc.getRoot().listMaterials();
    expect(materials.length).toBe(sourceDoc.getRoot().listMaterials().length);

    const emissive = materials.find((material) => material.getName() === 'EmissiveStrong');
    expect((emissive!.getExtension('KHR_materials_emissive_strength') as {
      getEmissiveStrength(): number;
    } | null)!.getEmissiveStrength()).toBeCloseTo(4.5, 6);

    const unlit = materials.find((material) => material.getName() === 'UnlitFlat');
    expect(unlit!.getExtension('KHR_materials_unlit')).not.toBeNull();

    const standard = materials.find((material) => material.getName() === 'StandardWithTransform');
    const transform = standard!.getBaseColorTextureInfo()!.getExtension('KHR_texture_transform') as {
      getScale(): number[]; getOffset(): number[]; getRotation(): number;
    } | null;
    expect(transform).not.toBeNull();
    expect([...transform!.getScale()]).toEqual([2, 2]);
    expect([...transform!.getOffset()]).toEqual([0.25, 0.125]);
    expect(transform!.getRotation()).toBeCloseTo(0.5, 6);
  });

  it('keeps the embedded texture', () => {
    expect(decodedDoc.getRoot().listTextures().length).toBe(sourceDoc.getRoot().listTextures().length);
    const texture = decodedDoc.getRoot().listTextures()[0];
    expect(texture.getMimeType()).toBe('image/png');
    expect(texture.getImage()!.length).toBeGreaterThan(0);
  });
});

describe('T17 — signature_step_order_is_respected', () => {
  // An ephemeral key: this test proves the ORDER of the steps, and must not
  // need the production signing key to do it. `verifyGlbBytes` takes the trust
  // root as an argument for exactly this.
  function ephemeralSigning() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return { signing: { privateKey, customerCert: null }, root: Buffer.from(jwk.x, 'base64url') };
  }

  it('compress -> sign yields a VALID signature (not merely a signable file)', () => {
    const { signing, root } = ephemeralSigning();
    const signed = signGlbBytes(compressedBytes, signing);
    expect(verifyGlbBytes(signed, root)).toBe('valid');
  });

  it('and the signed result still decodes as Draco geometry', async () => {
    const { signing, root } = ephemeralSigning();
    const signed = signGlbBytes(compressedBytes, signing);
    expect(verifyGlbBytes(signed, root)).toBe('valid');
    expect(hasDraco(signed)).toBe(true);

    // [VG-2] Signability alone proves nothing. Decode the SIGNED bytes and
    // compare against the decode of the unsigned Draco bytes: only that shows
    // compressing first leaves the whole chain intact.
    const io = await getIO();
    const signedDoc = await io.readBinary(signed);
    const signedIndex = indexByPath(signedDoc);
    expect([...signedIndex.keys()].sort()).toEqual([...decodedIndex.keys()].sort());
    for (const [path, before] of decodedIndex) {
      expect(signedIndex.get(path)!.extras, `extras at ${path}`).toEqual(before.extras);
    }

    const signedMeshes = signedDoc.getRoot().listMeshes();
    const decodedMeshes = decodedDoc.getRoot().listMeshes();
    expect(signedMeshes.length).toBe(decodedMeshes.length);
    let vertices = 0;
    for (let m = 0; m < signedMeshes.length; m += 1) {
      const a = decodedMeshes[m].listPrimitives();
      const b = signedMeshes[m].listPrimitives();
      expect(b.length).toBe(a.length);
      for (let p = 0; p < a.length; p += 1) {
        // Signing only rewrites the JSON chunk, so the decoded geometry must be
        // bit-identical here — no tolerance.
        expect(Array.from(b[p].getAttribute('POSITION')!.getArray()!))
          .toEqual(Array.from(a[p].getAttribute('POSITION')!.getArray()!));
        vertices += a[p].getAttribute('POSITION')!.getArray()!.length / 3;
      }
    }
    expect(vertices).toBeGreaterThan(0);
  }, 60_000);

  it('refuses the WRONG order: a signed GLB is never re-compressed', async () => {
    const { signing, root } = ephemeralSigning();
    // Sign the RAW fixture, then try to compress it — the order the plan forbids
    // (§F3 b). The guard turns the rule from a comment into behaviour.
    const signedSource = signGlbBytes(sourceBytes, signing);
    expect(verifyGlbBytes(signedSource, root)).toBe('valid');
    expect(isSigned(signedSource)).toBe(true);

    await expect(compressGlbBytes(signedSource)).rejects.toThrow(/signed GLB/i);

    // And proof the refusal is worth having: forcing it past the guard really
    // does destroy the signature.
    const forced = await compressGlbBytes(signedSource, { refuseSignedInput: false });
    expect(verifyGlbBytes(forced.bytes, root)).not.toBe('valid');
  }, 60_000);
});

describe('re-running the asset step', () => {
  it('is refused by default, because quantizing twice compounds the loss', async () => {
    const again = await compressGlbBytes(compressedBytes);
    expect(again.skipped).toBe(true);
    expect(again.reason).toMatch(/already declares/);
    expect(again.bytes.length).toBe(compressedBytes.length);
  });

  it('is possible with force, which is what makes the default a deliberate guard', async () => {
    const again = await compressGlbBytes(compressedBytes, { force: true });
    expect(again.skipped).toBe(false);
    expect(hasDraco(again.bytes)).toBe(true);
  }, 60_000);
});
