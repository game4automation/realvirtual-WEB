// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-stats — material & texture health of the asset being edited.
 *
 * Feeds the summary at the top of the Materials window. Deliberately scoped to
 * MATERIALS AND TEXTURES only: triangle counts, draw calls and geometry stats
 * already live in Settings → Dev Tools, and repeating them here would just make
 * the panel a worse version of that one.
 *
 * Every warning is ACTIONABLE — it carries the mesh paths it refers to, so the
 * panel can select the offending parts in the viewport when the user clicks it.
 * A warning the user cannot act on does not belong in this list.
 *
 * Pure: takes an Object3D, returns data. No viewer, no React, no side effects.
 */

import { Object3D, Mesh, Material, Texture, MeshStandardMaterial } from 'three';
import { fingerprint } from '../../../core/engine/rv-material-dedup';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';

/** Textures at or above this size are flagged as oversized for a machine part. */
const LARGE_TEXTURE_PX = 2048;

export type WarningSeverity = 'warning' | 'info';

export interface MaterialWarning {
  id: string;
  severity: WarningSeverity;
  /** Short headline, e.g. "12 duplicate materials". */
  label: string;
  /** One sentence saying why it matters and what the fix is. */
  detail: string;
  /** Mesh paths this warning refers to — clicking the warning selects them. */
  meshPaths: string[];
}

export interface MaterialStats {
  /** Distinct Material instances attached to the asset. */
  materialCount: number;
  /** Distinct materials by APPEARANCE — the floor `Merge duplicates` reaches. */
  uniqueByAppearance: number;
  /** Meshes carrying at least one material. */
  meshCount: number;
  /** Distinct textures, keyed by image source. */
  textureCount: number;
  /** Estimated GPU texture memory, bytes (RGBA + mipmaps). */
  textureBytes: number;
  warnings: MaterialWarning[];
}

/** Per-material record built during the walk. */
interface MatEntry {
  material: Material;
  meshPaths: string[];
}

/**
 * Walk the asset once and summarize its materials and textures.
 *
 * Multi-material meshes contribute every array slot — they are excluded from
 * *painting* (see `collectPaintableMeshes`) but they still consume materials and
 * textures, so omitting them here would under-report the asset.
 */
export function computeMaterialStats(root: Object3D | null): MaterialStats {
  const empty: MaterialStats = {
    materialCount: 0, uniqueByAppearance: 0, meshCount: 0,
    textureCount: 0, textureBytes: 0, warnings: [],
  };
  if (!root) return empty;

  const byMaterial = new Map<Material, MatEntry>();
  const textures = new Map<string, Texture>();
  let meshCount = 0;

  root.traverse((child) => {
    if (child.name.startsWith('_')) return; // runtime helpers/overlays
    const mesh = child as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.material) return;

    const path = NodeRegistry.computeNodePath(mesh);
    meshCount++;

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const entry = byMaterial.get(mat);
      if (entry) entry.meshPaths.push(path);
      else byMaterial.set(mat, { material: mat, meshPaths: [path] });
      collectTextures(mat, textures);
    }
  });

  // Group by appearance to find instances that differ only by identity.
  const byAppearance = new Map<string, MatEntry[]>();
  for (const entry of byMaterial.values()) {
    const fp = fingerprint(entry.material);
    const bucket = byAppearance.get(fp);
    if (bucket) bucket.push(entry);
    else byAppearance.set(fp, [entry]);
  }

  let textureBytes = 0;
  for (const tex of textures.values()) textureBytes += estimateTextureBytes(tex);

  return {
    materialCount: byMaterial.size,
    uniqueByAppearance: byAppearance.size,
    meshCount,
    textureCount: textures.size,
    textureBytes,
    warnings: buildWarnings(byAppearance, textures, byMaterial),
  };
}

/** Human-readable byte size, e.g. "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── internals ──────────────────────────────────────────────────────────

const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap',
  'aoMap', 'emissiveMap', 'alphaMap', 'lightMap',
] as const;

function collectTextures(mat: Material, into: Map<string, Texture>): void {
  const m = mat as unknown as Record<string, Texture | null | undefined>;
  for (const slot of TEXTURE_SLOTS) {
    const tex = m[slot];
    if (tex) into.set(textureKey(tex), tex);
  }
}

/** Identity by image source — one image wrapped in two Textures is one texture. */
function textureKey(t: Texture): string {
  const src = (t.source as unknown as { data?: { src?: string } } | undefined)?.data?.src;
  if (src) return src;
  const imgSrc = (t.image as unknown as { src?: string } | undefined)?.src;
  return imgSrc ?? t.uuid;
}

function textureSize(t: Texture): { w: number; h: number } | null {
  const img = t.image as { width?: number; height?: number } | undefined;
  if (!img?.width || !img?.height) return null;
  return { w: img.width, h: img.height };
}

/** RGBA8 plus the ~1/3 a full mip chain adds. Approximate by design — the point
 *  is the order of magnitude, not an exact GPU figure. */
function estimateTextureBytes(t: Texture): number {
  const size = textureSize(t);
  if (!size) return 0;
  return Math.round(size.w * size.h * 4 * (t.generateMipmaps === false ? 1 : 4 / 3));
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function buildWarnings(
  byAppearance: Map<string, MatEntry[]>,
  textures: Map<string, Texture>,
  byMaterial: Map<Material, MatEntry>,
): MaterialWarning[] {
  const warnings: MaterialWarning[] = [];

  // ── Duplicate materials ────────────────────────────────────────────────
  // Groups where several distinct instances render identically. Collapsing
  // them is what lets the batched renderer put those parts in one arena, so
  // this is the single highest-value cleanup on a freshly imported assembly.
  const dupPaths: string[] = [];
  let redundant = 0;
  for (const bucket of byAppearance.values()) {
    if (bucket.length < 2) continue;
    redundant += bucket.length - 1;
    for (const entry of bucket) dupPaths.push(...entry.meshPaths);
  }
  if (redundant > 0) {
    warnings.push({
      id: 'duplicate-materials',
      severity: 'warning',
      label: `${redundant} duplicate material${redundant === 1 ? '' : 's'}`,
      detail: 'Distinct materials that render identically. Merging them reduces '
        + 'draw calls in the batched viewer and shrinks the exported GLB.',
      meshPaths: dupPaths,
    });
  }

  // ── Texture problems ───────────────────────────────────────────────────
  const oversized: string[] = [];
  const nonPot: string[] = [];
  for (const tex of textures.values()) {
    const size = textureSize(tex);
    if (!size) continue;
    if (size.w >= LARGE_TEXTURE_PX || size.h >= LARGE_TEXTURE_PX) {
      oversized.push(`${size.w}×${size.h}`);
    }
    if (!isPowerOfTwo(size.w) || !isPowerOfTwo(size.h)) {
      nonPot.push(`${size.w}×${size.h}`);
    }
  }
  if (oversized.length > 0) {
    warnings.push({
      id: 'oversized-textures',
      severity: 'warning',
      label: `${oversized.length} oversized texture${oversized.length === 1 ? '' : 's'}`,
      detail: `${LARGE_TEXTURE_PX}px or larger (${oversized.slice(0, 3).join(', ')}`
        + `${oversized.length > 3 ? ', …' : ''}). Machine parts rarely need more `
        + 'than 1K — downscaling cuts load time and GPU memory.',
      meshPaths: meshPathsForTexturePredicate(byMaterial, (t) => {
        const s = textureSize(t);
        return !!s && (s.w >= LARGE_TEXTURE_PX || s.h >= LARGE_TEXTURE_PX);
      }),
    });
  }
  if (nonPot.length > 0) {
    warnings.push({
      id: 'npot-textures',
      severity: 'info',
      label: `${nonPot.length} non-power-of-two texture${nonPot.length === 1 ? '' : 's'}`,
      detail: 'Dimensions are not powers of two, so mipmapping and GPU compression '
        + 'may be unavailable. Resize to the nearest power of two where it matters.',
      meshPaths: meshPathsForTexturePredicate(byMaterial, (t) => {
        const s = textureSize(t);
        return !!s && (!isPowerOfTwo(s.w) || !isPowerOfTwo(s.h));
      }),
    });
  }

  // ── Transparency ───────────────────────────────────────────────────────
  // Transparent materials cannot share an opaque arena and force per-frame
  // sorting, so an accidental one (opacity 1 but the flag set) is worth naming.
  const transparentPaths: string[] = [];
  for (const entry of byMaterial.values()) {
    const m = entry.material as MeshStandardMaterial;
    if (m.transparent && m.opacity >= 1) transparentPaths.push(...entry.meshPaths);
  }
  if (transparentPaths.length > 0) {
    warnings.push({
      id: 'pointless-transparency',
      severity: 'info',
      label: 'Transparency with no effect',
      detail: 'Materials flagged transparent at full opacity. They pay the sorting '
        + 'cost of transparency and gain nothing — clear the flag or lower opacity.',
      meshPaths: transparentPaths,
    });
  }

  return warnings;
}

/** Mesh paths whose material carries a texture matching `pred`. */
function meshPathsForTexturePredicate(
  byMaterial: Map<Material, MatEntry>,
  pred: (t: Texture) => boolean,
): string[] {
  const out: string[] = [];
  for (const entry of byMaterial.values()) {
    const m = entry.material as unknown as Record<string, Texture | null | undefined>;
    for (const slot of TEXTURE_SLOTS) {
      const tex = m[slot];
      if (tex && pred(tex)) { out.push(...entry.meshPaths); break; }
    }
  }
  return out;
}
