// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-target-axis-correction-legacy.node.test.ts — `AxisCorrection` was removed
 * from realvirtual WEB on 2026-11-02 (Thomas: "diese properties können raus").
 *
 * Unity exports still carry the field. This suite pins the load half of that
 * decision: such an IKTarget loads exactly like one without the field, the web
 * component has no `AxisCorrection` any more, the parity validator stays silent
 * and the inspector neither edits nor shows it. The export half (identical
 * program for zero values, one console warning for non-zero) lives in
 * `robot-export-baked-pose.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { Object3D } from 'three';
import { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  getConsumedFields, getIgnoredFields, printParitySummary, resetParityValidator, validateExtras,
} from '../src/core/engine/rv-extras-validator';
import { classifyField, isFieldHidden } from '../src/core/hmi/rv-inspector-helpers';

const AXIS_POS = [10, -20, 30, 0, 45, -5];

function loadTarget(extras: Record<string, unknown>): RVIKTarget {
  const node = new Object3D();
  node.name = 'T0';
  node.userData.realvirtual = { IKTarget: extras };
  const t = new RVIKTarget(node);
  t.init({ registry: new NodeRegistry(), signalStore: new SignalStore() } as unknown as ComponentContext);
  return t;
}

describe('IKTarget with a legacy AxisCorrection (Unity export)', () => {
  it('loads exactly like a target without the field', () => {
    const without = loadTarget({ AxisPos: AXIS_POS });
    const zeros = loadTarget({ AxisPos: AXIS_POS, AxisCorrection: [0, 0, 0, 0, 0, 0] });
    const nonZero = loadTarget({ AxisPos: AXIS_POS, AxisCorrection: [1, 2, 3, 4, 5, 6] });
    for (const t of [zeros, nonZero]) {
      expect(t.AxisPos).toEqual(without.AxisPos);
      expect('AxisCorrection' in t).toBe(false);
    }
  });

  it('is accepted silently by the parity validator (no unhandled-field report)', () => {
    resetParityValidator();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      validateExtras('IKTarget', { AxisPos: AXIS_POS, AxisCorrection: [1, 2, 3, 4, 5, 6] });
      printParitySummary();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      resetParityValidator();
    }
  });

  it('is neither editable nor visible in the inspector', () => {
    expect(getConsumedFields('IKTarget')).not.toContain('AxisCorrection');
    expect(getIgnoredFields('IKTarget')).toContain('AxisCorrection');
    expect(classifyField('IKTarget', 'AxisCorrection')).toBe('ignored');
    expect(isFieldHidden('IKTarget', 'AxisCorrection')).toBe(true);
    expect(classifyField('IKTarget', 'AxisPos')).toBe('consumed');
  });
});
