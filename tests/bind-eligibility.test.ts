// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { getBindEligibility } from '../src/core/engine/rv-binding-slot-resolver';
import { signalBindEligibility, type SignalBindTarget } from '../src/plugins/signal-bind/signal-bind-target';
import type { RVViewer } from '../src/core/rv-viewer';

function registeredDrive() {
  const root = new Object3D();
  root.name = 'Axis';
  const registry = new NodeRegistry();
  registry.registerNode('Axis', root);
  const drive = { liveControlled: false };
  registry.register('Drive', 'Axis', drive);
  return { root, registry, drive };
}

describe('signal bind instance eligibility', () => {
  it('allows a drive without a proven competing controller', () => {
    const { root, registry } = registeredDrive();
    expect(getBindEligibility(root, registry)).toEqual({ eligible: true });
  });

  it('fails closed for an Erratic component on the target node', () => {
    const { root, registry } = registeredDrive();
    registry.register('Drive_ErraticPosition', 'Axis', {});
    expect(getBindEligibility(root, registry)).toEqual({
      eligible: false,
      reason: 'controlled by Drive_ErraticPosition',
    });
  });

  it('fails closed when the drive is an IK-controlled axis', () => {
    const { root, registry, drive } = registeredDrive();
    registry.register('RobotIK', 'Robot', { getAxisDrives: () => [drive] });
    expect(getBindEligibility(root, registry)).toEqual({
      eligible: false,
      reason: 'controlled by an IK path',
    });
  });

  it('fails closed for a declared JavaScript behavior assignment and exposes its reason', () => {
    const { root, registry } = registeredDrive();
    const target: SignalBindTarget = { kind: 'placed', placedId: 'placed-7', node: root };
    const viewer = {
      registry,
      behaviors: { getActiveBinds: () => [{ behaviorId: 'custom-axis', objectKey: 'placed-7' }] },
    } as unknown as RVViewer;

    expect(signalBindEligibility(viewer, target)).toEqual({
      eligible: false,
      reason: 'controlled by JavaScript behavior custom-axis',
    });
  });
});
