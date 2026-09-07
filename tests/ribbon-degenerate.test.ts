// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.6 — the failure paths.
 *
 * The rule the whole feature is held to: a web that cannot be solved goes INERT
 * with a named reason and leaves the scene exactly as authored. Never a NaN in a
 * transform, never a half-built band, never a silent nothing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { ribbonHarness, transformRef, type RollerSpec } from './ribbon-fixture';
import { RibbonManager } from '../src/core/engine/rv-ribbon-manager';

const OK: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true, driven: true },
  { name: 'Idler', xMm: 1500, yMm: 300, radiusMm: 60 },
  { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true },
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

function warnings(): string {
  return warn.mock.calls.flat().join(' ');
}

describe('RibbonPath degeneracies', () => {
  it('missing roller reference -> path inert, warn, rollers static', () => {
    const h = ribbonHarness(OK);
    const path = h.buildPath({
      Rollers: [transformRef('Root/Unwinder'), transformRef('Root/DoesNotExist')],
    });
    expect(path.isInert).toBe(true);
    expect(path.isActive).toBe(false);
    expect(warnings()).toContain('does not resolve');
    expect(h.ribbonManager.size).toBe(0);

    // Nothing moves, and nothing throws.
    h.drive.jog(1000);
    expect(() => h.step(1 / 60)).not.toThrow();
  });

  it('winder in the middle of Rollers -> inert + warn', () => {
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 100 },
      { name: 'Mid', xMm: 1500, yMm: 200, radiusMm: 300, winder: true },
      { name: 'B', xMm: 3000, yMm: 0, radiusMm: 100 },
    ]);
    const path = h.buildPath();
    expect(path.isInert).toBe(true);
    expect(warnings()).toContain('RibbonWinder in the MIDDLE');
  });

  it('roller axis deviating > 2 deg -> inert + warn', () => {
    const h = ribbonHarness(OK);
    // 5 degrees out of the common Z axis.
    h.nodes.get('Idler')!.rotation.x = (5 * Math.PI) / 180;
    h.scene.updateMatrixWorld(true);
    const path = h.buildPath();
    expect(path.isInert).toBe(true);
    expect(warnings()).toContain('deviates');

    // …and a 1 degree tilt is inside the tolerance.
    const h2 = ribbonHarness(OK);
    h2.nodes.get('Idler')!.rotation.x = (1 * Math.PI) / 180;
    h2.scene.updateMatrixWorld(true);
    expect(h2.buildPath().isActive).toBe(true);
  });

  it('RibbonThicknessMm = 0 or CoreRadiusMm = 0 -> winder inert, no NaN in scene', () => {
    const h = ribbonHarness([
      {
        name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true,
        extras: { RibbonThicknessMm: 0 },
      },
      { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    const path = h.buildPath();
    const unwinder = path.winders[0];
    expect(unwinder.isInert).toBe(true);
    expect(warnings()).toContain('must both be greater than 0');
    // The inert winder keeps its AUTHORED radius, so the path still solves.
    expect(Number.isFinite(unwinder.radiusMm)).toBe(true);
    expect(path.isActive).toBe(true);

    h.drive.jog(1000);
    h.step(1 / 60);
    for (const roller of path.rollers) {
      expect(Number.isFinite(roller.node.position.x)).toBe(true);
      expect(Number.isFinite(roller.angle)).toBe(true);
    }
    const positions = path.band!.mesh.geometry.getAttribute('position').array as Float32Array;
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('two overlapping rollers with opposite sides -> inert with the geometric reason', () => {
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 400, side: 'Left' },
      { name: 'B', xMm: 500, yMm: 0, radiusMm: 400, side: 'Right' },
    ]);
    const path = h.buildPath();
    expect(path.isInert).toBe(true);
    expect(warnings()).toContain('no tangent between roller 0 and 1');
  });

  it('a single roller is not a path', () => {
    const h = ribbonHarness(OK);
    const path = h.buildPath({ Rollers: [transformRef('Root/Unwinder')] });
    expect(path.isInert).toBe(true);
    expect(warnings()).toContain('at least two');
  });

  it('a path without a driven roller is built but never moves (plan-460)', () => {
    // Same fixture WITHOUT the drive on the unwinder: nothing pulls the web.
    const h = ribbonHarness(OK.map((s) => ({ ...s, driven: false })));
    const path = h.buildPath();
    expect(path.isActive).toBe(true);
    h.drive.jog(1000);
    h.step(1 / 60);
    expect(warnings()).toContain('has no driven roller');
    expect(path.rollers[1].angle).toBe(0);
  });
});

describe('RibbonPath lifecycle', () => {
  it('clearModel disposes every web path and winder (manager size 0, no leaked meshes)', () => {
    const h = ribbonHarness(OK);
    const path = h.buildPath();
    const band = path.band!;
    const bandMesh = band.mesh;
    const geometryDispose = vi.spyOn(bandMesh.geometry, 'dispose');
    const textureDispose = vi.spyOn(band.map!, 'dispose');
    const materialDispose = vi.spyOn(bandMesh.material as { dispose: () => void }, 'dispose');
    const roll = h.nodes.get('Unwinder')!.getObjectByName('Roll')!;

    expect(h.ribbonManager.size).toBe(1);
    h.ribbonManager.clear();

    expect(h.ribbonManager.size).toBe(0);
    expect(h.ribbonManager.groups).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalled();
    expect(textureDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    // The band is out of the scene graph…
    expect(bandMesh.parent).toBeNull();
    expect(h.path.children).not.toContain(bandMesh);
    // …and the winder gave the authored roll scale back.
    expect(roll.scale.toArray()).toEqual([2, 1, 2]);
  });

  it('a disposed path unregisters itself and stops being ticked', () => {
    const h = ribbonHarness(OK);
    const path = h.buildPath();
    path.dispose();
    expect(h.ribbonManager.size).toBe(0);
    h.drive.jog(1000);
    h.drive.tick(1 / 60);
    expect(h.ribbonManager.update(1 / 60)).toBe(false);
  });

  it('an empty manager is a no-op, not a crash', () => {
    const manager = new RibbonManager();
    expect(manager.update(1 / 60)).toBe(false);
    expect(manager.size).toBe(0);
    expect(() => manager.resetAll()).not.toThrow();
    expect(() => manager.clear()).not.toThrow();
    expect(manager.ownerOf({} as never)).toBeNull();
    // And an unregistered node is not a member of anything.
    expect(new Object3D().parent).toBeNull();
  });
});
