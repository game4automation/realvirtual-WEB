// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * EditTarget seam — the inspector write path routes to the SceneStore adapter
 * by default and to the asset-editor override while it is installed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getActiveEditTarget,
  setActiveEditTarget,
  type EditTarget,
} from '../src/core/hmi/rv-edit-target';
import { persistFieldOp } from '../src/core/hmi/scene/scene-field-ops';

afterEach(() => setActiveEditTarget(null));

describe('EditTarget routing', () => {
  it('default target is the SceneStore adapter (unavailable pre-boot, editor-only ops hidden)', () => {
    const target = getActiveEditTarget();
    // No SceneStore singleton in unit tests → adapter reports unavailable.
    expect(target.available).toBe(false);
    // Editor-only capabilities are NOT defined on the scene adapter — the
    // inspector uses this to hide Add/Remove-component & node affordances.
    expect(target.addComponent).toBeUndefined();
    expect(target.deleteNode).toBeUndefined();
  });

  it('an installed override receives the writes; clearing restores the default', () => {
    const calls: unknown[][] = [];
    const override: EditTarget = {
      available: true,
      setField: (...a) => { calls.push(['setField', ...a]); },
      unsetField: (...a) => { calls.push(['unsetField', ...a]); },
      withTransaction: async (_label, fn) => { await fn(); },
      addComponent: () => 'Drive',
      deleteNode: () => {},
    };
    setActiveEditTarget(override);
    expect(getActiveEditTarget()).toBe(override);

    getActiveEditTarget().setField('Root/Node', 'Drive', 'TargetSpeed', 10, 5);
    expect(calls).toEqual([['setField', 'Root/Node', 'Drive', 'TargetSpeed', 10, 5]]);

    setActiveEditTarget(null);
    expect(getActiveEditTarget()).not.toBe(override);
  });

  it('persistFieldOp routes through the active target', () => {
    const calls: unknown[][] = [];
    setActiveEditTarget({
      available: true,
      setField: (...a) => { calls.push(a); },
      unsetField: () => {},
      withTransaction: async (_l, fn) => { await fn(); },
    });
    persistFieldOp('Root/Node', 'Sensor', 'Limit', 42, 10);
    expect(calls).toEqual([['Root/Node', 'Sensor', 'Limit', 42, 10]]);
  });

  it('persistFieldOp is a no-op when no target is available (pre-boot)', () => {
    // Default scene adapter without a SceneStore — must not throw.
    expect(() => persistFieldOp('Root/Node', 'Sensor', 'Limit', 42, 10)).not.toThrow();
  });
});
