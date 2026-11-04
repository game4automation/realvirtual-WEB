// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-741 §9.6 — the GLB round-trip.
 *
 * The whole point of the DXF provider's design is that it produces a GLB and
 * then stops being special: cache, op log, placement and reload all treat it
 * like any other asset. That only holds if the bytes survive the trip, so this
 * is the test that would catch the design failing — layer hierarchy, vertex
 * colours, the informational extras, the world size in metres, and above all
 * the reload re-pivot being a no-op.
 */
import { describe, it, expect } from 'vitest';
import { Box3, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { pivotToFloorCenter } from '../src/core/engine/rv-placement-pivot';
import { parseDxf } from '@rv-private/plugins/dxf-import/dxf-parse';
import { entitiesToGeometry } from '@rv-private/plugins/dxf-import/dxf-geometry';
import { buildLayerBuffers } from '@rv-private/plugins/dxf-import/dxf-ribbon';
import {
  dxfToObject3D,
  polylinesForRibbons,
  DXF_FLOOR_CLEARANCE_M,
} from '@rv-private/plugins/dxf-import/dxf-to-three';
import {
  DEFAULT_DXF_OPTIONS,
  type DxfImportOptions,
} from '@rv-private/plugins/dxf-import/dxf-import.types';

// ─── Fixture ────────────────────────────────────────────────────────────

/** Two layers in ACI red and green, spanning 60 m × 40 m of drawing. */
const HALL = [
  '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER',
  '0', 'LAYER', '2', 'WALLS', '70', '0', '62', '1',
  '0', 'LAYER', '2', 'COLUMNS', '70', '0', '62', '3',
  '0', 'ENDTAB', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LWPOLYLINE', '8', 'WALLS', '90', '4', '70', '1',
  '10', '0', '20', '0', '10', '60000', '20', '0', '10', '60000', '20', '40000', '10', '0', '20', '40000',
  '0', 'LINE', '8', 'COLUMNS', '10', '10000', '20', '10000', '11', '10000', '21', '30000',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

function buildScene(text: string, opts: Partial<DxfImportOptions> = {}) {
  const options = { ...DEFAULT_DXF_OPTIONS, ...opts };
  const geometry = entitiesToGeometry(parseDxf(text), options, 'mm');
  const buffers = buildLayerBuffers(polylinesForRibbons(geometry, options), options.lineWidthMm);
  return dxfToObject3D(buffers, geometry, options, {
    units: 'mm',
    originOffset: geometry.originOffset,
    fileName: 'hall.dxf',
  });
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((n) => { if ((n as Mesh).isMesh) out.push(n as Mesh); });
  return out;
}

function groupNames(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => { if (n.name && !(n as Mesh).isMesh) out.push(n.name); });
  return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('DXF → objectToGlb → parseGlbSubtree', () => {
  it('preserves the layer hierarchy and one Lines mesh per layer', async () => {
    const { root } = buildScene(HALL);
    const parsed = await parseGlbSubtree(await objectToGlb(root));

    const names = groupNames(parsed);
    expect(names).toContain('DxfContent');
    expect(names).toContain('WALLS');
    expect(names).toContain('COLUMNS');
    // Both layers author a mesh called "Lines"; glTF's file-global name dedup
    // turns the second into "Lines_1" on the way back (doc-node-paths.md). The
    // LAYER groups keep their names, which is what a node path is addressed by.
    const meshNames = meshes(parsed).map(m => m.name).sort();
    expect(meshNames).toHaveLength(2);
    expect(meshNames.every(n => n.startsWith('Lines'))).toBe(true);
  });

  it('preserves the ACI vertex colours', async () => {
    const { root } = buildScene(HALL);
    const parsed = await parseGlbSubtree(await objectToGlb(root));

    const byLayer = new Map<string, Mesh>();
    parsed.traverse((n) => {
      if ((n as Mesh).isMesh && n.parent?.name) byLayer.set(n.parent.name, n as Mesh);
    });
    const read = (layer: string): [number, number, number] => {
      const geo = byLayer.get(layer)!.geometry as BufferGeometry;
      const c = geo.getAttribute('color');
      return [c.getX(0), c.getY(0), c.getZ(0)];
    };
    // glTF stores COLOR_0 linearly and these are the palette's pure primaries,
    // so an exact match is the right assertion — a colour-space slip would show.
    expect(read('WALLS')).toEqual([1, 0, 0]);
    expect(read('COLUMNS')).toEqual([0, 1, 0]);
  });

  it('preserves the informational DxfImport extras on the root', async () => {
    const { root } = buildScene(HALL);
    const parsed = await parseGlbSubtree(await objectToGlb(root));
    const info = (parsed.userData.realvirtual as { DxfImport?: { Layers: number; Units: string } } | undefined)?.DxfImport;
    expect(info).toBeDefined();
    expect(info!.Layers).toBe(2);
    expect(info!.Units).toBe('mm');
  });

  it('comes back at the right size in METRES', async () => {
    const { root } = buildScene(HALL);
    const parsed = await parseGlbSubtree(await objectToGlb(root));
    parsed.updateMatrixWorld(true);
    const size = new Box3().setFromObject(parsed).getSize(new Vector3());
    // 60 m × 40 m of drawing, plus one line width (20 mm) on each side.
    expect(size.x).toBeCloseTo(60.02, 2);
    expect(size.z).toBeCloseTo(40.02, 2);
    expect(size.y).toBeCloseTo(0, 4); // flat
  });

  it('lands on the floor with the authored clearance', async () => {
    const { root } = buildScene(HALL);
    const parsed = await parseGlbSubtree(await objectToGlb(root));
    parsed.updateMatrixWorld(true);
    expect(new Box3().setFromObject(parsed).min.y).toBeCloseTo(DXF_FLOOR_CLEARANCE_M, 5);
  });

  it('is UNMOVED by pivotToFloorCenter — the reload path runs it every time', async () => {
    // The single invariant that decides whether a placed hall plan stays put
    // across a save/reload cycle (plan §5.3 "Reload-Pivot").
    const { root } = buildScene(HALL);
    const parsed = await parseGlbSubtree(await objectToGlb(root));
    parsed.updateMatrixWorld(true);
    const before = new Box3().setFromObject(parsed).getCenter(new Vector3()).clone();

    pivotToFloorCenter(parsed);
    parsed.updateMatrixWorld(true);
    const after = new Box3().setFromObject(parsed).getCenter(new Vector3());

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });

  it('carries extruded solids through as well', async () => {
    const { root } = buildScene(HALL, { extrudeClosedMm: 3000 });
    const parsed = await parseGlbSubtree(await objectToGlb(root));
    expect(meshes(parsed).some(m => m.name === 'Solids')).toBe(true);
    parsed.updateMatrixWorld(true);
    expect(new Box3().setFromObject(parsed).max.y).toBeCloseTo(3 + DXF_FLOOR_CLEARANCE_M, 3);
  });

  it('is deterministic: the same drawing gives the same names twice', async () => {
    const a = groupNames(await parseGlbSubtree(await objectToGlb(buildScene(HALL).root)));
    const b = groupNames(await parseGlbSubtree(await objectToGlb(buildScene(HALL).root)));
    expect(a).toEqual(b);
  });
});
