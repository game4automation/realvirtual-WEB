// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * "Baked geometry" — the property inspector's read-only section for a selected
 * chunk mesh (plan-505 F7).
 *
 * A chunk is the merged triangles of one boundary × partition × material
 * (plan-754 / plan-755). The generic "Mesh" section below it shows the
 * geometry block; this section says what the chunk IS: which boundary it was
 * baked into (a link to that node), its partition, its material, and its
 * size in triangles, vertices and pick segments. Everything comes from the
 * geometry-keyed `chunkMetaOf` table — read-only, nothing here touches the
 * bake or the pick structure.
 *
 * There is deliberately no list of CAD parts: the segments belong to the
 * surviving nodes, and the removed parts' names died with the throwaway graph
 * (plan-505 decision log).
 */

import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import type { Mesh, Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import { chunkMetaOf } from '../engine/rv-bake-chunk';
import { isChunkMesh } from '../engine/rv-node-classification';
import { chunkInfoOf, formatCountFull } from './chunk-row-labels';
import { navigateToRef } from './rv-reference-display';
import { runtimeRow } from './rv-component-section';
import { InspectorRow } from './rv-inspector-row';
import { FIELD_BORDER_HOVER, FS, INK_LOW, MONO } from './shared-sx';

/** Section title (also the ComponentSection's component type). */
export const BAKED_GEOMETRY_SECTION = 'Baked geometry';

/** Material text of an uber chunk: one arena, colours per vertex. */
export const MERGED_MATERIAL_TEXT = 'Merged (vertex colours)';

/** The registry path of `owner`, or of its nearest registered ancestor. */
function registeredPathOf(viewer: RVViewer, owner: Object3D | null): string | null {
  const registry = viewer.registry;
  if (!registry || !owner) return null;
  for (let a: Object3D | null = owner; a; a = a.parent) {
    const path = registry.getPathForNode(a);
    if (path) return path;
  }
  return null;
}

/** A small colour box + hex text (WCAG 1.4.1: the hex carries the value). */
function SwatchRow({ hex }: { hex: string }) {
  return (
    <InspectorRow label="Colour" labelTitle="Colour" labelColor={INK_LOW} minHeight={24} py={0.15}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Box
          data-testid="baked-geometry-swatch"
          aria-hidden
          sx={{
            width: 10,
            height: 10,
            flexShrink: 0,
            borderRadius: 0.25,
            border: `1px solid ${FIELD_BORDER_HOVER}`,
            bgcolor: hex,
          }}
        />
        <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: 'text.primary' }}>{hex}</Typography>
      </Box>
    </InspectorRow>
  );
}

/**
 * The "Baked geometry" virtual component for `node`, or null when `node` is
 * not a chunk mesh the bake registered (no `chunkMetaOf` entry).
 */
export function buildBakedGeometryVirtualComponent(
  viewer: RVViewer,
  node: Object3D | null,
): { type: string; data: Record<string, unknown>; extraContent?: ReactNode } | null {
  if (!node || !isChunkMesh(node)) return null;
  const mesh = node as Mesh;
  if (!mesh.geometry || !chunkMetaOf.has(mesh.geometry)) return null;
  const info = chunkInfoOf(mesh);

  const ownerName = info.owner ? (info.owner.name || info.owner.type) : '—';
  const ownerPath = registeredPathOf(viewer, info.owner);
  const data: Record<string, unknown> = {
    Boundary: ownerPath
      ? runtimeRow(ownerName, { onClick: () => navigateToRef(viewer, ownerPath) })
      : runtimeRow(ownerName),
    Partition: runtimeRow(info.partitionLabels.length > 0 ? info.partitionLabels.join(', ') : '—'),
    Material: runtimeRow(info.kind === 'merged' ? MERGED_MATERIAL_TEXT : (info.materialName ?? '—')),
    Triangles: runtimeRow(formatCountFull(info.triangles)),
    Vertices: runtimeRow(formatCountFull(info.vertices)),
    Segments: runtimeRow(info.segments !== null ? formatCountFull(info.segments) : '—'),
    'Chunk key': runtimeRow(mesh.name || '—'),
  };
  return {
    type: BAKED_GEOMETRY_SECTION,
    data,
    extraContent: info.swatchHex ? <SwatchRow hex={info.swatchHex} /> : undefined,
  };
}
