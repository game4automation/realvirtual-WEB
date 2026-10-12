// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { applySchema } from '../src/core/engine/rv-component-registry';

function drive() {
  const d = new RVDrive(new Object3D());
  applySchema(d as unknown as Record<string, unknown>, RVDrive.schema,
    { Direction: 'RotationX', TargetSpeed: 100, JogForward: true });
  d.initDrive();
  d.update(0.1);
  return d;
}

describe('drive motion interlocks', () => {
  it('holds jog and behavior commands until all owners release, without restarting', () => {
    const d = drive();
    const first = {}, second = {};
    d.setMotionBlocked(first, true);
    d.setMotionBlocked(second, true);
    const position = d.currentPosition;
    const rotation = d.node.quaternion.clone();
    d.driveBehaviors.push({ update: () => { d.currentPosition += 10; } } as never);
    d.jogForward = true;
    d.update(0.1);
    expect(d.currentPosition).toBe(position);
    expect(d.node.quaternion.equals(rotation)).toBe(true);
    expect(d.currentSpeed).toBe(0);
    d.setMotionBlocked(first, false);
    expect(d.motionBlocked).toBe(true);
    d.update(0.1);
    expect(d.currentPosition).toBe(position);
    d.driveBehaviors.length = 0;
    d.setMotionBlocked(second, false);
    expect(d.motionBlocked).toBe(false);
    d.update(0.1);
    expect(d.currentPosition).toBe(position);
    d.jogForward = true;
    d.update(0.1);
    d.update(0.1);
    expect(d.currentPosition).toBeGreaterThan(position);
  });
});
