// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { readMUColliderTemplate } from '../src/core/engine/rv-mu-collider-template';
import { getColliderExtrasFrom, isSolidCollider } from '../src/core/engine/rv-collider-extras';
import {
  getConsumedFields, printParitySummary, resetParityValidator, validateExtras,
} from '../src/core/engine/rv-extras-validator';

const box = { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 4, z: 6 } };

describe('BoxCollider trigger parity (plan-2219)', () => {
  it('excludes a trigger child from the authored MU shape', () => {
    const root = new Object3D();
    root.userData.realvirtual = { Rigidbody: { isKinematic: false } };
    const solid = new Object3D(), trigger = new Object3D();
    solid.userData.realvirtual = { BoxCollider: box };
    trigger.position.x = 100;
    trigger.userData.realvirtual = { BoxCollider: { ...box, isTrigger: true } };
    root.add(solid, trigger);
    expect(readMUColliderTemplate(root)?.shapes).toEqual([
      { kind: 'cuboid', halfExtents: { x: 1, y: 2, z: 3 }, localOffset: { x: 0, y: 0, z: 0 } },
    ]);
    root.remove(solid);
    expect(readMUColliderTemplate(root)).toBeUndefined();
  });

  it('preserves the separately parsed collider-array trigger flag', () => {
    const colliders = getColliderExtrasFrom({ colliders: [{ type: 'BoxCollider', ...box, isTrigger: true }] });
    expect(colliders).toEqual([{ kind: 'box', ...box, enabled: true, isTrigger: true }]);
    expect(isSolidCollider(colliders[0])).toBe(false);
  });

  it('consumes isTrigger without suppressing unknown-field warnings', () => {
    resetParityValidator();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getConsumedFields('BoxCollider')).toContain('isTrigger');
      validateExtras('BoxCollider', { ...box, isTrigger: true });
      printParitySummary();
      expect(warn).not.toHaveBeenCalled();
      validateExtras('BoxCollider', { ...box, NotAField: true });
      printParitySummary();
      expect(warn.mock.calls.map(call => call.join(' ')).join('\n')).toContain('BoxCollider.NotAField');
    } finally {
      warn.mockRestore();
      resetParityValidator();
    }
  });
});
