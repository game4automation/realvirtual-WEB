// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Readable text for baked chunk meshes (plan-505).
 *
 * A chunk mesh is the merged triangles of one boundary × partition × material
 * (plan-754 / plan-755). Its `Mesh.name` is the chunk KEY (`static`,
 * `mover:<path>|tex:<uuid>`, …) — an identity the pick/debug tooling reads, so
 * it never changes. What the hierarchy shows instead is "kind + size":
 *
 *   `Merged · 84.2k tris`             an uber chunk (one arena, many sources)
 *   `Brushed Steel · 12k tris`        a textured chunk, by material name
 *   `MC01.13 · Merged · 3k tris`      a partitioned chunk (plan-755 groups)
 *   `Chunk · 12 tris`                 a chunk mesh without bake metadata
 *
 * Deliberately NO boundary or file name: the old `[chunk] <parent name>` label
 * leaked the GLB file name through the model root.
 *
 * The data source is the geometry-keyed {@link chunkMetaOf} WeakMap — read-only,
 * one lookup per label, which keeps `sceneRow()` on its "few field reads" budget.
 */

import { SRGBColorSpace, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three';
import { chunkMetaOf } from '../engine/rv-bake-chunk';
import { isUberMaterial } from '../engine/rv-uber-material';

// ─── Types ───────────────────────────────────────────────────────────────

/** What the hierarchy row and the inspector know about one chunk mesh. */
export interface ChunkRowInfo {
  /** `merged` = uber chunk, `textured` = own material, `unknown` = no bake meta. */
  kind: 'merged' | 'textured' | 'unknown';
  /** The chunk's material name (textured chunks only). */
  materialName: string | null;
  /** plan-755 partition labels, sorted; empty for an unpartitioned chunk. */
  partitionLabels: readonly string[];
  triangles: number;
  vertices: number;
  /** Pick segments of the chunk (plan-756); null without bake meta. */
  segments: number | null;
  /** The boundary the chunk was baked into (mover or asset root). */
  owner: Object3D | null;
  /** sRGB hex (`#rrggbb`) for the swatch — untextured colour materials only
   *  (null for merged chunks and for texture-mapped materials). */
  swatchHex: string | null;
}

// ─── Number formatting ───────────────────────────────────────────────────

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat('en-US');

/** Compact count for a row label: `12`, `84.2k`, `1.2M`. */
export function formatTrisCompact(n: number): string {
  // en-US compact prints an upper-case `K`; the row vocabulary is `k`.
  return COMPACT.format(n).replace('K', 'k');
}

/** Full, grouped count for the inspector: `84,213`. */
export function formatCountFull(n: number): string {
  return FULL.format(n);
}

// ─── Chunk info ──────────────────────────────────────────────────────────

const NO_LABELS: readonly string[] = [];

function trianglesOfGeometry(geometry: BufferGeometry | undefined): number {
  if (!geometry) return 0;
  if (geometry.index) return Math.floor(geometry.index.count / 3);
  const pos = geometry.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

function verticesOfGeometry(geometry: BufferGeometry | undefined): number {
  return geometry?.getAttribute('position')?.count ?? 0;
}

function firstMaterial(material: Material | Material[] | undefined): Material | null {
  if (!material) return null;
  return Array.isArray(material) ? material[0] ?? null : material;
}

/** Everything a row or the inspector shows about `mesh`. Without bake meta
 *  (test fixtures, foreign `_rvBakeChunk` meshes) the counts come from the
 *  geometry and `kind` is `unknown`. */
export function chunkInfoOf(mesh: Mesh): ChunkRowInfo {
  const geometry = mesh.geometry as BufferGeometry | undefined;
  const meta = geometry ? chunkMetaOf.get(geometry) : undefined;
  if (!meta) {
    return {
      kind: 'unknown',
      materialName: null,
      partitionLabels: NO_LABELS,
      triangles: trianglesOfGeometry(geometry),
      vertices: verticesOfGeometry(geometry),
      segments: null,
      owner: null,
      swatchHex: null,
    };
  }
  const { chunk } = meta;
  const material = chunk.material ?? firstMaterial(mesh.material as Material | Material[] | undefined);
  const merged = isUberMaterial(material);
  // The swatch shows a material's own base colour. A texture-mapped material's
  // colour is a tint (usually white) and says nothing about what is drawn, so
  // it gets no swatch — only untextured colour materials do.
  let swatchHex: string | null = null;
  const mapped = !!material && 'map' in material && !!(material as Material & { map?: unknown }).map;
  if (!merged && !mapped && material && 'color' in material) {
    const color = (material as Material & { color?: { getHexString?: (cs?: string) => string } }).color;
    if (color && typeof color.getHexString === 'function') swatchHex = `#${color.getHexString(SRGBColorSpace)}`;
  }
  return {
    kind: merged ? 'merged' : 'textured',
    materialName: merged ? null : (material?.name || 'Material'),
    partitionLabels: chunk.partitionLabels ?? NO_LABELS,
    triangles: chunk.triangles,
    vertices: verticesOfGeometry(chunk.geometry ?? geometry),
    segments: chunk.pick ? chunk.pick.segmentCount : null,
    owner: chunk.owner ?? null,
    swatchHex,
  };
}

/** Triangles of one chunk mesh: the bake's count when known, else the geometry's. */
export function chunkTriangles(mesh: Mesh): number {
  const geometry = mesh.geometry as BufferGeometry | undefined;
  const meta = geometry ? chunkMetaOf.get(geometry) : undefined;
  return meta ? meta.chunk.triangles : trianglesOfGeometry(geometry);
}

// ─── Labels ──────────────────────────────────────────────────────────────

/**
 * Row label of a chunk mesh — "kind + size" (plan-505 F2).
 *
 * Hot path: called from `sceneRow()` for every visible chunk row. One WeakMap
 * lookup, one material check, one string.
 */
export function chunkRowLabel(mesh: Mesh): string {
  const geometry = mesh.geometry as BufferGeometry | undefined;
  const meta = geometry ? chunkMetaOf.get(geometry) : undefined;
  if (!meta) return `Chunk · ${formatTrisCompact(trianglesOfGeometry(geometry))} tris`;
  const { chunk } = meta;
  const material = chunk.material ?? firstMaterial(mesh.material as Material | Material[] | undefined);
  const kind = isUberMaterial(material) ? 'Merged' : (material?.name || 'Material');
  const labels = chunk.partitionLabels;
  const prefix = labels && labels.length > 0 ? `${labels.join(', ')} · ` : '';
  return `${prefix}${kind} · ${formatTrisCompact(chunk.triangles)} tris`;
}

/** Label of the display-only fold row that groups a boundary's chunks:
 *  `Geometry · 1 chunk · 12 tris`, `Geometry · 20 chunks · 1.2M tris`. */
export function foldRowLabel(count: number, tris: number): string {
  return `Geometry · ${count} chunk${count === 1 ? '' : 's'} · ${formatTrisCompact(tris)} tris`;
}
