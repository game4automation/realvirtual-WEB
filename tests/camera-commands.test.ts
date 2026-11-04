// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureCameraCommandsRegistered } from '../src/core/hmi/camera-commands';
import type { CameraManager } from '../src/core/rv-camera-manager';
import type { RVViewer } from '../src/core/rv-viewer';
import { makeTestCameraManager } from './helpers/camera-test-harness';

function fixture(fpvActive = false, fpvExitSucceeds = true) {
  const camera = makeTestCameraManager();
  const manager = camera as unknown as CameraManager;
  const parent = new Object3D();
  parent.position.set(4, 1, -2);
  parent.rotation.y = Math.PI / 3;
  const node = new Object3D();
  parent.add(node);
  const order: string[] = [];
  const fpv = { isActive: fpvActive, exit: vi.fn(() => {
    order.push('fpv-exit');
    if (fpvExitSucceeds) fpv.isActive = false;
  }) };
  const plugin = { canFollow: () => true, enter: vi.fn(), exit: vi.fn(() => order.push('exit')) };
  const select = vi.fn();
  const viewer = {
    getPlugin: (id: string) => id === 'camera-follow' ? plugin : id === 'fpv' ? fpv : undefined,
    registry: { findNodeForUser: (path: string) => path === 'Part/A' ? { node } : null, getPathForNode: () => 'Part/A' },
    selectionManager: { select },
    animateCameraTo: (...args: Parameters<CameraManager['animateCameraTo']>) => {
      order.push('animate');
      manager.animateCameraTo(...args);
    },
  } as unknown as RVViewer;
  const registry = new CommandRegistry();
  ensureCameraCommandsRegistered(registry);
  const execute = (id: string, args: unknown) => registry.execute(id, args, { origin: 'ui', viewer });
  return { camera, node, plugin, fpv, select, order, execute };
}

describe('camera commands (plan-2031)', () => {
  it('exits active FPV before starting a flight', async () => {
    const f = fixture(true);
    expect(await f.execute('camera.flyTo', { position: [3, 2, 5], target: [0, 0, 0] })).toMatchObject({ ok: true });
    expect(f.fpv.exit).toHaveBeenCalledTimes(1);
    expect(f.fpv.isActive).toBe(false);
    expect(f.order).toEqual(['exit', 'fpv-exit', 'animate']);
    expect(f.camera.isCameraAnimating).toBe(true);
  });

  it('reports a command error without animating if FPV remains active after exit', async () => {
    const f = fixture(true, false);
    expect(await f.execute('camera.flyTo', { position: [3, 2, 5], target: [0, 0, 0] })).toMatchObject({
      ok: false, kind: 'threw',
      reason: 'Cannot fly the camera while first-person view is active; leave it first',
    });
    expect(f.fpv.exit).toHaveBeenCalledTimes(1);
    expect(f.fpv.isActive).toBe(true);
    expect(f.order).toEqual(['exit', 'fpv-exit']);
    expect(f.camera.isCameraAnimating).toBe(false);
    expect(f.camera.camera.position.toArray()).toEqual([0, 0, 0]);
  });

  it('finishes an absolute flight on the fifth 0.1-second tick and releases follow first', async () => {
    const f = fixture();
    expect(await f.execute('camera.flyTo', { position: [3, 2, 5], target: [1, 0, 2], durationSec: 0.5 })).toMatchObject({ ok: true });
    expect(f.order).toEqual(['exit', 'animate']);
    expect(f.camera.isCameraAnimating).toBe(true);
    for (let i = 0; i < 4; i++) {
      f.camera.tickCameraAnimation(0.1);
      expect(f.camera.isCameraAnimating).toBe(true);
    }
    f.camera.tickCameraAnimation(0.1);
    expect(f.camera.isCameraAnimating).toBe(false);
    expect(f.camera.camera.position.toArray()).toEqual([3, 2, 5]);
    expect(f.camera.controls.target.toArray()).toEqual([1, 0, 2]);
    f.camera.tickCameraAnimation(0.1);
    expect(f.camera.isCameraAnimating).toBe(false);
    expect(f.camera.camera.position.toArray()).toEqual([3, 2, 5]);
  });

  it.each(['follow', 'siton'])('selects the requested path before entering %s, and exits on off', async mode => {
    const f = fixture();
    f.plugin.enter.mockImplementation(() => expect(f.select).toHaveBeenCalledWith('Part/A'));
    expect(await f.execute('camera.follow', { mode, path: 'Part/A' })).toMatchObject({ ok: true });
    expect(f.plugin.enter).toHaveBeenCalledWith(mode);
    expect(await f.execute('camera.follow', { mode: 'off' })).toMatchObject({ ok: true });
    expect(f.plugin.exit).toHaveBeenCalledTimes(1);
  });

  it('refreshes the moving node endpoint, including parent transform and local forward', async () => {
    const f = fixture();
    expect(await f.execute('camera.flyTo', { node: 'Part/A', offset: [0, 2, -4], lookAhead: 1.5, durationSec: 1 })).toMatchObject({ ok: true });
    // Binary-exact quarter seconds keep this test about endpoint tracking.
    for (let i = 1; i <= 4; i++) {
      f.node.position.set(i * 2, 0, i);
      f.node.rotation.y = i * Math.PI / 8;
      f.camera.tickCameraAnimation(0.25);
      expect(f.camera.isCameraAnimating).toBe(i < 4);
    }
    f.node.updateWorldMatrix(true, false);
    const position = new Vector3(0, 2, -4).applyMatrix4(f.node.matrixWorld);
    const target = new Vector3().setFromMatrixPosition(f.node.matrixWorld)
      .addScaledVector(new Vector3(0, 0, 1).transformDirection(f.node.matrixWorld), 1.5);
    expect(f.camera.camera.position.distanceTo(position)).toBeLessThan(0.01);
    expect(f.camera.controls.target.distanceTo(target)).toBeLessThan(0.01);
  });

  it.each([
    { args: { position: [1, 2], target: [0, 0, 0] }, reason: /position.*3 finite/ },
    { args: { position: [1, NaN, 3], target: [0, 0, 0] }, reason: /position.*finite/ },
    { args: { node: 'missing' }, reason: /not found/ },
  ])('refuses invalid flight input without moving or releasing follow: $args', async ({ args, reason }) => {
    const f = fixture();
    expect(await f.execute('camera.flyTo', args)).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    expect(f.camera.camera.position.toArray()).toEqual([0, 0, 0]);
    expect(f.camera.isCameraAnimating).toBe(false);
    expect(f.plugin.exit).not.toHaveBeenCalled();
  });

  it('refuses following an unknown node without selecting or entering', async () => {
    const f = fixture();
    expect(await f.execute('camera.follow', { mode: 'follow', path: 'missing' })).toMatchObject({ ok: false, reason: expect.stringContaining('not found') });
    expect(f.select).not.toHaveBeenCalled();
    expect(f.plugin.enter).not.toHaveBeenCalled();
  });
});
