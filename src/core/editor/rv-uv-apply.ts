// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-uv-apply — puts generated UVs into the editor's document (plan-675 Phase 1).
 *
 * The body behind `editor.generateUVs` and behind the automatic UV generation of
 * `editor.assignMaterial` for textured presets. UVs are a GEOMETRY replacement
 * (SOL review #4): per distinct (geometry, world scale) the pure generator
 * (`rv-uv-generate`) builds a complete new BufferGeometry, which is written to
 * a one-mesh GLB and applied through the existing `replaceNodeGeometry` op —
 * SHA-addressed in the CAD-GLB cache, undo = the previous geometry, replayable
 * after a reload. Several calls inside one `withTransaction` are one undo step.
 *
 * Meshes that share one geometry at the same world scale stay sharing (one op
 * with `sharedNodePaths`); a different scale gets its own geometry, because the
 * UVs are metric.
 *
 * Cylindrical UVs carry a per-node start phase (`phaseSeed` = the node path,
 * see rv-uv-generate), so the rollers of one curve do not all start with the
 * same texture phase. A shared geometry that resolves to `cylindrical` is
 * therefore split: every node gets its own geometry with its own phase. Planar
 * and box UVs have no phase and keep sharing.
 */

import { Mesh, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { NodeRegistry } from '../engine/rv-node-registry';
import { objectToGlb } from '../import/rv-import-object';
import { generateUVs, uvSkipReason, type GenerateUVsResult, type ResolvedUVMode, type UVMode } from './rv-uv-generate';
import type { CadConverter } from '../import/rv-cad-glb-cache';

export const UV_MODES: readonly UVMode[] = ['auto', 'cylindrical', 'planar', 'box'];

/** The part of the editor's document this module needs (an `AssetDocument` satisfies it). */
export interface UVTargetDocument {
  replaceNodeGeometry(
    nodePath: string, glbBytes: ArrayBuffer, converter: CadConverter,
    opts?: { quality?: string; sharedNodePaths?: string[] },
  ): Promise<{ sha256: string; prevSha256: string } | null>;
  readonly executor: { geometryKeyOf(geometry: BufferGeometry): { quality: string; converter?: CadConverter } | null };
}

export interface GeneratedUVEntry {
  path: string;
  mode: ResolvedUVMode;
  shapeClass: string;
  addedVertices: number;
  sharedWith?: number;
  radiusMm?: number;
  /** Start phase in revolutions baked into u (cylindrical only, seeded by the node path). */
  phase?: number;
}

export interface UVApplyResult {
  generated: GeneratedUVEntry[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Every mesh at or under the given nodes (deduped), with its registry path. Runtime helpers are skipped. */
export function collectUVMeshes(registry: NodeRegistry, nodePaths: readonly string[]): Array<{ mesh: Mesh; path: string }> {
  const seen = new Set<Mesh>();
  const out: Array<{ mesh: Mesh; path: string }> = [];
  for (const p of nodePaths) {
    const node = registry.getNode(p);
    if (!node) continue;
    node.traverse((child: Object3D) => {
      if (child.name.startsWith('_') || child.userData?._rvGizmo === true) return;
      const mesh = child as Mesh;
      if (!mesh.isMesh || !mesh.geometry || seen.has(mesh)) return;
      seen.add(mesh);
      out.push({ mesh, path: NodeRegistry.computeNodePath(mesh) });
    });
  }
  return out;
}

/** True when the geometry already carries texture coordinates. */
export function hasUVs(geometry: BufferGeometry): boolean {
  return !!geometry.getAttribute('uv');
}

const scaleKey = (v: Vector3): string => [v.x, v.y, v.z].map((x) => Math.abs(x).toPrecision(6)).join(',');

/**
 * Generate UVs for `meshes` and apply them as geometry replacements on `doc`.
 * Wrap the call in `doc.withTransaction` for a single undo step.
 */
export async function applyGeneratedUVs(
  doc: UVTargetDocument,
  meshes: ReadonlyArray<{ mesh: Mesh; path: string }>,
  mode: UVMode,
  overwrite: boolean,
): Promise<UVApplyResult> {
  const skipped: UVApplyResult['skipped'] = [];
  const generated: GeneratedUVEntry[] = [];
  // Group users by (geometry, metric scale): one op per group.
  const groups = new Map<BufferGeometry, Map<string, { scale: Vector3; paths: string[] }>>();
  for (const { mesh, path } of meshes) {
    const geometry = mesh.geometry as BufferGeometry;
    if (!overwrite && hasUVs(geometry)) { skipped.push({ path, reason: 'has-uv' }); continue; }
    const reason = uvSkipReason(geometry);
    if (reason) { skipped.push({ path, reason }); continue; }
    mesh.updateWorldMatrix(true, false);
    const scale = mesh.getWorldScale(new Vector3());
    // UVs are object-local; the asset root's own scale is part of "metres".
    let bySize = groups.get(geometry);
    if (!bySize) { bySize = new Map(); groups.set(geometry, bySize); }
    const k = scaleKey(scale);
    const g = bySize.get(k);
    if (g) g.paths.push(path); else bySize.set(k, { scale, paths: [path] });
  }
  // One job = one generated geometry applied to its paths. All geometries are
  // generated (and the source key read) BEFORE the first replacement, so a
  // split shared geometry is never read after a replacement swapped it out.
  type Job = { paths: string[]; result: GenerateUVsResult; basis: string; converter: CadConverter };
  const jobs: Job[] = [];
  for (const [geometry, bySize] of groups) {
    const known = doc.executor.geometryKeyOf(geometry);
    const basis = (known?.quality ?? 'source').split('|uv:')[0];
    const converter: CadConverter = known?.converter ?? 'browser';
    for (const { scale, paths } of bySize.values()) {
      const own: Job[] = [];
      try {
        const first = generateUVs(geometry, mode, scale, { phaseSeed: paths[0] });
        if (first.mode !== 'cylindrical' || paths.length === 1) {
          own.push({ paths, result: first, basis, converter });
        } else {
          // Cylindrical: every node its own start phase → its own geometry.
          own.push({ paths: [paths[0]], result: first, basis, converter });
          for (const p of paths.slice(1)) {
            own.push({ paths: [p], result: generateUVs(geometry, 'cylindrical', scale, { phaseSeed: p }), basis, converter });
          }
        }
      } catch (e) {
        for (const j of own) j.result.geometry.dispose();
        for (const p of paths) skipped.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      jobs.push(...own);
    }
  }
  for (const { paths, result, basis, converter } of jobs) {
    const tmp = new Mesh(result.geometry);
    let bytes: ArrayBuffer;
    try {
      // Geometry only: the hash must not depend on the geometry's userData.
      const ud = result.geometry.userData;
      result.geometry.userData = {};
      try { bytes = await objectToGlb(tmp); } finally { result.geometry.userData = ud; }
    } finally {
      (tmp.material as { dispose(): void }).dispose();
    }
    const [first, ...others] = paths;
    try {
      await doc.replaceNodeGeometry(first, bytes, converter, {
        quality: `${basis}|uv:v1:${result.mode}`,
        ...(others.length ? { sharedNodePaths: others } : {}),
      });
    } catch (e) {
      for (const p of paths) skipped.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
      result.geometry.dispose();
      continue;
    }
    result.geometry.dispose();
    for (const p of paths) {
      generated.push({
        path: p, mode: result.mode, shapeClass: result.shapeClass, addedVertices: result.addedVertices,
        ...(paths.length > 1 ? { sharedWith: paths.length - 1 } : {}),
        ...(result.radiusMm !== undefined ? { radiusMm: Math.round(result.radiusMm * 100) / 100 } : {}),
        ...(result.phase !== undefined ? { phase: result.phase } : {}),
      });
    }
  }
  return { generated, skipped };
}
