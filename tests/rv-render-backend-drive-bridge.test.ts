// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-render-backend-drive-bridge.test.ts — plan-256 WEB test (d).
 *
 * The per-tick WEB→backend drive bridge: while a non-Three backend is active the
 * viewer pushes one value (first drive's currentPosition, or a configured
 * signal) to the backend via `sendDriveValue`. Under Three it must NOT push.
 * Tested via the pure helpers `pushRenderBackendDriveValue` +
 * `readDriveBridgeValue` (the same functions the viewer calls each tick).
 */

import { describe, test, expect, vi } from 'vitest';
import {
  RenderBackendController,
  pushRenderBackendDriveValue,
  readDriveBridgeValue,
  type RenderBackend,
  type RenderBackendDriveBridgeConfig,
} from '../src/core/render-backend/rv-render-backend';

/** A fake non-Three backend that records sendDriveValue calls. */
function makeFakeBackend() {
  const sendDriveValue = vi.fn<(v: number, o?: unknown) => void>();
  const backend: RenderBackend = {
    id: 'omniverse',
    mount() { /* no overlay in this unit test */ },
    dispose() { /* nothing to tear down */ },
    sendDriveValue,
  };
  return { backend, sendDriveValue };
}

describe('render-backend drive bridge', () => {
  test('(d) pushes the drive position while omniverse is active, NOT under three', async () => {
    const { backend, sendDriveValue } = makeFakeBackend();
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => backend);

    const cfg: RenderBackendDriveBridgeConfig = { enabled: true };
    const drivePosition = 12.5;
    const readValue = () => drivePosition;

    // three (default) → no push.
    pushRenderBackendDriveValue(controller, cfg, readValue);
    expect(sendDriveValue).not.toHaveBeenCalled();

    // switch to omniverse → push the drive position.
    await controller.setBackend('omniverse', document.createElement('div'));
    pushRenderBackendDriveValue(controller, cfg, readValue);
    expect(sendDriveValue).toHaveBeenCalledTimes(1);
    expect(sendDriveValue).toHaveBeenCalledWith(drivePosition, undefined);

    // switch back to three → no further pushes.
    await controller.setBackend('three');
    pushRenderBackendDriveValue(controller, cfg, readValue);
    expect(sendDriveValue).toHaveBeenCalledTimes(1);
  });

  test('disabled bridge does not push even under omniverse', async () => {
    const { backend, sendDriveValue } = makeFakeBackend();
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => backend);
    await controller.setBackend('omniverse', document.createElement('div'));

    pushRenderBackendDriveValue(controller, { enabled: false }, () => 7);
    expect(sendDriveValue).not.toHaveBeenCalled();
  });

  test('undefined source value is not pushed', async () => {
    const { backend, sendDriveValue } = makeFakeBackend();
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => backend);
    await controller.setBackend('omniverse', document.createElement('div'));

    pushRenderBackendDriveValue(controller, { enabled: true }, () => undefined);
    expect(sendDriveValue).not.toHaveBeenCalled();
  });

  test('forwards drive payload options', async () => {
    const { backend, sendDriveValue } = makeFakeBackend();
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => backend);
    await controller.setBackend('omniverse', document.createElement('div'));

    const drive = { primPath: '/World/Axis', mode: 'rotate' as const, axis: 1 as const, scale: 1 };
    pushRenderBackendDriveValue(controller, { enabled: true, drive }, () => 3);
    expect(sendDriveValue).toHaveBeenCalledWith(3, drive);
  });
});

describe('readDriveBridgeValue', () => {
  const drives = [
    { name: 'DriveA', currentPosition: 3.5 },
    { name: 'DriveB', currentPosition: 8.0 },
  ];

  test('defaults to the first drive currentPosition', () => {
    expect(readDriveBridgeValue({ enabled: true }, drives, null)).toBe(3.5);
  });

  test('selects a drive by name', () => {
    expect(readDriveBridgeValue({ enabled: true, driveName: 'DriveB' }, drives, null)).toBe(8.0);
  });

  test('a configured signal wins over the drive (number and bool→0/1)', () => {
    const signals = {
      get: (n: string) => (n === 'Speed' ? 42 : n === 'Running' ? true : undefined),
    };
    expect(readDriveBridgeValue({ enabled: true, signalName: 'Speed' }, drives, signals)).toBe(42);
    expect(readDriveBridgeValue({ enabled: true, signalName: 'Running' }, drives, signals)).toBe(1);
    // Missing signal → undefined (nothing pushed).
    expect(readDriveBridgeValue({ enabled: true, signalName: 'Nope' }, drives, signals)).toBeUndefined();
  });

  test('no drives and no signal → undefined', () => {
    expect(readDriveBridgeValue({ enabled: true }, [], null)).toBeUndefined();
  });
});
