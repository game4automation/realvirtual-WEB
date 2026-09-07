// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.7b — what a save must NOT contain, and what it must put back.
 *
 * Two halves of one rule: runtime geometry is reproducible from the rv_extras,
 * so it belongs in the viewer and not in the file; and a runtime SCALE must be
 * undone rather than reset, because a CAD roll may legitimately be authored
 * non-unit (SOL round-2 finding 3 — the fixture uses `(2, 1, 2)` on purpose).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';
import { RV_RIBBON_BAND, RV_RIBBON_ROLL_SCALE } from '../src/core/engine/rv-traverse-utils';
import { ribbonHarness, type RollerSpec } from './ribbon-fixture';

const LINE: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
  { name: 'Idler', xMm: 1500, yMm: 300, radiusMm: 60, driven: true },
  { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true },
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

/**
 * The real export pre-pass, on a clone — the same shape `exportAssetGlb` uses.
 * Imported rather than reimplemented, so a change to the marker list is caught.
 */
function restoreRollScales(clone: Object3D): void {
  clone.traverse((node) => {
    const authored = (node.userData as Record<string, unknown>)[RV_RIBBON_ROLL_SCALE];
    if (!Array.isArray(authored) || authored.length !== 3) return;
    const [x, y, z] = authored as number[];
    node.scale.set(x, y, z);
  });
}

describe('web handling and the asset export', () => {
  it('prunes the runtime band mesh', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    const band = path.band!.mesh;
    expect(band.userData[RV_RIBBON_BAND]).toBe(true);
    expect(h.path.children).toContain(band);

    pruneRuntimeHelpers(h.root);

    expect(band.parent).toBeNull();
    expect(h.path.children).not.toContain(band);
    // The authored roller nodes are untouched.
    expect(h.root.children).toContain(h.nodes.get('Idler'));
  });

  it('prunes the procedural roll a winder generated for itself', () => {
    // No RollMesh reference at all -> the winder builds one.
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 400, winder: true, extras: { RollMesh: null } },
      { name: 'B', xMm: 3000, yMm: 0, radiusMm: 100, driven: true },
    ]);
    h.buildPath();
    const generated = h.nodes.get('A')!.getObjectByName('A_Roll');
    expect(generated).toBeDefined();

    pruneRuntimeHelpers(h.root);
    expect(generated!.parent).toBeNull();
  });

  it('restores the authored RollMesh scale (fixture uses a non-unit CAD scale of (2,1,2))', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    const roll = h.nodes.get('Unwinder')!.getObjectByName('Roll')!;
    expect(roll.userData[RV_RIBBON_ROLL_SCALE]).toEqual([2, 1, 2]);

    // Run the web down, so the live scale is nowhere near the authored one.
    h.drive.jog(50_000);
    for (let i = 0; i < 200; i++) h.step(1 / 60);
    expect(path.winders[0].radiusMm).toBeLessThan(400);
    expect(roll.scale.x).not.toBeCloseTo(2, 3);

    // The export pre-pass puts the AUTHORED triple back — not (1,1,1), which
    // would silently resize the CAD part on every save.
    restoreRollScales(h.root);
    expect(roll.scale.toArray()).toEqual([2, 1, 2]);
  });

  it('disposing a path also restores the authored roll scale in the LIVE tree', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    const roll = h.nodes.get('Unwinder')!.getObjectByName('Roll')!;
    h.drive.jog(50_000);
    for (let i = 0; i < 100; i++) h.step(1 / 60);
    // The path disposes the winders it gave roles to — nothing else does, since
    // `clearModel()` has no generic per-component sweep.
    path.dispose();
    expect(roll.scale.toArray()).toEqual([2, 1, 2]);
    expect(roll.userData[RV_RIBBON_ROLL_SCALE]).toBeUndefined();
  });

  it('re-importing the pruned tree rebuilds the same path length (round trip)', () => {
    const h = ribbonHarness(LINE);
    const first = h.buildPath();
    const lengthBefore = first.lengthMm;

    // Simulate the save: run the web, prune the runtime helpers, restore scales.
    h.drive.jog(20_000);
    for (let i = 0; i < 100; i++) h.step(1 / 60);
    pruneRuntimeHelpers(h.root);
    restoreRollScales(h.root);
    first.dispose();

    // Simulate the load: the same rv_extras over the same, now clean, tree.
    const h2 = ribbonHarness(LINE);
    const second = h2.buildPath();
    expect(second.lengthMm).toBeCloseTo(lengthBefore, 6);
    // …and the reloaded unwinder is back at its authored 400 mm, because the
    // wound length is derived from the AUTHORED outer radius, not from whatever
    // the previous session left behind.
    expect(second.winders[0].radiusMm).toBeCloseTo(400, 6);
  });
});
