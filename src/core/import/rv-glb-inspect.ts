// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-inspect — read a GLB's JSON chunk without decoding its geometry.
 *
 * Exists to make ONE class of failure impossible: `GLTFExporter` drops a mesh
 * whose attributes all have `count === 0` (processAccessor → null → processMesh →
 * null) and writes the node WITHOUT a mesh. No throw, no warning. Downstream you
 * get an object that appears in the hierarchy and renders nothing.
 *
 * Counting mesh-bearing nodes in the JSON chunk is cheap (the BIN chunk is never
 * touched), so every export can assert that it encoded as many meshes as it was
 * given.
 */

import { parseGlbChunks } from '../persistence/rv-glb-chunks';

/** The subset of glTF JSON this module reasons about. */
export interface GlbJson {
  nodes?: { name?: string; mesh?: number }[];
  meshes?: { name?: string; primitives?: unknown[] }[];
  accessors?: { count?: number }[];
}

/** Parse only the JSON chunk of a binary GLB. Throws when the bytes are not a GLB. */
export function readGlbJson(glb: ArrayBuffer): GlbJson {
  return parseGlbChunks(glb).json as GlbJson;
}

/** Number of nodes that actually reference a mesh. */
export function countGlbMeshNodes(json: GlbJson): number {
  return (json.nodes ?? []).filter((n) => n.mesh !== undefined).length;
}

/** Names of nodes that reference no mesh (candidates for a silent exporter drop). */
export function meshlessGlbNodeNames(json: GlbJson): string[] {
  return (json.nodes ?? []).filter((n) => n.mesh === undefined).map((n) => n.name ?? '<unnamed>');
}

/**
 * Assert the exporter encoded every mesh it was handed.
 *
 * `expected` is the mesh count of the tree that went in. A shortfall means
 * GLTFExporter silently discarded geometry — better a loud, precise error at
 * import time than an invisible object the user has to debug themselves.
 */
export function assertGlbMeshCount(glb: ArrayBuffer, expected: number, context: string): void {
  if (expected === 0) return;
  const json = readGlbJson(glb);
  const actual = countGlbMeshNodes(json);
  if (actual >= expected) return;

  const lost = expected - actual;
  const sample = meshlessGlbNodeNames(json).slice(0, 5).join(', ');
  throw new Error(
    `[${context}] GLB encoding lost ${lost} of ${expected} meshes — the exporter wrote ` +
    `${actual} mesh-bearing node(s). Those objects would appear in the hierarchy and render ` +
    `nothing.${sample ? ` First mesh-less nodes: ${sample}.` : ''}`,
  );
}
