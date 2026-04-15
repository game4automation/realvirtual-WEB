// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for WebViewer draw call reduction — material deduplication and
 * uber-material pattern (Deliverable 1 of the material-reduction plan).
 *
 * Covers:
 *   - Material fingerprint stability + collision avoidance
 *   - Array-material (multi-material mesh) in-place element replacement
 *     — the root cause of the previous "black materials" bug
 *   - Uber-material eligibility predicate
 *   - Per-vertex attribute baking (color + rmPacked as Uint8 normalized)
 *   - Geometry clone isolation (no mutation of shared geometry)
 *   - Singleton sharing + protection from clearModel disposal
 */

import { describe, it, expect } from 'vitest';
import {
  Object3D,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  BoxGeometry,
  BufferGeometry,
  Material,
  FrontSide,
  BackSide,
  DoubleSide,
  Color,
  Texture,
} from 'three';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import {
  RVUberMaterial,
  isUberEligible,
  classifyUberEligible,
  bakeMaterialToAttributes,
  applyUberMaterial,
} from '../src/core/engine/rv-uber-material';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMesh(mat: Material | Material[]): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), mat);
  return m;
}

function makeStandardMaterial(opts: Partial<{
  color: number;
  roughness: number;
  metalness: number;
  transparent: boolean;
  opacity: number;
}> = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: opts.color ?? 0xff0000,
    roughness: opts.roughness ?? 0.5,
    metalness: opts.metalness ?? 0.0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1.0,
  });
}

// ─── Material dedup ─────────────────────────────────────────────────────

describe('deduplicateMaterials — fingerprint', () => {
  it('collapses two visually identical materials onto one reference', () => {
    const root = new Object3D();
    const a = makeStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    const b = makeStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    expect(a).not.toBe(b); // two distinct instances
    root.add(makeMesh(a));
    root.add(makeMesh(b));

    const result = deduplicateMaterials(root);

    expect(result.originalCount).toBe(2);
    expect(result.uniqueCount).toBe(1);
    expect(result.disposedCount).toBe(1);
    const meshes = root.children as Mesh[];
    expect(meshes[0].material).toBe(meshes[1].material);
  });

  it('keeps materials with different colors separate', () => {
    const root = new Object3D();
    root.add(makeMesh(makeStandardMaterial({ color: 0xff0000 })));
    root.add(makeMesh(makeStandardMaterial({ color: 0x00ff00 })));

    const result = deduplicateMaterials(root);

    expect(result.uniqueCount).toBe(2);
    expect(result.disposedCount).toBe(0);
  });

  it('quantizes float fields so 0.5 and 0.5001 collide', () => {
    const root = new Object3D();
    root.add(makeMesh(makeStandardMaterial({ roughness: 0.5 })));
    root.add(makeMesh(makeStandardMaterial({ roughness: 0.5001 })));

    const result = deduplicateMaterials(root);

    expect(result.uniqueCount).toBe(1);
  });

  it('keeps materials with meaningfully different floats separate', () => {
    const root = new Object3D();
    root.add(makeMesh(makeStandardMaterial({ roughness: 0.5 })));
    root.add(makeMesh(makeStandardMaterial({ roughness: 0.6 })));

    const result = deduplicateMaterials(root);

    expect(result.uniqueCount).toBe(2);
  });

  it('keeps transparent and opaque apart even with same color', () => {
    const root = new Object3D();
    root.add(makeMesh(makeStandardMaterial({ color: 0xff0000, transparent: false })));
    root.add(makeMesh(makeStandardMaterial({ color: 0xff0000, transparent: true, opacity: 0.5 })));

    const result = deduplicateMaterials(root);

    expect(result.uniqueCount).toBe(2);
  });

  it('compares textures by source URL rather than UUID', () => {
    const root = new Object3D();
    // Two distinct Texture wrappers pointing at the same image src — common
    // GLTFLoader output pattern.
    const makeTextured = (): MeshStandardMaterial => {
      const mat = makeStandardMaterial();
      const tex = new Texture();
      (tex as unknown as { source: { data: { src: string } } }).source = {
        data: { src: 'https://example.com/atlas.png' },
      };
      mat.map = tex;
      return mat;
    };
    root.add(makeMesh(makeTextured()));
    root.add(makeMesh(makeTextured()));

    const result = deduplicateMaterials(root);

    expect(result.uniqueCount).toBe(1);
  });
});

describe('deduplicateMaterials — array-material safety', () => {
  it('replaces array elements in place without swapping the array reference', () => {
    // This is the regression test for the previous "black materials" bug.
    // If the dedup code did `mesh.material = dedupMap.get(fp)` on an array
    // material, the single replacement would silently discard the rest of
    // the array and geometry.groups would render against a single material.
    const root = new Object3D();
    const shared = makeStandardMaterial({ color: 0xff0000 });
    const dup = makeStandardMaterial({ color: 0xff0000 }); // same fingerprint
    const unique = makeStandardMaterial({ color: 0x00ff00 });

    const meshA = makeMesh([shared, unique]);
    const meshB = makeMesh([dup, unique]);
    const originalArrA = meshA.material as Material[];
    const originalArrB = meshB.material as Material[];
    root.add(meshA);
    root.add(meshB);

    const result = deduplicateMaterials(root);

    // Array references must not have been swapped
    expect(meshA.material).toBe(originalArrA);
    expect(meshB.material).toBe(originalArrB);
    // Both multi-material meshes still hold two-element arrays
    expect(Array.isArray(meshA.material) && (meshA.material as Material[]).length).toBe(2);
    expect(Array.isArray(meshB.material) && (meshB.material as Material[]).length).toBe(2);
    // The duplicate element was replaced in-place with the shared reference
    expect((meshA.material as Material[])[0]).toBe((meshB.material as Material[])[0]);
    // The unique element keeps its original reference on both
    expect((meshA.material as Material[])[1]).toBe(unique);
    expect((meshB.material as Material[])[1]).toBe(unique);
    // 4 elements total, 2 unique (shared + unique), 1 collapsed (dup → shared)
    expect(result.originalCount).toBe(4);
    expect(result.uniqueCount).toBe(2);
    expect(result.disposedCount).toBe(1);
  });

  it('handles mesh that shares the same material reference twice via multiple meshes', () => {
    const root = new Object3D();
    const shared = makeStandardMaterial({ color: 0x123456 });
    root.add(makeMesh(shared));
    root.add(makeMesh(shared));
    root.add(makeMesh(shared));

    const result = deduplicateMaterials(root);

    // Each mesh contributes one reference to originalCount, but shared
    // references resolve to the same unique entry.
    expect(result.originalCount).toBe(3);
    expect(result.uniqueCount).toBe(1);
    expect(result.disposedCount).toBe(0); // nothing was replaced — same ref
  });
});

// ─── RVUberMaterial class ────────────────────────────────────────────────

describe('RVUberMaterial', () => {
  it('has vertexColors enabled and identity uniforms', () => {
    const mat = new RVUberMaterial();
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.r).toBe(1);
    expect(mat.color.g).toBe(1);
    expect(mat.color.b).toBe(1);
    expect(mat.roughness).toBe(1.0);
    expect(mat.metalness).toBe(0.0);
    expect(mat.side).toBe(FrontSide);
  });

  it('is tagged with userData._rvShared = true', () => {
    const mat = new RVUberMaterial();
    expect(mat.userData._rvShared).toBe(true);
  });

  it('returns a constant program cache key so all instances share one WebGL program', () => {
    const a = new RVUberMaterial();
    const b = new RVUberMaterial();
    expect(a.customProgramCacheKey!()).toBe(b.customProgramCacheKey!());
    expect(a.customProgramCacheKey!()).toBe('__rvUberMaterial_v1');
  });

  it('has an onBeforeCompile that patches both vertex and fragment shader', () => {
    const mat = new RVUberMaterial();
    expect(typeof mat.onBeforeCompile).toBe('function');
    // Simulate the exact anchors from the real three.js meshphysical shader:
    // - vertex: #include <common> and #include <begin_vertex>
    // - fragment: #include <common>, #include <roughnessmap_fragment>,
    //             #include <metalnessmap_fragment>
    // The fragment shader's actual roughness/metalness assignments live
    // INSIDE those included chunks, not in the top-level source, so the
    // patch must target the include directives themselves.
    const shader = {
      uniforms: {},
      vertexShader:
        '#include <common>\nvoid main(){\n#include <begin_vertex>\n}',
      fragmentShader:
        '#include <common>\nvoid main(){\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n}',
    };
    mat.onBeforeCompile(shader as never, null as never);

    // Vertex: custom attribute declared and assigned to varying
    expect(shader.vertexShader).toContain('attribute vec2 rmPacked;');
    expect(shader.vertexShader).toContain('varying vec2 vRm;');
    expect(shader.vertexShader).toContain('vRm = rmPacked;');

    // Fragment: varying declared, AND per-vertex override written AFTER each
    // chunk so the chunk's default roughnessFactor/metalnessFactor
    // assignment gets overwritten with the attribute value.
    expect(shader.fragmentShader).toContain('varying vec2 vRm;');
    expect(shader.fragmentShader).toContain('#include <roughnessmap_fragment>\nroughnessFactor = vRm.x;');
    expect(shader.fragmentShader).toContain('#include <metalnessmap_fragment>\nmetalnessFactor = vRm.y;');
  });

  it('onBeforeCompile throws nothing (no silent regressions) on a real three.js-style source', () => {
    // A faithful fragment of the meshphysical_frag.glsl surrounding the
    // roughness/metalness includes. If three.js ever renames or removes
    // these chunks, the replace would silently no-op and the shader would
    // render as fully rough non-metallic (uniforms = 1.0, 0.0). This test
    // verifies the anchor strings are still present in the result after
    // patching.
    const mat = new RVUberMaterial();
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n\nvoid main() {\n\t#include <uv_vertex>\n\t#include <color_vertex>\n\t#include <begin_vertex>\n}',
      fragmentShader:
        '#include <common>\n#include <packing>\n\nvoid main() {\n\tvec4 diffuseColor = vec4( diffuse, opacity );\n\t#include <roughnessmap_fragment>\n\t#include <metalnessmap_fragment>\n}',
    };
    mat.onBeforeCompile(shader as never, null as never);
    // Both anchors must have been found and patched — if either replace is
    // a no-op the shader renders with identity uniforms and the user sees
    // fully-rough / non-metallic material regardless of baked values.
    expect(shader.fragmentShader).toMatch(
      /#include <roughnessmap_fragment>\s*\n?\s*roughnessFactor = vRm\.x;/
    );
    expect(shader.fragmentShader).toMatch(
      /#include <metalnessmap_fragment>\s*\n?\s*metalnessFactor = vRm\.y;/
    );
  });
});

// ─── Uber eligibility predicate ─────────────────────────────────────────

describe('isUberEligible', () => {
  it('accepts a plain untextured MeshStandardMaterial', () => {
    const mat = makeStandardMaterial();
    expect(isUberEligible(mat)).toBe(true);
  });

  it('rejects a MeshBasicMaterial (not Standard)', () => {
    const mat = new MeshBasicMaterial({ color: 0xff0000 });
    expect(isUberEligible(mat)).toBe(false);
  });

  it('rejects a material with a color map', () => {
    const mat = makeStandardMaterial();
    mat.map = new Texture();
    expect(isUberEligible(mat)).toBe(false);
  });

  it('rejects a material with a normalMap', () => {
    const mat = makeStandardMaterial();
    mat.normalMap = new Texture();
    expect(isUberEligible(mat)).toBe(false);
  });

  it('rejects a transparent material', () => {
    const mat = makeStandardMaterial({ transparent: true, opacity: 0.5 });
    expect(isUberEligible(mat)).toBe(false);
  });

  it('rejects BackSide / DoubleSide', () => {
    const back = makeStandardMaterial();
    back.side = BackSide;
    expect(isUberEligible(back)).toBe(false);
    const dbl = makeStandardMaterial();
    dbl.side = DoubleSide;
    expect(isUberEligible(dbl)).toBe(false);
  });

  it('rejects a material with vertexColors already enabled', () => {
    const mat = makeStandardMaterial();
    mat.vertexColors = true;
    expect(isUberEligible(mat)).toBe(false);
  });

  it('rejects a material with non-zero emissive', () => {
    const mat = makeStandardMaterial();
    mat.emissive = new Color(1, 0, 0);
    mat.emissiveIntensity = 1;
    expect(isUberEligible(mat)).toBe(false);
  });

  it('accepts a material with emissive color but zero intensity', () => {
    const mat = makeStandardMaterial();
    mat.emissive = new Color(1, 0, 0);
    mat.emissiveIntensity = 0;
    expect(isUberEligible(mat)).toBe(true);
  });

  it('rejects a flat-shaded material', () => {
    const mat = makeStandardMaterial();
    mat.flatShading = true;
    expect(isUberEligible(mat)).toBe(false);
  });
});

describe('classifyUberEligible', () => {
  it('filters a mixed set down to eligible materials only', () => {
    const good = makeStandardMaterial();
    const badTextured = makeStandardMaterial();
    badTextured.map = new Texture();
    const badBasic = new MeshBasicMaterial();
    const input = new Set<Material>([good, badTextured, badBasic]);

    const out = classifyUberEligible(input);

    expect(out.has(good)).toBe(true);
    expect(out.has(badTextured)).toBe(false);
    expect(out.has(badBasic)).toBe(false);
    expect(out.size).toBe(1);
  });
});

// ─── Attribute baking ───────────────────────────────────────────────────

describe('bakeMaterialToAttributes', () => {
  it('writes color and rmPacked attributes as Uint8 normalized', () => {
    const mesh = makeMesh(makeStandardMaterial());
    const originalGeom = mesh.geometry;
    const sharedUber = new RVUberMaterial();

    // Build the original material and set its color directly in linear space
    // to sidestep the sRGB → linear hex parsing. The baker reads from
    // material.color (linear) and writes linear bytes into the attribute,
    // which is what three.js vertexColors expects.
    const originalMat = makeStandardMaterial({ roughness: 0.25, metalness: 0.75 });
    originalMat.color.setRGB(1.0, 0.5, 0.25); // linear values, no sRGB curve
    bakeMaterialToAttributes(mesh, sharedUber, originalMat);

    // Geometry was cloned, not mutated in place
    expect(mesh.geometry).not.toBe(originalGeom);
    // Original geometry has no baked attributes
    expect(originalGeom.attributes.color).toBeUndefined();
    expect(originalGeom.attributes.rmPacked).toBeUndefined();

    // New geometry has them
    const colorAttr = mesh.geometry.attributes.color;
    const rmAttr = mesh.geometry.attributes.rmPacked;
    expect(colorAttr).toBeDefined();
    expect(rmAttr).toBeDefined();
    expect(colorAttr.itemSize).toBe(3);
    expect(rmAttr.itemSize).toBe(2);
    expect(colorAttr.normalized).toBe(true);
    expect(rmAttr.normalized).toBe(true);
    expect(colorAttr.array).toBeInstanceOf(Uint8Array);
    expect(rmAttr.array).toBeInstanceOf(Uint8Array);

    // Every vertex gets the same color/rm values (linear space)
    const colorArr = colorAttr.array as Uint8Array;
    const vCount = mesh.geometry.attributes.position.count;
    for (let i = 0; i < vCount; i++) {
      expect(colorArr[i * 3]).toBe(255);                  // 1.0 * 255
      expect(colorArr[i * 3 + 1]).toBe(Math.round(0.5 * 255));   // 128
      expect(colorArr[i * 3 + 2]).toBe(Math.round(0.25 * 255));  // 64
    }
    const rmArr = rmAttr.array as Uint8Array;
    for (let i = 0; i < vCount; i++) {
      expect(rmArr[i * 2]).toBe(Math.round(0.25 * 255));    // 64
      expect(rmArr[i * 2 + 1]).toBe(Math.round(0.75 * 255)); // 191
    }

    // Mesh is now on the shared uber material
    expect(mesh.material).toBe(sharedUber);
    expect(mesh.userData._rvUberBaked).toBe(true);
  });

  it('does not mutate geometry shared with other meshes', () => {
    const sharedGeom: BufferGeometry = new BoxGeometry(1, 1, 1);
    const meshA = new Mesh(sharedGeom, makeStandardMaterial({ color: 0xff0000 }));
    const meshB = new Mesh(sharedGeom, makeStandardMaterial({ color: 0x0000ff }));
    expect(meshA.geometry).toBe(meshB.geometry);

    const uber = new RVUberMaterial();
    bakeMaterialToAttributes(meshA, uber, meshA.material as MeshStandardMaterial);

    // meshB's geometry reference is unchanged, and still has no baked attrs
    expect(meshB.geometry).toBe(sharedGeom);
    expect(sharedGeom.attributes.color).toBeUndefined();
    expect(sharedGeom.attributes.rmPacked).toBeUndefined();
    // meshA's geometry is a fresh clone
    expect(meshA.geometry).not.toBe(sharedGeom);
  });
});

// ─── End-to-end applyUberMaterial ────────────────────────────────────────

describe('applyUberMaterial', () => {
  it('collapses eligible materials onto one shared RVUberMaterial', () => {
    const root = new Object3D();
    const matA = makeStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    const matB = makeStandardMaterial({ color: 0x00ff00, roughness: 0.3 });
    const matTextured = makeStandardMaterial();
    matTextured.map = new Texture();
    root.add(makeMesh(matA));
    root.add(makeMesh(matB));
    root.add(makeMesh(matTextured));

    const dedupedMaterials = new Set<Material>([matA, matB, matTextured]);
    const result = applyUberMaterial(root, dedupedMaterials);

    expect(result.eligibleMaterialCount).toBe(2);
    expect(result.bakedMeshCount).toBe(2);
    expect(result.sharedMaterial).toBeInstanceOf(RVUberMaterial);

    // Both uber-eligible meshes now reference the shared uber material
    const meshes = root.children as Mesh[];
    expect(meshes[0].material).toBe(result.sharedMaterial);
    expect(meshes[1].material).toBe(result.sharedMaterial);
    // Textured mesh is untouched
    expect(meshes[2].material).toBe(matTextured);
    expect((meshes[2] as Mesh).userData._rvUberBaked).toBeUndefined();

    // dedupedMaterials was mutated: collapsed entries removed, uber added
    expect(dedupedMaterials.has(matA)).toBe(false);
    expect(dedupedMaterials.has(matB)).toBe(false);
    expect(dedupedMaterials.has(matTextured)).toBe(true);
    expect(dedupedMaterials.has(result.sharedMaterial!)).toBe(true);
    expect(dedupedMaterials.size).toBe(2); // textured + uber
  });

  it('no-ops and returns null sharedMaterial when nothing is eligible', () => {
    const root = new Object3D();
    const textured = makeStandardMaterial();
    textured.map = new Texture();
    root.add(makeMesh(textured));

    const dedupedMaterials = new Set<Material>([textured]);
    const result = applyUberMaterial(root, dedupedMaterials);

    expect(result.bakedMeshCount).toBe(0);
    expect(result.sharedMaterial).toBeNull();
    expect(dedupedMaterials.size).toBe(1);
    expect(dedupedMaterials.has(textured)).toBe(true);
  });

  it('skips multi-material meshes even if elements would be eligible', () => {
    // Phase 2 deliberately leaves array-material meshes on deduped materials
    // and defers uber-collapse to a later phase. The predicate does not fire.
    const root = new Object3D();
    const m1 = makeStandardMaterial({ color: 0xff0000 });
    const m2 = makeStandardMaterial({ color: 0x00ff00 });
    root.add(makeMesh([m1, m2]));

    const dedupedMaterials = new Set<Material>([m1, m2]);
    const result = applyUberMaterial(root, dedupedMaterials);

    expect(result.bakedMeshCount).toBe(0);
    expect(result.sharedMaterial).toBeNull();
  });

  it('pipeline: dedup then uber collapses all untextured onto one reference', () => {
    // Integration: two identical red + two identical blue + one textured
    // → after dedup: 3 unique materials → after uber: 1 uber + 1 textured
    const root = new Object3D();
    const textured = makeStandardMaterial();
    textured.map = new Texture();
    (textured.map as unknown as { source: { data: { src: string } } }).source = {
      data: { src: 'foo.png' },
    };
    root.add(makeMesh(makeStandardMaterial({ color: 0xff0000 })));
    root.add(makeMesh(makeStandardMaterial({ color: 0xff0000 })));
    root.add(makeMesh(makeStandardMaterial({ color: 0x0000ff })));
    root.add(makeMesh(makeStandardMaterial({ color: 0x0000ff })));
    root.add(makeMesh(textured));

    const dedup = deduplicateMaterials(root);
    expect(dedup.uniqueCount).toBe(3);

    const uber = applyUberMaterial(root, dedup.uniqueMaterials);
    expect(uber.bakedMeshCount).toBe(4);
    expect(uber.sharedMaterial).toBeInstanceOf(RVUberMaterial);

    // Post-pipeline: every untextured mesh points at the same uber reference
    const meshes = root.children as Mesh[];
    expect(meshes[0].material).toBe(uber.sharedMaterial);
    expect(meshes[1].material).toBe(uber.sharedMaterial);
    expect(meshes[2].material).toBe(uber.sharedMaterial);
    expect(meshes[3].material).toBe(uber.sharedMaterial);
    expect(meshes[4].material).toBe(textured);
    // Final unique material set: 2 (uber + textured)
    expect(dedup.uniqueMaterials.size).toBe(2);
  });
});
