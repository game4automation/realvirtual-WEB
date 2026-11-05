// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Mesh, Object3D, Texture } from 'three';
import { modelLayerLengthBound, serializedLengthBound, UsdExportTooLargeError, type ModelLayerBoundOptions } from './usd-export-geometry-split';
import type { StagePostOptions } from './usd-stage-post';

/**
 * Provisional: confirm with a browser probe on the development machine.
 * A large model failed near 2 GiB with "Failed to construct 'Blob'";
 * 1.5 GiB leaves headroom. This module belongs to the lazy USD export path.
 */
export const MAX_USDZ_PACKAGE_BYTES = 1_610_612_736;
let limitBytes = MAX_USDZ_PACKAGE_BYTES;

/** Tests only; restore even when the export throws. */
export function setUsdPackageLimitForTests(next: number): () => void {
  const before = limitBytes;
  limitBytes = next;
  return () => { limitBytes = before; };
}

export type UsdzPackageFiles = Readonly<Record<string, number | Uint8Array | readonly Uint8Array[]>>;

/** UTF-8 size without allocating an encoded copy (also handles lone surrogates). */
function utf8Length(text: string): number {
  let size = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    size += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return size;
}

/**
 * Upper bound for our STORED USDZ writers, independent of entry order:
 * local header (30 + UTF-8 name), extra-field header (4) + at most 64
 * padding bytes; central directory (46 + name) REPEATS that extra field;
 * EOCD (22). No comments or compression. Counts chunked layers without joining.
 */
export function estimateUsdzPackageBytes(files: UsdzPackageFiles): number {
  let total = 22;
  for (const [name, data] of Object.entries(files)) {
    const size = typeof data === 'number' ? data : data instanceof Uint8Array ? data.byteLength
      : data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    total += size + 30 + 46 + 2 * utf8Length(name) + 2 * (4 + 64);
  }
  return total;
}

/** Exact byte sizes and conservative estimates use the same refusal path. */
export function assertUsdzPackageSize(estimatedBytes: number): void {
  if (!Number.isFinite(estimatedBytes) || estimatedBytes > limitBytes) {
    throw new UsdExportTooLargeError('usd-package-too-large', 'model.usda', estimatedBytes, limitBytes);
  }
}

export function assertUsdzFilesFit(files: UsdzPackageFiles): void {
  assertUsdzPackageSize(estimateUsdzPackageBytes(files));
}

const TEXTURE_SLOTS = ['map', 'emissiveMap', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap',
  'alphaMap', 'clearcoatMap', 'clearcoatRoughnessMap'] as const;

export interface StagePackageBoundOptions extends ModelLayerBoundOptions {
  /** Post-export additions must be included before the exporter's FIRST ZIP. */
  post: StagePostOptions;
}

/**
 * Call on the temporarily split export tree, immediately BEFORE parseAsync.
 * Geometry numbers, exporter identifiers and placeholder prim names are ASCII:
 * their text bytes equal the character bounds from plan-2246. Authored metadata
 * is counted separately with UTF-8/quoting headroom, as are renamed prims and
 * post-pass channels (full precision, matrix fallback and visibility compat).
 *
 * Texture residual uncertainty: canvas.toBlob is browser-owned; its PNG/JPEG
 * encoded size/metadata has no cross-browser contractual upper bound. Reserve
 * twice RGBA at the exporter's default 1024px edge plus 64 KiB per unique
 * texture source/flip pair. This is conservative for ordinary browser encoders, not a
 * proof for arbitrary encoders. The complete file check before repacking is
 * authoritative, but cannot undo the exporter's earlier texture/ZIP allocation.
 */
export function estimateStageUsdzPackageBytes(scene: Object3D, options: StagePackageBoundOptions): number {
  const files: Record<string, number> = { 'model.usda': modelLayerLengthBound(scene, options) };
  let maxDepth = 3, nodes = 0;
  const materials = new Set<string>(), textures = new Set<string>();
  const visit = (node: Object3D, depth: number): void => {
    if (!node.visible) return;
    nodes++;
    maxDepth = Math.max(maxDepth, depth);
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      if (!Array.isArray(mesh.material) && mesh.geometry?.attributes.position) {
        files[`geometries/Geometry_${mesh.geometry.id}.usda`] = serializedLengthBound(mesh.geometry);
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material) continue;
        if (materials.has(material.uuid)) continue;
        materials.add(material.uuid);
        const maps = material as unknown as Partial<Record<typeof TEXTURE_SLOTS[number], Texture>>;
        for (const key of TEXTURE_SLOTS) if (maps[key]) {
          const texture = maps[key]!;
          const id = `${texture.source.id}_${texture.flipY}`;
          if (textures.has(id)) continue;
          textures.add(id);
          files[`textures/Texture_${id}.png`] = 1024 * 1024 * 8 + 65536;
        }
      }
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const child of scene.children) visit(child, 3);
  const post = options.post;
  // Wrappers, material relocation, primvar readers and subset-family edits.
  let additions = 4096 + nodes * (1024 + maxDepth * 32) + materials.size * 2048;
  for (const name of post.finalNames) additions += 6 * name.length;
  for (const name of post.partNames?.values() ?? []) additions += 6 * name.length;
  for (const data of post.prims?.values() ?? []) {
    if (post.writeAddresses !== false) for (const [key, value] of Object.entries(data.customData ?? {})) {
      if (typeof value !== 'string') continue;
      additions += 128 + 6 * (key.length + value.length) + 8 * maxDepth;
    }
    for (const channel of [data.matrix, data.translate, data.orient, data.scale]) if (channel) {
      // 32 bytes per number covers finite JS doubles/toPrecision(9), tuple
      // punctuation; frame keys and indentation are additional per sample.
      additions += 512 + 32 * (channel.values.length + channel.defaultValue.length)
        + channel.frames.length * (64 + maxDepth * 4);
    }
    // At most two compatibility scale samples per visibility sample.
    additions += 512 + (data.visibilitySamples?.length ?? 0) * (256 + maxDepth * 8);
  }
  files['model.usda'] += additions;
  return estimateUsdzPackageBytes(files);
}

export function assertStageUsdzPackageFits(scene: Object3D, options: StagePackageBoundOptions): void {
  assertUsdzPackageSize(estimateStageUsdzPackageBytes(scene, options));
}
