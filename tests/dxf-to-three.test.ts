// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-741 §9.4 — the Three.js stage: ribbon topology, one group per layer, and
 * the root normalisation.
 *
 * The load-bearing test in here is the LAST one. The planner's reload path runs
 * `pivotToFloorCenter` on every placement unconditionally, so a root whose AABB
 * is not already floor-centred moves a little every time the scene is opened.
 * That is exactly what the plan's "pivot-correct by construction" decision is
 * about, and it is the reason the −90° rotation lives on an inner wrapper rather
 * than on the root itself.
 */
import { describe, it, expect } from 'vitest';
import { Box3, Group, Mesh, Vector3, type Object3D } from 'three';
import { parseDxf } from '@rv-private/plugins/dxf-import/dxf-parse';
import { entitiesToGeometry } from '@rv-private/plugins/dxf-import/dxf-geometry';
import { buildLayerBuffers, totalTriangles } from '@rv-private/plugins/dxf-import/dxf-ribbon';
import {
  assertNotEmpty,
  dxfToObject3D,
  dxfTreeStats,
  normalizeDxfRoot,
  polylinesForRibbons,
  DXF_FLOOR_CLEARANCE_M,
} from '@rv-private/plugins/dxf-import/dxf-to-three';
import {
  DEFAULT_DXF_OPTIONS,
  type DxfImportOptions,
} from '@rv-private/plugins/dxf-import/dxf-import.types';
import { pivotToFloorCenter } from '../src/core/engine/rv-placement-pivot';

// ─── Helpers ────────────────────────────────────────────────────────────

function dxf(entities: string[], tables: string[] = []): string {
  const out: string[] = [];
  if (tables.length > 0) {
    out.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', ...tables, '0', 'ENDTAB', '0', 'ENDSEC');
  }
  out.push('0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

function scene(text: string, opts: Partial<DxfImportOptions> = {}, fileName = 'plan.dxf') {
  const options = { ...DEFAULT_DXF_OPTIONS, ...opts };
  const geometry = entitiesToGeometry(parseDxf(text), options, 'mm');
  const buffers = buildLayerBuffers(
    polylinesForRibbons(geometry, options),
    options.lineWidthMm, // 'mm' units ⇒ 1 drawing unit is 1 mm
  );
  return dxfToObject3D(buffers, geometry, options, {
    units: 'mm',
    originOffset: geometry.originOffset,
    fileName,
  });
}

function meshNamed(root: Object3D, name: string): Mesh | null {
  let found: Mesh | null = null;
  root.traverse((n) => { if (!found && n.name === name && (n as Mesh).isMesh) found = n as Mesh; });
  return found;
}

const ONE_LINE = dxf(['0', 'LINE', '8', 'WALLS', '10', '0', '20', '0', '11', '1000', '21', '0']);

// ─── Ribbon topology ────────────────────────────────────────────────────

describe('ribbon buffers', () => {
  it('turns ONE segment into 4 vertices and 6 indices (two triangles)', () => {
    const geometry = entitiesToGeometry(parseDxf(ONE_LINE), DEFAULT_DXF_OPTIONS, 'mm');
    const [buf] = buildLayerBuffers(geometry.polylines, 20);
    expect(buf.layer).toBe('WALLS');
    expect(buf.positions.length / 3).toBe(4);
    expect(buf.index.length).toBe(6);
    expect(buf.triangles).toBe(2);
  });

  it('gives an n-point polyline 2n vertices', () => {
    const text = dxf([
      '0', 'LWPOLYLINE', '8', 'A', '90', '4', '70', '0',
      '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '100', '10', '200', '20', '100',
    ]);
    const geometry = entitiesToGeometry(parseDxf(text), DEFAULT_DXF_OPTIONS, 'mm');
    const [buf] = buildLayerBuffers(geometry.polylines, 20);
    expect(buf.positions.length / 3).toBe(8);
    expect(buf.triangles).toBe(6); // 3 segments × 2
  });

  it('closes the loop of a closed polyline (n segments, not n−1)', () => {
    const square = dxf([
      '0', 'LWPOLYLINE', '8', 'A', '90', '4', '70', '1',
      '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '100', '10', '0', '20', '100',
    ]);
    const geometry = entitiesToGeometry(parseDxf(square), DEFAULT_DXF_OPTIONS, 'mm');
    const [buf] = buildLayerBuffers(geometry.polylines, 20);
    expect(buf.positions.length / 3).toBe(8);
    expect(buf.triangles).toBe(8); // 4 closed segments × 2
  });

  it('draws the ribbon at the requested world width', () => {
    const geometry = entitiesToGeometry(parseDxf(ONE_LINE), DEFAULT_DXF_OPTIONS, 'mm');
    const [buf] = buildLayerBuffers(geometry.polylines, 20);
    // A horizontal segment: the two vertices of one end differ by the width in Y.
    const y0 = buf.positions[1];
    const y1 = buf.positions[4];
    expect(Math.abs(y0 - y1)).toBeCloseTo(20, 6);
  });

  it('writes the ACI colour into the vertex-colour buffer', () => {
    const red = dxf(
      ['0', 'LINE', '8', 'R', '10', '0', '20', '0', '11', '10', '21', '0'],
      ['0', 'LAYER', '2', 'R', '70', '0', '62', '1'],
    );
    const geometry = entitiesToGeometry(parseDxf(red), DEFAULT_DXF_OPTIONS, 'mm');
    const [buf] = buildLayerBuffers(geometry.polylines, 20);
    expect([buf.colors[0], buf.colors[1], buf.colors[2]]).toEqual([1, 0, 0]);
  });

  it('sorts layers by name so re-importing the same file gives the same paths', () => {
    const text = dxf([
      '0', 'LINE', '8', 'ZONE', '10', '0', '20', '0', '11', '10', '21', '0',
      '0', 'LINE', '8', 'AISLE', '10', '0', '20', '5', '11', '10', '21', '5',
    ]);
    const geometry = entitiesToGeometry(parseDxf(text), DEFAULT_DXF_OPTIONS, 'mm');
    expect(buildLayerBuffers(geometry.polylines, 20).map(b => b.layer)).toEqual(['AISLE', 'ZONE']);
  });
});

// ─── Hierarchy ──────────────────────────────────────────────────────────

describe('scene hierarchy', () => {
  it('is root → DxfContent → one group per layer, each with a Lines mesh', () => {
    const text = dxf([
      '0', 'LINE', '8', 'WALLS', '10', '0', '20', '0', '11', '1000', '21', '0',
      '0', 'LINE', '8', 'COLUMNS', '10', '0', '20', '500', '11', '1000', '21', '500',
    ]);
    const { root, layerCount } = scene(text);
    expect(root.children).toHaveLength(1);
    const wrapper = root.children[0];
    expect(wrapper.name).toBe('DxfContent');
    const layers = wrapper.children[0];
    expect(layers.children.map(c => c.name).sort()).toEqual(['COLUMNS', 'WALLS']);
    expect(layerCount).toBe(2);
    expect(meshNamed(root, 'Lines')).not.toBeNull();
  });

  it('creates no group for a layer that produced nothing', () => {
    const text = dxf(
      [
        '0', 'LINE', '8', 'WALLS', '10', '0', '20', '0', '11', '1000', '21', '0',
        '0', 'LINE', '8', 'OLD', '10', '0', '20', '0', '11', '1000', '21', '0',
      ],
      ['0', 'LAYER', '2', 'OLD', '70', '1', '62', '1'],
    );
    expect(scene(text).layerCount).toBe(1);
  });

  it('shares ONE material across every layer', () => {
    const text = dxf([
      '0', 'LINE', '8', 'A', '10', '0', '20', '0', '11', '10', '21', '0',
      '0', 'LINE', '8', 'B', '10', '0', '20', '5', '11', '10', '21', '5',
    ]);
    const { root } = scene(text);
    const materials = new Set<unknown>();
    root.traverse((n) => { if ((n as Mesh).isMesh) materials.add((n as Mesh).material); });
    expect(materials.size).toBe(1);
    const [mat] = [...materials] as { vertexColors: boolean }[];
    // Vertex colours are what carries the ACI palette through the batched
    // renderer's per-material arena.
    expect(mat.vertexColors).toBe(true);
  });
});

// ─── Root normalisation ─────────────────────────────────────────────────

describe('normalizeDxfRoot', () => {
  it('scales the root and rotates the CONTENT, not the root', () => {
    const content = new Group();
    content.name = 'Layers';
    const root = normalizeDxfRoot(content, 0.001, 'plan');
    expect(root.scale.x).toBeCloseTo(0.001, 12);
    expect(root.rotation.x).toBe(0);
    expect(root.children[0].rotation.x).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('lifts the drawing half a millimetre off the floor and applies NO XZ offset', () => {
    const root = normalizeDxfRoot(new Group(), 0.001, 'plan');
    expect(root.position.y).toBeCloseTo(DXF_FLOOR_CLEARANCE_M, 12);
    expect(root.position.x).toBe(0);
    expect(root.position.z).toBe(0);
  });

  it('records the drawing origin as information only', () => {
    const { root } = scene(dxf([
      '0', 'LINE', '8', 'A', '10', '3401000', '20', '5712000', '11', '3401200', '21', '5712100',
    ]));
    const info = (root.userData.realvirtual as { DxfImport: { OriginOffsetMm: number[]; Layers: number } }).DxfImport;
    expect(info.OriginOffsetMm[0]).toBeCloseTo(3401100, 3);
    expect(info.Layers).toBe(1);
  });
});

describe('reload idempotence (the reason the rotation sits on the wrapper)', () => {
  it('leaves the drawing centred on the world origin in the floor plane', () => {
    const { root } = scene(dxf([
      '0', 'LINE', '8', 'A', '10', '0', '20', '0', '11', '100000', '21', '0',
      '0', 'LINE', '8', 'A', '10', '0', '20', '0', '11', '0', '21', '60000',
    ]));
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const centre = box.getCenter(new Vector3());
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
    expect(box.min.y).toBeCloseTo(DXF_FLOOR_CLEARANCE_M, 6);
  });

  it('survives pivotToFloorCenter unchanged — the planner runs it on EVERY reload', () => {
    const { root } = scene(dxf([
      '0', 'LWPOLYLINE', '8', 'A', '90', '4', '70', '1',
      '10', '0', '20', '0', '10', '80000', '20', '0', '10', '80000', '20', '40000', '10', '0', '20', '40000',
    ]));
    root.updateMatrixWorld(true);
    const before = new Box3().setFromObject(root).getCenter(new Vector3()).clone();

    pivotToFloorCenter(root);
    root.updateMatrixWorld(true);
    const after = new Box3().setFromObject(root).getCenter(new Vector3());

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(after.z).toBeCloseTo(before.z, 9);

    // …and running it a second time is still a no-op.
    pivotToFloorCenter(root);
    root.updateMatrixWorld(true);
    const again = new Box3().setFromObject(root).getCenter(new Vector3());
    expect(again.x).toBeCloseTo(before.x, 9);
    expect(again.z).toBeCloseTo(before.z, 9);
  });
});

// ─── Extrusion, guards ──────────────────────────────────────────────────

describe('extrusion', () => {
  const SQUARE = dxf([
    '0', 'LWPOLYLINE', '8', 'W', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '5000', '20', '0', '10', '5000', '20', '5000', '10', '0', '20', '5000',
  ]);

  it('is off by default — the closed contour stays a line ribbon', () => {
    const { root } = scene(SQUARE);
    expect(meshNamed(root, 'Solids')).toBeNull();
    expect(meshNamed(root, 'Lines')).not.toBeNull();
  });

  it('builds a Solids mesh of the requested height and drops the redundant ribbon', () => {
    const { root } = scene(SQUARE, { extrudeClosedMm: 3000 });
    const solids = meshNamed(root, 'Solids');
    expect(solids).not.toBeNull();
    expect(meshNamed(root, 'Lines')).toBeNull();
    root.updateMatrixWorld(true);
    // 3000 mm of height, in metres, after the root scale.
    expect(new Box3().setFromObject(root).max.y - DXF_FLOOR_CLEARANCE_M).toBeCloseTo(3, 3);
  });
});

describe('guards', () => {
  it('assertNotEmpty names the frozen-layer escape hatch', () => {
    expect(() => assertNotEmpty(new Group(), 'plan.dxf'))
      .toThrow(/only paper space or frozen layers/i);
  });

  it('refuses a drawing whose only layers are frozen', () => {
    const frozen = dxf(
      ['0', 'LINE', '8', 'OLD', '10', '0', '20', '0', '11', '1000', '21', '0'],
      ['0', 'LAYER', '2', 'OLD', '70', '1', '62', '1'],
    );
    expect(() => scene(frozen)).toThrow(/frozen layers/i);
  });

  it('counts triangles the same way the GLB encoder does', () => {
    const { root, triangles } = scene(ONE_LINE);
    expect(triangles).toBe(2);
    expect(dxfTreeStats(root).triangles).toBe(2);
    expect(totalTriangles(buildLayerBuffers(
      entitiesToGeometry(parseDxf(ONE_LINE), DEFAULT_DXF_OPTIONS, 'mm').polylines, 20,
    ))).toBe(2);
  });
});
