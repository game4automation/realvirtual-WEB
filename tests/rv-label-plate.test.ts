// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-529 §9.2 — the Plate mesh contract (`rv-label-plate.ts`): layer 0,
 * depth-tested and depth-writing (the documented exception to the label-sprite
 * contract), flagged for the exporter prune, 2 mm standoff, sizes in metres.
 */
import { describe, it, expect } from 'vitest';
import { Mesh, Object3D, SRGBColorSpace } from 'three';
import {
  LABEL_PLATE_STANDOFF_M,
  buildLabelPlate,
  disposeLabelPlate,
  replaceLabelPlateTexture,
  setLabelPlateSize,
} from '../src/core/engine/rv-label-plate';
import { makeLabelCanvas, labelContractViolations, LABEL_ANISOTROPY } from '../src/core/engine/rv-label-sprite';
import { RVWebLabel, layoutPlate, DEFAULT_TEXT_COLOR, DEFAULT_BACKGROUND_COLOR } from '../src/core/engine/rv-web-label';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { WebLabelManager } from '../src/core/engine/rv-web-label-manager';

function canvas(): HTMLCanvasElement {
  return makeLabelCanvas(100, 40, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 100, 40); });
}

function plateLabel(extras: Record<string, unknown>): { label: RVWebLabel; node: Object3D } {
  const node = new Object3D();
  const label = new RVWebLabel(node);
  applySchema(label as unknown as Record<string, unknown>, RVWebLabel.schema, { Mode: 'Plate', ...extras });
  label.init({ webLabelManager: new WebLabelManager() } as unknown as ComponentContext);
  return { label, node };
}

describe('buildLabelPlate', () => {
  it('is a Mesh on layer 0, depth-tested and depth-writing, flagged _rvLabelPlate + _rvWebLabel', () => {
    const h = buildLabelPlate(canvas(), 0.5, 0.2);
    expect(h.mesh).toBeInstanceOf(Mesh);
    expect(h.mesh.layers.mask).toBe(1);
    expect(h.material.depthTest).toBe(true);
    expect(h.material.depthWrite).toBe(true);
    expect(h.mesh.userData._rvLabelPlate).toBe(true);
    expect(h.mesh.userData._rvWebLabel).toBe(true);
    expect(h.texture.colorSpace).toBe(SRGBColorSpace);
    expect(h.texture.anisotropy).toBe(LABEL_ANISOTROPY);
    expect(h.texture.generateMipmaps).toBe(true);
    disposeLabelPlate(h);
  });

  it('respects explicit sizes in metres (1 unit = 1 m)', () => {
    const h = buildLabelPlate(canvas(), 0.5, 0.2);
    h.geometry.computeBoundingBox();
    const bb = h.geometry.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(0.5, 6);
    expect(bb.max.y - bb.min.y).toBeCloseTo(0.2, 6);
    expect(bb.max.z - bb.min.z).toBeCloseTo(0, 6);
    expect(setLabelPlateSize(h, 0.5, 0.2)).toBe(false);
    expect(setLabelPlateSize(h, 0.6, 0.2)).toBe(true);
    h.geometry.computeBoundingBox();
    expect(h.geometry.boundingBox!.max.x - h.geometry.boundingBox!.min.x).toBeCloseTo(0.6, 6);
    disposeLabelPlate(h);
  });

  it('texture swap disposes the old texture', () => {
    const h = buildLabelPlate(canvas(), 0.5, 0.2);
    const old = h.texture;
    let disposed = false;
    old.addEventListener('dispose', () => { disposed = true; });
    replaceLabelPlateTexture(h, canvas());
    expect(disposed).toBe(true);
    expect(h.material.map).toBe(h.texture);
    disposeLabelPlate(h);
  });

  it('is NOT reported by the label-sprite contract (the sanctioned exemption)', () => {
    const root = new Object3D();
    const h = buildLabelPlate(canvas(), 0.5, 0.2);
    root.add(h.mesh);
    expect(labelContractViolations(root)).toEqual([]);
    disposeLabelPlate(h);
  });
});

describe('WebLabel Plate layout', () => {
  it('sits 2 mm in front of the node plane along +Z, plus the Offset (mm)', () => {
    const { label } = plateLabel({ Text: 'Hi', Offset: { x: 10, y: -20, z: 5 } });
    const obj = label.visual!.object;
    expect(obj.position.x).toBeCloseTo(0.01, 9);
    expect(obj.position.y).toBeCloseTo(-0.02, 9);
    expect(obj.position.z).toBeCloseTo(0.005 + LABEL_PLATE_STANDOFF_M, 9);
    expect(LABEL_PLATE_STANDOFF_M).toBeCloseTo(0.002, 9);
    label.dispose();
  });

  it('auto size from text when width/height are 0; explicit mm sizes are respected', () => {
    const auto = layoutPlate(['Model courtesy of'], 40, 0, 0, DEFAULT_TEXT_COLOR, DEFAULT_BACKGROUND_COLOR);
    expect(auto.widthMm).toBeGreaterThan(auto.heightMm);
    expect(auto.heightMm).toBeGreaterThan(40);   // one 40 mm line + padding
    expect(auto.heightMm).toBeLessThan(90);    // 1.25 line height + 0.8 font padding = 82.5 mm
    const fixed = layoutPlate(['Model courtesy of'], 40, 500, 120, DEFAULT_TEXT_COLOR, DEFAULT_BACKGROUND_COLOR);
    expect(fixed.widthMm).toBe(500);
    expect(fixed.heightMm).toBe(120);
    // Canvas keeps the plate aspect (no stretched glyphs).
    expect(fixed.canvas.width / fixed.canvas.height).toBeCloseTo(500 / 120, 1);
    const mixed = layoutPlate(['A'], 40, 500, 0, DEFAULT_TEXT_COLOR, DEFAULT_BACKGROUND_COLOR);
    expect(mixed.widthMm).toBe(500);
    expect(mixed.heightMm).toBeCloseTo(auto.heightMm, 6);
  });

  it('keeps the canvas within 4096 physical px on a huge plate', () => {
    const big = layoutPlate(['X'], 10, 20000, 5000, DEFAULT_TEXT_COLOR, DEFAULT_BACKGROUND_COLOR);
    expect(Math.max(big.canvas.width, big.canvas.height)).toBeLessThanOrEqual(4096);
  });
});
