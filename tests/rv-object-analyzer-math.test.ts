// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  clampTileSize,
  DEFAULT_TILE_SIZE,
  formatBoundsLabel,
  MARGIN_ISOLATED,
  MARGIN_NEAR,
  MOSAIC_HEADER_PX,
  mosaicLayout,
  parsePathsParam,
  VIEW_DEFS,
} from '../src/plugins/mcp-bridge/rv-object-analyzer-math';

describe('parsePathsParam', () => {
  it('splits single-line input on commas and semicolons and trims', () => {
    expect(parsePathsParam('A/B, C/D ;E')).toEqual(['A/B', 'C/D', 'E']);
  });

  it('treats the comma as a literal once the input spans lines', () => {
    // CAD part names really do carry commas ("ISO 15 ABB - 6020 - Full,SI,NC"),
    // so multi-line input — the form used to paste a list of paths — splits on
    // line breaks and semicolons only.
    expect(parsePathsParam('A/B, C/D ;E\nF\r\nG')).toEqual(['A/B, C/D', 'E', 'F', 'G']);
  });

  it('drops empty segments', () => {
    expect(parsePathsParam(' , ,, ')).toEqual([]);
    expect(parsePathsParam(' \n \r\n ')).toEqual([]);
    expect(parsePathsParam('')).toEqual([]);
  });

  it('keeps a single path intact (paths may contain spaces)', () => {
    expect(parsePathsParam('Machine 1/Conveyor A')).toEqual(['Machine 1/Conveyor A']);
  });

  it('is defensive about non-string input', () => {
    expect(parsePathsParam(undefined as unknown as string)).toEqual([]);
  });
});

describe('clampTileSize', () => {
  it('defaults to 256 for missing/invalid input', () => {
    expect(clampTileSize(undefined)).toBe(DEFAULT_TILE_SIZE);
    expect(clampTileSize(Number.NaN)).toBe(DEFAULT_TILE_SIZE);
    expect(clampTileSize('big' as unknown as number)).toBe(DEFAULT_TILE_SIZE);
  });

  it('clamps to 128..512 and rounds', () => {
    expect(clampTileSize(1)).toBe(128);
    expect(clampTileSize(4096)).toBe(512);
    expect(clampTileSize(300.6)).toBe(301);
  });
});

describe('VIEW_DEFS', () => {
  it('has 4 views: two context (far/near) then two isolated 3/4 views', () => {
    expect(VIEW_DEFS.map((v) => v.name)).toEqual(['far', 'near', 'front-top', 'back-bottom']);
    expect(VIEW_DEFS.map((v) => v.kind)).toEqual(['context', 'context', 'isolated', 'isolated']);
    expect(VIEW_DEFS.map((v) => v.framing)).toEqual(['scene', 'near', 'tight', 'tight']);
  });

  it('all view directions are normalized', () => {
    for (const v of VIEW_DEFS) {
      expect(Math.hypot(...v.dir), v.name).toBeCloseTo(1, 10);
    }
  });

  it('the two isolated views look from opposite half-spaces (all faces covered)', () => {
    const a = VIEW_DEFS.find((v) => v.name === 'front-top')!;
    const b = VIEW_DEFS.find((v) => v.name === 'back-bottom')!;
    for (let i = 0; i < 3; i++) {
      expect(Math.sign(a.dir[i]), `component ${i}`).toBe(-Math.sign(b.dir[i]));
    }
  });

  it('margins: near context stands further back than isolated', () => {
    expect(MARGIN_NEAR).toBeGreaterThan(MARGIN_ISOLATED);
  });
});

describe('mosaicLayout', () => {
  it('produces 4 cells, all 2T, one per view in VIEW_DEFS order', () => {
    const T = 256;
    const layout = mosaicLayout(T);
    expect(layout.cells).toHaveLength(4);
    expect(layout.cells.every((c) => c.size === 2 * T)).toBe(true);
    expect(layout.cells.map((c) => c.view)).toEqual(VIEW_DEFS.map((v) => v.name));
  });

  it('matches the size formula 4T x (header + 4T)', () => {
    const T = 256;
    const layout = mosaicLayout(T);
    expect(layout.width).toBe(4 * T);
    expect(layout.height).toBe(MOSAIC_HEADER_PX + 4 * T);
    expect(layout.header).toBe(MOSAIC_HEADER_PX);
  });

  it('arranges a 2x2 grid: context row on top, isolated row below', () => {
    const T = 128;
    const layout = mosaicLayout(T);
    const [far, near, ft, bb] = layout.cells;
    expect([far.x, far.y]).toEqual([0, MOSAIC_HEADER_PX]);
    expect([near.x, near.y]).toEqual([2 * T, MOSAIC_HEADER_PX]);
    expect([ft.x, ft.y]).toEqual([0, MOSAIC_HEADER_PX + 2 * T]);
    expect([bb.x, bb.y]).toEqual([2 * T, MOSAIC_HEADER_PX + 2 * T]);
  });

  it('cells never overlap and stay inside the mosaic', () => {
    const layout = mosaicLayout(256);
    const cells = layout.cells;
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(layout.header);
      expect(c.x + c.size).toBeLessThanOrEqual(layout.width);
      expect(c.y + c.size).toBeLessThanOrEqual(layout.height);
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        const overlap =
          a.x < b.x + b.size && b.x < a.x + a.size &&
          a.y < b.y + b.size && b.y < a.y + a.size;
        expect(overlap, `${a.view} overlaps ${b.view}`).toBe(false);
      }
    }
  });

  it('labels distinguish context and isolated tiles', () => {
    const labels = mosaicLayout(256).cells.map((c) => c.label);
    expect(labels).toEqual([
      'context far', 'context near', 'isolated front-top', 'isolated back-bottom',
    ]);
  });

  it('clamps the tile size like the tool parameter', () => {
    expect(mosaicLayout(1).width).toBe(4 * 128);
    expect(mosaicLayout(9999).width).toBe(4 * 512);
  });
});

describe('formatBoundsLabel', () => {
  it('formats dimensions, center and node count', () => {
    const label = formatBoundsLabel({ x: 1.2345, y: 2, z: 0.5 }, { x: 0, y: 1, z: -2.5 }, 2);
    expect(label).toContain('1.234');
    expect(label).toContain('2.000');
    expect(label).toContain('0.500');
    expect(label).toContain('(0.000, 1.000, -2.500)');
    expect(label).toContain('2 nodes');
  });

  it('uses singular for one node', () => {
    expect(formatBoundsLabel({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 }, 1)).toContain('1 node');
  });
});
